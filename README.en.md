# Codex Cloud Storage

[简体中文](README.md)

A local, read-only cloud object browser for Codex Desktop. Open it from **New tab → More tools → Plugins and MCP**. Supports AWS S3, Huawei OBS, Tencent COS, Alibaba OSS and S3-compatible endpoints through official SDKs.

Browse accounts → buckets → folders → objects in a compact, lazy-loaded tree with independent branch pagination and retry. Select buckets, folders or objects and use “添加到对话” to append titled metadata to the active editable draft without sending or replacing existing input. Up to 100 items can be added at once; no contents, recursive listings or credentials are included. Hosts without the message extension show copyable text instead. Select regions from provider-specific Chinese labels and exact codes, or enter a custom region. Invalid account settings show field-level messages and focus the first error. Download individual or selected objects directly to disk, with progress, cancellation and collision-safe filenames. Credentials are saved in macOS Keychain. No preview, cloud upload, delete, copy or archive-restore operations are exposed.

![Example UI using synthetic test data](docs/tree-example.png)

## Install

Requires macOS, Codex Desktop with MCP Apps thread entrypoint support, and [uv](https://docs.astral.sh/uv/getting-started/installation/).

```sh
codex plugin marketplace add boreas320/codex-cloud-storage --ref v0.2.0
codex plugin add codex-cloud-storage@cloud-storage
```

The packaged UI needs no Node.js. First launch installs locked Python 3.12 dependencies using uv. Open the plugin in a new chat after installation. Chats already running before installation can retain an old MCP server list; restart Codex if needed.

To install an extracted release ZIP, verify `SHA256SUMS`, then run `sh codex-cloud-storage/scripts/install-local.sh`. Keep the extracted directory for future reinstalls.

Add credentials in the plugin UI, never in chat. Supply known bucket names when your account lacks account-wide ListBuckets permission. OBS and generic S3 require an endpoint; COS and OSS require a region. Only loopback endpoints may use plain HTTP.

Downloads default to `~/Downloads/多云对象存储`. Settings can change this directory. Three transfers run concurrently, with at most 100 active/queued transfers. Downloads use temporary files, size and ETag checks, available server checksums, and an atomic no-overwrite final step. Local SHA-256 is reported separately; ETag is never assumed to be MD5.

## Limits

- macOS only for production credential storage; no plaintext fallback.
- No content preview, recursive folder downloads, resume, object version selection or archive restoration.
- Accounts and download settings persist. Navigation (up to 100 expanded branches, search location and current node) is restored through the host's per-chat model-context state when supported; otherwise it lives in the current view. Transfers last for the service lifetime. A hard termination can leave `.cloud-download-*.part` files.
- App-only credential tools prevent normal model discovery; the host still mediates form submission. No credentials are returned or logged by this plugin.
- Provider adapters use official SDKs. Tests with synthetic responses are not live-provider certification. See [verification](docs/verification.md).

## Development

```sh
uv sync --python 3.12
cd frontend && npm ci && npm run build
npx playwright install chromium
npm test
cd ..
uv run ruff check src tests
uv run python -m pytest -q
uv run python scripts/package.py
```

`PLAYWRIGHT_CHANNEL=chrome npm test` uses an existing local Chrome. `CLOUD_STORAGE_DATA_DIR` isolates configuration for testing. CI runs backend, stdio protocol and UI bridge tests and builds the plugin archive.

## License

Apache-2.0. Independently implemented; inspired by the capabilities of Storage UI, BucketDock and mcp-server-opendal. No business source copied from those projects. See [NOTICE](NOTICE).

## Troubleshooting a host error screen

If the menu entry appears but Codex says it cannot display the app, try a new chat. `unknown MCP server 'cloud-storage'` means the current chat has not loaded the newly installed service; retrying the same tab does not add that service. Restarting Codex can also reload it. If it still fails in a fresh chat, inspect the specific Codex log error without sharing credentials or full account configuration.
