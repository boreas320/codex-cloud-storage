"""Exercise an installed/extracted plugin without touching real account settings."""

import asyncio
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main(root):
    with tempfile.TemporaryDirectory(prefix="cloud-storage-smoke-") as config:
        params = StdioServerParameters(
            command="sh",
            args=[str(root / "scripts/run-server.sh")],
            env={**os.environ, "CLOUD_STORAGE_DATA_DIR": config},
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {t.name: t for t in (await session.list_tools()).tools}
                assert tools["storage.open"].meta["openai/ui"]["entrypoints"] == [{"type": "thread"}]
                assert tools["save_account"].meta["ui"]["visibility"] == ["app"]
                opened = await session.call_tool("storage.open", {})
                assert opened.structuredContent["data"]["accounts"] == []
                assert (
                    opened.structuredContent["data"]["version"]
                    == json.loads((root / "plugin.json").read_text())["version"]
                )
                invalid = await session.call_tool(
                    "save_account",
                    {"account": {"name": "Smoke test", "provider": "obs", "endpoint": "obs.example.invalid"}},
                )
                assert {"endpoint", "access_key", "secret_key"} <= set(
                    invalid.structuredContent["error"]["fields"]
                )
                resource = await session.read_resource("ui://codex-cloud-storage/browser")
                actual = resource.contents[0].text.encode()
                expected = (root / "src/cloud_storage/ui/index.html").read_bytes()
                assert hashlib.sha256(actual).digest() == hashlib.sha256(expected).digest()
                print(
                    f"PASS: {len(tools)} tools; empty-argument thread entrypoint; isolated config; exact UI bytes"
                )


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1]).resolve()))
