// script/generate_today.mjs
import fs from "fs";
import { pickStocks } from "../lib/pickStocks.mjs";

function pad(n) {
  return String(n).padStart(2, "0");
}

function taipeiNowString() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

async function main() {
  const FINMIND_TOKEN = process.env.FINMIND_TOKEN || "";

  const result = await pickStocks({ FINMIND_TOKEN });

  const out = {
    market: "TW",
    generatedAt: taipeiNowString(),
    topN: result.topN ?? (result.picks ? result.picks.length : 0),
    picks: result.picks ?? []
  };

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/today.json", JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log("✅ Generated public/today.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
