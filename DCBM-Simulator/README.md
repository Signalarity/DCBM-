# DCBM Simulator

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
