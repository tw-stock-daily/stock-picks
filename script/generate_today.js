// script/generate_today.js
// 產生 public/today.json + public/history/YYYY-MM-DD.json（台北日期）
// 不依賴 express，只跑選股 + 寫檔

const fs = require("fs");
const path = require("path");
const pickStocks = require("../lib/pickStocks.js");

// ===== 台北時間工具 =====
function tzDateISO(tz = "Asia/Taipei") {
  // 產生 YYYY-MM-DD（用指定時區）
  return new Date().toLocaleDateString("en-CA", { timeZone: tz }); // en-CA 會輸出 2026-02-07
}

function tzDateTime(tz = "Asia/Taipei") {
  // 產生 YYYY-MM-DD HH:mm:ss（用指定時區）
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
  // sv-SE 會輸出 2026-02-07 01:30:00
  return parts;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function main() {
  const TZ = "Asia/Taipei";

  const todayKey = tzDateISO(TZ);          // ✅ 以台北日期命名 history 檔案
  const generatedAt = tzDateTime(TZ);      // ✅ 顯示台北時間

  const outPublic = path.join(process.cwd(), "public");
  const outHistory = path.join(outPublic, "history");
  ensureDir(outPublic);
  ensureDir(outHistory);

  // === 跑選股（你已經跑成功的真策略）===
  const result = await pickStocks({
    market: "TW",
    generatedAt,
    // 這裡的參數依你的 pickStocks 版本而定
    // 你目前已經能跑出 inst / plan / tradeStyle，表示 pickStocks OK
  });

  // today.json（給 app 用）
  const todayJson = {
    market: "TW",
    generatedAt,
    topN: 3,
    picks: result.picks || [],
    meta: result.meta || {},
  };

  fs.writeFileSync(path.join(outPublic, "today.json"), JSON.stringify(todayJson, null, 2), "utf-8");

  // history：每天一份（✅台北日期）
  const historyPath = path.join(outHistory, `${todayKey}.json`);
  fs.writeFileSync(historyPath, JSON.stringify(todayJson, null, 2), "utf-8");

  console.log(`✅ wrote: public/today.json`);
  console.log(`✅ wrote: public/history/${todayKey}.json`);
}

main().catch((e) => {
  console.error("❌ generate_today failed:", e);
  process.exit(1);
});
