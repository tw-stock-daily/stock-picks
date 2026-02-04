// server.js (TOP3 + 補齊TOP3 + 價格區間 + 中文名 + 產業 + 600股票池(成交量前600)
//          + 兩段式FinMind加權 + 負分不推薦 + 排除創新板/創新版)
//
// 安裝套件：
//   npm i express axios node-cache cors
// （可選）若你想用 .env：npm i dotenv
//
// 啟動（手動輸入 FinMind Token）：
// Windows CMD:
//   cd C:\Users\actom\stock
//   set FINMIND_TOKEN=xxx
//   node server.js
//
// PowerShell:
//   cd C:\Users\actom\stock
//   $env:FINMIND_TOKEN="xxx"
//   node server.js

const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const cors = require("cors");
const path = require("path");

// 可選：dotenv（不裝也不影響）
try { require("dotenv").config(); } catch (_) {}

const app = express();
app.use(cors());
app.use(express.json());

const cache = new NodeCache({ stdTTL: 60 * 15 });

const FINMIND_TOKEN = (process.env.FINMIND_TOKEN || "").trim();
const PORT = process.env.PORT || 3000;

// ====== 參數（你之後要調整，可只改這區）======
const POOL_SIZE = 600;              // 股票池：成交量排序取前 600（想 800 就改 800）
const MIN_LIQ_SHARES = 500000;      // 過濾：成交量至少 50 萬股（500 張）
const MIN_PRICE = 10;               // 過濾：收盤至少 10 元
const STAGE2_TOPK_DEFAULT = 40;     // 第二段只對前 topK 做籌碼微調（避免太慢）
const STAGE1_CONCURRENCY = 6;       // 第一段併發（Yahoo+法人）
const STAGE2_CONCURRENCY = 5;       // 第二段併發（FinMind）
const MIN_PICK_SCORE = 0;           // ★負分不推薦：score 必須 > 0 才會進推薦池

// RSI 條件（你要求上限 82）
const RSI_MIN = 50;
const RSI_MAX = 82;

// ============== helpers ==============
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");
const yyyymmdd = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

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
  gain /= period; loss /= period;
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

function findLatestValidRow(sortedRows, validatorFn) {
  for (let i = sortedRows.length - 1; i >= 0; i--) {
    const r = sortedRows[i];
    if (validatorFn(r)) return r;
  }
  return null;
}

// ============== bucket ==============
function parseBucket(bucket) {
  switch (bucket) {
    case "lt100": return { label: "100以內", min: -Infinity, max: 100 };
    case "100_300": return { label: "100~300", min: 100, max: 300 };
    case "300_600": return { label: "300~600", min: 300, max: 600 };
    case "600_1000": return { label: "600~1000", min: 600, max: 1000 };
    case "gt1000": return { label: "1000以上", min: 1000, max: Infinity };
    case "all":
    default: return { label: "不限", min: -Infinity, max: Infinity };
  }
}

function inBucket(price, b) {
  if (!Number.isFinite(price)) return false;
  if (b.max === Infinity) return price >= b.min;
  if (b.min === -Infinity) return price < b.max;
  return price >= b.min && price < b.max;
}

// ============== concurrency limiter ==============
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;

  async function runner() {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      out[i] = await worker(items[i], i);
    }
  }

  const runners = [];
  for (let k = 0; k < Math.max(1, limit); k++) runners.push(runner());
  await Promise.all(runners);
  return out;
}

