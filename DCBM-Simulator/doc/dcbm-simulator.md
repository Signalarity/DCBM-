# Local DCBM simulator

This tool collects public headers from a local Knots node and generates a
standalone, interactive HTML report. It does not modify the node, access wallet
RPCs, import keys, or activate consensus rules. Once generated, the report works
offline and can be shared without RPC credentials.

## Launch

From the repository root, with Python 3.11 or newer:

```sh
python3 contrib/dcbm/simulator.py --refresh --open
```

The collector defaults to `http://127.0.0.1:8332` with cookie authentication from
`~/.bitcoin/.cookie`. Both can be set with `--rpc-url` and `--cookie-file`.
Only loopback RPC URLs are accepted; credentials in URLs and HTTP redirects
are rejected. The RPC allowlist is `getblockchaininfo`, `getnetworkinfo`,
`getblockhash`, and `getblockheader`.

Outputs are `build/dcbm-simulator/history.json` and
`build/dcbm-simulator/index.html`. The public header snapshot remains usable
when Knots is offline. Subsequent launches can use:

```sh
contrib/dcbm/run-simulator.sh
```

Add `--refresh` to collect a new snapshot. The collector verifies mainnet's
BLAKE2b checkpoint at height 961640, captures a fixed tip, checks contiguous
height/hash links, and confirms that the captured tip has not reorganized
before saving. Headers remain available from a pruned node. Snapshot integrity
metadata is a SHA-256 of the compact, sorted-key JSON header array, not an
independent proof-of-work verification or an authentication signature.

For a desktop launcher tied to the current checkout:

```sh
python3 contrib/dcbm/install-simulator-launcher.py
```

It installs **DCBM Simulator** in the desktop and application menu. The desktop
entry's refresh action opens a terminal to read a fresh snapshot. Its normal
action rebuilds from the cache and opens the HTML report in the default browser.

## Adjustable maturity rules

The initial maturity, hypothetical activation height, upper bound, lower bound,
upward response multiplier, and downward response multiplier are independent.
Bounds apply to the initial assignment as well as each later retarget.

Let `r = old_target / new_target`, the ratio of new difficulty to old difficulty.
With response multiplier `w` selected from the up/down setting:

```text
next = floor(previous * (1 + w * (r - 1)))
```

Then apply the chosen bounds. A disabled cap is genuinely unbounded, using
arbitrary-precision integers. A disabled positive floor permits zero blocks;
negative maturity is never permitted. A cap smaller than the floor is rejected.
Excess above a cap is discarded, not accumulated. Rates are parsed as exact
decimal fractions, so no floating-point percentage arithmetic enters maturity
assignments. The rule applies at genuine 2016-block boundaries strictly after
the chosen activation block. Each reward retains the assignment at its own
mining height; later adjustments do not reprice it.

Default custom settings match the current experiment: initial maturity 25920,
floor 100, cap 105120, upward response 1, downward response 2. Side-by-side
references are the original 1×/1× rule (with its INT_MAX technical ceiling),
a one-year symmetric rule, and a fixed 180-day rule.

These are counterfactual activations, independent of the implementation's real
RDTS expiry gate. Arbitrary custom parameters may not be valid configuration
options for the node. The report changes no public-network consensus rules.

## Future hash-power assumptions

Enter a total percentage change over a chosen number of months or years, rather
than one percentage for each retarget. For example, +50% over five years means
`H(t) = H(0) * 1.5^(t / 5 years)`, approximately +8.45% per year compounded.
The same input accepts negative growth greater than -100%. Optional positive
or negative step events multiply the trend at specified times.

The starting expected block interval is estimated from the work and elapsed
time of the last 120 observed blocks, and is editable. For each future block,
the engine integrates the assumed hash power until one unit of expected block
work has accumulated. Difficulty follows the standard mainnet retarget schedule,
using the observed partial epoch at the snapshot boundary, quarter/fourfold
timespan clamps, the mainnet proof-of-work limit, and compact-target rounding.
Expected timestamps are rounded to whole seconds and constrained by parent MTP.
The horizon is limited to ten years and 600,000 future blocks for browser
responsiveness; a computation limit is explicitly reported.

