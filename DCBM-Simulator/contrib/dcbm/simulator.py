#!/usr/bin/env python3
"""Read-only XBT header collector and standalone DCBM simulation report builder.

No third-party Python packages, wallet RPCs, or web server are required.
"""

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

FORK_HEIGHT = 961640
FORK_HASH = "0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb"
INTERVAL = 2016
SPACING = 600
ORIGINAL_MAXIMUM = 2147483647
ASSETS = Path(__file__).with_name("simulator")
READ_METHODS = {"getblockchaininfo", "getblockhash", "getblockheader", "getnetworkinfo"}


def decode_compact(bits):
    value = int(bits, 16) if isinstance(bits, str) else bits
    if not isinstance(value, int) or not 0 <= value <= 0xFFFFFFFF:
        raise ValueError("Invalid compact target")
    size, word = value >> 24, value & 0x007FFFFF
    target = word >> (8 * (3 - size)) if size <= 3 else word << (8 * (size - 3))
    if target <= 0 or value & 0x00800000 or target.bit_length() > 256:
        raise ValueError("Target must be positive and fit in 256 bits")
    return target


def encode_compact(target):
    if not isinstance(target, int) or not 0 < target < 1 << 256:
        raise ValueError("Invalid target")
    size = (target.bit_length() + 7) // 8
    word = target << (8 * (3 - size)) if size <= 3 else target >> (8 * (size - 3))
    if word & 0x00800000:
        word >>= 8
        size += 1
    return f"{(size << 24) | word:08x}"


def bounds(value, floor=100, cap=105120):
    # Disabling the configurable floor permits zero, never negative maturity.
    lower = 0 if floor is None else int(floor)
    upper = None if cap is None else int(cap)
    if lower < 0 or upper is not None and upper < lower:
        raise ValueError("Cap must be at least the nonnegative floor")
    return max(lower, value) if upper is None else max(lower, min(upper, value))


def adjust_maturity(previous, old_bits, new_bits, *, floor=100, cap=105120, up="1", down="2"):
    previous = bounds(int(previous), floor, cap)
    old, new = decode_compact(old_bits), decode_compact(new_bits)
    up, down = Fraction(str(up)), Fraction(str(down))
    if up < 0 or down < 0:
        raise ValueError("Response multipliers must be nonnegative")
    ratio = Fraction(old, new)
    response = up if ratio >= 1 else down
    factor = 1 + response * (ratio - 1)
    # A single exact floor, including for negative factors, then apply bounds.
    return bounds((previous * factor.numerator) // factor.denominator, floor, cap)


def replay(headers, activation, initial=25920, **rule):
    """Return epoch assignments. An origin block keeps its epoch's maturity."""
    by_height = {h["height"]: h for h in headers}
    if activation not in by_height:
        raise ValueError("Activation is outside the header snapshot")
    maturity = bounds(int(initial), rule.get("floor", 100), rule.get("cap", 105120))
    result = [{"height": activation, "maturity": maturity}]
    for h in headers:
        height = h["height"]
        if height <= activation or height % INTERVAL:
            continue
        maturity = adjust_maturity(maturity, by_height[height - 1]["bits"], h["bits"], **rule)
        result.append({"height": height, "maturity": maturity})
    return result


def reward_status(headers, epochs, origin):
    by_height = {h["height"]: h for h in headers}
    applicable = [e for e in epochs if e["height"] <= origin]
    if origin not in by_height or not applicable:
        raise ValueError("Reward is outside the replay")
    maturity = applicable[-1]["maturity"]
    unlock = origin + maturity
    block = by_height.get(unlock)
    return {"maturity": maturity, "unlock_height": unlock,
            "unlock_time": None if block is None else block["time"],
            "elapsed_seconds": None if block is None else block["time"] - by_height[origin]["time"]}


class LocalRPC:
    """Only explicitly allowed read methods, with cookie auth kept in memory."""

    def __init__(self, url, cookie):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme not in ("http", "https") or parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("RPC must point to a loopback address")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("RPC URL must not contain credentials, query strings, or fragments")
        self.url = url
        self.authorization = "Basic " + base64.b64encode(Path(cookie).read_bytes().strip()).decode("ascii")

    def batch(self, calls):
        if any(method not in READ_METHODS for method, _ in calls):
            raise ValueError("Only the header collector's read-only RPC methods are permitted")
        body = [{"jsonrpc": "1.0", "id": i, "method": method, "params": params}
                for i, (method, params) in enumerate(calls)]
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", "Authorization": self.authorization})
        # Do not send the local RPC cookie to a redirect destination.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        try:
            with opener.open(request, timeout=60) as response:
                rows = json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"Local RPC returned HTTP {error.code}; check that Knots is running") from None
        except urllib.error.URLError:
            raise RuntimeError("Could not reach the local Knots RPC server") from None
        if not isinstance(rows, list) or len(rows) != len(calls):
            raise RuntimeError("Incomplete RPC batch response")
        results = {}
        for row in rows:
            if row.get("error"):
                raise RuntimeError(f"Read-only RPC failed with code {row['error'].get('code')}")
            ident = row.get("id")
            if not isinstance(ident, int) or not 0 <= ident < len(calls) or ident in results:
                raise RuntimeError("Invalid RPC response IDs")
            results[ident] = row["result"]
        return [results[i] for i in range(len(calls))]

    def call(self, method, *params):
        return self.batch([(method, list(params))])[0]


