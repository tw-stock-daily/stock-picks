const fs = require("fs");
const path = require("path");
const axios = require("axios");

// === 設定 ===
const HISTORY_DIR = path.join(__dirname, "../public/history");
const TP1_PCT = 0.03; // +3%

// === 工具 ===
function toNum(x) {
  return Number(x) || 0;
}

function pct(a, b) {
  return (b - a) / a;
}

// === 抓股價 ===
async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW`;

  const r = await axios.get(url);
  const data = r.data.chart.result[0];

  const q = data.indicators.quote[0];

  return data.timestamp.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    close: toNum(q.close[i]),
    high: toNum(q.high[i]),
  }));
}

// === 主程式 ===
async function main() {
  const files = fs.readdirSync(HISTORY_DIR);

  let total = 0;
  let d1_win = 0;
  let d3_move = 0;
  let d5_tp1 = 0;
  let daily_hit = 0;

  for (const file of files) {
    const data = JSON.parse(
      fs.readFileSync(path.join(HISTORY_DIR, file))
    );

    const picks = data.picks || [];
    if (!picks.length) continue;

    let dayHit = false;

    for (const p of picks) {
      const symbol = p.symbol;
      const entry = p.lastClose;

      const bars = await fetchBars(symbol);
      if (!bars || bars.length < 10) continue;

      // 找推薦日 index
      const idx = bars.findIndex(b => b.date === p.asOfDataDate);
      if (idx < 0) continue;

      total++;

      // === D+1 ===
      const d1 = bars[idx + 1];
      if (d1 && d1.close > entry) d1_win++;

      // === D+3 ===
      const d3_range = bars.slice(idx + 1, idx + 4);
      if (d3_range.some(b => b.high > entry)) d3_move++;

      // === D+5 TP1 ===
      const d5_range = bars.slice(idx + 1, idx + 6);
      if (d5_range.some(b => b.high >= entry * (1 + TP1_PCT))) {
        d5_tp1++;
        dayHit = true;
      }
    }

    if (dayHit) daily_hit++;
  }

  const result = {
    totalSamples: total,
    d1_win_rate: d1_win / total,
    d3_move_rate: d3_move / total,
    d5_tp1_rate: d5_tp1 / total,
    daily_hit_rate: daily_hit / files.length
  };

  fs.writeFileSync(
    path.join(__dirname, "../public/stats.json"),
    JSON.stringify(result, null, 2)
  );

  console.log("=== 勝率分析完成 ===");
  console.log(result);
}

main();
