require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { processMt5Event } = require("./mt5Connector");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";
const MT5_WEBHOOK_SECRET = process.env.MT5_WEBHOOK_SECRET || "demo-mt5-secret";
const MT5_WEBHOOK_TOLERANCE_MS = Number(process.env.MT5_WEBHOOK_TOLERANCE_MS || 5 * 60 * 1000);

const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "dsfxbook.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    direction TEXT NOT NULL,
    pnl REAL NOT NULL,
    note TEXT DEFAULT '',
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS community_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS sync_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL UNIQUE,
    broker TEXT NOT NULL,
    platform TEXT NOT NULL,
    account TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS mt5_webhook_events (
    event_id TEXT PRIMARY KEY,
    user_id INTEGER,
    account TEXT,
    platform TEXT,
    status TEXT NOT NULL,
    message TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    raw_payload TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

app.use(cors());
app.use(
  express.json({
    verify: (req, res, buffer) => {
      req.rawBody = buffer.toString("utf8");
    }
  })
);
app.use(
  express.static(__dirname, {
    index: false
  })
);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

const signToken = (user) =>
  jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });

const authRequired = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Missing auth token." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
};

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "All fields are required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (existing) return res.status(409).json({ error: "Email already in use." });
  const hash = await bcrypt.hash(password, 10);
  const result = db
    .prepare("INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(String(name).trim(), normalizedEmail, hash, Date.now());
  const user = { id: result.lastInsertRowid, name: String(name).trim(), email: normalizedEmail };
  return res.json({ token: signToken(user), user });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail);
  if (!user) return res.status(401).json({ error: "Invalid credentials." });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials." });
  return res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email }
  });
});

app.get("/api/me", authRequired, (req, res) => {
  const user = db.prepare("SELECT id, name, email, created_at FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found." });
  return res.json({ user });
});

app.get("/api/trades", authRequired, (req, res) => {
  const rows = db
    .prepare("SELECT id, symbol, direction, pnl, note, created_at FROM trades WHERE user_id = ? ORDER BY created_at DESC")
    .all(req.user.id);
  return res.json({ trades: rows });
});

