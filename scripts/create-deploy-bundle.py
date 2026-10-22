"""Create the three source contexts needed for a remote Docker build, without local state."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import tarfile

root = Path(__file__).resolve().parents[1]
target = root / "output" / "deploy" / "pluhub-source.tar.gz"
target.parent.mkdir(parents=True, exist_ok=True)
excluded = {".git", "node_modules", "dist", "output", ".pluhub", ".cache-tools", ".playwright-cli", "coverage", "__pycache__"}


def keep(info):
    parts = PurePosixPath(info.name).parts
    if any(part in excluded or part.startswith(".pluhub-") for part in parts):
        return None
    if len(parts) > 1 and parts[1] in {"keys", "backups"}:
        return None
    name = parts[-1]
    if name.startswith(".env") and name != ".env.example":
        return None
    if info.issym() or info.islnk():
        raise ValueError("Unexpected source symlink: " + info.name)
    if name == "pluhub.json" or name.endswith((".tgz", ".pid", ".tsbuildinfo", ".pem", ".key", ".phb", ".pyc", ".sqlite", ".sqlite-wal", ".sqlite-shm")):
        return None
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    return info


def create_bundle(destination=target, names=("PluHub", "PluHub-Spec", "PluHub-Plugins")):
    with tarfile.open(destination, "w:gz") as archive:
        for name in names:
            archive.add(root.parent / name, arcname=name, filter=keep)

if __name__ == "__main__":
    create_bundle()
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    manifest = {"file": target.name, "sha256": digest, "bytes": target.stat().st_size}
    target.with_suffix(".json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest))
