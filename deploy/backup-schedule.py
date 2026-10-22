#!/usr/bin/env python3
"""Configure local systemd backup windows; never catch up outside the window."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import stat
import subprocess
import sys
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import backup


def validate(value):
    if not isinstance(value, dict) or value.get('schemaVersion') != 1 or type(value.get('enabled')) is not bool:
        raise backup.BackupError('Invalid backup policy')
    if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', value.get('time', '')):
        raise backup.BackupError('Backup time must use HH:MM')
    if not isinstance(value.get('timezone'), str) or not re.fullmatch(r'[A-Za-z_]+(?:/[A-Za-z_+-]+)*', value['timezone']):
        raise backup.BackupError('Invalid backup timezone')
    ZoneInfo(value['timezone'])
    if type(value.get('windowMinutes')) is not int or not 5 <= value['windowMinutes'] <= 120:
        raise backup.BackupError('Backup window must be 5 to 120 minutes')
    directory = PurePosixPath(value.get('directory', ''))
    if not directory.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(directory)) or '..' in directory.parts:
        raise backup.BackupError('Invalid deployment directory')
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', value.get('container', '')):
        raise backup.BackupError('Invalid gateway container name')
    return value


def remaining_window(policy, now):
    local = now.astimezone(ZoneInfo(policy['timezone']))
    hour, minute = map(int, policy['time'].split(':'))
    elapsed = (local.hour * 3600 + local.minute * 60 + local.second - hour * 3600 - minute * 60) % 86400
    return max(0, policy['windowMinutes'] * 60 - elapsed)


def units(policy):
    validate(policy)
    directory = policy['directory']
    service = '\n'.join([
        '[Unit]', 'Description=PluHub local encrypted backup', 'After=docker.service', 'Requires=docker.service', '',
        '[Service]', 'Type=oneshot', 'User=root', 'UMask=0077', 'NoNewPrivileges=true',
        'WorkingDirectory=' + directory,
        'ExecStart=/usr/bin/python3 -B ' + directory + '/deploy/backup-schedule.py run --directory ' + directory,
        'TimeoutStartSec=65min', 'TimeoutStopSec=90s', '',
    ])
    timer = '\n'.join([
        '[Unit]', 'Description=PluHub daily maintenance window', '', '[Timer]',
        'OnCalendar=*-*-* ' + policy['time'] + ':00 ' + policy['timezone'],
        'Persistent=false', 'AccuracySec=1s', 'RandomizedDelaySec=0', 'Unit=pluhub-backup.service', '',
        '[Install]', 'WantedBy=timers.target', '',
    ])
    return service, timer


def run_scheduled(policy):
    validate(policy)
    if not policy['enabled']:
        return {'skipped': True, 'reason': 'disabled'}
    remaining = remaining_window(policy, datetime.now().astimezone())
    if remaining < 120:
        return {'skipped': True, 'reason': 'outside-maintenance-window'}
    directory = Path(policy['directory']).resolve(strict=True)
    args = SimpleNamespace(directory=directory, container=policy['container'], destination=directory / 'backups/daily', key_file=directory / 'keys/backup.key', tool_image=None)
    def deadline(_signal, _frame):
        raise backup.BackupError('Maintenance window ended; recovering the gateway')
    old_alarm = signal.signal(signal.SIGALRM, deadline)
    try:
        # Reserve recovery time. Restore checking happens after service resumption.
        signal.alarm(remaining - 90)
        created = backup.create_offline(args)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_alarm)
    restored = backup.check_backup(SimpleNamespace(backup=Path(created['backup']), key_file=args.key_file, image=created['imageId']))
    verified = {'passed': True, 'backup': created['backup'], 'imageId': created['imageId'], 'databases': restored['databases'], 'verifiedAt': datetime.now().astimezone().isoformat(), 'storage': 'local'}
    backup.private_json(Path(created['backup']).parent / 'verified.json', verified)
    backup.private_json(directory / 'backups/daily/latest.json', verified, replace=True)
    return verified


def load_policy(directory):
    path = directory / 'backup-policy.json'
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise backup.BackupError('Backup policy must be a private regular file')
    value = validate(json.loads(path.read_text()))
    if Path(value['directory']).resolve(strict=True) != directory:
        raise backup.BackupError('Backup policy belongs to another deployment')
    return value


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    configure = commands.add_parser('configure')
    configure.add_argument('--directory', type=Path, required=True)
    configure.add_argument('--container', default='pluhub-gateway-1')
    configure.add_argument('--time', required=True)
    configure.add_argument('--timezone', default='Asia/Shanghai')
    configure.add_argument('--window-minutes', type=int, default=30)
    configure.add_argument('--enable', action='store_true')
    for command in ['run', 'status']:
        item = commands.add_parser(command); item.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise backup.BackupError('Backup scheduling requires root on Linux')
    directory = args.directory.resolve(strict=True)
    if args.command == 'configure':
        policy = validate({'schemaVersion':1, 'enabled':args.enable, 'time':args.time, 'timezone':args.timezone, 'windowMinutes':args.window_minutes, 'directory':str(directory), 'container':args.container})
        service, timer = units(policy)
        backup.private_json(directory / 'backup-policy.json', policy, replace=True)
        for name, content in [('service', service), ('timer', timer)]:
            path = Path('/etc/systemd/system/pluhub-backup.' + name)
            if path.is_symlink():
                raise backup.BackupError('Refusing to replace a linked systemd unit')
            path.write_text(content); path.chmod(0o644)
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        subprocess.run(['systemctl', 'enable' if args.enable else 'disable', '--now', 'pluhub-backup.timer'], check=True)
        print(json.dumps({'configured':True, **policy}))
    elif args.command == 'status':
        print(json.dumps(load_policy(directory)))
    else:
        print(json.dumps(run_scheduled(load_policy(directory))))


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise backup.BackupError('Scheduled backup interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        main()
    except Exception as error:
        print(json.dumps({'passed':False, 'error':str(error) if isinstance(error,backup.BackupError) else 'Scheduled backup failed; inspect service and recovery state'}), file=sys.stderr)
        sys.exit(1)
