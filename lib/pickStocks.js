/**
 * lib/pickStocks.js
 * 台股精選 - 起漲版
 * - 技術面：Yahoo Finance 日K（MA/RSI/量比/ATR）
 * - 法人：TWSE T86 JSON（三大法人買賣超）→ 換算張
 * - 不依賴 FinMind（避免 402 額度上限）
 *
 * 起漲版重點：
 * 1) RSI 提前：48 ~ 70
 * 2) 量比不再偏好爆量後段股（cap）
 * 3) 均線條件放寬到「接近起漲」
 * 4) 新增近 5 日前高突破
 * 5) 排除近 3 日已經漲太多的股票
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 10 });

/* =======================
   參數（起漲版）
======================= */
const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000;
const MIN_PRICE = 10;

const RSI_MIN = 48;
const RSI_MAX = 70;

const MIN_PICK_SCORE = 0;

const INST_MAX_DAYS = 20;   // 法人近 N 日摘要
const INST_LOOKBACK = 45;   // 法人回溯最多幾天（封關/長假用）

// Yahoo 節流
const YAHOO_SLEEP_OK_MS = 80;
const YAHOO_SLEEP_FAIL_MS = 120;

// 起漲版參數
const VOL_RATIO_MIN = 1.15;
const VOL_RATIO_CAP = 3.0;
const RECENT_HIGH_LOOKBACK = 5;   // 近5日前高突破
const RECENT_RUNUP_3D_MAX = 0.12; // 近3日漲幅超過12% 視為太後段
const MA_TOL = 0.995;             // 接近 MA20 即可
const TRUST_SUM_MIN = -1000;      // C方案：投信不能明顯大賣
const TRUST_LATEST_MIN = -200;    // C方案：當日投信不能明顯大賣
const FOREIGN_SUM_MIN = -2000;    // 外資不能大砍

/* =======================
   工具
======================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");

function ymd(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function toYyyymmdd(yyyy_mm_dd) {
  return String(yyyy_mm_dd || "").replace(/-/g, "");
}

function toNum(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const s = String(x).replace(/,/g, "").trim();
  if (!s || s === "--") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function toInt(x) {
  return Math.trunc(toNum(x));
}

function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return 0;
  return (b - a) / a;
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
   TWSE 股票池
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
        symbol: String(r.Code || "").trim(),
        name: String(r.Name || "").trim(),
        volume: toNum(r.TradeVolume),
        close: toNum(r.ClosingPrice),
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
   Yahoo 日K（主來源）
======================= */
async function fetchBarsYahoo(stockId) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${stockId}.TW`;
  const resp = await axios.get(url, {
    params: { range: "6mo", interval: "1d" },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) return null;

  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};

  const bars = ts
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: toNum(q.open?.[i]),
      high: toNum(q.high?.[i]),
      low: toNum(q.low?.[i]),
      close: toNum(q.close?.[i]),
      volume: toNum(q.volume?.[i]),
    }))
    .filter((b) => b.close > 0);

  return bars.length >= 30 ? bars : null;
}

/* =======================
   法人：TWSE T86（JSON版，免額度）
======================= */
async function fetchTwseT86ByDate(yyyymmdd) {
  const key = `twse:t86json:${yyyymmdd}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const url = "https://www.twse.com.tw/rwd/zh/fund/T86";
  try {
    const resp = await axios.get(url, {
      params: { response: "json", date: yyyymmdd, selectType: "ALL" },
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.twse.com.tw/",
        Accept: "application/json,text/plain,*/*",
      },
    });

    const j = resp.data;
    const stat = String(j?.stat || "");
    if (stat !== "OK") {
      cache.set(key, null);
      return null;
    }

    const fields = j?.fields || [];
    const data = j?.data || [];
    if (!Array.isArray(fields) || !Array.isArray(data) || data.length === 0) {
      cache.set(key, null);
      return null;
    }

    const idx = (cands) =>
      cands.map((n) => fields.indexOf(n)).find((i) => i >= 0);

    const iCode = idx(["證券代號", "代號", "股票代號"]);
    const iF = idx([
      "外資及陸資買賣超股數(不含外資自營商)",
      "外資及陸資買賣超股數",
      "外資買賣超股數",
    ]);
    const iI = idx(["投信買賣超股數", "投信買賣超"]);
    const iD = idx(["自營商買賣超股數", "自營商(合計)買賣超股數"]);
    const iT = idx(["三大法人買賣超股數", "合計買賣超股數", "三大法人買賣超"]);

    if (iCode == null) {
      cache.set(key, null);
      return null;
    }

    const map = new Map();
    for (const row of data) {
      const code = String(row[iCode] || "").trim();
      if (!/^\d{4}$/.test(code)) continue;

      const foreign = iF != null ? toInt(row[iF]) : 0;
      const trust = iI != null ? toInt(row[iI]) : 0;
      const dealer = iD != null ? toInt(row[iD]) : 0;
      const total = iT != null ? toInt(row[iT]) : foreign + trust + dealer;

      map.set(code, { foreign, trust, dealer, total });
    }

    const out = { date: yyyymmdd, map };
    cache.set(key, out);
    return out;
  } catch {
    cache.set(key, null);
    return null;
  }
}

