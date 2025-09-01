// server.mjs — Wheels Relay (Node 18+, ESM, Render-ready)

import express from "express";
import fs from "node:fs";
import path from "node:path";

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 3000;
const INGEST_TOKEN = process.env.INGEST_TOKEN || "changeme-ingest-token";
const FALLBACK_ROUTE = process.env.FALLBACK_ROUTE === "1"; // optional

// ------------------------------------------------------------------
// Middleware (JSON + simple CORS)
// ------------------------------------------------------------------
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Ingest-Token"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ------------------------------------------------------------------
// Health
// ------------------------------------------------------------------
app.get("/", (_req, res) => res.type("text/plain").send("OK"));
app.get("/api/health", (_req, res) =>
  res.status(200).json({ ok: true, uptime: process.uptime() })
);

// ------------------------------------------------------------------
// Helpers (SimBrief parsing + math)
// ------------------------------------------------------------------
const META_CACHE_MS = 60_000;
const ROUTE_CACHE_MS = 60_000;
let metaCache = { ts: 0, key: "", data: null };
let routeCache = { ts: 0, key: "", data: null };

const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
};

const arrify = (v) => {
  // normalize SimBrief shapes: [], {point:[]}, {fix:[]}, {waypoint:[]}, single object
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (Array.isArray(v.point)) return v.point;
  if (Array.isArray(v.fix)) return v.fix;
  if (Array.isArray(v.waypoint)) return v.waypoint;
  if (Array.isArray(v.waypoints)) return v.waypoints;
  return [v];
};

const pickLat = (o) =>
  num(o?.lat) ??
  num(o?.latitude) ??
  num(o?.lat_deg) ??
  num(o?.pos_lat) ??
  num(o?.lat_dec);
const pickLon = (o) =>
  num(o?.lon) ??
  num(o?.lng) ??
  num(o?.long) ??
  num(o?.longitude) ??
  num(o?.pos_long) ??
  num(o?.lon_deg) ??
  num(o?.long_dec);

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// great-circle interpolation (returns [ [lon,lat], ... ])
function greatCircleLine(aLat, aLon, bLat, bLon, segments = 64) {
  const φ1 = toRad(aLat), λ1 = toRad(aLon);
  const φ2 = toRad(bLat), λ2 = toRad(bLon);
  const Δφ = φ2 - φ1;
  const Δλ = λ2 - λ1;
  const sinΔφ = Math.sin(Δφ / 2);
  const sinΔλ = Math.sin(Δλ / 2);
  const d = 2 * Math.asin(
    Math.sqrt(sinΔφ * sinΔφ + Math.cos(φ1) * Math.cos(φ2) * sinΔλ * sinΔλ)
  );
  if (d === 0) return [[aLon, aLat], [bLon, bLat]];

  const coords = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const φ = Math.atan2(z, Math.sqrt(x * x + y * y));
    const λ = Math.atan2(y, x);
    coords.push([toDeg(λ), toDeg(φ)]);
  }
  return coords;
}

function findAirportLatLon(node) {
  if (!node) return null;
  const lat =
    pickLat(node) ?? pickLat(node.position) ?? pickLat(node.pos) ?? null;
  const lon =
    pickLon(node) ?? pickLon(node.position) ?? pickLon(node.pos) ?? null;
  if (lat != null && lon != null) return [lat, lon];
  return null;
}

