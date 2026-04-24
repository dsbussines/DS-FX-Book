const fileFromPath = (pathname) => {
  const raw = String(pathname || "").replace(/\\/g, "/");
  if (raw === "/" || raw === "") return "index.html";
  const parts = raw.split("/").filter(Boolean);
  const leaf = (parts[parts.length - 1] || "").toLowerCase();
  return leaf || "index.html";
};

const pageFile = () => fileFromPath(window.location.pathname);

const applyNavActive = () => {
  const file = pageFile();
  let hash = (window.location.hash || "").toLowerCase();
  if (file === "analysis.html" && !hash) hash = "#trade";
  if (file === "lounge.html" && !hash) hash = "#lounges";

  document.querySelectorAll(".side-link, .side-sublink").forEach((l) => l.classList.remove("active"));
  document.querySelectorAll(".nav-block").forEach((b) => b.classList.remove("is-active"));

  document.querySelectorAll(".side-sublink").forEach((link) => {
    const url = new URL(link.getAttribute("href"), window.location.href);
    const lf = fileFromPath(url.pathname);
    const lh =
      (url.hash || "").toLowerCase() ||
      (lf === "analysis.html" ? "#trade" : lf === "lounge.html" ? "#lounges" : "");
    if (lf === file && lh === hash) {
      link.classList.add("active");
      link.closest(".nav-block")?.classList.add("is-active");
    }
  });

  document.querySelectorAll(".side-link.parent").forEach((link) => {
    const url = new URL(link.getAttribute("href"), window.location.href);
    const lf = fileFromPath(url.pathname);
    if (lf !== file) return;
    if (file === "analysis.html" && (hash === "#trade" || hash === "#performance")) {
      link.classList.add("active");
      link.closest(".nav-block")?.classList.add("is-active");
    } else if (file === "lounge.html" && (hash === "#lounges" || hash === "#leaderboard")) {
      link.classList.add("active");
      link.closest(".nav-block")?.classList.add("is-active");
    }
  });

  document.querySelectorAll(".side-link:not(.parent)").forEach((link) => {
    const href = link.getAttribute("href");
    if (!href) return;
    const url = new URL(href, window.location.href);
    const lf = fileFromPath(url.pathname);
    if (lf !== file) return;
    const lh = (url.hash || "").toLowerCase();
    if (lh) {
      if (lh !== hash) return;
    } else if (hash) {
      return;
    }
    link.classList.add("active");
  });
};

