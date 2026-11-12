(function () {
  'use strict';
  const E = DCBMSim, $ = id => document.getElementById(id);
  const payload = JSON.parse($('payload').textContent);
  let dataset = E.validateDataset(payload.dataset), result = null, pending = false;
  const colors = ['#b5efc5', '#f5b482', '#86c8fa', '#7e8995'];
  const visible = new Set(['custom', 'original', 'one-year', 'fixed']);
  const formIds = ['activation', 'initial', 'floor', 'cap', 'up', 'down', 'years', 'growth', 'period', 'start-minutes'];
  const format = value => BigInt(value).toLocaleString('en-US');
  const utc = seconds => new Date(seconds * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const shortDate = seconds => new Date(seconds * 1000).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', year: 'numeric' });
  function amount(value, divisor = 1, decimals = 1) {
    if (!value) return '0';
    const exponent = E.logBig(value) - Math.log10(divisor);
    if (exponent > 9) return (10 ** (exponent % 1)).toFixed(1) + 'e' + Math.floor(exponent);
    return (Number(value) / divisor).toLocaleString('en-US', { maximumFractionDigits: decimals });
  }
  function nominal(value) {
    if (value === 0n) return '0 blocks';
    if (value < 144n) return amount(value, 6, 1) + ' hours';
    if (value < 52560n) return amount(value, 144, 1) + ' days';
    return amount(value, 52560, 2) + ' years';
  }
  const compactBlocks = v => v.toString().length > 36 ? v.toString().slice(0, 12) + '… (' + v.toString().length + ' digits)' : format(v);
  function error(message) { $('error').hidden = !message; $('error').textContent = message || ''; }
  function defaults() {
    return { activation: E.FORK_HEIGHT, initial: '25920', floor: '100', cap: '105120', up: '1', down: '2',
      future: { enabled: true, years: 3, growth: 0, period: 1, unit: 'years', startMinutes: Number(E.estimatedMinutes(dataset.headers).toFixed(4)), shocks: [] } };
  }
  function addShock(shock = { year: 1, percent: 50 }) {
    if ($('shocks').children.length >= 12) return;
    const row = document.createElement('div'); row.className = 'shock-row';
    for (const [title, name, value] of [['At year', 'year', shock.year], ['Hash-rate change %', 'percent', shock.percent]]) {
      const label = document.createElement('label'); label.textContent = title;
      const input = document.createElement('input'); input.type = 'number'; input.step = 'any'; input.dataset.key = name; input.value = value;
      input.setAttribute('aria-label', title); label.append(input); row.append(label);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Remove hash-rate event');
    remove.addEventListener('click', () => { row.remove(); markDirty(); }); row.append(remove); $('shocks').append(row);
  }
  function applyParameters(input) {
    const base = defaults(), p = input || base, f = p.future || base.future;
    for (const id of ['activation', 'initial', 'up', 'down']) $(id).value = String(p[id] ?? base[id]);
    $('floor-enabled').checked = p.floor !== null; $('cap-enabled').checked = p.cap !== null;
    $('floor').value = String(p.floor ?? 100); $('cap').value = String(p.cap ?? 105120);
    $('future-enabled').checked = f.enabled !== false;
    for (const id of ['years', 'growth', 'period']) $(id).value = String(f[id] ?? base.future[id]);
    $('period-unit').value = f.unit === 'months' ? 'months' : 'years';
    $('start-minutes').value = String(f.startMinutes ?? base.future.startMinutes);
    $('activation').min = dataset.headers[0].height; $('activation').max = dataset.snapshot.height;
    $('shocks').replaceChildren(); for (const shock of (f.shocks || []).slice(0, 12)) addShock(shock);
    updateHints();
  }
  function parameters() {
    const p = { activation: Number($('activation').value), initial: $('initial').value,
      floor: $('floor-enabled').checked ? $('floor').value : null, cap: $('cap-enabled').checked ? $('cap').value : null,
      up: $('up').value, down: $('down').value,
      future: { enabled: $('future-enabled').checked, years: Number($('years').value), growth: Number($('growth').value),
        period: Number($('period').value), unit: $('period-unit').value, startMinutes: Number($('start-minutes').value),
        shocks: Array.from($('shocks').children).map(row => ({ year: Number(row.querySelector('[data-key=year]').value), percent: Number(row.querySelector('[data-key=percent]').value) })) } };
    E.normalizeRule(p);
    if (!Number.isSafeInteger(p.activation) || p.activation < E.FORK_HEIGHT || p.activation > dataset.snapshot.height) throw new Error('Choose an activation block inside the historical snapshot.');
    return p;
  }
  function updateHints() {
    $('floor').disabled = !$('floor-enabled').checked; $('cap').disabled = !$('cap-enabled').checked;
    $('future-fields').classList.toggle('future-muted', !$('future-enabled').checked);
    try { $('initial-hint').textContent = nominal(BigInt($('initial').value)) + ' at ten-minute blocks'; } catch {}
    try { $('cap-hint').textContent = $('cap-enabled').checked ? nominal(BigInt($('cap').value)) + ' at ten-minute blocks' : 'No upper bound; growth is mathematically unbounded.'; } catch {}
    $('response-hint').textContent = '+1% difficulty → +' + $('up').value + '% CBM. −1% difficulty → −' + $('down').value + '% CBM.';
    const h = dataset.headers[Number($('activation').value) - E.FORK_HEIGHT];
    $('activation-date').textContent = h ? utc(h.time) : 'Outside this snapshot';
    const growth = Number($('growth').value), period = Number($('period').value), unit = $('period-unit').value;
    if (growth > -100 && period > 0) {
      const annual = Math.expm1(Math.log1p(growth / 100) * (unit === 'months' ? 12 : 1) / period) * 100;
      $('growth-hint').textContent = (annual >= 0 ? '+' : '') + annual.toLocaleString('en-US', { maximumFractionDigits: 2 }) + '% annual compounded trend (' + growth + '% total over ' + period + ' ' + unit + '). Use a negative percentage for a decrease.';
    }
  }
  function markDirty() {
    updateHints(); pending = true; $('run-status').classList.add('dirty'); $('run-status').textContent = 'Parameters changed. Run to update the results.';
  }
  function provenance() {
    $('snapshot-height').textContent = '#' + dataset.snapshot.height.toLocaleString();
    $('snapshot-date').textContent = 'Collected ' + utc(Date.parse(dataset.snapshot.collected_at) / 1000);
    $('snapshot-range').textContent = dataset.headers.length.toLocaleString() + ' headers · since ' + shortDate(dataset.headers[0].time);
    const out = $('provenance'); out.replaceChildren();
    for (const text of ['Network: XBT mainnet. BLAKE2b checkpoint: ' + E.FORK_HASH,
      'Snapshot height: ' + dataset.snapshot.height + '. Tip hash: ' + dataset.snapshot.hash,
      'Normalized public-header SHA-256: ' + (dataset.snapshot.headers_sha256 || 'not provided'),
      'Collecting node version: ' + dataset.snapshot.node_version + '. Collected: ' + dataset.snapshot.collected_at]) {
      const line = document.createElement('div'); line.textContent = text; out.append(line);
    }
  }
  function models(p, headers) {
    return [
      { id: 'custom', label: 'Your rule', rule: p },
      { id: 'original', label: 'Original · 1× / 1×', rule: { ...p, floor: '100', cap: '2147483647', up: '1', down: '1' } },
      { id: 'one-year', label: '1-year cap · 1× / 1×', rule: { ...p, floor: '100', cap: '52560', up: '1', down: '1' } },
      { id: 'fixed', label: 'Fixed 180 days', rule: { initial: '25920', floor: '25920', cap: '25920', up: '0', down: '0' } }
    ].map((m, i) => ({ ...m, color: colors[i], points: E.replay(headers, p.activation, m.rule) }));
  }
  async function run() {
    updateHints();
    error(''); pending = true; const button = $('run'); button.disabled = true; button.textContent = 'Calculating…';
    $('run-status').textContent = 'Replaying history and modeling future retargets…';
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 10)));
    try {
      const p = parameters(), future = E.project(dataset.headers, p.future), hs = future.headers;
      result = { parameters: p, headers: hs, future, models: models(p, hs) };
      pending = false; $('run-status').classList.remove('dirty');
      $('run-status').textContent = 'Calculated locally. ' + future.count.toLocaleString() + ' modeled future blocks.';
      provenance(); renderSummary(); renderLegend(); renderInspector(); renderEpochs(); drawAll();
      $('preferences-text').value = E.preferenceText(p);
      $('copy-status').textContent = 'Ready to share. The rule ID groups matching rules regardless of test scenario.';
      if (!future.count && p.future.enabled) $('run-status').textContent += ' No future block falls within this horizon.';
    } catch (e) { error(e.message); $('run-status').textContent = 'Review the parameters above.'; }
    finally { button.disabled = false; button.innerHTML = 'Run simulation <span>↗</span>'; }
  }
  function renderSummary() {
    $('custom-future').textContent = result.future.count ? nominal(E.at(result.models[0].points, result.headers.at(-1).height)) : 'Not modeled';
    $('custom-future-blocks').textContent = result.future.count ? 'At modeled height ' + result.headers.at(-1).height.toLocaleString() : 'Enable future assumptions to explore';
    $('future-count').textContent = result.future.count.toLocaleString();
    $('future-summary').textContent = result.future.status;
    const f = result.future;
    $('projection-detail').textContent = f.count ? 'Deterministic expected block intervals. ' + (f.annualChange >= 0 ? '+' : '') + f.annualChange.toLocaleString('en-US', { maximumFractionDigits: 2 }) + '% annual hash-rate trend, with ' + f.events.length + ' step event(s). Difficulty retargets every 2,016 blocks; CBM does not affect the assumed hash power.' : 'Enable a modeled future to explore hash power and block times.';
  }
  function renderLegend() {
    const legend = $('legend'); legend.replaceChildren();
    for (const model of result.models) {
      const label = document.createElement('label'), input = document.createElement('input'), dot = document.createElement('i');
      input.type = 'checkbox'; input.checked = visible.has(model.id); dot.style.background = model.color;
      input.addEventListener('change', () => { input.checked ? visible.add(model.id) : visible.delete(model.id); drawMaturity(); });
      label.append(input, dot, document.createTextNode(model.label)); legend.append(label);
    }
  }
  function cell(row, text, small, color) {
    const td = document.createElement('td'); td.textContent = text;
    if (color) td.style.color = color;
    if (small) { const detail = document.createElement('small'); detail.textContent = small; td.append(detail); }
    row.append(td); return td;
  }
  function renderInspector() {
    if (!result) return;
    const input = $('reward-height'), minimum = result.parameters.activation, maximum = result.headers.at(-1).height;
    input.min = minimum; input.max = maximum;
    let origin = input.value === '' ? dataset.snapshot.height : Number(input.value);
    if (!Number.isSafeInteger(origin)) origin = dataset.snapshot.height;
    origin = Math.max(minimum, Math.min(maximum, origin)); input.value = origin;
    const h = result.headers[origin - E.FORK_HEIGHT];
    $('reward-date').textContent = (h.projected ? 'Modeled mining time: ' : 'Observed mining time: ') + utc(h.time) + '. Later retargets do not rewrite this reward’s assignment.';
    $('reward-table').replaceChildren();
    for (const model of result.models) {
      const r = E.reward(result.headers, model.points, origin, dataset.snapshot.height), row = document.createElement('tr');
      cell(row, model.label, null, model.color);
      cell(row, compactBlocks(r.maturity) + ' blocks', nominal(r.maturity) + ' at target spacing');
      cell(row, compactBlocks(r.unlockHeight));
      const date = cell(row, r.unlockTime === null ? 'Beyond replay' : utc(r.unlockTime));
      const badge = document.createElement('small'); badge.className = 'model-badge ' + (r.kind === 'observed' ? 'observed-badge' : '');
      badge.textContent = r.kind === 'observed' ? 'Observed block timestamp' : r.kind === 'modeled' ? 'Modeled · assumption-dependent' : 'No date inferred'; date.append(badge);
      cell(row, r.elapsed === null ? '—' : (r.elapsed / 86400).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' days', r.elapsed === null ? '' : r.kind === 'modeled' ? 'modeled elapsed time' : 'observed elapsed time');
      $('reward-table').append(row);
    }
  }
  function difficultyChange(point) {
    if (!point.oldBits) return 'Activation';
    const old = E.target(point.oldBits), next = E.target(point.bits);
    const change = Number((old - next) * 1000000n / next) / 10000;
    return (change >= 0 ? '+' : '') + change.toLocaleString('en-US', { maximumFractionDigits: 4 }) + '%';
  }
  function renderEpochs() {
    const points = result.models[0].points, shown = points.slice(-16); $('epoch-table').replaceChildren();
    for (const p of shown) {
      const row = document.createElement('tr');
      cell(row, p.height.toLocaleString()); cell(row, utc(p.time).slice(0, 16)); cell(row, difficultyChange(p));
      cell(row, compactBlocks(p.maturity), null, colors[0]); cell(row, compactBlocks(E.at(result.models[1].points, p.height)), null, colors[1]);
      cell(row, p.projected ? 'Modeled' : 'Observed headers'); $('epoch-table').append(row);
    }
    $('epoch-note').textContent = 'Showing the last ' + shown.length + ' of ' + points.length + ' activation / retarget rows. CSV export includes every row, all four rules, exact targets, and response parameters.';
  }
  function canvas(id) {
    const element = $(id), r = element.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    element.width = Math.round(r.width * dpr); element.height = Math.round(r.height * dpr);
    const ctx = element.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
    ctx.font = '10px ui-monospace, monospace'; ctx.lineWidth = 1;
    return { ctx, w: r.width, h: r.height, left: 62, right: 12, top: 20, bottom: 29 };
  }
  function axes(c, start, end, label, futureStart) {
    const { ctx, w, h, left, right, top, bottom } = c, width = w - left - right, height = h - top - bottom;
    const x = time => left + (time - start) / Math.max(1, end - start) * width;
    const y = fraction => top + (1 - fraction / 1.05) * height;
    if (futureStart !== undefined && end > futureStart) {
      ctx.fillStyle = '#f5b48209'; ctx.fillRect(x(futureStart), top, w - right - x(futureStart), height);
      ctx.setLineDash([3, 4]); ctx.strokeStyle = '#f5b48255'; ctx.beginPath(); ctx.moveTo(x(futureStart), top); ctx.lineTo(x(futureStart), h - bottom); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#a38b77'; ctx.textAlign = 'right'; ctx.fillText('MODELED FUTURE', w - right - 4, 10);
    }
    for (let i = 0; i <= 4; i++) {
      const f = i / 4; ctx.strokeStyle = '#ffffff0c'; ctx.beginPath(); ctx.moveTo(left, y(f)); ctx.lineTo(w - right, y(f)); ctx.stroke();
      ctx.fillStyle = '#83909b'; ctx.textAlign = 'right'; ctx.fillText(label(f), left - 9, y(f) + 3);
      const time = start + (end - start) * f; ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
      ctx.fillText(shortDate(time), x(time), h - 6);
    }
    return { x, y };
  }
  let maturityCoordinates = null;
  function drawMaturity() {
    if (!result) return;
    const c = canvas('maturity-chart'), { ctx } = c, selected = result.models.filter(m => visible.has(m.id));
    const all = selected.flatMap(m => m.points.map(p => p.maturity));
    const max = all.reduce((a, b) => b > a ? b : a, 1n), log = $('log-scale').checked, logMax = E.logBig(max + 1n);
    const normalize = v => log ? E.logBig(v + 1n) / Math.max(1e-9, logMax) : Number(v * 1000000000n / max) / 1e9;
    function label(f) {
      if (f === 0) return '0d';
      if (!log) return amount(max * BigInt(Math.round(f * 100)) / 100n, 144, 0) + 'd';
      const exponent = logMax * f - Math.log10(144);
      if (exponent < -1) return '<0.1d';
      return exponent > 6 ? (10 ** (exponent % 1)).toFixed(1) + 'e' + Math.floor(exponent) + 'd' : (10 ** exponent).toLocaleString('en-US', { maximumFractionDigits: exponent < 1 ? 1 : 0 }) + 'd';
    }
    const start = result.models[0].points[0].time, end = Math.max(start + 1, result.headers.at(-1).time);
    const { x, y } = axes(c, start, end, label, dataset.headers.at(-1).time);
    for (const m of selected.slice().reverse()) {
      ctx.strokeStyle = m.color; ctx.lineWidth = m.id === 'custom' ? 2.4 : 1.5; ctx.setLineDash(m.id === 'fixed' ? [4, 4] : []);
      ctx.beginPath(); let last = m.points[0]; ctx.moveTo(x(last.time), y(normalize(last.maturity)));
      for (const p of m.points.slice(1)) { ctx.lineTo(x(p.time), y(normalize(last.maturity))); ctx.lineTo(x(p.time), y(normalize(p.maturity))); last = p; }
      ctx.lineTo(x(end), y(normalize(last.maturity))); ctx.stroke();
    }
    ctx.setLineDash([]);
    maturityCoordinates = { ...c, start, end, x, y };
  }
  function drawHash() {
    if (!result) return;
    const c = canvas('hash-chart'), { ctx } = c, f = result.future;
    if (!f.count) { ctx.fillStyle = '#929ca7'; ctx.textAlign = 'center'; ctx.fillText('Enable a future scenario to see the mining model.', c.w / 2, c.h / 2); return; }
    const historyTip = dataset.headers.at(-1), start = historyTip.time, end = result.headers.at(-1).time;
    const times = Array.from({ length: 161 }, (_, i) => start + (end - start) * i / 160);
    for (const event of f.events) if (event.time <= end) times.push(Math.max(start, event.time - 1), event.time);
    for (const p of result.models[0].points) if (p.projected) times.push(Math.max(start, p.time - 1), p.time);
    times.sort((a, b) => a - b);
    const base = E.target(historyTip.bits), rows = [], hs = result.headers;
    for (const t of times) {
      let lo = dataset.headers.length - 1, hi = hs.length;
      while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (hs[mid].time <= t) lo = mid; else hi = mid; }
      const hash = Math.exp(f.options.rate * (t - start)) * f.events.filter(e => e.time <= t).reduce((a, e) => a * e.factor, 1);
      const relativeD = Number(base + 1n) / Number(E.target(hs[lo].bits) + 1n);
      rows.push({ time: t, hash, minutes: f.options.startMinutes / 10 * relativeD / hash });
    }
    const max = Math.max(1, ...rows.flatMap(r => [r.hash, r.minutes])), logMax = Math.log10(1 + max);
    const { x, y } = axes(c, start, end, f => (10 ** (logMax * f) - 1).toLocaleString('en-US', { maximumFractionDigits: 1 }) + '×');
    for (const [key, color] of [['hash', '#86c8fa'], ['minutes', '#c7a4fa']]) {
      ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.beginPath();
      rows.forEach((r, i) => { const px = x(r.time), py = y(Math.log10(1 + r[key]) / logMax); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.stroke();
    }
  }
  function drawAll() { drawMaturity(); drawHash(); }
  $('maturity-chart').addEventListener('pointermove', event => {
    if (!result || !maturityCoordinates) return;
    const c = maturityCoordinates, rect = $('maturity-chart').getBoundingClientRect(), pos = event.clientX - rect.left;
    const t = c.start + (pos - c.left) / (c.w - c.left - c.right) * (c.end - c.start);
    const p = result.models[0].points.reduce((a, b) => Math.abs(a.time - t) < Math.abs(b.time - t) ? a : b);
    const tip = $('chart-tooltip'); tip.replaceChildren();
    const heading = document.createElement('strong'); heading.textContent = 'Block ' + p.height.toLocaleString() + (p.projected ? ' · modeled' : ' · observed'); tip.append(heading);
    for (const m of result.models.filter(m => visible.has(m.id))) {
      const row = document.createElement('div'), name = document.createElement('span'), v = document.createElement('span'); name.textContent = m.label; name.style.color = m.color; v.textContent = nominal(E.at(m.points, p.height)); row.append(name, v); tip.append(row);
    }
    tip.hidden = false; tip.style.left = Math.max(0, Math.min(c.w - 260, pos + 12)) + 'px'; tip.style.top = '26px';
  });
  $('maturity-chart').addEventListener('pointerleave', () => $('chart-tooltip').hidden = true);
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a');
    link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  function readyExport() { if (!result) return false; if (pending) { error('Run the changed parameters before exporting.'); return false; } return true; }
  $('copy-preferences').addEventListener('click', async () => {
    if (!readyExport()) return;
    const text = $('preferences-text'); text.value = E.preferenceText(result.parameters);
    try {
      if (!navigator.clipboard || !window.isSecureContext) throw new Error('Use manual copy');
      await navigator.clipboard.writeText(text.value);
      $('copy-status').textContent = 'Copied! Paste your preference into Discord or GitHub.';
    } catch {
      text.focus(); text.select();
      let copied = false; try { copied = document.execCommand('copy'); } catch {}
      $('copy-status').textContent = copied ? 'Copied! Paste your preference into Discord or GitHub.' : 'Summary selected. Press Ctrl+C (or Command+C) to copy, then paste it into Discord or GitHub.';
    }
  });
  $('export-json').addEventListener('click', () => {
    if (!readyExport()) return;
    download('dcbm-experiment-' + dataset.snapshot.height + '.json', JSON.stringify({ engine_version: '1.0', dataset, parameters: result.parameters }, null, 2), 'application/json');
  });
  $('export-html').addEventListener('click', () => {
    if (!readyExport()) return;
    const copy = document.documentElement.cloneNode(true);
    copy.querySelector('#payload').textContent = JSON.stringify({ dataset, parameters: result.parameters }).replace(/</g, '\\u003c');
    download('dcbm-simulator-' + dataset.snapshot.height + '.html', '<!doctype html>\n' + copy.outerHTML, 'text/html');
  });
  $('export-csv').addEventListener('click', () => {
    if (!readyExport()) return;
    const rows = [['height', 'utc', 'source', 'old_target', 'new_target', 'model', 'maturity_blocks', 'up_response', 'down_response', 'floor_blocks', 'cap_blocks', 'activation_height']];
    for (const m of result.models) for (const p of m.points) rows.push([p.height, utc(p.time), p.projected ? 'modeled' : 'observed', p.oldBits ? E.target(p.oldBits).toString() : '', E.target(p.bits).toString(), m.id, p.maturity.toString(), m.rule.up, m.rule.down, m.rule.floor ?? 'none', m.rule.cap ?? 'none', result.parameters.activation]);
    download('dcbm-retargets-' + dataset.snapshot.height + '.csv', rows.map(row => row.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n'), 'text/csv');
  });
  $('import-button').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async event => {
    try {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 30000000) throw new Error('Import a JSON snapshot smaller than 30 MB.');
      const source = JSON.parse(await file.text()), next = E.validateDataset(source.dataset || source);
      dataset = next; applyParameters(source.parameters); $('reward-height').value = dataset.snapshot.height; await run();
    } catch (e) { error('Import failed: ' + e.message); }
    finally { event.target.value = ''; }
  });
  $('controls').addEventListener('submit', event => { event.preventDefault(); run(); });
  let refreshing = false;
  async function startAt(height) {
    $('activation').value = height; $('reward-height').value = height;
    updateHints(); await run();
  }
  $('start-current').addEventListener('click', async () => {
    if (refreshing) return;
    refreshing = true;
    for (const id of ['start-current', 'start-snapshot', 'start-launch', 'run', 'import-button']) $(id).disabled = true;
    $('live-status').textContent = 'Connecting to mempool.guide…';
    try {
      const next = await E.refreshDataset(dataset, globalThis.fetch.bind(globalThis), message => $('live-status').textContent = message);
      dataset = next;
      $('activation').max = dataset.snapshot.height;
      $('start-minutes').value = Number(E.estimatedMinutes(dataset.headers).toFixed(4));
      await startAt(dataset.snapshot.height);
      $('live-status').textContent = 'Fetched from mempool.guide at ' + utc(Date.parse(dataset.snapshot.collected_at) / 1000) + ' · Starting at #' + dataset.snapshot.height.toLocaleString() + '.';
    } catch (e) {
      $('live-status').textContent = 'Live refresh unavailable: ' + e.message + ' Your snapshot is unchanged. Use snapshot tip (#' + dataset.snapshot.height.toLocaleString() + ') to continue offline.';
    } finally {
      refreshing = false;
      for (const id of ['start-current', 'start-snapshot', 'start-launch', 'run', 'import-button']) $(id).disabled = false;
    }
  });
  $('start-snapshot').addEventListener('click', () => {
    $('live-status').textContent = 'Using loaded snapshot #' + dataset.snapshot.height.toLocaleString() + ' · collected ' + dataset.snapshot.collected_at + '. No live refresh requested.';
    startAt(dataset.snapshot.height);
  });
  $('start-launch').addEventListener('click', () => startAt(E.FORK_HEIGHT));
  $('controls').addEventListener('input', markDirty); $('controls').addEventListener('change', markDirty);
  $('add-shock').addEventListener('click', () => { addShock(); markDirty(); });
  $('reset').addEventListener('click', () => { $('preset').value = 'current'; applyParameters(); markDirty(); });
  $('preset').addEventListener('change', () => {
    const preset = $('preset').value;
    const rules = { current: ['100', '105120', '1', '2'], symmetric: ['100', '52560', '1', '1'], original: ['100', '2147483647', '1', '1'], unbounded: [null, null, '1', '1'], tenth: ['100', null, '0.1', '0.1'] };
    const [floor, cap, up, down] = rules[preset]; $('floor-enabled').checked = floor !== null; $('cap-enabled').checked = cap !== null;
    $('floor').value = floor ?? '100'; $('cap').value = cap ?? '105120'; $('up').value = up; $('down').value = down; markDirty();
  });
  $('reward-height').addEventListener('change', renderInspector);
  for (const [id, get] of [['reward-launch', () => result.parameters.activation], ['reward-tip', () => dataset.snapshot.height], ['reward-end', () => result.headers.at(-1).height]]) $(id).addEventListener('click', () => { if (result) { $('reward-height').value = get(); renderInspector(); } });
  $('log-scale').addEventListener('change', drawMaturity);
  for (const id of ['about-button', 'refresh-help']) $(id).addEventListener('click', () => $('about').showModal());
  $('close-about').addEventListener('click', () => $('about').close());
  let resizeTimer; new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawAll, 80); }).observe($('maturity-chart').parentElement);
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawAll, 80); });
  applyParameters(payload.parameters); $('reward-height').value = dataset.snapshot.height; provenance(); run();
  // Public, read-only inspection hook for reproducible browser verification.
  window.DCBMReport = { getResult: () => result, getDataset: () => dataset, run, parameters };
})();
