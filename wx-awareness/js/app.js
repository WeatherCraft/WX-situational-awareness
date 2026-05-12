/* ============================================================
   SITUATIONAL AWARENESS — app.js
   ============================================================ */

const NWS_ALERTS_URL  = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&region_type=land';
const LSR_URL         = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours=12&wfo=all';
const SPC_DAY1_URL    = 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson';
const SPC_DAY2_URL    = 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.lyr.geojson';
const SPC_DAY3_URL    = 'https://www.spc.noaa.gov/products/outlook/day3otlk_cat.lyr.geojson';
const SPC_D1TOR       = 'https://www.spc.noaa.gov/products/outlook/day1otlk_torn.lyr.geojson';
const SPC_D2TOR       = 'https://www.spc.noaa.gov/products/outlook/day2otlk_torn.lyr.geojson';
const SPC_D3TOR       = 'https://www.spc.noaa.gov/products/outlook/day3otlk_torn.lyr.geojson';

const RADAR_REFL_WMS  = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi';
const RADAR_VEL_WMS   = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0u.cgi';

const CAT_ORDER = ['TSTM','MRGL','SLGT','ENH','MDT','HIGH'];

let allAlerts    = [];
let allReports   = [];
let alertFilter  = 'ALL';
let reportFilter = 'ALL';
let pingSettings = { PDS: false, TOR: false, SVR: false, 'TOR/FFW-E': false };
let seenAlertIds = new Set();
let alertsExpanded = false;
let radarMap = null;
let radarLayer = null;

// ============================================================
// MULTI-TZ CLOCKS
// ============================================================
function updateClocks() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');

  // Zulu (UTC) in military time HH:MM:SS
  const zH = pad(now.getUTCHours());
  const zM = pad(now.getUTCMinutes());
  const zS = pad(now.getUTCSeconds());
  document.getElementById('clock-utc').textContent = `${zH}${zM}${zS}Z`;

  // Helper: format as HH:MM for a given UTC offset (standard, no DST auto here)
  // We use Intl.DateTimeFormat for proper DST handling
  const fmt = tz => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit',
      hour12: false
    }).formatToParts(now);
    const h = parts.find(p => p.type === 'hour')?.value || '00';
    const m = parts.find(p => p.type === 'minute')?.value || '00';
    return `${h}:${m}`;
  };

  document.getElementById('clock-est').textContent = fmt('America/New_York');
  document.getElementById('clock-cst').textContent = fmt('America/Chicago');
  document.getElementById('clock-mst').textContent = fmt('America/Denver');
  document.getElementById('clock-pst').textContent = fmt('America/Los_Angeles');
}
setInterval(updateClocks, 1000);
updateClocks();

// ============================================================
// SETTINGS
// ============================================================
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.remove('hidden');
  document.getElementById('settings-overlay').classList.remove('hidden');
});
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-overlay').addEventListener('click', closeSettings);
function closeSettings() {
  document.getElementById('settings-panel').classList.add('hidden');
  document.getElementById('settings-overlay').classList.add('hidden');
}

document.querySelectorAll('.ping-toggle').forEach(cb => {
  cb.addEventListener('change', () => {
    pingSettings[cb.dataset.type] = cb.checked;
    savePingSettings();
  });
});
document.getElementById('compact-toggle').addEventListener('click', () => {
  document.body.classList.toggle('compact');
  document.getElementById('compact-toggle').classList.toggle('active');
  document.getElementById('compact-icon').textContent =
    document.body.classList.contains('compact') ? '⊞' : '⊡';
  if (radarMap) setTimeout(() => radarMap.invalidateSize(), 120);
});

// Persist ping settings
function savePingSettings() {
  try { localStorage.setItem('pings', JSON.stringify(pingSettings)); } catch(e) {}
}
try {
  const s = JSON.parse(localStorage.getItem('pings') || '{}');
  Object.entries(s).forEach(([k, v]) => {
    pingSettings[k] = v;
    const el = document.querySelector(`.ping-toggle[data-type="${k}"]`);
    if (el) el.checked = v;
  });
} catch(e) {}

