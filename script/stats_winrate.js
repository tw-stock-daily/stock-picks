/**
 * 台股精選 勝率分析工具
 *
 * 統計內容：
 * 1. D+1 勝率：推薦日後第 1 個交易日收盤 > 推薦日收盤
 * 2. D+3 勝率：推薦日後第 3 個交易日收盤 > 推薦日收盤
 * 3. D+5 勝率：推薦日後第 5 個交易日收盤 > 推薦日收盤
 * 4. D+5 觸及 TP1：5 個交易日內最高價 >= 推薦日收盤 +3%
 * 5. D+5 觸及 TP2：5 個交易日內最高價 >= 推薦日收盤 +5%
 *
 * 使用方式：
 * node script/stats_winrate.js
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const HISTORY_DIR = path.join(process.cwd(), "public", "history");
const OUTPUT_PATH = path.join(process.cwd(), "public", "stats.json");

const TP1_PCT = 0.03; // +3%
const TP2_PCT = 0.05; // +5%

const cache = new Map();

function toNum(x) {
  const n = Number(String(x ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function pctText(n) {
  if (!Number.isFinite(n)) return "0.00%";
  return `${(n * 100).toFixed(2)}%`;
}

function dateFromTsTaipei(tsSec) {
  const d = new Date(tsSec * 1000 + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function fetchBars(symbol) {
  if (cache.has(symbol)) return cache.get(symbol);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW`;

  try {
    const r = await axios.get(url, {
      timeout: 20000,
      params: {
        range: "6mo",
        interval: "1d",
        includePrePost: false,
        events: "div,splits"
      },
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    const data = r.data?.chart?.result?.[0];
    const q = data?.indicators?.quote?.[0];

    if (!data?.timestamp || !q) {
      cache.set(symbol, []);
      return [];
    }

    const bars = data.timestamp.map((t, i) => ({
      date: dateFromTsTaipei(t),
      open: toNum(q.open?.[i]),
      high: toNum(q.high?.[i]),
      low: toNum(q.low?.[i]),
      close: toNum(q.close?.[i]),
      volume: toNum(q.volume?.[i])
    })).filter(b =>
      b.date &&
      b.open > 0 &&
      b.high > 0 &&
      b.low > 0 &&
      b.close > 0
    );

    cache.set(symbol, bars);
    return bars;
  } catch (err) {
    console.log(`⚠️ 抓取 ${symbol} 股價失敗：${err.message}`);
    cache.set(symbol, []);
    return [];
  }
}

function readHistoryFiles() {
  if (!fs.existsSync(HISTORY_DIR)) {
    throw new Error(`找不到 history 資料夾：${HISTORY_DIR}`);
  }

  return fs.readdirSync(HISTORY_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
}

function getPickDate(pick, fallbackDate) {
  return pick.asOfDataDate || pick.date || fallbackDate;
}

async function main() {
  const files = readHistoryFiles();

  let totalSamples = 0;

  let d1Sample = 0;
  let d3Sample = 0;
  let d5Sample = 0;

  let d1Win = 0;
  let d3Win = 0;
  let d5Win = 0;

  let tp1Sample = 0;
  let tp2Sample = 0;

  let tp1Hit = 0;
  let tp2Hit = 0;

  let validDays = 0;
  let dailyTp1HitDays = 0;
  let dailyTp2HitDays = 0;

  const details = [];

  for (const file of files) {
    const filePath = path.join(HISTORY_DIR, file);
    const day = file.replace(".json", "");

    let json;
    try {
      json = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      console.log(`⚠️ 無法讀取 ${file}`);
      continue;
    }

    const picks = Array.isArray(json.picks) ? json.picks : [];
    if (!picks.length) continue;

    validDays++;

    let dayTp1Hit = false;
    let dayTp2Hit = false;

    for (const pick of picks) {
      const symbol = String(pick.symbol || "").trim();
      const name = pick.name || "";
      const entry = toNum(pick.lastClose);
      const pickDate = getPickDate(pick, day);

      if (!/^\d{4}$/.test(symbol) || entry <= 0 || !pickDate) continue;

      const bars = await fetchBars(symbol);
      if (!bars.length) continue;

      const idx = bars.findIndex(b => b.date === pickDate);
      if (idx < 0) {
        console.log(`⚠️ ${symbol} ${name} 找不到推薦日股價：${pickDate}`);
        continue;
      }

      totalSamples++;

      const d1 = bars[idx + 1];
      const d3 = bars[idx + 3];
      const d5 = bars[idx + 5];

      let d1Result = null;
      let d3Result = null;
      let d5Result = null;

      if (d1) {
        d1Sample++;
        d1Result = d1.close > entry;
        if (d1Result) d1Win++;
      }

      if (d3) {
        d3Sample++;
        d3Result = d3.close > entry;
        if (d3Result) d3Win++;
      }

      if (d5) {
        d5Sample++;
        d5Result = d5.close > entry;
        if (d5Result) d5Win++;
      }

      const d5Range = bars.slice(idx + 1, idx + 6);

      let hitTp1 = false;
      let hitTp2 = false;

      if (d5Range.length > 0) {
        tp1Sample++;
        tp2Sample++;

        hitTp1 = d5Range.some(b => b.high >= entry * (1 + TP1_PCT));
        hitTp2 = d5Range.some(b => b.high >= entry * (1 + TP2_PCT));

        if (hitTp1) {
          tp1Hit++;
          dayTp1Hit = true;
        }

        if (hitTp2) {
          tp2Hit++;
          dayTp2Hit = true;
        }
      }

      details.push({
        date: day,
        pickDate,
        symbol,
        name,
        entry,
        d1Close: d1 ? d1.close : null,
        d3Close: d3 ? d3.close : null,
        d5Close: d5 ? d5.close : null,
        d1Win: d1Result,
        d3Win: d3Result,
        d5Win: d5Result,
        tp1Price: Number((entry * (1 + TP1_PCT)).toFixed(2)),
        tp2Price: Number((entry * (1 + TP2_PCT)).toFixed(2)),
        d5HighMax: d5Range.length
          ? Math.max(...d5Range.map(b => b.high))
          : null,
        tp1Hit: hitTp1,
        tp2Hit: hitTp2
      });
    }

    if (dayTp1Hit) dailyTp1HitDays++;
    if (dayTp2Hit) dailyTp2HitDays++;
  }

  const result = {
    version: "stats-v2-with-tp2",
    generatedAt: new Date().toISOString(),
    range: files.length
      ? `${files[0].replace(".json", "")} ~ ${files[files.length - 1].replace(".json", "")}`
      : null,

    totalHistoryFiles: files.length,
    validPickDays: validDays,
    totalSamples,

    d1: {
      samples: d1Sample,
      wins: d1Win,
      winRate: d1Sample ? d1Win / d1Sample : 0
    },

    d3: {
      samples: d3Sample,
      wins: d3Win,
      winRate: d3Sample ? d3Win / d3Sample : 0
    },

    d5: {
      samples: d5Sample,
      wins: d5Win,
      winRate: d5Sample ? d5Win / d5Sample : 0
    },

    tp1: {
      label: "+3% within 5 trading days",
      pct: TP1_PCT,
      samples: tp1Sample,
      hits: tp1Hit,
      hitRate: tp1Sample ? tp1Hit / tp1Sample : 0
    },

    tp2: {
      label: "+5% within 5 trading days",
      pct: TP2_PCT,
      samples: tp2Sample,
      hits: tp2Hit,
      hitRate: tp2Sample ? tp2Hit / tp2Sample : 0
    },

    dailyHit: {
      tp1: {
        days: validDays,
        hitDays: dailyTp1HitDays,
        hitRate: validDays ? dailyTp1HitDays / validDays : 0
      },
      tp2: {
        days: validDays,
        hitDays: dailyTp2HitDays,
        hitRate: validDays ? dailyTp2HitDays / validDays : 0
      }
    },

    details
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), "utf8");

  console.log("✅ 勝率統計完成");
  console.log(`統計區間: ${result.range}`);
  console.log(`有效推薦日: ${validDays}`);
  console.log(`總樣本數: ${totalSamples}`);
  console.log(`D+1 勝率: ${pctText(result.d1.winRate)}（樣本 ${d1Sample}）`);
  console.log(`D+3 勝率: ${pctText(result.d3.winRate)}（樣本 ${d3Sample}）`);
  console.log(`D+5 勝率: ${pctText(result.d5.winRate)}（樣本 ${d5Sample}）`);
  console.log(`D+5 觸及 TP1(+3%) 比例: ${pctText(result.tp1.hitRate)}（樣本 ${tp1Sample}）`);
  console.log(`D+5 觸及 TP2(+5%) 比例: ${pctText(result.tp2.hitRate)}（樣本 ${tp2Sample}）`);
  console.log(`每日3檔至少1檔觸及 TP1(+3%)：${pctText(result.dailyHit.tp1.hitRate)}（${dailyTp1HitDays}/${validDays}天）`);
  console.log(`每日3檔至少1檔觸及 TP2(+5%)：${pctText(result.dailyHit.tp2.hitRate)}（${dailyTp2HitDays}/${validDays}天）`);
  console.log(`✅ 已輸出: public/stats.json`);
}

main().catch(err => {
  console.error("❌ 勝率統計失敗");
  console.error(err);
  process.exit(1);
});
