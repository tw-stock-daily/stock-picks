// script/generate_today.js
const fs = require("fs");
const { pickStocks } = require("../lib/pickStocks.js");

function pad(n) { return String(n).padStart(2, "0"); }
function taipeiNowString() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
}

async function main() {
  const FINMIND_TOKEN = process.env.FINMIND_TOKEN || "";

  // 你想固定參數就寫死在這（跟你 API 預設一致）
  const data = await pickStocks({
    FINMIND_TOKEN,
    windowDays: 10,
    bucket: "all",
    topK: 40,
  });

  const out = {
    market: "TW",
    generatedAt: taipeiNowString(),
    topN: 3,
    picks: (data.picks || []).slice(0, 3),
    meta: {
      finmindEnabled: data.finmindEnabled,
      windowDays: data.windowDays,
      bucket: data.bucket,
      pool: data.pool,
    }
  };

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/today.json", JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log("✅ Generated public/today.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