// ============================================================
// ALERTS BAR — expand/collapse
// ============================================================
const alertsBar   = document.getElementById('alerts-bar');
const abExpandBtn = document.getElementById('ab-expand-btn');
const abExpanded  = document.getElementById('ab-expanded');
const abTickerWrap = document.getElementById('ab-ticker-wrap');

abExpandBtn.addEventListener('click', () => {
  alertsExpanded = !alertsExpanded;
  alertsBar.classList.toggle('expanded', alertsExpanded);
  abExpandBtn.classList.toggle('open', alertsExpanded);
  abExpandBtn.textContent = alertsExpanded ? '▼' : '▲';
  // Adjust main padding so content isn't hidden
  const main = document.getElementById('site-main');
  if (alertsExpanded) {
    main.style.paddingBottom = '440px';
  } else {
    main.style.paddingBottom = '';
  }
});

// Alert filter buttons in bar
document.querySelectorAll('.abf').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.abf').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    alertFilter = btn.dataset.filter;
    renderAlerts();
  });
});

// ============================================================
// CLASSIFY ALERT
// ============================================================
function classifyAlert(a) {
  const ev   = (a.properties.event || '').toUpperCase();
  const desc = (a.properties.description || '').toUpperCase();
  const isPDS = desc.includes('PARTICULARLY DANGEROUS SITUATION') || desc.includes('PDS TORNADO');

  if (ev.includes('TORNADO WARNING')) {
    if (isPDS) return 'PDS';
    return 'TOR';
  }
  if (ev.includes('FLASH FLOOD EMERGENCY') && ev.includes('TORNADO')) return 'TORFFW';
  if (ev.includes('FLASH FLOOD EMERGENCY')) return 'TORFFW';
  if (ev.includes('SEVERE THUNDERSTORM WARNING')) return 'SVR';
  if (ev.includes('FLASH FLOOD')) return 'FFW';
  if (ev.includes('SPECIAL WEATHER STATEMENT')) return 'SPS';
  if (ev.includes('WATCH')) return 'MWS';
  return 'OTHER';
}

const ALERT_PRIORITY = { PDS:0, TORFFW:1, TOR:2, SVR:3, FFW:4, SPS:5, MWS:6, OTHER:7 };

// ============================================================
// FETCH ALERTS
// ============================================================
async function fetchAlerts() {
  const btn = document.getElementById('refresh-alerts');
  btn.classList.add('spinning');
  try {
    const res  = await fetch(NWS_ALERTS_URL, { headers: { 'User-Agent': 'wx-sitrep/2.0' } });
    const data = await res.json();
    const features = data.features || [];

    // Detect new
    const brandNew = features.filter(f => !seenAlertIds.has(f.properties.id));
    features.forEach(f => seenAlertIds.add(f.properties.id));
    brandNew.forEach(a => {
      const t = classifyAlert(a);
      if (pingSettings[t] || (t === 'TOR' && pingSettings['TOR']) || (t === 'PDS' && pingSettings['PDS'])) {
        triggerPing(t, a.properties.headline || a.properties.event);
      }
    });

    allAlerts = features;
    renderAlerts();
    document.getElementById('alert-count').textContent = allAlerts.length;
  } catch(e) {
    console.error('Alert fetch error:', e);
  } finally {
    btn.classList.remove('spinning');
  }
}