const initShell = () => {
  const dateEl = document.getElementById("app-date");
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  }
  const clock = () => {
    const el = document.getElementById("header-clock");
    if (!el) return;
    el.textContent = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true
    });
  };
  clock();
  setInterval(clock, 1000);

  const search = document.getElementById("global-search");
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search?.focus();
    }
  });

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    document.body.classList.toggle("theme-light");
  });

  const shell = document.querySelector(".app-shell");
  document.querySelector(".sidebar-pin")?.addEventListener("click", () => {
    shell?.classList.toggle("sidebar-collapsed");
  });

  if (!document.querySelector(".fab-support")) {
    const fab = document.createElement("a");
    fab.href = "support.html";
    fab.className = "fab-support";
    fab.setAttribute("aria-label", "Open help");
    fab.innerHTML = '<span class="material-symbols-outlined" style="font-size:26px">chat</span>';
    document.body.appendChild(fab);
  }

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion) {
    const onScroll = () => {
      const y = window.scrollY || document.documentElement.scrollTop;
      document.documentElement.style.setProperty("--parallax-y", `${y * 0.15}px`);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  const onHash = () => {
    applyNavActive();
    const id = window.location.hash.slice(1);
    if (!id) return;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  onHash();
  window.addEventListener("hashchange", onHash);

  document.getElementById("quick-add")?.addEventListener("click", () => {
    window.location.href = "trades.html";
  });

  const modKey = document.querySelector(".mod-key");
  if (modKey) modKey.textContent = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
};

initShell();

const API_BASE = "/api";
const tokenKey = "dsfxbook_token";
let token = localStorage.getItem(tokenKey) || "";
let trades = [];
let communityPosts = [];

const registerForm = document.querySelector("#register-form");
const loginForm = document.querySelector("#login-form");
const authStatus = document.querySelector("#auth-status");
const logoutBtn = document.querySelector("#logout-btn");

const tradeForm = document.querySelector("#trade-form");
const tradeList = document.querySelector("#trade-list");
const totalEl = document.querySelector("#m-total");
const winRateEl = document.querySelector("#m-winrate");
const pnlEl = document.querySelector("#m-pnl");
const pfEl = document.querySelector("#m-pf");
const equityCanvas = document.querySelector("#equity-chart");

const btGenerateBtn = document.querySelector("#bt-generate");
const btBuyBtn = document.querySelector("#bt-buy");
const btSellBtn = document.querySelector("#bt-sell");
const btCloseBtn = document.querySelector("#bt-close");
const btPriceEl = document.querySelector("#bt-price");
const btPosEl = document.querySelector("#bt-pos");
const btPnlEl = document.querySelector("#bt-pnl");
const btCanvas = document.querySelector("#bt-chart");
const backtestState = { data: [], current: 0, position: null };

const syncForm = document.querySelector("#sync-form");
const syncStatus = document.querySelector("#sync-status");
const refreshMt5EventsBtn = document.querySelector("#refresh-mt5-events");
const mt5EventsEl = document.querySelector("#mt5-events");

const aiGenerateBtn = document.querySelector("#ai-generate");
const aiReportEl = document.querySelector("#ai-report");

const communityForm = document.querySelector("#community-form");
const communityFeed = document.querySelector("#community-feed");
const journalList = document.querySelector("#journal-list");
const analysisChart = document.querySelector("#analysis-chart");

const contactForm = document.querySelector(".contact-form");

const setAuthStatus = (message) => {
  if (authStatus) authStatus.textContent = message;
};

const formatMoney = (value) => `$${value.toFixed(2)}`;

const api = async (path, options = {}) => {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
};

const renderMiniLineChart = (canvas, series, color) => {
  if (!canvas || !series.length) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(280, canvas.clientWidth) * dpr;
  const height = Math.max(130, canvas.clientHeight) * dpr;
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.beginPath();
  series.forEach((value, i) => {
    const x = (i / (series.length - 1 || 1)) * (width - 12) + 6;
    const y = height - ((value - min) / range) * (height - 12) - 6;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
};

const updateAnalytics = () => {
  const total = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const net = trades.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = total ? (wins.length / total) * 100 : 0;
  const pf = grossLoss === 0 ? (grossProfit > 0 ? grossProfit : 0) : grossProfit / grossLoss;
  if (totalEl) totalEl.textContent = String(total);
  if (winRateEl) winRateEl.textContent = `${winRate.toFixed(1)}%`;
  if (pnlEl) {
    pnlEl.textContent = formatMoney(net);
    pnlEl.style.color = net >= 0 ? "#91d7ae" : "#ff8e8e";
  }
  if (pfEl) pfEl.textContent = pf.toFixed(2);
  const equityCurve = [];
  trades
    .slice()
    .reverse()
    .reduce((running, trade) => {
      const next = running + trade.pnl;
      equityCurve.push(next);
      return next;
    }, 0);
  if (equityCurve.length) renderMiniLineChart(equityCanvas, equityCurve, "#6ea0ff");
};

const renderTrades = () => {
  if (tradeList) tradeList.innerHTML = "";
  if (journalList) journalList.innerHTML = "";
  if (!trades.length) {
    if (tradeList) tradeList.innerHTML = "<li>No trades yet. Add your first trade above.</li>";
    if (journalList) journalList.innerHTML = "<li>No journal entries yet.</li>";
    updateAnalytics();
    return;
  }
  trades.forEach((trade) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${trade.symbol}</strong> • ${trade.direction.toUpperCase()} • ${formatMoney(
      Number(trade.pnl)
    )}<br/><small>${trade.note || "No note"}</small>`;
    if (tradeList) tradeList.appendChild(li);
    if (journalList) {
      const journalItem = document.createElement("li");
      journalItem.innerHTML = `<strong>${trade.symbol}</strong> - ${trade.note || "No note"}<br/><small>${trade.direction.toUpperCase()} / ${formatMoney(Number(trade.pnl))}</small>`;
      journalList.appendChild(journalItem);
    }
  });
  updateAnalytics();
  if (analysisChart) {
    const data = trades.map((trade) => Number(trade.pnl)).reverse();
    renderMiniLineChart(analysisChart, data.length ? data : [0], "#3f8dff");
  }
};

const renderCommunity = () => {
  if (!communityFeed) return;
  communityFeed.innerHTML = "";
  if (!communityPosts.length) {
    communityFeed.innerHTML = "<li>No posts yet. Share your first market view.</li>";
    return;
  }
  communityPosts.forEach((post) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${post.user_name}</strong><br/><small>${post.text}</small>`;
    communityFeed.appendChild(li);
  });
};

const renderMt5Events = (events) => {
  if (!mt5EventsEl) return;
  mt5EventsEl.innerHTML = "";
  if (!events || !events.length) {
    mt5EventsEl.innerHTML = "<li>No MT5 webhook events yet.</li>";
    return;
  }
  events.forEach((event) => {
    const li = document.createElement("li");
    li.innerHTML = `<strong>${event.status.toUpperCase()}</strong> • ${event.platform} ${event.account}<br/><small>${event.message}</small>`;
    mt5EventsEl.appendChild(li);
  });
};

const refreshData = async () => {
  if (!token) return;
  const [tradeRes, communityRes, syncRes] = await Promise.all([
    api("/trades"),
    api("/community"),
    api("/sync")
  ]);
  trades = tradeRes.trades || [];
  communityPosts = communityRes.posts || [];
  renderTrades();
  renderCommunity();
  if (syncStatus && syncRes.sync) {
    syncStatus.textContent = `Connected to ${syncRes.sync.platform} account ${syncRes.sync.account} at ${syncRes.sync.broker} (read-only).`;
  } else if (syncStatus) {
    syncStatus.textContent = "No account connected.";
  }
  try {
    const eventsRes = await api("/integrations/mt5/events");
    renderMt5Events(eventsRes.events || []);
  } catch (error) {
    renderMt5Events([]);
  }
};

const setLoggedInUi = (user) => {
  setAuthStatus(`Logged in as ${user.name} (${user.email})`);
  const nameEl = document.getElementById("sidebar-user-name");
  const emailEl = document.getElementById("sidebar-user-email");
  if (nameEl) nameEl.textContent = user.name || "Trader";
  if (emailEl) emailEl.textContent = user.email || "";
};

const handleAuthSuccess = async (payload) => {
  token = payload.token;
  localStorage.setItem(tokenKey, token);
  setLoggedInUi(payload.user);
  await refreshData();
  if (window.location.pathname === "/settings" || window.location.pathname === "/settings.html") {
    window.location.href = "/";
  }
};

if (registerForm) registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/auth/register", {
      method: "POST",
      body: JSON.stringify({
        name: document.querySelector("#register-name").value.trim(),
        email: document.querySelector("#register-email").value.trim(),
        password: document.querySelector("#register-password").value
      })
    });
    registerForm.reset();
    await handleAuthSuccess(payload);
  } catch (error) {
    setAuthStatus(error.message);
  }
});