// ------------------------------------------------------------------
// SimBrief: latest meta
//   /simbrief/latest?username=NAME  or  ?userid=12345
// ------------------------------------------------------------------
app.get("/simbrief/latest", async (req, res) => {
  try {
    const username = (req.query.username || "").toString().trim();
    const userid = (req.query.userid || "").toString().trim();
    if (!username && !userid && !process.env.SIMBRIEF_USER) {
      return res
        .status(400)
        .json({ ok: false, error: "Provide username= or userid= (or set SIMBRIEF_USER)" });
    }

    const key = username
      ? `u:${username}`
      : userid
      ? `id:${userid}`
      : `u:${process.env.SIMBRIEF_USER}`;

    const now = Date.now();
    if (metaCache.data && metaCache.key === key && now - metaCache.ts < META_CACHE_MS) {
      return res.json(metaCache.data);
    }

    const qs = new URLSearchParams({ json: "1" });
    if (username) qs.set("username", username);
    else if (userid) qs.set("userid", userid);
    else qs.set("username", process.env.SIMBRIEF_USER);

    const url = `https://www.simbrief.com/api/xml.fetcher.php?${qs.toString()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SimBrief fetch failed: HTTP ${r.status}`);
    const ofp = await r.json();

    const payload = {
      ok: true,
      meta: {
        callsign:
          ofp?.general?.icao_id ||
          ofp?.general?.callsign ||
          ofp?.general?.flight_number ||
          null,
        flight_number: ofp?.general?.flight_number || null,
        origin: ofp?.origin?.icao_code || ofp?.origin?.iata_code || null,
        destination: ofp?.destination?.icao_code || ofp?.destination?.iata_code || null,
        aircraft_icao: ofp?.aircraft?.icaocode || ofp?.aircraft?.icao_type || null,
        reg: ofp?.aircraft?.reg || null,
        etd: ofp?.times?.sched_out || ofp?.times?.est_out || null,
        eta: ofp?.times?.sched_in || ofp?.times?.est_in || null,
        cruise_alt_ft:
          ofp?.general?.initial_altitude || ofp?.general?.cruise_altitude || null,
        route_text: ofp?.general?.route || ofp?.atc?.route || null,
        distance_nm:
          ofp?.general?.plan_routetotaldistance || ofp?.general?.route_distance || null,
      },
    };

    metaCache = { ts: now, key, data: payload };
    res.json(payload);
  } catch (err) {
    console.error("[/simbrief/latest]", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// ------------------------------------------------------------------
// SimBrief: planned route (GeoJSON)
//   /api/route?user=NAME  or  ?userid=12345
//   Robust parsing for route points; optional GC fallback
// ------------------------------------------------------------------
app.get("/api/route", async (req, res) => {
  try {
    const user = (req.query.user || process.env.SIMBRIEF_USER || "").toString().trim();
    const userid = (req.query.userid || "").toString().trim();
    if (!user && !userid) {
      return res.status(400).json({ error: "Missing SimBrief user (?user= or ?userid= or SIMBRIEF_USER)" });
    }

    const key = userid ? `id:${userid}` : `u:${user}`;
    const now = Date.now();
    if (routeCache.data && routeCache.key === key && now - routeCache.ts < ROUTE_CACHE_MS) {
      return res.json(routeCache.data);
    }

    const qs = new URLSearchParams({ json: "1" });
    if (userid) qs.set("userid", userid);
    else qs.set("username", user);

    const url = `https://www.simbrief.com/api/xml.fetcher.php?${qs.toString()}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`SimBrief fetch failed: HTTP ${r.status}`);
    const ofp = await r.json();

    // collect possible waypoint arrays
    const candidates = [
      ofp?.general?.route_points,
      ofp?.general?.routepoints,
      ofp?.navlog?.fix,
      ofp?.navlog?.waypoint,
      ofp?.navlog?.waypoints,
    ].flatMap(arrify);

    let points = [];
    for (const p of candidates) {
      const lat = pickLat(p);
      const lon = pickLon(p);
      if (lat != null && lon != null) {
        points.push({ lat, lon, ident: p.ident || p.name || p.wpt || "" });
      }
    }

    // Build GeoJSON if we found points
    if (points.length) {
      const line = {
        type: "Feature",
        properties: {
          source: "SimBrief",
          user: user || null,
          userid: userid || null,
          callsign:
            ofp?.general?.icao_id ||
            ofp?.general?.callsign ||
            ofp?.general?.flight_number ||
            "",
          dep: ofp?.origin?.icao_code || ofp?.origin?.iata_code || "",
          arr: ofp?.destination?.icao_code || ofp?.destination?.iata_code || "",
          route: ofp?.general?.route || ofp?.atc?.route || "",
          distance_nm:
            ofp?.general?.plan_routetotaldistance || ofp?.general?.route_distance || null,
          alt_cruise_ft:
            ofp?.general?.initial_altitude || ofp?.general?.cruise_altitude || null,
        },
        geometry: {
          type: "LineString",
          coordinates: points.map((p) => [p.lon, p.lat]),
        },
      };

      const pointsFC = {
        type: "FeatureCollection",
        features: points.map((p) => ({
          type: "Feature",
          properties: { ident: p.ident },
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        })),
      };

      const payload = { line, points: pointsFC };
      routeCache = { ts: now, key, data: payload };
      return res.json(payload);
    }

    // Optional fallback: great-circle using origin/destination lat/lon if present
    if (FALLBACK_ROUTE) {
      const depLL = findAirportLatLon(ofp?.origin);
      const arrLL = findAirportLatLon(ofp?.destination);
      if (depLL && arrLL) {
        const coords = greatCircleLine(depLL[0], depLL[1], arrLL[0], arrLL[1], 64);
        const line = {
          type: "Feature",
          properties: {
            source: "Fallback",
            dep: ofp?.origin?.icao_code || "",
            arr: ofp?.destination?.icao_code || "",
          },
          geometry: { type: "LineString", coordinates: coords },
        };
        const pointsFC = {
          type: "FeatureCollection",
          features: [
            { type: "Feature", properties: { ident: "DEP" }, geometry: { type: "Point", coordinates: [coords[0][0], coords[0][1]] } },
            { type: "Feature", properties: { ident: "ARR" }, geometry: { type: "Point", coordinates: [coords.at(-1)[0], coords.at(-1)[1]] } },
          ],
        };
        const payload = { line, points: pointsFC };
        routeCache = { ts: now, key, data: payload };
        return res.json(payload);
      }
    }

    return res.status(404).json({ error: "No route points found in OFP" });
  } catch (err) {
    console.error("[/api/route]", err);
    res.status(500).json({ error: String(err) });
  }
});

// ------------------------------------------------------------------
// Live telemetry: /ingest + /stream (per-flight)
// ------------------------------------------------------------------
const liveData = new Map(); // flight -> last datum

// POST /ingest?flight=WHEELS735
app.post("/ingest", (req, res) => {
  const flight = (req.query.flight || "default").toString();
  const token = req.header("X-Ingest-Token");
  if (token !== INGEST_TOKEN) return res.status(403).json({ error: "Forbidden" });

  const d = req.body || {};
  if (typeof d.lat !== "number" || typeof d.lon !== "number") {
    return res.status(400).json({ error: "lat/lon required (numbers)" });
  }

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

// GET /stream?flight=WHEELS735
app.get("/stream", (req, res) => {
  const flight = (req.query.flight || "default").toString();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  // send immediately if we have data
  const now = liveData.get(flight);
  if (now) res.write(`data: ${JSON.stringify(now)}\n\n`);

  // keepalive + repeat latest every second
  const t = setInterval(() => {
    const d = liveData.get(flight);
    if (d) res.write(`data: ${JSON.stringify(d)}\n\n`);
    else res.write(`: ping\n\n`);
  }, 1000);

  req.on("close", () => clearInterval(t));
});

// ------------------------------------------------------------------
// Optional static hosting (serve ./public if present)
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Wheels Relay running on http://0.0.0.0:${PORT}`);
});