function renderAlerts() {
  let list = allAlerts;

  if (alertFilter !== 'ALL') {
    list = allAlerts.filter(a => {
      const t = classifyAlert(a);
      if (alertFilter === 'PDS') return t === 'PDS';
      if (alertFilter === 'TOR') return t === 'TOR' || t === 'PDS' || t === 'TORFFW';
      if (alertFilter === 'SVR') return t === 'SVR';
      if (alertFilter === 'FFW') return t === 'FFW' || t === 'TORFFW';
      return false;
    });
  }

  list = [...list].sort((a, b) =>
    (ALERT_PRIORITY[classifyAlert(a)] || 7) - (ALERT_PRIORITY[classifyAlert(b)] || 7)
  );

  // Update count badge
  document.getElementById('alert-count').textContent = list.length;

  // Build ticker text
  if (!list.length) {
    document.getElementById('ab-ticker').textContent = 'NO ACTIVE ALERTS MATCHING FILTER';
  } else {
    const ticker = list.slice(0, 30).map(a => {
      const t = classifyAlert(a);
      const ev = a.properties.headline || a.properties.event || '';
      const area = (a.properties.areaDesc || '').split(';')[0];
      return `[ ${t} ] ${truncate(ev, 55)} — ${truncate(area, 40)}`;
    }).join('   ·   ');
    const el = document.getElementById('ab-ticker');
    el.textContent = ticker;
    // Reset animation
    el.style.animation = 'none';
    el.offsetHeight; // reflow
    el.style.animation = '';
  }

  // Build expanded grid
  const grid = document.getElementById('alerts-grid');
  if (!list.length) {
    grid.innerHTML = '<div class="no-data" style="grid-column:1/-1">NO ACTIVE ALERTS</div>';
    return;
  }

  grid.innerHTML = list.map(a => {
    const p = a.properties;
    const t = classifyAlert(a);
    const expires = p.expires ? fmtTime(new Date(p.expires)) : '—';
    const sent    = p.sent    ? fmtTime(new Date(p.sent))    : '—';
    return `
    <div class="alert-card type-${t}">
      <div class="ac-top">
        <span class="ac-badge badge-${t}">${t}</span>
        <span class="ac-headline">${truncate(p.headline || p.event || '', 60)}</span>
      </div>
      <div class="ac-area">${truncate(p.areaDesc || '', 70)}</div>
      <div class="ac-meta">
        <span>${p.senderName || ''}</span>
        <span>Issued ${sent}</span>
        <span class="ac-expire">Exp ${expires}</span>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('refresh-alerts').addEventListener('click', fetchAlerts);

// ============================================================
// FETCH STORM REPORTS
// ============================================================
async function fetchReports() {
  const btn = document.getElementById('refresh-reports');
  btn.classList.add('spinning');
  try {
    const res  = await fetch(LSR_URL);
    const data = await res.json();
    allReports = data.features || [];
    renderReports();
    document.getElementById('reports-count').textContent = allReports.length;
    document.getElementById('reports-ts').textContent = fmtTime(new Date());
  } catch(e) {
    console.error('Reports fetch error:', e);
    document.getElementById('reports-list').innerHTML = '<div class="no-data">⚠ Failed to load</div>';
  } finally {
    btn.classList.remove('spinning');
  }
}

function renderReports() {
  let list = allReports;
  if (reportFilter !== 'ALL') {
    list = allReports.filter(r => {
      const t = (r.properties.typetext || r.properties.type || '').toUpperCase();
      if (reportFilter === 'TORNADO') return t.includes('TORNADO');
      if (reportFilter === 'HAIL')    return t.includes('HAIL');
      if (reportFilter === 'WIND')    return t.includes('WIND') || t.includes('TSTM WND');
      return false;
    });
  }
  list = [...list].sort((a, b) => new Date(b.properties.valid) - new Date(a.properties.valid));

  const el = document.getElementById('reports-list');
  if (!list.length) { el.innerHTML = '<div class="no-data">NO REPORTS</div>'; return; }

  el.innerHTML = list.slice(0, 200).map(r => {
    const p = r.properties;
    const raw = (p.typetext || p.type || '').toUpperCase();
    let dispType = 'OTHER', icon = '⚡', magStr = '', magClass = '';

    if (raw.includes('TORNADO')) {
      dispType = 'TORNADO'; icon = '🌪️';
      const ef = p.magnitude ? `EF${p.magnitude}` : 'TOR';
      magStr = ef; magClass = 'tor';
    } else if (raw.includes('HAIL')) {
      dispType = 'HAIL'; icon = '🧊';
      magStr = p.magnitude ? `${p.magnitude}"` : 'HAIL'; magClass = 'hail';
    } else if (raw.includes('WIND') || raw.includes('TSTM WND')) {
      dispType = 'WIND'; icon = '💨';
      magStr = p.magnitude ? `${p.magnitude}MPH` : 'WIND'; magClass = 'wind';
    } else {
      magStr = raw.slice(0,8);
    }

    const loc   = [p.city, p.county].filter(Boolean).join(', ');
    const state = p.state || '';
    const t     = p.valid ? fmtTime(new Date(p.valid)) : '';
    const rem   = p.remark ? truncate(p.remark, 50) : '';

    return `
    <div class="report-item type-${dispType}">
      <div class="report-row1">
        <span class="report-icon">${icon}</span>
        <span class="report-type-label">${dispType}</span>
        <span class="report-mag ${magClass}">${magStr}</span>
      </div>
      <div class="report-location">${loc}${state ? ', '+state : ''}</div>
      <div class="report-meta">${t}${p.wfo ? ' · '+p.wfo : ''}${rem ? ' · '+rem : ''}</div>
    </div>`;
  }).join('');
}

