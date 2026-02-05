// script/generate_today.js
const fs = require("fs");
const path = require("path");
const { pickStocks } = require("../lib/pickStocks");

// 台北時間字串：YYYY-MM-DD HH:mm
function pad(n) { return String(n).padStart(2, "0"); }
function taipeiParts(date = new Date()) {
  // 轉成台北時間（UTC+8）
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const Y = t.getUTCFullYear();
  const M = pad(t.getUTCMonth() + 1);
  const D = pad(t.getUTCDate());
  const hh = pad(t.getUTCHours());
  const mm = pad(t.getUTCMinutes());
  return { Y, M, D, hh, mm, ymd: `${Y}-${M}-${D}`, hm: `${hh}:${mm}` };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function main() {
  const { ymd, hm } = taipeiParts();

  // ✅ 真的跑引擎
  const data = await pickStocks();

  // ✅ 防呆：避免寫入空結果（保留前一天 today.json）
  const poolSize = data?.meta?.pool?.size ?? 0;
  const picks = Array.isArray(data?.picks) ? data.picks : [];

  if (!data || poolSize === 0 || picks.length === 0) {
    console.log(`⚠️ No valid pool/picks today (pool=${poolSize}, picks=${picks.length}). Skip overwrite.`);
    return;
  }

  // ✅ 統一輸出格式（你的 App 會更好用）
  const out = {
    market: data.market || "TW",
    generatedAt: `${ymd} ${hm}`,
    topN: 3,
    picks: picks.slice(0, 3),
    meta: data.meta || {},
  };

  const publicDir = path.join(process.cwd(), "public");
  const historyDir = path.join(publicDir, "history");
  ensureDir(publicDir);
  ensureDir(historyDir);

  // today.json
  fs.writeFileSync(path.join(publicDir, "today.json"), JSON.stringify(out, null, 2) + "\n", "utf8");

  // history/YYYY-MM-DD.json
  const histPath = path.join(historyDir, `${ymd}.json`);
  fs.writeFileSync(histPath, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log(`✅ Generated public/today.json`);
  console.log(`✅ Archived ${path.relative(process.cwd(), histPath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
