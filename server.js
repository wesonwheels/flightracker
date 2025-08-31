// server.js (ESM) — Render-ready API for Wheels Tracker
// Env on Render: SIMBRIEF_USER=YourSimBriefUsername  PORT=3000
// Start: node server.js

import express from "express";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;

// --- Basic middleware ---
app.set("trust proxy", true);
app.use(express.json());

// CORS (allow PebbleHost frontend to call this API)
app.use((req, res, next) => {
  // Tighten later: set this to 'https://yourdomain.com'
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// --- Root & Health check ---
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/api/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ============================
//   SimBrief planned route
//   GET /api/route
//   GET /api/route?user=NAME
//   GET /api/route?ofp_id=123456
// ============================
let routeCache = { ts: 0, user: null, ofp_id: null, data: null };
const CACHE_MS = 60 * 1000; // 60s cache

app.get("/api/route", async (req, res) => {
  try {
    const user = (req.query.user || process.env.SIMBRIEF_USER || "").trim();
    const ofp_id = (req.query.ofp_id || "").trim();
    if (!user) return res.status(400).json({ error: "Missing SimBrief user (?user= or SIMBRIEF_USER)" });

    const now = Date.now();
    if (routeCache.data && now - routeCache.ts < CACHE_MS &&
        routeCache.user === user && routeCache.ofp_id === ofp_id) {
      return res.json(routeCache.data);
    }

    const params = new URLSearchParams({ username: user, json: "1" });
    if (ofp_id) params.set("ofp_id", ofp_id);
    const url = `https://www.simbrief.com/api/xml.fetcher.php?${params.toString()}`;

    const r = await fetch(url);
    if (!r.ok) throw new Error(`SimBrief fetch failed: HTTP ${r.status}`);
    const ofp = await r.json();

    let points = [];
    if (Array.isArray(ofp?.general?.route_points)) {
      points = ofp.general.route_points.map(p => ({
        lat: parseFloat(p.lat),
        lon: parseFloat(p.lon),
        ident: p.ident || p.name || ""
      }));
    } else if (Array.isArray(ofp?.navlog?.fix)) {
      points = ofp.navlog.fix.map(f => ({
        lat: parseFloat(f.lat),
        lon: parseFloat(f.lon),
        ident: f.ident || f.name || ""
      }));
    }
    points = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!points.length) return res.status(404).json({ error: "No route points found in OFP" });

    const dep = ofp?.origin?.icao_code || ofp?.origin?.iata_code || "";
    const arr = ofp?.destination?.icao_code || ofp?.destination?.iata_code || "";
    const callsign = ofp?.general?.icao_id || ofp?.general?.flight_number || "";
    const routeStr = ofp?.general?.route || ofp?.atc?.route || "";

    const line = {
      type: "Feature",
      properties: {
        source: "SimBrief",
        user,
        callsign,
        dep,
        arr,
        route: routeStr,
        distance_nm: ofp?.general?.plan_routetotaldistance || ofp?.general?.route_distance || null,
        alt_cruise_ft: ofp?.general?.initial_altitude || ofp?.general?.cruise_altitude || null
      },
      geometry: { type: "LineString", coordinates: points.map(p => [p.lon, p.lat]) }
    };

    const pointsFC = {
      type: "FeatureCollection",
      features: points.map(p => ({
        type: "Feature",
        properties: { ident: p.ident },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] }
      }))
    };

    const payload = { line, points: pointsFC };
    routeCache = { ts: Date.now(), user, ofp_id, data: payload };
    res.json(payload);
  } catch (err) {
    console.error("[/api/route] ", err);
    res.status(500).json({ error: String(err) });
  }
});

// ============================
//   SimBrief latest meta proxy
//   GET /simbrief/latest?username=NAME
//   GET /simbrief/latest?userid=1234567
//   Returns: { ok, meta: {...} }
// ============================
let metaCache = { ts: 0, key: "", data: null };
const META_CACHE_MS = 60 * 1000;

