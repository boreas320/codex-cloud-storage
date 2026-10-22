"""Build a self-contained plugin ZIP (no credentials, environments or symlinks)."""

import hashlib
import json
import shutil
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "plugin.json").read_text())["version"]
out = root / "dist"
stage = out / "codex-cloud-storage"
if stage.exists():
    shutil.rmtree(stage)
stage.mkdir(parents=True)
files = [
    "plugin.json",
    "mcp.json",
    ".mcp.json",
    "pyproject.toml",
    "uv.lock",
    "README.md",
    "README.en.md",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_UI_LICENSES.txt",
]
for directory in ["src", "assets", "skills", ".codex-plugin", "scripts", "docs"]:
    files += [
        str(p.relative_to(root))
        for p in (root / directory).rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
    ]
for name in files:
    source = root / name
    if source.is_symlink():
        raise ValueError(f"Symlink cannot be packaged: {name}")
    target = stage / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
for name in ["plugin.json", "mcp.json", ".codex-plugin/plugin.json", ".mcp.json"]:
    json.loads((stage / name).read_text())
assert (stage / "src/cloud_storage/ui/index.html").stat().st_size > 10000
archive = out / f"codex-cloud-storage-{version}.zip"
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
    for p in sorted(stage.rglob("*")):
        if p.is_file():
            z.write(p, str(Path(stage.name) / p.relative_to(stage)))
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
(out / "SHA256SUMS").write_text(f"{digest}  {archive.name}\n")
# Marketplace stays outside the installable archive.
(out / "marketplace.json").write_text(
    json.dumps(
        {
            "name": "cloud-storage",
            "interface": {"displayName": "Cloud Storage"},
            "plugins": [
                {
                    "name": "codex-cloud-storage",
                    "source": {"source": "local", "path": "./codex-cloud-storage"},
                    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                    "category": "Developer Tools",
                }
            ],
        },
        indent=2,
    )
)
print(archive)
print(digest)

manifest_dir = out / ".agents" / "plugins"
manifest_dir.mkdir(parents=True, exist_ok=True)
shutil.copy2(out / "marketplace.json", manifest_dir / "marketplace.json")
