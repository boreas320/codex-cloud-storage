"""Read-only provider adapters. No cloud write API is exposed."""

from __future__ import annotations

import re
from contextlib import contextmanager, suppress
from datetime import datetime

from .accounts import StorageError


def iso(value):
    return value.isoformat() if isinstance(value, datetime) else str(value or "")


def item(key, size=0, modified="", storage_class="", etag="", directory=False):
    return {
        "key": key,
        "size": int(size or 0),
        "modified": iso(modified),
        "storage_class": storage_class or "",
        "etag": etag or "",
        "directory": directory,
    }


def safe_error(exc):
    if isinstance(exc, StorageError):
        return exc
    code, request_id = "PROVIDER_ERROR", ""
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code", code)
        request_id = response.get("ResponseMetadata", {}).get("RequestId", "")
    elif callable(getattr(exc, "get_error_code", None)):
        code, request_id = exc.get_error_code(), exc.get_request_id()
    else:
        code = getattr(exc, "code", None) or code
        request_id = getattr(exc, "request_id", "") or ""
    # Provider exception messages can include headers, signed URLs or credentials.
    code = code if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", str(code)) else "PROVIDER_ERROR"
    request_id = request_id if re.fullmatch(r"[A-Za-z0-9_./+=:-]{0,200}", str(request_id)) else ""
    messages = {
        "AccessDenied": "权限不足，请检查该账号对桶或对象的读取权限。",
        "403": "权限不足或凭证无效。",
        "NoSuchKey": "对象不存在或已被删除。",
        "NoSuchBucket": "桶不存在或地域错误。",
        "ExpiredToken": "临时凭证已过期，请更新账号设置。",
        "InvalidAccessKeyId": "访问密钥无效，请更新账号设置。",
        "SignatureDoesNotMatch": "签名校验失败，请检查凭证、地域和服务地址。",
        "PreconditionFailed": "对象已发生变化，请刷新列表后重新下载。",
        "412": "对象已发生变化，请刷新后重试。",
        "InvalidObjectState": "此对象当前不可下载，可能需要先在云控制台恢复归档对象。",
        "PermanentRedirect": "桶所在地域与配置不一致，请修改账号地域。",
        "AuthorizationHeaderMalformed": "签名地域不匹配，请检查桶所在地域。",
    }
    message = messages.get(str(code), "云服务请求失败，请检查网络、地域、服务地址和读取权限。")
    return StorageError(str(code), message, str(request_id))


