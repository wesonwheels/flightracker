// server.js (ESM) – Flight tracker backend with SimBrief planned route
// Run: node server.js
// Env: SIMBRIEF_USER=YourSimBriefUsername  PORT=3000

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware ---
app.set('trust proxy', true);
app.use(express.json());

// (Optional) tiny CORS for local dev; comment out if not needed
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// --- Health check ---
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// --- SimBrief planned route endpoint ---
// Returns: { line: <GeoJSON Feature LineString>, points: <FeatureCollection> }
let routeCache = { ts: 0, user: null, ofp_id: null, data: null };
const CACHE_MS = 60 * 1000; // 60s

app.get('/api/route', async (req, res) => {
  try {
    const user = (req.query.user || process.env.SIMBRIEF_USER || '').trim();
    const ofp_id = (req.query.ofp_id || '').trim(); // optional: specific OFP id

    if (!user) {
      return res.status(400).json({ error: 'Missing SimBrief user (?user= or SIMBRIEF_USER)' });
    }

    const now = Date.now();
    if (
      routeCache.data &&
      now - routeCache.ts < CACHE_MS &&
      routeCache.user === user &&
      routeCache.ofp_id === ofp_id
    ) {
      return res.json(routeCache.data);
    }

    // Build SimBrief URL
    // Docs: https://www.simbrief.com/api/xml.fetcher.php
    const params = new URLSearchParams({ username: user, json: '1' });
    if (ofp_id) params.set('ofp_id', ofp_id);
    const url = `https://www.simbrief.com/api/xml.fetcher.php?${params.toString()}`;

    const r = await fetch(url);
    if (!r.ok) throw new Error(`SimBrief fetch failed: HTTP ${r.status}`);
    const ofp = await r.json();

    // Extract route points. JSON structure can vary by OFP format.
    let points = [];
    if (Array.isArray(ofp?.general?.route_points)) {
      points = ofp.general.route_points.map(p => ({
        lat: parseFloat(p.lat),
        lon: parseFloat(p.lon),
        ident: p.ident || p.name || ''
      }));
    } else if (Array.isArray(ofp?.navlog?.fix)) {
      points = ofp.navlog.fix.map(f => ({
        lat: parseFloat(f.lat),
        lon: parseFloat(f.lon),
        ident: f.ident || f.name || ''
      }));
    }

    points = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!points.length) {
      return res.status(404).json({ error: 'No route points found in OFP' });
    }

    const dep = ofp?.origin?.icao_code || ofp?.origin?.iata_code || '';
    const arr = ofp?.destination?.icao_code || ofp?.destination?.iata_code || '';
    const callsign = ofp?.general?.icao_id || ofp?.general?.flight_number || '';
    const routeStr = ofp?.general?.route || ofp?.atc?.route || '';

    const feature = {
      type: 'Feature',
      properties: {
        source: 'SimBrief',
        user,
        callsign,
        dep,
        arr,
        route: routeStr,
        distance_nm:
          ofp?.general?.plan_routetotaldistance ||
          ofp?.general?.route_distance ||
          null,
        alt_cruise_ft:
          ofp?.general?.initial_altitude ||
          ofp?.general?.cruise_altitude ||
          null
      },
      geometry: {
        type: 'LineString',
        coordinates: points.map(p => [p.lon, p.lat])
      }
    };

    const pointsFC = {
      type: 'FeatureCollection',
      features: points.map(p => ({
        type: 'Feature',
        properties: { ident: p.ident },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] }
      }))
    };

    const payload = { line: feature, points: pointsFC };

    routeCache = { ts: now, user, ofp_id, data: payload };
    res.json(payload);
  } catch (err) {
    console.error('[SimBrief route] ', err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Static hosting ---
const PUBLIC_DIR = path.join(process.cwd(), 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', extensions: ['html'] }));
  // Optional SPA fallback to /public/index.html
  app.get('*', (req, res, next) => {
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      const idx = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(idx)) return res.sendFile(idx);
    }
    next();
  });
}

// --- Start server ---
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Tracker running on http://0.0.0.0:${PORT}`);
});
