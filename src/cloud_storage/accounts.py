"""Atomic public configuration; secrets are stored only in the macOS Keychain."""

from __future__ import annotations

import fcntl
import json
import os
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

import keyring
from platformdirs import user_data_path
from pydantic import BaseModel, Field, ValidationError, field_validator
from pydantic_core import PydanticCustomError

PROVIDERS = {"s3", "obs", "cos", "oss", "s3-compatible"}
SERVICE = "io.github.boreas320.codex-cloud-storage"


class StorageError(Exception):
    def __init__(self, code: str, message: str, request_id: str = "", fields=None):
        super().__init__(message)
        self.code, self.message, self.request_id = code, message, request_id
        self.fields = fields

    def public(self):
        value = {"code": self.code, "message": self.message, "request_id": self.request_id}
        if self.fields:
            value["fields"] = self.fields
        return value


VALIDATION_MESSAGES = {
    "endpoint_scheme": "服务地址需以 https:// 开头；仅本机地址允许 http://。",
    "endpoint_origin": "服务地址只能包含协议、域名和端口，不能包含用户名、密码、路径、查询参数或片段。",
    "endpoint_host": "服务地址的域名或端口格式不正确。",
    "buckets_invalid": "请每行填写一个桶名，不要填写网址或包含斜杠；每个桶名最多 255 个字符。",
    "provider_invalid": "请选择支持的云服务。",
    "blank_name": "请输入账号名称，不能只有空格。",
    "region_invalid": "区域代码只能包含小写字母、数字和连字符。",
}
FIELD_LABELS = {
    "name": "账号名称",
    "provider": "云服务",
    "region": "区域",
    "endpoint": "服务地址",
    "buckets": "指定存储桶",
    "access_key": "Access Key ID / SecretId",
    "secret_key": "Secret Access Key / SecretKey",
    "session_token": "临时令牌",
}


def validation_fields(exc: ValidationError):
    fields = {}
    # Never serialize Pydantic input/ctx/msg: they may contain submitted credentials.
    for error in exc.errors(include_input=False, include_context=False, include_url=False):
        field = str(error["loc"][0]) if error["loc"] else "account"
        kind = error["type"]
        label = FIELD_LABELS.get(field, "配置")
        message = VALIDATION_MESSAGES.get(kind)
        if not message:
            if kind in {"missing", "string_too_short"}:
                message = f"请填写{label}。"
            elif kind in {"string_too_long", "too_long"}:
                message = f"{label}超过长度或数量限制。"
            else:
                message = f"{label}格式不正确。"
        fields.setdefault(field, message)
    return fields


class AccountInput(BaseModel):
    id: str = ""
    name: str = Field(min_length=1, max_length=100)
    provider: str
    region: str = ""
    endpoint: str = ""
    buckets: list[str] = Field(default_factory=list, max_length=100)
    path_style: bool = False

    @field_validator("provider")
    @classmethod
    def provider_valid(cls, value):
        if value not in PROVIDERS:
            raise PydanticCustomError("provider_invalid", "Unsupported provider")
        return value

    @field_validator("name")
    @classmethod
    def name_valid(cls, value):
        if not value.strip():
            raise PydanticCustomError("blank_name", "Blank name")
        return value.strip()

    @field_validator("region")
    @classmethod
    def region_valid(cls, value):
        import re

        value = value.strip()
        if value and not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value):
            raise PydanticCustomError("region_invalid", "Invalid region code")
        return value

    @field_validator("endpoint")
    @classmethod
    def endpoint_valid(cls, value):
        if not value:
            return value
        value = value.strip()
        try:
            url = urlparse(value)
            host = url.hostname
            url.port
        except ValueError:
            raise PydanticCustomError("endpoint_host", "Invalid host or port") from None
        if url.scheme != "https" and not (url.scheme == "http" and host in {"localhost", "127.0.0.1", "::1"}):
            raise PydanticCustomError("endpoint_scheme", "HTTPS required")
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise PydanticCustomError("endpoint_origin", "Origin required")
        if not host or any(c.isspace() for c in host) or "\\" in host:
            raise PydanticCustomError("endpoint_host", "Invalid hostname")
        return value.rstrip("/")

    @field_validator("buckets")
    @classmethod
    def buckets_valid(cls, values):
        if any(not v or "/" in v or len(v) > 255 for v in values):
            raise PydanticCustomError("buckets_invalid", "Invalid bucket name")
        return list(dict.fromkeys(values))


class Credentials(BaseModel):
    access_key: str = Field(min_length=1, max_length=1024)
    secret_key: str = Field(min_length=1, max_length=4096)
    session_token: str = Field(default="", max_length=32768)


