#!/bin/sh
set -eu
PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if ! command -v uv >/dev/null 2>&1; then
  for candidate in "$HOME/.local/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
    if [ -x "$candidate" ]; then PATH="$(dirname "$candidate"):$PATH"; export PATH; break; fi
  done
fi
if ! command -v uv >/dev/null 2>&1; then
  echo 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' >&2
  exit 1
fi
export UV_PROJECT_ENVIRONMENT="${XDG_CACHE_HOME:-$HOME/Library/Caches}/codex-cloud-storage/venv-0.2.1"
exec uv run --project "$PLUGIN_DIR" --python 3.12 --frozen --no-dev --no-editable codex-cloud-storage
