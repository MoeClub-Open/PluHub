#!/usr/bin/env python3
"""Exercise the host backup controller against isolated Docker data and containers."""
from pathlib import Path
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import importlib.util
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
IMAGE = os.environ.get("PLUHUB_DOCKER_IMAGE", "pluhub:local")
CLI = ROOT / "deploy/backup.py"


def command(args, success=True):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if success and result.returncode:
        raise RuntimeError("Isolated backup verification command failed (exit %s)" % result.returncode)
    if not success and result.returncode == 0:
        raise RuntimeError("Expected an isolated backup failure")
    return result


def docker(*args):
    return command(["docker", *args]).stdout.decode().strip()


def cli(*args, success=True):
    result = command([sys.executable, "-B", str(CLI), *map(str, args)], success)
    return json.loads(result.stdout) if success else result.returncode


def healthy(name):
    for _ in range(100):
        value = json.loads(docker("inspect", name))[0]
        if value["State"]["Running"] and value["State"].get("Health", {}).get("Status") == "healthy":
            return
        time.sleep(0.5)
    raise RuntimeError("The isolated gateway did not become healthy")


def main():
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("Run isolated deployment verification as root on Linux")
    prefix = "pluhub-backup-manager-" + secrets.token_hex(8)
    volume, name = prefix + "-data", prefix + "-app"
    directory = Path(tempfile.mkdtemp(prefix=prefix + "-"))
    key = directory / "keys/backup.key"
    checks = []
    try:
        (directory / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
        (directory / ".env").write_text("EXAMPLE_TOKEN=synthetic-backup-token\n", encoding="utf-8")
        docker("volume", "create", volume)
        docker("run", "-d", "--name", name, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs=/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000", "--label", "com.docker.compose.service=gateway", "--label", "com.docker.compose.project.working_dir=" + str(directory), "--mount", "type=volume,source=" + volume + ",target=/data", IMAGE)
        healthy(name)
        # Installed plugin artifacts use readable files and traversable directories,
        # unlike the private databases in a fresh deployment. Preserve both modes.
        docker("exec", name, "node", "-e", "const fs=require('node:fs'),p='/data/.pluhub/plugins/restore-fixture';fs.mkdirSync(p+'/dist',{recursive:true,mode:0o755});fs.chmodSync(p,0o755);fs.chmodSync(p+'/dist',0o755);fs.writeFileSync(p+'/dist/index.js','export {};\\n',{mode:0o644});fs.writeFileSync(p+'/private-fixture','synthetic-private-content',{mode:0o600})")
        assert cli("keygen", "--key-file", key) == {"created": True}
        assert key.stat().st_mode & 0o077 == 0
        original_key = key.read_bytes()
        cli("keygen", "--key-file", key, success=False)
        assert key.read_bytes() == original_key
        checks.append("private-key-generation-never-overwrites")
        arguments = ["create-offline", "--container", name, "--directory", directory, "--destination", directory / "backups", "--key-file", key]
        result = cli(*arguments)
        assert result["passed"] and result["serviceRestored"]
        healthy(name)
        assert not (directory / ".pluhub-backup-recovery.json").exists()
        assert not list(directory.glob(".pluhub-backup-meta-*"))
        checks.append("encrypted-backup-and-service-resumption")
        restored = cli("check", "--backup", result["backup"], "--key-file", key, "--image", IMAGE)
        assert restored["passed"] and restored["productionDataModified"] is False and restored["databases"] > 0
        checks.append("independent-matching-image-restore-check")
        docker("stop", "--time", "40", name)
        stopped = cli(*arguments)
        assert stopped["passed"] and stopped["serviceRestored"] is False
        assert json.loads(docker("inspect", name))[0]["State"]["Running"] is False
        docker("start", name); healthy(name)
        checks.append("previously-stopped-service-remains-stopped")
        docker("run", "--rm", "--user", "0", "--cap-drop=ALL", "--cap-add=DAC_OVERRIDE", "--mount", "type=volume,source=" + volume + ",target=/data", "--entrypoint", "ln", IMAGE, "-s", "/nonexistent-fixture-target", "/data/state/fixture-link")
        cli(*arguments, success=False)
        healthy(name)
        assert not (directory / ".pluhub-backup-recovery.json").exists()
        assert not list(directory.glob(".pluhub-backup-meta-*"))
        assert len(list((directory / "backups").glob("*/receipt.json"))) == 2
        checks.append("failed-snapshot-resumes-service-without-successful-receipt")
        docker("run", "--rm", "--user", "0", "--cap-drop=ALL", "--cap-add=DAC_OVERRIDE", "--mount", "type=volume,source=" + volume + ",target=/data", "--entrypoint", "rm", IMAGE, "/data/state/fixture-link")
        item = json.loads(docker("inspect", name))[0]
        docker("stop", "--time", "40", name)
        journal = directory / ".pluhub-backup-recovery.json"
        journal.write_text(json.dumps({"container": item["Id"], "image": item["Image"]}), encoding="utf-8"); journal.chmod(0o600)
        assert cli("recover-service", "--directory", directory) == {"recovered": True}
        healthy(name); assert not journal.exists()
        checks.append("explicit-interrupted-job-service-recovery")
        sys.path.insert(0, str(ROOT / "deploy"))
        spec = importlib.util.spec_from_file_location("backup_schedule", ROOT / "deploy/backup-schedule.py")
        schedule = importlib.util.module_from_spec(spec); spec.loader.exec_module(schedule)
        scheduled = schedule.run_scheduled({"schemaVersion": 1, "enabled": True, "time": datetime.now(timezone.utc).strftime("%H:%M"), "timezone": "UTC", "windowMinutes": 5, "directory": str(directory), "container": name})
        assert scheduled["passed"] and scheduled["storage"] == "local"
        assert json.loads((directory / "backups/daily/latest.json").read_text())["backup"] == scheduled["backup"]
        healthy(name)
        checks.append("scheduled-local-backup-and-independent-restore")
        report = {"passed": True, "image": IMAGE, "imageId": json.loads(docker("image", "inspect", IMAGE))[0]["Id"], "checks": checks, "realPayments": 0, "externalMail": 0, "paidModelCalls": 0}
        output = ROOT / "output/backup-manager-smoke.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        output.chmod(0o644)
        print(json.dumps(report))
    finally:
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        subprocess.run(["docker", "volume", "rm", volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        if not directory.name.startswith(prefix + "-"):
            raise RuntimeError("Unsafe fixture cleanup path")
        shutil.rmtree(directory)


if __name__ == "__main__":
    main()
