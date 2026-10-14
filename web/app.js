'use strict';

/* ================================================================ helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
// Everything that comes from listing sites is untrusted: always escape it before putting it in HTML.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : null);
const inr = n => (n == null || isNaN(n) ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'));
const inrShort = n => {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e7) return '₹' + (n / 1e7).toFixed(n >= 1e8 ? 1 : 2).replace(/\.?0+$/, '') + ' Cr';
  if (n >= 1e5) return '₹' + (n / 1e5).toFixed(1).replace(/\.0$/, '') + ' L';
  return inr(n);
};
const pct = g => (g == null ? '—' : (g > 0 ? '+' : '') + g.toFixed(1) + '%');
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const fmtT = s => (s < 60 ? Math.round(s) + 's' : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch { /* not json */ }
    throw new Error(msg);
  }
  return r.json();
}
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 9000 : 5500);
}

const CAT = {
  metro: { label: 'Metro / rail', color: '#7c3aed' },
  school: { label: 'Schools', color: '#2563eb' },
  health: { label: 'Health', color: '#dc2626' },
  daily: { label: 'Markets & banks', color: '#d97706' },
  park: { label: 'Parks', color: '#16a34a' },
  bus: { label: 'Bus stops', color: '#64748b' },
};
const ROLE = { listings: 'Listings agent', circle: 'Circle-rate agent', rera: 'RERA agent', auction: 'Auction agent', custom: 'Custom agent' };
const VCLASS = v => (/Well above/.test(v) ? 'v-well-above' : /Above/.test(v) ? 'v-above' : /Close/.test(v) ? 'v-close' : /Below/.test(v) ? 'v-below' : 'v-none');

/* ================================================================ state */
const S = {
  config: null,
  locs: new Map(),        // locality id -> saved result
  current: null,          // locality id on screen
  live: null,             // partial data while a scan runs
  scanJob: null,
  jobs: new Map(),        // job id -> {kind, label, es, lastSeq, ended, cards: Map}
  circleFlow: {},         // locality id -> what the circle-rate pipeline did this session
  layersOn: new Set(JSON.parse(store.get('layers') || '["metro","school","health","daily","park"]')),
  ring: 1000,
  onlyMatch: false,
  sort: { key: 'ppsy', asc: true },
  markers: [],
};

/* ================================================================ theme + map */
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};
const savedTheme = store.get('theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

const map = L.map('map', { zoomControl: false }).setView([28.5, 77.3], 10);
L.control.zoom({ position: 'topright' }).addTo(map);
let tiles = null;
function setTiles() {
  if (tiles) map.removeLayer(tiles);
  // Public OSM tiles: fine for a demo (see the OSM tile usage policy); use a tile provider for real traffic.
  tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'osm-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
}
setTiles();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setTiles);
$('#themeBtn').onclick = () => {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('theme', next);
  setTiles();
};

const G = {
  others: L.layerGroup().addTo(map),
  center: L.layerGroup().addTo(map),
  pins: L.layerGroup().addTo(map),
  amen: Object.fromEntries(Object.keys(CAT).map(c => [c, L.layerGroup()])),
  heat: null,
};

function dockPx() { return $('#dock').getBoundingClientRect().height; }
function focusOn(lat, lon, radius = 1300) {
  const b = L.latLng(lat, lon).toBounds(radius * 2);
  const sumW = !$('#summary').hidden && innerWidth > 760 ? $('#summary').offsetWidth + 30 : 20;
  map.fitBounds(b, { paddingTopLeft: [sumW, 20], paddingBottomRight: [20, dockPx() + 20], maxZoom: 16, animate: true });
}

/* ================================================================ boot */
async function boot() {
  try {
    S.config = await api('/api/config');
  } catch (e) {
    toast('Server not reachable: ' + e.message, 'err');
    return;
  }
  const pill = $('#keyPill');
  pill.textContent = S.config.has_key ? 'TinyFish connected' : 'No TINYFISH_API_KEY';
  pill.className = 'pill ' + (S.config.has_key ? 'ok' : 'bad');

  const states = Object.keys(S.config.states);
  const stateOpts = states.map(s => `<option>${esc(s)}</option>`).join('') + '<option>Other</option>';
  $('#stateSel').innerHTML = stateOpts;
  $$('.stateList').forEach(s => (s.innerHTML = states.map(x => `<option>${esc(x)}</option>`).join('')));
  $('#auctionState').value = 'Delhi';
  fillAuthorities();

  $('#portalChecks').innerHTML = S.config.portals.map(p =>
    `<label class="check" title="${esc(p.note || '')}"><input type="checkbox" name="portal" value="${esc(p.key)}" ${p.default ? 'checked' : ''}><span>${esc(p.label)}${p.note ? ` <small class="muted">· ${esc(p.note)}</small>` : ''}</span></label>`).join('');

  const presetHtml = S.config.presets.map((p, i) => `<button type="button" class="preset" data-i="${i}">${esc(p.name)}, ${esc(p.city)}</button>`).join('');
  $('#presets').innerHTML = presetHtml;
  $('#welcomePresets').innerHTML = presetHtml;
  $$('.preset').forEach(b => (b.onclick = () => fillPreset(S.config.presets[b.dataset.i])));

  buildLayerChips();
  await loadLocalities();
  const last = store.get('current');
  if (last && S.locs.has(last)) select(last, false);
  else if (S.locs.size) select([...S.locs.keys()][0], false);

  // Re-attach to jobs that are still running on the server (e.g. after a page reload).
  try {
    const jobs = await api('/api/jobs');
    jobs.filter(j => !j.done).reverse().forEach(j => {
      if (j.kind === 'scan') scanStarted(j.id);
      attachJob(j.id, j.kind, j.label, j.started);
    });
  } catch { /* ignore */ }
  setInterval(tick, 1000);
}

function fillPreset(p) {
  const f = $('#scanForm');
  f.name.value = p.name; f.city.value = p.city; f.state.value = p.state;
  switchView('scan');
  f.name.focus();
}

async function loadLocalities() {
  const list = await api('/api/localities');
  S.locs = new Map(list.map(r => [r.id, r]));
  renderLocList();
  renderOthers();
  renderCompareOptions();
}

/* ================================================================ views */
function switchView(v) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => (s.hidden = s.id !== 'view-' + v));
  if (v === 'compare') renderCompare();
}
$$('.tab').forEach(t => (t.onclick = () => switchView(t.dataset.view)));

function switchPane(p) {
  $$('.dtab').forEach(t => t.classList.toggle('active', t.dataset.pane === p));
  $$('.pane').forEach(x => x.classList.toggle('active', x.id === 'pane-' + p));
  if ($('#dock').classList.contains('collapsed')) toggleDock(false);
}
$$('.dtab').forEach(t => (t.onclick = () => switchPane(t.dataset.pane)));
function toggleDock(force) {
  const d = $('#dock');
  const collapse = force === undefined ? !d.classList.contains('collapsed') : force;
  d.classList.toggle('collapsed', collapse);
  $('.stage').classList.toggle('dc', collapse);
}
$('#dockToggle').onclick = () => toggleDock();

