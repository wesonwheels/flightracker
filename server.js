// server.js — Wheels Relay (ESM)
// Works on Render at any subdomain (including flightracker-6mit). Provides:
//   POST /ingest?flight=ID     (header: X-Ingest-Token)
//   GET  /stream?flight=ID     (SSE; replays last point; keepalives)
//   GET  /simbrief/latest?...  (optional mini-proxy)
//   GET  /                     (OK)
//
// Package.json (for Render):
// {
//   "name": "wheels-relay",
//   "private": true,
//   "type": "module",
//   "engines": { "node": ">=18" },
//   "dependencies": { "express": "^4.19.2", "cors": "^2.8.5" },
//   "scripts": { "start": "node server.js" }
// }

import express from "express";
import cors from "cors";

// ===== Config =====
const PORT = process.env.PORT || 3000;
const INGEST_TOKEN = process.env.INGEST_TOKEN || "449a6c2b8a4361a5f5c6058ad56c4a1e";
const KEEPALIVE_MS = 25000; // SSE ping interval

// ===== App =====
const app = express();
app.set("trust proxy", true);
app.use(cors({ origin: "*" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Ingest-Token");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});
app.use(express.json({ limit: "256kb" }));

// ===== State =====
/** @type {Map<string, Set<import("http").ServerResponse>>} */
const clientsByFlight = new Map();
/** @type {Map<string, any>} */
const latestByFlight = new Map();

function getClients(flt) {
  if (!clientsByFlight.has(flt)) clientsByFlight.set(flt, new Set());
  return clientsByFlight.get(flt);
}

function writeSSE(res, eventName, payload) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function keepAlive(res) { res.write(`: ok\n: keepalive\n\n`); }

// ===== Routes =====
app.options("/ingest", (_, res) => res.sendStatus(204));
app.options("/stream", (_, res) => res.sendStatus(204));
app.options("/simbrief/latest", (_, res) => res.sendStatus(204));

app.get("/", (_req, res) => res.type("text/plain").send("OK"));

// SSE stream per flight
app.get("/stream", (req, res) => {
  const flight = String(req.query.flight || "default");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const clients = getClients(flight);
  clients.add(res);

  // Cleanup
  req.on("close", () => {
    clients.delete(res);
  });

  // Replay last
  const last = latestByFlight.get(flight);
  if (last) writeSSE(res, null, last);

  // Keepalive pings
  const iv = setInterval(() => {
    if (res.writableEnded) return clearInterval(iv);
    try { keepAlive(res); } catch { clearInterval(iv); }
  }, KEEPALIVE_MS);
});

// Ingest points from MSFS client
app.post("/ingest", (req, res) => {
  const token = req.get("X-Ingest-Token") || req.get("x-ingest-token");
  if (!token || token !== INGEST_TOKEN) return res.sendStatus(401);

  const now = Date.now();
  const flight = String(req.query.flight || req.body?.flight || "default");

  const point = {
    ...req.body,
    flight,
    serverTs: req.body?.serverTs ?? now,
  };

  latestByFlight.set(flight, point);

  const clients = getClients(flight);
  const payload = JSON.stringify(point);
  for (const r of clients) {
    try { r.write(`data: ${payload}\n\n`); } catch { /* ignore broken pipes */ }
  }

  return res.sendStatus(204);
});

// Optional: SimBrief proxy (very light XML scrape)
// /simbrief/latest?username=NAME  or  /simbrief/latest?userid=1234567
app.get("/simbrief/latest", async (req, res) => {
  try {
    const { username, userid } = req.query;
    if (!username && !userid) return res.json({ ok: false, error: "missing username or userid" });
    const qs = username ? `username=${encodeURIComponent(username)}` : `userid=${encodeURIComponent(userid)}`;
    const url = `https://www.simbrief.com/api/xml.fetcher.php?${qs}`;
    const r = await fetch(url, { headers: { "User-Agent": "WheelsRelay/1.0" } });
    const xml = await r.text();

    const pick = (tag) => (xml.match(new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, "i"))||[])[1] || undefined;
    const meta = {
      flight_number: pick("flight_number") || pick("callsign"),
      callsign: pick("callsign"),
      origin: pick("origin"),
      destination: pick("destination"),
      aircraft_icao: pick("aircraft_icao") || pick("aircraft_type"),
      etd: pick("etd"),
      eta: pick("eta"),
    };
    res.json({ ok: true, meta });
  } catch (e) {
    res.json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`[WheelsRelay] Listening on ${PORT}`);
});