app.get("/simbrief/latest", async (req, res) => {
  try {
    const username = (req.query.username || "").trim();
    const userid = (req.query.userid || "").trim();
    if (!username && !userid && !process.env.SIMBRIEF_USER) {
      return res.status(400).json({ ok: false, error: "Provide username= or userid= (or set SIMBRIEF_USER)" });
    }

    const key = username ? `u:${username}` : (userid ? `id:${userid}` : `u:${process.env.SIMBRIEF_USER}`);
    const now = Date.now();
    if (metaCache.data && metaCache.key === key && (now - metaCache.ts < META_CACHE_MS)) {
      return res.json(metaCache.data);
    }

    const params = new URLSearchParams({ json: "1" });
    if (username) params.set("username", username);
    else if (userid) params.set("userid", userid);
    else params.set("username", process.env.SIMBRIEF_USER);

    const url = `https://www.simbrief.com/api/xml.fetcher.php?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SimBrief fetch failed: HTTP ${r.status}`);
    const ofp = await r.json();

    const meta = {
      callsign: ofp?.general?.icao_id || ofp?.general?.flight_number || null,
      flight_number: ofp?.general?.flight_number || null,
      origin: ofp?.origin?.icao_code || ofp?.origin?.iata_code || null,
      destination: ofp?.destination?.icao_code || ofp?.destination?.iata_code || null,
      aircraft_icao: ofp?.aircraft?.icaocode || ofp?.aircraft?.icao_type || null,
      reg: ofp?.aircraft?.reg || null,
      etd: ofp?.times?.sched_out || ofp?.times?.est_out || null,
      eta: ofp?.times?.sched_in || ofp?.times?.est_in || null,
      cruise_alt_ft: ofp?.general?.initial_altitude || ofp?.general?.cruise_altitude || null,
      route_text: ofp?.general?.route || ofp?.atc?.route || null,
      distance_nm: ofp?.general?.plan_routetotaldistance || ofp?.general?.route_distance || null
    };

    const payload = { ok: true, meta };
    metaCache = { ts: now, key, data: payload };
    res.json(payload);
  } catch (err) {
    console.error("[/simbrief/latest] ", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ============================
//   Live telemetry stream (SSE)
//   GET /stream?flight=NAME
//   Sends NDJSON over SSE (1 msg/sec) — stubbed motion
//   Replace with real sim telemetry later.
// ============================
app.get("/stream", (req, res) => {
  // Headers for SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Use query to select different flights if needed
  const flight = (req.query.flight || "default").toString();

  // Simple demo track near DFW drifting east
  let lat = 33.0 + Math.random() * 0.4;  // 33.0–33.4
  let lon = -97.4 + Math.random() * 0.4; // -97.4–-97.0
  let alt = 10000 + Math.random() * 2000;
  let hdg = 90;

  const tick = () => {
    // Move the point a little
    lon += 0.01;
    const climb = (Math.random() - 0.5) * 200; // +/-100 fpm drift
    alt += climb;

    const d = {
      flight,
      lat: Number(lat),
      lon: Number(lon),
      alt_ft: Math.max(0, Math.round(alt)),
      hdg_deg: Math.round(hdg),
      gs_kts: 350,
      vs_fpm: Math.round(climb * 3), // arbitrary
      tas_kts: 360,
      serverTs: Date.now()
    };

    res.write(`data: ${JSON.stringify(d)}\n\n`);
  };

  const timer = setInterval(tick, 1000);
  req.on("close", () => clearInterval(timer));
});

// --- Static hosting (optional; harmless if you don't have a /public) ---
const PUBLIC_DIR = path.join(process.cwd(), "public");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { maxAge: "1h", extensions: ["html"] }));
  // SPA fallback// server.js — Wheels Tracker Backend (ESM)
// Start: node server.js
// Env: SIMBRIEF_USER=YourSimBriefUsername, INGEST_TOKEN=yourLongRandomToken, PORT=3000

import express from "express";
import fs from "node:fs";
import path from "node:path";

const app = express();
const PORT = process.env.PORT || 3000;

// ------------ Middleware / CORS ------------
app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));
app.use((req, res, next) => {
  // Tighten later to your PebbleHost origin if you want
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Ingest-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ------------ Root & Health ------------
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/api/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ===================================================
//                 SimBrief: Planned Route
//   GET /api/route
//   GET /api/route?user=NAME
//   GET /api/route?ofp_id=########
// ===================================================
let routeCache = { ts: 0, user: "", ofp_id: "", data: null };
const ROUTE_CACHE_MS = 60 * 1000;

app.get("/api/route", async (req, res) => {
  try {
    const user = (req.query.user || process.env.SIMBRIEF_USER || "").toString().trim();
    const ofp_id = (req.query.ofp_id || "").toString().trim();
    if (!user) return res.status(400).json({ error: "Missing SimBrief user (?user= or SIMBRIEF_USER)" });

    const now = Date.now();
    if (routeCache.data && now - routeCache.ts < ROUTE_CACHE_MS &&
        routeCache.user === user && routeCache.ofp_id === ofp_id) {
      return res.json(routeCache.data);
    }

    const params = new URLSearchParams({ username: user, json: "1" });
    if (ofp_id) params.set("ofp_id", ofp_id);
    const url = `https://www.simbrief.com/api/xml.fetcher.php?${params.toString()}`;

    const r = await fetch(url);
    if (!r.ok) throw new Error(`SimBrief fetch failed: HTTP ${r.status}`);
    const ofp = await r.json();

    // Route points can appear in different places depending on OFP format
    let points = [];
    if (Array.isArray(ofp?.general?.route_points)) {
      points = ofp.general.route_points.map(p => ({
        lat: parseFloat(p.lat), lon: parseFloat(p.lon), ident: p.ident || p.name || ""
      }));
    } else if (Array.isArray(ofp?.navlog?.fix)) {
      points = ofp.navlog.fix.map(f => ({
        lat: parseFloat(f.lat), lon: parseFloat(f.lon), ident: f.ident || f.name || ""
      }));
    }
    points = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (!points.length) return res.status(404).json({ error: "No route points found in OFP" });

    const dep = ofp?.origin?.icao_code || ofp?.origin?.iata_code || "";
    const arr = ofp?.destination?.icao_code || ofp?.destination?.iata_code || "";
    const callsign = ofp?.general?.icao_id || ofp?.general?.flight_number || "";
    const routeStr = ofp?.general?.route || ofp?.atc?.route || "";

    const line = {
      type: "Feature",
      properties: {
        source: "SimBrief",
        user, callsign, dep, arr, route: routeStr,
        distance_nm: ofp?.general?.plan_routetotaldistance || ofp?.general?.route_distance || null,
        alt_cruise_ft: ofp?.general?.initial_altitude || ofp?.general?.cruise_altitude || null
      },
      geometry: { type: "LineString", coordinates: points.map(p => [p.lon, p.lat]) }
    };

    const pointsFC = {
      type: "FeatureCollection",
      features: points.map(p => ({
        type: "Feature",
        properties: { ident: p.ident },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] }
      }))
    };

    const payload = { line, points: pointsFC };
    routeCache = { ts: now, user, ofp_id, data: payload };
    res.json(payload);
  } catch (err) {
    console.error("[/api/route]", err);
    res.status(500).json({ error: String(err) });
  }
});

