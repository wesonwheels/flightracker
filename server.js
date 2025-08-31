// server.js  (ESM)
import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.INGEST_TOKEN || "449a6c2b8a4361a5f5c6058ad56c4a1e";

app.use(cors({ origin: true }));
app.use(express.json());

// flightId => Set(res)
const clients = new Map();
// flightId => last JSON string
const latest  = new Map();

function sendSSE(res, jsonString) {
  res.write(`data: ${jsonString}\n\n`); // proper SSE frame
}

// Preflight for ingest
app.options("/ingest", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Ingest-Token",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  });
  res.end();
});

app.post("/ingest", (req, res) => {
  if (req.header("x-ingest-token") !== TOKEN) return res.status(401).end();
  const flight = String(req.query.flight || req.body.flight || "default");
  const now = Date.now();
  const sample = { ...req.body, serverTs: req.body.serverTs ?? now };
  const json = JSON.stringify(sample);

  latest.set(flight, json);
  const set = clients.get(flight);
  if (set && set.size) for (const c of set) sendSSE(c, json);

  res.status(204).end();
});

app.get("/stream", (req, res) => {
  const flight = String(req.query.flight || "default");
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*", // allows https and file:// (null)
    "X-Accel-Buffering": "no",
    "Vary": "Origin",
  });
  if (res.flushHeaders) res.flushHeaders();
  res.write(": ok\n\n");

  // Keepalive pings so proxies don’t close the stream
  const ping = setInterval(() => res.write(": keepalive\n\n"), 25000);

  // Send last point immediately
  const last = latest.get(flight);
  if (last) sendSSE(res, last);

  // Track client
  if (!clients.has(flight)) clients.set(flight, new Set());
  clients.get(flight).add(res);

  req.on("close", () => {
    clearInterval(ping);
    clients.get(flight)?.delete(res);
  });
});

app.get("/", (_, res) => res.type("text/plain").send("OK"));

app.listen(PORT, () => {
  console.log(`relay up on :${PORT}`);
});
