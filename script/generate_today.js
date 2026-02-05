// script/generate_today.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { pickStocks } = require("../lib/pickStocks");

// 台北時間字串：YYYY-MM-DD HH:mm
function pad(n) { return String(n).padStart(2, "0"); }
function taipeiParts(date = new Date()) {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const Y = t.getUTCFullYear();
  const M = pad(t.getUTCMonth() + 1);
  const D = pad(t.getUTCDate());
  const hh = pad(t.getUTCHours());
  const mm = pad(t.getUTCMinutes());
  return { Y, M, D, hh, mm, ymd: `${Y}-${M}-${D}`, hm: `${hh}:${mm}` };
}
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

function sma(arr, period) {
  let sum = 0;
  const out = [];
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

async function fetchYahooIndexBars(symbol, range = "6mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`;
  const resp = await axios.get(url, {
    params: { range, interval, includePrePost: false },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const r = resp.data?.chart?.result?.[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const closes = (q.close || []).map(x => Number(x) || 0);

  return ts
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: closes[i],
    }))
    .filter(b => b.close > 0);
}

// 盤勢保護：不改排名，只縮減推薦數（riskOff -> 只留 1 檔）
async function marketGuard(picks) {
  // 台股加權指數：Yahoo = ^TWII
  const bars = await fetchYahooIndexBars("^TWII", "6mo", "1d");
  if (bars.length < 80) {
    return { level: "unknown", maxPicks: 3, note: "index bars not enough" };
  }

  const closes = bars.map(b => b.close);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const rsi14 = rsi(closes, 14);

  const i = closes.length - 1;
  const last = closes[i];
  const m20 = ma20[i];
  const m60 = ma60[i];
  const r14 = rsi14[i];

  // 規則：偏保守（你之後想調再調）
  const below60 = m60 ? last < m60 : false;
  const weakMomentum = r14 != null ? r14 < 45 : false;
  const downTrend = (m20 && m60) ? (m20 < m60 && last < m20) : false;

  let level = "riskOn";
  let maxPicks = 3;
  const reasons = [];

  if (below60) reasons.push("指數低於60日均線");
  if (downTrend) reasons.push("20日<60日且收盤<20日");
  if (weakMomentum) reasons.push("RSI偏弱(<45)");

  // 只要符合其中 2 個，就進入 riskOff（只留1檔）
  const flags = [below60, downTrend, weakMomentum].filter(Boolean).length;
  if (flags >= 2) {
    level = "riskOff";
    maxPicks = 1;
  }

  return {
    level,
    maxPicks,
    index: { symbol: "^TWII", last, ma20: m20, ma60: m60, rsi14: r14 },
    reasons,
  };
}

async function main() {
  const { ymd, hm } = taipeiParts();
  const data = await pickStocks();

  const poolSize = data?.meta?.pool?.size ?? 0;
  const picksRaw = Array.isArray(data?.picks) ? data.picks : [];

  // 防呆：避免寫入空結果（保留前一天 today.json）
  if (!data || poolSize === 0 || picksRaw.length === 0) {
    console.log(`⚠️ No valid pool/picks today (pool=${poolSize}, picks=${picksRaw.length}). Skip overwrite.`);
    return;
  }

  // 盤勢保護（只縮減推薦數，不改排序）
  const guard = await marketGuard(picksRaw);
  const picks = picksRaw.slice(0, Math.min(guard.maxPicks, 3));

  const out = {
    market: data.market || "TW",
    generatedAt: `${ymd} ${hm}`,
    topN: 3,
    picks,
    meta: {
      ...(data.meta || {}),
      marketGuard: guard,
    },
  };

  const publicDir = path.join(process.cwd(), "public");
  const historyDir = path.join(publicDir, "history");
  ensureDir(publicDir);
  ensureDir(historyDir);

  fs.writeFileSync(path.join(publicDir, "today.json"), JSON.stringify(out, null, 2) + "\n", "utf8");

  const histPath = path.join(historyDir, `${ymd}.json`);
  fs.writeFileSync(histPath, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log(`✅ Generated public/today.json`);
  console.log(`✅ Archived ${path.relative(process.cwd(), histPath)}`);
  console.log(`🛡 MarketGuard: ${guard.level}, maxPicks=${guard.maxPicks}, reasons=${(guard.reasons||[]).join(" / ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
