"""Local stdio MCP server with a Codex thread entrypoint."""

from __future__ import annotations

import asyncio
import atexit
import base64
import json
import logging
import os
from pathlib import Path
from typing import Annotated
from urllib.parse import urlparse

from mcp.server.fastmcp import FastMCP
from mcp.server.lowlevel.helper_types import ReadResourceContents
from mcp.types import CallToolResult, Icon, TextContent, ToolAnnotations
from pydantic import Field, ValidationError

from .accounts import AccountInput, AccountStore, Credentials, StorageError, validation_fields
from .downloads import Downloads
from .providers import connect, safe_error

# SDK debug/error messages may contain signed URLs or request headers.
# Only this server's sanitized error responses are emitted to the host.
for namespace in ("boto3", "botocore", "qcloud_cos", "obs", "alibabacloud_oss_v2"):
    sdk_logger = logging.getLogger(namespace)
    sdk_logger.handlers = [logging.NullHandler()]
    sdk_logger.propagate = False

URI = "ui://codex-cloud-storage/browser"
ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="8" y="10" width="48" height="44" rx="12" fill="#14856e"/><path d="M20 24h24M20 32h24M20 40h14" stroke="white" stroke-width="4" stroke-linecap="round"/></svg>'
icons = [
    Icon(
        src="data:image/svg+xml;base64," + base64.b64encode(ICON.encode()).decode(), mimeType="image/svg+xml"
    )
]
mcp = FastMCP(
    "多云对象存储",
    instructions="Browse cloud metadata and download explicitly requested objects locally. Never request credentials in chat.",
)
store = AccountStore(
    Path(os.environ["CLOUD_STORAGE_DATA_DIR"]) if os.environ.get("CLOUD_STORAGE_DATA_DIR") else None
)
downloads = Downloads(store)
atexit.register(downloads.close)
READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=True)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=True)
APP_ONLY = {"ui": {"visibility": ["app"]}}


def result(value=None, error=None):
    data = {"ok": error is None, "data": value} if error is None else {"ok": False, "error": error.public()}
    return CallToolResult(
        content=[TextContent(type="text", text=json.dumps(data, ensure_ascii=False))],
        structuredContent=data,
        isError=error is not None,
    )


async def run(fn, *args):
    try:
        return result(await asyncio.to_thread(fn, *args))
    except ValidationError as exc:
        return result(
            error=StorageError("INVALID_INPUT", "请检查标出的字段。", fields=validation_fields(exc))
        )
    except Exception as exc:
        return result(error=safe_error(exc))


@mcp.tool(
    name="storage.open",
    title="多云对象存储",
    annotations=READ,
    icons=icons,
    meta={"ui": {"resourceUri": URI}, "openai/ui": {"entrypoints": [{"type": "thread"}]}},
)
async def open_storage():
    """Open the multi-cloud object storage browser in a Codex content tab."""
    return await run(lambda: {"accounts": store.list(), "settings": store.settings(), "version": "0.2.1"})


@mcp.resource(URI, mime_type="text/html;profile=mcp-app", title="多云对象存储")
def browser():
    return (Path(__file__).parent / "ui" / "index.html").read_text()


@mcp._mcp_server.read_resource()
async def read_resource(uri):
    if str(uri) != URI:
        raise ValueError("Unknown resource")
    return [
        ReadResourceContents(
            content=browser(),
            mime_type="text/html;profile=mcp-app",
            meta={
                "ui": {"csp": {"connectDomains": [], "resourceDomains": []}},
                "openai/ui": {
                    "preferredDisplayMode": "fullscreen",
                    "availableDisplayModes": ["fullscreen", "inline"],
                },
            },
        )
    ]


@mcp.tool(annotations=READ)
async def list_accounts():
    """List configured cloud accounts without credentials."""
    return await run(store.list)


def operation(account_id, method, *args):
    with connect(store, account_id) as client:
        return getattr(client, method)(*args)


@mcp.tool(annotations=READ)
async def list_buckets(account_id: str, cursor: str = ""):
    """List an account's buckets, or its configured known buckets. Follow next_cursor."""
    return await run(operation, account_id, "buckets", cursor)


@mcp.tool(annotations=READ)
async def list_objects(
    account_id: str,
    bucket: str,
    prefix: str = "",
    cursor: str = "",
    limit: Annotated[int, Field(ge=1, le=1000)] = 200,
):
    """List one page of objects and virtual directories by key prefix. Does not read object content."""
    return await run(operation, account_id, "objects", bucket, prefix, cursor, limit)


@mcp.tool(annotations=READ)
async def head_object(account_id: str, bucket: str, key: str):
    """Read object metadata only."""
    return await run(operation, account_id, "head", bucket, key)


@mcp.tool(annotations=WRITE)
async def start_download(account_id: str, bucket: str, key: str):
    """Start an explicitly requested download into the configured local directory. No cloud writes."""
    return await run(downloads.start, account_id, bucket, key)


@mcp.tool(annotations=READ)
async def get_download_status():
    """List this local service's queued and completed downloads; content never enters chat."""
    return result(downloads.list())


@mcp.tool(annotations=WRITE)
async def cancel_download(task_id: str):
    """Cancel a local download. No remote object is modified."""
    return await run(downloads.cancel, task_id)


@mcp.tool(annotations=WRITE, meta=APP_ONLY)
async def save_account(account: dict, credentials: dict | None = None):
    """App-only: store connection settings with credentials in the macOS Keychain."""

    def save():
        fields = {}
        parsed_account, parsed_credentials = None, None
        try:
            parsed_account = AccountInput.model_validate(account)
        except ValidationError as exc:
            fields.update(validation_fields(exc))
        if credentials is not None:
            try:
                parsed_credentials = Credentials.model_validate(credentials)
            except ValidationError as exc:
                fields.update(validation_fields(exc))
        elif not account.get("id"):
            fields.update(
                access_key="请填写 Access Key ID / SecretId。",
                secret_key="请填写 Secret Access Key / SecretKey。",
            )
        if parsed_account:
            if parsed_account.provider in {"obs", "s3-compatible"} and not parsed_account.endpoint:
                fields["endpoint"] = "请填写服务地址，需以 https:// 开头。"
            if parsed_account.provider in {"cos", "oss"} and not parsed_account.region:
                fields["region"] = "请选择区域或输入自定义区域。"
            host = urlparse(parsed_account.endpoint).hostname or ""
            if parsed_account.provider == "obs" and ".obs." in host and host.endswith(".myhuaweicloud.com"):
                fields["endpoint"] = "此处应填写区域服务地址，不要填写桶域名；请将桶名填入「指定存储桶」。"
        if fields:
            raise StorageError("INVALID_INPUT", "请检查标出的字段。", fields=fields)
        return store.save(parsed_account, parsed_credentials)

    return await run(save)


@mcp.tool(annotations=READ, meta=APP_ONLY)
async def get_settings():
    """App-only: read local preferences."""
    return await run(store.settings)


@mcp.tool(annotations=WRITE, meta=APP_ONLY)
async def save_settings(download_directory: str):
    """App-only: set the absolute local download directory."""
    return await run(store.save_settings, download_directory)


def main():
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
