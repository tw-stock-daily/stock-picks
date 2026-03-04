/**
 * script/generate_today.js
 * 投信優先（本土法人）二次加權版：不改你原本 pickStocks，只在產檔前做 re-rank
 *
 * 特色：
 * - 仍沿用你原本 pickStocks 的 picks 結構與流程
 * - 針對每支 pick 的 inst 做「投信優先」加權分數 instAdj
 * - 用 newScore = score + instAdj 重新排序取 TOP3
 * - 會把 instAdj / instWeightedNet / instNote 寫回 inst 方便你 debug
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------- Time helpers (Asia/Taipei) ----------
function fmtTaipei(dt = new Date()) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(dt)
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
function taipeiDateKey(dt = new Date()) {
  // YYYY-MM-DD in Asia/Taipei
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

// ---------- Safe number ----------
function num(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// ---------- 投信優先法人加權（二次加權）----------
// 注意：你現在 today.json 的 inst 沒有 series/trustStreak，所以這版用「可取得的欄位」做加權：
// sumTrust, sumForeign, sumDealer, latestTrustNet, latestTotalNet, buyStreak
//
// 如果你未來在核心加上 trustStreak/trustRatio，這裡也能再升級（但先讓你穩穩上線）。
function calcTrustFirstAdj(inst) {
  if (!inst) return { instAdj: 0, meta: { note: "no inst" } };

  const sumTrust = num(inst.sumTrust, 0);
  const sumForeign = num(inst.sumForeign, 0);
  const sumDealer = num(inst.sumDealer, 0);

  const latestTrustNet = num(inst.latestTrustNet, 0);
  const latestTotalNet = num(inst.latestTotalNet, 0);
  const buyStreak = num(inst.buyStreak, 0);

  // 權重（你要的核心）
  const wTrust = 1.5;
  const wForeign = 1.0;
  const wDealer = 0.5;

  const instWeightedNet = sumTrust * wTrust + sumForeign * wForeign + sumDealer * wDealer;

  // 基底：log 壓縮，避免大張數碾壓
  const base = Math.sign(instWeightedNet || 0) * Math.log10(Math.abs(instWeightedNet) + 10);

  // 投信方向加權：投信為正、且最新一天投信也為正 → 加分；反之扣分
  let trustBonus = 0;
  if (sumTrust > 0) trustBonus += 0.8;
  if (sumTrust < 0) trustBonus -= 0.8;
  if (latestTrustNet > 0) trustBonus += 0.6;
  if (latestTrustNet < 0) trustBonus -= 0.6;

  // 外資大賣扣分（避免外資砍盤壓住投信）
  let foreignPenalty = 0;
  if (sumForeign <= -1000) foreignPenalty -= 1.2;
  else if (sumForeign > -1000) foreignPenalty += 0.2;

  // 法人總體（延用你原本 buyStreak 的概念，當作穩定度）
  let stability = 0;
  if (buyStreak >= 3) stability += 0.6;
  if (latestTotalNet < 0) stability -= 0.4;

  // 合成，轉成對原 score 的「加減分」
  // 你的 score 通常是 0~100 左右（你貼的 95.785），所以 instAdj 設計成 +-8 以內，避免翻車。
  let instAdj = (base * 1.4) + trustBonus + foreignPenalty + stability;
  instAdj = clamp(instAdj * 2.0, -8, 8);

  const note = [
    `weighted=${instWeightedNet.toFixed(0)}(張加權)`,
    `sumTrust=${sumTrust}`,
    `latestTrust=${latestTrustNet}`,
    `sumForeign=${sumForeign}`,
    `buyStreak=${buyStreak}`,
    `adj=${instAdj.toFixed(2)}`
  ].join(" | ");

  return {
    instAdj,
    meta: {
      instWeightedNet,
      weights: { trust: wTrust, foreign: wForeign, dealer: wDealer },
      base,
      trustBonus,
      foreignPenalty,
      stability,
      note
    }
  };
}

// ---------- resolve pickStocks from your repo ----------
function resolvePickStocks() {
  // 依常見結構嘗試載入（不改你的專案結構也能跑）
  const candidates = [
    "../pickStocks",
    "../src/pickStocks",
    "../core/pickStocks",
    "../lib/pickStocks",
    "./pickStocks",
    "../script/pickStocks",
    "../scripts/pickStocks",
    "../engine/pickStocks",
  ];

  for (const p of candidates) {
    try {
      const mod = require(path.join(__dirname, p));
      // 可能是 module.exports = pickStocks 或 { pickStocks }
      if (typeof mod === "function") return mod;
      if (mod && typeof mod.pickStocks === "function") return mod.pickStocks;
    } catch (_) {}
  }

  throw new Error(
    `Cannot resolve pickStocks(). Please tell me where pickStocks is exported.\n` +
      `Tried: ${candidates.join(", ")}`
  );
}

async function main() {
  const pickStocks = resolvePickStocks();

  // 1) 先跑你原本的選股（不動它）
  const result = await pickStocks();

  if (!result || typeof result !== "object") {
    throw new Error("pickStocks() returned invalid result");
  }

  // 你原本 result 結構不一定一樣，所以做保守處理：
  // - 如果有 result.picks 用它
  // - 否則若 result 本身就是 picks array，也支援
  const picks = Array.isArray(result.picks) ? result.picks : (Array.isArray(result) ? result : null);
  if (!picks) throw new Error("Cannot find picks array from pickStocks() result");

  // 2) 投信優先二次加權 + 重排
  const enriched = picks.map((p) => {
    const inst = p.inst || null;
    const { instAdj, meta } = calcTrustFirstAdj(inst);

    // newScore 用來重排，不破壞原 score（保留）
    const baseScore = num(p.score, 0);
    const newScore = baseScore + instAdj;

    // 把 debug 資訊寫回 inst（App 不用改也不會壞）
    if (inst && typeof inst === "object") {
      inst.instWeightedNet = meta.instWeightedNet;
      inst.instAdj = Number(instAdj.toFixed(3));
      inst.instNote = meta.note;
      inst.instWeights = meta.weights;
    }

    return {
      ...p,
      _baseScore: baseScore,
      _instAdj: instAdj,
      _newScore: newScore,
    };
  });

  enriched.sort((a, b) => b._newScore - a._newScore);

  // 3) 取 TOP3（並保留原本 reason/主推邏輯：第一名主推，其餘補位）
  const top3 = enriched.slice(0, 3).map((p, idx) => {
    const out = { ...p };
    // 用新分數覆蓋 score，讓 App 直接看到排序結果
    out.score = Number(num(out._newScore, 0).toFixed(3));

    // 補上主推/補位（如果你原本已經有 reason，就尊重原本）
    if (!out.reason) out.reason = idx === 0 ? "主推" : "補位";
    if (!out.tradeStyle) out.tradeStyle = "基準版(穩定)+投信優先";
    return out;
  });

  // 4) 組裝輸出（盡量沿用你原本輸出欄位）
  const now = new Date();
  const generatedAtTaipei = fmtTaipei(now);
  const historyKey = taipeiDateKey(now);

  // 你原本有 asOfDataDate，有時是 —，這裡不強求，保留原本
  const payload = {
    ...(result.picks ? { ...result } : {}),
    generatedAt: result.generatedAt || new Date().toISOString(),
    generatedAtTaipei,
    historyKey,
    picks: top3,
    picksCount: top3.length,
    note: "投信優先二次加權：在原選股結果上，以投信/本土法人權重做 re-rank（不改核心引擎）。",
  };

  // 5) 寫檔
  const outToday = path.join(process.cwd(), "public", "today.json");
  const outHist = path.join(process.cwd(), "public", "history", `${historyKey}.json`);

  writeJson(outToday, payload);
  writeJson(outHist, payload);

  console.log("✅ pickStocks resolved OK");
  console.log(`   generatedAt(Taipei): ${generatedAtTaipei}`);
  console.log(`   historyKey(Taipei): ${historyKey}`);
  console.log(`✅ wrote: public/today.json`);
  console.log(`✅ wrote: public/history/${historyKey}.json`);
  console.log(`✅ picks count: ${top3.length}`);
}

main().catch((e) => {
  console.error("❌ generate_today failed:", e?.stack || String(e));
  process.exit(1);
});
