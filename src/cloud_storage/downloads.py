"""Bounded transfer queue with atomic, no-overwrite installation."""

from __future__ import annotations

import base64
import hashlib
import os
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .accounts import StorageError
from .providers import connect, safe_error


def safe_filename(key):
    name = key.rsplit("/", 1)[-1]
    name = "".join("_" if ord(c) < 32 or c in ":\\" else c for c in name)
    if name in {"", ".", ".."}:
        name = "download.bin"
    while len(name.encode("utf-8")) > 180:
        name = name[:-1]
    return name


def install_file(temp: Path, directory: Path, name: str):
    base = Path(name)
    for index in range(10000):
        destination = directory / (name if index == 0 else f"{base.stem} ({index}){base.suffix}")
        try:
            # link is atomic and fails if any file or symlink exists at destination.
            os.link(temp, destination)
            temp.unlink()
            return destination
        except FileExistsError:
            continue
    raise StorageError("NAME_CONFLICT", "下载目录中的同名文件过多，请更改下载目录。")


class Downloads:
    def __init__(self, store, connector=connect):
        self.store, self.connector = store, connector
        self.pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="download")
        self.jobs = {}
        self.events = {}
        self.lock = threading.RLock()

    def start(self, account_id, bucket, key):
        # Confirm account exists without reading credentials into tool results.
        if account_id not in {a["id"] for a in self.store.list()}:
            raise StorageError("ACCOUNT_NOT_FOUND", "账号不存在。")
        directory = Path(self.store.settings()["download_directory"]).expanduser()
        with self.lock:
            if sum(j["status"] in {"queued", "running"} for j in self.jobs.values()) >= 100:
                raise StorageError("QUEUE_FULL", "最多可同时排队 100 个下载，请稍后重试。")
            # Bound completed task history for long-lived Codex sessions.
            if len(self.jobs) >= 500:
                for old in list(self.jobs):
                    if self.jobs[old]["status"] not in {"queued", "running"}:
                        self.jobs.pop(old)
                        self.events.pop(old)
                        break
            task_id = uuid.uuid4().hex
            self.events[task_id] = threading.Event()
            self.jobs[task_id] = {
                "id": task_id,
                "account_id": account_id,
                "bucket": bucket,
                "key": key,
                "status": "queued",
                "bytes": 0,
                "total": None,
                "path": None,
                "error": None,
            }
            self.pool.submit(self._run, task_id, directory)
            return dict(self.jobs[task_id])

    def list(self):
        with self.lock:
            return [dict(j) for j in self.jobs.values()]

    def cancel(self, task_id):
        with self.lock:
            if task_id not in self.jobs:
                raise StorageError("TASK_NOT_FOUND", "下载任务不存在，服务重启后任务历史不会保留。")
            self.events[task_id].set()
            return dict(self.jobs[task_id])

    def _update(self, task_id, **values):
        with self.lock:
            self.jobs[task_id].update(values)

    def _run(self, task_id, directory):
        temp = None
        job, event = self.jobs[task_id], self.events[task_id]
        try:
            if event.is_set():
                raise InterruptedError()
            self._update(task_id, status="running")
            with self.connector(self.store, job["account_id"]) as client:
                info = client.head(job["bucket"], job["key"])
                expected = info["size"]
                self._update(task_id, total=expected)
                directory.mkdir(parents=True, exist_ok=True)
                directory = directory.resolve(strict=True)
                fd, filename = tempfile.mkstemp(prefix=".cloud-download-", suffix=".part", dir=directory)
                temp = Path(filename)
                digest, count = hashlib.sha256(), 0
                md5 = hashlib.md5(usedforsecurity=False)
                from obs.util import Crc64

                crc64 = Crc64()
                with os.fdopen(fd, "wb") as output:
                    with client.stream(job["bucket"], job["key"], info["etag"]) as source:
                        while True:
                            if event.is_set():
                                raise InterruptedError()
                            chunk = source.read(1024 * 1024)
                            if not chunk:
                                break
                            count += len(chunk)
                            if count > expected:
                                raise StorageError("SIZE_MISMATCH", "对象大小发生变化，下载未完成。")
                            output.write(chunk)
                            digest.update(chunk)
                            md5.update(chunk)
                            crc64.update(chunk)
                            self._update(task_id, bytes=count)
                    output.flush()
                    os.fsync(output.fileno())
                if count != expected:
                    raise StorageError("SIZE_MISMATCH", "下载大小与对象大小不一致，请重试。")
                computed = {
                    "sha256": base64.b64encode(digest.digest()).decode(),
                    "md5": base64.b64encode(md5.digest()).decode(),
                    "crc64": str(crc64.crc),
                }
                checksums = getattr(client, "checksums", {})
                if any(computed.get(algorithm) != value for algorithm, value in checksums.items()):
                    raise StorageError("CHECKSUM_MISMATCH", "文件内容与服务端校验值不一致，下载未完成。")
                after = client.head(job["bucket"], job["key"])
                if after["size"] != expected or after["etag"] != info["etag"]:
                    raise StorageError("OBJECT_CHANGED", "下载过程中对象发生变化，请刷新后重试。")
                with self.lock:
                    if event.is_set():
                        raise InterruptedError()
                    destination = install_file(temp, directory, safe_filename(job["key"]))
                    self._update(
                        task_id,
                        status="completed",
                        path=str(destination),
                        sha256=digest.hexdigest(),
                        verification="size-and-etag; local-sha256",
                        server_checksums=list(checksums),
                    )
        except InterruptedError:
            self._update(task_id, status="cancelled")
        except OSError:
            self._update(
                task_id,
                status="failed",
                error={
                    "code": "IO_ERROR",
                    "message": "下载读写失败，请检查网络、下载目录权限与剩余空间。",
                    "request_id": "",
                },
            )
        except Exception as exc:
            self._update(task_id, status="failed", error=safe_error(exc).public())
        finally:
            if temp:
                temp.unlink(missing_ok=True)

    def close(self):
        for event in self.events.values():
            event.set()
        self.pool.shutdown(wait=True, cancel_futures=True)
