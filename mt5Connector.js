const normalizeDirection = (value) => {
  if (typeof value === "number") return value === 0 ? "buy" : "sell";
  const str = String(value || "").trim().toLowerCase();
  if (["buy", "long", "0"].includes(str)) return "buy";
  if (["sell", "short", "1"].includes(str)) return "sell";
  return "";
};

const normalizePayload = (payload) => {
  const account = String(payload.account || payload.accountNumber || "").trim();
  const platform = String(payload.platform || payload.terminal || "MT5").trim().toUpperCase();
  const symbol = String(payload.symbol || payload.instrument || "").trim().toUpperCase();
  const direction = normalizeDirection(payload.direction || payload.side || payload.type);
  const pnl = Number(payload.pnl ?? payload.profit ?? payload.realizedPnl);
  const note = String(payload.note || payload.comment || "MT5 synced trade").trim();
  const closedAt = Number(payload.closed_at || payload.closedAt || Date.now());
  return {
    account,
    platform,
    symbol,
    direction,
    pnl: Number.isFinite(pnl) ? pnl : null,
    note,
    closedAt: Number.isFinite(closedAt) ? closedAt : Date.now()
  };
};

const processMt5Event = (db, payload) => {
  const normalized = normalizePayload(payload);
  if (!normalized.account) {
    return { status: "ignored", message: "Missing account in payload.", normalized };
  }

  const syncAccount = db
    .prepare("SELECT user_id, account, platform FROM sync_accounts WHERE account = ? AND upper(platform) = ?")
    .get(normalized.account, normalized.platform);
  if (!syncAccount) {
    return {
      status: "ignored",
      message: `No synced DS FX Book account found for ${normalized.platform} ${normalized.account}.`,
      normalized
    };
  }

  if (!normalized.symbol || !normalized.direction || normalized.pnl === null) {
    return {
      status: "ignored",
      message: "Payload missing symbol/direction/pnl; not converted into a trade.",
      normalized,
      userId: syncAccount.user_id
    };
  }

  const result = db
    .prepare("INSERT INTO trades (user_id, symbol, direction, pnl, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(syncAccount.user_id, normalized.symbol, normalized.direction, normalized.pnl, normalized.note, normalized.closedAt);
  return {
    status: "processed",
    message: "Trade imported from MT5 webhook.",
    normalized,
    userId: syncAccount.user_id,
    tradeId: result.lastInsertRowid
  };
};

module.exports = { processMt5Event };