if (loginForm) loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = await api("/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: document.querySelector("#login-email").value.trim(),
        password: document.querySelector("#login-password").value
      })
    });
    loginForm.reset();
    await handleAuthSuccess(payload);
  } catch (error) {
    setAuthStatus(error.message);
  }
});

if (logoutBtn) logoutBtn.addEventListener("click", () => {
  token = "";
  localStorage.removeItem(tokenKey);
  trades = [];
  communityPosts = [];
  renderTrades();
  renderCommunity();
  setAuthStatus("Logged out.");
  const nameEl = document.getElementById("sidebar-user-name");
  const emailEl = document.getElementById("sidebar-user-email");
  if (nameEl) nameEl.textContent = "Guest";
  if (emailEl) emailEl.textContent = "Sign in to sync";
  if (syncStatus) syncStatus.textContent = "No account connected.";
  renderMt5Events([]);
});

if (tradeForm) tradeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!token) return setAuthStatus("Please login first.");
  try {
    await api("/trades", {
      method: "POST",
      body: JSON.stringify({
        symbol: document.querySelector("#trade-symbol").value.trim(),
        direction: document.querySelector("#trade-direction").value,
        pnl: Number(document.querySelector("#trade-pnl").value),
        note: document.querySelector("#trade-note").value.trim()
      })
    });
    tradeForm.reset();
    await refreshData();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

const updateBacktestPnL = () => {
  if (!backtestState.data.length) return;
  const price = backtestState.data[backtestState.current];
  btPriceEl.textContent = price.toFixed(2);
  if (!backtestState.position) {
    btPosEl.textContent = "None";
    btPnlEl.textContent = "$0.00";
    btPnlEl.style.color = "var(--text)";
    return;
  }
  const sign = backtestState.position.type === "buy" ? 1 : -1;
  const pnl = (price - backtestState.position.entry) * sign * 10;
  btPosEl.textContent = `${backtestState.position.type.toUpperCase()} @ ${backtestState.position.entry.toFixed(2)}`;
  btPnlEl.textContent = formatMoney(pnl);
  btPnlEl.style.color = pnl >= 0 ? "#91d7ae" : "#ff8e8e";
};

if (btGenerateBtn) btGenerateBtn.addEventListener("click", async () => {
  if (!token) return setAuthStatus("Please login first.");
  try {
    const payload = await api("/backtest/generate");
    backtestState.data = payload.prices || [];
    backtestState.current = backtestState.data.length - 1;
    backtestState.position = null;
    renderMiniLineChart(btCanvas, backtestState.data, "#8f75ff");
    updateBacktestPnL();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

if (btBuyBtn) btBuyBtn.addEventListener("click", () => {
  if (!backtestState.data.length) return;
  backtestState.position = { type: "buy", entry: backtestState.data[backtestState.current] };
  updateBacktestPnL();
});

if (btSellBtn) btSellBtn.addEventListener("click", () => {
  if (!backtestState.data.length) return;
  backtestState.position = { type: "sell", entry: backtestState.data[backtestState.current] };
  updateBacktestPnL();
});

if (btCloseBtn) btCloseBtn.addEventListener("click", async () => {
  if (!token || !backtestState.position) return;
  const pnl = Number(btPnlEl.textContent.replace("$", ""));
  try {
    await api("/trades", {
      method: "POST",
      body: JSON.stringify({
        symbol: "BT-DEMO",
        direction: backtestState.position.type,
        pnl,
        note: "Backtest close"
      })
    });
    backtestState.position = null;
    updateBacktestPnL();
    await refreshData();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

if (syncForm) syncForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!token) return setAuthStatus("Please login first.");
  try {
    await api("/sync", {
      method: "POST",
      body: JSON.stringify({
        broker: document.querySelector("#sync-broker").value.trim(),
        platform: document.querySelector("#sync-platform").value,
        account: document.querySelector("#sync-account").value.trim()
      })
    });
    syncForm.reset();
    await refreshData();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

if (communityForm) communityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!token) return setAuthStatus("Please login first.");
  try {
    await api("/community", {
      method: "POST",
      body: JSON.stringify({ text: document.querySelector("#community-text").value.trim() })
    });
    communityForm.reset();
    await refreshData();
  } catch (error) {
    setAuthStatus(error.message);
  }
});

if (aiGenerateBtn) aiGenerateBtn.addEventListener("click", async () => {
  if (!token) return setAuthStatus("Please login first.");
  try {
    const payload = await api("/ai/report");
    aiReportEl.textContent = payload.message || "No AI report available.";
  } catch (error) {
    setAuthStatus(error.message);
  }
});

if (refreshMt5EventsBtn) refreshMt5EventsBtn.addEventListener("click", async () => {
  if (!token) return setAuthStatus("Please login first.");
  try {
    const eventsRes = await api("/integrations/mt5/events");
    renderMt5Events(eventsRes.events || []);
  } catch (error) {
    setAuthStatus(error.message);
  }
});

if (contactForm) {
  contactForm.addEventListener("submit", (event) => {
    event.preventDefault();
    alert("Thanks! Your message has been received.");
    contactForm.reset();
  });
}

const bootstrap = async () => {
  renderTrades();
  renderCommunity();
  renderMt5Events([]);
  if (!token) {
    setAuthStatus("Not logged in.");
    return;
  }
  try {
    const payload = await api("/me");
    setLoggedInUi(payload.user);
    await refreshData();
    if (btCanvas) {
      const bt = await api("/backtest/generate");
      backtestState.data = bt.prices || [];
      backtestState.current = backtestState.data.length - 1;
      renderMiniLineChart(btCanvas, backtestState.data, "#8f75ff");
      updateBacktestPnL();
    }
  } catch (error) {
    token = "";
    localStorage.removeItem(tokenKey);
    setAuthStatus("Session expired. Please login again.");
  }
};

bootstrap();
