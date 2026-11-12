"""Behavior and cross-language checks. Run with python3 -m unittest discover here."""

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "simulator.py"
spec = importlib.util.spec_from_file_location("dcbm_simulator", SOURCE)
sim = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sim)
ENGINE = Path(__file__).with_name("engine.js")


class ArithmeticTests(unittest.TestCase):
    def test_current_cpp_boundary_vectors(self):
        # These exact examples are also exercised by coinbase_maturity_tests.cpp.
        vectors = [
            (10000, "01630000", "01640000", 9800),
            (10000, "01650000", "01640000", 10100),
            (10000, "01030000", "01040000", 5000),
            (301, "01030000", "01040000", 150),
            (10000, "01330000", "01640000", 200),
            (10000, "01010000", "01020000", 100),
            (10000, "01010000", "01040000", 100),
            (10000, "2100bfff", "2100ffff", 4999),
            (25920, "1d00ffff", "1c1fffe0", 105120),
            (105120, "01630000", "01640000", 103017),
        ]
        for previous, old, new, expected in vectors:
            with self.subTest(previous=previous, old=old, new=new):
                self.assertEqual(sim.adjust_maturity(previous, old, new), expected)

    def test_cap_discards_excess(self):
        value = sim.adjust_maturity(105120, "01010000", "01010000")
        for _ in range(5):
            value = sim.adjust_maturity(value, "01040000", "01010000")
        self.assertEqual(value, 105120)
        self.assertEqual(sim.adjust_maturity(value, "01030000", "01040000"), 52560)

    def test_no_cap_really_is_unbounded(self):
        value = sim.adjust_maturity(2147483647, "01040000", "01010000", cap=None)
        self.assertEqual(value, 8589934588)

    def test_no_floor_can_reach_zero_not_negative(self):
        self.assertEqual(sim.adjust_maturity(150, "01010000", "01040000", floor=None, cap=None), 0)
        self.assertEqual(sim.adjust_maturity(150, "01030000", "01040000", floor=None), 75)

    def test_fractional_response(self):
        self.assertEqual(sim.adjust_maturity(10000, "016e0000", "01640000", up="0.1"), 10100)
        self.assertEqual(sim.adjust_maturity(10000, "015a0000", "01640000", down="0.1"), 9900)

    def test_invalid_bounds_and_targets(self):
        for old, new in [("00000000", "1d00ffff"), ("1d80ffff", "1d00ffff"), ("23010000", "1d00ffff")]:
            with self.assertRaises(ValueError):
                sim.adjust_maturity(150, old, new)
        with self.assertRaises(ValueError):
            sim.bounds(150, 1000, 100)

    def test_compact_roundtrip(self):
        for bits in ["1d00ffff", "1900ad98", "2100ffff", "01010000", "1c3fffc0"]:
            self.assertEqual(sim.decode_compact(sim.encode_compact(sim.decode_compact(bits))), sim.decode_compact(bits))

    def test_seed_reward_is_not_repriced(self):
        activation = 2015
        hs = [{"height": i, "time": i * 600, "bits": "01040000" if i < 2016 else "01010000"}
              for i in range(2014, 2120)]
        epochs = sim.replay(hs, activation, initial=100)
        self.assertEqual(epochs[0]["maturity"], 100)
        self.assertEqual(epochs[1]["maturity"], 400)
        old = sim.reward_status(hs, epochs, 2015)
        self.assertEqual(old["unlock_height"], 2115)
        self.assertEqual(old["unlock_time"], 2115 * 600)
        new = sim.reward_status(hs, epochs, 2016)
        self.assertEqual(new["unlock_height"], 2416)
        self.assertIsNone(new["unlock_time"])

    def test_activation_on_boundary_does_not_apply_that_retarget(self):
        hs = [{"height": 2015, "time": 0, "bits": "01040000"},
              {"height": 2016, "time": 600, "bits": "01010000"}]
        self.assertEqual(sim.replay(hs, 2016, initial=150)[0]["maturity"], 150)