// ===================================================
//                 SimBrief: Latest Meta
//   GET /simbrief/latest?username=... | ?userid=...
//   Returns { ok, meta: {...} }
// ===================================================
let metaCache = { ts: 0, key: "", data: null };
const META_CACHE_MS = 60 * 1000;

app.get("/simbrief/latest", async (req, res) => {
  try {
    const username = (req.query.username || "").toString().trim();
    const userid = (req.query.userid || "").toString().trim();
    if (!username && !userid && !process.env.SIMBRIEF_USER) {
      return res.status(400).json({ ok: false, error: "Provide username= or userid= (or set SIMBRIEF_USER)" });
    }

    const key = username ? `u:${username}` : (userid ? `id:${userid}` : `u:${process.env.SIMBRIEF_USER}`);
    const now = Date.now();
    if (metaCache.data && metaCache.key === key && now - metaCache.ts < META_CACHE_MS) {
      return res.json(metaCache.data);
    }

    const params = new URLSearchParams({ json: "1" });
    if (username) params.set("username", username);
    else if (userid) params.set("userid", userid);
    else params.set("username", process.env.SIMBRIEF_USER);

    const url = `https://www.simbrief.com/api/xml.fetcher.php?${params.toString()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SimBrief fetch failed: HTTP ${r.status}`);
    const ofp = await r.json();

    const meta = {
      callsign: ofp?.general?.icao_id || ofp?.general?.flight_number || null,
      flight_number: ofp?.general?.flight_number || null,
      origin: ofp?.origin?.icao_code || ofp?.origin?.iata_code || null,
      destination: ofp?.destination?.icao_code || ofp?.destination?.iata_code || null,
      aircraft_icao: ofp?.aircraft?.icaocode || ofp?.aircraft?.icao_type || null,
      reg: ofp?.aircraft?.reg || null,
      etd: ofp?.times?.sched_out || ofp?.times?.est_out || null,
      eta: ofp?.times?.sched_in || ofp?.times?.est_in || null,
      cruise_alt_ft: ofp?.general?.initial_altitude || ofp?.general?.cruise_altitude || null,
      route_text: ofp?.general?.route || ofp?.atc?.route || null,
      distance_nm: ofp?.general?.plan_routetotaldistance || ofp?.general?.route_distance || null
    };

    const payload = { ok: true, meta };
    metaCache = { ts: now, key, data: payload };
    res.json(payload);
  } catch (err) {
    console.error("[/simbrief/latest]", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ===================================================
//          Live Telemetry: Ingest + Stream
//   POST /ingest?flight=NAME   (from your PC)
//      headers: X-Ingest-Token: <token>
//      body: { lat, lon, alt_ft, hdg_deg, gs_kts, vs_fpm, tas_kts, serverTs? }
//   GET /stream?flight=NAME    (to browser)
// ===================================================
const INGEST_TOKEN = process.env.INGEST_TOKEN || "changeme-ingest-token";
const liveData = new Map(); // flight -> latest datum

app.post("/ingest", (req, res) => {
  const flight = (req.query.flight || "default").toString();
  const token = req.header("X-Ingest-Token");

  if (token !== INGEST_TOKEN) return res.status(403).json({ error: "Forbidden" });

  const d = req.body || {};
  if (typeof d.lat !== "number" || typeof d.lon !== "number") {
    return res.status(400).json({ error: "lat/lon required (numbers)" });
  }
  // normalize + stamp
  const datum = {
    flight,
    lat: Number(d.lat),
    lon: Number(d.lon),
    alt_ft: Number(d.alt_ft || 0),
    hdg_deg: Number(d.hdg_deg || 0),
    gs_kts: Number(d.gs_kts || 0),
    vs_fpm: Number(d.vs_fpm || 0),
    tas_kts: Number(d.tas_kts || 0),
    serverTs: Number(d.serverTs || Date.now()),
  };
  liveData.set(flight, datum);
  res.json({ ok: true });
});

app.get("/stream", (req, res) => {
  const flight = (req.query.flight || "default").toString();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // Immediately send latest point (if any)
  const now = liveData.get(flight);
  if (now) res.write(`data: ${JSON.stringify(now)}\n\n`);

  const timer = setInterval(() => {
    const d = liveData.get(flight);
    if (d) res.write(`data: ${JSON.stringify(d)}\n\n`);
  }, 1000);

  req.on("close", () => clearInterval(timer));
});

// ------------ Optional static hosting ------------
const PUBLIC_DIR = path.join(process.cwd(), "public");
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { maxAge: "1h", extensions: ["html"] }));
  app.get("*", (req, res, next) => {
    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      const idx = path.join(PUBLIC_DIR, "index.html");
      if (fs.existsSync(idx)) return res.sendFile(idx);
    }
    next();
  });
}

// ------------ Start ------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Wheels Tracker API on http://0.0.0.0:${PORT}`);
});

  app.get("*", (req, res, next) => {
    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      const idx = path.join(PUBLIC_DIR, "index.html");
      if (fs.existsSync(idx)) return res.sendFile(idx);
    }
    next();
  });
}

// --- Start server ---
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Tracker API running on http://0.0.0.0:${PORT}`);
});