// ============== FinMind stock info map (用來判斷創新版) ==============
async function finmindFetch({ dataset, stock_id, data_id, start_date, end_date }) {
  const key = `finmind:${dataset}:${stock_id || ""}:${data_id || ""}:${start_date || ""}:${end_date || ""}:${FINMIND_TOKEN ? "T" : "N"}`;
  const cached = cache.get(key);
  if (cached) return cached;

  if (FINMIND_TOKEN) {
    try {
      const resp = await axios.get("https://api.finmindtrade.com/api/v4/data", {
        params: {
          dataset,
          ...(stock_id ? { stock_id } : {}),
          ...(data_id ? { data_id } : {}),
          ...(start_date ? { start_date } : {}),
          ...(end_date ? { end_date } : {}),
        },
        headers: { Authorization: `Bearer ${FINMIND_TOKEN}`, "User-Agent": "Mozilla/5.0" },
        timeout: 15000,
      });
      const data = resp.data?.data || [];
      cache.set(key, data, 60 * 30);
      return data;
    } catch (_) {
      // fallback v3
    }
  }

  const resp = await axios.get("https://api.finmindtrade.com/api/v3/data", {
    params: {
      dataset,
      ...(stock_id ? { stock_id } : {}),
      ...(data_id ? { data_id } : {}),
      ...(start_date ? { start_date } : {}),
      ...(end_date ? { end_date } : {}),
      ...(FINMIND_TOKEN ? { token: FINMIND_TOKEN } : {}),
    },
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 15000,
  });

  const data = resp.data?.data || [];
  cache.set(key, data, 60 * 30);
  return data;
}

async function finmindGetStockInfoMap() {
  const key = `finmind:TaiwanStockInfo:map:${FINMIND_TOKEN ? "T" : "N"}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const rows = await finmindFetch({ dataset: "TaiwanStockInfo" });
    const map = new Map();
    for (const r of rows) {
      const sid = String(r.stock_id || "").trim();
      if (!sid) continue;
      map.set(sid, {
        stock_name: String(r.stock_name || "").trim(),
        industry_category: String(r.industry_category || "").trim(),
        type: String(r.type || "").trim(),
      });
    }
    cache.set(key, map, 60 * 60 * 6);
    return map;
  } catch (_) {
    const empty = new Map();
    cache.set(key, empty, 60 * 10);
    return empty;
  }
}

function isInnovationBoard(finInfo) {
  const t = String(finInfo?.type || "").trim();
  // 常見：創新板 / 創新版 / Innovation Board
  return /創新|創新版|創新板|innovation/i.test(t);
}

// ============== TWSE: 上市日資料（用來做股票池） ==============
// 來源：TWSE STOCK_DAY_ALL
async function fetchTWSEStockDayAll() {
  const key = `twse:stock_day_all`;
  const cached = cache.get(key);
  if (cached) return cached;

  const resp = await axios.get("https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL", {
    params: { response: "json" },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.twse.com.tw/" },
  });

  const data = resp.data?.data || [];
  cache.set(key, data, 60 * 10);
  return data;
}

async function getTopSymbolsByVolume(poolSize, infoMap) {
  const rows = await fetchTWSEStockDayAll();

  // ✅ 正確欄位：
  // [0]代號 [1]名稱 [2]成交股數 [3]成交金額 [4]開盤 [5]最高 [6]最低 [7]收盤 [8]漲跌 [9]成交筆數
  const list = rows
    .map(r => ({
      symbol: String(r?.[0] || "").trim(),
      name: String(r?.[1] || "").trim(),
      volume: toNum(r?.[2]),
      close: toNum(r?.[7]),       // ✅ 修正：收盤在 [7]
    }))
    .filter(x => /^\d{4}$/.test(x.symbol)) // 只留一般股票（排除 0050 ETF 這種）
    .filter(x => x.volume > MIN_LIQ_SHARES && x.close > MIN_PRICE)
    .filter(x => {
      const finInfo = infoMap.get(x.symbol);
      if (!finInfo) return true;            // 沒資料就先放行
      return !isInnovationBoard(finInfo);   // ✅ 排除創新板/創新版
    })
    .sort((a, b) => b.volume - a.volume)
    .slice(0, poolSize);

  return list; // 含 symbol/name/volume/close
}

// ============== Yahoo（價量技術面主來源） ==============
async function fetchYahoo(symbol, range = "6mo", interval = "1d") {
  const key = `yahoo:${symbol}:${range}:${interval}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW`;
  const resp = await axios.get(url, {
    params: { range, interval, includePrePost: false, events: "div,splits" },
    timeout: 15000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo chart no result for ${symbol}`);

  const metaName = r.meta?.shortName || r.meta?.longName || "";
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};

  const closes = (q.close || []).map(toNum);
  const opens  = (q.open  || []).map(toNum);
  const highs  = (q.high  || []).map(toNum);
  const lows   = (q.low   || []).map(toNum);
  const vols   = (q.volume|| []).map(toNum);

  const bars = ts.map((t, i) => ({
    t,
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: opens[i],
    high: highs[i],
    low: lows[i],
    close: closes[i],
    volume: vols[i],
  })).filter(b => b.close > 0);

  const out = { symbol, name: metaName, bars };
  cache.set(key, out, 60 * 30);
  return out;
}

