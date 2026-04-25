/**
 * 生成 public/today.json
 * v3.9.2
 *
 * 新增：
 * - picks：正式推薦 1~3 名，列入勝率
 * - alternates：備選 4~6 名，不列入勝率
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

function normalizePick(x, idx, type = "pick") {
  return {
    rank: type === "pick" ? idx + 1 : idx + 4,
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
    tp1: x.plan?.tp1 ?? x.tp1,
    tp2: x.plan?.tp2 ?? x.tp2,
    stop: x.plan?.stop ?? x.stop,

    inst: x.inst,

    stockTags: x.stockTags || [],
    industryRoots: x.industryRoots || [],
    industryRoles: x.industryRoles || [],
    matchedThemes: x.matchedThemes || [],
    matchedThemeReasons: x.matchedThemeReasons || [],
    theme: x.theme || null,

    marketState: x.marketState,
    asOfDataDate: x.asOfDataDate,
    reason: x.reason,
    tradeStyle: x.tradeStyle,
    isAlternate: type === "alternate"
  };
}

async function main() {
  const result = await pickStocks();
  const today = ymdTaipei();
  const generatedAt = isoTaipei();

  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const picks = Array.isArray(result.picks) ? result.picks : [];

  const usedSymbols = new Set(picks.map(x => x.symbol));
  const alternatesRaw = candidates
    .filter(x => !usedSymbols.has(x.symbol))
    .slice(0, 3);

  const payload = {
    version: "v3.9.2",
    tradeStyle: "資金流強勢版v3.9.2",
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

    picks: picks.map((x, idx) => normalizePick(x, idx, "pick")),

    // 備選股不列入勝率分析，stats_winrate.js 只讀 picks
    alternates: alternatesRaw.map((x, idx) => normalizePick(x, idx, "alternate")),

    candidatesCount: candidates.length
  };

  const publicDir = path.join(process.cwd(), "public");
  const historyDir = path.join(publicDir, "history");

  fs.mkdirSync(publicDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });

  fs.writeFileSync(path.join(publicDir, "today.json"), JSON.stringify(payload, null, 2), "utf8");
  fs.writeFileSync(path.join(historyDir, `${today}.json`), JSON.stringify(payload, null, 2), "utf8");

  console.log(`✅ generated: ${path.join(publicDir, "today.json")}`);
  console.log(`✅ history:   ${path.join(historyDir, `${today}.json`)}`);
  console.log(`✅ version:   ${payload.version}`);
  console.log(`✅ tradeStyle:${payload.tradeStyle}`);
  console.log(`✅ marketState:${payload.marketState}`);
  console.log(`✅ picks:     ${payload.picks.map(x => `${x.symbol}-${x.name}`).join(", ") || "(none)"}`);
  console.log(`✅ alternates:${payload.alternates.map(x => `${x.symbol}-${x.name}`).join(", ") || "(none)"}`);
  console.log(`✅ candidates:${payload.candidatesCount}`);
}

main().catch(err => {
  console.error("❌ generate_today failed");
  console.error(err);
  process.exit(1);
});