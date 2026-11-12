/* Exact maturity arithmetic; deterministic, explicitly hypothetical future mining model. */
(function (root) {
  'use strict';
  const INTERVAL = 2016, SPACING = 600, YEAR = 365.25 * 86400;
  const FORK_HEIGHT = 961640;
  const FORK_HASH = '0000000000000050c1e5f69672f459293be14f46e5a494e7a8c8541396f18eeb';
  const POW_LIMIT = BigInt('0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  const targets = new Map();
  function integer(value, name = 'Value') {
    if (String(value).length > 1000 || !/^\d+$/.test(String(value))) throw new Error(name + ' must be a nonnegative whole number of at most 1,000 digits.');
    return BigInt(value);
  }
  function fraction(value) {
    const text = String(value);
    if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error('Response rates must be nonnegative decimals (up to six decimal places).');
    const parts = text.split('.'), decimals = parts[1] || '';
    const n = BigInt(parts[0] + decimals), d = 10n ** BigInt(decimals.length);
    if (n > 100n * d) throw new Error('Response rates must be at most 100×.');
    return { n, d };
  }
  function target(bits) {
    if (typeof bits !== 'string' || !/^[0-9a-fA-F]{8}$/.test(bits)) throw new Error('Invalid compact target.');
    if (targets.has(bits)) return targets.get(bits);
    const b = BigInt('0x' + bits), size = Number(b >> 24n), word = b & 0x7fffffn;
    const t = size <= 3 ? word >> BigInt(8 * (3 - size)) : word << BigInt(8 * (size - 3));
    if (t <= 0n || (b & 0x800000n) !== 0n || t >= (1n << 256n)) throw new Error('Compact target is negative, zero, or overflowing.');
    targets.set(bits, t); return t;
  }
  function compact(t) {
    if (t <= 0n || t >= (1n << 256n)) throw new Error('Invalid proof-of-work target.');
    let size = Math.ceil(t.toString(16).length / 2);
    let word = size <= 3 ? t << BigInt(8 * (3 - size)) : t >> BigInt(8 * (size - 3));
    if (word & 0x800000n) { word >>= 8n; size++; }
    return ((BigInt(size) << 24n) | word).toString(16).padStart(8, '0');
  }
  function normalizeRule(input) {
    const floor = input.floor === null ? 0n : integer(input.floor ?? 100, 'Floor');
    const cap = input.cap === null ? null : integer(input.cap ?? 105120, 'Cap');
    if (cap !== null && cap < floor) throw new Error('The cap must be at least the floor.');
    return { floor, cap, up: fraction(input.up ?? '1'), down: fraction(input.down ?? '2'),
      initial: integer(input.initial ?? 25920, 'Initial maturity') };
  }
  function clamp(v, rule) { return v < rule.floor ? rule.floor : rule.cap !== null && v > rule.cap ? rule.cap : v; }
  function adjust(previous, oldBits, newBits, input) {
    const rule = input.up && typeof input.up.n === 'bigint' ? input : normalizeRule(input);
    const old = target(oldBits), next = target(newBits), rate = old >= next ? rule.up : rule.down;
    const numerator = next * rate.d + rate.n * (old - next), denominator = next * rate.d;
    // Nonpositive factors reach zero (or a configured positive floor), never a negative lock.
    if (numerator <= 0n) return rule.floor;
    return clamp(clamp(BigInt(previous), rule) * numerator / denominator, rule);
  }
  function validateDataset(data) {
    if (!data || data.schema !== 'dcbm-history-v1' || data.network !== 'xbt-main') throw new Error('Import an XBT mainnet simulator snapshot or experiment JSON.');
    const hs = data.headers;
    if (!Array.isArray(hs) || !hs.length || hs.length > 500000) throw new Error('Invalid or oversized historical snapshot.');
    if (hs[0].height !== FORK_HEIGHT || hs[0].hash !== FORK_HASH) throw new Error('The snapshot does not match the XBT BLAKE2b checkpoint.');
    let previous = null;
    for (const h of hs) {
      if (!Number.isSafeInteger(h.height) || !Number.isInteger(h.time) || h.time < 0 || h.time > 0xffffffff || !/^[0-9a-f]{64}$/.test(h.hash)) throw new Error('Malformed historical header.');
      target(h.bits);
      if (previous && (h.height !== previous.height + 1 || h.prev !== previous.hash)) throw new Error('Historical headers have a gap or inconsistent hash links.');
      previous = h;
    }
    if (!data.snapshot || data.snapshot.height !== previous.height || data.snapshot.hash !== previous.hash) throw new Error('Snapshot tip metadata is inconsistent.');
    return data;
  }
  async function refreshDataset(data, request = globalThis.fetch, progress = () => {}) {
    validateDataset(data);
    const base = 'https://mempool.guide/api';
    async function get(path, json = true) {
      const response = await request(base + path, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Explorer returned HTTP ' + response.status);
      return json ? response.json() : response.text();
    }
    const tip = Number(await get('/blocks/tip/height', false));
    if (!Number.isSafeInteger(tip) || tip < data.snapshot.height) throw new Error('Explorer tip is invalid or behind this snapshot.');
    let height = tip, common = null;
    const added = [];
    for (let page = 0; page < 200 && common === null; page++) {
      progress('Fetching public blocks through #' + height.toLocaleString() + '…');
      const blocks = await get('/blocks/' + height);
      if (!Array.isArray(blocks) || !blocks.length || blocks.length > 100) throw new Error('Invalid explorer block response.');
      for (const b of blocks) {
        if (b.height !== height || !Number.isInteger(b.bits) || b.bits <= 0 || b.bits > 0xffffffff) throw new Error('Explorer returned unexpected block data.');
        const cached = data.headers[height - FORK_HEIGHT];
        if (cached && cached.hash === b.id) { common = height; break; }
        added.push({ height, hash: b.id, prev: b.previousblockhash, time: b.timestamp, bits: b.bits.toString(16).padStart(8, '0') });
        height--;
        if (height < FORK_HEIGHT) throw new Error('Explorer does not match the XBT checkpoint.');
      }
    }
    if (common === null) throw new Error('Snapshot is too far behind for a quick refresh. Import a newer snapshot.');
    const headers = data.headers.slice(0, common - FORK_HEIGHT + 1).concat(added.reverse());
    const last = headers.at(-1);
    const next = { ...data, headers, snapshot: { height: last.height, hash: last.hash,
      collected_at: new Date().toISOString(), node_version: 'mempool.guide public API', source: base } };
    validateDataset(next);
    if ((await get('/block-height/' + tip, false)).trim() !== last.hash) throw new Error('Explorer chain changed during refresh. Please retry.');
    return next;
  }
  function preferenceText(p) {
    const rule = normalizeRule(p);
    const rate = r => String(Number(r.n) / Number(r.d));
    const floor = p.floor === null ? 'none' : rule.floor.toString();
    const cap = rule.cap === null ? 'none' : rule.cap.toString();
    const key = ['DCBM-v1', 'initial=' + rule.initial, 'floor=' + floor, 'cap=' + cap, 'up=' + rate(rule.up), 'down=' + rate(rule.down)].join('|');
    const f = p.future || { enabled: false };
    const lines = ['My DCBM preference',
      'Rule ID: ' + key,
      'Initial maturity: ' + rule.initial + ' blocks',
      'Floor: ' + (floor === 'none' ? 'none (zero allowed)' : floor + ' blocks'),
      'Cap: ' + (cap === 'none' ? 'none' : cap + ' blocks (~' + (Number(rule.cap) / 52560).toLocaleString('en-US', { maximumFractionDigits: 4 }) + ' target years)'),
      'Difficulty increase response: ' + rate(rule.up) + 'x',
      'Difficulty decrease response: ' + rate(rule.down) + 'x',
      'Excess above cap discarded; rewards keep their mining-block maturity.',
      '', 'Test scenario (not part of Rule ID):', 'Activation height: ' + p.activation];
    if (f.enabled) {
      lines.push('Future: ' + f.years + ' years; hash-rate change ' + f.growth + '% over ' + f.period + ' ' + f.unit + '; starting block time ' + f.startMinutes + ' minutes');
      lines.push('Hash-rate events: ' + ((f.shocks || []).map(s => 'year ' + s.year + ': ' + s.percent + '%').join('; ') || 'none'));
    } else lines.push('Future: disabled');
    lines.push('Informal preference only; no on-chain vote or consensus activation.');
    return lines.join('\n');
  }
  function replay(headers, activation, input) {
    const first = headers[0].height, rule = normalizeRule(input);
    if (!Number.isSafeInteger(activation) || activation < first || activation > headers.at(-1).height) throw new Error('Activation must be inside the historical snapshot.');
    let maturity = clamp(rule.initial, rule);
    const points = [{ ...headers[activation - first], maturity, oldBits: null }];
    for (let i = activation - first + 1; i < headers.length; i++) {
      const h = headers[i];
      if (h.height % INTERVAL) continue;
      const oldBits = headers[i - 1].bits;
      maturity = adjust(maturity, oldBits, h.bits, rule);
      points.push({ ...h, maturity, oldBits });
    }
    return points;
  }
  function at(points, height) {
    let lo = 0, hi = points.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].height <= height) lo = mid + 1; else hi = mid; }
    if (!lo) throw new Error('Reward predates activation.');
    return points[lo - 1].maturity;
  }
  function reward(headers, points, origin, observedTip) {
    const first = headers[0].height, h = headers[origin - first];
    if (!h) throw new Error('Reward is outside the replay.');
    const maturity = at(points, origin), unlockHeight = BigInt(origin) + maturity;
    const block = unlockHeight <= BigInt(headers.at(-1).height) ? headers[Number(unlockHeight) - first] : null;
    return { maturity, unlockHeight, unlockTime: block ? block.time : null,
      elapsed: block ? block.time - h.time : null,
      kind: !block ? 'beyond' : block.height <= observedTip ? 'observed' : 'modeled' };
  }
  function work(t) { return (1n << 256n) / (t + 1n); }
  function estimatedMinutes(headers) {
    const recent = headers.slice(-121), seconds = recent.at(-1).time - recent[0].time;
    if (seconds <= 0 || recent.length < 2) return 10;
    const total = recent.slice(1).reduce((sum, h) => sum + Number(work(target(h.bits))), 0);
    return Number(work(target(recent.at(-1).bits))) * seconds / total / 60;
  }
  function projectionOptions(input, headers) {
    const years = Number(input.years ?? 3), percent = Number(input.growth ?? 0), period = Number(input.period ?? 1);
    const unit = input.unit ?? 'years', startMinutes = Number(input.startMinutes ?? estimatedMinutes(headers));
    if (!Number.isFinite(years) || years < 0.05 || years > 10) throw new Error('Project between 0.05 and 10 years.');
    if (!Number.isFinite(percent) || percent <= -100 || percent > 10000 || !Number.isFinite(period) || period < 0.25 || period > 100) throw new Error('Use a hash-rate change greater than −100%, at most +10,000%, over 0.25–100 periods.');
    if (!['years', 'months'].includes(unit)) throw new Error('Choose months or years.');
    if (!Number.isFinite(startMinutes) || startMinutes < 0.01 || startMinutes > 1440) throw new Error('Starting block time must be between 0.01 and 1,440 minutes.');
    const shocks = input.shocks ?? [];
    if (!Array.isArray(shocks) || shocks.length > 12) throw new Error('Use at most twelve hash-rate jumps or drops.');
    const events = shocks.map(s => {
      const year = Number(s.year), change = Number(s.percent);
      if (!Number.isFinite(year) || year < 0 || year > years || !Number.isFinite(change) || change <= -100 || change > 10000) throw new Error('Hash-rate events must be inside the horizon, with a change above −100% and at most +10,000%.');
      return { year, percent: change, factor: 1 + change / 100 };
    }).sort((a, b) => a.year - b.year);
    return { years, percent, period, unit, startMinutes, events,
      rate: Math.log1p(percent / 100) / (period * YEAR / (unit === 'months' ? 12 : 1)) };
  }
  function project(history, input) {
    if (!input.enabled) return { headers: history, count: 0, status: 'Historical replay only', events: [] };
    const options = projectionOptions(input, history), headers = history.slice(), first = history[0].height;
    const tip = history.at(-1), start = tip.time, end = start + options.years * YEAR;
    const events = options.events.map(e => ({ ...e, time: start + e.year * YEAR }));
    let eventIndex = 0, shockFactor = 1, timestamp = start, bits = tip.bits;
    let currentTarget = target(bits), baseTarget = currentTarget;
    let relativeDifficulty = 1, count = 0, reason = 'Projection horizon reached';
    const limit = 600000;
    function nextTime(t) {
      let remaining = 1, cursor = t;
      while (true) {
        while (eventIndex < events.length && events[eventIndex].time <= cursor) shockFactor *= events[eventIndex++].factor;
        const hash = Math.exp(options.rate * (cursor - start)) * shockFactor;
        const duration = options.startMinutes * 60 * relativeDifficulty;
        const nextEvent = eventIndex < events.length ? events[eventIndex].time : Infinity;
        const k = options.rate;
        const argument = remaining * duration * k / hash;
        const dt = Math.abs(k) < 1e-15 ? remaining * duration / hash : argument <= -1 ? Infinity : Math.log1p(argument) / k;
        if (cursor + dt <= nextEvent || nextEvent === Infinity) return cursor + dt;
        const span = nextEvent - cursor;
        const produced = hash / duration * (Math.abs(k) < 1e-15 ? span : Math.expm1(k * span) / k);
        remaining = Math.max(0, remaining - produced);
        cursor = nextEvent;
      }
    }
    while (count < limit) {
      const height = headers.at(-1).height + 1;
      if (height % INTERVAL === 0) {
        const anchor = headers[height - INTERVAL - first];
        if (!anchor) throw new Error('Projection needs the start of the current difficulty epoch in its snapshot.');
        const span = Math.max(302400, Math.min(4838400, headers.at(-1).time - anchor.time));
        let adjusted = currentTarget * BigInt(Math.floor(span)) / 1209600n;
        adjusted = adjusted > POW_LIMIT ? POW_LIMIT : adjusted < 1n ? 1n : adjusted;
        bits = compact(adjusted); currentTarget = target(bits);
        relativeDifficulty = Number(baseTarget + 1n) / Number(currentTarget + 1n);
      }
      let next = nextTime(timestamp);
      if (!Number.isFinite(next)) { reason = 'Hash-rate decline leaves insufficient modeled work for another block'; break; }
      const recent = headers.slice(-11).map(h => h.time).sort((a, b) => a - b);
      next = Math.max(Math.floor(next), recent[Math.floor(recent.length / 2)] + 1);
      if (next > end) break;
      headers.push({ height, time: next, bits, projected: true });
      timestamp = next; count++;
    }
    if (count === limit) reason = 'Stopped at the 600,000-block computation limit';
    return { headers, count, status: reason, events, options, end,
      annualChange: Math.expm1(options.rate * YEAR) * 100 };
  }
  function logBig(value) {
    if (value <= 0n) return 0;
    const s = value.toString(); return Math.log10(Number(s.slice(0, 15))) + Math.max(0, s.length - 15);
  }
  const api = { INTERVAL, SPACING, YEAR, FORK_HEIGHT, FORK_HASH, target, compact, normalizeRule,
    clamp, adjust, validateDataset, refreshDataset, preferenceText, replay, at, reward, estimatedMinutes, projectionOptions, project, logBig };
  root.DCBMSim = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
