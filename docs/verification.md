# Verification record — v0.1.0

Date: 2026-10-22 (Asia/Shanghai).

| Check | Evidence / status |
|---|---|
| Python backend and stdio protocol | 32 tests passed locally: S3 SDK with Moto, OBS/COS/OSS response shapes, pagination, special keys, config isolation, failures, cancellation, checksum mismatch, no-overwrite finalization, MCP handshake and UI resource |
| Browser interaction | 4 Playwright tests passed using a real Chromium-family browser and a simulated MCP host: account form, navigation, prefix search, metadata, explicit download, narrow layout, account switching isolation, dark theme, and host-backed navigation restoration |
| UI build | TypeScript check and single-file production build passed |
| Runtime dependencies | Locked in uv.lock and package-lock.json; npm production audit reported no vulnerabilities |
| Real macOS Keychain | Synthetic credential saved, read back using a fresh vault instance, and deleted successfully; no real cloud credentials used |
| Local Codex installation | `codex plugin add` succeeded; read-back reports installed and enabled |
| Installed package startup | Both the GitHub-tag-installed plugin and independently downloaded/extracted release completed MCP initialize, listed 11 tools, opened storage.open with empty arguments, and returned HTML matching the packaged resource byte-for-byte |
| GitHub publication | Public repository and v0.1.0 release published; ZIP and SHA256SUMS downloaded again and verified. GitHub Actions run 39757466064 passed |
| Codex menu and actual rendering | Entry discovered by the user. In a fresh Codex chat, storage.open succeeded and the real MCP Apps page and screenshot were inspected: the onboarding UI renders correctly. See codex-live-ui.png. Pre-install chats can fail with `unknown MCP server 'cloud-storage'`; open a new chat or restart Codex. |
| AWS S3 live account | Not tested — no account supplied for this project |
| Huawei OBS live account | Not tested — no account supplied for this project |
| Tencent COS live account | Not tested — no account supplied for this project |
| Alibaba OSS live account | Not tested — no account supplied for this project |
| MinIO live service | Not tested — S3-compatible transport covered by SDK/mocked service tests only |

`browser-example.png` shows **synthetic test data**, not a production cloud bucket or proof of a live cloud download.

To complete real-account acceptance: open the plugin from More tools, add a read-only account in the UI, browse a known bucket, download a known file, compare its hash with a trusted copy, then reopen the app to confirm account settings persist. Repeat for each provider. Do not publish keys, account configuration, or actual bill files as test evidence.

GitHub Actions is the source of truth for remote test/package status. Release assets include SHA256SUMS for verifying the delivered archive.

Post-release acceptance: actual rendering was verified after v0.1.0 assets were built. The archive retains the build-time verification snapshot; this document and release notes contain the later evidence. No application code changed.

![Actual Codex MCP App, no cloud accounts configured](codex-live-ui.png)

## v0.1.1 — field validation and region selector

- 41 Python tests and 7 Playwright interaction tests passed locally.
- Regression cases cover missing HTTPS, OBS bucket URLs, malformed endpoint ports/paths, required fields, malformed secret fields without echoing submitted secrets, provider-specific region selection, custom-region preservation, and error focus/recovery.
- Screenshot `validation-example.png` uses synthetic inputs with a simulated MCP host. It demonstrates field errors and the region selector, not a live cloud account connection.
- No real account configuration or Keychain entry was read or modified during this update. Fresh Codex rendering evidence above applies to v0.1.0; v0.1.1 UI behavior is tested in a browser harness and its package startup is checked independently.

![Field validation using synthetic inputs](validation-example.png)

## v0.2.0 — resource tree and conversation drafts

- 41 backend/protocol tests and 13 Playwright tests passed locally; TypeScript and the production UI build passed.
- New coverage: independent account branches, branch pagination and retry, collapse while loading, keyboard expansion, per-chat tree restoration, exact Unicode/special-character keys, stale-selection removal on refresh, cross-account multi-selection/download, and bucket/folder/object metadata attachments.
- The simulated host asserts `ui/message` uses `target: active` and `send: false`, with a titled item for each selection. No message is emitted by browsing alone, and attachments do not issue download or content-read calls. Rejected messages show failure; absent capabilities offer copyable text.
- `tree-example.png` uses synthetic accounts and objects with a simulated MCP host. These checks do not certify the native Codex composer or a live cloud transfer. The prior native screenshot remains evidence for v0.1.0 only.
- No real cloud credentials or Keychain entries were read or modified for this change. Existing account configuration and download settings were not modified.
- The updated local package reports v0.2.0 and passes isolated startup; an actual `storage.open` call in the pre-existing chat still reports v0.1.1. A fresh chat or host restart is required before native acceptance of the new UI. This call checked version/public metadata only, without a cloud operation.
- CI uses the Chrome browser preinstalled on GitHub's Ubuntu 24.04 runner, matching the local Playwright channel. This avoids a slow Ubuntu package-mirror dependency download; all interaction tests remain enabled.

![Tree view with synthetic accounts and objects](tree-example.png)

## v0.2.1 — consecutive attachments and copy fallback

- Fixes the v0.2.0 report where the first addition worked but later additions returned `The composer is unavailable`. Titled metadata now uses the model-context extension instead of the message/composer append path.
- Local checks: 41 backend/protocol tests and 19 frontend tests, including serial context updates, delayed echoes, host clear/removal, duplicate and cross-account selections, navigation preservation, failure/retry, unsupported capability and a 320px copy dialog. TypeScript, production UI build and Ruff checks pass. Tests use synthetic data and a simulated host.
- A fresh native Codex chat actually ran 0.2.1-dev.1. Bucket, folder, object and repeated cross-account additions returned success feedback without reproducing the old error; copy text matched selected metadata. This proves plugin feedback and metadata, not native composer attachment rendering or persistence.
- Native clipboard access fell back to the manual-copy hint; actual clipboard contents were not verified. The narrow-dialog correction in dev.2 is covered by browser geometry/click tests.
- On 2026-10-22 the user explicitly confirmed that, in 0.2.1-dev.2, consecutively adding a bucket, directory and object accumulates visible native composer attachments and preserves existing input text. This is user-confirmed native acceptance; the allowed MCP Apps interface does not expose the native composer to automation. Deduplication and removal/clear remain covered by simulated-host tests, not a separate user-confirmed native check.
- The v0.2.1 candidate ZIP was checksum-verified, independently extracted and started with isolated configuration: 11 tools, empty-argument thread entrypoint, exact packaged UI bytes.
- No cloud adapter, credential storage or download behavior changed in this patch. Live account download acceptance remains outside this verification. Public screenshots and fixtures contain synthetic data only; private native-validation evidence is not included.

- Removed the redundant bottom account/path status line at the user’s request. Full object keys remain in object details and copied/attached metadata; toolbar buttons still show selection counts.

## v0.2.2 — tree disclosure alignment

- Replaced font-based disclosure characters with centered 16px SVG chevrons in fixed-height inline-flex buttons. Expanded and collapsed controls no longer depend on glyph baselines; tree icons use block SVG layout.
- TypeScript/build, 19 existing frontend tests, 41 backend tests and Ruff pass. Reviewed the regenerated synthetic tree screenshot for both expanded and collapsed alignment. Native Codex rendering of this patch has not been independently observed.
