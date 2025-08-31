// server.js
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());

// SSE clients
let clients = [];

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Endpoint for simulator to POST flight data
app.use(express.json());
app.post("/update", (req, res) => {
  const data = req.body;
  if (!data) {
    return res.status(400).json({ error: "No data received" });
  }
  // Broadcast to all connected SSE clients
  clients.forEach((res) => res.write(`data: ${JSON.stringify(data)}\n\n`));
  res.json({ ok: true });
});

// SSE stream for frontend
app.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Keep connection open
  clients.push(res);
  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });
});

// Use Render's dynamic port, fallback for local testing
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Relay up on :${PORT}`);
});
