/**
 * lib/pickStocks.js
 * 台股精選：選股引擎（短中期 3天~4週）
 *
 * 做到：
 * - 股票池：TWSE STOCK_DAY_ALL（流動性+價格）
 * - 產業比重：電子/電機/IC 90%，其他 10%（FinMind TaiwanStockInfo）
 * - 技術面：Yahoo 日K（6mo）→ MA/RSI/量比/ATR
 * - 動能：近 3 或 5 日漲幅 >= 5%
 * - 趨勢：lastClose > MA20 且 MA20 上升
 * - 法人：FinMind T86（股數→張）
 * - PBR：FinMind TaiwanStockPER（抓不到不致命）
 *
 * ⚠️ 已移除：120 天接近新高條件（避免 picks=0）
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 10 });

/* =======================
   參數（可再調）
======================= */
const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000;
const MIN_PRICE = 10;

const RSI_MIN = 50;
const RSI_MAX = 82;

const STAGE2_TOPK = 40;      // 第二階段才去抓 FinMind（法人/PBR）
const MIN_PICK_SCORE = 0;

// 產業權重：電子/電機/IC 90%，其他 10%
const ELECTRONICS_RATIO = 0.9;

// 短中期新增條件
const GAIN_3D_OR_5D_MIN = 0.05; // 5%

// 法人統計視窗（交易日）
const INST_WINDOW_DAYS = 20;

/* =======================
   小工具
======================= */
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
function toNumOrNull(x) {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  const s = String(x).replace(/,/g, "").trim();
  if (s === "" || s === "--") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function pickFirst(obj, keys, fallback = null) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return fallback;
}

