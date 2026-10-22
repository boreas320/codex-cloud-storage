import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def test_real_stdio_handshake_entrypoint_resources_and_tools(tmp_path):
    root = Path(__file__).resolve().parents[1]
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "cloud_storage.server"],
        cwd=str(root),
        env={**os.environ, "CLOUD_STORAGE_DATA_DIR": str(tmp_path), "PYTHONPATH": str(root / "src")},
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = {t.name: t for t in (await session.list_tools()).tools}
            assert tools["storage.open"].meta["openai/ui"]["entrypoints"] == [{"type": "thread"}]
            assert tools["save_account"].meta["ui"]["visibility"] == ["app"]
            assert not tools["start_download"].annotations.readOnlyHint
            assert tools["list_objects"].annotations.readOnlyHint
            assert not any("delete" in name or "upload" in name for name in tools)
            resource = await session.read_resource("ui://codex-cloud-storage/browser")
            assert "多云对象存储" in resource.contents[0].text
            assert resource.contents[0].mimeType == "text/html;profile=mcp-app"
            opened = await session.call_tool("storage.open", {})
            assert opened.structuredContent["data"]["accounts"] == []
            bad = await session.call_tool(
                "save_account",
                {"account": {"provider": "wrong"}, "credentials": {"secret_key": "NEVER_ECHO_THIS"}},
            )
            assert bad.isError and "NEVER_ECHO_THIS" not in bad.model_dump_json()