document.querySelectorAll('#reports-panel .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#reports-panel .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    reportFilter = btn.dataset.filter;
    renderReports();
  });
});
document.getElementById('refresh-reports').addEventListener('click', fetchReports);

// ============================================================
// SPC OUTLOOKS
// ============================================================
async function fetchOutlooks() {
  try {
    const [r1c, r2c, r3c, r1t, r2t, r3t] = await Promise.allSettled([
      fetchJSON(SPC_DAY1_URL), fetchJSON(SPC_DAY2_URL), fetchJSON(SPC_DAY3_URL),
      fetchJSON(SPC_D1TOR),    fetchJSON(SPC_D2TOR),    fetchJSON(SPC_D3TOR)
    ]);
    applyCatOutlook('d1-cat-val', 'tile-d1-cat', r1c.value);
    applyCatOutlook('d2-cat-val', 'tile-d2-cat', r2c.value);
    applyCatOutlook('d3-cat-val', 'tile-d3-cat', r3c.value);
    applyTorOutlook('d1-tor-val', 'tile-d1-tor', r1t.value);
    applyTorOutlook('d2-tor-val', 'tile-d2-tor', r2t.value);
    applyTorOutlook('d3-tor-val', 'tile-d3-tor', r3t.value);

    // Refresh SPC images with cache-busting
    const ts = Math.floor(Date.now() / 300000);
    refreshSpcImages(ts);
  } catch(e) { console.error('Outlook error:', e); }
}

function applyCatOutlook(valId, tileId, data) {
  const el   = document.getElementById(valId);
  const tile = document.getElementById(tileId);
  if (!data?.features?.length) {
    el.textContent = 'NONE'; el.className = 'spc-val spc-NONE'; return;
  }
  const cats = data.features.map(f => (f.properties.LABEL2 || f.properties.LABEL || '').toUpperCase());
  let highest = 'NONE';
  for (const c of CAT_ORDER) { if (cats.some(x => x.includes(c))) highest = c; }
  el.textContent = highest;
  el.className = `spc-val spc-${highest}`;
  if (tile) {
    tile.classList.remove('level-HIGH','level-MDT','level-ENH','level-SLGT');
    if (['HIGH','MDT','ENH','SLGT'].includes(highest)) tile.classList.add(`level-${highest}`);
  }
}

function applyTorOutlook(valId, tileId, data) {
  const el = document.getElementById(valId);
  if (!data?.features?.length) { el.textContent = 'NONE'; el.className = 'spc-val spc-NONE'; return; }
  const labels = data.features.map(f => (f.properties.LABEL2 || f.properties.LABEL || '').replace('%','').trim());
  const hasSIGN = labels.some(l => l.toUpperCase().includes('SIGN'));
  const nums = labels.map(l => parseFloat(l)).filter(n => !isNaN(n));
  const max  = nums.length ? Math.max(...nums) : 0;

  if (hasSIGN)      { el.textContent = 'SIGN'; el.className = 'spc-val spc-SIGN'; }
  else if (max >= 45){ el.textContent = '45%';  el.className = 'spc-val spc-HIGH'; }
  else if (max >= 30){ el.textContent = '30%';  el.className = 'spc-val spc-MDT';  }
  else if (max >= 15){ el.textContent = '15%';  el.className = 'spc-val spc-ENH';  }
  else if (max >= 10){ el.textContent = '10%';  el.className = 'spc-val spc-SLGT'; }
  else if (max >= 5) { el.textContent = '5%';   el.className = 'spc-val spc-MRGL'; }
  else if (max >= 2) { el.textContent = '2%';   el.className = 'spc-val spc-TSTM'; }
  else               { el.textContent = 'NONE'; el.className = 'spc-val spc-NONE'; }
}

