import fs from "fs";

function pad(n) {
  return String(n).padStart(2, "0");
}

function taipeiNowString() {
  // GitHub Actions 會用 UTC，我們手動轉成台北時間 (+8)
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const y = now.getUTCFullYear();
  const m = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const hh = pad(now.getUTCHours());
  const mm = pad(now.getUTCMinutes());
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

const path = "public/today.json";
const raw = fs.readFileSync(path, "utf8");
const data = JSON.parse(raw);

// 只更新 generatedAt，先證明排程成功
data.generatedAt = taipeiNowString();

fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log("Updated", path, "generatedAt =", data.generatedAt);