async function fetchInstFromTwse(stockId, asOfDate) {
  const base = new Date(asOfDate + "T00:00:00Z");
  const byDay = [];

  for (let back = 0; back <= INST_LOOKBACK; back++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - back);

    const yyyymmdd = toYyyymmdd(ymd(d));
    const t86 = await fetchTwseT86ByDate(yyyymmdd);
    if (!t86 || !t86.map) continue;

    const row = t86.map.get(stockId);
    if (!row) continue;

    byDay.push({ date: yyyymmdd, ...row });
    if (byDay.length >= INST_MAX_DAYS) break;

    await sleep(80);
  }

  if (!byDay.length) return null;

  const latest = byDay[0];
  const window = byDay;

  const sum = window.reduce(
    (acc, x) => {
      acc.foreign += x.foreign;
      acc.trust += x.trust;
      acc.dealer += x.dealer;
      acc.total += x.total;
      return acc;
    },
    { foreign: 0, trust: 0, dealer: 0, total: 0 }
  );

  let buyStreak = 0;
  for (const d of window) {
    if ((d.total ?? 0) > 0) buyStreak++;
    else break;
  }

  const toLots = (shares) => Math.round(shares / 1000);

  return {
    windowDays: window.length,
    asOfDate,
    latestDate: latest.date,
    sumTotal: toLots(sum.total),
    sumForeign: toLots(sum.foreign),
    sumTrust: toLots(sum.trust),
    sumDealer: toLots(sum.dealer),
    buyStreak,
    latestTotalNet: toLots(latest.total),
    latestForeignNet: toLots(latest.foreign),
    latestTrustNet: toLots(latest.trust),
    latestDealerNet: toLots(latest.dealer),
    unit: "張",
    source: "TWSE T86 (json)",
  };
}