/* ================================================================ locality list */
function watched(r) {
  return (S.config?.watchlist || []).some(w => w.name.toLowerCase() === r.name.toLowerCase() && w.city.toLowerCase() === r.city.toLowerCase());
}
function gapChip(g) {
  if (g == null) return '<span class="gap-chip v-none">no circle rate</span>';
  const cls = g > 25 ? 'v-well-above' : g > 10 ? 'v-above' : g >= -10 ? 'v-close' : 'v-below';
  return `<span class="gap-chip ${cls}">${pct(g)} vs circle</span>`;
}
function renderLocList() {
  const items = [...S.locs.values()].sort((a, b) => b.generated.localeCompare(a.generated));
  $('#locCount').textContent = items.length ? items.length + ' saved' : '';
  if (!items.length) return;
  $('#locList').innerHTML = items.map(r => `
    <div class="loc-item ${r.id === S.current ? 'active' : ''}" data-id="${esc(r.id)}" role="button" tabindex="0">
      <div><div class="loc-name">${esc(r.label)}</div>
        <div class="loc-meta">${esc(r.generated.slice(0, 10))} · ${r.n} listings · ${r.trend?.length || 1} run${(r.trend?.length || 1) > 1 ? 's' : ''}</div></div>
      <div class="loc-price">${inr(r.median_ppsy)}<div class="loc-meta">per sq yd</div>${gapChip(r.gap_pct)}</div>
      <button class="star ${watched(r) ? 'on' : ''}" data-star="${esc(r.id)}" title="Weekly watchlist">★</button>
    </div>`).join('');
  $$('.loc-item').forEach(el => {
    el.onclick = e => { if (!e.target.closest('.star')) select(el.dataset.id); };
    el.onkeydown = e => { if (e.key === 'Enter') select(el.dataset.id); };
  });
  $$('[data-star]').forEach(b => (b.onclick = async () => {
    const r = S.locs.get(b.dataset.star);
    const on = !b.classList.contains('on');
    S.config.watchlist = await api('/api/watch', { name: r.name, city: r.city, state: r.state, on });
    renderLocList();
    toast(on ? `${r.label} added to the weekly watchlist` : `${r.label} removed from the watchlist`);
  }));
}

function select(id, focus = true) {
  S.current = id;
  store.set('current', id);
  renderAll(focus);
}

/* ================================================================ rendering a locality */
function currentData() {
  if (S.live && S.current === S.live.id) return S.live;
  return S.locs.get(S.current) || null;
}

function renderAll(focus = true) {
  const d = currentData();
  $('#welcome').hidden = !!d;
  $('#summary').hidden = !d;
  $('#mapTools').hidden = !d;
  renderLocList();
  renderSummary(d);
  renderMapData(d, focus);
  renderListings(d);
  renderCircle(d);
  renderDigest(d);
  renderOthers();
}

function gaugeSvg(score) {
  const r = 28, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, score / 10));
  const col = score >= 7 ? 'var(--good)' : score >= 4 ? 'var(--warn)' : 'var(--bad)';
  return `<svg viewBox="0 0 66 66" width="66" height="66"><circle cx="33" cy="33" r="${r}" fill="none" stroke="var(--line)" stroke-width="6"/>
    <circle cx="33" cy="33" r="${r}" fill="none" stroke="${col}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c * f} ${c}" transform="rotate(-90 33 33)"/></svg>`;
}

function sparkSvg(trend) {
  if (!trend || trend.length < 2) return '<p class="foot-note">The trend line appears after two runs on different days. Star the locality to include it in the weekly run.</p>';
  const W = 320, H = 56, P = 6, v = trend.map(p => p.median), lo = Math.min(...v), hi = Math.max(...v);
  const x = i => P + i * (W - 2 * P) / (v.length - 1), y = val => H - 14 - (hi === lo ? 0.5 : (val - lo) / (hi - lo)) * (H - 24);
  const pts = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
  const dots = v.map((val, i) => `<circle cx="${x(i)}" cy="${y(val)}" r="2.6" fill="var(--accent)"><title>${esc(trend[i].date)}: ${inr(val)} per sq yd</title></circle>`).join('');
  const ch = (v.at(-1) / v[0] - 1) * 100;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <polyline fill="none" stroke="var(--accent)" stroke-width="2" points="${pts}" vector-effect="non-scaling-stroke"/>${dots}
      <text x="${P}" y="${H - 2}" font-size="9" fill="var(--muted)">${esc(trend[0].date)}</text>
      <text x="${W - P}" y="${H - 2}" font-size="9" fill="var(--muted)" text-anchor="end">${esc(trend.at(-1).date)}</text></svg>
    <div class="foot-note">${trend.length} runs · ${pct(ch)} since first run · latest ${inr(v.at(-1))}/sq yd</div>`;
}

function renderSummary(d) {
  const el = $('#summary');
  if (!d) return;
  const liveRun = d === S.live;
  const vals = (d.listings || []).map(x => x.ppsy);
  const med = liveRun ? median(vals) : d.median_ppsy;
  const circle = liveRun ? d.circle : d.circle;
  const circlePpsy = circle?.ppsy ?? d.circle_ppsy ?? null;
  const gap = liveRun ? (med && circlePpsy ? (med / circlePpsy - 1) * 100 : null) : d.gap_pct;
  const verdict = liveRun ? (vals.length ? 'Collecting listings…' : 'Agents at work…') : d.verdict;
  const amen = d.amenity || d.score;
  const portals = liveRun ? null : d.portals;
  const parts = amen ? Object.entries({ metro: 3, school: 2, health: 2, daily: 1.5, park: 1, bus: 0.5 }).map(([k, max]) => `
      <div class="part"><span>${esc(CAT[k].label.split(' ')[0])}</span><div class="bar"><i style="width:${(amen.parts[k] / max) * 100}%;background:${CAT[k].color}"></i></div>
      <span class="n">${k === 'metro' ? (amen.nearest_metro_m != null ? (amen.nearest_metro_m / 1000).toFixed(1) + 'k' : '—') : amen.counts_1km[k]}</span></div>`).join('') : '';

  el.innerHTML = `
    <div class="sum-top">
      <div class="sum-title">
        <div><h2>${esc(d.name)}</h2><div class="sum-sub">${esc(d.city)}${d.state ? ', ' + esc(d.state) : ''} · ${liveRun ? 'live scan' : 'run ' + esc(d.generated.replace('T', ' ').slice(0, 16))}</div>
          ${d.geo_how ? `<div class="sum-sub" title="${esc(d.geo_how)}" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px">📍 ${/^city centre/.test(d.geo_how) ? '<b style="color:var(--warn)">' + esc(d.geo_how) + '</b>' : 'Located via ' + esc(d.geo_how)}</div>` : ''}</div>
        ${liveRun ? '' : `<button class="star ${watched(d) ? 'on' : ''}" id="sumStar" title="Weekly watchlist">★</button>`}
      </div>
      <div class="verdict ${liveRun ? 'v-none' : VCLASS(verdict)}">
        <div>${esc(verdict)}${!liveRun && d.verdict_line ? `<small>${esc(d.verdict_line)}</small>` : ''}</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">Median ask</div><div class="v">${inr(med)}</div><div class="s">per sq yd · ${vals.length} plots</div></div>
      <div class="stat"><div class="k">Circle rate</div><div class="v">${inr(circlePpsy)}</div><div class="s">${circle ? esc(circle.origin || 'on file') : 'not on file'}</div></div>
      <div class="stat"><div class="k">Gap</div><div class="v">${pct(gap)}</div><div class="s">indicator only</div></div>
    </div>
    <div class="sum-sec">
      <div class="sec-k">Amenity score <span class="muted small" style="text-transform:none;letter-spacing:0">OpenStreetMap, 1 km</span></div>
      ${amen ? `<div class="score-wrap"><div class="gauge">${gaugeSvg(amen.score)}<b>${amen.score}</b></div><div class="parts">${parts}</div></div>
        <div class="foot-note">Heuristic out of 10. Metro distance has the largest weight, which is the part backed by the transit studies. OSM coverage can be thin in newer sectors.</div>`
        : '<p class="foot-note">Fetching amenities from Overpass…</p>'}
    </div>
    ${liveRun ? '' : `<div class="sum-sec"><div class="sec-k">Weekly median trend</div>${sparkSvg(d.trend)}</div>`}
    ${portals ? `<div class="sum-sec"><div class="sec-k">Collected by TinyFish agents</div><div class="agents-row">${Object.values(portals).map(p =>
      `<span class="agent-chip ${p.ok && !p.blocked ? '' : 'bad'}">${esc(p.label)} <b>${p.ok ? p.count : 'failed'}</b>${p.blocked ? ' · blocked' : ''}</span>`).join('')}</div>
      ${d.dropped?.length ? `<div class="foot-note">${d.dropped.length} listing${d.dropped.length > 1 ? 's' : ''} set aside (unsupported units such as bigha/marla, or price outliers). See Listings.</div>` : ''}
      <div class="foot-note">Asking prices, not sale prices. Pin positions are approximate.</div></div>` : ''}`;
  const star = $('#sumStar');
  if (star) star.onclick = async () => {
    const on = !star.classList.contains('on');
    S.config.watchlist = await api('/api/watch', { name: d.name, city: d.city, state: d.state, on });
    star.classList.toggle('on', on);
    renderLocList();
    toast(on ? `${d.label} added to the weekly watchlist` : `${d.label} removed from the watchlist`);
  };
}

/* ---------------------------------------------------------------- map */
function priceColor(v, lo, hi) {
  const t = hi === lo ? 0.5 : Math.min(Math.max((v - lo) / (hi - lo), 0), 1);
  return `hsl(${130 - 130 * t}, 72%, ${isDark() ? 52 : 42}%)`;
}
function pctile(sorted, p) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0; }

function popupHtml(x, d) {
  const link = safeUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Open listing ↗</a>` : '<span class="approx">no listing link returned</span>';
  const rera = x.project ? `<button class="link-btn" data-rera="${esc(x.project)}">Check RERA</button>` : '';
  return `<div class="pop-title">${esc(x.title || 'Plot')}</div>
    <div class="pop-price">${inrShort(x.total_price_inr)}</div>
    <div class="pop-grid">
      <span>Per sq yd</span><b>${inr(x.ppsy)}</b>
      <span>Area</span><span style="color:var(--ink)">${x.area_sqyd} sq yd <small class="muted">(${esc(x.area)} ${esc(x.area_unit)})</small></span>
      ${x.gap_pct != null ? `<span>vs circle</span><b>${pct(x.gap_pct)}</b>` : ''}
      <span>Portal</span><span style="color:var(--ink)">${esc(x.portal)}${x.also_on ? ' + ' + esc(x.also_on.join(', ')) : ''}</span>
      ${x.project ? `<span>Project</span><span style="color:var(--ink)">${esc(x.project)}</span>` : ''}
      ${x.posted_by ? `<span>Posted by</span><span style="color:var(--ink)">${esc(x.posted_by)}</span>` : ''}
      ${x.listed_on ? `<span>Listed</span><span style="color:var(--ink)">${esc(x.listed_on)}</span>` : ''}
    </div>
    <div class="approx">Approximate location (${esc(x.pin || 'search area')})</div>
    <div class="pop-actions">${link}${rera}</div>`;
}