app.post("/api/trades", authRequired, (req, res) => {
  const { symbol, direction, pnl, note } = req.body || {};
  if (!symbol || !direction || Number.isNaN(Number(pnl))) {
    return res.status(400).json({ error: "symbol, direction and pnl are required." });
  }
  const cleanDirection = String(direction).toLowerCase();
  if (!["buy", "sell"].includes(cleanDirection)) return res.status(400).json({ error: "direction must be buy or sell." });
  const result = db
    .prepare("INSERT INTO trades (user_id, symbol, direction, pnl, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(req.user.id, String(symbol).trim().toUpperCase(), cleanDirection, Number(pnl), String(note || "").trim(), Date.now());
  const trade = db.prepare("SELECT id, symbol, direction, pnl, note, created_at FROM trades WHERE id = ?").get(result.lastInsertRowid);
  return res.status(201).json({ trade });
});

app.get("/api/community", authRequired, (req, res) => {
  const posts = db
    .prepare("SELECT id, user_name, text, created_at FROM community_posts ORDER BY created_at DESC LIMIT 100")
    .all();
  return res.json({ posts });
});

app.post("/api/community", authRequired, (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Post text is required." });
  const user = db.prepare("SELECT name FROM users WHERE id = ?").get(req.user.id);
  const result = db
    .prepare("INSERT INTO community_posts (user_id, user_name, text, created_at) VALUES (?, ?, ?, ?)")
    .run(req.user.id, user.name, String(text).trim(), Date.now());
  const post = db.prepare("SELECT id, user_name, text, created_at FROM community_posts WHERE id = ?").get(result.lastInsertRowid);
  return res.status(201).json({ post });
});

app.get("/api/sync", authRequired, (req, res) => {
  const sync = db
    .prepare("SELECT broker, platform, account, updated_at FROM sync_accounts WHERE user_id = ?")
    .get(req.user.id);
  return res.json({ sync: sync || null });
});

app.post("/api/sync", authRequired, (req, res) => {
  const { broker, platform, account } = req.body || {};
  if (!broker || !platform || !account) return res.status(400).json({ error: "broker, platform and account are required." });
  db.prepare(
    `INSERT INTO sync_accounts (user_id, broker, platform, account, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET broker = excluded.broker, platform = excluded.platform, account = excluded.account, updated_at = excluded.updated_at`
  ).run(req.user.id, String(broker).trim(), String(platform).trim().toUpperCase(), String(account).trim(), Date.now());
  return res.json({ ok: true });
});

app.get("/api/ai/report", authRequired, (req, res) => {
  const trades = db
    .prepare("SELECT pnl FROM trades WHERE user_id = ? ORDER BY created_at ASC")
    .all(req.user.id);
  if (trades.length < 3) return res.json({ message: "Add at least 3 trades for a useful report." });
  const total = trades.length;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const net = trades.reduce((sum, t) => sum + t.pnl, 0);
  const avg = net / total;
  let streak = 0;
  let maxStreak = 0;
  trades.forEach((t) => {
    if (t.pnl < 0) {
      streak += 1;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 0;
    }
  });
  const winRate = (wins / total) * 100;
  const grade = net > 0 && winRate > 55 ? "A-" : net > 0 ? "B" : "C";
  const message = `Grade ${grade}. Win rate ${winRate.toFixed(1)}% across ${total} trades. Avg PnL ${avg.toFixed(
    2
  )}. Longest loss streak ${maxStreak}. ${maxStreak >= 3 ? "Reduce size after 2 losses." : "Keep compounding winners with fixed risk."}`;
  return res.json({ message });
});

app.get("/api/backtest/generate", authRequired, (req, res) => {
  const points = [100];
  for (let i = 1; i < 40; i += 1) points.push(Math.max(10, points[i - 1] + (Math.random() - 0.5) * 2.2));
  return res.json({ prices: points });
});

app.get("/api/integrations/mt5/events", authRequired, (req, res) => {
  const rows = db
    .prepare(
      "SELECT event_id, account, platform, status, message, received_at FROM mt5_webhook_events WHERE user_id = ? ORDER BY received_at DESC LIMIT 25"
    )
    .all(req.user.id);
  return res.json({ events: rows });
});

const safeCompare = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

app.post("/api/integrations/mt5/webhook", (req, res) => {
  const timestampHeader = req.headers["x-mt5-timestamp"];
  const signatureHeader = req.headers["x-mt5-signature"];
  const providedEventId = String(req.headers["x-mt5-event-id"] || "").trim();
  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return res.status(401).json({ error: "Missing or invalid x-mt5-timestamp." });
  if (Math.abs(Date.now() - timestamp) > MT5_WEBHOOK_TOLERANCE_MS) {
    return res.status(401).json({ error: "Webhook timestamp expired." });
  }
  const payloadRaw = req.rawBody || JSON.stringify(req.body || {});
  const signedContent = `${timestamp}.${payloadRaw}`;
  const expectedSignature = crypto.createHmac("sha256", MT5_WEBHOOK_SECRET).update(signedContent).digest("hex");
  if (!safeCompare(signatureHeader, expectedSignature)) {
    return res.status(401).json({ error: "Invalid webhook signature." });
  }

  const eventId =
    providedEventId ||
    crypto.createHash("sha256").update(`${timestamp}.${payloadRaw}`).digest("hex");
  const duplicate = db.prepare("SELECT event_id FROM mt5_webhook_events WHERE event_id = ?").get(eventId);
  if (duplicate) return res.status(409).json({ error: "Duplicate webhook event." });

  const result = processMt5Event(db, req.body || {});
  db.prepare(
    `INSERT INTO mt5_webhook_events (event_id, user_id, account, platform, status, message, received_at, raw_payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventId,
    result.userId || null,
    result.normalized?.account || "",
    result.normalized?.platform || "",
    result.status,
    result.message,
    Date.now(),
    payloadRaw
  );

  return res.json({
    received: true,
    eventId,
    status: result.status,
    message: result.message,
    tradeId: result.tradeId || null
  });
});

const pageRoutes = [
  { path: "/", view: "landing", title: "DS FX Book" },
  { path: "/index.html", view: "landing", title: "DS FX Book" },
  { path: "/dashboard", view: "dashboard", title: "Dashboard" },
  { path: "/dashboard.html", view: "dashboard", title: "Dashboard" },
  { path: "/trades", view: "trades", title: "Trades" },
  { path: "/trades.html", view: "trades", title: "Trades" },
  { path: "/journal", view: "journal", title: "Journal" },
  { path: "/journal.html", view: "journal", title: "Journal" },
  { path: "/analysis", view: "analysis", title: "Analysis" },
  { path: "/analysis.html", view: "analysis", title: "Analysis" },
  { path: "/market", view: "market", title: "Market" },
  { path: "/market.html", view: "market", title: "Market" },
  { path: "/ai-report", view: "ai-report", title: "AI Report" },
  { path: "/ai-report.html", view: "ai-report", title: "AI Report" },
  { path: "/backtesting", view: "backtesting", title: "Backtesting" },
  { path: "/backtesting.html", view: "backtesting", title: "Backtesting" },
  { path: "/lounge", view: "lounge", title: "Traders Lounge" },
  { path: "/lounge.html", view: "lounge", title: "Traders Lounge" },
  { path: "/tools", view: "tools", title: "Tools" },
  { path: "/tools.html", view: "tools", title: "Tools" },
  { path: "/subscription", view: "subscription", title: "Subscription" },
  { path: "/subscription.html", view: "subscription", title: "Subscription" },
  { path: "/settings", view: "settings", title: "Settings" },
  { path: "/settings.html", view: "settings", title: "Settings" },
  { path: "/support", view: "support", title: "Help & Support" },
  { path: "/support.html", view: "support", title: "Help & Support" }
];

pageRoutes.forEach((route) => {
  app.get(route.path, (req, res) => {
    res.render(route.view, { title: route.title, currentPath: req.path });
  });
});

app.get(/.*/, (req, res) => {
  res.redirect("/");
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`DS FX Book server running on http://localhost:${PORT}`);
});
