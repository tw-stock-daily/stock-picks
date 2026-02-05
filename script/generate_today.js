const fs = require("fs");
const path = require("path");
const { pickStocks } = require("../lib/pickStocks");

async function main() {
  const data = await pickStocks();

  if (
    !data ||
    !Array.isArray(data.picks) ||
    data.picks.length === 0 ||
    !data.meta ||
    !data.meta.pool ||
    data.meta.pool.size === 0
  ) {
    console.log("⚠️ No valid data today. Skip overwrite.");
    return;
  }

  const outDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, "today.json");
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2), "utf-8");

  console.log("✅ today.json generated");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