class CollectorTests(unittest.TestCase):
    def test_wallet_methods_cannot_be_called(self):
        rpc = object.__new__(sim.LocalRPC)
        with self.assertRaises(ValueError):
            rpc.batch([("sendtoaddress", ["not-an-address", 1])])

    def test_remote_or_credential_urls_rejected_before_cookie_access(self):
        for url in ["http://example.com:8332", "http://user:password@127.0.0.1:8332", "http://127.0.0.1:8332?token=x"]:
            with self.assertRaises(ValueError):
                sim.LocalRPC(url, "/nonexistent-cookie")

    def test_wrong_chain_checkpoint_rejected(self):
        with self.assertRaises(ValueError):
            sim.validate_dataset({"schema": "dcbm-history-v1", "network": "xbt-main", "headers": [{"height": sim.FORK_HEIGHT, "hash": "0" * 64}]})


@unittest.skipUnless(shutil.which("node"), "Node is needed for independent browser arithmetic checks")
class BrowserEngineTests(unittest.TestCase):
    def js(self, body, data=None):
        script = "const E=require(" + json.dumps(str(ENGINE)) + ");\n" + body
        run = subprocess.run(["node", "-e", script], input=json.dumps(data), capture_output=True, text=True, check=True)
        return json.loads(run.stdout)

    def test_python_browser_agree_for_many_target_ratios(self):
        cases = []
        for old in [1, 2, 3, 51, 99, 100, 101, 110, 127]:
            for new in [1, 2, 4, 50, 99, 100, 127]:
                for initial, floor, cap, up, down in [(301, 100, 105120, "1", "2"),
                    (10000, None, None, "0.1", "0.25"), (105120, 100, 105120, "1", "2")]:
                    old_bits, new_bits = sim.encode_compact(old), sim.encode_compact(new)
                    expected = sim.adjust_maturity(initial, old_bits, new_bits, floor=floor, cap=cap, up=up, down=down)
                    cases.append({"initial": str(initial), "old": old_bits, "new": new_bits,
                        "rule": {"floor": floor, "cap": cap, "up": up, "down": down}, "expected": str(expected)})
        actual = self.js("const fs=require('fs'), cases=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(cases.map(c=>E.adjust(BigInt(c.initial),c.old,c.new,c.rule).toString())));", cases)
        self.assertEqual(actual, [c["expected"] for c in cases])

    def test_growth_is_total_over_chosen_period(self):
        r = self.js("const p=E.projectionOptions({years:5,growth:50,period:5,unit:'years',startMinutes:10,shocks:[]},[]);console.log(JSON.stringify({growth:Math.exp(p.rate*5*E.YEAR)}));")
        self.assertAlmostEqual(r["growth"], 1.5)

    def test_projection_retargets_and_timestamps(self):
        r = self.js("""
const start=E.FORK_HEIGHT, count=3000, time=1700000000;
const hs=Array.from({length:count},(_,i)=>({height:start+i,time:time+i*600,bits:'1d00ffff'}));
const p=E.project(hs,{enabled:true,years:.1,growth:0,period:1,unit:'years',startMinutes:10,shocks:[{year:0,percent:100}]});
const points=E.replay(p.headers,hs.at(-1).height,{initial:'25920',floor:'100',cap:'105120',up:'1',down:'2'});
console.log(JSON.stringify({count:p.count,firstDelay:p.headers[count].time-hs.at(-1).time,
 retargets:points.length-1,harder:E.target(p.headers.at(-1).bits)<E.target(hs.at(-1).bits),
 monotonic:p.headers.slice(count).every((h,i)=>!i||h.time>=p.headers[count+i-1].time)}));
""")
        self.assertEqual(r["firstDelay"], 300)
        self.assertGreater(r["retargets"], 1)
        self.assertTrue(r["harder"])
        self.assertTrue(r["monotonic"])

    def test_negative_hash_rate_and_events(self):
        r = self.js("""
const hs=Array.from({length:3000},(_,i)=>({height:E.FORK_HEIGHT+i,time:1700000000+i*600,bits:'1d00ffff'}));
const p=E.project(hs,{enabled:true,years:.05,growth:0,period:1,unit:'years',startMinutes:10,shocks:[{year:0,percent:-50}]});
console.log(JSON.stringify({delay:p.headers[3000].time-hs.at(-1).time, count:p.count}));
""")
        self.assertEqual(r["delay"], 1200)
        self.assertGreater(r["count"], 0)

    def test_projection_is_independent_of_maturity_rule(self):
        r = self.js("""
const hs=Array.from({length:3000},(_,i)=>({height:E.FORK_HEIGHT+i,time:1700000000+i*600,bits:'1d00ffff'}));
const options={enabled:true,years:.05,growth:20,period:1,unit:'years',startMinutes:10,shocks:[]};
const p=E.project(hs,options), old=hs.length;
const a=E.replay(p.headers,hs.at(-1).height,{initial:'25920',floor:null,cap:null,up:'1',down:'1'});
const b=E.replay(p.headers,hs.at(-1).height,{initial:'25920',floor:'100',cap:'105120',up:'1',down:'2'});
console.log(JSON.stringify({unchanged:hs.length===old,both:a.at(-1).height===b.at(-1).height}));
""")
        self.assertTrue(r["unchanged"])
        self.assertTrue(r["both"])


class ExplorerTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node is required')
    def test_preference_groups_rules_and_separates_scenarios(self):
        script = r"""
const E=require(process.argv[1]), assert=require('node:assert/strict');
const a={activation:981595,initial:'25920',floor:null,cap:null,up:'1.00',down:'2.0',future:{enabled:false}};
const b={...a,activation:961640,up:'1',future:{enabled:true,years:3,growth:50,period:5,unit:'years',startMinutes:10,shocks:[{year:1,percent:-25}]}};
const x=E.preferenceText(a),y=E.preferenceText(b);
assert.equal(x.split('\n')[1],y.split('\n')[1]);
assert.match(x,/Floor: none \(zero allowed\)/);assert.match(x,/Cap: none/);
assert.match(y,/year 1: -25%/);assert.match(y,/Activation height: 961640/);
assert.notEqual(E.preferenceText({...a,down:'1'}).split('\n')[1],x.split('\n')[1]);
"""
        subprocess.run(['node', '-e', script, str(ENGINE)], check=True, capture_output=True, text=True)

    @unittest.skipUnless(shutil.which('node'), 'Node is required')
    def test_refresh_append_reorg_failure_and_checkpoint(self):
        script = r"""
const E=require(process.argv[1]), assert=require('node:assert/strict');
(async()=>{
const first={height:E.FORK_HEIGHT,hash:E.FORK_HASH,time:1700000000,bits:'1d00ffff'};
const old={height:first.height+1,hash:'1'.repeat(64),prev:first.hash,time:first.time+600,bits:first.bits};
const replacement={...old,hash:'2'.repeat(64)};
const tip={height:first.height+2,hash:'3'.repeat(64),prev:replacement.hash,time:first.time+1200,bits:first.bits};
const dataset={schema:'dcbm-history-v1',network:'xbt-main',headers:[first,old],snapshot:{height:old.height,hash:old.hash,headers_sha256:'old'}};
const convert=h=>({height:h.height,id:h.hash,previousblockhash:h.prev,timestamp:h.time,bits:parseInt(h.bits,16)});
const request=async url=>({ok:true,json:async()=>[tip,replacement,first].map(convert),text:async()=>url.includes('/blocks/tip/')?String(tip.height):tip.hash});
const refreshed=await E.refreshDataset(dataset,request);
assert.equal(refreshed.headers[1].hash,replacement.hash);
assert.equal(refreshed.snapshot.height,tip.height);
assert.equal(refreshed.snapshot.headers_sha256,undefined);
assert.equal(dataset.headers[1].hash,old.hash);
const unchanged=await E.refreshDataset(refreshed,request);
assert.equal(unchanged.headers.length,3);
await assert.rejects(E.refreshDataset(dataset,async()=>{throw Error('offline')}),/offline/);
await assert.rejects(E.refreshDataset(dataset,async url=>({...await request(url),json:async()=>[convert({...tip,prev:'4'.repeat(64)}),convert(replacement),convert(first)]})),/links/);
await assert.rejects(E.refreshDataset(dataset,async url=>({...await request(url),text:async()=>url.includes('/blocks/tip/')?String(tip.height):'5'.repeat(64)})),/chain changed/);
assert.equal(E.replay(refreshed.headers,tip.height,{})[0].maturity,25920n);
console.log('Explorer append/reorg, offline failure, links, tip stability, and activation: OK');
})().catch(e=>{console.error(e);process.exit(1)});
"""
        subprocess.run(['node', '-e', script, str(ENGINE)], check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
