// script/evaluate_performance.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8"); }

function listHistoryFiles(historyDir) {
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // asc
}

async function fetchYahooDailyCloses(symbolTW, range = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbolTW}`;
  const resp = await axios.get(url, {
    params: { range, interval: "1d", includePrePost: false },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  const r = resp.data?.chart?.result?.[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const closes = (q.close || []).map(x => Number(x) || 0);
  return ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    close: closes[i],
  })).filter(x => x.close > 0);
}

function nextTradingClose(closes, baseDate, tradingDaysAhead) {
  // closes: [{date, close}] sorted asc
  const idx = closes.findIndex(x => x.date === baseDate);
  if (idx < 0) return null;
  const targetIdx = idx + tradingDaysAhead;
  if (targetIdx >= closes.length) return null;
  return closes[targetIdx];
}

function mean(arr) { return arr.reduce((a,b)=>a+b,0) / (arr.length || 1); }
function median(arr) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x,y)=>x-y);
  const m = Math.floor(a.length/2);
  return a.length % 2 ? a[m] : (a[m-1]+a[m])/2;
}

async function main() {
  const publicDir = path.join(process.cwd(), "public");
  const historyDir = path.join(publicDir, "history");
  const outDir = path.join(publicDir, "performance");
  ensureDir(outDir);

  const files = listHistoryFiles(historyDir);
  if (files.length === 0) {
    console.log("⚠️ No history files. Skip performance.");
    return;
  }

  // 為了避免 Actions 太久：只回測最近 90 份（你之後想調再調）
  const recent = files.slice(-90);

  // 收集出現過的股票代號
  const symbols = new Set();
  const byDate = [];
  for (const f of recent) {
    const obj = readJson(path.join(historyDir, f));
    const date = f.replace(".json", "");
    const picks = Array.isArray(obj.picks) ? obj.picks : [];
    for (const p of picks) symbols.add(String(p.symbol || "").trim());
    byDate.push({ date, picks });
  }

  // 下載每檔股票近 6 個月收盤（一次一檔，避免被限流）
  const closeMap = new Map();
  for (const sym of symbols) {
    try {
      const yahooSym = `${sym}.TW`;
      const closes = await fetchYahooDailyCloses(yahooSym, "6mo");
      closeMap.set(sym, closes);
      await new Promise(r => setTimeout(r, 80));
    } catch (_) {
      closeMap.set(sym, []);
    }
  }

  const horizons = [1, 5, 10]; // trading days
  const resultsByDate = [];

  for (const row of byDate) {
    const baseDate = row.date;
    const daily = { date: baseDate, picks: [] };

    for (const p of row.picks) {
      const sym = String(p.symbol || "").trim();
      const closes = closeMap.get(sym) || [];
      const base = closes.find(x => x.date === baseDate);
      if (!base) continue;

      const item = { symbol: sym, name: p.name || "", baseClose: base.close, ret: {} };
      for (const h of horizons) {
        const nxt = nextTradingClose(closes, baseDate, h);
        if (!nxt) continue;
        item.ret[`D+${h}`] = Number((((nxt.close / base.close) - 1) * 100).toFixed(3)); // %
      }
      daily.picks.push(item);
    }
    resultsByDate.push(daily);
  }

  // summary
  const summary = {};
  for (const h of horizons) {
    const key = `D+${h}`;
    const arr = [];
    for (const d of resultsByDate) {
      for (const p of d.picks) {
        if (p.ret[key] == null) continue;
        arr.push(p.ret[key]);
      }
    }
    const wins = arr.filter(x => x > 0).length;
    summary[key] = {
      samples: arr.length,
      winRate: arr.length ? Number((wins / arr.length * 100).toFixed(2)) : 0,
      avgReturnPct: arr.length ? Number(mean(arr).toFixed(3)) : 0,
      medianReturnPct: arr.length ? Number(median(arr).toFixed(3)) : 0,
    };
  }

  writeJson(path.join(outDir, "summary.json"), {
    generatedAt: new Date().toISOString(),
    range: { filesUsed: recent.length, from: recent[0].replace(".json",""), to: recent[recent.length-1].replace(".json","") },
    summary,
  });

  writeJson(path.join(outDir, "by_date.json"), resultsByDate);

  console.log("✅ Performance updated: public/performance/summary.json + by_date.json");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