def validate_dataset(data):
    if data.get("schema") != "dcbm-history-v1" or data.get("network") != "xbt-main":
        raise ValueError("Expected an XBT mainnet DCBM history snapshot")
    headers = data.get("headers", [])
    if not headers or len(headers) > 500000:
        raise ValueError("Invalid or oversized header snapshot")
    if headers[0].get("height") != FORK_HEIGHT or headers[0].get("hash") != FORK_HASH:
        raise ValueError("Snapshot does not start at the XBT BLAKE2b checkpoint")
    previous = None
    for header in headers:
        if not isinstance(header.get("height"), int) or not isinstance(header.get("time"), int):
            raise ValueError("Header height and timestamp must be integers")
        if not 0 <= header["time"] <= 0xFFFFFFFF:
            raise ValueError("Invalid header timestamp")
        if not isinstance(header.get("hash"), str) or len(header["hash"]) != 64:
            raise ValueError("Invalid block hash")
        int(header["hash"], 16)
        decode_compact(header["bits"])
        if previous and (header["height"] != previous["height"] + 1 or header.get("prev") != previous["hash"]):
            raise ValueError("Header snapshot has a gap or inconsistent hash links")
        previous = header
    snapshot = data.get("snapshot", {})
    if snapshot.get("height") != previous["height"] or snapshot.get("hash") != previous["hash"]:
        raise ValueError("Snapshot tip metadata does not match its headers")
    return data


def collect(rpc):
    info = rpc.call("getblockchaininfo")
    if info["chain"] != "main" or info["blocks"] < FORK_HEIGHT:
        raise ValueError("Collector requires a synced XBT mainnet node")
    if rpc.call("getblockhash", FORK_HEIGHT) != FORK_HASH:
        raise ValueError("This node is not on the expected XBT BLAKE2b chain")
    version = rpc.call("getnetworkinfo")["version"]
    tip, tip_hash = info["blocks"], info["bestblockhash"]
    batches = [list(range(start, min(start + 128, tip + 1)))
               for start in range(FORK_HEIGHT, tip + 1, 128)]

    def fetch(heights):
        hashes = rpc.batch([("getblockhash", [h]) for h in heights])
        headers = rpc.batch([("getblockheader", [h, True]) for h in hashes])
        result = []
        for height, expected_hash, row in zip(heights, hashes, headers):
            if row["height"] != height or row["hash"] != expected_hash:
                raise RuntimeError("Node returned inconsistent header data")
            result.append({"height": height, "time": row["time"], "bits": row["bits"],
                           "hash": row["hash"], "prev": row.get("previousblockhash")})
        return result

    headers = []
    print(f"Reading {tip - FORK_HEIGHT + 1:,} public headers from your local node…", flush=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        for rows in pool.map(fetch, batches):
            headers.extend(rows)
            if len(headers) // 1024 != (len(headers) - len(rows)) // 1024:
                print(f"  {len(headers):,} headers read", flush=True)
    if rpc.call("getblockhash", tip) != tip_hash:
        raise RuntimeError("Chain reorganized during collection; refresh the snapshot")
    serialized = json.dumps(headers, sort_keys=True, separators=(",", ":")).encode()
    data = {"schema": "dcbm-history-v1", "network": "xbt-main", "interval": INTERVAL,
            "target_spacing": SPACING, "fork_height": FORK_HEIGHT,
            "snapshot": {"height": tip, "hash": tip_hash, "node_version": version,
                         "collected_at": datetime.now(timezone.utc).isoformat(),
                         "headers_sha256": hashlib.sha256(serialized).hexdigest()},
            "headers": headers}
    return validate_dataset(data)


def report(data, destination, parameters=None):
    validate_dataset(data)
    payload = json.dumps({"dataset": data, "parameters": parameters}, separators=(",", ":")).replace("<", "\\u003c")
    text = (ASSETS / "report.html").read_text()
    for marker, content in [("/*__STYLE__*/", (ASSETS / "style.css").read_text()),
                            ("/*__ENGINE__*/", (ASSETS / "engine.js").read_text()),
                            ("/*__APP__*/", (ASSETS / "app.js").read_text()),
                            ("__PAYLOAD__", payload)]:
        if marker not in text:
            raise ValueError("Report template is missing an asset marker")
        text = text.replace(marker, content, 1)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".html.tmp")
    temporary.write_text(text)
    temporary.replace(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Read a fresh public-header snapshot from local Knots")
    parser.add_argument("--history-file", type=Path, help="Use an exported history or experiment JSON, entirely offline")
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[2] / "build/dcbm-simulator")
    parser.add_argument("--rpc-url", default="http://127.0.0.1:8332")
    parser.add_argument("--cookie-file", type=Path, default=Path.home() / ".bitcoin/.cookie")
    parser.add_argument("--collect-only", action="store_true")
    parser.add_argument("--open", action="store_true", help="Open the completed standalone report in a browser")
    args = parser.parse_args()
    if args.refresh and args.history_file:
        parser.error("Choose either --refresh or --history-file")
    cache = args.output_dir / "history.json"
    parameters = None
    try:
        if args.history_file:
            source = json.loads(args.history_file.read_text())
            data = source.get("dataset", source)
            parameters = source.get("parameters")
        elif args.refresh or not cache.exists():
            data = collect(LocalRPC(args.rpc_url, args.cookie_file))
            args.output_dir.mkdir(parents=True, exist_ok=True)
            temporary = cache.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(data, separators=(",", ":")))
            temporary.replace(cache)
        else:
            data = json.loads(cache.read_text())
        validate_dataset(data)
        print(f"Snapshot: height {data['snapshot']['height']:,}; {len(data['headers']):,} headers; XBT checkpoint verified")
        if not args.collect_only:
            destination = args.output_dir / "index.html"
            report(data, destination, parameters)
            print(f"Standalone simulator: {destination}")
            if args.open:
                webbrowser.open(destination.resolve().as_uri())
    except (OSError, ValueError, KeyError, RuntimeError) as error:
        print(f"Simulator: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
