const fs = require("fs");
const { spawn } = require("child_process");

const FINMIND_TOKEN = process.env.FINMIND_TOKEN;
if (!FINMIND_TOKEN) {
  console.error("Missing FINMIND_TOKEN. Set it in GitHub Secrets.");
  process.exit(1);
}

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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ✅ 先暫時用這個，等你確認真正 API 再改
const API_PATH = "/api/picks";
const PORT = "8787";
const API_URL = `http://127.0.0.1:${PORT}${API_PATH}`;

async function main() {
  // 1) 啟動 server.js
  const env = { ...process.env, FINMIND_TOKEN, PORT };
  const proc = spawn("node", ["server.js"], { env, stdio: "inherit" });

  // 2) 等 server 起來（建議拉長一點比較穩）
  await sleep(8000);

  // 3) 呼叫 API
  const res = await fetch(API_URL);
  if (!res.ok) {
    proc.kill();
    throw new Error(`API failed: ${res.status} ${res.statusText}`);
  }
  const apiData = await res.json();

  // 4) 寫出 today.json
  const out = {
    market: "TW",
    generatedAt: taipeiNowString(),
    topN: apiData?.topN ?? apiData?.picks?.length ?? (Array.isArray(apiData) ? apiData.length : 5),
    picks: apiData?.picks ?? apiData,
  };

  fs.writeFileSync("public/today.json", JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log("✅ Wrote public/today.json");

  proc.kill();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
