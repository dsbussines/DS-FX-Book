require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { query } = require("./db/client");
const { processMt5Event } = require("./mt5Connector");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";
const MT5_WEBHOOK_SECRET = process.env.MT5_WEBHOOK_SECRET || "demo-mt5-secret";
const MT5_WEBHOOK_TOLERANCE_MS = Number(process.env.MT5_WEBHOOK_TOLERANCE_MS || 5 * 60 * 1000);

const bootstrapSchema = async () => {
  const schemaPath = path.join(__dirname, "db", "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  await query(sql);
};

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

const authRequired = async (req, res, next) => {
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

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});

const handleDbError = (res, error) => {
  if (error?.code === "23505") return res.status(409).json({ error: "Conflict: duplicate data." });
  // eslint-disable-next-line no-console
  console.error(error);
  return res.status(500).json({ error: "Internal server error." });
};

app.post("/api/auth/register", authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "All fields are required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const existing = await query("SELECT id FROM users WHERE email = $1 LIMIT 1", [normalizedEmail]);
    if (existing.rows[0]) return res.status(409).json({ error: "Email already in use." });
    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO users (name, email, password_hash, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [String(name).trim(), normalizedEmail, hash, Date.now()]
    );
    const user = { id: result.rows[0].id, name: String(name).trim(), email: normalizedEmail };
    return res.json({ token: signToken(user), user });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
  const normalizedEmail = String(email).trim().toLowerCase();
  try {
    const userResult = await query("SELECT * FROM users WHERE email = $1 LIMIT 1", [normalizedEmail]);
    const user = userResult.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid credentials." });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials." });
    return res.json({
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.get("/api/me", authRequired, async (req, res) => {
  try {
    const userResult = await query("SELECT id, name, email, created_at FROM users WHERE id = $1 LIMIT 1", [req.user.id]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: "User not found." });
    return res.json({ user });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.get("/api/trades", authRequired, async (req, res) => {
  try {
    const rows = await query(
      "SELECT id, symbol, direction, pnl, note, created_at FROM trades WHERE user_id = $1 ORDER BY created_at DESC",
      [req.user.id]
    );
    return res.json({ trades: rows.rows });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.post("/api/trades", authRequired, async (req, res) => {
  const { symbol, direction, pnl, note } = req.body || {};
  if (!symbol || !direction || Number.isNaN(Number(pnl))) {
    return res.status(400).json({ error: "symbol, direction and pnl are required." });
  }
  const cleanDirection = String(direction).toLowerCase();
  if (!["buy", "sell"].includes(cleanDirection)) return res.status(400).json({ error: "direction must be buy or sell." });
  try {
    const inserted = await query(
      `INSERT INTO trades (user_id, symbol, direction, pnl, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, symbol, direction, pnl, note, created_at`,
      [req.user.id, String(symbol).trim().toUpperCase(), cleanDirection, Number(pnl), String(note || "").trim(), Date.now()]
    );
    return res.status(201).json({ trade: inserted.rows[0] });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.get("/api/community", authRequired, async (req, res) => {
  try {
    const posts = await query("SELECT id, user_name, text, created_at FROM community_posts ORDER BY created_at DESC LIMIT 100");
    return res.json({ posts: posts.rows });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.post("/api/community", authRequired, async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: "Post text is required." });
  try {
    const userResult = await query("SELECT name FROM users WHERE id = $1 LIMIT 1", [req.user.id]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: "User not found." });
    const post = await query(
      `INSERT INTO community_posts (user_id, user_name, text, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_name, text, created_at`,
      [req.user.id, user.name, String(text).trim(), Date.now()]
    );
    return res.status(201).json({ post: post.rows[0] });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.get("/api/sync", authRequired, async (req, res) => {
  try {
    const sync = await query("SELECT broker, platform, account, updated_at FROM sync_accounts WHERE user_id = $1 LIMIT 1", [
      req.user.id
    ]);
    return res.json({ sync: sync.rows[0] || null });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.post("/api/sync", authRequired, async (req, res) => {
  const { broker, platform, account } = req.body || {};
  if (!broker || !platform || !account) return res.status(400).json({ error: "broker, platform and account are required." });
  try {
    await query(
      `INSERT INTO sync_accounts (user_id, broker, platform, account, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT(user_id) DO UPDATE
       SET broker = EXCLUDED.broker, platform = EXCLUDED.platform, account = EXCLUDED.account, updated_at = EXCLUDED.updated_at`,
      [req.user.id, String(broker).trim(), String(platform).trim().toUpperCase(), String(account).trim(), Date.now()]
    );
    return res.json({ ok: true });
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.get("/api/ai/report", authRequired, async (req, res) => {
  try {
    const tradeRows = await query("SELECT pnl FROM trades WHERE user_id = $1 ORDER BY created_at ASC", [req.user.id]);
    const trades = tradeRows.rows;
    if (trades.length < 3) return res.json({ message: "Add at least 3 trades for a useful report." });
  const total = trades.length;
    const wins = trades.filter((t) => Number(t.pnl) > 0).length;
    const net = trades.reduce((sum, t) => sum + Number(t.pnl), 0);
  const avg = net / total;
  let streak = 0;
  let maxStreak = 0;
  trades.forEach((t) => {
      if (Number(t.pnl) < 0) {
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
  } catch (error) {
    return handleDbError(res, error);
  }
});

app.get("/api/backtest/generate", authRequired, (req, res) => {
  const points = [100];
  for (let i = 1; i < 40; i += 1) points.push(Math.max(10, points[i - 1] + (Math.random() - 0.5) * 2.2));
  return res.json({ prices: points });
});

app.get("/api/integrations/mt5/events", authRequired, async (req, res) => {
  try {
    const rows = await query(
      `SELECT event_id, account, platform, status, message, received_at
       FROM mt5_webhook_events
       WHERE user_id = $1
       ORDER BY received_at DESC
       LIMIT 25`,
      [req.user.id]
    );
    return res.json({ events: rows.rows });
  } catch (error) {
    return handleDbError(res, error);
  }
});

const safeCompare = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""), "utf8");
  const rightBuffer = Buffer.from(String(right || ""), "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

app.post("/api/integrations/mt5/webhook", webhookLimiter, async (req, res) => {
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
  try {
    const duplicateResult = await query("SELECT event_id FROM mt5_webhook_events WHERE event_id = $1 LIMIT 1", [eventId]);
    if (duplicateResult.rows[0]) return res.status(409).json({ error: "Duplicate webhook event." });

    const result = await processMt5Event({ query }, req.body || {});
    await query(
      `INSERT INTO mt5_webhook_events (event_id, user_id, account, platform, status, message, received_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        eventId,
        result.userId || null,
        result.normalized?.account || "",
        result.normalized?.platform || "",
        result.status,
        result.message,
        Date.now(),
        payloadRaw
      ]
    );

    return res.json({
      received: true,
      eventId,
      status: result.status,
      message: result.message,
      tradeId: result.tradeId || null
    });
  } catch (error) {
    return handleDbError(res, error);
  }
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

bootstrapSchema()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      // eslint-disable-next-line no-console
      console.log(`DS FX Book server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Failed to bootstrap schema:", error);
    process.exit(1);
  });
