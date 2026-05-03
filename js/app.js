/* ============================================================
   WX SITREP — app.js
   Fetches from NWS API, SPC, Iowa Mesonet / RIDGE2
   ============================================================ */

// ---- CONFIG ----
const REFRESH_ALERTS_MS  = 60_000;   // 1 min
const REFRESH_REPORTS_MS = 120_000;  // 2 min
const REFRESH_OUTLOOK_MS = 300_000;  // 5 min

// NWS API
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&region_type=land';
const LSR_URL        = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson?hours=12&wfo=all';

// Iowa State RIDGE2 NEXRAD tiles (WMS)
const RADAR_BASE = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q.cgi';
const RADAR_VEL  = 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0u.cgi';

// SPC XMACL JSON
const SPC_DAY1_URL = 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.lyr.geojson';
const SPC_DAY2_URL = 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.lyr.geojson';
const SPC_DAY3_URL = 'https://www.spc.noaa.gov/products/outlook/day3otlk_cat.lyr.geojson';
const SPC_D1TOR    = 'https://www.spc.noaa.gov/products/outlook/day1otlk_torn.lyr.geojson';
const SPC_D2TOR    = 'https://www.spc.noaa.gov/products/outlook/day2otlk_torn.lyr.geojson';
const SPC_D3TOR    = 'https://www.spc.noaa.gov/products/outlook/day3otlk_torn.lyr.geojson';

// SPC categorical order (highest last)
const CAT_ORDER = ['TSTM','MRGL','SLGT','ENH','MDT','HIGH'];
const TOR_ORDER = ['0.02','0.05','0.10','0.15','0.30','0.45','0.60','SIGN'];

// ---- STATE ----
let allAlerts    = [];
let allReports   = [];
let alertFilter  = 'ALL';
let reportFilter = 'ALL';
let pingSettings = { PDS: false, TOR: false, SVR: false, 'TOR/FFW-E': false };
let seenAlertIds = new Set();
let isCompact    = false;
let radarMap     = null;
let radarLayer   = null;
let currentProduct = 'n0q';

// ---- DOM REFS ----
const settingsBtn   = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const compactToggle = document.getElementById('compact-toggle');
const alertsList    = document.getElementById('alerts-list');
const reportsList   = document.getElementById('reports-list');
const alertCount    = document.getElementById('alert-count');
const reportsCount  = document.getElementById('reports-count');
const alertsTs      = document.getElementById('alerts-ts');
const reportsTs     = document.getElementById('reports-ts');
const outlookTs     = document.getElementById('outlook-ts');
const toastContainer = document.getElementById('toast-container');
const utcClock      = document.getElementById('utc-clock');
const localClock    = document.getElementById('local-clock');
const refreshAlerts  = document.getElementById('refresh-alerts');
const refreshReports = document.getElementById('refresh-reports');
const radarBref      = document.getElementById('radar-bref');
const radarRvel      = document.getElementById('radar-rvel');

// ============================================================
// CLOCK
// ============================================================
function updateClock() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  utcClock.textContent  = `${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())} Z`;
  localClock.textContent = now.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) + ' LCL';
}
setInterval(updateClock, 1000);
updateClock();

// ============================================================
// SETTINGS PANEL
// ============================================================
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.remove('hidden');
  settingsOverlay.classList.remove('hidden');
});
settingsClose.addEventListener('click', closeSettings);
settingsOverlay.addEventListener('click', closeSettings);
function closeSettings() {
  settingsPanel.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
}

// Ping checkboxes
document.querySelectorAll('.ping-toggle').forEach(cb => {
  cb.addEventListener('change', () => {
    pingSettings[cb.dataset.type] = cb.checked;
    localStorage.setItem('pingSettings', JSON.stringify(pingSettings));
  });
});

// Load ping settings from storage
try {
  const saved = JSON.parse(localStorage.getItem('pingSettings') || '{}');
  Object.entries(saved).forEach(([k, v]) => {
    pingSettings[k] = v;
    const el = document.querySelector(`.ping-toggle[data-type="${k}"]`);
    if (el) el.checked = v;
  });
} catch(e) {}