// ============== TWSE T86（中文名 + 三大法人） ==============
async function fetchTWSE_T86(dateYYYYMMDD) {
  const key = `twse:t86:${dateYYYYMMDD}:raw`;
  const cached = cache.get(key);
  if (cached) return cached;

  const resp = await axios.get("https://www.twse.com.tw/fund/T86", {
    params: { response: "json", date: dateYYYYMMDD, selectType: "ALLBUT0999" },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.twse.com.tw/" },
  });

  const data = resp.data?.data || [];
  cache.set(key, data, 60 * 30);
  return data;
}

function parseT86Row(row) {
  const symbol = String(row?.[0] || "").trim();
  if (!/^\d{4}$/.test(symbol)) return null;
  return {
    symbol,
    name: String(row?.[1] || "").trim(),
    foreignNet: toNum(row?.[4]),
    trustNet: toNum(row?.[7]),
    dealerNet: toNum(row?.[10]),
  };
}

async function getT86Map(dateYYYYMMDD) {
  const key = `twse:t86:${dateYYYYMMDD}:map`;
  const cached = cache.get(key);
  if (cached) return cached;

  const rows = await fetchTWSE_T86(dateYYYYMMDD);
  const map = new Map();
  for (const r of rows) {
    const pr = parseT86Row(r);
    if (!pr) continue;
    map.set(pr.symbol, pr);
  }
  cache.set(key, map, 60 * 30);
  return map;
}

async function getRecentTradingDates(n, endDate = new Date()) {
  const dates = [];
  const d = new Date(endDate);
  for (let tries = 0; tries < 60 && dates.length < n; tries++) {
    const ds = yyyymmdd(d);
    try {
      const rows = await fetchTWSE_T86(ds);
      if (Array.isArray(rows) && rows.length > 0) dates.push(ds);
    } catch (_) {}
    d.setDate(d.getDate() - 1);
    await sleep(30);
  }
  return dates;
}

async function getInstitutionStats(symbol, windowDays = 10, endDate = new Date()) {
  const dates = await getRecentTradingDates(windowDays, endDate);

  const series = [];
  let nameFromT86 = "";

  for (const ds of dates) {
    const map = await getT86Map(ds);
    const found = map.get(symbol) || null;
    if (!nameFromT86 && found?.name) nameFromT86 = found.name;

    series.push({
      date: ds,
      foreignNet: found ? found.foreignNet : 0,
      trustNet: found ? found.trustNet : 0,
      dealerNet: found ? found.dealerNet : 0,
    });
  }

  const sumForeign = series.reduce((a, x) => a + x.foreignNet, 0);
  const sumTrust   = series.reduce((a, x) => a + x.trustNet, 0);
  const sumDealer  = series.reduce((a, x) => a + x.dealerNet, 0);
  const sumTotal   = sumForeign + sumTrust + sumDealer;

  const totalNetArr = series.map(x => x.foreignNet + x.trustNet + x.dealerNet);
  let buyStreak = 0; for (const v of totalNetArr) { if (v > 0) buyStreak++; else break; }
  let sellStreak = 0; for (const v of totalNetArr) { if (v < 0) sellStreak++; else break; }

  return {
    windowDays,
    dates,
    series,
    nameFromT86,
    sumForeign, sumTrust, sumDealer, sumTotal,
    buyStreak, sellStreak,
    latestTotalNet: totalNetArr[0] || 0,
  };
}