function renderMapData(d, focus) {
  G.center.clearLayers();
  G.pins.clearLayers();
  Object.values(G.amen).forEach(g => { g.clearLayers(); map.removeLayer(g); });
  S.markers = [];
  if (!d || d.lat == null) return;

  const scanning = d === S.live;
  L.marker([d.lat, d.lon], { icon: L.divIcon({ className: '', html: `<div class="center-pin ${scanning ? 'scanning' : ''}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 })
    .bindTooltip(esc(d.label), { permanent: true, direction: 'top', offset: [0, -12], className: 'loc-label' }).addTo(G.center);
  L.circle([d.lat, d.lon], { radius: S.ring, color: isDark() ? '#e5e7eb' : '#111', weight: 1.2, dashArray: '5 6', fillOpacity: 0.035, interactive: false }).addTo(G.center);

  const rows = (d.listings || []);
  const sorted = rows.map(x => x.ppsy).sort((a, b) => a - b);
  const lo = pctile(sorted, 0.1), hi = pctile(sorted, 0.9);
  rows.forEach((x, i) => {
    if (x.lat == null || (S.onlyMatch && x.match === false)) return;
    const m = L.circleMarker([x.lat, x.lon], { radius: 8, color: isDark() ? '#0d0f12' : '#fff', weight: 1.5, fillColor: priceColor(x.ppsy, lo, hi), fillOpacity: 0.95 })
      .bindPopup(popupHtml(x, d), { maxWidth: 320 });
    m.addTo(G.pins);
    S.markers[i] = m;
  });
  $('#legend')?.remove();
  if (rows.length) {
    $('#mapTools').insertAdjacentHTML('beforeend', `<div id="legend" style="margin-top:9px">
      <div style="height:7px;border-radius:99px;background:linear-gradient(90deg,${priceColor(0, 0, 1)},${priceColor(.5, 0, 1)},${priceColor(1, 0, 1)})"></div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-top:3px;font-family:var(--mono)"><span>${inr(lo)}</span><span>price per sq yd</span><span>${inr(hi)}</span></div></div>`);
  }

  const items = d.amenities || [];
  items.forEach(a => {
    L.circleMarker([a.lat, a.lon], { radius: a.cat === 'metro' ? 6 : 4.5, color: CAT[a.cat].color, weight: 1, fillColor: CAT[a.cat].color, fillOpacity: 0.75 })
      .bindTooltip(`${esc(a.name)} · ${a.dist_m < 1000 ? a.dist_m + ' m' : (a.dist_m / 1000).toFixed(1) + ' km'}`)
      .addTo(G.amen[a.cat]);
  });
  Object.entries(G.amen).forEach(([c, g]) => { if (S.layersOn.has(c)) g.addTo(map); });
  updateChipCounts(items);
  renderHeat();
  if (focus) focusOn(d.lat, d.lon);
}

function buildLayerChips() {
  $('#layerChips').innerHTML = Object.entries(CAT).map(([k, c]) =>
    `<button class="chip ${S.layersOn.has(k) ? 'on' : ''}" data-cat="${k}"><i style="background:${c.color}"></i>${c.label} <b data-n="${k}">0</b></button>`).join('');
  $$('.chip').forEach(b => (b.onclick = () => {
    const k = b.dataset.cat;
    if (S.layersOn.has(k)) { S.layersOn.delete(k); map.removeLayer(G.amen[k]); } else { S.layersOn.add(k); G.amen[k].addTo(map); }
    b.classList.toggle('on');
    store.set('layers', JSON.stringify([...S.layersOn]));
  }));
  $$('#ringSeg button').forEach(b => (b.onclick = () => {
    S.ring = +b.dataset.r;
    $$('#ringSeg button').forEach(x => x.classList.toggle('on', x === b));
    renderMapData(currentData(), false);
  }));
  $('#heatToggle').onchange = renderHeat;
  $('#matchToggle').onchange = e => { S.onlyMatch = e.target.checked; renderMapData(currentData(), false); renderListings(currentData()); };
}
function updateChipCounts(items) {
  Object.keys(CAT).forEach(k => {
    const n = items.filter(a => a.cat === k && a.dist_m <= S.ring).length;
    const el = $(`[data-n="${k}"]`);
    if (el) el.textContent = n;
  });
}

function renderHeat() {
  if (G.heat) { map.removeLayer(G.heat); G.heat = null; }
  if (!$('#heatToggle').checked || !L.heatLayer) return;
  const all = [...S.locs.values()].flatMap(r => r.listings || []).filter(x => x.lat != null);
  if (S.live) all.push(...S.live.listings);
  if (!all.length) return;
  const sorted = all.map(x => x.ppsy).sort((a, b) => a - b), top = pctile(sorted, 0.95) || 1;
  G.heat = L.heatLayer(all.map(x => [x.lat, x.lon, Math.min(1, x.ppsy / top)]), { radius: 28, blur: 22, maxZoom: 15 }).addTo(map);
}

function renderOthers() {
  G.others.clearLayers();
  S.locs.forEach(r => {
    if (r.id === S.current || r.lat == null) return;
    L.circleMarker([r.lat, r.lon], { radius: 7, color: '#ff6b35', weight: 2.5, fillColor: isDark() ? '#15181c' : '#fff', fillOpacity: 1 })
      .bindTooltip(`${esc(r.label)} · ${inr(r.median_ppsy)}/sq yd`, { direction: 'top' })
      .on('click', () => select(r.id)).addTo(G.others);
  });
}

map.on('popupopen', e => {
  const b = e.popup.getElement().querySelector('[data-rera]');
  if (b) b.onclick = () => {
    const d = currentData();
    const f = $('#reraForm');
    f.project.value = b.dataset.rera;
    f.locality.value = d?.label || '';
    if (d?.state && S.config.states[d.state]) f.state.value = d.state;
    switchView('tools');
    f.requestSubmit();
  };
});

/* ---------------------------------------------------------------- listings pane */
const COLS = [
  { key: 'portal', label: 'Portal' },
  { key: 'title', label: 'Plot' },
  { key: 'area_sqyd', label: 'Area sq yd', num: true },
  { key: 'total_price_inr', label: 'Price', num: true },
  { key: 'ppsy', label: '₹ / sq yd', num: true },
  { key: 'gap_pct', label: 'vs circle', num: true },
  { key: 'listed_on', label: 'Listed' },
];
function renderListings(d) {
  const el = $('#pane-listings');
  const rows = (d?.listings || []).map((x, i) => ({ ...x, _i: i }));
  $('#listCount').textContent = rows.length;
  if (!d) { el.innerHTML = '<div class="empty-pane">Pick or scan a locality to see its listings.</div>'; return; }
  if (!rows.length) { el.innerHTML = `<div class="empty-pane">${d === S.live ? 'Listings appear here as each agent finishes.' : 'No usable listings in this run.'}</div>`; return; }
  const { key, asc } = S.sort;
  rows.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x == null) return 1; if (y == null) return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * (asc ? 1 : -1);
  });
  const sorted = rows.map(x => x.ppsy).sort((a, b) => a - b), lo = pctile(sorted, .1), hi = pctile(sorted, .9);
  const f = d.filters || {};
  const hasF = f.min_area || f.max_area || f.budget;
  el.innerHTML = `
    <div class="tbl-bar"><h3>${rows.length} plots · ${esc(d.label)}</h3>
      ${hasF ? `<span class="muted small">Your filters: ${f.min_area || 0}–${f.max_area || '∞'} sq yd${f.budget ? ', up to ' + inrShort(f.budget) : ''} · ${rows.filter(r => r.match).length} match</span>` : ''}
      <span class="muted small" style="margin-left:auto">De-duplicated across portals · click a row to find it on the map</span></div>
    <table class="tbl"><thead><tr>${COLS.map(c => `<th data-k="${c.key}" class="${c.num ? 'num' : ''} ${key === c.key ? 'sorted' + (asc ? ' asc' : '') : ''}">${c.label}</th>`).join('')}<th></th></tr></thead>
    <tbody>${rows.filter(x => !(S.onlyMatch && x.match === false)).map(x => `
      <tr data-i="${x._i}" class="${hasF && x.match === false ? 'dim' : ''}">
        <td><span class="portal-tag">${esc(x.portal)}</span>${x.also_on ? `<div class="muted small">+ ${esc(x.also_on.join(', '))}</div>` : ''}</td>
        <td class="ttl"><div title="${esc(x.title)}">${esc(x.title || 'Plot')}</div><small>${esc([x.project, x.posted_by, x.locality].filter(Boolean).join(' · '))}</small></td>
        <td class="num">${x.area_sqyd}</td>
        <td class="num">${inrShort(x.total_price_inr)}</td>
        <td class="num"><span class="swatch" style="background:${priceColor(x.ppsy, lo, hi)}"></span>${inr(x.ppsy)}</td>
        <td class="num">${pct(x.gap_pct)}</td>
        <td>${esc(x.listed_on || '')}</td>
        <td>${safeUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : ''}</td>
      </tr>`).join('')}</tbody></table>
    ${d.dropped?.length ? `<details style="margin-top:14px"><summary class="muted small" style="cursor:pointer">${d.dropped.length} listings set aside and why</summary>
      <table class="tbl" style="margin-top:6px"><tbody>${d.dropped.map(x => `<tr><td><span class="portal-tag">${esc(x.portal)}</span></td><td>${esc(x.title || '')}</td>
      <td>${esc(x.area)} ${esc(x.area_unit)}</td><td class="num">${inrShort(x.total_price_inr)}</td><td class="muted">${esc(x.drop_reason)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
  $$('th[data-k]', el).forEach(th => (th.onclick = () => {
    S.sort = { key: th.dataset.k, asc: S.sort.key === th.dataset.k ? !S.sort.asc : true };
    renderListings(d);
  }));
  $$('tr[data-i]', el).forEach(tr => (tr.onclick = e => {
    if (e.target.closest('a')) return;
    const m = S.markers[+tr.dataset.i];
    if (m) { map.panTo(m.getLatLng()); m.openPopup(); }
  }));
}

/* ---------------------------------------------------------------- circle-rate pane */
function renderCircle(d) {
  const el = $('#pane-circle');
  if (!d) { el.innerHTML = '<div class="empty-pane">Pick or scan a locality.</div>'; return; }
  const flow = S.circleFlow[d.id];
  const c = d.circle;
  const step = (n, title, body, state) => `<div class="flow-step ${state}"><div class="dot">${state === 'ok' ? '✓' : n}</div><div><b>${title}</b>${body || ''}</div></div>`;
  let flowHtml;
  if (!flow) {
    flowHtml = `<p class="muted small">${c ? 'This run used the rate on file, so no lookup was needed.' : 'No lookup ran for this locality in this session. Start a scan with “Find the circle rate” switched on, or enter the official rate on the right.'}</p>`;
  } else {
    const res = flow.results || [];
    const fetched = flow.fetched || [];
    flowHtml = `<div class="flow">
      ${step(1, 'TinyFish Search API', `<div class="muted small">“${esc(flow.query || '')}”</div>
        ${res.length ? `<div class="results">${res.slice(0, 5).map(r => `<div class="res"><a href="${esc(safeUrl(r.url) || '#')}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>${r.gov ? '<span class="badge gov">govt</span>' : ''}<div class="site">${esc(r.site)}</div></div>`).join('')}</div>` : ''}`,
        res.length ? 'ok' : flow.phase === 'search' ? 'on' : '')}
      ${step(2, 'TinyFish Fetch API', fetched.length ? `<div class="results">${fetched.map(r => `<div class="res"><a href="${esc(safeUrl(r.url) || '#')}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a>
          ${r.fetch === 'ok' ? '' : '<span class="badge warn">fetch failed</span>'}${r.evidence_snippet ? `<blockquote>${esc(r.evidence_snippet)}</blockquote>` : ''}</div>`).join('')}</div>` : '<div class="muted small">Reads the top pages and looks for the locality.</div>',
        fetched.length ? 'ok' : flow.phase === 'results' ? 'on' : '')}
      ${step(3, 'TinyFish Agent', flow.agentUrl ? `<div class="muted small">Attempt ${flow.attempt}: reading ${esc(flow.agentUrl)} · watch it in Live agents</div>` : '<div class="muted small">Opens the best page and extracts the rate with its unit and date.</div>',
        flow.phase === 'found' ? 'ok' : flow.phase === 'agent' ? 'on' : '')}
      ${step(4, 'Result', flow.phase === 'found' ? `<div class="muted small">Rate found. Shown on the right as “agent (verify)”.</div>` : flow.phase === 'not_found' ? '<div class="muted small">Not found on the candidate pages. Enter it from the official notification.</div>' : flow.phase === 'error' ? `<div class="muted small">${esc(flow.message)}</div>` : '', flow.phase === 'found' ? 'ok' : '')}
    </div>`;
  }
  const found = flow?.rate;
  el.innerHTML = `<div class="two-col">
    <div class="box"><h4>How the circle rate was looked up</h4>${flowHtml}</div>
    <div class="box">
      <h4>Circle rate for ${esc(d.label)}</h4>
      ${c ? `<div class="rate-big">${inr(c.rate_inr)} <span class="muted" style="font-size:14px;font-family:Inter">${esc((c.unit || '').replace('per_', 'per '))}</span></div>
        <div class="muted small">= ${inr(c.ppsy)} per sq yd</div>
        <dl class="kv"><dt>Origin</dt><dd>${esc(c.origin || 'official')}${/agent/.test(c.origin || '') ? ' <span class="badge warn">verify</span>' : ''}</dd>
          ${c.category ? `<dt>Category</dt><dd>${esc(c.category)}</dd>` : ''}
          <dt>As of</dt><dd>${esc(c.as_of || '—')}</dd>
          <dt>Source</dt><dd>${safeUrl(c.source_url) ? `<a href="${esc(c.source_url)}" target="_blank" rel="noopener noreferrer">${esc(c.source_url)}</a>` : esc(c.source_url || '—')}</dd>
          ${c.evidence ? `<dt>Evidence</dt><dd><blockquote style="margin:0;padding:4px 8px;border-left:3px solid var(--accent);background:var(--accent-soft)">${esc(c.evidence)}</blockquote></dd>` : ''}</dl>`
        : `<p class="muted small">No circle rate on file, so no gap is shown. A rate of 0 means unknown.</p>`}
      <details ${c ? '' : 'open'} style="margin-top:12px"><summary class="small" style="cursor:pointer;font-weight:600">${c ? 'Correct or confirm this rate' : 'Enter the official rate'}</summary>
        <form id="circleForm" class="form" style="margin-top:10px">
          <div class="row2"><label>Rate ₹<input name="rate_inr" type="number" min="1" step="any" required value="${c?.rate_inr || found?.rate_inr || ''}"></label>
            <label>Unit<select name="unit">${['per_sqm', 'per_sqyd', 'per_sqft'].map(u => `<option value="${u}" ${(c?.unit || found?.unit) === u ? 'selected' : ''}>${u.replace('per_', 'per ')}</option>`).join('')}</select></label></div>
          <label>Official source URL<input name="source_url" value="${esc(c?.source_url || found?.source_url || '')}" placeholder="state registration / revenue portal"></label>
          <div class="row2"><label>As of<input name="as_of" value="${esc(c?.as_of || found?.as_of || '')}" placeholder="2026-04-01"></label>
            <label>Category<input name="category" value="${esc(c?.category || found?.category || 'residential')}"></label></div>
          <button class="btn primary sm" type="submit">Save to circle_rates.csv</button>
          <p class="foot-note">Use the official state notification and match its unit and land category. Do not copy a rate from a blog.</p>
        </form></details>
    </div></div>`;
  $('#circleForm').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const agentSame = found && +f.rate_inr.value === found.rate_inr;
    try {
      const out = await api('/api/circle-rate', {
        locality: d.name, city: d.city, rate_inr: +f.rate_inr.value, unit: f.unit.value,
        source_url: f.source_url.value, as_of: f.as_of.value, category: f.category.value,
        origin: agentSame ? 'agent, checked by user' : 'manual',
      });
      toast('Circle rate saved. Gap recalculated.');
      if (out.locality) { S.locs.set(out.locality.id, out.locality); renderAll(false); }
    } catch (err) { toast('Could not save: ' + err.message, 'err'); }
  };
}

/* ---------------------------------------------------------------- digest pane */
function renderDigest(d) {
  const el = $('#pane-digest');
  if (!d || d === S.live) { el.innerHTML = `<div class="empty-pane">${d ? 'The digest is built when the scan finishes.' : 'Pick or scan a locality.'}</div>`; return; }
  const g = d.digest || {};
  const rows = (d.trend || []).slice().reverse();
  const list = (items, extra) => items.length ? `<table class="tbl"><tbody>${items.map(x => `<tr><td><span class="portal-tag">${esc(x.portal)}</span></td><td class="ttl"><div>${esc(x.title || 'Plot')}</div></td>
      <td class="num">${x.area_sqyd} sq yd</td><td class="num">${inrShort(x.total_price_inr)}</td><td class="num">${inr(x.ppsy)}/sq yd</td><td>${extra(x)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted small">None.</p>';
  el.innerHTML = g.compared_to ? `
    <div class="digest-head">
      <div class="dg"><div class="k">Compared to</div><div class="v" style="font-size:18px">${esc(g.compared_to)}</div></div>
      <div class="dg"><div class="k">New listings</div><div class="v">${g.new.length}</div></div>
      <div class="dg"><div class="k">Price drops</div><div class="v">${g.price_drops.length}</div></div>
      <div class="dg"><div class="k">Median change</div><div class="v">${pct(g.median_change_pct)}</div></div>
    </div>
    <div class="two-col"><div class="box"><h4>Price drops</h4>${list(g.price_drops, x => `<b style="color:var(--good)">−${x.drop_pct}%</b> <span class="muted small">was ${inrShort(x.old_price)}</span>`)}</div>
      <div class="box"><h4>New since last run</h4>${list(g.new.slice(0, 15), x => safeUrl(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">open ↗</a>` : '')}</div></div>`
    : `<div class="box" style="max-width:720px"><h4>First run for ${esc(d.label)}</h4>
       <p class="muted small">The weekly digest compares each run with the previous run on an earlier day: new listings, price drops and the change in median price. Star this locality and schedule <code>python run_weekly.py</code> (weekly, e.g. Monday 08:00) to build it up. Listing sites only show today's price, so this history is the value.</p></div>`;
  if (rows.length) el.insertAdjacentHTML('beforeend', `<div class="box" style="margin-top:12px;max-width:720px"><h4>Run history</h4><table class="tbl"><thead><tr><th>Date</th><th class="num">Median ₹/sq yd</th></tr></thead>
    <tbody>${rows.map(t => `<tr><td>${esc(t.date)}</td><td class="num">${inr(t.median)}</td></tr>`).join('')}</tbody></table></div>`);
}

/* ---------------------------------------------------------------- compare */
function renderCompareOptions() {
  const opts = [...S.locs.values()].map(r => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join('');
  const a = $('#cmpA'), b = $('#cmpB'), va = a.value, vb = b.value;
  a.innerHTML = opts; b.innerHTML = opts;
  const ids = [...S.locs.keys()];
  a.value = va && S.locs.has(va) ? va : ids[0] || '';
  b.value = vb && S.locs.has(vb) ? vb : ids[1] || ids[0] || '';
}
$('#cmpA').onchange = $('#cmpB').onchange = () => renderCompare();
function renderCompare() {
  const A = S.locs.get($('#cmpA').value), B = S.locs.get($('#cmpB').value);
  const out = $('#cmpOut');
  if (!A || !B || A === B) { out.innerHTML = `<p class="empty" style="padding:4px">${S.locs.size < 2 ? 'Scan at least two localities to compare them.' : 'Pick two different localities.'}</p>`; return; }
  const metrics = [
    { k: 'Median ask / sq yd', f: r => r.median_ppsy, fmt: inr, better: 'low' },
    { k: 'Gap to circle rate', f: r => r.gap_pct, fmt: pct, better: 'low' },
    { k: 'Amenity score', f: r => r.amenity?.score, fmt: v => (v == null ? '—' : v + ' / 10'), better: 'high', max: 10 },
    { k: 'Nearest metro / rail', f: r => r.amenity?.nearest_metro_m, fmt: v => (v == null ? '—' : (v / 1000).toFixed(1) + ' km'), better: 'low' },
    { k: 'Schools within 1 km', f: r => r.amenity?.counts_1km.school, fmt: v => v ?? '—', better: 'high' },
    { k: 'Listings in last run', f: r => r.n, fmt: v => v, better: null },
  ];
  const col = (r, o) => `<div class="cmp-col"><h4>${esc(r.label)}</h4><div class="muted small">${esc(r.verdict)}</div>
    ${metrics.map(m => {
      const v = m.f(r), w = m.f(o);
      const win = m.better && v != null && w != null && v !== w && (m.better === 'low' ? v < w : v > w);
      const max = m.max || Math.max(Math.abs(v || 0), Math.abs(w || 0)) || 1;
      return `<div class="cmp-row ${win ? 'win' : ''}"><div class="k">${m.k}</div><div class="v">${m.fmt(v)}</div>
        <div class="bar"><i style="width:${v == null ? 0 : Math.abs(v) / max * 100}%"></i></div></div>`;
    }).join('')}</div>`;
  out.innerHTML = `<div class="cmp">${col(A, B)}${col(B, A)}</div>
    <p class="hint small" style="margin-top:8px">Green marks the lower price, smaller gap, higher score or closer metro. The gap is an indicator, not proof of mispricing.</p>`;
  if (A.lat != null && B.lat != null) {
    map.fitBounds(L.latLngBounds([[A.lat, A.lon], [B.lat, B.lon]]).pad(0.3), { paddingBottomRight: [20, dockPx() + 20], paddingTopLeft: [380, 20] });
  }
}

/* ================================================================ jobs and agent cards */
function attachJob(jobId, kind, label, started) {
  if (S.jobs.has(jobId)) return S.jobs.get(jobId);
  // started is the server's job start (epoch seconds); event.at is seconds since then, so timers survive a reload.
  const job = { id: jobId, kind, label, started: started || Date.now() / 1000, lastSeq: -1, ended: false, cards: new Map(), es: null };
  S.jobs.set(jobId, job);
  const grid = $('#agentGrid');
  $('.empty-pane', grid)?.remove();
  const block = document.createElement('div');
  block.className = 'job-block';
  block.id = 'job-' + jobId;
  block.innerHTML = `<div class="job-label">${esc({ scan: 'Scan', rera: 'RERA check', auction: 'Auction tracker', custom: 'Custom agent' }[kind] || kind)} · ${esc(label)} · ${new Date(job.started * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div><div class="job-cards"></div>`;
  grid.prepend(block);
  connect(job);
  return job;
}

function connect(job) {
  const es = new EventSource(`/api/jobs/${job.id}/events?after=${job.lastSeq}`);
  job.es = es;
  es.onmessage = m => {
    const ev = JSON.parse(m.data);
    if (ev.seq <= job.lastSeq) return;
    job.lastSeq = ev.seq;
    try { onEvent(job, ev); } catch (err) { console.error(err, ev); }
  };
  es.onerror = () => {
    es.close();
    if (!job.ended) setTimeout(() => connect(job), 1500);
  };
}

function card(job, id, meta = {}) {
  let c = job.cards.get(id);
  if (c) return c;
  const role = meta.role || (id === 'circle-rate' ? 'circle' : id.split(':')[0]);
  const label = meta.label || (id === 'circle-rate' ? 'Circle rate' : id);
  const el = document.createElement('div');
  el.className = 'agent';
  el.innerHTML = `
    <div class="agent-head"><div><div class="nm">${esc(label)}</div><div class="role">${esc(ROLE[role] || 'Agent')}</div></div>
      <span class="status st-queued">queued</span><span class="tm">—</span></div>
    <div class="agent-body">
      <div class="screen"><div class="screen-msg"><div><div class="spinner"></div>Waiting to start</div></div></div>
      <div class="steps-wrap"><ol class="steps"></ol></div>
    </div>
    <div class="agent-foot"><details><summary>Goal and result</summary><div class="muted small" style="margin:6px 0 4px">Start URL: <span class="u"></span></div><pre class="goal"></pre><pre class="res" hidden></pre></details></div>`;
  $(`#job-${job.id} .job-cards`).append(el);
  c = { el, role, label, t0: null, tEnd: null, state: 'queued', liveUrl: null };
  job.cards.set(id, c);
  updateAgentCount();
  return c;
}

function setStatus(c, state, text) {
  c.state = state;
  const s = $('.status', c.el);
  s.className = 'status st-' + state;
  s.textContent = text || state;
  c.el.classList.toggle('running', ['started', 'live'].includes(state));
}
function screenMsg(c, html) {
  $('.screen', c.el).innerHTML = `<div class="screen-msg"><div>${html}</div></div>`;
}
function addStep(c, t, text, cls = '') {
  const ol = $('.steps', c.el);
  ol.insertAdjacentHTML('beforeend', `<li class="${cls}"><span>${t != null ? fmtT(t) : ''}</span><div>${esc(text)}</div></li>`);
  ol.scrollTop = ol.scrollHeight;
}

function onAgentEvent(job, ev) {
  const c = card(job, ev.id);
  switch (ev.phase) {
    case 'queued':
      c.t0 = (job.started + (ev.at || 0)) * 1000; c.tEnd = null;
      $('.u', c.el).textContent = ev.url;
      $('.goal', c.el).textContent = ev.goal;
      $('.role', c.el).textContent = `${ROLE[c.role] || 'Agent'} · Agent API (SSE)${ev.stealth ? ' · stealth' : ''}${ev.schema ? ' · output_schema' : ''}`;
      setStatus(c, 'queued');
      screenMsg(c, `<div class="spinner"></div>Requesting a TinyFish browser for<br><b style="color:#e5e7eb">${esc(ev.url)}</b>`);
      break;
    case 'started':
      setStatus(c, 'started', 'starting');
      screenMsg(c, `<div class="spinner"></div>Run <code style="background:none;border:0;color:#e5e7eb">${esc((ev.run_id || '').slice(0, 8))}</code> accepted.<br>Waiting for a browser. If your account's concurrency limit is reached, it queues here.`);
      break;
    case 'live': {
      setStatus(c, 'live');
      if (c.liveUrl !== ev.streaming_url) {
        if (c.liveUrl) addStep(c, ev.t, 'Agent switched to a new browser session');
        c.liveUrl = ev.streaming_url;
        const url = safeUrl(ev.streaming_url);
        $('.screen', c.el).innerHTML = url ? `<span class="live-tag">LIVE</span><a class="open-live" href="${esc(url)}" target="_blank" rel="noopener">open ↗</a>
          <iframe src="${esc(url)}" title="Live browser for ${esc(c.label)}" referrerpolicy="no-referrer" loading="eager"></iframe>` : '';
      }
      break;
    }
    case 'step':
      if (c.state === 'started') setStatus(c, 'live');
      addStep(c, ev.t, ev.purpose);
      break;
    case 'done': {
      c.tEnd = (job.started + ev.at) * 1000;
      setStatus(c, 'done');
      const r = ev.result || {};
      let big = '✓', lbl = `Finished in ${ev.steps} steps`;
      if (c.role === 'listings') { big = (r.listings || []).length; lbl = `listings returned in ${ev.steps} steps${r.blocked ? ' · site showed a block page' : ''}`; }
      if (c.role === 'circle') { big = r.found ? inr(r.rate_inr) : '—'; lbl = r.found ? (r.unit || '') + ' · ' + (r.category || '') : 'rate not on this page'; }
      if (c.role === 'rera') { big = r.found ? '✓' : '?'; lbl = r.found ? (r.registration_number || 'match found') : r.could_not_check ? 'could not check' : 'no match'; }
      if (c.role === 'auction') { big = (r.schemes || []).length; lbl = 'schemes found'; }
      $('.screen', c.el).insertAdjacentHTML('beforeend', `<div class="screen-over"><div class="big">${esc(big)}</div><div class="lbl">${esc(lbl)}</div><div class="lbl muted">${fmtT(ev.t)}</div></div>`);
      $('.live-tag', c.el)?.remove();
      addStep(c, ev.t, 'COMPLETE');
      const pre = $('.res', c.el);
      pre.hidden = false;
      pre.textContent = JSON.stringify(r, null, 2);
      if (r.notes) addStep(c, null, 'Note: ' + r.notes);
      break;
    }
    case 'error':
      c.tEnd = (job.started + ev.at) * 1000;
      setStatus(c, 'error', 'failed');
      $('.screen', c.el).insertAdjacentHTML('beforeend', `<div class="screen-over err"><div class="big">Agent could not finish</div><div class="lbl">${esc(ev.message)}</div></div>`);
      $('.live-tag', c.el)?.remove();
      addStep(c, ev.t, ev.message, 'err');
      break;
  }
  updateJobStatus();
}

function onEvent(job, ev) {
  switch (ev.type) {
    case 'job':
      if (ev.phase === 'start') {
        (ev.agents || []).forEach(a => card(job, a.id, a));
        if (ev.kind === 'scan') {
          S.live = { id: ev.id, label: ev.label, name: ev.label.split(',')[0], city: ev.label.split(',').slice(1).join(',').trim(),
            state: $('#scanForm').state.value, lat: null, lon: null, listings: [], amenities: [], score: null, circle: null };
          S.current = ev.id;
          S.circleFlow[ev.id] = null;
          renderAll(false);
        }
        switchPane('agents');
      } else if (ev.phase === 'end') {
        job.ended = true;
        job.es?.close();
        $$('.agent', $('#job-' + job.id)).forEach(el => el.classList.remove('running'));
        if (job.id === S.scanJob) scanFinished();
      } else if (ev.phase === 'failed') {
        toast('Job failed: ' + ev.message, 'err');
      } else if (ev.phase === 'cancelled') {
        toast('Stopped. Remote browsers were asked to cancel.');
        job.cards.forEach(c => { if (!['done', 'error'].includes(c.state)) { c.tEnd = Date.now(); setStatus(c, 'error', 'stopped'); } });
        if (S.live) { S.live = null; renderAll(false); }
      }
      updateJobStatus();
      break;
    case 'agent':
      onAgentEvent(job, ev);
      if (ev.phase === 'done' && job.kind === 'custom') renderCustom(ev.result);
      break;
    case 'geo':
      if (S.live) { S.live.lat = ev.lat; S.live.lon = ev.lon; S.live.geo_how = ev.how; if (S.current === S.live.id) { renderMapData(S.live, true); } }
      break;
    case 'amenities':
      if (S.live) { S.live.amenities = ev.items; S.live.score = ev.score; if (S.current === S.live.id) { renderSummary(S.live); renderMapData(S.live, false); } }
      break;
    case 'listings':
      if (S.live) {
        S.live.listings.push(...ev.rows);
        if (S.current === S.live.id) { renderSummary(S.live); renderMapData(S.live, false); renderListings(S.live); }
        toast(`${ev.portal}: ${ev.rows.length} plots on the map`);
      }
      break;
    case 'circle': {
      const id = S.live?.id;
      if (!id) break;
      const f = (S.circleFlow[id] ||= {});
      f.phase = ev.phase;
      if (ev.query) f.query = ev.query;
      if (ev.phase === 'results') f.results = ev.results;
      if (ev.phase === 'fetched') f.fetched = ev.results;
      if (ev.phase === 'agent') { f.agentUrl = ev.url; f.attempt = ev.attempt; }
      if (ev.phase === 'found') {
        f.rate = ev.rate;
        const TO = { per_sqyd: 1, per_sqft: 9, per_sqm: 1 / 1.19599 };
        if (TO[ev.rate.unit]) S.live.circle = { ...ev.rate, origin: 'agent (verify)', ppsy: Math.round(ev.rate.rate_inr * TO[ev.rate.unit]) };
        toast(`Circle-rate agent found ${inr(ev.rate.rate_inr)} ${(ev.rate.unit || '').replace('per_', 'per ')}. Marked “verify”.`);
      }
      if (ev.phase === 'on_file') S.live.circle = ev.rate;
      if (ev.phase === 'error') f.message = ev.message;
      if (S.current === id) { renderCircle(S.live); renderSummary(S.live); }
      break;
    }
    case 'result': {
      const r = ev.result;
      if (r.saved) S.locs.set(r.id, r);
      S.live = null;
      if (r.saved) { select(r.id, false); renderCompareOptions(); }
      else { S.locs.set(r.id, r); select(r.id, false); }
      toast(r.n ? `Done: ${r.n} plots · ${r.verdict}` : 'Scan finished but no usable listings came back. Try stealth mode or another portal.', r.n ? '' : 'warn');
      break;
    }
    case 'warn':
      toast(ev.message, 'warn');
      break;
    case 'rera':
      renderRera(ev);
      break;
    case 'auctions':
      renderAuctions(ev);
      break;
  }
}

function updateAgentCount() {
  let n = 0;
  S.jobs.forEach(j => j.cards.forEach(c => { if (!['done', 'error'].includes(c.state)) n++; }));
  $('#agentCount').textContent = n;
}
function updateJobStatus() {
  updateAgentCount();
  const active = [...S.jobs.values()].filter(j => !j.ended);
  if (!active.length) { $('#jobStatus').innerHTML = ''; return; }
  const cards = active.flatMap(j => [...j.cards.values()]);
  const done = cards.filter(c => ['done', 'error'].includes(c.state)).length;
  const live = cards.filter(c => c.state === 'live').length;
  $('#jobStatus').innerHTML = `<span class="status st-live">running</span> ${done}/${cards.length} agents finished · ${live} browsing live`;
}
function tick() {
  S.jobs.forEach(j => j.cards.forEach(c => {
    if (c.t0) $('.tm', c.el).textContent = fmtT(((c.tEnd || Date.now()) - c.t0) / 1000);
  }));
}

/* ================================================================ scan form */
$('#scanForm').onsubmit = async e => {
  e.preventDefault();
  const f = e.target;
  const portals = $$('input[name="portal"]:checked').map(i => i.value);
  const custom = f.custom.value.split(/[,\s]+/).filter(Boolean);
  if (!portals.length && !custom.length) { toast('Pick at least one portal.', 'warn'); return; }
  const num = v => (v === '' ? null : +v);
  const body = {
    name: f.name.value.trim(), city: f.city.value.trim(), state: f.state.value,
    portals, custom_urls: custom, stealth: f.stealth.checked, auto_circle: f.auto_circle.checked,
    min_area: num(f.min_area.value), max_area: num(f.max_area.value), budget: f.budget.value ? +f.budget.value * 1e5 : null,
  };
  scanStarted(null);
  try {
    const { job_id, started } = await api('/api/scan', body);
    S.scanJob = job_id;
    attachJob(job_id, 'scan', `${body.name}, ${body.city}`, started);
  } catch (err) {
    toast('Could not start: ' + err.message, 'err');
    scanFinished();
  }
};
$('#stopBtn').onclick = async () => {
  if (!S.scanJob) return;
  $('#stopBtn').disabled = true;
  try { await api(`/api/jobs/${S.scanJob}/cancel`, {}); } catch (err) { toast(err.message, 'err'); }
  $('#stopBtn').disabled = false;
};
function scanStarted(jobId) {
  if (jobId) S.scanJob = jobId;
  $('#scanBtn').disabled = true;
  $('#scanBtn').lastChild.textContent = ' Agents running…';
  $('#stopBtn').hidden = false;
}
function scanFinished() {
  S.scanJob = null;
  $('#scanBtn').disabled = false;
  $('#scanBtn').lastChild.textContent = ' Release the agents';
  $('#stopBtn').hidden = true;
}

/* ================================================================ tools */
function fillAuthorities() {
  const st = S.config.states[$('#auctionState').value] || {};
  $('#auctionAuth').innerHTML = Object.keys(st.authorities || {}).map(a => `<option>${esc(a)}</option>`).join('');
}
$('#auctionState').onchange = fillAuthorities;

function toolSubmit(formSel, path, build, outSel, kind) {
  $(formSel).onsubmit = async e => {
    e.preventDefault();
    const body = build(e.target);
    const btn = $('button[type="submit"]', e.target);
    btn.disabled = true;
    $(outSel).innerHTML = '<p class="muted small out">Agent started. Watch it in the Live agents panel below.</p>';
    try {
      const { job_id, started } = await api(path, body);
      const job = attachJob(job_id, kind, body.project || body.authority || body.url || body.goal.slice(0, 50), started);
      job.onEnd = () => (btn.disabled = false);
      const poll = setInterval(() => { if (job.ended) { btn.disabled = false; clearInterval(poll); } }, 1000);
    } catch (err) {
      $(outSel).innerHTML = `<p class="out" style="color:var(--bad)">${esc(err.message)}</p>`;
      btn.disabled = false;
    }
  };
}
toolSubmit('#reraForm', '/api/rera', f => ({ project: f.project.value, promoter: f.promoter.value, state: f.state.value, locality: f.locality.value }), '#reraOut', 'rera');
toolSubmit('#auctionForm', '/api/auctions', f => ({ state: f.state.value, authority: f.url.value ? '' : f.authority.value, url: f.url.value, place: f.place.value }), '#auctionOut', 'auction');
toolSubmit('#customForm', '/api/agent', f => ({ url: f.url.value, goal: f.goal.value, stealth: f.stealth.checked }), '#customOut', 'custom');

function renderRera(ev) {
  const r = ev.result || {};
  const cls = { verified: 'verified', 'not found': 'notfound', 'could not check': 'nocheck' }[ev.badge];
  $('#reraOut').innerHTML = `<div class="out"><span class="rera-badge ${cls}">${ev.badge === 'verified' ? '✓ ' : ''}${esc(ev.badge)}</span>
    <dl class="kv">${[['Project', r.project_name], ['Reg. no.', r.registration_number], ['Promoter', r.promoter], ['Status', r.status], ['Valid until', r.valid_until]]
      .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}
      ${safeUrl(r.page_url) ? `<dt>Page</dt><dd><a href="${esc(r.page_url)}" target="_blank" rel="noopener noreferrer">open ↗</a></dd>` : ''}</dl>
    ${r.notes ? `<p class="foot-note">${esc(r.notes)}</p>` : ''}
    <p class="foot-note">First-pass check by an agent. Not legal advice. Confirm on the portal yourself.</p></div>`;
}
function renderAuctions(ev) {
  const items = ev.schemes || [];
  $('#auctionOut').innerHTML = `<div class="out"><div class="muted small">${ev.ok ? `${items.length} scheme${items.length === 1 ? '' : 's'} found on ${esc(ev.authority)}` : 'The agent could not finish. See its card for details.'}</div>
    ${items.map(s => `<div class="scheme"><b>${safeUrl(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a>` : esc(s.title)}</b>
      <div class="meta">${[s.kind, s.location, s.plot_sizes, s.reserve_price_text && 'Reserve ' + s.reserve_price_text, s.opens_on && 'Opens ' + s.opens_on, s.closes_on && 'Closes ' + s.closes_on, s.status]
        .filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('')}</div></div>`).join('')}
    ${ev.notes ? `<p class="foot-note">${esc(ev.notes)}</p>` : ''}</div>`;
}
function renderCustom(result) {
  $('#customOut').innerHTML = `<pre class="out" style="font-family:var(--mono);font-size:11.5px;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:10px;white-space:pre-wrap;max-height:320px;overflow:auto">${esc(JSON.stringify(result, null, 2))}</pre>`;
}

boot();
