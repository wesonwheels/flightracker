// server.js — Wheels Relay (Render-ready)
// Endpoints:
//   GET  /stream            -> Server-Sent Events for your website
//   POST /ingest            -> MSFS sender posts JSON here (requires x-ingest-token)
//   GET  /simbrief/latest   -> Proxies SimBrief (username or userid) & returns selected fields
//
// Env vars (Render → Environment):
//   INGEST_TOKEN              = long random secret for /ingest
//   ORIGINS                   = comma separated site origins (e.g. https://wesonwheels.com,https://www.wesonwheels.com)
//   SIMBRIEF_CACHE_SECONDS    = optional, default 60
//   PORT                      = provided by Render (fallback 10000)

import express from "express";
import cors from "cors";
import fetch from "node-fetch"; // add "node-fetch": "^3" to dependencies

const app = express();
app.use(express.json());

// ---- CORS (lock to your site domains) ----
const ORIGINS = (process.env.ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = ORIGINS.includes("*")
  ? { origin: true } // allow all (for testing). Replace with exact origins for production.
  : {
      origin: (origin, cb) => {
        // Allow same-origin or no Origin (e.g., curl), and exact matches from ORIGINS.
        if (!origin || ORIGINS.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
    };

app.use(cors(corsOptions));

// ---- Live state & SSE clients ----
let clients = [];
let lastData = null;

// Optional heartbeat to keep connections alive on some hosts/proxies
const HEARTBEAT_MS = 25000;

// ---- SSE stream for the tracker ----
app.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders?.();

  // Send latest state immediately (so late joiners see something)
  if (lastData) res.write(`data: ${JSON.stringify(lastData)}\n\n`);

  // Heartbeat pings
  const iv = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { /* ignore */ }
  }, HEARTBEAT_MS);

  clients.push(res);
  req.on("close", () => {
    clearInterval(iv);
    clients = clients.filter(c => c !== res);
  });
});

// ---- Ingest from MSFS sender ----
app.post("/ingest", (req, res) => {
  const token = req.header("x-ingest-token");
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return res.status(401).json({ ok: false, error: "invalid token" });
  }

  // Attach server timestamp and broadcast
  lastData = { ...req.body, serverTs: Date.now() };
  const payload = `data: ${JSON.stringify(lastData)}\n\n`;
  for (const c of clients) {
    try { c.write(payload); } catch { /* ignore broken pipes */ }
  }

  res.json({ ok: true });
});

// ---- SimBrief proxy (latest OFP) ----
// Usage:  GET /simbrief/latest?username=YOUR_NAME
//     or: GET /simbrief/latest?userid=1234567
// Returns a trimmed "meta" object for the HUD.
const SB_TTL = Math.max(5, parseInt(process.env.SIMBRIEF_CACHE_SECONDS || "60", 10));
let sbCache = { key: "", t: 0, data: null };

app.get("/simbrief/latest", async (req, res) => {
  try {
    const { username, userid } = req.query;
    if (!username && !userid) {
      return res.status(400).json({ ok: false, error: "pass ?username= or ?userid=" });
    }
    const key = username ? `u:${username}` : `id:${userid}`;
    const url = userid
      ? `https://www.simbrief.com/api/xml.fetcher.php?userid=${encodeURIComponent(userid)}&json=1`
      : `https://www.simbrief.com/api/xml.fetcher.php?username=${encodeURIComponent(username)}&json=1`;

    // Cache by identity for SB_TTL seconds
    const fresh = (Date.now() - sbCache.t) / 1000 < SB_TTL && sbCache.key === key;
    if (!fresh) {
      const r = await fetch(url, { timeout: 10000 });
      if (!r.ok) throw new Error(`simbrief fetch failed (${r.status})`);
      const ofp = await r.json();
      sbCache = { key, t: Date.now(), data: ofp };
    }

    const ofp = sbCache.data || {};
    // Pick common fields defensively
    const meta = {
      flight_number:
        ofp?.general?.flight_number ||
        ofp?.general?.flightnum ||
        ofp?.general?.num ||
        null,
      callsign:
        (ofp?.general?.icao_airline && ofp?.general?.flight_number
          ? `${ofp.general.icao_airline}${ofp.general.flight_number}`
          : ofp?.general?.callsign) || null,
      airline_icao: ofp?.general?.icao_airline || null,
      aircraft_icao:
        ofp?.aircraft?.icaocode ||
        ofp?.aircraft?.icaotype ||
        ofp?.aircraft?.type ||
        null,
      origin:
        ofp?.origin?.icao_code ||
        ofp?.origin?.icao ||
        ofp?.origin?.code ||
        null,
      destination:
        ofp?.destination?.icao_code ||
        ofp?.destination?.icao ||
        ofp?.destination?.code ||
        null,
      route:
        ofp?.general?.route ||
        ofp?.ats?.route ||
        null,
      etd: ofp?.times?.sched_out || ofp?.times?.sched_off || null, // scheduled
      eta: ofp?.times?.est_on || ofp?.times?.est_in || null,       // estimated
      cruise:
        ofp?.profile?.initial_altitude ||
        ofp?.cruise?.fl ||
        null,
    };

    res.json({ ok: true, meta });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ---- Root/health ----
app.get("/", (_req, res) => {
  res.type("text/plain").send(
    [
      "Wheels Relay OK",
      "Endpoints:",
      "  GET  /stream",
      "  POST /ingest   (header: x-ingest-token)",
      "  GET  /simbrief/latest?username=NAME | ?userid=ID",
    ].join("\n")
  );
});

// ---- Start ----
const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Relay listening on :" + port));
