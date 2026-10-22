import gzip
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import os
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("backup_manager", Path(__file__).resolve().parents[1] / "deploy/backup.py")
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)
IMAGE = "sha256:" + "1" * 64


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.archive = self.directory / "backup.tar.gz"

    def tearDown(self):
        self.temporary.cleanup()

    def package(self, extra=(), manifest=None):
        if manifest is None:
            manifest = {"schemaVersion": 1, "imageId": IMAGE, "config": "pluhub.json"}
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, data in [("data/pluhub.json", b"{}"), ("deployment/manifest.json", json.dumps(manifest).encode())]:
                entry = tarfile.TarInfo(name); entry.size = len(data); entry.mode = 0o600
                archive.addfile(entry, io.BytesIO(data))
            for entry in extra:
                archive.addfile(entry, io.BytesIO(b""))

    def test_accepts_data_and_provenance_with_verified_expanded_size(self):
        self.package()
        result = manager.validate_archive(self.archive)
        self.assertEqual(result["manifest"]["imageId"], IMAGE)
        self.assertGreater(result["expandedBytes"], 2)

    def test_rejects_paths_that_escape_or_alias_restore_members(self):
        for name in ["/outside", "../outside", "data/../../outside", "data\\outside", "data/pluhub.json", "other/file"]:
            with self.subTest(name=name):
                self.package([tarfile.TarInfo(name)])
                with self.assertRaises(manager.BackupError):
                    manager.validate_archive(self.archive)

    def test_rejects_links_devices_and_privileged_modes(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.FIFOTYPE]:
            entry = tarfile.TarInfo("data/unsafe"); entry.type = kind; entry.linkname = "/outside"
            self.package([entry])
            with self.assertRaises(manager.BackupError):
                manager.validate_archive(self.archive)
        entry = tarfile.TarInfo("data/setuid"); entry.mode = 0o4755
        self.package([entry])
        with self.assertRaises(manager.BackupError):
            manager.validate_archive(self.archive)

    def test_rejects_invalid_or_unresolvable_image_and_config_metadata(self):
        for manifest in [[], {"schemaVersion": 1}, {"schemaVersion": 2, "imageId": IMAGE, "config": "pluhub.json"}, {"schemaVersion": 1, "imageId": "pluhub:latest", "config": "pluhub.json"}, {"schemaVersion": 1, "imageId": IMAGE, "config": "../outside"}, {"schemaVersion": 1, "imageId": IMAGE, "config": "missing.json"}, {"schemaVersion": 1, "imageId": IMAGE, "config": 42}]:
            self.package(manifest=manifest)
            with self.assertRaises(manager.BackupError):
                manager.validate_archive(self.archive)

    def test_rejects_declared_expansion_before_reading_a_large_payload(self):
        member = tarfile.TarInfo("data/too-large"); member.size = 1024 ** 4 + 1
        with gzip.open(self.archive, "wb") as archive:
            archive.write(member.tobuf() + b"\x00" * 1024)
        with self.assertRaisesRegex(manager.BackupError, "restore limits"):
            manager.validate_archive(self.archive)

    def test_cancels_only_its_known_helper_after_an_operation_deadline(self):
        calls = []
        def docker(*args, **kwargs):
            calls.append(args)
            if args[0] == "run":
                raise subprocess.TimeoutExpired("docker", 1800)
            return ""
        with patch.object(manager, "docker", side_effect=docker):
            with self.assertRaises(subprocess.TimeoutExpired):
                manager.helper([IMAGE, "backup-bundle"])
        self.assertEqual([args[0] for args in calls], ["run", "stop", "rm"])
        name = calls[0][calls[0].index("--name") + 1]
        self.assertTrue(name.startswith("pluhub-backup-job-"))
        self.assertEqual(calls[1][-1], name); self.assertEqual(calls[2][-1], name)

    def test_refuses_changed_images_and_retains_unconfirmed_recovery_state(self):
        journal = self.directory / ".pluhub-backup-recovery.json"
        journal.write_text("{}", encoding="utf-8")
        record = {"container": "a" * 64, "image": IMAGE}
        with patch.object(manager, "inspect_container", return_value={"Image": "sha256:" + "2" * 64}), patch.object(manager, "docker") as docker:
            with self.assertRaises(manager.BackupError):
                manager.resume(self.directory, record)
            docker.assert_not_called()
        with patch.object(manager, "inspect_container", return_value={"Image": IMAGE, "Id": "a" * 64, "State": {"Running": True, "Health": {"Status": "starting"}}}), patch.object(manager.time, "sleep"):
            with self.assertRaisesRegex(manager.BackupError, "did not recover"):
                manager.resume(self.directory, record)
        self.assertTrue(journal.exists())

    def test_does_not_restart_the_gateway_while_its_known_backup_helper_is_still_running(self):
        journal = self.directory / ".pluhub-backup-recovery.json"
        journal.write_text("{}", encoding="utf-8")
        record = {"container": "a" * 64, "image": IMAGE, "helper": "pluhub-backup-job-" + "b" * 32}
        calls = []
        def docker(*args, **kwargs):
            calls.append(args[0])
            return "helper-id" if args[0] == "ps" else json.dumps([{"State": {"Running": True}}])
        with patch.object(manager, "inspect_container", return_value={"Image": IMAGE}), patch.object(manager, "docker", side_effect=docker):
            with self.assertRaisesRegex(manager.BackupError, "still running"):
                manager.resume(self.directory, record)
        self.assertEqual(calls, ["ps", "inspect"])
        self.assertTrue(journal.exists())

    @unittest.skipUnless(sys.platform == "linux", "Linux file locking")
    def test_inherited_maintenance_lock_stays_owned_by_the_parent_operation(self):
        import fcntl
        path = self.directory / ".pluhub-maintenance.lock"
        with path.open("w") as parent:
            path.chmod(0o600)
            fcntl.flock(parent, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.dict(os.environ, {"PLUHUB_MAINTENANCE_FD": str(parent.fileno())}):
                with manager.maintenance(self.directory):
                    pass
            with path.open("r") as other:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == "__main__":
    unittest.main()
