/**
 * lib/pickStocks.js
 * 真・選股引擎（由基準版 server.js 原封不動搬運核心）
 * ❌ 無 express
 * ✅ 只負責：抓資料 → 計算 → 排序 → 輸出
 *
 * ✅ 本次更新：加入「120 天內最接近新高」條件
 *    - 取最近 120 個交易日的最高價（用 close 或 high，這裡用 close 更保守穩定）
 *    - 若 (120DHigh - lastClose) / 120DHigh <= NEAR_120D_HIGH_PCT 才算符合
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 10 });

/* =======================
   參數（與基準版一致）
======================= */
const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000;
const MIN_PRICE = 10;

const RSI_MIN = 50;
const RSI_MAX = 82;

const STAGE2_TOPK = 40;
const MIN_PICK_SCORE = 0;

/* =======================
   ✅ 新增條件：120 天內最接近新高
   - 建議先用 5% 以內（穩健、不會變追高）
======================= */
const NEAR_120D_HIGH_PCT = 0.05; // 5% 以內視為「接近新高」
const LOOKBACK_HIGH_DAYS = 120;  // 120 個交易日（約 6 個月）

/* =======================
   工具函式（原樣）
======================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");

function ymd(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
function dateDaysAgo(days) {
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
function pickFirst(obj, keys, fallback = null) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return fallback;
}

/* =======================
   技術指標（原樣）
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

  let gain = 0,
    loss = 0;
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
   TWSE 股票池（雙來源）
======================= */
async function fetchTWSEStockDayAll() {
  const key = "twse:stock_day_all";
  const cached = cache.get(key);
  if (cached) return cached;

  const headers = { "User-Agent": "Mozilla/5.0" };

  // OpenAPI 優先
  try {
    const r1 = await axios.get(
      "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
      { timeout: 20000, headers }
    );
    if (Array.isArray(r1.data) && r1.data.length > 0) {
      cache.set(key, r1.data);
      return r1.data;
    }
  } catch (_) {}

  // 舊版備援
  const r2 = await axios.get(
    "https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL",
    {
      params: { response: "json" },
      timeout: 20000,
      headers: { ...headers, Referer: "https://www.twse.com.tw/" },
    }
  );
  const data = r2.data?.data || [];
  cache.set(key, data);
  return data;
}

function buildPool(rows) {
  return rows
    .map((r) => {
      if (Array.isArray(r)) {
        return {
          symbol: String(r[0] || "").trim(),
          name: String(r[1] || "").trim(),
          volume: toNum(r[2]),
          close: toNum(r[7]),
        };
      }
      return {
        symbol: String(pickFirst(r, ["Code", "證券代號", "股票代號"], "")).trim(),
        name: String(pickFirst(r, ["Name", "證券名稱", "股票名稱"], "")).trim(),
        volume: toNum(pickFirst(r, ["TradeVolume", "成交股數", "成交股數(股)"], 0)),
        close: toNum(pickFirst(r, ["ClosingPrice", "收盤價", "收盤"], 0)),
      };
    })
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
   Yahoo（原邏輯）
======================= */
async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW`;
  const resp = await axios.get(url, {
    params: { range: "6mo", interval: "1d" },
    timeout: 15000,
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
   ✅ 120D 新高距離計算（新增）
======================= */
function calcNearHigh(bars, lookback = LOOKBACK_HIGH_DAYS) {
  if (!bars || bars.length < 30) return { high: null, distPct: null, ok: false };

  const closes = bars.map((b) => b.close).filter((x) => x > 0);
  if (closes.length < 30) return { high: null, distPct: null, ok: false };

  const window = closes.slice(-Math.min(lookback, closes.length));
  const high = Math.max(...window);
  const lastClose = closes[closes.length - 1];
  if (!high || high <= 0 || !lastClose || lastClose <= 0) return { high: null, distPct: null, ok: false };

  const distPct = (high - lastClose) / high; // 0 ~ 1
  const ok = distPct <= NEAR_120D_HIGH_PCT;

  return { high, distPct, ok };
}

/* =======================
   評分（原邏輯 + 新條件）
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
  const volRatio = vol20[i] && vol20[i] > 0 ? vols[i] / vol20[i] : 1;

  const okTrend =
    lastMA20 && lastMA5 && lastClose > lastMA20 && lastMA5 > lastMA20;
  const okRSI =
    lastRSI == null ? true : lastRSI >= RSI_MIN && lastRSI <= RSI_MAX;
  const okVol = volRatio >= 1.1;

  // ✅ 新增：接近 120 天新高
  const near = calcNearHigh(bars, LOOKBACK_HIGH_DAYS);
  const okNearHigh = near.ok;

  const passed = okTrend && okRSI && okVol && okNearHigh;

  // 原本 score + 讓「越接近新高」略微加分（不讓它主導）
  const baseScore =
    (lastMA20 ? ((lastClose / lastMA20 - 1) * 100) : 0) * 2 +
    (volRatio - 1) * 10;

  // distPct 越小越好：0% => +5 分；5% => +0 分；>5% 不加分
  let nearBonus = 0;
  if (near.distPct != null) {
    const x = Math.max(0, (NEAR_120D_HIGH_PCT - near.distPct) / NEAR_120D_HIGH_PCT); // 0~1
    nearBonus = x * 5;
  }

  const score = baseScore + nearBonus;

  return {
    passed,
    score,
    lastClose,
    // ✅ 讓前端可顯示/除錯（不影響你現有 UI）
    near120dHigh: near.high,
    near120dDistPct: near.distPct != null ? Number((near.distPct * 100).toFixed(2)) : null,
  };
}

/* =======================
   主流程
======================= */
async function pickStocks() {
  const rows = await fetchTWSEStockDayAll();
  const pool = buildPool(rows);

  if (!pool || pool.length === 0) {
    return {
      market: "TW",
      generatedAt: new Date().toISOString(),
      topN: 3,
      picks: [],
      meta: {
        pool: { size: 0, POOL_SIZE, MIN_LIQ_SHARES, MIN_PRICE },
      },
    };
  }

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
        score: Number(s.score.toFixed(4)),
        passed: s.passed,
        // ✅ 附上新條件資訊（可在 App 後續顯示）
        lastClose: Number(s.lastClose.toFixed(2)),
        near120dHigh: s.near120dHigh != null ? Number(s.near120dHigh.toFixed(2)) : null,
        near120dDistPct: s.near120dDistPct,
      });

      await sleep(30); // 避免 Yahoo 限流
    } catch (_) {}
  }

  scored.sort((a, b) => b.score - a.score);

  const passed = scored.filter((x) => x.passed);
  const picks = [];

  for (const x of passed) {
    if (picks.length >= 3) break;
    picks.push({ ...x, reason: "主推" });
  }
  for (const x of scored) {
    if (picks.length >= 3) break;
    if (picks.find((p) => p.symbol === x.symbol)) continue;
    picks.push({ ...x, reason: "補位" });
  }

  return {
    market: "TW",
    generatedAt: new Date().toISOString(),
    topN: 3,
    picks,
    meta: {
      pool: {
        size: pool.length,
        POOL_SIZE,
        MIN_LIQ_SHARES,
        MIN_PRICE,
      },
      filters: {
        near120dHighPct: NEAR_120D_HIGH_PCT,
        lookbackHighDays: LOOKBACK_HIGH_DAYS,
      },
    },
  };
}

module.exports = { pickStocks };