function isLikelyElectronics(industry) {
  const s = String(industry || "");
  return (
    s.includes("電子") ||
    s.includes("半導體") ||
    s.includes("電腦") ||
    s.includes("通信") ||
    s.includes("光電") ||
    s.includes("IC") ||
    s.includes("電機") ||
    s.includes("網通") ||
    s.includes("資訊") ||
    s.includes("零組件")
  );
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

function buildPoolFromTWSE(rows) {
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
   FinMind API
======================= */
async function finmindGet(dataset, params, token) {
  const url = "https://api.finmindtrade.com/api/v4/data";
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const resp = await axios.get(url, {
    params: { dataset, ...params },
    headers,
    timeout: 25000,
  });
  return resp.data?.data || [];
}

async function fetchFinMindInfoMap(token) {
  const key = "finmind:TaiwanStockInfo";
  const cached = cache.get(key);
  if (cached) return cached;

  const rows = await finmindGet("TaiwanStockInfo", {}, token);
  const map = new Map();
  for (const r of rows) {
    const stock_id = String(r.stock_id || "").trim();
    if (!stock_id) continue;
    map.set(stock_id, {
      type: String(r.type || "").trim(), // twse/tpex/rotc/...
      industry: String(r.industry_category || "").trim(),
      name: String(r.stock_name || "").trim(),
    });
  }
  cache.set(key, map);
  return map;
}

/* =======================
   Yahoo：個股 6mo 日K
======================= */
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

/* =======================
   FinMind：PBR（TaiwanStockPER）
======================= */
async function fetchPBRLatest(stockId, token) {
  if (!token) return { pbr: null, perDate: null };
  try {
    const start = daysAgo(45);
    const rows = await finmindGet(
      "TaiwanStockPER",
      { data_id: stockId, start_date: start },
      token
    );
    if (!rows || rows.length === 0) return { pbr: null, perDate: null };

    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const last = rows[rows.length - 1];
    const pbr = toNumOrNull(last.PBR);
    return { pbr, perDate: String(last.date || "") || null };
  } catch (_) {
    return { pbr: null, perDate: null };
  }
}

/* =======================
   FinMind：法人（T86）股數→張
======================= */
function calcBuyStreak(netTotalsByDay) {
  let streak = 0;
  for (let i = netTotalsByDay.length - 1; i >= 0; i--) {
    if ((netTotalsByDay[i] ?? 0) > 0) streak++;
    else break;
  }
  return streak;
}

async function fetchInstWindow(stockId, token, endDate /* YYYY-MM-DD */) {
  if (!token) return null;

  try {
    const start = daysAgo(45);
    const rows = await finmindGet(
      "TaiwanStockInstitutionalInvestorsBuySell",
      { data_id: stockId, start_date: start, end_date: endDate },
      token
    );
    if (!rows || rows.length === 0) return null;

    rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const byDate = new Map();
    for (const r of rows) {
      const d = String(r.date || "");
      if (!d) continue;
      const name = String(r.name || "");
      const buy = toNum(r.buy);
      const sell = toNum(r.sell);
      const net = buy - sell;

      if (!byDate.has(d)) {
        byDate.set(d, { date: d, foreign: 0, trust: 0, dealer: 0, total: 0 });
      }
      const o = byDate.get(d);

      if (name.includes("Foreign_Investor")) o.foreign += net;
      else if (name.includes("Investment_Trust")) o.trust += net;
      else if (name.includes("Dealer")) o.dealer += net;

      o.total += net;
    }

    const days = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    if (days.length === 0) return null;

    const window = days.slice(-INST_WINDOW_DAYS);
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

    const latest = days[days.length - 1];
    const buyStreak = calcBuyStreak(days.map((d) => d.total));

    const toLots = (shares) => Math.round(shares / 1000);

    return {
      windowDays: window.length,
      sumForeign: toLots(sum.foreign),
      sumTrust: toLots(sum.trust),
      sumDealer: toLots(sum.dealer),
      sumTotal: toLots(sum.total),
      latestDate: latest.date,
      latestTotalNet: toLots(latest.total),
      buyStreak,
      unit: "張",
      note: "FinMind 原始 buy/sell 單位為股數，本欄已換算為張(÷1000)。",
    };
  } catch (_) {
    return null;
  }
}

/* =======================
   評分 + 條件（已移除120日新高）
======================= */
function scoreAndExplain(bars) {
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

  // 原本條件
  const okTrend = lastMA20 && lastMA5 && lastClose > lastMA20 && lastMA5 > lastMA20;
  const okRSI = lastRSI == null ? true : lastRSI >= RSI_MIN && lastRSI <= RSI_MAX;
  const okVol = volRatio == null ? false : volRatio >= 1.1;

  // 新增：近 3 或 5 日漲幅 >= 5%
  const gain3 = i >= 3 ? (closes[i] - closes[i - 3]) / closes[i - 3] : null;
  const gain5 = i >= 5 ? (closes[i] - closes[i - 5]) / closes[i - 5] : null;
  const okGain =
    (gain3 != null && gain3 >= GAIN_3D_OR_5D_MIN) ||
    (gain5 != null && gain5 >= GAIN_3D_OR_5D_MIN);

  // 新增：趨勢發動（MA20 上升 + 價格站上 MA20）
  const ma20Up =
    (i >= 5 && ma20[i] != null && ma20[i - 5] != null) ? (ma20[i] > ma20[i - 5]) : false;
  const okLaunch = !!(lastMA20 && lastClose > lastMA20 && ma20Up);

  // ✅ 已移除：120 日接近新高
  const passed = okTrend && okRSI && okVol && okGain && okLaunch;

  // 分數（可微調權重）
  const trendScore = lastMA20 ? ((lastClose / lastMA20 - 1) * 100) : 0;
  const volScore = volRatio != null ? (volRatio - 1) * 10 : 0;
  const momentumScore = (gain5 != null ? gain5 : (gain3 != null ? gain3 : 0)) * 100;

  const score = trendScore * 2 + volScore + momentumScore;

  return {
    passed,
    score,
    lastClose,
    ma5: lastMA5,
    ma20: lastMA20,
    rsi14: lastRSI,
    volRatio,
    atr14: lastATR,
    barsLastDate: bars[bars.length - 1].date,
    extra: { gain3, gain5 },
  };
}

function buildTradePlan(lastClose, atr14) {
  const atrV = atr14 && atr14 > 0 ? atr14 : (lastClose * 0.03);

  const entryLow = lastClose - atrV * 0.4;
  const entryHigh = lastClose + atrV * 0.2;
  const stop = lastClose - atrV * 1.2;
  const tp1 = lastClose + atrV * 1.0;
  const tp2 = lastClose + atrV * 1.8;

  return {
    entryLow: Number(entryLow.toFixed(2)),
    entryHigh: Number(entryHigh.toFixed(2)),
    stop: Number(stop.toFixed(2)),
    tp1: Number(tp1.toFixed(2)),
    tp2: Number(tp2.toFixed(2)),
    basis: "ATR",
  };
}

/* =======================
   主流程
======================= */
async function pickStocks({ generatedAt } = {}) {
  const token = process.env.FINMIND_TOKEN || "";

  const infoMap = await fetchFinMindInfoMap(token);

  const rows = await fetchTWSEStockDayAll();
  let pool = buildPoolFromTWSE(rows);

  if (!pool || pool.length === 0) {
    return {
      market: "TW",
      generatedAt: generatedAt || new Date().toISOString(),
      topN: 3,
      picks: [],
      meta: { pool: { size: 0, POOL_SIZE, MIN_LIQ_SHARES, MIN_PRICE } },
    };
  }

  // 只保留 twse/tpex（排除興櫃等）
  pool = pool.filter((p) => {
    const inf = infoMap.get(p.symbol);
    if (!inf) return true; // 沒資料先不誤殺
    const t = String(inf.type || "").toLowerCase();
    return t === "twse" || t === "tpex";
  });

  const enrichedPool = pool.map((p) => {
    const inf = infoMap.get(p.symbol);
    return {
      ...p,
      industry: inf?.industry || null,
      marketType: inf?.type || null,
    };
  });

  const electronics = enrichedPool.filter((p) => isLikelyElectronics(p.industry));
  const others = enrichedPool.filter((p) => !isLikelyElectronics(p.industry));

  const needElec = Math.floor(POOL_SIZE * ELECTRONICS_RATIO);
  const needOther = POOL_SIZE - needElec;

  const poolWeighted = [
    ...electronics.sort((a, b) => b.volume - a.volume).slice(0, needElec),
    ...others.sort((a, b) => b.volume - a.volume).slice(0, needOther),
  ];

  // 第一階段：Yahoo 計分（要能產出完整詳情）
  const scored = [];
  for (const p of poolWeighted) {
    try {
      const bars = await fetchYahooBars(p.symbol);
      if (!bars || bars.length < 60) continue;

      const s = scoreAndExplain(bars);
      if (s.score <= MIN_PICK_SCORE) continue;

      scored.push({
        symbol: p.symbol,
        name: p.name,
        score: Number(s.score.toFixed(4)),
        passed: s.passed,

        lastClose: s.lastClose,
        ma5: s.ma5,
        ma20: s.ma20,
        rsi14: s.rsi14,
        volRatio: s.volRatio,
        atr14: s.atr14,

        asOfDataDate: s.barsLastDate,
        extra: s.extra,

        plan: buildTradePlan(s.lastClose, s.atr14),
      });

      await sleep(25);
    } catch (_) {}
  }

  scored.sort((a, b) => b.score - a.score);

  // 第二階段：只針對前 STAGE2_TOPK 拉 FinMind（法人/PBR）
  const stage2 = scored.slice(0, STAGE2_TOPK);

  for (const x of stage2) {
    try {
      const pbrInfo = await fetchPBRLatest(x.symbol, token);
      x.pbr = pbrInfo.pbr;
      x.pbrDate = pbrInfo.perDate;

      x.inst = await fetchInstWindow(x.symbol, token, x.asOfDataDate);

      await sleep(80);
    } catch (_) {}
  }

  // PBR 加權（先不硬擋）
  for (const x of stage2) {
    if (x.pbr == null) continue;
    if (x.pbr <= 2) x.score += 6;
    else if (x.pbr <= 3) x.score += 3;
    else if (x.pbr >= 6) x.score -= 4;
  }

  stage2.sort((a, b) => b.score - a.score);

  // TOP3：passed 優先，補位次之（保底一定要有）
  const passed = stage2.filter((z) => z.passed);
  const picks = [];

  for (const z of passed) {
    if (picks.length >= 3) break;
    picks.push({ ...z, reason: "主推" });
  }
  for (const z of stage2) {
    if (picks.length >= 3) break;
    if (picks.find((p) => p.symbol === z.symbol)) continue;
    picks.push({ ...z, reason: "補位" });
  }

  const asOfDataDate = picks[0]?.asOfDataDate || null;

  return {
    market: "TW",
    generatedAt: generatedAt || new Date().toISOString(),
    topN: 3,
    asOfDataDate,
    picks,
    meta: {
      pool: {
        size: poolWeighted.length,
        POOL_SIZE,
        MIN_LIQ_SHARES,
        MIN_PRICE,
        ELECTRONICS_RATIO,
      },
      rules: {
        rsi: [RSI_MIN, RSI_MAX],
        gain_3d_or_5d_min: GAIN_3D_OR_5D_MIN,
        stage2_topk: STAGE2_TOPK,
        inst_window_days: INST_WINDOW_DAYS,
      },
      tradeStyle: "短中期(3天~4週)",
    },
  };
}

module.exports = { pickStocks };
