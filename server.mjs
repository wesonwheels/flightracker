// server.mjs — Wheels Relay (Node 18+)
// Run: PORT=3000 node server.mjs
import express from "express";
import cors from "cors";

// --- config ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const PUSH_TOKEN = process.env.PUSH_TOKEN || ""; // optional; set to require auth on /push

// --- app setup ------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// flight -> Set<res> (SSE watchers)
const watchers = new Map();
// flight -> last known payload
const last = new Map();

// --- helpers --------------------------------------------------------------
function broadcast(flight, payload) {
  const set = watchers.get(flight);
  if (!set || set.size === 0) return 0;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(line);
  return set.size;
}

// --- health ---------------------------------------------------------------
app.get("/", (_req, res) => res.type("text/plain").send("ok"));

// --- SSE stream -----------------------------------------------------------
app.get("/stream", (req, res) => {
  const flight = String(req.query.flight || "DEFAULT");

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders?.();

  // register watcher
  let set = watchers.get(flight);
  if (!set) watchers.set(flight, (set = new Set()));
  set.add(res);

  // send last known state immediately (if any)
  const lastPayload = last.get(flight);
  res.write(`event: hello\ndata: {"flight":"${flight}"}\n\n`);
  if (lastPayload) res.write(`data: ${JSON.stringify(lastPayload)}\n\n`);

  // heartbeat to keep proxies happy
  const hb = setInterval(() => {
    res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`);
  }, 25000);

  req.on("close", () => {
    clearInterval(hb);
    set.delete(res);
  });
});

// --- ingest position/state ------------------------------------------------
// POST /push?flight=WHEELS735
// Body: { lat, lon, alt_ft, hdg_deg, gs_kts, vs_fpm, tas_kts, ... }
app.post("/push", (req, res) => {
  if (PUSH_TOKEN && req.get("x-auth") !== PUSH_TOKEN) {
    return res.status(401).json({ ok: false, error: "bad token" });
  }

  const flight = String(req.query.flight || req.body.flight || "DEFAULT");
  const data = { ...(req.body || {}), serverTs: Date.now() };

  last.set(flight, data);
  const n = broadcast(flight, data);
  res.json({ ok: true, flight, watchers: n });
});

// --- SimBrief helper (JSON) ----------------------------------------------
// GET /simbrief/latest?username=155825  (or ?userid=12345)
app.get("/simbrief/latest", async (req, res) => {
  try {
    const { username, userid } = req.query;
    if (!username && !userid) {
      return res.status(400).json({ ok: false, error: "missing username or userid" });
    }
    const q = userid
      ? `userid=${encodeURIComponent(userid)}`
      : `username=${encodeURIComponent(username)}`;

    // Node 18+ has global fetch
    const url = `https://www.simbrief.com/api/xml.fetcher.php?${q}&json=1&jsonp=`;
    const r = await fetch(url, { headers: { "User-Agent": "WheelsRelay/1.0" } });
    if (!r.ok) throw new Error(`SimBrief ${r.status}`);

    const plan = await r.json();

    const meta = {
      callsign:
        plan?.general?.callsign ||
        (plan?.general?.icao_airline && plan?.general?.flight_number
          ? `${plan.general.icao_airline}${plan.general.flight_number}`
          : undefined),
      flight_number: plan?.general?.flight_number,
      origin: plan?.origin?.icao_code || plan?.origin?.iata_code,
      destination: plan?.destination?.icao_code || plan?.destination?.iata_code,
      etd: plan?.times?.est_out || plan?.times?.sched_out || null,
      eta: plan?.times?.est_on || plan?.times?.sched_on || null,
      aircraft_icao: plan?.aircraft?.icaocode || plan?.aircraft?.type || null,
      route_text: plan?.general?.route || plan?.atc?.route || null,
    };

    res.json({ ok: true, meta, raw: plan });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

// --- start ----------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Wheels relay listening on :${PORT}`);
});