// ============== FinMind 籌碼 ==============
async function finmindGetMarginStats(symbol, lookbackDays = 35) {
  if (!FINMIND_TOKEN) return null;
  try {
    const start = dateDaysAgo(lookbackDays);
    const end = ymd(new Date());

    const rows = await finmindFetch({
      dataset: "TaiwanStockMarginPurchaseShortSale",
      data_id: symbol,
      start_date: start,
      end_date: end,
    });

    const sorted = (rows || [])
      .map(r => ({ ...r, date: String(r.date || r.Date || "").slice(0, 10) }))
      .filter(r => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (sorted.length < 3) return null;

    const mpKeys = ["MarginPurchaseTodayBalance","MarginPurchaseBalance","MarginPurchase"];
    const ssKeys = ["ShortSaleTodayBalance","ShortSaleBalance","ShortSale"];

    const last = findLatestValidRow(sorted, (r) => {
      const mp = toNum(pickFirst(r, mpKeys, 0));
      const ss = toNum(pickFirst(r, ssKeys, 0));
      return mp !== 0 || ss !== 0;
    });
    if (!last) return null;

    const lastMp = toNum(pickFirst(last, mpKeys, 0));
    const lastSs = toNum(pickFirst(last, ssKeys, 0));

    const tail = sorted.slice(Math.max(0, sorted.length - 12));
    const mpArr = tail.map(r => toNum(pickFirst(r, mpKeys, 0)));
    const ssArr = tail.map(r => toNum(pickFirst(r, ssKeys, 0)));

    const firstMp = mpArr[0] ?? 0;
    const mpDelta = lastMp - firstMp;

    let incStreak = 0;
    for (let i = mpArr.length - 1; i >= 1; i--) {
      if (mpArr[i] > mpArr[i - 1]) incStreak++;
      else break;
    }

    const firstSs = ssArr[0] ?? 0;
    const ssDelta = lastSs - firstSs;

    const mpHot = (incStreak >= 3) && (firstMp > 0 ? (mpDelta / firstMp) >= 0.05 : mpDelta > 0);

    return { mpDelta, mpIncStreak: incStreak, mpHot, ssDelta, lastDate: last.date };
  } catch (_) {
    return null;
  }
}

async function finmindGetDayTradingStats(symbol, lookbackDays = 35) {
  if (!FINMIND_TOKEN) return null;
  try {
    const start = dateDaysAgo(lookbackDays);
    const end = ymd(new Date());

    let rows = await finmindFetch({
      dataset: "TaiwanStockDayTrading",
      data_id: symbol,
      start_date: start,
      end_date: end,
    });

    if (!rows || rows.length === 0) {
      rows = await finmindFetch({
        dataset: "TaiwanStockDayTrading",
        stock_id: symbol,
        start_date: start,
        end_date: end,
      });
    }

    const sorted = (rows || [])
      .map(r => ({ ...r, date: String(r.date || r.Date || "").slice(0,10) }))
      .filter(r => r.date)
      .sort((a,b) => a.date.localeCompare(b.date));

    if (sorted.length < 1) return null;

    const ratioKeys = [
      "DayTradingRatio","day_trading_ratio","DayTradingVolumeRatio",
      "DayTradingVolumeRatio(%)","dayTradingRatio"
    ];
    const volKeys = [
      "DayTradingVolume","day_trading_volume","DayTradingDealVolume",
      "DayTradingTradingVolume","dayTradingVolume"
    ];
    const amtKeys = ["DayTradingAmount","day_trading_amount","dayTradingAmount"];

    const last = findLatestValidRow(sorted, (r) => {
      const v = pickFirst(r, ratioKeys, null);
      return v != null && String(v).trim() !== "";
    });
    if (!last) return null;

    let ratio = pickFirst(last, ratioKeys, null);
    ratio = ratio == null ? null : toNum(ratio);
    if (ratio != null && ratio > 0 && ratio <= 1) ratio = ratio * 100;

    const vol = toNum(pickFirst(last, volKeys, 0));
    const amount = toNum(pickFirst(last, amtKeys, 0));

    const hot = ratio != null ? ratio >= 35 : false;
    return { ratio, vol, amount, hot, lastDate: last.date };
  } catch (_) {
    return null;
  }
}

// ============== scoring ==============
function scoreStock(bars, inst, finmind = {}) {
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.volume);

  const ma5  = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const rsi14 = rsi(closes, 14);
  const vol20 = sma(vols, 20);
  const atr14 = atr(highs, lows, closes, 14);

  const i = closes.length - 1;
  const lastClose = closes[i];
  const lastMA5 = ma5[i];
  const lastMA20 = ma20[i];
  const lastRSI = rsi14[i];
  const volRatio = (vol20[i] && vol20[i] > 0) ? (vols[i] / vol20[i]) : 1;
  const lastATR = atr14[i];

  const okTrend = !!(lastMA20 && lastMA5 && lastClose > lastMA20 && lastMA5 > lastMA20);
  const okRSI   = lastRSI == null ? true : (lastRSI >= RSI_MIN && lastRSI <= RSI_MAX);
  const okVol   = volRatio >= 1.1;
  const okInst  = inst.sumTotal > 0 && inst.buyStreak >= 3 && inst.latestTotalNet > 0;

  const passed = okTrend && okRSI && okVol && okInst;

  const reasons = [];
  if (!okTrend) reasons.push("均線不強");
  if (!okRSI) reasons.push("RSI不佳");
  if (!okVol) reasons.push("量能不足");
  if (!okInst) reasons.push("法人不穩");

  const instScore = Math.log10(Math.max(1, Math.abs(inst.sumTotal))) * (inst.sumTotal > 0 ? 1 : -1);
  const trendScore = lastMA20 ? (lastClose / lastMA20 - 1) * 100 : 0;
  const volScore = (volRatio - 1) * 10;

  let finAdj = 0;
  if (finmind?.margin?.mpHot) finAdj -= 2.0;
  if (finmind?.daytrade?.hot) finAdj -= 2.0;
  if (finmind?.daytrade?.ratio != null && finmind.daytrade.ratio < 20) finAdj += 0.6;

  const score = instScore * 3.2 + trendScore * 2.2 + volScore + finAdj;

  const atrUse = (lastATR && lastATR > 0) ? lastATR : (lastClose * 0.03);
  const entryLow = lastClose - atrUse * 0.3;
  const entryHigh = lastClose + atrUse * 0.3;
  const stop = lastClose - atrUse * 1.5;
  const tp1 = lastClose + atrUse * 2.0;
  const tp2 = lastClose + atrUse * 3.0;

  const badges = [];
  if (finmind?.margin?.mpHot) badges.push("融資偏熱");
  if (finmind?.daytrade?.hot) badges.push("當沖偏高");

  return {
    passed,
    score,
    signals: {
      lastClose,
      ma5: lastMA5,
      ma20: lastMA20,
      rsi14: lastRSI,
      volRatio,
      atr14: atrUse,
      instSumTotal: inst.sumTotal,
      instBuyStreak: inst.buyStreak,
      instLatestTotalNet: inst.latestTotalNet,
      plan: { entryLow, entryHigh, stop, tp1, tp2 }
    },
    finmindBadges: badges,
    debug: {
      reasons: reasons.length ? reasons.join(" / ") : "PASS",
      okTrend, okRSI, okVol, okInst,
      finAdj
    }
  };
}

