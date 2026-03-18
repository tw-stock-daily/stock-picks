"use strict";

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const HISTORY_DIR = path.join(process.cwd(), "public", "history");
const OUT_FILE = path.join(process.cwd(), "public", "stats.json");

function num(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function safeDate(s) {
  if (!s) return null;
  const str = String(s).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function fetchYahooBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW`;
  const resp = await axios.get(url, {
    params: {
      range: "6mo",
      interval: "1d",
      includePrePost: false,
      events: "div,splits",
    },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo no result for ${symbol}`);

  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};

  const opens = q.open || [];
  const highs = q.high || [];
  const lows = q.low || [];
  const closes = q.close || [];
  const vols = q.volume || [];

  const bars = ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: num(opens[i], null),
    high: num(highs[i], null),
    low: num(lows[i], null),
    close: num(closes[i], null),
    volume: num(vols[i], null),
  })).filter(b => b.close != null);

  return bars;
}

function getEntryPrice(pick) {
  // 保守一點：優先用 entryHigh，沒有就用 lastClose
  const entryHigh = num(pick?.plan?.entryHigh, NaN);
  if (Number.isFinite(entryHigh) && entryHigh > 0) return entryHigh;

  const lastClose = num(pick?.lastClose, NaN);
  if (Number.isFinite(lastClose) && lastClose > 0) return lastClose;

  return null;
}

function getAsOfDate(historyJson, pick, fallbackFromFilename) {
  return (
    safeDate(pick?.asOfDataDate) ||
    safeDate(historyJson?.asOfDataDate) ||
    safeDate(historyJson?.historyKey) ||
    safeDate(fallbackFromFilename)
  );
}

