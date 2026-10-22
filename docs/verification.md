# Verification record — v0.1.0

Date: 2026-10-22 (Asia/Shanghai).

| Check | Evidence / status |
|---|---|
| Python backend and stdio protocol | 32 tests passed locally: S3 SDK with Moto, OBS/COS/OSS response shapes, pagination, special keys, config isolation, failures, cancellation, checksum mismatch, no-overwrite finalization, MCP handshake and UI resource |
| Browser interaction | 4 Playwright tests passed using a real Chromium-family browser and a simulated MCP host: account form, navigation, prefix search, metadata, explicit download, narrow layout, account switching isolation dark theme, and host-backed navigation restoration |
| UI build | TypeScript check and single-file production build passed |
| Runtime dependencies | Locked in uv.lock and package-lock.json; npm production audit reported no vulnerabilities |
| Real macOS Keychain | Synthetic credential saved, read back using a fresh vault instance, and deleted successfully; no real cloud credentials used |
| Local Codex installation | `codex plugin add` succeeded; read-back reports installed and enabled |
| Installed package startup | Independent cached plugin launcher completed MCP initialize, listed 11 tools, opened storage.open with empty arguments, and returned the bundled HTML resource |
| Codex menu click | Not verified: the computer-use tool prohibits automating the Codex native window. The thread entrypoint declaration is protocol-tested; actual menu appearance and click need a user check |
| AWS S3 live account | Not tested — no account supplied for this project |
| Huawei OBS live account | Not tested — no account supplied for this project |
| Tencent COS live account | Not tested — no account supplied for this project |
| Alibaba OSS live account | Not tested — no account supplied for this project |
| MinIO live service | Not tested — S3-compatible transport covered by SDK/mocked service tests only |

`browser-example.png` shows **synthetic test data**, not a production cloud bucket or proof of a live cloud download.

To complete real-account acceptance: open the plugin from More tools, add a read-only account in the UI, browse a known bucket, download a known file, compare its hash with a trusted copy, then reopen the app to confirm account settings persist. Repeat for each provider. Do not publish keys, account configuration, or actual bill files as test evidence.

GitHub Actions is the source of truth for remote test/package status. Release assets include SHA256SUMS for verifying the delivered archive.