/* =======================
   評分 + 詳細欄位（起漲版核心）
======================= */
function scoreAndDetails(bars) {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const vols = bars.map((b) => b.volume);

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const rsi14v = rsi(closes, 14);
  const vol20 = sma(vols, 20);
  const atr14v = atr(highs, lows, closes, 14);

  const i = closes.length - 1;

  const lastClose = closes[i];
  const lastMA5 = ma5[i];
  const lastMA20 = ma20[i];
  const lastRSI = rsi14v[i];
  const lastATR = atr14v[i];
  const volRatioRaw = vol20[i] && vol20[i] > 0 ? vols[i] / vol20[i] : null;
  const volRatioCapped = volRatioRaw != null ? Math.min(volRatioRaw, VOL_RATIO_CAP) : null;

  // 起漲版：接近黃金交叉即可
  const okTrend =
    lastMA20 &&
    lastMA5 &&
    lastClose >= lastMA20 * MA_TOL &&
    lastMA5 >= lastMA20 * MA_TOL;

  // 起漲版：RSI 提前
  const okRSI =
    lastRSI == null ? true : lastRSI >= RSI_MIN && lastRSI <= RSI_MAX;

  // 起漲版：有量但不要只看爆量
  const okVol = volRatioRaw == null ? false : volRatioRaw >= VOL_RATIO_MIN;

  // 起漲版：突破近 5 日前高（不含今日）
  const recentSlice = closes.slice(Math.max(0, i - RECENT_HIGH_LOOKBACK), i);
  const recentHigh = recentSlice.length ? Math.max(...recentSlice) : lastClose;
  const okBreakout = lastClose > recentHigh;

  // 起漲版：近 3 日若已漲太多，視為後段
  const close3dAgo = closes[i - 3];
  const runup3d = pctChange(close3dAgo, lastClose);
  const notTooLate = runup3d <= RECENT_RUNUP_3D_MAX;

  const passed = okTrend && okRSI && okVol && okBreakout && notTooLate;

  // 分數設計：偏向剛啟動，而不是已經衝太久
  const trendScore = lastMA20 ? ((lastClose / lastMA20 - 1) * 100) * 1.8 : 0;
  const volScore = volRatioCapped != null ? (volRatioCapped - 1) * 6 : 0;
  const breakoutScore = okBreakout ? 4.0 : 0;
  const latePenalty = !notTooLate ? -6.0 : 0;

  const score = trendScore + volScore + breakoutScore + latePenalty;

  return {
    passed,
    score,
    lastClose,
    ma5: lastMA5,
    ma20: lastMA20,
    rsi14: lastRSI,
    volRatio: volRatioRaw,
    volRatioCapped,
    atr14: lastATR,
    breakout: okBreakout,
    recentHigh,
    runup3dPct: Number((runup3d * 100).toFixed(2)),
    asOfDataDate: bars[i].date,
  };
}

function buildPlan(price, atrV) {
  const atrUse = atrV && atrV > 0 ? atrV : price * 0.03;
  return {
    entryLow: +(price - atrUse * 0.25).toFixed(2),
    entryHigh: +(price + atrUse * 0.20).toFixed(2),
    stop: +(price - atrUse * 1.4).toFixed(2),
    tp1: +(price + atrUse * 1.8).toFixed(2),
    tp2: +(price + atrUse * 2.8).toFixed(2),
  };
}

/* =======================
   主流程
======================= */
async function pickStocks({ generatedAt } = {}) {
  const rows = await fetchTWSEStockDayAll();
  const pool = buildPool(rows);

  const scored = [];

  for (const p of pool) {
    try {
      const bars = await fetchBarsYahoo(p.symbol);

      if (!bars) {
        await sleep(YAHOO_SLEEP_FAIL_MS);
        continue;
      }

      const s = scoreAndDetails(bars);
      if (s.score <= MIN_PICK_SCORE) {
        await sleep(YAHOO_SLEEP_OK_MS);
        continue;
      }

      const inst = await fetchInstFromTwse(p.symbol, s.asOfDataDate);

      scored.push({
        symbol: p.symbol,
        name: p.name,

        lastClose: s.lastClose,
        ma5: s.ma5,
        ma20: s.ma20,
        rsi14: s.rsi14,
        volRatio: s.volRatio,
        volRatioCapped: s.volRatioCapped,
        atr14: s.atr14,
        breakout: s.breakout,
        recentHigh: s.recentHigh,
        runup3dPct: s.runup3dPct,
        plan: buildPlan(s.lastClose, s.atr14),

        asOfDataDate: s.asOfDataDate,

        score: +s.score.toFixed(4),
        passed: s.passed,
        tradeStyle: "起漲版",
        inst,
      });

      await sleep(YAHOO_SLEEP_OK_MS);
    } catch {
      await sleep(YAHOO_SLEEP_FAIL_MS);
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // 起漲版仍保留 TOP3 補滿邏輯
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

  return {
    market: "TW",
    generatedAt: generatedAt || new Date().toISOString(),
    topN: 3,
    picks,
    // 讓 generate_today 可以直接拿更大的候選池來做二次排序
    candidates: scored,
    meta: {
      pool: { size: pool.length, POOL_SIZE, MIN_LIQ_SHARES, MIN_PRICE },
      dataSource: "Yahoo(tech) + TWSE(T86 inst json)",
      mode: "起漲版",
    },
  };
}

module.exports = { pickStocks };
