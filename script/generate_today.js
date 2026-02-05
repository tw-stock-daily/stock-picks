// script/generate_today.js
// 目的：不改選股核心邏輯，只把「今日 picks」加上技術指標與交易計畫（收盤/MA/RSI/量比/entry/stop/TP）。
// 依賴：axios（你已經有了）

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// 你現有的真策略：請保持不動
const { pickStocks } = require("../lib/pickStocks");

// ============== indicators ==============
function toNum(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const s = String(x).replace(/,/g, "").trim();
  if (s === "" || s === "--") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
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

// ============== Yahoo chart fetch ==============
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

// 只做「顯示用」的操作型態判斷（不影響排序）
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
  const rsi14 = rsiArr[i];

  const vol20 = vol20Arr[i];
  const volRatio = (vol20 && vol20 > 0) ? (vols[i] / vol20) : null;

  const lastATR = atrArr[i];
  const atrUse = (lastATR && lastATR > 0) ? lastATR : (lastClose * 0.03);

  // 沿用你基準版 server.js 的 plan 計算方式（不改邏輯）
  const entryLow = lastClose - atrUse * 0.3;
  const entryHigh = lastClose + atrUse * 0.3;
  const stop = lastClose - atrUse * 1.5;
  const tp1 = lastClose + atrUse * 2.0;
  const tp2 = lastClose + atrUse * 3.0;

  const tradeStyle = inferTradeStyle({ rsi14, volRatio, ma5: ma5v, ma20: ma20v });

  return {
    lastClose,
    ma5: ma5v,
    ma20: ma20v,
    rsi14,
    volRatio,
    atr14: atrUse,
    tradeStyle,
    plan: { entryLow, entryHigh, stop, tp1, tp2 },
  };
}

async function enrichPick(p) {
  // p: {symbol,name,score,passed,reason,...}
  const symbol = String(p.symbol || "").trim();
  if (!symbol) return p;

  try {
    const bars = await fetchYahooBarsTW(symbol, "6mo", "1d");
    if (!bars || bars.length < 30) return { ...p, tech: { note: "bars不足" } };

    const sig = buildSignalsFromBars(bars);
    return {
      ...p,
      // 直接把欄位攤平，讓 app.html 更好顯示
      lastClose: sig.lastClose,
      ma5: sig.ma5,
      ma20: sig.ma20,
      rsi14: sig.rsi14,
      volRatio: sig.volRatio,
      atr14: sig.atr14,
      tradeStyle: sig.tradeStyle,
      plan: sig.plan,
      techUpdatedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ...p, tech: { error: String(e?.message || e) } };
  }
}

// 限制併發，避免 Yahoo/Actions 太快被擋
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

async function main() {
  // 1) 先跑真策略（不改任何核心）
  const base = await pickStocks();

  // 2) 只對今日 picks 加上技術資料（不影響排名）
  const picks = Array.isArray(base.picks) ? base.picks : [];
  const enriched = await mapLimit(picks, 2, enrichPick);

  const out = {
    ...base,
    generatedAt: base.generatedAt || new Date().toISOString(),
    picks: enriched,
    meta: {
      ...(base.meta || {}),
      tech: {
        note: "tech欄位由 generate_today.js 針對 picks 補齊（不影響排序）",
        source: "Yahoo chart",
      }
    }
  };

  // 3) 寫入 public/today.json
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