function refreshSpcImages(ts) {
  const map = {
    'img-d1-cat': 'https://www.spc.noaa.gov/products/outlook/day1otlk_1300.gif',
    'img-d1-tor': 'https://www.spc.noaa.gov/products/outlook/day1probotlk_1300_torn.gif',
    'img-d2-cat': 'https://www.spc.noaa.gov/products/outlook/day2otlk_0600.gif',
    'img-d2-tor': 'https://www.spc.noaa.gov/products/outlook/day2probotlk_torn.gif',
    'img-d3-cat': 'https://www.spc.noaa.gov/products/outlook/day3otlk_0730.gif',
    'img-d3-tor': 'https://www.spc.noaa.gov/products/outlook/day3probotlk_torn.gif',
  };
  Object.entries(map).forEach(([id, url]) => {
    const img = document.getElementById(id);
    if (img) img.src = `${url}?_=${ts}`;
  });
}

// ============================================================
// RADAR MAP (Leaflet)
// ============================================================
function initRadar() {
  if (!window.L) { setTimeout(initRadar, 200); return; }

  radarMap = L.map('radar-map', {
    center: [38.5, -97],
    zoom: 3,
    zoomControl: true,
    attributionControl: true,
  });

  // Dark basemap tiles
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(radarMap);

  // NEXRAD REFL WMS
  radarLayer = L.tileLayer.wms(RADAR_REFL_WMS, {
    layers: 'nexrad-n0q-900913',
    format: 'image/png',
    transparent: true,
    opacity: 0.85,
    attribution: 'Iowa State Mesonet',
  }).addTo(radarMap);

  // Labels on top
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
    pane: 'overlayPane',
  }).addTo(radarMap);

  // Auto-refresh radar every 90s
  setInterval(() => {
    if (radarLayer) radarLayer.setParams({ _t: Date.now() });
    document.getElementById('radar-ts').textContent = '● LIVE';
  }, 90_000);
}

// Radar product toggle
document.getElementById('radar-bref').addEventListener('click', () => {
  document.getElementById('radar-bref').classList.add('active');
  document.getElementById('radar-rvel').classList.remove('active');
  if (radarLayer) {
    radarLayer.setUrl(RADAR_REFL_WMS);
    radarLayer.setParams({ layers: 'nexrad-n0q-900913', _t: Date.now() });
  }
});
document.getElementById('radar-rvel').addEventListener('click', () => {
  document.getElementById('radar-rvel').classList.add('active');
  document.getElementById('radar-bref').classList.remove('active');
  if (radarLayer) {
    radarLayer.setUrl(RADAR_VEL_WMS);
    radarLayer.setParams({ layers: 'nexrad-n0u-900913', _t: Date.now() });
  }
});

// ============================================================
// AUDIO PINGS
// ============================================================
const PING_FREQS = {
  PDS:     [880, 1100, 880, 1100],
  TOR:     [660, 880, 660],
  SVR:     [440, 550, 440],
  TORFFW:  [880, 1320, 880, 1320],
};

function playPing(type) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = PING_FREQS[type] || [440, 550];
    let t = ctx.currentTime;
    freqs.forEach(f => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = f;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.start(t); osc.stop(t + 0.18);
      t += 0.22;
    });
  } catch(e) {}
}

function showToast(type, msg) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<div class="toast-title">⚠ NEW ${type} ALERT</div><div class="toast-body">${truncate(msg, 75)}</div>`;
  document.getElementById('toast-container').prepend(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 350);
  }, 9000);
}

function triggerPing(type, msg) {
  playPing(type);
  showToast(type, msg || '');
}

// ============================================================
// HELPERS
// ============================================================
function fmtTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
         ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

// ============================================================
// INIT
// ============================================================
async function init() {
  initRadar();
  await Promise.allSettled([fetchAlerts(), fetchReports(), fetchOutlooks()]);
  setInterval(fetchAlerts,  60_000);
  setInterval(fetchReports, 120_000);
  setInterval(fetchOutlooks, 300_000);
}

init();
