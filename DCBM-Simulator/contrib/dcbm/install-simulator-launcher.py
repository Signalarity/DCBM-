#!/usr/bin/env python3
"""Install a desktop entry for this checkout's local DCBM simulator."""
from pathlib import Path
import shutil


def quoted(path):
    return '"' + str(path).replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$') + '"'


def main():
    repo = Path(__file__).resolve().parents[2]
    home = Path.home()
    launcher = repo / 'contrib/dcbm/run-simulator.sh'
    entry = '\n'.join([
        '[Desktop Entry]', 'Version=1.0', 'Type=Application', 'Name=DCBM Simulator',
        'Comment=Explore XBT maturity rules and future hash-rate scenarios',
        'Exec=' + quoted(launcher), 'Path=' + str(repo),
        'Icon=' + str(repo / 'contrib/dcbm/simulator/icon.svg'),
        'Terminal=false', 'Categories=Development;', 'StartupNotify=false',
    ]) + '\n'
    if shutil.which('x-terminal-emulator'):
        entry += '\nActions=Refresh;\n\n[Desktop Action Refresh]\nName=Refresh public headers from Knots\nExec=x-terminal-emulator -e ' + quoted(launcher) + ' --refresh\n'
    for destination in [home / 'Desktop/DCBM-Simulator.desktop', home / '.local/share/applications/dcbm-simulator.desktop']:
        if destination.exists():
            raise SystemExit('Launcher already exists; leaving it unchanged: ' + str(destination))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(entry)
        destination.chmod(0o755)
        print('Installed:', destination)


if __name__ == '__main__':
    main()
