# WX SITREP — Severe Weather Situational Awareness

A real-time severe weather dashboard styled in a dark tactical radar-room aesthetic. Designed to be deployed on GitHub Pages with a Cloudflare custom domain.

## Features

- **Active Alerts** — Live NWS alerts (PDS, TOR, SVR, FFW, SPS, watches) color-coded by severity
- **Storm Reports** — Iowa State Mesonet LSR feed (tornadoes, hail, wind) for the last 12 hours
- **SPC Outlooks** — Day 1/2/3 highest categorical and tornado probabilities
- **Live Radar Mosaic** — Iowa State RIDGE2 NEXRAD WMS via Leaflet (reflectivity + velocity toggle)
- **Audio + Visual Pings** — Enable notifications per alert type (PDS, TOR, SVR, TOR/FFW-E)
- **Compact Mode** — Fits everything on one widescreen monitor without scrolling
- **UTC + Local Clock** — Always visible in the header

## Data Sources

| Source | URL |
|--------|-----|
| NWS Active Alerts | `api.weather.gov` |
| SPC Day 1/2/3 Outlooks | `spc.noaa.gov` |
| Storm Reports (LSR) | `mesonet.agron.iastate.edu` |
| NEXRAD Radar WMS | `mesonet.agron.iastate.edu` |

All data is fetched client-side — no backend required.

## Deployment

### GitHub Pages

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Set source to **Deploy from branch → main / root**
4. Your site will be live at `https://<username>.github.io/<repo>/`

### Cloudflare Custom Domain

1. In GitHub Pages settings, set your custom domain (e.g. `wx.yourdomain.com`)
2. In Cloudflare DNS, add a **CNAME** record:
   - Name: `wx` (or `@` for apex)
   - Target: `<username>.github.io`
   - Proxy: ✅ Proxied (orange cloud)
3. Enable **Full (strict)** SSL in Cloudflare → SSL/TLS
4. Enable **Always Use HTTPS** and **Auto Minify** (optional)
5. GitHub will auto-provision an SSL cert via Let's Encrypt

### Cloudflare Page Rules (optional but recommended)

- Cache everything: `wx.yourdomain.com/*` → Cache Level: Cache Everything, Edge Cache TTL: 2 hours
- The HTML/JS/CSS is static; all data is fetched live from APIs.

## File Structure

```
├── index.html        # Main page
├── css/
│   └── style.css     # All styles
├── js/
│   └── app.js        # Data fetching, rendering, radar, pings
└── README.md
```

## Refresh Intervals

| Data | Interval |
|------|----------|
| Active Alerts | 60 seconds |
| Storm Reports | 2 minutes |
| SPC Outlooks | 5 minutes |
| Radar | 2 minutes (auto) |

## Alert Types

| Badge | Color | Meaning |
|-------|-------|---------|
| PDS | Magenta | Particularly Dangerous Situation Tornado Warning |
| TOR | Red | Tornado Warning |
| SVR | Yellow | Severe Thunderstorm Warning |
| FFW | Green | Flash Flood Warning/Emergency |
| TOR/FFW-E | Orange | Tornado + Flash Flood Emergency |
| SPS | Blue | Special Weather Statement |

## Ping Sounds

Enable per-type audio alerts in the ⚙ Settings panel. Each type plays a distinct tone sequence when a new alert matching that type appears. Requires user interaction before audio context can activate (browser security requirement).

## Notes

- Data is for **situational awareness only** — always follow official NWS guidance.
- SPC outlook parsing extracts the **highest** category/probability present anywhere in the contiguous US on that day.
- CORS: All APIs used are public and CORS-enabled. No proxy needed.
