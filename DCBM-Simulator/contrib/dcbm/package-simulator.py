#!/usr/bin/env python3
"""Build an allowlisted, self-contained DCBM simulator ZIP for GitHub releases."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[2]
FILES = [
    'contrib/dcbm/simulator.py', 'contrib/dcbm/package-simulator.py',
    'contrib/dcbm/run-simulator.sh', 'contrib/dcbm/install-simulator-launcher.py',
    'contrib/dcbm/simulator/engine.js', 'contrib/dcbm/simulator/app.js',
    'contrib/dcbm/simulator/style.css', 'contrib/dcbm/simulator/report.html',
    'contrib/dcbm/simulator/icon.svg', 'contrib/dcbm/simulator/test_simulator.py',
    'doc/dcbm-simulator.md',
]

README = """# DCBM Simulator

An independent, offline simulator for Experimental Dynamic Coinbase Maturity on
the XBT BLAKE2b chain. This is not an official Bitcoin Knots release and does not
activate consensus rules. No installation is needed to explore the report.

## Open it

Extract this ZIP and double-click **index.html**. It works offline in a modern
browser. All JavaScript, styling, parameters, and public header data are included.

Customize maturity caps/floors (including none), response rates, activation,
initial maturity, future hash-rate trends over months/years, and step changes.
Use **Copy my preferences** for a pasteable Discord/GitHub voting summary with
a consistent rule ID. This is informal discussion; no votes are sent or collected.
Export experiments as JSON, retarget tables as CSV, or customized HTML reports.
Use **Start at current block** to fetch public blocks from mempool.guide and
activate the hypothetical rule at the latest height. No visitor node is needed.
This optional browser request requires internet and trusts the public explorer.
If unavailable, **Use snapshot tip** starts from the included offline data.
**Start from Spamcoin forking off** restores the historical starting point.

Future outcomes are assumptions, not forecasts. The included snapshot is fixed;
its exact height, hash, and collection time appear in the simulator.

## Put it on GitHub

- **Downloadable release:** Attach `DCBM-Simulator-v1.0.zip` to a GitHub Release.
  Visitors download and extract the ZIP, then open `index.html`.
- **Browse the source:** Extract the ZIP, then upload its contents to your
  repository using **Add file → Upload files**. Uploading a ZIP through that
  screen stores the ZIP; GitHub does not automatically extract it.
- **Live GitHub Pages demo:** Upload `index.html` to the root of a Pages branch
  or to its configured `/docs` folder, then enable that source in
  **Settings → Pages**. The single HTML file needs no build step or backend.
  Enabling Pages publishes the included public snapshot and simulator.

No pull request is needed to upload files to a repository you own.

## Rebuild offline from source

Python 3.11 or newer is required; no pip dependencies are needed.

```sh
python3 contrib/dcbm/simulator.py --history-file data/history.json
```

The regenerated report is `build/dcbm-simulator/index.html`. To collect a newer
snapshot from your own local Knots node, run:

```sh
python3 contrib/dcbm/simulator.py --refresh --open
```

The collector accepts loopback RPC only, uses your local cookie for authentication,
and permits four public-chain read methods. It never puts credentials in exports.
The browser report itself never connects to RPC.

## Tests and package integrity

```sh
python3 -m unittest discover -s contrib/dcbm/simulator -p 'test_*.py' -v
```

The optional cross-language tests use Node.js. `MANIFEST.json` records the SHA-256
of each bundled file. These checksums detect changes; they are not release
signatures or a security audit. Full methodology: `doc/dcbm-simulator.md`.

## Contents and privacy

Only simulator source, instructions, license, a ready-made report, and public
block headers are included. No wallet files, private keys, RPC cookies, passwords,
Lightning data, unrelated node source/binaries, or source backup files are bundled.

License: MIT; see `LICENSE`.
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--history-file', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/dcbm-simulator/DCBM-Simulator-v1.0.zip')
    args = parser.parse_args()
    source = ROOT / 'contrib/dcbm/simulator.py'
    spec = importlib.util.spec_from_file_location('dcbm_package_report', source)
    simulator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(simulator)
    history = args.history_file or ROOT / 'build/dcbm-simulator/history.json'
    if not history.exists():
        history = ROOT / 'data/history.json'
    data = simulator.validate_dataset(json.loads(history.read_text()))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    report = args.output.parent / 'index.html'
    simulator.report(data, report)
    members = {name: (ROOT / name).read_bytes() for name in FILES}
    license_path = ROOT / 'COPYING' if (ROOT / 'COPYING').exists() else ROOT / 'LICENSE'
    members.update({'README.md': README.encode(), 'LICENSE': license_path.read_bytes(),
                    'index.html': report.read_bytes(),
                    'data/history.json': json.dumps(data, separators=(',', ':')).encode()})
    manifest = {'package': 'DCBM Simulator', 'version': '1.0',
                'created_at': datetime.now(timezone.utc).isoformat(),
                'snapshot_height': data['snapshot']['height'], 'snapshot_hash': data['snapshot']['hash'],
                'files': {name: hashlib.sha256(content).hexdigest() for name, content in sorted(members.items())}}
    members['MANIFEST.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    temporary = args.output.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(members.items()):
            info = zipfile.ZipInfo('DCBM-Simulator/' + name)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if name.endswith('run-simulator.sh') else 0o644) << 16
            archive.writestr(info, content)
    temporary.replace(args.output)
    digest = hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.with_suffix('.zip.sha256').write_text(digest + '  ' + args.output.name + '\n')
    print('GitHub ZIP:', args.output)
    print('Standalone Pages file:', report)
    print('Size:', f'{args.output.stat().st_size / 1024 / 1024:.2f} MiB')
    print('SHA-256:', digest)


if __name__ == '__main__':
    main()
