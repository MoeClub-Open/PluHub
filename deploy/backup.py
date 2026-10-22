#!/usr/bin/env python3
"""Offline encrypted backups and independent restore checks for Linux Compose deployments."""
import argparse
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid


class BackupError(Exception):
    pass


def docker(*args, packet=None, timeout=180):
    result = subprocess.run(["docker", *args], input=None if packet is None else json.dumps(packet).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise BackupError("Docker operation failed (exit %s)" % result.returncode)
    return result.stdout.decode().strip()


def inspect_container(name, directory):
    value = json.loads(docker("inspect", name))[0]
    labels = value["Config"].get("Labels") or {}
    if labels.get("com.docker.compose.service") != "gateway" or Path(labels.get("com.docker.compose.project.working_dir", "")).resolve() != directory:
        raise BackupError("The container does not belong to this gateway deployment")
    if not re.fullmatch(r"[a-f0-9]{64}", value["Id"]) or not re.fullmatch(r"sha256:[a-f0-9]{64}", value["Image"]):
        raise BackupError("Invalid container identity")
    return value


def read_key(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 66:
        raise BackupError("Backup key must be a private regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        current = os.fstat(stream.fileno())
        if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or current.st_mode & 0o077:
            raise BackupError("Backup key changed while opening")
        value = stream.read(67)
    if len(value) == 32:
        return value
    if re.fullmatch(rb"[a-fA-F0-9]{64}\r?\n?", value):
        return bytes.fromhex(value.decode().strip())
    raise BackupError("Backup key must contain 32 random bytes")


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_json(path, value, replace=False):
    target = path.with_name(".backup-record-" + secrets.token_hex(16)) if replace else path
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n"); stream.flush(); os.fsync(stream.fileno())
        if replace:
            os.replace(target, path)
        sync_directory(path.parent)
    except BaseException:
        try:
            target.unlink()
        except FileNotFoundError:
            pass
        raise


@contextlib.contextmanager
def maintenance(directory):
    import fcntl
    path = directory / ".pluhub-maintenance.lock"
    inherited = os.environ.get("PLUHUB_MAINTENANCE_FD")
    if inherited is not None:
        fd = os.dup(int(inherited))
        current, expected = os.fstat(fd), path.lstat()
        if not stat.S_ISREG(expected.st_mode) or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino):
            os.close(fd)
            raise BackupError("The inherited maintenance lock belongs to another file")
    else:
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "a") as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise BackupError("Another maintenance operation is running")
        yield


def resume(directory, journal):
    item = inspect_container(journal["container"], directory)
    if item["Image"] != journal["image"]:
        raise BackupError("The original container image changed; recovery needs operator review")
    helper_name = journal.get("helper")
    if helper_name:
        if not re.fullmatch(r"pluhub-backup-job-[a-f0-9]{32}", helper_name):
            raise BackupError("Invalid backup helper identity")
        helper_id = docker("ps", "-aq", "--filter", "name=^/" + helper_name + "$")
        if helper_id:
            helper_state = json.loads(docker("inspect", helper_id))[0]["State"]
            if helper_state["Running"]:
                raise BackupError("The backup helper is still running; wait for it before recovering the service")
    restart = journal.get("restart", True)
    if restart and not item["State"]["Running"]:
        docker("start", item["Id"])
    for _ in range(80):
        state = inspect_container(journal["container"], directory)["State"] if restart else {}
        if not restart or state["Running"] and state.get("Health", {}).get("Status") == "healthy":
            if journal.get("staging"):
                staging = Path(journal["staging"])
                if staging.parent != directory or not staging.name.startswith(".pluhub-backup-meta-") or staging.is_symlink():
                    raise BackupError("Unsafe staging directory")
                if staging.exists():
                    shutil.rmtree(staging)
            (directory / ".pluhub-backup-recovery.json").unlink()
            sync_directory(directory)
            return
        time.sleep(0.5)
    raise BackupError("The original gateway did not recover; run recover-service after checking its state")


def mount(source, target, readonly=False):
    source = str(source)
    if any(character in source for character in [",", "\n", "\r", "\x00"]):
        raise BackupError("Unsupported mount path")
    return ["--mount", "type=bind,source=" + source + ",target=" + target + (",readonly" if readonly else "")]


def helper(image, *arguments, packet=None, recovery=None):
    name = "pluhub-backup-job-" + uuid.uuid4().hex
    if recovery is not None:
        directory, journal = recovery
        journal["helper"] = name
        private_json(directory / ".pluhub-backup-recovery.json", journal, replace=True)
    try:
        return docker("run", "--rm", "--name", name, "-i", "--network", "none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--tmpfs=/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000", *arguments, image[0], *image[1:], packet=packet, timeout=1800)
    except BaseException:
        for arguments in [("stop", "--time", "10", name), ("rm", "-f", name)]:
            try:
                docker(*arguments)
            except Exception:
                pass
        raise


def copy_metadata(source, target):
    if not stat.S_ISREG(source.lstat().st_mode):
        raise BackupError("Deployment metadata must be a regular file")
    shutil.copyfile(source, target)
    target.chmod(0o600); os.chown(target, 1000, 1000)


def create_offline(args):
    directory = args.directory.resolve(strict=True)
    key = read_key(args.key_file)
    with maintenance(directory):
        journal_file = directory / ".pluhub-backup-recovery.json"
        if journal_file.exists():
            raise BackupError("An earlier backup needs recover-service before another backup")
        item = inspect_container(args.container, directory)
        data = [mount for mount in item["Mounts"] if mount["Destination"] == "/data"]
        extra = [mount for mount in item["Mounts"] if mount["Destination"] not in ["/data", "/tmp"]]
        if len(data) != 1 or data[0]["Type"] != "volume" or extra:
            raise BackupError("This tool requires one named /data volume and no additional persistent mounts")
        volume = data[0]["Name"]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", volume):
            raise BackupError("Invalid data volume identity")
        tool_image = json.loads(docker("image", "inspect", args.tool_image or item["Image"]))[0]["Id"]
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", tool_image):
            raise BackupError("A local immutable tool image is required")
        docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop=ALL", "--entrypoint", "node", tool_image, "-e", "require('node:fs').accessSync('/opt/pluhub/deploy/docker/backup-bundle.mjs')")
        args.destination.mkdir(mode=0o700, parents=True, exist_ok=True)
        record = args.destination.resolve() / ("backup-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + "-" + uuid.uuid4().hex[:8])
        record.mkdir(mode=0o700); os.chown(record, 1000, 1000)
        sync_directory(record.parent)
        staging = Path(tempfile.mkdtemp(prefix=".pluhub-backup-meta-", dir=directory))
        os.chown(staging, 1000, 1000)
        journal = None
        try:
            copy_metadata(directory / "compose.yaml", staging / "compose.yaml")
            if os.path.lexists(directory / ".env"):
                copy_metadata(directory / ".env", staging / ".env")
            was_running = item["State"]["Running"]
            intent = {"container": item["Id"], "image": item["Image"], "restart": was_running, "staging": str(staging)}
            private_json(journal_file, intent)
            journal = intent
            if was_running:
                docker("stop", "--time", "40", item["Id"])
            receipt = json.loads(helper([tool_image, "backup-bundle", "--output", "/backups/data.phb", "--deployment", "/deployment"], "--mount", "type=volume,source=" + volume + ",target=/data", *mount(staging, "/deployment", True), *mount(record, "/backups"), packet={"key": base64.b64encode(key).decode(), "imageId": item["Image"], "environment": item["Config"].get("Env") or []}, recovery=(directory, journal)))
            archive = record / "data.phb"
            with archive.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if receipt.get("imageId") != item["Image"] or receipt.get("sha256") != digest or receipt.get("bytes") != archive.stat().st_size:
                raise BackupError("Backup receipt verification failed")
            private_json(record / "receipt.json", receipt)
        finally:
            if journal is not None:
                resume(directory, journal)
            else:
                if staging.parent != directory or not staging.name.startswith(".pluhub-backup-meta-"):
                    raise BackupError("Unsafe staging directory")
                shutil.rmtree(staging)
        return {"passed": True, "backup": str(record / "data.phb"), "imageId": item["Image"], "serviceRestored": was_running}


def validate_archive(path):
    names, total = set(), 0
    with tarfile.open(path, "r:gz") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or ".." in name.parts or "\\" in member.name or "\x00" in member.name or not name.parts or name.parts[0] not in ["data", "deployment"] or str(name) in names:
                raise BackupError("Unsafe or duplicate archive path")
            if not (member.isfile() or member.isdir()) or member.mode & 0o7000 or member.size < 0:
                raise BackupError("Unsafe archive member")
            names.add(str(name)); total += member.size
            if len(names) > 1000000 or total > 1024 ** 4:
                raise BackupError("Archive exceeds restore limits")
        if "deployment/manifest.json" not in names:
            raise BackupError("Backup manifest is missing")
        member = archive.getmember("deployment/manifest.json")
        if not member.isfile() or member.size > 65536:
            raise BackupError("Invalid backup manifest")
        manifest = json.load(archive.extractfile(member))
        if not isinstance(manifest, dict) or not isinstance(manifest.get("config"), str) or not isinstance(manifest.get("imageId"), str) or "\\" in manifest["config"] or "\x00" in manifest["config"]:
            raise BackupError("Invalid backup manifest")
        config = PurePosixPath(manifest.get("config", ""))
        if manifest.get("schemaVersion") != 1 or not re.fullmatch(r"sha256:[a-f0-9]{64}", manifest.get("imageId", "")) or config.is_absolute() or ".." in config.parts or not config.parts or "data/" + str(config) not in names:
            raise BackupError("Invalid backup manifest")
    return {"manifest": manifest, "expandedBytes": total}


def check_backup(args):
    key = read_key(args.key_file)
    image = json.loads(docker("image", "inspect", args.image))[0]["Id"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise BackupError("A local immutable tool image is required")
    staging = Path(tempfile.mkdtemp(prefix="pluhub-restore-check-")); os.chown(staging, 1000, 1000)
    volume = "pluhub-restore-check-" + uuid.uuid4().hex
    volume_created = False
    try:
        if not stat.S_ISREG(args.backup.lstat().st_mode):
            raise BackupError("Backup must be a regular file")
        archive = args.backup.resolve(strict=True)
        if shutil.disk_usage(staging).free < archive.stat().st_size + 1024 ** 3:
            raise BackupError("Insufficient space for authenticated restore checking")
        helper([image, "backup-decrypt", "--input", "/input/data.phb", "--output", "/backups/authenticated.tar.gz"], *mount(archive, "/input/data.phb", True), *mount(staging, "/backups"), packet={"key": base64.b64encode(key).decode()})
        validated = validate_archive(staging / "authenticated.tar.gz")
        manifest = validated["manifest"]
        original_image = json.loads(docker("image", "inspect", manifest["imageId"]))[0]["Id"]
        if original_image != manifest["imageId"]:
            raise BackupError("The matching application image is unavailable")
        docker("volume", "create", volume); volume_created = True
        available = json.loads(helper([original_image, "-e", "const s=require('node:fs').statfsSync('/data');console.log(JSON.stringify({available:s.bavail*s.bsize}))"], "--entrypoint", "node", "--mount", "type=volume,source=" + volume + ",target=/data"))["available"]
        if validated["expandedBytes"] > available - 1024 ** 3:
            raise BackupError("Insufficient data-volume space for restore checking")
        docker("run", "--rm", "--network", "none", "--user", "0", "--read-only", "--cap-drop=ALL", "--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER", "--security-opt=no-new-privileges", *mount(staging, "/backups", True), "--mount", "type=volume,source=" + volume + ",target=/data", "--entrypoint", "tar", original_image, "-xzf", "/backups/authenticated.tar.gz", "--strip-components=1", "-C", "/data", "data")
        result = json.loads(helper([original_image, "verify-data"], "-e", "PLUHUB_CONFIG=/data/" + manifest["config"], "--mount", "type=volume,source=" + volume + ",target=/data"))
        if not result.get("passed"):
            raise BackupError("Restored data validation failed")
        return {"passed": True, "imageId": original_image, "databases": len(result["databases"]), "productionDataModified": False}
    finally:
        try:
            if volume_created:
                docker("volume", "rm", volume)
        finally:
            if not staging.name.startswith("pluhub-restore-check-"):
                raise BackupError("Unsafe restore directory")
            shutil.rmtree(staging)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    keygen = commands.add_parser("keygen"); keygen.add_argument("--key-file", type=Path, required=True)
    create = commands.add_parser("create-offline"); create.add_argument("--container", required=True); create.add_argument("--directory", type=Path, required=True); create.add_argument("--destination", type=Path, required=True); create.add_argument("--key-file", type=Path, required=True); create.add_argument("--tool-image")
    check = commands.add_parser("check"); check.add_argument("--backup", type=Path, required=True); check.add_argument("--key-file", type=Path, required=True); check.add_argument("--image", required=True)
    recover = commands.add_parser("recover-service"); recover.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "linux":
        raise BackupError("This deployment tool requires Linux")
    if args.command != "keygen" and os.geteuid() != 0:
        raise BackupError("Gateway backup maintenance requires root on the deployment host")
    if args.command == "keygen":
        args.key_file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd = os.open(args.key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(secrets.token_bytes(32)); stream.flush(); os.fsync(stream.fileno())
        sync_directory(args.key_file.parent)
        result = {"created": True}
    elif args.command == "create-offline":
        result = create_offline(args)
    elif args.command == "check":
        result = check_backup(args)
    else:
        directory = args.directory.resolve(strict=True)
        with maintenance(directory):
            path = directory / ".pluhub-backup-recovery.json"
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                raise BackupError("Invalid recovery record")
            resume(directory, json.loads(path.read_text()))
        result = {"recovered": True}
    print(json.dumps(result))


if __name__ == "__main__":
    def interrupted(_number, _frame):
        raise BackupError("Backup interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    except Exception as error:
        print(json.dumps({"passed": False, "error": str(error) if isinstance(error, BackupError) else "Backup operation failed; inspect the service and recovery record"}), file=sys.stderr)
        sys.exit(1)