// ============== API ==============
app.get("/api/health", async (_, res) => {
  res.json({ ok: true, ts: new Date().toISOString(), finmindEnabled: !!FINMIND_TOKEN });
});

// ✅ 診斷：看股票池到底怎麼被刷掉
app.get("/api/debug/pool", async (_, res) => {
  try {
    const rows = await fetchTWSEStockDayAll();
    const headRaw = rows.slice(0, 3);

    const parsed = rows.map(r => ({
      symbol: String(r?.[0] || "").trim(),
      name: String(r?.[1] || "").trim(),
      volume: toNum(r?.[2]),
      close: toNum(r?.[7]),      // ✅ 修正：收盤在 [7]
      rawVol: r?.[2],
      rawClose: r?.[7],
    })).filter(x => /^\d{4}$/.test(x.symbol));

    const filtered = parsed.filter(x => x.volume > MIN_LIQ_SHARES && x.close > MIN_PRICE);

    res.json({
      ok: true,
      rawCount: rows.length,
      parsedCount: parsed.length,
      filteredCount: filtered.length,
      headRaw,
      headParsed: parsed.slice(0, 5),
      headFiltered: filtered.slice(0, 10),
      thresholds: { MIN_LIQ_SHARES, MIN_PRICE, POOL_SIZE }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// /api/picks?window=10&bucket=all|lt100|100_300|300_600|600_1000|gt1000
app.get("/api/picks", async (req, res) => {
  try {
    const windowDays = Number(req.query.window || 10);
    const bucketKey = String(req.query.bucket || "all");
    const bucket = parseBucket(bucketKey);

    const topK = Math.max(10, Math.min(100, Number(req.query.topK || STAGE2_TOPK_DEFAULT)));

    const infoMap = await finmindGetStockInfoMap();
    const topList = await getTopSymbolsByVolume(POOL_SIZE, infoMap);

    const symbols = topList.map(x => x.symbol);

    // 第一段：Yahoo + 法人
    const firstPass = await mapLimit(symbols, STAGE1_CONCURRENCY, async (sym) => {
      try {
        const [yahoo, inst] = await Promise.all([
          fetchYahoo(sym, "6mo", "1d"),
          getInstitutionStats(sym, windowDays, new Date()),
        ]);

        const bars = yahoo?.bars || [];
        if (!bars || bars.length < 30) return null;

        const finInfo = infoMap.get(sym) || {};
        const dayAllName = (topList.find(x => x.symbol === sym)?.name) || "";
        const displayName =
          (inst.nameFromT86 && inst.nameFromT86.trim())
            ? inst.nameFromT86.trim()
            : (finInfo.stock_name || yahoo.name || dayAllName || "");

        const industry = finInfo.industry_category || "";

        const scored = scoreStock(bars, inst, {}); // stage1 不帶 FinMind

        const item = {
          symbol: sym,
          name: displayName,
          industry,
          score: Number(scored.score.toFixed(4)),
          ...scored.signals,
          passed: scored.passed,
          finmind: { badges: [], margin: null, daytrade: null, enabled: !!FINMIND_TOKEN, stage: "stage1" },
          debug: scored.debug,
          _inst: inst,
          _bars: bars,
        };

        if (!inBucket(item.lastClose, bucket)) return null;
        return item;
      } catch (_) {
        return null;
      }
    });

    const allList0 = firstPass.filter(Boolean);
    allList0.sort((a, b) => b.score - a.score);

    // 第二段：只對前 topK 做 FinMind 佐證
    const topCandidates = allList0.slice(0, topK);
    if (FINMIND_TOKEN && topCandidates.length > 0) {
      const enriched = await mapLimit(topCandidates, STAGE2_CONCURRENCY, async (it) => {
        try {
          const [margin, daytrade] = await Promise.all([
            finmindGetMarginStats(it.symbol, 35),
            finmindGetDayTradingStats(it.symbol, 35),
          ]);

          const rescored = scoreStock(it._bars, it._inst, { margin, daytrade });

          return {
            ...it,
            score: Number(rescored.score.toFixed(4)),
            passed: rescored.passed,
            finmind: { badges: rescored.finmindBadges, margin, daytrade, enabled: true, stage: "stage2" },
            debug: rescored.debug,
          };
        } catch (_) {
          return it;
        }
      });

      const map = new Map(enriched.map(x => [x.symbol, x]));
      for (let i = 0; i < allList0.length; i++) {
        const rep = map.get(allList0[i].symbol);
        if (rep) allList0[i] = rep;
      }
      allList0.sort((a, b) => b.score - a.score);
    }

    // ★負分不推薦：score 必須 > MIN_PICK_SCORE
    const eligibleAll = allList0.filter(x => x.score > MIN_PICK_SCORE);
    eligibleAll.sort((a, b) => b.score - a.score);

    const eligiblePassed = eligibleAll.filter(x => x.passed);
    eligiblePassed.sort((a, b) => b.score - a.score);

    const picks = [];
    const used = new Set();

    for (const x of eligiblePassed) {
      if (picks.length >= 3) break;
      picks.push({ ...stripInternal(x), pickType: "主推" });
      used.add(x.symbol);
    }

    for (const x of eligibleAll) {
      if (picks.length >= 3) break;
      if (used.has(x.symbol)) continue;
      picks.push({ ...stripInternal(x), pickType: "補位", fallbackReason: x.debug?.reasons || "未通過" });
      used.add(x.symbol);
    }

    res.json({
      ok: true,
      pool: {
        type: "TWSE_TOP_VOLUME",
        size: symbols.length,
        note: `上市股票成交量排序取前${POOL_SIZE}（先過濾量>${MIN_LIQ_SHARES}股、收盤>${MIN_PRICE}元、排除創新板/創新版）`
      },
      windowDays,
      bucket: { key: bucketKey, label: bucket.label, min: bucket.min, max: bucket.max },
      finmindEnabled: !!FINMIND_TOKEN,
      finmindStage2TopK: FINMIND_TOKEN ? topK : 0,
      minPickScore: MIN_PICK_SCORE,
      countInBucket: allList0.length,
      countPassedInBucket: eligiblePassed.length,
      picks
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

function stripInternal(item) {
  const { _inst, _bars, ...rest } = item;
  return rest;
}

app.get("/api/stock/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol;
    const windowDays = Number(req.query.window || 10);

    const [yahoo, inst, infoMap, margin, daytrade] = await Promise.all([
      fetchYahoo(symbol, "6mo", "1d"),
      getInstitutionStats(symbol, windowDays, new Date()),
      finmindGetStockInfoMap(),
      finmindGetMarginStats(symbol, 35),
      finmindGetDayTradingStats(symbol, 35),
    ]);

    const bars = yahoo?.bars || [];
    if (!bars || bars.length < 30) return res.json({ ok: false, error: "no bars" });

    const finInfo = infoMap.get(symbol) || {};
    const displayName =
      (inst.nameFromT86 && inst.nameFromT86.trim())
        ? inst.nameFromT86.trim()
        : (finInfo.stock_name || yahoo.name || "");

    const industry = finInfo.industry_category || "";
    const scored = scoreStock(bars, inst, { margin, daytrade });

    res.json({
      ok: true,
      symbol,
      name: displayName,
      industry,
      windowDays,
      ...scored,
      inst,
      finmind: { enabled: !!FINMIND_TOKEN, margin, daytrade }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// 靜態檔 + 首頁
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// 404
app.use((req, res) => res.status(404).send(`Not found: ${req.method} ${req.originalUrl}`));

app.listen(PORT, () => console.log(`✅ server running: http://localhost:${PORT}`));
