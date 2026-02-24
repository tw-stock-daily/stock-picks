/**
 * lib/pickStocks.js
 * ✅ 穩定基準版（回退用）
 *
 * 特性：
 * - 保證會出股
 * - today.json 欄位完整
 * - 法人有抓就顯示，沒有也不會壞
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 10 });

/* ======================= */
const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000;
const MIN_PRICE = 10;

const RSI_MIN = 50;
const RSI_MAX = 82;

const MIN_PICK_SCORE = 0;
const INST_WINDOW_DAYS = 20;
/* ======================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");

function ymd(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return ymd(d);
}

function toNum(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const s = String(x).replace(/,/g, "").trim();
  if (s === "" || s === "--") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/* =======================
   技術指標
======================= */
function sma(arr, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(null);
  const out = Array(closes.length).fill(null);

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(null);
  const tr = Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  const out = Array(closes.length).fill(null);
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i] ?? 0;
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < closes.length; i++) {
    prev = (prev * (period - 1) + (tr[i] ?? 0)) / period;
    out[i] = prev;
  }
  return out;
}

/* =======================
   股票池
======================= */
async function fetchTWSEStockDayAll() {
  const key = "twse:stock_day_all";
  const cached = cache.get(key);
  if (cached) return cached;

  const headers = { "User-Agent": "Mozilla/5.0" };

  const r1 = await axios.get(
    "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
    { timeout: 20000, headers }
  );

  cache.set(key, r1.data);
  return r1.data;
}

function buildPool(rows) {
  return rows
    .map((r) => ({
      symbol: String(r.Code || r[0] || "").trim(),
      name: String(r.Name || r[1] || "").trim(),
      volume: toNum(r.TradeVolume || r[2]),
      close: toNum(r.ClosingPrice || r[7]),
    }))
    .filter(
      (x) =>
        /^\d{4}$/.test(x.symbol) &&
        x.volume > MIN_LIQ_SHARES &&
        x.close > MIN_PRICE
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, POOL_SIZE);
}

/* =======================
   Yahoo
======================= */
async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW`;
  const resp = await axios.get(url, {
    params: { range: "6mo", interval: "1d" },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) return null;

  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};

  const bars = ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: toNum(q.open?.[i]),
    high: toNum(q.high?.[i]),
    low: toNum(q.low?.[i]),
    close: toNum(q.close?.[i]),
    volume: toNum(q.volume?.[i]),
  }));

  return bars.filter((b) => b.close > 0);
}

/* =======================
   法人（可失敗）
======================= */
async function fetchInst(stockId, token, endDate) {
  if (!token) return null;

  try {
    const url = "https://api.finmindtrade.com/api/v4/data";
    const rows = (
      await axios.get(url, {
        params: {
          dataset: "TaiwanStockInstitutionalInvestorsBuySell",
          data_id: stockId,
          start_date: daysAgo(30),
          end_date: endDate,
        },
        headers: { Authorization: `Bearer ${token}` },
      })
    ).data?.data;

    if (!rows?.length) return null;

    let total = 0;
    for (const r of rows.slice(-INST_WINDOW_DAYS)) {
      total += (toNum(r.buy) - toNum(r.sell));
    }

    return {
      sumTotal: Math.round(total / 1000),
      unit: "張",
    };
  } catch {
    return null;
  }
}

/* =======================
   評分（基準版）
======================= */
function scoreStock(bars) {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const vols = bars.map((b) => b.volume);

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const rsi14 = rsi(closes, 14);
  const vol20 = sma(vols, 20);
  const atr14 = atr(highs, lows, closes, 14);

  const i = closes.length - 1;

  const lastClose = closes[i];
  const lastMA5 = ma5[i];
  const lastMA20 = ma20[i];
  const lastRSI = rsi14[i];
  const volRatio = vol20[i] ? vols[i] / vol20[i] : 1;

  const okTrend =
    lastMA20 && lastMA5 && lastClose > lastMA20 && lastMA5 > lastMA20;

  const okRSI =
    lastRSI == null ? true : lastRSI >= RSI_MIN && lastRSI <= RSI_MAX;

  const okVol = volRatio >= 1.1;

  const passed = okTrend && okRSI && okVol;

  const score =
    ((lastClose / lastMA20 - 1) * 100) * 2 +
    (volRatio - 1) * 10;

  return {
    passed,
    score,
    lastClose,
    atr14: atr14[i],
    asOfDataDate: bars[i].date,
  };
}

function buildPlan(price, atrV) {
  const atrUse = atrV || price * 0.03;
  return {
    entryLow: +(price - atrUse * 0.4).toFixed(2),
    entryHigh: +(price + atrUse * 0.2).toFixed(2),
    stop: +(price - atrUse * 1.2).toFixed(2),
    tp1: +(price + atrUse * 1.0).toFixed(2),
    tp2: +(price + atrUse * 1.8).toFixed(2),
  };
}

/* =======================
   主流程
======================= */
async function pickStocks({ generatedAt } = {}) {
  const token = process.env.FINMIND_TOKEN || "";

  const rows = await fetchTWSEStockDayAll();
  const pool = buildPool(rows);

  const scored = [];

  for (const p of pool) {
    try {
      const bars = await fetchYahoo(p.symbol);
      if (!bars || bars.length < 30) continue;

      const s = scoreStock(bars);
      if (s.score <= MIN_PICK_SCORE) continue;

      scored.push({
        symbol: p.symbol,
        name: p.name,
        score: +s.score.toFixed(4),
        passed: s.passed,
        lastClose: s.lastClose,
        plan: buildPlan(s.lastClose, s.atr14),
        asOfDataDate: s.asOfDataDate,
      });

      await sleep(25);
    } catch {}
  }

  scored.sort((a, b) => b.score - a.score);

  // ⭐ 永遠補滿 3 檔
  const picks = [];

  const passed = scored.filter((x) => x.passed);

  for (const x of passed) {
    if (picks.length >= 3) break;
    picks.push({ ...x, reason: "主推" });
  }

  for (const x of scored) {
    if (picks.length >= 3) break;
    if (picks.find((p) => p.symbol === x.symbol)) continue;
    picks.push({ ...x, reason: "補位" });
  }

  // ⭐ 加法人（不影響結果）
  for (const p of picks) {
    p.inst = await fetchInst(p.symbol, token, p.asOfDataDate);
  }

  return {
    market: "TW",
    generatedAt: generatedAt || new Date().toISOString(),
    topN: 3,
    picks,
    meta: {
      pool: {
        size: pool.length,
        POOL_SIZE,
        MIN_LIQ_SHARES,
        MIN_PRICE,
      },
      tradeStyle: "基準版(穩定)",
    },
  };
}

module.exports = { pickStocks };