Projected block intervals use floating-point modeling, while target updates and
maturity ratios use integer arithmetic. The model is deterministic. It does
not model Poisson arrival variance, miner incentives, maturity-driven changes
in hash power, price, reorgs, censorship, or network propagation. Different CBM
rules are compared against the same assumed chain. A falling exponential hash
rate can leave less than one expected block's work in the remaining future;
that is a model outcome, not a claim that a real network cannot find a block.

## Interpret unlock dates

For a reward mined at height `h` with assigned maturity `m`, the first eligible
spend height is `h + m`. If that block is in the historical snapshot, the report
shows its actual timestamp and elapsed time. If it lies in the modeled future,
the report labels the date as modeled. Beyond the available replay, the tool
does not invent an unlock date. Nominal “days” and “years” in the maturity chart
assume ten-minute blocks; they are not calendar guarantees.

## Reproduce and share

Create an allowlisted ZIP for a GitHub Release:

```sh
python3 contrib/dcbm/package-simulator.py
```

The output is `build/dcbm-simulator/DCBM-Simulator-v1.0.zip`, with source,
instructions, license, a file-integrity manifest, a public header snapshot,
and a ready-to-open `index.html`. Extract it before uploading its contents
through GitHub's file-upload interface; uploading a ZIP does not unpack it.
For a single-file GitHub Pages demo, use `build/dcbm-simulator/index.html`.

- **Export JSON** includes the observed public header snapshot and parameters.
  It excludes local paths, RPC authentication, wallet data, and derived future
  headers. Importing it reconstructs the experiment.
- **Export full CSV** includes every activation/retarget, both exact targets,
  all four comparison rules, their parameters, and observed/modeled labels.
- **Save HTML** includes the data, code, and current parameters in one file.
  It requires no server or third-party JavaScript/CDN.

Rebuild a report from an exported experiment entirely offline:

```sh
python3 contrib/dcbm/simulator.py \
  --history-file path/to/dcbm-experiment.json --output-dir /tmp/dcbm-replay
```

Do not treat historical replay as a forecast. Its value is making assumptions
and arithmetic inspectable and reproducible, including unfavorable outcomes.

## Verification

```sh
python3 -m unittest discover -s contrib/dcbm/simulator -p 'test_*.py' -v
node --check contrib/dcbm/simulator/engine.js
node --check contrib/dcbm/simulator/app.js
git diff --check
```

Tests cover the C++ experiment's numerical boundary vectors, exact fractional
rounding, discarded cap excess, optional bounds, original reward assignments,
activation on a retarget boundary, disallowed RPC methods/URLs, Python versus
JavaScript arithmetic, long-period growth conversion, negative hash-power
events, and modeled retargets. Browser checks additionally exercise controls,
historical data, projections, desktop/mobile layouts, and export/import.

## Live browser refresh and sharing preferences

Click **Start at current block** to load public XBT block data directly from
mempool.guide, then activate the hypothetical rule at that height. No visitor
node or login is needed; the explorer receives the request. Hash links and the
XBT checkpoint are checked, but proof of work is not independently verified.
Refresh replaces the dataset only after validation, handles recent reorgs,
and is limited to 200 block-page requests with a 15-second timeout per request.
For an unavailable explorer or an old snapshot, use **Use snapshot tip** offline
or import a newer snapshot. **Start from Spamcoin forking off** restores activation at
the XBT checkpoint. Live starts re-estimate starting block time from recent blocks.

After running final settings, **Copy my preferences** copies a short text summary
for Discord or GitHub. The visible text box also supports manual copying.
Matching rule IDs group the initial maturity, floor, cap, and response rates;
activation and future assumptions are listed separately. These are informal
preferences, not authenticated ballots or on-chain votes. No votes are collected
or sent by the simulator.
