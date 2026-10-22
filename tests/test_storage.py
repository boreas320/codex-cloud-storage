import io
import json
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import boto3
import pytest
from botocore.exceptions import ClientError
from moto import mock_aws
from pydantic import ValidationError

from cloud_storage.accounts import AccountInput, AccountStore, Credentials, StorageError
from cloud_storage.downloads import Downloads, safe_filename
from cloud_storage.providers import Provider, connect, safe_error


class Vault:
    def __init__(self):
        self.values = {}

    def put(self, ref, value):
        self.values[ref] = dict(value)

    def get(self, ref):
        return self.values[ref]

    def delete(self, ref):
        del self.values[ref]


@pytest.fixture
def store(tmp_path):
    value = AccountStore(tmp_path / "config", Vault())
    value.save_settings(str(tmp_path / "downloads"))
    return value


def account(store, name="example", provider="s3", **kwargs):
    return store.save(
        AccountInput(name=name, provider=provider, region="us-east-1", **kwargs),
        Credentials(access_key="TEST_ACCESS_ONLY", secret_key="TEST_SECRET_ONLY"),
    )


def wait(queue, task, timeout=10):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        value = next(j for j in queue.list() if j["id"] == task["id"])
        if value["status"] not in {"queued", "running"}:
            return value
        time.sleep(0.01)
    pytest.fail("download did not terminate")


def test_configuration_persists_without_credentials(store):
    a = account(store)
    reloaded = AccountStore(store.directory, store.vault)
    assert reloaded.list() == [a]
    assert reloaded.snapshot(a["id"])[1]["secret_key"] == "TEST_SECRET_ONLY"
    config = (store.directory / "config.json").read_text()
    assert "TEST_SECRET_ONLY" not in config and "TEST_ACCESS_ONLY" not in config
    assert (store.directory / "config.json").stat().st_mode & 0o777 == 0o600
    saved = reloaded.save(AccountInput(**{**a, "name": "renamed"}), None)
    assert saved["name"] == "renamed" and len(store.vault.values) == 1


def test_keychain_failure_does_not_save_account(store):
    store.vault.put = Mock(side_effect=StorageError("KEYCHAIN_UNAVAILABLE", "locked"))
    with pytest.raises(StorageError):
        account(store)
    assert store.list() == []


def test_credential_rotation_replaces_only_that_account(store):
    a, b = account(store), account(store, "second")
    store.save(AccountInput(**a), Credentials(access_key="NEW_ACCESS", secret_key="NEW_SECRET"))
    assert len(store.vault.values) == 2
    assert store.snapshot(a["id"])[1]["secret_key"] == "NEW_SECRET"
    assert store.snapshot(b["id"])[1]["secret_key"] == "TEST_SECRET_ONLY"


@pytest.mark.parametrize(
    "endpoint",
    [
        "http://public.example",
        "https://user:secret@example.com",
        "https://example.com/bucket",
        "https://example.com?token=abc",
    ],
)
def test_invalid_endpoint(endpoint):
    with pytest.raises(ValidationError):
        AccountInput(name="bad", provider="s3", endpoint=endpoint)


@pytest.mark.parametrize(
    "key",
    ["../../secret", "a/../file.txt", "/abs/file", "a\\b", "中文/账单 空格+#.csv", "..", "/", "x" * 1000],
)
def test_safe_filename(key):
    name = safe_filename(key)
    assert "/" not in name and "\\" not in name and name not in {".", "..", ""}
    assert len(name.encode()) <= 180


def test_cloud_errors_redacted():
    error = ClientError(
        {
            "Error": {"Code": "ExpiredToken", "Message": "TEST_SECRET_ONLY"},
            "ResponseMetadata": {"RequestId": "req-123"},
        },
        "ListObjectsV2",
    )
    public = safe_error(error).public()
    assert public["code"] == "ExpiredToken" and public["request_id"] == "req-123"
    assert "TEST_SECRET_ONLY" not in json.dumps(public)
    assert "signed-url-secret" not in str(safe_error(RuntimeError("signed-url-secret")))


@mock_aws
def test_s3_browse_pagination_prefix_metadata_and_download(store):
    a = account(store)
    s3 = boto3.client("s3", region_name="us-east-1")
    s3.create_bucket(Bucket="test-bucket")
    content = b"hello-cloud\n" * 200000
    for key in ["账单/a +#.csv", "账单/b.csv", "other/c.csv"]:
        s3.put_object(Bucket="test-bucket", Key=key, Body=content)
    p = Provider(*store.snapshot(a["id"]))
    assert p.buckets()["items"] == [{"name": "test-bucket"}]
    assert {x["key"] for x in p.objects("test-bucket")["items"]} == {"账单/", "other/"}
    first = p.objects("test-bucket", "账单/", limit=1)
    second = p.objects("test-bucket", "账单/", cursor=first["next_cursor"], limit=1)
    assert first["next_cursor"] and first["items"][0]["key"] != second["items"][0]["key"]
    assert p.head("test-bucket", "账单/a +#.csv")["size"] == len(content)
    assert p.objects("test-bucket", "missing/")["items"] == []
    p.close()
    queue = Downloads(store)
    try:
        done = wait(queue, queue.start(a["id"], "test-bucket", "账单/a +#.csv"))
        assert done["status"] == "completed", done
        assert Path(done["path"]).read_bytes() == content
        duplicate = wait(queue, queue.start(a["id"], "test-bucket", "账单/a +#.csv"))
        assert duplicate["path"] != done["path"]
        assert Path(done["path"]).read_bytes() == content
        missing = wait(queue, queue.start(a["id"], "test-bucket", "absent"))
        assert missing["status"] == "failed"
        assert not list(Path(store.settings()["download_directory"]).glob("*.part"))
    finally:
        queue.close()