// Compact mode
compactToggle.addEventListener('click', () => {
  isCompact = !isCompact;
  document.body.classList.toggle('compact', isCompact);
  compactToggle.classList.toggle('active', isCompact);
  document.getElementById('compact-icon').textContent = isCompact ? '⊞' : '⊡';
  if (radarMap) setTimeout(() => radarMap.invalidateSize(), 100);
});

// ============================================================
// ALERT TYPE DETECTION
// ============================================================
function classifyAlert(alert) {
  const ev = (alert.properties.event || '').toUpperCase();
  const desc = (alert.properties.description || '').toUpperCase();
  const params = alert.properties.parameters || {};
  const isPDS = (params.tornadoDetection?.includes('OBSERVED') ||
                 params.tornadoDetection?.includes('PDS') ||
                 desc.includes('THIS IS A PARTICULARLY DANGEROUS SITUATION') ||
                 desc.includes('PDS'));

  if (ev.includes('TORNADO WARNING')) {
    if (isPDS) return 'PDS';
    // Check for TOR+FFW-E
    if (ev.includes('FLASH FLOOD')) return 'TOR/FFW-E';
    return 'TOR';
  }
  if (ev.includes('FLASH FLOOD EMERGENCY')) return 'TOR/FFW-E';
  if (ev.includes('SEVERE THUNDERSTORM WARNING')) return 'SVR';
  if (ev.includes('FLASH FLOOD')) return 'FFW';
  if (ev.includes('SPECIAL WEATHER STATEMENT')) return 'SPS';
  if (ev.includes('TORNADO WATCH') || ev.includes('SEVERE THUNDERSTORM WATCH')) return 'MWS';
  return 'OTHER';
}

function alertFilterKey(type) {
  if (type === 'PDS' || type === 'TOR' || type === 'TOR/FFW-E') return 'TOR';
  if (type === 'SVR') return 'SVR';
  if (type === 'FFW') return 'FFW';
  if (type === 'SPS') return 'SPS';
  if (type === 'PDS') return 'PDS';
  return 'OTHER';
}

// ============================================================
// FETCH ALERTS
// ============================================================
async function fetchAlerts() {
  const btn = refreshAlerts;
  btn.classList.add('spinning');
  try {
    const res = await fetch(NWS_ALERTS_URL, {headers:{'User-Agent':'wxsitrep/1.0'}});
    const data = await res.json();
    const features = data.features || [];

    const newIds = new Set(features.map(f => f.properties.id));
    const brandNew = features.filter(f => !seenAlertIds.has(f.properties.id));

    allAlerts = features;
    allAlerts.forEach(f => seenAlertIds.add(f.properties.id));

    // Fire pings for new high-priority alerts
    brandNew.forEach(a => {
      const type = classifyAlert(a);
      if (pingSettings[type] || (type === 'TOR' && pingSettings['TOR'])) {
        triggerPing(type, a.properties.headline || a.properties.event);
      }
      if (type === 'PDS' && pingSettings['PDS']) {
        triggerPing('PDS', a.properties.headline || a.properties.event);
      }
    });

    renderAlerts();
    alertsTs.textContent = fmtTime(new Date());
    alertCount.textContent = allAlerts.length;
  } catch(e) {
    console.error('Alert fetch error', e);
    alertsList.innerHTML = `<div class="no-data">⚠ Failed to load alerts. Check console.</div>`;
  } finally {
    btn.classList.remove('spinning');
  }
}