class KeychainVault:
    def __init__(self):
        # Explicit backend: never allow keyrings.alt plaintext or environment fallback.
        from keyring.backends.macOS import Keyring

        self.backend = Keyring()

    def get(self, ref):
        try:
            value = self.backend.get_password(SERVICE, ref)
            if value is None:
                raise ValueError("Missing credential")
            return Credentials.model_validate_json(value).model_dump()
        except Exception:
            raise StorageError(
                "KEYCHAIN_UNAVAILABLE", "无法读取钥匙串凭证，请解锁钥匙串或重新保存账号。"
            ) from None

    def put(self, ref, value):
        try:
            self.backend.set_password(SERVICE, ref, json.dumps(value))
            if self.get(ref) != value:
                raise ValueError("Read-back mismatch")
        except Exception:
            raise StorageError("KEYCHAIN_UNAVAILABLE", "无法保存并读回钥匙串凭证；未保存账号。") from None

    def delete(self, ref):
        try:
            self.backend.delete_password(SERVICE, ref)
        except keyring.errors.PasswordDeleteError:
            pass
        except Exception:
            raise StorageError("KEYCHAIN_UNAVAILABLE", "无法删除钥匙串凭证。") from None


class AccountStore:
    def __init__(self, directory: Path | None = None, vault=None):
        self.directory = directory or user_data_path("codex-cloud-storage", appauthor=False)
        self.vault = vault

    def _vault(self):
        if self.vault is None:
            try:
                self.vault = KeychainVault()
            except Exception:
                raise StorageError("KEYCHAIN_UNAVAILABLE", "此版本需要 macOS 钥匙串。") from None
        return self.vault

    @contextmanager
    def _locked(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.directory, 0o700)
        with open(self.directory / ".lock", "a") as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _read(self):
        path = self.directory / "config.json"
        if not path.exists():
            return {"accounts": [], "download_directory": str(Path.home() / "Downloads" / "多云对象存储")}
        try:
            value = json.loads(path.read_text())
            if not isinstance(value.get("accounts"), list):
                raise ValueError()
            return value
        except Exception:
            raise StorageError("CONFIG_INVALID", "本地配置损坏，请先备份配置文件再修复。") from None

    def _write(self, data):
        fd, tmp = tempfile.mkstemp(dir=self.directory, prefix=".config-")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.directory / "config.json")
        finally:
            Path(tmp).unlink(missing_ok=True)

    @staticmethod
    def _public(account):
        return {k: v for k, v in account.items() if k != "credential_ref"}

    def list(self):
        with self._locked():
            return [self._public(a) for a in self._read()["accounts"]]

    def snapshot(self, account_id):
        with self._locked():
            account = next((a for a in self._read()["accounts"] if a["id"] == account_id), None)
            if account is None:
                raise StorageError("ACCOUNT_NOT_FOUND", "账号不存在。")
            return self._public(account), self._vault().get(account["credential_ref"])

    def save(self, account: AccountInput, credentials: Credentials | None):
        with self._locked():
            data = self._read()
            previous = next((a for a in data["accounts"] if a["id"] == account.id), None)
            if account.id and previous is None:
                raise StorageError("ACCOUNT_NOT_FOUND", "账号不存在，请重新打开设置。")
            if credentials is None and previous is None:
                raise StorageError(
                    "CREDENTIALS_REQUIRED",
                    "请填写访问凭证。",
                    fields={
                        "access_key": "请填写 Access Key ID / SecretId。",
                        "secret_key": "请填写 Secret Access Key / SecretKey。",
                    },
                )
            if account.provider in {"obs", "s3-compatible"} and not account.endpoint:
                raise StorageError(
                    "ENDPOINT_REQUIRED", "请填写服务地址。", fields={"endpoint": "请填写服务地址。"}
                )
            if account.provider in {"cos", "oss"} and not account.region:
                raise StorageError(
                    "REGION_REQUIRED",
                    "请选择区域或输入自定义区域。",
                    fields={"region": "请选择区域或输入自定义区域。"},
                )
            result = account.model_dump()
            result["id"] = previous["id"] if previous else uuid.uuid4().hex
            result["credential_ref"] = uuid.uuid4().hex if credentials else previous["credential_ref"]
            if credentials:
                self._vault().put(result["credential_ref"], credentials.model_dump())
            data["accounts"] = [a for a in data["accounts"] if a["id"] != result["id"]] + [result]
            try:
                self._write(data)
            except Exception:
                if credentials:
                    self._vault().delete(result["credential_ref"])
                raise
            if previous and credentials:
                self._vault().delete(previous["credential_ref"])
            return self._public(result)

    def settings(self):
        with self._locked():
            return {"download_directory": self._read()["download_directory"]}

    def save_settings(self, directory):
        path = Path(directory).expanduser()
        if not path.is_absolute():
            raise StorageError("INVALID_DIRECTORY", "下载目录必须是绝对路径。")
        with self._locked():
            data = self._read()
            data["download_directory"] = str(path)
            self._write(data)
        return {"download_directory": str(path)}
