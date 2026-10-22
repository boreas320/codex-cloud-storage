#!/bin/sh
# Register an extracted release using Codex's supported local marketplace workflow.
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MANIFEST="$PLUGIN_DIR/.agents/plugins/marketplace.json"
if [ ! -f "$MANIFEST" ]; then
  mkdir -p "$(dirname "$MANIFEST")"
  cat > "$MANIFEST" <<'JSON'
{
  "name": "cloud-storage",
  "interface": { "displayName": "Cloud Storage" },
  "plugins": [{
    "name": "codex-cloud-storage",
    "source": { "source": "local", "path": "./" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Developer Tools"
  }]
}
JSON
fi
codex plugin marketplace add "$PLUGIN_DIR"
codex plugin add codex-cloud-storage@cloud-storage