function calcReturnPct(entry, price) {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(price)) return null;
  return ((price - entry) / entry) * 100;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function main() {
  if (!fs.existsSync(HISTORY_DIR)) {
    throw new Error(`找不到資料夾: ${HISTORY_DIR}`);
  }

  const files = fs.readdirSync(HISTORY_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();

  if (!files.length) {
    throw new Error("public/history 裡沒有任何 json 檔");
  }

  let totalPicks = 0;

  let d1Count = 0, d1Win = 0;
  let d3Count = 0, d3Win = 0;
  let d5Count = 0, d5Win = 0;
  let tp1Count = 0, tp1Hit = 0;

  const d1Returns = [];
  const d3Returns = [];
  const d5Returns = [];

  const details = [];

  for (const file of files) {
    const full = path.join(HISTORY_DIR, file);
    const data = readJson(full);
    const fileDate = file.replace(".json", "");

    for (const pick of (data.picks || [])) {
      const symbol = String(pick.symbol || "").trim();
      if (!symbol) continue;

      const asOfDate = getAsOfDate(data, pick, fileDate);
      const entryPrice = getEntryPrice(pick);
      const tp1 = num(pick?.plan?.tp1, NaN);

      if (!asOfDate || !Number.isFinite(entryPrice)) continue;

      let bars;
      try {
        bars = await fetchYahooBars(symbol);
      } catch (e) {
        details.push({
          file,
          symbol,
          asOfDate,
          error: `抓 Yahoo 失敗: ${String(e.message || e)}`
        });
        continue;
      }

      const idx = bars.findIndex(b => b.date === asOfDate);
      if (idx < 0) {
        details.push({
          file,
          symbol,
          asOfDate,
          error: "找不到 asOfDate 對應 K 線"
        });
        continue;
      }

      totalPicks++;

      const d1Bar = bars[idx + 1] || null;
      const d3Bar = bars[idx + 3] || null;
      const d5Bar = bars[idx + 5] || null;

      const row = {
        file,
        symbol,
        name: pick.name || "",
        asOfDate,
        entryPrice: Number(entryPrice.toFixed(3)),
        lastClose: num(pick.lastClose, null),
        tp1: Number.isFinite(tp1) ? Number(tp1.toFixed(3)) : null,
      };

      // D+1
      if (d1Bar) {
        d1Count++;
        const r1 = calcReturnPct(entryPrice, d1Bar.close);
        if (r1 != null) {
          d1Returns.push(r1);
          if (r1 > 0) d1Win++;
        }
        row.d1Close = d1Bar.close;
        row.d1RetPct = r1 != null ? Number(r1.toFixed(3)) : null;
      }

      // D+3
      if (d3Bar) {
        d3Count++;
        const r3 = calcReturnPct(entryPrice, d3Bar.close);
        if (r3 != null) {
          d3Returns.push(r3);
          if (r3 > 0) d3Win++;
        }
        row.d3Close = d3Bar.close;
        row.d3RetPct = r3 != null ? Number(r3.toFixed(3)) : null;
      }

      // D+5
      if (d5Bar) {
        d5Count++;
        const r5 = calcReturnPct(entryPrice, d5Bar.close);
        if (r5 != null) {
          d5Returns.push(r5);
          if (r5 > 0) d5Win++;
        }
        row.d5Close = d5Bar.close;
        row.d5RetPct = r5 != null ? Number(r5.toFixed(3)) : null;
      }

      // D+5 是否碰到 TP1
      if (Number.isFinite(tp1)) {
        let hit = false;
        let maxHigh5 = null;

        for (let k = 1; k <= 5; k++) {
          const b = bars[idx + k];
          if (!b) continue;
          if (maxHigh5 == null || (b.high != null && b.high > maxHigh5)) {
            maxHigh5 = b.high;
          }
          if (b.high != null && b.high >= tp1) hit = true;
        }

        // 只有當至少存在未來一天資料時才算樣本
        const hasFuture = !!bars[idx + 1];
        if (hasFuture) {
          tp1Count++;
          if (hit) tp1Hit++;
        }

        row.maxHighIn5 = maxHigh5 != null ? Number(maxHigh5.toFixed(3)) : null;
        row.hitTp1In5 = hit;
      }

      details.push(row);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalPicks,
      d1: {
        samples: d1Count,
        win: d1Win,
        winRatePct: d1Count ? Number(((d1Win / d1Count) * 100).toFixed(2)) : null,
        avgReturnPct: d1Returns.length ? Number(avg(d1Returns).toFixed(3)) : null,
      },
      d3: {
        samples: d3Count,
        win: d3Win,
        winRatePct: d3Count ? Number(((d3Win / d3Count) * 100).toFixed(2)) : null,
        avgReturnPct: d3Returns.length ? Number(avg(d3Returns).toFixed(3)) : null,
      },
      d5: {
        samples: d5Count,
        win: d5Win,
        winRatePct: d5Count ? Number(((d5Win / d5Count) * 100).toFixed(2)) : null,
        avgReturnPct: d5Returns.length ? Number(avg(d5Returns).toFixed(3)) : null,
      },
      tp1In5: {
        samples: tp1Count,
        hit: tp1Hit,
        hitRatePct: tp1Count ? Number(((tp1Hit / tp1Count) * 100).toFixed(2)) : null,
      }
    },
    details
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), "utf8");

  console.log("✅ 勝率統計完成");
  console.log(`總樣本數: ${totalPicks}`);
  console.log(`D+1 勝率: ${output.summary.d1.winRatePct ?? "-"}%（樣本 ${d1Count}）`);
  console.log(`D+3 勝率: ${output.summary.d3.winRatePct ?? "-"}%（樣本 ${d3Count}）`);
  console.log(`D+5 勝率: ${output.summary.d5.winRatePct ?? "-"}%（樣本 ${d5Count}）`);
  console.log(`D+5 觸及 TP1 比例: ${output.summary.tp1In5.hitRatePct ?? "-"}%（樣本 ${tp1Count}）`);
  console.log(`✅ 已輸出: public/stats.json`);
}

main().catch(err => {
  console.error("❌ stats_winrate 失敗:", String(err?.stack || err));
  process.exit(1);
});
