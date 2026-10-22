from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
spec = importlib.util.spec_from_file_location('backup_schedule', Path(__file__).resolve().parents[1] / 'deploy/backup-schedule.py')
schedule = importlib.util.module_from_spec(spec); spec.loader.exec_module(schedule)


def policy(**values):
    return {'schemaVersion':1,'enabled':True,'time':'04:00','timezone':'Asia/Shanghai','windowMinutes':30,'directory':'/root/pluhub','container':'pluhub-gateway-1',**values}


class ScheduleTests(unittest.TestCase):
    def test_validates_explicit_times_and_window_limits(self):
        self.assertEqual(schedule.validate(policy()), policy())
        for value in ['4:00','24:00','04:60','04:00\nExecStart=bad']:
            with self.assertRaises(Exception): schedule.validate(policy(time=value))
        for value in [True,4,121]:
            with self.assertRaises(Exception): schedule.validate(policy(windowMinutes=value))

    def test_rejects_unit_specifier_and_path_injection(self):
        for value in ['/root/pluhub%h','/root/test\npath','relative','/root/../other']:
            with self.assertRaises(Exception): schedule.units(policy(directory=value))
        with self.assertRaises(Exception): schedule.units(policy(container='name; bad'))

    def test_uses_the_configured_timezone(self):
        now = datetime(2026,10,22,20,5,tzinfo=timezone.utc)
        self.assertEqual(schedule.remaining_window(policy(),now),25*60)
        self.assertEqual(schedule.remaining_window(policy(time='05:00'),now),0)

    def test_handles_midnight_windows_and_exact_end(self):
        midnight = datetime(2026,10,22,16,5,tzinfo=timezone.utc)
        self.assertEqual(schedule.remaining_window(policy(time='23:50'),midnight),15*60)
        self.assertEqual(schedule.remaining_window(policy(time='00:00',windowMinutes=5),midnight),0)

    def test_does_not_make_missed_tasks_persistent_or_randomly_delay_them(self):
        service,timer=schedule.units(policy())
        self.assertIn('OnCalendar=*-*-* 04:00:00 Asia/Shanghai',timer)
        self.assertIn('Persistent=false',timer)
        self.assertIn('RandomizedDelaySec=0',timer)
        self.assertNotIn('PrivateTmp=true',service)

    def test_skips_disabled_or_out_of_window_without_touching_docker(self):
        with patch.object(schedule.backup,'create_offline') as create:
            self.assertTrue(schedule.run_scheduled(policy(enabled=False))['skipped'])
            with patch.object(schedule,'remaining_window',return_value=0):
                self.assertTrue(schedule.run_scheduled(policy())['skipped'])
            with patch.object(schedule,'remaining_window',return_value=119):
                self.assertTrue(schedule.run_scheduled(policy())['skipped'])
            create.assert_not_called()


if __name__ == '__main__': unittest.main()
