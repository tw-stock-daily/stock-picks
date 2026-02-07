// script/generate_today.js
// 產生 public/today.json + public/history/YYYY-MM-DD.json（台北日期）
// 相容各種 pickStocks 匯出形式（CJS/ESM default/named）

const fs = require("fs");
const path = require("path");

// ===== 台北時間工具 =====
function tzDateISO(tz = "Asia/Taipei") {
  // YYYY-MM-DD
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function tzDateTime(tz = "Asia/Taipei") {
  // YYYY-MM-DD HH:mm:ss
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// ===== 取得 pickStocks 函式（相容各種 export）=====
function resolvePickStocks(mod) {
  // 可能是：function / {pickStocks} / {default:function} / {default:{pickStocks}} ...
  if (!mod) return null;

  // 1) 直接就是 function
  if (typeof mod === "function") return mod;

  // 2) named export
  if (typeof mod.pickStocks === "function") return mod.pickStocks;

  // 3) default export 是 function
  if (typeof mod.default === "function") return mod.default;

  // 4) default export 是 object，裡面有 pickStocks
  if (mod.default && typeof mod.default.pickStocks === "function") return mod.default.pickStocks;

  return null;
}

async function main() {
  const TZ = "Asia/Taipei";
  const todayKey = tzDateISO(TZ);     // ✅ 台北日期當檔名
  const generatedAt = tzDateTime(TZ); // ✅ 台北時間顯示

  // === 輸出資料夾 ===
  const outPublic = path.join(process.cwd(), "public");
  const outHistory = path.join(outPublic, "history");
  ensureDir(outPublic);
  ensureDir(outHistory);

  // === 載入 pickStocks ===
  const modPath = path.join(process.cwd(), "lib", "pickStocks.js");
  let mod;
  try {
    mod = require(modPath);
  } catch (e) {
    console.error("❌ 無法載入 lib/pickStocks.js：", e?.message || e);
    process.exit(1);
  }

  const pickStocks = resolvePickStocks(mod);
  if (!pickStocks) {
    console.error("❌ 找不到可呼叫的 pickStocks 函式。");
    console.error("   目前 lib/pickStocks.js 的 exports 是：", Object.keys(mod || {}));
    if (mod && mod.default && typeof mod.default === "object") {
      console.error("   default keys：", Object.keys(mod.default));
    }
    process.exit(1);
  }

  console.log("✅ pickStocks resolved OK");
  console.log("   generatedAt(Taipei):", generatedAt);
  console.log("   historyKey(Taipei):", todayKey);

  // === 跑選股 ===
  // 你目前的 pickStocks 已經能跑出：picks + meta（含 pool/marketGuard/inst/plan/tradeStyle）
  // 我們只傳最小必要參數，避免改動你的核心邏輯
  const result = await pickStocks({
    market: "TW",
    generatedAt,
  });

  // 兼容 result 可能直接就是 {picks, meta} 或整個 today 結構
  const picks = result?.picks || [];
  const meta = result?.meta || {};

  const todayJson = {
    market: "TW",
    generatedAt,
    topN: 3,
    picks,
    meta,
  };

  // today.json（App 讀）
  const todayPath = path.join(outPublic, "today.json");
  fs.writeFileSync(todayPath, JSON.stringify(todayJson, null, 2), "utf-8");

  // history（每天一份，不覆蓋）
  const historyPath = path.join(outHistory, `${todayKey}.json`);
  fs.writeFileSync(historyPath, JSON.stringify(todayJson, null, 2), "utf-8");

  console.log("✅ wrote:", path.relative(process.cwd(), todayPath));
  console.log("✅ wrote:", path.relative(process.cwd(), historyPath));
  console.log("✅ picks count:", picks.length);
}

main().catch((e) => {
  console.error("❌ generate_today failed:", e);
  process.exit(1);
});