class Provider:
    def __init__(self, account, credentials):
        self.account, self.kind = account, account["provider"]
        self.client = self._create(credentials)

    def _create(self, c):
        a = self.account
        if self.kind in {"s3", "s3-compatible"}:
            import boto3
            from botocore.config import Config

            return boto3.client(
                "s3",
                region_name=a["region"] or "us-east-1",
                endpoint_url=a["endpoint"] or None,
                aws_access_key_id=c["access_key"],
                aws_secret_access_key=c["secret_key"],
                aws_session_token=c["session_token"] or None,
                config=Config(
                    connect_timeout=10,
                    read_timeout=30,
                    retries={"max_attempts": 2},
                    s3={"addressing_style": "path" if a["path_style"] else "virtual"},
                ),
            )
        if self.kind == "obs":
            from obs import ObsClient

            return ObsClient(
                access_key_id=c["access_key"],
                secret_access_key=c["secret_key"],
                security_token=c["session_token"] or None,
                server=a["endpoint"],
                timeout=30,
                max_retry_count=2,
            )
        if self.kind == "cos":
            from qcloud_cos import CosConfig, CosS3Client

            return CosS3Client(
                CosConfig(
                    Region=a["region"],
                    SecretId=c["access_key"],
                    SecretKey=c["secret_key"],
                    Token=c["session_token"] or None,
                    Scheme="https",
                    Endpoint=a["endpoint"].removeprefix("https://") or None,
                    Timeout=30,
                )
            )
        if self.kind == "oss":
            import alibabacloud_oss_v2 as oss

            return oss.Client(
                oss.Config(
                    region=a["region"],
                    endpoint=a["endpoint"] or None,
                    credentials_provider=oss.credentials.StaticCredentialsProvider(
                        c["access_key"], c["secret_key"], c["session_token"] or None
                    ),
                    connect_timeout=10,
                    readwrite_timeout=30,
                    retry_max_attempts=2,
                )
            )
        raise StorageError("UNSUPPORTED_PROVIDER", "不支持此存储类型。")

    def close(self):
        close = getattr(self.client, "close", None)
        if callable(close):
            close()

    @staticmethod
    def _obs(response):
        if response.status >= 300:
            raise StorageError(
                str(response.errorCode or response.status),
                "OBS 请求失败，请检查权限、地域、凭证或对象状态。",
                response.requestId or "",
            )
        return response.body

    def buckets(self, cursor="", limit=200):
        if self.account["buckets"]:
            return {"items": [{"name": n} for n in self.account["buckets"]], "next_cursor": ""}
        if self.kind in {"s3", "s3-compatible"}:
            # Older S3-compatible implementations do not accept paginated ListBuckets.
            if self.kind == "s3-compatible":
                r = self.client.list_buckets()
            else:
                r = self.client.list_buckets(
                    MaxBuckets=limit, **({"ContinuationToken": cursor} if cursor else {})
                )
            return {
                "items": [{"name": x["Name"]} for x in r.get("Buckets", [])],
                "next_cursor": r.get("ContinuationToken", ""),
            }
        if self.kind == "obs":
            r = self._obs(self.client.listBuckets(maxKeys=limit, marker=cursor or None))
            return {
                "items": [{"name": x.name} for x in r.buckets or []],
                "next_cursor": getattr(r, "nextMarker", "") or "",
            }
        if self.kind == "cos":
            r = self.client.list_buckets(Marker=cursor, MaxKeys=limit)
            return {
                "items": [{"name": x["Name"]} for x in r.get("Buckets", {}).get("Bucket", [])],
                "next_cursor": r.get("NextMarker", ""),
            }
        import alibabacloud_oss_v2 as oss

        r = self.client.list_buckets(oss.ListBucketsRequest(marker=cursor or None, max_keys=limit))
        return {"items": [{"name": x.name} for x in r.buckets or []], "next_cursor": r.next_marker or ""}

    def objects(self, bucket, prefix="", cursor="", limit=200):
        if self.kind in {"s3", "s3-compatible"}:
            r = self.client.list_objects_v2(
                Bucket=bucket,
                Prefix=prefix,
                Delimiter="/",
                MaxKeys=limit,
                **({"ContinuationToken": cursor} if cursor else {}),
            )
            rows = [
                item(x["Key"], x["Size"], x.get("LastModified"), x.get("StorageClass"), x.get("ETag"))
                for x in r.get("Contents", [])
            ]
            rows += [item(x["Prefix"], directory=True) for x in r.get("CommonPrefixes", [])]
            return {"items": rows, "next_cursor": r.get("NextContinuationToken", "")}
        if self.kind == "obs":
            r = self._obs(
                self.client.listObjects(
                    bucket, prefix=prefix, marker=cursor or None, max_keys=limit, delimiter="/"
                )
            )
            rows = [item(x.key, x.size, x.lastModified, x.storageClass, x.etag) for x in r.contents or []]
            rows += [item(x.prefix, directory=True) for x in r.commonPrefixs or []]
            return {"items": rows, "next_cursor": r.next_marker or ""}
        if self.kind == "cos":
            r = self.client.list_objects(
                Bucket=bucket, Prefix=prefix, Marker=cursor, MaxKeys=limit, Delimiter="/"
            )
            rows = [
                item(x["Key"], x.get("Size"), x.get("LastModified"), x.get("StorageClass"), x.get("ETag"))
                for x in r.get("Contents", [])
            ]
            rows += [item(x["Prefix"], directory=True) for x in r.get("CommonPrefixes", [])]
            return {"items": rows, "next_cursor": r.get("NextMarker", "")}
        import alibabacloud_oss_v2 as oss

        r = self.client.list_objects_v2(
            oss.ListObjectsV2Request(
                bucket=bucket, prefix=prefix, continuation_token=cursor or None, max_keys=limit, delimiter="/"
            )
        )
        rows = [item(x.key, x.size, x.last_modified, x.storage_class, x.etag) for x in r.contents or []]
        rows += [item(x.prefix, directory=True) for x in r.common_prefixes or []]
        return {"items": rows, "next_cursor": r.next_continuation_token or ""}

    def head(self, bucket, key):
        if self.kind in {"s3", "s3-compatible"}:
            r = self.client.head_object(Bucket=bucket, Key=key)
            return {
                **item(
                    key,
                    r["ContentLength"],
                    r.get("LastModified"),
                    r.get("StorageClass", "STANDARD"),
                    r.get("ETag"),
                ),
                "content_type": r.get("ContentType", ""),
                "metadata": r.get("Metadata", {}),
            }
        if self.kind == "obs":
            r = self._obs(self.client.getObjectMetadata(bucket, key))
            return {
                **item(key, r.contentLength, r.lastModified, r.storageClass, r.etag),
                "content_type": r.contentType or "",
            }
        if self.kind == "cos":
            r = self.client.head_object(Bucket=bucket, Key=key)
            return {
                **item(
                    key,
                    r.get("Content-Length"),
                    r.get("Last-Modified"),
                    r.get("x-cos-storage-class", "STANDARD"),
                    r.get("ETag"),
                ),
                "content_type": r.get("Content-Type", ""),
            }
        import alibabacloud_oss_v2 as oss

        r = self.client.head_object(oss.HeadObjectRequest(bucket=bucket, key=key))
        return {
            **item(key, r.content_length, r.last_modified, r.storage_class, r.etag),
            "content_type": r.content_type or "",
        }

    @contextmanager
    def stream(self, bucket, key, etag):
        self.checksums = {}
        if self.kind in {"s3", "s3-compatible"}:
            r = self.client.get_object(Bucket=bucket, Key=key, **({"IfMatch": etag} if etag else {}))
            body = r["Body"]
            if r.get("ChecksumType") == "FULL_OBJECT" and r.get("ChecksumSHA256"):
                self.checksums["sha256"] = r["ChecksumSHA256"]
        elif self.kind == "obs":
            from obs import GetObjectHeader

            r = self._obs(
                self.client.getObject(
                    bucket,
                    key,
                    headers=GetObjectHeader(if_match=etag or None),
                    loadStreamInMemory=False,
                    isAttachCrc64=True,
                )
            )
            body = r.response
            if r.crc64:
                self.checksums["crc64"] = str(r.crc64)
        elif self.kind == "cos":
            r = self.client.get_object(
                Bucket=bucket, Key=key, KeySimplifyCheck=False, **({"IfMatch": etag} if etag else {})
            )
            body = r["Body"].get_raw_stream()
            headers = {k.lower(): v for k, v in r.items()}
            if headers.get("x-cos-hash-crc64ecma"):
                self.checksums["crc64"] = str(headers["x-cos-hash-crc64ecma"])
        else:
            import alibabacloud_oss_v2 as oss

            r = self.client.get_object(oss.GetObjectRequest(bucket=bucket, key=key, if_match=etag or None))
            body = r.body
            if r.hash_crc64:
                self.checksums["crc64"] = str(r.hash_crc64)
            if r.content_md5:
                self.checksums["md5"] = r.content_md5
        try:
            yield body
        finally:
            body.close()


@contextmanager
def connect(store, account_id):
    account, credentials = store.snapshot(account_id)
    try:
        client = Provider(account, credentials)
    except Exception as exc:
        raise safe_error(exc) from None
    try:
        yield client
    finally:
        with suppress(Exception):
            client.close()
