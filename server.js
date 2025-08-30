import express from "express";
import cors from "cors";

const app = express();
app.use(express.json());

const ORIGINS = (process.env.ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = ORIGINS.includes("*")
  ? { origin: true }
  : { origin: (origin, cb) => cb(null, ORIGINS.includes(origin)) };

app.use(cors(corsOptions));

let clients = [];
let lastData = null;

app.get("/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders?.();
  if (lastData) res.write(`data: ${JSON.stringify(lastData)}\n\n`);
  clients.push(res);
  req.on("close", () => (clients = clients.filter(c => c !== res)));
});

app.post("/ingest", (req, res) => {
  const token = req.header("x-ingest-token");
  if (!process.env.INGEST_TOKEN || token !== process.env.INGEST_TOKEN) {
    return res.status(401).json({ ok:false, error:"invalid token" });
  }
  lastData = { ...req.body, serverTs: Date.now() };
  const payload = `data: ${JSON.stringify(lastData)}\n\n`;
  for (const c of clients) c.write(payload);
  res.json({ ok:true });
});

app.get("/", (req, res) => {
  res.type("text/plain").send("Wheels Relay OK. Use /stream and POST /ingest.");
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Relay listening on :" + port));