function renderAlerts() {
  let filtered = allAlerts;
  if (alertFilter !== 'ALL') {
    filtered = allAlerts.filter(a => {
      const type = classifyAlert(a);
      if (alertFilter === 'PDS') return type === 'PDS';
      if (alertFilter === 'TOR') return type === 'TOR' || type === 'PDS' || type === 'TOR/FFW-E';
      if (alertFilter === 'SVR') return type === 'SVR';
      if (alertFilter === 'FFW') return type === 'FFW' || type === 'TOR/FFW-E';
      if (alertFilter === 'SPS') return type === 'SPS';
      return false;
    });
  }

  // Sort: PDS > TOR > SVR > FFW > rest
  const order = { 'PDS':0,'TOR/FFW-E':1,'TOR':2,'SVR':3,'FFW':4,'SPS':5,'MWS':6,'OTHER':7 };
  filtered.sort((a,b) => (order[classifyAlert(a)]||7) - (order[classifyAlert(b)]||7));

  if (!filtered.length) {
    alertsList.innerHTML = `<div class="no-data">NO ACTIVE ALERTS FOR THIS FILTER</div>`;
    return;
  }

  alertsList.innerHTML = filtered.map(a => {
    const p = a.properties;
    const type = classifyAlert(a);
    const expires = p.expires ? new Date(p.expires) : null;
    const sent    = p.sent    ? new Date(p.sent)    : null;
    const areas   = p.areaDesc || '';
    const headline = p.headline || p.event || 'Unknown Alert';
    const wfo = p.senderName || '';

    return `
    <div class="alert-item type-${type.replace('/','')}" data-id="${p.id}">
      <div class="alert-top">
        <span class="alert-badge badge-${type.replace('/','')}">${type}</span>
        <span class="alert-headline">${truncate(headline, 60)}</span>
      </div>
      <div class="alert-area">${truncate(areas, 80)}</div>
      <div class="alert-meta">
        <span>${wfo}</span>
        ${sent    ? `<span>Issued: ${fmtTime(sent)}</span>` : ''}
        ${expires ? `<span class="alert-expire">Expires: ${fmtTime(expires)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// Filter buttons - alerts
document.querySelectorAll('#alerts-panel .filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#alerts-panel .filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    alertFilter = btn.dataset.filter;
    renderAlerts();
  });
});
refreshAlerts.addEventListener('click', fetchAlerts);

// ============================================================
// FETCH STORM REPORTS (Iowa Mesonet LSR)
// ============================================================
async function fetchReports() {
  const btn = refreshReports;
  btn.classList.add('spinning');
  try {
    const res = await fetch(LSR_URL);
    const data = await res.json();
    allReports = data.features || [];
    renderReports();
    reportsTs.textContent = fmtTime(new Date());
    reportsCount.textContent = allReports.length;
  } catch(e) {
    console.error('Reports fetch error', e);
    reportsList.innerHTML = `<div class="no-data">⚠ Failed to load reports.</div>`;
  } finally {
    btn.classList.remove('spinning');
  }
}

function renderReports() {
  let filtered = allReports;
  const typeMap = { TORNADO:'TORNADO', HAIL:'HAIL', WIND:'WIND' };
  if (reportFilter !== 'ALL') {
    filtered = allReports.filter(r => {
      const t = (r.properties.type || r.properties.typetext || '').toUpperCase();
      if (reportFilter === 'TORNADO') return t.includes('TORNADO');
      if (reportFilter === 'HAIL')    return t.includes('HAIL');
      if (reportFilter === 'WIND')    return t.includes('WIND');
      return false;
    });
  }

  // Sort by time desc
  filtered.sort((a,b) => {
    const ta = new Date(a.properties.valid || 0);
    const tb = new Date(b.properties.valid || 0);
    return tb - ta;
  });

  if (!filtered.length) {
    reportsList.innerHTML = `<div class="no-data">NO REPORTS FOR THIS FILTER</div>`;
    return;
  }

  reportsList.innerHTML = filtered.slice(0, 200).map(r => {
    const p = r.properties;
    const rawType = (p.type || p.typetext || '').toUpperCase();
    let dispType = 'OTHER';
    let icon = '⚡';
    let magClass = '';
    let magStr = '';

    if (rawType.includes('TORNADO')) {
      dispType = 'TORNADO'; icon = '🌪️';
      const mag = p.magnitude || '';
      magStr = mag ? `EF${mag}` : 'TORNADO';
      magClass = 'tornado';
    } else if (rawType.includes('HAIL')) {
      dispType = 'HAIL'; icon = '🧊';
      const mag = parseFloat(p.magnitude || 0);
      magStr = mag ? `${mag}"` : 'HAIL';
      magClass = 'hail';
    } else if (rawType.includes('WIND') || rawType.includes('TSTM WND')) {
      dispType = 'WIND'; icon = '💨';
      const mag = p.magnitude || '';
      magStr = mag ? `${mag} MPH` : 'WIND';
      magClass = 'wind';
    } else {
      icon = '⚡'; magStr = p.magnitude || rawType;
    }

    const loc = p.city || p.county || '';
    const state = p.state || '';
    const wfo = p.wfo || '';
    const t = p.valid ? fmtTime(new Date(p.valid)) : '';
    const remark = p.remark || '';

    return `
    <div class="report-item type-${dispType}">
      <div class="report-top">
        <span class="report-icon">${icon}</span>
        <span class="report-type">${dispType}</span>
        <span class="report-magnitude ${magClass}">${magStr}</span>
      </div>
      <div class="report-location">${loc}${state ? ', ' + state : ''}</div>
      <div class="report-meta">${t}${wfo ? ' · ' + wfo : ''}${remark ? ' · ' + truncate(remark, 50) : ''}</div>
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
refreshReports.addEventListener('click', fetchReports);

// ============================================================
// SPC OUTLOOKS
// ============================================================
async function fetchOutlooks() {
  try {
    const [d1c, d2c, d3c, d1t, d2t, d3t] = await Promise.allSettled([
      fetchJSON(SPC_DAY1_URL), fetchJSON(SPC_DAY2_URL), fetchJSON(SPC_DAY3_URL),
      fetchJSON(SPC_D1TOR),    fetchJSON(SPC_D2TOR),    fetchJSON(SPC_D3TOR)
    ]);

    setOutlook('d1-cat-val', d1c.value, CAT_ORDER, 'spc-');
    setOutlook('d2-cat-val', d2c.value, CAT_ORDER, 'spc-');
    setOutlook('d3-cat-val', d3c.value, CAT_ORDER, 'spc-');
    setTorOutlook('d1-tor-val', d1t.value);
    setTorOutlook('d2-tor-val', d2t.value);
    setTorOutlook('d3-tor-val', d3t.value);

    outlookTs.textContent = fmtTime(new Date());
  } catch(e) {
    console.error('Outlook fetch error', e);
  }
}

function setOutlook(elId, data, order, prefix) {
  const el = document.getElementById(elId);
  if (!data || !data.features) { el.textContent = 'NONE'; el.className = 'outlook-value spc-NONE'; return; }
  const cats = data.features.map(f => (f.properties.LABEL2 || f.properties.LABEL || '').toUpperCase());
  let highest = 'NONE';
  for (const cat of order) {
    if (cats.some(c => c.includes(cat))) highest = cat;
  }
  el.textContent = highest;
  el.className = `outlook-value ${prefix}${highest}`;

  // Color the card left border
  const card = el.closest('.outlook-card');
  if (card) {
    const colors = { TSTM:'#55aa55',MRGL:'#55cc55',SLGT:'#ffff66',ENH:'#ff9900',MDT:'#ff3300',HIGH:'#ff00cc',NONE:'#1e2d3d' };
    card.style.setProperty('--card-color', colors[highest] || '#1e2d3d');
    card.querySelector('::before') || (card.style.borderLeft = `3px solid ${colors[highest] || '#1e2d3d'}`);
  }
}

function setTorOutlook(elId, data) {
  const el = document.getElementById(elId);
  if (!data || !data.features || !data.features.length) {
    el.textContent = 'NONE'; el.className = 'outlook-value spc-NONE'; return;
  }
  const probs = data.features.map(f => (f.properties.LABEL2 || f.properties.LABEL || '').replace('%','').trim());
  const hasSIGN = probs.some(p => p.toUpperCase().includes('SIGN'));
  const nums = probs.map(p => parseFloat(p)).filter(n => !isNaN(n));
  const maxNum = nums.length ? Math.max(...nums) : 0;

  if (hasSIGN) { el.textContent = 'SIGN'; el.className = 'outlook-value spc-SIGN'; }
  else if (maxNum >= 60) { el.textContent = '60%'; el.className = 'outlook-value spc-HIGH'; }
  else if (maxNum >= 45) { el.textContent = '45%'; el.className = 'outlook-value spc-HIGH'; }
  else if (maxNum >= 30) { el.textContent = '30%'; el.className = 'outlook-value spc-MDT'; }
  else if (maxNum >= 15) { el.textContent = '15%'; el.className = 'outlook-value spc-ENH'; }
  else if (maxNum >= 10) { el.textContent = '10%'; el.className = 'outlook-value spc-SLGT'; }
  else if (maxNum >= 5)  { el.textContent = '5%';  el.className = 'outlook-value spc-MRGL'; }
  else if (maxNum >= 2)  { el.textContent = '2%';  el.className = 'outlook-value spc-TSTM'; }
  else { el.textContent = 'NONE'; el.className = 'outlook-value spc-NONE'; }
}

async function fetchJSON(url) {
  const res = await fetch(url);
  return res.json();
}

// ============================================================
// LEAFLET RADAR MAP
// ============================================================
function initRadarMap() {
  const container = document.getElementById('radar-map');
  if (!container || !window.L) return;

  radarMap = L.map('radar-map', {
    center: [38.5, -96.5],
    zoom: 4,
    zoomControl: true,
    attributionControl: true,
  });

  // Dark basemap
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap contributors © CARTO',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(radarMap);

  // NEXRAD WMS from Iowa State
  radarLayer = L.tileLayer.wms(RADAR_BASE, {
    layers: 'nexrad-n0q-900913',
    format: 'image/png',
    transparent: true,
    opacity: 0.85,
    attribution: 'Iowa State Mesonet',
  }).addTo(radarMap);

  // Labels overlay
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19, pane: 'overlayPane',
  }).addTo(radarMap);

  // Auto-refresh radar every 2 min
  setInterval(() => {
    if (radarLayer) {
      radarLayer.setParams({ _t: Date.now() });
    }
  }, 120_000);
}

// Radar product toggle
radarBref.addEventListener('click', () => {
  radarBref.classList.add('active');
  radarRvel.classList.remove('active');
  if (radarLayer) {
    radarLayer.setUrl(RADAR_BASE);
    radarLayer.setParams({ layers: 'nexrad-n0q-900913', _t: Date.now() });
  }
});

radarRvel.addEventListener('click', () => {
  radarRvel.classList.add('active');
  radarBref.classList.remove('active');
  if (radarLayer) {
    radarLayer.setUrl(RADAR_VEL);
    radarLayer.setParams({ layers: 'nexrad-n0u-900913', _t: Date.now() });
  }
});

// ============================================================
// AUDIO PING
// ============================================================
function playPing(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = { PDS: [880, 1100, 880], TOR: [660, 880, 660], SVR: [440, 550], 'TOR/FFW-E': [880, 1320, 880] };
    const seq = freqs[type] || [440];
    let time = ctx.currentTime;
    seq.forEach(freq => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
      osc.start(time); osc.stop(time + 0.2);
      time += 0.25;
    });
  } catch(e) {}
}

function showToast(type, message) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<div class="toast-title">⚠ NEW ${type} ALERT</div><div class="toast-body">${truncate(message, 80)}</div>`;
  toastContainer.prepend(toast);
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 350);
  }, 8000);
}

function triggerPing(type, message) {
  playPing(type);
  showToast(type, message);
}

// ============================================================
// HELPERS
// ============================================================
function fmtTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) +
         ' ' + d.toLocaleDateString([], {month:'short', day:'numeric'});
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + '…' : str || '';
}

// ============================================================
// INIT + POLLING
// ============================================================
async function init() {
  initRadarMap();
  await Promise.allSettled([fetchAlerts(), fetchReports(), fetchOutlooks()]);

  setInterval(fetchAlerts,  REFRESH_ALERTS_MS);
  setInterval(fetchReports, REFRESH_REPORTS_MS);
  setInterval(fetchOutlooks, REFRESH_OUTLOOK_MS);
}

init();
