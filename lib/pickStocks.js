/**
 * lib/pickStocks.js
 * 穩定版：Yahoo(技術) + TWSE(三大法人, 免額度)
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

// Yahoo 節流
const YAHOO_SLEEP_OK_MS = 80;
const YAHOO_SLEEP_FAIL_MS = 120;

// 法人：取近 N 個交易日摘要（我們用「可抓到的日數」當 windowDays）
const INST_MAX_DAYS = 20;

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
function toInt(x) {
  return Math.trunc(toNum(x));
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
function isHolidayLikeNoDataText(s) {
  const t = String(s || "").trim();
  return !t || t.includes("查無資料") || t.includes("休市") || t.includes("無資料");
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

/* ========== 股票池 ========== */
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
      if (!Array.isArray(r)) {
        return {
          symbol: String(r.Code || "").trim(),
          name: String(r.Name || "").trim(),
          volume: toNum(r.TradeVolume),
          close: toNum(r.ClosingPrice),
        };
      }
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

/* ========== Yahoo 日K（主來源） ========== */
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

/* ========== 法人：TWSE 三大法人（免額度） ========== */
/**
 * TWSE 三大法人買賣超（股）：
 * https://www.twse.com.tw/rwd/zh/fund/T86?response=csv&date=YYYYMMDD&selectType=ALL
 *
 * 這裡我們：
 * - 抓指定 date 的 CSV
 * - parse 出每檔股票的「外資/投信/自營/合計」淨買賣超（股）
 * - 換算成 張（÷1000）
 */
function parseTwseCsv(csvText) {
  const lines = String(csvText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("資料日期") && !l.startsWith("="));

  // CSV 可能混有逗號分隔與引號；這裡用「簡化版」：
  // - 先去掉頭尾引號
  // - 再以 "," 切
  const rows = lines
    .map((l) => l.replace(/^\uFEFF/, "")) // BOM
    .filter((l) => l.includes(",")) // 有逗號才是資料列
    .map((l) => l.replace(/^"|"$/g, ""))
    .map((l) => l.split('","').join(","))
    .map((l) => l.split(","));

  return rows;
}

function pickT86Columns(header) {
  // 嘗試找欄位索引（中文欄名可能略不同）
  const idx = (nameCandidates) =>
    nameCandidates
      .map((n) => header.indexOf(n))
      .find((i) => i >= 0);

  const iCode = idx(["證券代號", "股票代號", "代號"]);
  const iF = idx(["外資及陸資買賣超股數", "外資買賣超股數", "外資(不含自營商)買賣超股數"]);
  const iI = idx(["投信買賣超股數", "投信買賣超"]);
  const iD = idx(["自營商買賣超股數", "自營商(合計)買賣超股數", "自營商買賣超"]);
  const iT = idx(["三大法人買賣超股數", "三大法人買賣超", "合計買賣超股數"]);

  return { iCode, iF, iI, iD, iT };
}

async function fetchTwseT86ByDate(yyyymmdd) {
  const key = `twse:t86:${yyyymmdd}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const url = "https://www.twse.com.tw/rwd/zh/fund/T86";
  const resp = await axios.get(url, {
    params: { response: "csv", date: yyyymmdd, selectType: "ALL" },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.twse.com.tw/" },
  });

  const text = resp.data;
  if (isHolidayLikeNoDataText(text)) {
    cache.set(key, null);
    return null;
  }

  const rows = parseTwseCsv(text);
  if (!rows.length) {
    cache.set(key, null);
    return null;
  }

  // 找 header（通常含「證券代號」）
  const headerRow = rows.find((r) => r.includes("證券代號")) || rows[0];
  const { iCode, iF, iI, iD, iT } = pickT86Columns(headerRow);

  // 若抓不到代號欄，視為失敗
  if (iCode == null || iCode < 0) {
    cache.set(key, null);
    return null;
  }

  const map = new Map();

  for (const r of rows) {
    const code = String(r[iCode] || "").trim();
    if (!/^\d{4}$/.test(code)) continue;

    const foreign = iF != null && iF >= 0 ? toInt(r[iF]) : 0;
    const trust = iI != null && iI >= 0 ? toInt(r[iI]) : 0;
    const dealer = iD != null && iD >= 0 ? toInt(r[iD]) : 0;
    const total = iT != null && iT >= 0 ? toInt(r[iT]) : (foreign + trust + dealer);

    map.set(code, { foreign, trust, dealer, total });
  }

  const out = { date: yyyymmdd, map };
  cache.set(key, out);
  return out;
}

function toYyyymmdd(yyyy_mm_dd) {
  return String(yyyy_mm_dd || "").replace(/-/g, "");
}

async function fetchInstFromTwse(stockId, asOfDate) {
  // 從 asOfDate 往前找最多 14 天，收集最近 INST_MAX_DAYS 個有資料的交易日
  const outDays = [];
  const byDay = [];

  const base = new Date(asOfDate + "T00:00:00Z");
  for (let back = 0; back <= 14; back++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - back);
    const yyyymmdd = toYyyymmdd(ymd(d));

    const t86 = await fetchTwseT86ByDate(yyyymmdd);
    if (!t86 || !t86.map) continue;

    const row = t86.map.get(stockId);
    if (!row) continue;

    byDay.push({ date: yyyymmdd, ...row });
    outDays.push(yyyymmdd);

    if (byDay.length >= INST_MAX_DAYS) break;
    await sleep(60); // 節流，避免打太快
  }

  if (!byDay.length) return null;

  // 最新日
  const latest = byDay[0]; // 因為 back 從 0 往前，第一筆是最新
  // window（近N日）
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

  // 連買 streak（合計淨買 >0）
  let buyStreak = 0;
  for (const d of window) {
    if ((d.total ?? 0) > 0) buyStreak++;
    else break;
  }

  const toLots = (shares) => Math.round(shares / 1000);

  return {
    windowDays: window.length,
    asOfDate: asOfDate,
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
    source: "TWSE T86 (csv)",
  };
}

/* ========== 評分 + 詳情 ========== */
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

/* ========== 主流程 ========== */
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

      scored.push({
        symbol: p.symbol,
        name: p.name,
        lastClose: s.lastClose,
        ma5: s.ma5,
        ma20: s.ma20,
        rsi14: s.rsi14,
        volRatio: s.volRatio,
        atr14: s.atr14,
        plan: buildPlan(s.lastClose, s.atr14),
        asOfDataDate: s.asOfDataDate,
        score: +s.score.toFixed(4),
        passed: s.passed,
        tradeStyle: "基準版(穩定)",
      });

      await sleep(YAHOO_SLEEP_OK_MS);
    } catch {
      await sleep(YAHOO_SLEEP_FAIL_MS);
    }
  }

  scored.sort((a, b) => b.score - a.score);

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

  // 法人（TWSE）
  for (const p of picks) {
    try {
      p.inst = await fetchInstFromTwse(p.symbol, p.asOfDataDate);
    } catch {
      p.inst = null;
    }
  }

  return {
    market: "TW",
    generatedAt: generatedAt || new Date().toISOString(),
    topN: 3,
    picks,
    meta: {
      pool: { size: pool.length, POOL_SIZE, MIN_LIQ_SHARES, MIN_PRICE },
      dataSource: "Yahoo(tech) + TWSE(T86 inst)",
    },
  };
}

module.exports = { pickStocks };
