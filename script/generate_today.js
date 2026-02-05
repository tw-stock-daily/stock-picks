// script/generate_today.js
// 功能：
// 1) 跑真策略 pickStocks() 產生 picks（不改核心）
// 2) 對 picks 補技術面（Yahoo bars -> MA/RSI/ATR/plan）
// 3) 對 picks 補法人摘要（TWSE T86 -> 外資/投信/自營 合計、連買、最新淨買）
// 4) 寫入 public/today.json

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { pickStocks } = require("../lib/pickStocks");

// -------------------- utils --------------------
function toNum(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const s = String(x).replace(/,/g, "").trim();
  if (!s || s === "--") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
const pad2 = (n) => String(n).padStart(2, "0");
const yyyymmdd = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;

// -------------------- indicators --------------------
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
  if (!closes || closes.length < period + 1) return Array(closes.length).fill(null);
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
  if (!closes || closes.length < period + 1) return Array(closes.length).fill(null);
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

// -------------------- yahoo bars --------------------
async function fetchYahooBarsTW(symbol, range = "6mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW`;
  const resp = await axios.get(url, {
    params: { range, interval, includePrePost: false, events: "div,splits" },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo chart no result for ${symbol}`);

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

  return bars;
}

function inferTradeStyle({ rsi14, volRatio, ma5, ma20 }) {
  if (rsi14 == null || volRatio == null || ma5 == null || ma20 == null) return "波段";
  if (volRatio >= 1.6 && rsi14 >= 65) return "短期";
  if (ma5 > ma20 && rsi14 >= 52 && rsi14 <= 66) return "波段";
  return "波段";
}

function buildSignalsFromBars(bars) {
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.volume);

  const ma5Arr = sma(closes, 5);
  const ma20Arr = sma(closes, 20);
  const rsiArr = rsi(closes, 14);
  const vol20Arr = sma(vols, 20);
  const atrArr = atr(highs, lows, closes, 14);

  const i = closes.length - 1;
  const lastClose = closes[i];

  const ma5v = ma5Arr[i];
  const ma20v = ma20Arr[i];
  const rsi14v = rsiArr[i];

  const vol20 = vol20Arr[i];
  const volRatio = (vol20 && vol20 > 0) ? (vols[i] / vol20) : null;

  const lastATR = atrArr[i];
  const atrUse = (lastATR && lastATR > 0) ? lastATR : (lastClose * 0.03);

  // 跟你基準版 server.js 一樣的交易計畫公式
  const entryLow = lastClose - atrUse * 0.3;
  const entryHigh = lastClose + atrUse * 0.3;
  const stop = lastClose - atrUse * 1.5;
  const tp1 = lastClose + atrUse * 2.0;
  const tp2 = lastClose + atrUse * 3.0;

  const tradeStyle = inferTradeStyle({ rsi14: rsi14v, volRatio, ma5: ma5v, ma20: ma20v });

  return {
    lastClose,
    ma5: ma5v,
    ma20: ma20v,
    rsi14: rsi14v,
    volRatio,
    atr14: atrUse,
    tradeStyle,
    plan: { entryLow, entryHigh, stop, tp1, tp2 },
  };
}

// -------------------- TWSE T86 (法人) --------------------
// cache：避免同一天 T86 重複抓
const t86Cache = new Map(); // key: yyyymmdd -> Map(symbol -> {foreignNet,trustNet,dealerNet,name})

async function fetchTWSE_T86(dateYYYYMMDD) {
  if (t86Cache.has(dateYYYYMMDD)) return t86Cache.get(dateYYYYMMDD);

  const resp = await axios.get("https://www.twse.com.tw/fund/T86", {
    params: { response: "json", date: dateYYYYMMDD, selectType: "ALLBUT0999" },
    timeout: 25000,
    headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.twse.com.tw/" },
  });

  const data = resp.data?.data || [];
  const map = new Map();
  for (const row of data) {
    const symbol = String(row?.[0] || "").trim();
    if (!/^\d{4}$/.test(symbol)) continue;
    map.set(symbol, {
      symbol,
      name: String(row?.[1] || "").trim(),
      foreignNet: toNum(row?.[4]),
      trustNet: toNum(row?.[7]),
      dealerNet: toNum(row?.[10]),
    });
  }
  t86Cache.set(dateYYYYMMDD, map);
  return map;
}

async function getRecentTradingDates(n, endDate = new Date()) {
  const dates = [];
  const d = new Date(endDate);
  for (let tries = 0; tries < 80 && dates.length < n; tries++) {
    const ds = yyyymmdd(d);
    try {
      const map = await fetchTWSE_T86(ds);
      if (map && map.size > 0) dates.push(ds);
    } catch (_) {}
    d.setDate(d.getDate() - 1);
    await new Promise(r => setTimeout(r, 40));
  }
  return dates;
}

async function getInstitutionStats(symbol, windowDays = 10) {
  const dates = await getRecentTradingDates(windowDays, new Date());
  const series = [];

  let nameFromT86 = "";

  for (const ds of dates) {
    const map = await fetchTWSE_T86(ds);
    const found = map.get(symbol) || null;
    if (!nameFromT86 && found?.name) nameFromT86 = found.name;

    const foreignNet = found ? found.foreignNet : 0;
    const trustNet = found ? found.trustNet : 0;
    const dealerNet = found ? found.dealerNet : 0;

    series.push({ date: ds, foreignNet, trustNet, dealerNet });
  }

  const sumForeign = series.reduce((a, x) => a + x.foreignNet, 0);
  const sumTrust   = series.reduce((a, x) => a + x.trustNet, 0);
  const sumDealer  = series.reduce((a, x) => a + x.dealerNet, 0);
  const sumTotal   = sumForeign + sumTrust + sumDealer;

  const totalNetArr = series.map(x => x.foreignNet + x.trustNet + x.dealerNet);

  // series[0] 是最近一天
  let buyStreak = 0;
  for (const v of totalNetArr) { if (v > 0) buyStreak++; else break; }

  let sellStreak = 0;
  for (const v of totalNetArr) { if (v < 0) sellStreak++; else break; }

  return {
    windowDays,
    nameFromT86,
    sumForeign, sumTrust, sumDealer, sumTotal,
    buyStreak, sellStreak,
    latestTotalNet: totalNetArr[0] || 0,
    dates,
  };
}

// -------------------- concurrency --------------------
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

// -------------------- enrich pick --------------------
async function enrichPick(p, windowDays) {
  const symbol = String(p.symbol || "").trim();
  if (!symbol) return p;

  const out = { ...p };

  // 1) 技術面
  try {
    const bars = await fetchYahooBarsTW(symbol, "6mo", "1d");
    if (bars && bars.length >= 30) {
      const sig = buildSignalsFromBars(bars);
      Object.assign(out, sig, { techUpdatedAt: new Date().toISOString() });
    } else {
      out.tech = { note: "bars不足" };
    }
  } catch (e) {
    out.tech = { error: String(e?.message || e) };
  }

  // 2) 法人
  try {
    const inst = await getInstitutionStats(symbol, windowDays);
    out.inst = inst;
  } catch (e) {
    out.inst = { error: String(e?.message || e), windowDays };
  }

  return out;
}

async function main() {
  // 先跑真策略（不改核心）
  const base = await pickStocks();

  const picks = Array.isArray(base.picks) ? base.picks : [];
  const windowDays = base?.meta?.windowDays ? Number(base.meta.windowDays) : 10;

  // 只 enrich 今日 picks（不改排序），併發不要太高
  const enriched = await mapLimit(picks, 2, (p) => enrichPick(p, windowDays));

  const out = {
    ...base,
    generatedAt: base.generatedAt || new Date().toISOString(),
    picks: enriched,
    meta: {
      ...(base.meta || {}),
      tech: {
        note: "技術欄位由 generate_today.js 針對 picks 補齊（不影響排序）",
        source: "Yahoo chart",
      },
      inst: {
        note: "法人欄位由 generate_today.js 針對 picks 補齊（TWSE T86）",
        source: "TWSE T86",
        windowDays,
      }
    }
  };

  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  const file = path.join(publicDir, "today.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");

  console.log("✅ wrote:", file);
  console.log("✅ picks:", out.picks?.length || 0);
}

main().catch((e) => {
  console.error("❌ generate_today failed:", e);
  process.exit(1);
});