class FakeProvider:
    def __init__(self, data=b"data", reported=4, changed=False, blocked=None, broken=False):
        self.data, self.reported, self.changed, self.blocked, self.broken = (
            data,
            reported,
            changed,
            blocked,
            broken,
        )
        self.heads = 0

    def head(self, *args):
        self.heads += 1
        return {"size": self.reported, "etag": "changed" if self.changed and self.heads > 1 else "etag"}

    @contextmanager
    def stream(self, *args):
        if self.blocked:
            self.blocked.wait(2)
        if self.broken:
            raise ConnectionError("secret network details")
        yield io.BytesIO(self.data)


@pytest.mark.parametrize(
    "provider,code",
    [
        (FakeProvider(data=b"short", reported=10), "SIZE_MISMATCH"),
        (FakeProvider(changed=True), "OBJECT_CHANGED"),
        (FakeProvider(broken=True), "IO_ERROR"),
    ],
)
def test_failure_never_installs_partial_file(store, provider, code):
    a = account(store)

    @contextmanager
    def connector(*args):
        yield provider

    queue = Downloads(store, connector)
    try:
        done = wait(queue, queue.start(a["id"], "bucket", "../file.txt"))
        assert done["status"] == "failed" and done["error"]["code"] == code
        assert list(Path(store.settings()["download_directory"]).iterdir()) == []
    finally:
        queue.close()


def test_cancel_download_and_account_context(store):
    a, b = account(store), account(store, "second")
    gate, seen = threading.Event(), []

    @contextmanager
    def connector(_store, aid):
        seen.append(aid)
        yield FakeProvider(blocked=gate)

    queue = Downloads(store, connector)
    try:
        task = queue.start(a["id"], "bucket", "file")
        queue.cancel(task["id"])
        gate.set()
        assert wait(queue, task)["status"] == "cancelled"
        assert b["id"] not in seen
    finally:
        queue.close()


@pytest.mark.parametrize("kind", ["s3", "s3-compatible", "obs", "cos", "oss"])
def test_known_buckets_skip_account_wide_request(kind):
    provider = object.__new__(Provider)
    provider.kind, provider.account = kind, {"buckets": ["restricted-bucket"]}
    provider.client = Mock()
    assert provider.buckets()["items"] == [{"name": "restricted-bucket"}]
    assert provider.client.mock_calls == []


def test_obs_sdk_response_shapes():
    from obs.model import CommonPrefix, Content, ListObjectsResponse

    p = object.__new__(Provider)
    p.kind, p.client = "obs", Mock()
    p.client.listObjects.return_value = SimpleNamespace(
        status=200,
        body=ListObjectsResponse(
            contents=[Content(key="中文/a", size=12)],
            commonPrefixs=[CommonPrefix(prefix="dir/")],
            next_marker="next",
        ),
    )
    out = p.objects("bucket", "中文/", "old", 25)
    assert out["next_cursor"] == "next" and out["items"][0]["size"] == 12
    p.client.listObjects.assert_called_once_with(
        "bucket", prefix="中文/", marker="old", max_keys=25, delimiter="/"
    )


def test_cos_sdk_arguments():
    from qcloud_cos.cos_comm import mapped

    p = object.__new__(Provider)
    p.kind, p.client = "cos", Mock()
    p.client.list_objects.return_value = {"Contents": [{"Key": "中文/a", "Size": "12"}], "NextMarker": "next"}
    assert p.objects("bucket", "中文/", "old")["next_cursor"] == "next"
    p.client.head_object.return_value = {"Content-Length": "12", "ETag": '"a"'}
    assert p.head("bucket", "key")["size"] == 12
    p.client.head_object.assert_called_with(Bucket="bucket", Key="key")
    assert mapped({"IfMatch": '"a"'}) == {"If-Match": '"a"'}


def test_oss_sdk_response_shapes():
    import alibabacloud_oss_v2 as oss

    p = object.__new__(Provider)
    p.kind, p.client = "oss", Mock()
    p.client.list_objects_v2.return_value = oss.ListObjectsV2Result(
        contents=[oss.ObjectProperties(key="中文/a", size=12)],
        common_prefixes=[oss.CommonPrefix(prefix="dir/")],
        next_continuation_token="next",
    )
    out = p.objects("bucket", "中文/", "old", 25)
    assert out["next_cursor"] == "next" and out["items"][1]["directory"]
    request = p.client.list_objects_v2.call_args.args[0]
    assert request.bucket == "bucket" and request.continuation_token == "old" and request.max_keys == 25


def test_same_size_corruption_rejected_by_server_checksum(store):
    a = account(store)
    p = FakeProvider()
    p.checksums = {"sha256": "not-the-server-digest"}

    @contextmanager
    def connector(*args):
        yield p

    queue = Downloads(store, connector)
    try:
        result = wait(queue, queue.start(a["id"], "bucket", "file"))
        assert result["error"]["code"] == "CHECKSUM_MISMATCH"
        assert list(Path(store.settings()["download_directory"]).iterdir()) == []
    finally:
        queue.close()


def test_real_connection_context_preserves_cancellation(store, monkeypatch):
    a = account(store)
    p = Mock()
    monkeypatch.setattr("cloud_storage.providers.Provider", lambda *_: p)
    with pytest.raises(InterruptedError):
        with connect(store, a["id"]):
            raise InterruptedError()
    p.close.assert_called_once()
