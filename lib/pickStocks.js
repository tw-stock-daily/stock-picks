/**
 * lib/pickStocks.js
 * 穩定基準版：一定出 TOP3，並輸出完整詳情欄位（tech/plan/inst）
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 10 });

/* ========== 參數 ========== */
const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000;
const MIN_PRICE = 10;

const RSI_MIN = 50;
const RSI_MAX = 82;

const MIN_PICK_SCORE = 0;
const INST_WINDOW_DAYS = 20;

/* ========== 工具 ========== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function toNum(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const s = String(x).replace(/,/g, "").trim();
  if (!s || s === "--") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
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

/* ========== 指標 ========== */
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

/* ========== TWSE 股票池 ========== */
async function fetchTWSEStockDayAll() {
  const key = "twse:stock_day_all";
  const cached = cache.get(key);
  if (cached) return cached;

  const headers = { "User-Agent": "Mozilla/5.0" };

  // OpenAPI
  const r1 = await axios.get(
    "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
    { timeout: 20000, headers }
  );
  cache.set(key, r1.data);
  return r1.data;
}

function buildPool(rows) {
  return rows
    .map((r) => {
      // openapi.twse 多為 object：Code/Name/TradeVolume/ClosingPrice
      if (!Array.isArray(r)) {
        return {
          symbol: String(r.Code || "").trim(),
          name: String(r.Name || "").trim(),
          volume: toNum(r.TradeVolume),
          close: toNum(r.ClosingPrice),
        };
      }
      // 兼容 array
      return {
        symbol: String(r[0] || "").trim(),
        name: String(r[1] || "").trim(),
        volume: toNum(r[2]),
        close: toNum(r[7]),
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

/* ========== Yahoo 個股日K ========== */
async function fetchYahooBars(symbol) {
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

/* ========== 評分 + 詳情欄位 ========== */
function scoreAndDetails(bars) {
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
  const lastATR = atr14[i];

  const volRatio = vol20[i] && vol20[i] > 0 ? vols[i] / vol20[i] : null;

  const okTrend =
    lastMA20 && lastMA5 && lastClose > lastMA20 && lastMA5 > lastMA20;
  const okRSI =
    lastRSI == null ? true : lastRSI >= RSI_MIN && lastRSI <= RSI_MAX;
  const okVol = volRatio == null ? false : volRatio >= 1.1;

  const passed = okTrend && okRSI && okVol;

  const score =
    (lastMA20 ? ((lastClose / lastMA20 - 1) * 100) : 0) * 2 +
    (volRatio != null ? (volRatio - 1) * 10 : 0);

  return {
    passed,
    score,
    lastClose,
    ma5: lastMA5,
    ma20: lastMA20,
    rsi14: lastRSI,
    volRatio,
    atr14: lastATR,
    asOfDataDate: bars[i].date,
  };
}

function buildPlan(price, atrV) {
  const atrUse = atrV && atrV > 0 ? atrV : price * 0.03;
  return {
    entryLow: +(price - atrUse * 0.4).toFixed(2),
    entryHigh: +(price + atrUse * 0.2).toFixed(2),
    stop: +(price - atrUse * 1.2).toFixed(2),
    tp1: +(price + atrUse * 1.0).toFixed(2),
    tp2: +(price + atrUse * 1.8).toFixed(2),
  };
}

/* ========== FinMind 法人（股→張） ========== */
async function fetchInstWindow(stockId, token, endDate) {
  if (!token) return null;

  try {
    const url = "https://api.finmindtrade.com/api/v4/data";
    const start = daysAgo(45);
    const resp = await axios.get(url, {
      params: {
        dataset: "TaiwanStockInstitutionalInvestorsBuySell",
        data_id: stockId,
        start_date: start,
        end_date: endDate,
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 25000,
    });

    const rows = resp.data?.data || [];
    if (!rows.length) return null;

    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const window = rows.slice(-INST_WINDOW_DAYS);

    // FinMind 回來的 name: Foreign_Investor / Investment_Trust / Dealer...
    let sumForeign = 0, sumTrust = 0, sumDealer = 0, sumTotal = 0;

    const byDate = new Map();
    for (const r of rows) {
      const d = String(r.date || "");
      if (!d) continue;
      const name = String(r.name || "");
      const buy = toNum(r.buy);
      const sell = toNum(r.sell);
      const net = buy - sell;

      if (!byDate.has(d)) byDate.set(d, 0);
      byDate.set(d, byDate.get(d) + net);

      if (name.includes("Foreign_Investor")) sumForeign += net;
      else if (name.includes("Investment_Trust")) sumTrust += net;
      else if (name.includes("Dealer")) sumDealer += net;

      sumTotal += net;
    }

    const dates = Array.from(byDate.keys()).sort();
    const latestDate = dates[dates.length - 1];
    const latestTotalNet = byDate.get(latestDate) || 0;

    // 連買 streak（用 total net）
    let buyStreak = 0;
    for (let i = dates.length - 1; i >= 0; i--) {
      const v = byDate.get(dates[i]) || 0;
      if (v > 0) buyStreak++;
      else break;
    }

    const toLots = (shares) => Math.round(shares / 1000);

    return {
      windowDays: window.length,
      sumForeign: toLots(sumForeign),
      sumTrust: toLots(sumTrust),
      sumDealer: toLots(sumDealer),
      sumTotal: toLots(sumTotal),
      buyStreak,
      latestDate,
      latestTotalNet: toLots(latestTotalNet),
      unit: "張",
      note: "FinMind 原始 buy/sell 為股數，本欄已÷1000換算張數。",
    };
  } catch {
    return null;
  }
}

/* ========== 主流程 ========== */
async function pickStocks({ generatedAt } = {}) {
  const token = process.env.FINMIND_TOKEN || "";

  const rows = await fetchTWSEStockDayAll();
  const pool = buildPool(rows);

  const scored = [];
  for (const p of pool) {
    try {
      const bars = await fetchYahooBars(p.symbol);
      if (!bars || bars.length < 30) continue;

      const s = scoreAndDetails(bars);
      if (s.score <= MIN_PICK_SCORE) continue;

      scored.push({
        symbol: p.symbol,
        name: p.name,
        score: +s.score.toFixed(4),
        passed: s.passed,

        lastClose: s.lastClose,
        ma5: s.ma5,
        ma20: s.ma20,
        rsi14: s.rsi14,
        volRatio: s.volRatio,
        atr14: s.atr14,

        asOfDataDate: s.asOfDataDate,
        plan: buildPlan(s.lastClose, s.atr14),
      });

      await sleep(25);
    } catch (_) {}
  }

  scored.sort((a, b) => b.score - a.score);

  // 永遠補滿 3 檔
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

  // 法人：抓得到就填，抓不到仍保留 picks
  for (const p of picks) {
    p.inst = await fetchInstWindow(p.symbol, token, p.asOfDataDate);
    await sleep(80);
  }

  return {
    market: "TW",
    generatedAt: generatedAt || new Date().toISOString(),
    topN: 3,
    picks,
    meta: {
      pool: { size: pool.length, POOL_SIZE, MIN_LIQ_SHARES, MIN_PRICE },
      tradeStyle: "基準版(穩定)",
    },
  };
}

module.exports = { pickStocks };
