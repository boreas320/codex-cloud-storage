import json
from unittest.mock import Mock

import pytest

from cloud_storage import server


@pytest.mark.parametrize(
    "endpoint,phrase",
    [
        ("obs.ap-southeast-3.myhuaweicloud.com", "https://"),
        ("http://obs.ap-southeast-3.myhuaweicloud.com", "https://"),
        ("https://example-bucket.obs.ap-southeast-3.myhuaweicloud.com", "桶域名"),
        ("https://obs.example.invalid/path", "路径"),
        ("https://obs.example.invalid:wrong", "端口"),
        ("https://obs.example.invalid?token=DO_NOT_ECHO", "查询参数"),
        ("https://key:DO_NOT_ECHO@obs.example.invalid", "密码"),
    ],
)
async def test_endpoint_errors_identify_field_without_echoing_inputs(monkeypatch, endpoint, phrase):
    store = Mock()
    monkeypatch.setattr(server, "store", store)
    response = await server.save_account(
        {"name": "Test", "provider": "obs", "region": "ap-southeast-3", "endpoint": endpoint},
        {"access_key": "TEST_ACCESS", "secret_key": "DO_NOT_ECHO", "session_token": "DO_NOT_ECHO"},
    )
    assert response.isError
    assert phrase in response.structuredContent["error"]["fields"]["endpoint"]
    assert "DO_NOT_ECHO" not in response.model_dump_json()
    store.save.assert_not_called()


async def test_all_invalid_fields_are_returned_and_secrets_are_not_echoed(monkeypatch):
    store = Mock()
    monkeypatch.setattr(server, "store", store)
    response = await server.save_account(
        {"name": " ", "provider": "cos", "region": "not a region", "buckets": ["https://bad"]},
        {"access_key": "", "secret_key": {"hidden": "DO_NOT_ECHO"}, "session_token": "x" * 32769},
    )
    assert set(response.structuredContent["error"]["fields"]) == {
        "name",
        "region",
        "buckets",
        "access_key",
        "secret_key",
        "session_token",
    }
    assert "DO_NOT_ECHO" not in response.model_dump_json()
    store.save.assert_not_called()


async def test_required_fields_and_valid_custom_region(monkeypatch):
    store = Mock()
    monkeypatch.setattr(server, "store", store)
    bad = await server.save_account({"name": "Test", "provider": "cos"}, None)
    assert set(bad.structuredContent["error"]["fields"]) == {"region", "access_key", "secret_key"}
    store.save.assert_not_called()
    store.save.return_value = {"id": "test"}
    good = await server.save_account(
        {"id": "test", "name": "Test", "provider": "cos", "region": "private-region-1"}, None
    )
    assert not good.isError
    assert store.save.call_args.args[0].region == "private-region-1"
    assert store.save.call_args.args[1] is None
    assert "secret" not in json.dumps(good.structuredContent)
