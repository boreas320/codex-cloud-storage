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
from pydantic import BaseModel, Field, field_validator

PROVIDERS = {"s3", "obs", "cos", "oss", "s3-compatible"}
SERVICE = "io.github.boreas320.codex-cloud-storage"


class StorageError(Exception):
    def __init__(self, code: str, message: str, request_id: str = ""):
        super().__init__(message)
        self.code, self.message, self.request_id = code, message, request_id

    def public(self):
        return {"code": self.code, "message": self.message, "request_id": self.request_id}


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
            raise ValueError("Unsupported provider")
        return value

    @field_validator("endpoint")
    @classmethod
    def endpoint_valid(cls, value):
        if not value:
            return value
        url = urlparse(value)
        if (
            not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path not in ("", "/")
        ):
            raise ValueError("Endpoint must be an origin without path or credentials")
        if url.scheme != "https" and not (
            url.scheme == "http" and url.hostname in {"localhost", "127.0.0.1", "::1"}
        ):
            raise ValueError("HTTPS is required except for local loopback development")
        return value.rstrip("/")

    @field_validator("buckets")
    @classmethod
    def buckets_valid(cls, values):
        if any(not v or "/" in v or len(v) > 255 for v in values):
            raise ValueError("Invalid bucket name")
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
                raise StorageError("CREDENTIALS_REQUIRED", "新账号需要提供凭证。")
            if account.provider in {"obs", "s3-compatible"} and not account.endpoint:
                raise StorageError("ENDPOINT_REQUIRED", "请填写服务地址。")
            if account.provider in {"cos", "oss"} and not account.region:
                raise StorageError("REGION_REQUIRED", "请填写地域。")
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
