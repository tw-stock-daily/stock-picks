/**
 * 生成 public/today.json
 * v3.9 資金流強勢版
 */

const fs = require("fs");
const path = require("path");
const { pickStocks } = require("../lib/pickStocks");

function nowInTaipei() {
  const now = new Date();
  const taipei = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  return taipei;
}

function ymdTaipei(date = nowInTaipei()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isoTaipei(date = nowInTaipei()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
}

async function main() {
  const result = await pickStocks();
  const today = ymdTaipei();
  const generatedAt = isoTaipei();

  const payload = {
    version: "v3.9",
    tradeStyle: "資金流強勢版v3.9",
    generatedAt,
    asOfLocal: generatedAt,
    date: today,
    marketState: result.marketState || "neutral",

    hotThemes: (result.hotThemes || []).map((x, idx) => ({
      rank: idx + 1,
      theme: x.theme,
      score: x.score,
      news: (x.news || []).slice(0, 3)
    })),

    picks: (result.picks || []).map((x, idx) => ({
      rank: idx + 1,
      symbol: x.symbol,
      name: x.name,
      score: x.score,
      baseScore: x.baseScore,
      instScore: x.instScore,
      themeScore: x.themeScore,

      lastClose: x.lastClose,
      rsi14: x.rsi14,
      volRatio: x.volRatio,
      ma5: x.ma5,
      ma10: x.ma10,
      ma20: x.ma20,
      atr14: x.atr14,
      macdDif: x.macdDif,
      macdDea: x.macdDea,
      macdHist: x.macdHist,

      rs5: x.rs5,
      rs10: x.rs10,
      rsScore: x.rsScore,
      falseBreakoutLike: x.falseBreakoutLike,

      plan: x.plan,
      inst: x.inst,

      stockTags: x.stockTags || [],
      industryRoots: x.industryRoots || [],
      industryRoles: x.industryRoles || [],
      matchedThemes: x.matchedThemes || [],
      matchedThemeReasons: x.matchedThemeReasons || [],
      theme: x.theme || null,

      marketState: x.marketState || result.marketState || "neutral",
      asOfDataDate: x.asOfDataDate,
      reason: x.reason,
      tradeStyle: x.tradeStyle
    })),

    candidatesCount: Array.isArray(result.candidates) ? result.candidates.length : 0
  };

  const publicDir = path.join(process.cwd(), "public");
  const historyDir = path.join(publicDir, "history");

  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });

  const todayPath = path.join(publicDir, "today.json");
  const historyPath = path.join(historyDir, `${today}.json`);

  fs.writeFileSync(todayPath, JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(historyPath, JSON.stringify(payload, null, 2), "utf8");

  console.log(`✅ generated: ${todayPath}`);
  console.log(`✅ history:   ${historyPath}`);
  console.log(`✅ version:   ${payload.version}`);
  console.log(`✅ tradeStyle:${payload.tradeStyle}`);
  console.log(`✅ marketState:${payload.marketState}`);
  console.log(`✅ hotThemes: ${(payload.hotThemes || []).map(x => x.theme).join(", ")}`);
  console.log(`✅ picks:     ${(payload.picks || []).map(x => `${x.symbol}-${x.name}`).join(", ") || "(none)"}`);
  console.log(`✅ candidates:${payload.candidatesCount}`);
}

main().catch(err => {
  console.error("❌ generate_today failed");
  console.error(err);
  process.exit(1);
});
