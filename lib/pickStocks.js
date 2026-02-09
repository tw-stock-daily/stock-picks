/**
 * lib/pickStocks.js
 * 真・選股引擎（補齊 App 所需 detail + 價格帶 + 法人張數 + 最近交易日）
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 10 });

/* =======================
   參數（保留你目前設定）
======================= */
const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000;
const MIN_PRICE = 10;

const RSI_MIN = 50;
const RSI_MAX = 82;

const MIN_PICK_SCORE = 0;

// 價格帶：對齊 app.html 的 bucket
const PRICE_BUCKETS = [
  { key: "lt100", label: "100 以內", min: 0, max: 100, take: 3 },
  { key: "100_300", label: "100 ~ 300", min: 100, max: 300, take: 3 },
  { key: "300_600", label: "300 ~ 600", min: 300, max: 600, take: 3 },
  { key: "600_1000", label: "600 ~ 1000", min: 600, max: 1000, take: 3 },
  { key: "gt1000", label: "1000 以上", min: 1000, max: Infinity, take: 3 },
];

/* =======================
   工具
======================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");

function ymd(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
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
function subtractDays(ymdStr, days) {
  const d = new Date(ymdStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}
function roundInt(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n);
}
function sharesToLots(vShares) {
  // 股數 -> 張數（1張=1000股），保留正負號，四捨五入到整張
  if (vShares == null || !Number.isFinite(vShares)) return null;
  return Math.round(vShares / 1000);
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
   TWSE 股票池（雙來源）
======================= */
async function fetchTWSEStockDayAll() {
  const key = "twse:stock_day_all";
  const cached = cache.get(key);
  if (cached) return cached;

  const headers = { "User-Agent": "Mozilla/5.0" };

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
   Yahoo 日K（6mo）
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
   FinMind 三大法人（T86）
   dataset: TaiwanStockInstitutionalInvestorsBuySell
   欄位 buy/sell 為股數 -> 我們輸出轉成張
======================= */
const FINMIND_TOKEN = process.env.FINMIND_TOKEN;
async function fetchFinMindT86(stockId, startDate, endDate) {
  if (!FINMIND_TOKEN) {
    throw new Error("Missing FINMIND_TOKEN env (GitHub Secrets).");
  }

  const key = `finmind:t86:${stockId}:${startDate}:${endDate}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const url = "https://api.finmindtrade.com/api/v4/data";
  const headers = { Authorization: `Bearer ${FINMIND_TOKEN}` };
  const params = {
    dataset: "TaiwanStockInstitutionalInvestorsBuySell",
    data_id: stockId,
    start_date: startDate,
    end_date: endDate,
  };

  const resp = await axios.get(url, { headers, params, timeout: 20000 });
  const data = resp.data?.data || [];
  cache.set(key, data);
  return data;
}

function summarizeT86(rows, windowDays = 10) {
  // rows: [{date, stock_id, buy, name, sell}, ...]  (股數)
  if (!Array.isArray(rows) || rows.length === 0) return null;

  // 依日期分組
  const byDate = new Map();
  for (const r of rows) {
    const d = r.date;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }

  const dates = Array.from(byDate.keys()).sort(); // ASC
  const lastDates = dates.slice(-windowDays);

  // 將一日的各類別淨買賣（股數）整理
  function dayAgg(dayRows) {
    const netByName = new Map();
    for (const rr of dayRows) {
      const name = rr.name;
      const net = toNum(rr.buy) - toNum(rr.sell);
      netByName.set(name, (netByName.get(name) || 0) + net);
    }
    // 分組：外資/投信/自營（自營含 Dealer_self + Dealer_Hedging）
    const foreign =
      (netByName.get("Foreign_Investor") || 0) +
      (netByName.get("Foreign_Dealer_Self") || 0);

    const trust = netByName.get("Investment_Trust") || 0;

    const dealer =
      (netByName.get("Dealer_self") || 0) +
      (netByName.get("Dealer_Hedging") || 0);

    const total = foreign + trust + dealer;
    return { foreign, trust, dealer, total };
  }

  let sumForeign = 0, sumTrust = 0, sumDealer = 0, sumTotal = 0;

  // 最新一日
  const latestDate = dates[dates.length - 1];
  const latestAgg = dayAgg(byDate.get(latestDate));

  // window 累計
  for (const d of lastDates) {
    const agg = dayAgg(byDate.get(d));
    sumForeign += agg.foreign;
    sumTrust += agg.trust;
    sumDealer += agg.dealer;
    sumTotal += agg.total;
  }

  // 連買：從最新日往回，連續 total > 0 的天數
  let buyStreak = 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    const d = dates[i];
    const agg = dayAgg(byDate.get(d));
    if (agg.total > 0) buyStreak++;
    else break;
  }

  // 轉成「張」
  return {
    windowDays,
    sumTotal: sharesToLots(sumTotal),
    sumForeign: sharesToLots(sumForeign),
    sumTrust: sharesToLots(sumTrust),
    sumDealer: sharesToLots(sumDealer),
    buyStreak,
    latestTotalNet: sharesToLots(latestAgg.total),
    latestDate,
    unit: "lots",
  };
}

/* =======================
   評分 + 產出 App 所需指標
======================= */
function scoreStock(bars) {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const vols = bars.map((b) => b.volume);

  const ma5Arr = sma(closes, 5);
  const ma20Arr = sma(closes, 20);
  const rsi14Arr = rsi(closes, 14);
  const vol20Arr = sma(vols, 20);
  const atr14Arr = atr(highs, lows, closes, 14);

  const i = closes.length - 1;
  const lastClose = closes[i];
  const lastMA5 = ma5Arr[i];
  const lastMA20 = ma20Arr[i];
  const lastRSI = rsi14Arr[i];
  const lastATR = atr14Arr[i];
  const volRatio = vol20Arr[i] && vol20Arr[i] > 0 ? vols[i] / vol20Arr[i] : 1;
  const dataDate = bars[i]?.date || null;

  const okTrend = lastMA20 && lastMA5 && lastClose > lastMA20 && lastMA5 > lastMA20;
  const okRSI = lastRSI == null ? true : lastRSI >= RSI_MIN && lastRSI <= RSI_MAX;
  const okVol = volRatio >= 1.1;

  const passed = okTrend && okRSI && okVol;

  const score =
    (lastMA20 ? ((lastClose / lastMA20 - 1) * 100) : 0) * 2 +
    (volRatio - 1) * 10;

  return {
    passed,
    score,
    dataDate,
    lastClose,
    ma5: lastMA5,
    ma20: lastMA20,
    rsi14: lastRSI,
    volRatio,
    atr14: lastATR,
  };
}

function buildPlan(lastClose, atr14) {
  if (!Number.isFinite(lastClose) || lastClose <= 0) return null;
  const atrv = Number.isFinite(atr14) && atr14 > 0 ? atr14 : lastClose * 0.03;

  // 以 ATR 做「保守波段」區間（你之後可再細調）
  const entryHigh = lastClose - 0.2 * atrv;
  const entryLow = lastClose - 0.6 * atrv;
  const stop = entryLow - 0.8 * atrv;
  const tp1 = lastClose + 1.0 * atrv;
  const tp2 = lastClose + 1.8 * atrv;

  return {
    entryLow: round2(entryLow),
    entryHigh: round2(entryHigh),
    stop: round2(stop),
    tp1: round2(tp1),
    tp2: round2(tp2),
  };
}

function inBucket(price, bucket) {
  return price >= bucket.min && price < bucket.max;
}

/* =======================
   主流程
======================= */
async function pickStocks(opts = {}) {
  const rows = await fetchTWSEStockDayAll();
  const pool = buildPool(rows);

  const generatedAt = opts.generatedAt || new Date().toISOString();
  const tradeStyle = opts.tradeStyle || "波段";

  if (!pool || pool.length === 0) {
    return {
      market: "TW",
      generatedAt,
      topN: 3,
      picks: [],
      meta: {
        pool: { size: 0, POOL_SIZE, MIN_LIQ_SHARES, MIN_PRICE },
      },
    };
  }

  // Stage 1：只用 Yahoo 做技術評分（不要在這裡抓法人，太慢）
  const scored = [];
  let globalDataDate = null;

  for (const p of pool) {
    try {
      const bars = await fetchYahoo(p.symbol);
      if (!bars || bars.length < 30) continue;

      const s = scoreStock(bars);
      if (s.score <= MIN_PICK_SCORE) continue;

      if (s.dataDate && (!globalDataDate || s.dataDate > globalDataDate)) {
        globalDataDate = s.dataDate;
      }

      scored.push({
        symbol: p.symbol,
        name: p.name,
        score: Number(s.score.toFixed(4)),
        passed: s.passed,

        // ✅ App 需要的技術欄位
        lastClose: round2(s.lastClose),
        ma5: round2(s.ma5),
        ma20: round2(s.ma20),
        rsi14: s.rsi14 == null ? null : round2(s.rsi14),
        volRatio: round2(s.volRatio),

        // 後續 plan 會用
        _atr14: s.atr14 == null ? null : s.atr14,
        _dataDate: s.dataDate || null,
      });

      await sleep(30); // 避免 Yahoo 限流
    } catch (_) {}
  }

  scored.sort((a, b) => b.score - a.score);

  // TOP3（先 passed，再補位）
  const passedList = scored.filter((x) => x.passed);

  const topPicks = [];
  for (const x of passedList) {
    if (topPicks.length >= 3) break;
    topPicks.push({ ...x, reason: "主推" });
  }
  for (const x of scored) {
    if (topPicks.length >= 3) break;
    if (topPicks.find((p) => p.symbol === x.symbol)) continue;
    topPicks.push({ ...x, reason: "補位" });
  }

  // 價格帶（每帶 2~3 檔；這裡用 3）
  const bucketPicks = [];
  for (const bucket of PRICE_BUCKETS) {
    const candidates = scored
      .filter((x) => Number.isFinite(x.lastClose) && inBucket(x.lastClose, bucket))
      .slice(0, bucket.take);

    // 同一價格帶內避免重複，與 TOP3 重複則保留（你說可重複沒關係）
    const seen = new Set();
    for (const c of candidates) {
      if (seen.has(c.symbol)) continue;
      seen.add(c.symbol);
      bucketPicks.push({ ...c, reason: `價格帶：${bucket.label}` });
    }
  }

  // 合併：TOP3 在前，其餘在後
  const combined = [...topPicks, ...bucketPicks];

  // Stage 2：只對「要輸出」的 picks 抓法人 & 計畫（數量少才不會爆 API）
  // 法人取最近 30 天，windowDays=10
  const enriched = [];
  for (const p of combined) {
    const dataDate = p._dataDate || globalDataDate; // 用該股最新交易日，或全市場最大值

    let inst = null;
    try {
      if (dataDate) {
        const endDate = dataDate;
        const startDate = subtractDays(endDate, 40); // 保守抓 40 天，避免假日
        const rowsT86 = await fetchFinMindT86(p.symbol, startDate, endDate);
        const sum = summarizeT86(rowsT86, 10);
        if (sum) inst = sum;
      }
    } catch (_) {
      inst = null;
    }

    const plan = buildPlan(Number(p.lastClose), p._atr14);

    enriched.push({
      symbol: p.symbol,
      name: p.name,
      score: p.score,
      passed: p.passed,
      reason: p.reason,

      tradeStyle,

      // ✅ 技術欄位（App 直接讀）
      lastClose: p.lastClose ?? null,
      ma5: p.ma5 ?? null,
      ma20: p.ma20 ?? null,
      rsi14: p.rsi14 ?? null,
      volRatio: p.volRatio ?? null,

      // ✅ 計畫 / 法人（App 直接讀）
      plan: plan || null,
      inst: inst || null,

      // ✅ 額外放 meta 用（不影響前端）
      dataDate: dataDate || null,
    });
  }

  return {
    market: "TW",
    generatedAt,
    topN: 3,
    picks: enriched,
    meta: {
      dataDate: globalDataDate || null, // ✅ 最近交易日（用來解決假日無資料）
      pool: {
        size: pool.length,
        POOL_SIZE,
        MIN_LIQ_SHARES,
        MIN_PRICE,
      },
      priceBuckets: PRICE_BUCKETS.map((b) => ({ key: b.key, label: b.label, take: b.take })),
    },
  };
}

module.exports = { pickStocks };
