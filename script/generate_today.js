// script/generate_today.js
// 產生 public/today.json + public/history/YYYY-MM-DD.json（台北日期）
// - todayKey：用台北日期做檔名（每天一份）
// - asOfDataDate：用「最近交易日」做資料日（假日/休市不中斷）

const fs = require("fs");
const path = require("path");

function tzDateISO(tz = "Asia/Taipei") {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}

function tzDateTime(tz = "Asia/Taipei") {
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

function resolvePickStocks(mod) {
  if (!mod) return null;
  if (typeof mod === "function") return mod;
  if (typeof mod.pickStocks === "function") return mod.pickStocks;
  if (typeof mod.default === "function") return mod.default;
  if (mod.default && typeof mod.default.pickStocks === "function") return mod.default.pickStocks;
  return null;
}

async function main() {
  const TZ = "Asia/Taipei";
  const todayKey = tzDateISO(TZ);
  const generatedAt = tzDateTime(TZ);

  const outPublic = path.join(process.cwd(), "public");
  const outHistory = path.join(outPublic, "history");
  ensureDir(outPublic);
  ensureDir(outHistory);

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
    console.error("❌ 找不到可呼叫的 pickStocks 函式。exports keys:", Object.keys(mod || {}));
    process.exit(1);
  }

  console.log("✅ pickStocks resolved OK");
  console.log("   generatedAt(Taipei):", generatedAt);
  console.log("   historyKey(Taipei):", todayKey);

  const result = await pickStocks({
    market: "TW",
    generatedAt,
  });

  const picks = result?.picks || [];
  const meta = result?.meta || {};
  const asOfDataDate = result?.asOfDataDate || null;

  const todayJson = {
    market: "TW",
    generatedAt,
    asOfDataDate,       // ✅ 重要：資料日（最近交易日）
    topN: 3,
    picks,
    meta,
  };

  const todayPath = path.join(outPublic, "today.json");
  fs.writeFileSync(todayPath, JSON.stringify(todayJson, null, 2), "utf-8");

  const historyPath = path.join(outHistory, `${todayKey}.json`);
  fs.writeFileSync(historyPath, JSON.stringify(todayJson, null, 2), "utf-8");

  console.log("✅ wrote:", path.relative(process.cwd(), todayPath));
  console.log("✅ wrote:", path.relative(process.cwd(), historyPath));
  console.log("✅ picks count:", picks.length);
  console.log("✅ asOfDataDate:", asOfDataDate || "—");
}

main().catch((e) => {
  console.error("❌ generate_today failed:", e);
  process.exit(1);
});
