"use strict";

/**
 * script/generate_today.js
 * 起漲版 v2 輸出器（含推薦理由）
 */

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

// ---------- resolve pickStocks ----------
function resolvePickStocks() {
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
      if (typeof mod === "function") return mod;
      if (mod && typeof mod.pickStocks === "function") return mod.pickStocks;
    } catch (_) {}
  }

  throw new Error(
    `Cannot resolve pickStocks(). Please tell me where pickStocks is exported.\n` +
      `Tried: ${candidates.join(", ")}`
  );
}

function looksLikePickItem(x) {
  return x && typeof x === "object" && typeof x.symbol === "string" && ("score" in x);
}

function extractCandidateArray(result) {
  const preferredKeys = ["candidates", "all", "allList", "ranked", "eligible", "universe", "pool", "items", "list"];
  for (const k of preferredKeys) {
    const v = result?.[k];
    if (Array.isArray(v) && v.some(looksLikePickItem)) return v.filter(looksLikePickItem);
  }

  let best = null;
  for (const [, v] of Object.entries(result || {})) {
    if (!Array.isArray(v)) continue;
    if (!v.some(looksLikePickItem)) continue;
    if (!best || v.length > best.length) best = v;
  }
  return best ? best.filter(looksLikePickItem) : null;
}

// ---------- 法人最低門檻 ----------
function instFilter(inst, level) {
  if (!inst) return { pass: true, reason: "no inst" };

  const sumTrust = num(inst.sumTrust, 0);
  const sumForeign = num(inst.sumForeign, 0);
  const latestTrustNet = num(inst.latestTrustNet, 0);

  const TH = {
    TRUST_SUM_TOO_NEG: -1000,
    TRUST_LATEST_TOO_NEG: -200,
    FOREIGN_SUM_TOO_NEG: -2000,
  };

  if (level === 1) {
    if (sumTrust <= TH.TRUST_SUM_TOO_NEG) return { pass: false, reason: `投信窗口大賣(sumTrust<=${TH.TRUST_SUM_TOO_NEG})` };
    if (latestTrustNet <= TH.TRUST_LATEST_TOO_NEG) return { pass: false, reason: `投信當日明顯賣(latestTrust<=${TH.TRUST_LATEST_TOO_NEG})` };
    if (sumForeign <= TH.FOREIGN_SUM_TOO_NEG) return { pass: false, reason: `外資窗口大砍(sumForeign<=${TH.FOREIGN_SUM_TOO_NEG})` };
    return { pass: true, reason: "pass(level1)" };
  }

  if (level === 2) {
    if (sumTrust <= TH.TRUST_SUM_TOO_NEG) return { pass: false, reason: `投信窗口大賣(sumTrust<=${TH.TRUST_SUM_TOO_NEG})` };
    if (sumForeign <= TH.FOREIGN_SUM_TOO_NEG) return { pass: false, reason: `外資窗口大砍(sumForeign<=${TH.FOREIGN_SUM_TOO_NEG})` };
    return { pass: true, reason: "pass(level2)" };
  }

  if (sumForeign <= TH.FOREIGN_SUM_TOO_NEG) return { pass: false, reason: `外資窗口大砍(sumForeign<=${TH.FOREIGN_SUM_TOO_NEG})` };
  return { pass: true, reason: "pass(level3)" };
}

// ---------- 法人小幅加權 ----------
function calcInstAdj(inst) {
  if (!inst) return { instAdj: 0, meta: { note: "no inst" } };

  const sumTrust = num(inst.sumTrust, 0);
  const sumForeign = num(inst.sumForeign, 0);
  const sumDealer = num(inst.sumDealer, 0);

  const latestTrustNet = num(inst.latestTrustNet, 0);
  const latestTotalNet = num(inst.latestTotalNet, 0);
  const buyStreak = num(inst.buyStreak, 0);

  const wTrust = 1.5;
  const wForeign = 1.0;
  const wDealer = 0.5;

  const instWeightedNet = sumTrust * wTrust + sumForeign * wForeign + sumDealer * wDealer;
  const base = Math.sign(instWeightedNet || 0) * Math.log10(Math.abs(instWeightedNet) + 10);

  let trustBias = 0;
  if (sumTrust > 0) trustBias += 0.5;
  if (sumTrust < 0) trustBias -= 0.5;
  if (latestTrustNet > 0) trustBias += 0.3;
  if (latestTrustNet < 0) trustBias -= 0.3;

  let stability = 0;
  if (buyStreak >= 3) stability += 0.3;
  if (latestTotalNet < 0) stability -= 0.2;

  let instAdj = (base * 1.0) + trustBias + stability;
  instAdj = clamp(instAdj * 1.8, -6, 6);

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
      trustBias,
      stability,
      note,
    }
  };
}

// ---------- main ----------
async function main() {
  const pickStocks = resolvePickStocks();
  const result = await pickStocks();

  if (!result || typeof result !== "object") {
    throw new Error("pickStocks() returned invalid result");
  }

  const picks0 = Array.isArray(result.picks) ? result.picks : (Array.isArray(result) ? result : null);
  if (!picks0) throw new Error("Cannot find picks array from pickStocks() result");

  const candidates = extractCandidateArray(result) || picks0;

  const selected = [];
  const used = new Set();

  for (const level of [1, 2, 3]) {
    const enriched = candidates
      .filter(looksLikePickItem)
      .map((p) => {
        const inst = p.inst || null;

        const f = instFilter(inst, level);
        const { instAdj, meta } = calcInstAdj(inst);

        const baseScore = num(p.score, 0);
        const newScore = baseScore + instAdj;

        if (inst && typeof inst === "object") {
          inst.instFilterPass = !!f.pass;
          inst.instFilterLevel = level;
          inst.instFilterReason = f.reason;

          inst.instWeightedNet = meta.instWeightedNet;
          inst.instAdj = Number(instAdj.toFixed(3));
          inst.instNote = meta.note;
          inst.instWeights = meta.weights;
        }

        return { ...p, _baseScore: baseScore, _instAdj: instAdj, _newScore: newScore, _filter: f };
      })
      .filter((p) => p._filter?.pass);

    enriched.sort((a, b) => b._newScore - a._newScore);

    for (const p of enriched) {
      if (selected.length >= 3) break;
      if (used.has(p.symbol)) continue;
      selected.push(p);
      used.add(p.symbol);
    }

    if (selected.length >= 3) break;
  }

  if (selected.length < 3) {
    for (const p of picks0) {
      if (selected.length >= 3) break;
      if (used.has(p.symbol)) continue;

      if (p.inst && typeof p.inst === "object") {
        p.inst.instFilterPass = false;
        p.inst.instFilterLevel = 99;
        p.inst.instFilterReason = "候選不足補位(保底)";
      }

      selected.push(p);
      used.add(p.symbol);
    }
  }

  const top3 = selected.slice(0, 3).map((p, idx) => {
    const out = { ...p };
    const ns = num(out._newScore, num(out.score, 0));
    out.score = Number(ns.toFixed(3));
    out.tradeStyle = "起漲版v2";
    if (!out.reason) out.reason = idx === 0 ? "主推" : "補位";
    return out;
  });

  const now = new Date();
  const generatedAtTaipei = fmtTaipei(now);
  const historyKey = taipeiDateKey(now);

  const payload = {
    ...(result.picks ? { ...result } : {}),
    generatedAt: result.generatedAt || new Date().toISOString(),
    generatedAtTaipei,
    historyKey,
    picks: top3,
    picksCount: top3.length,
    note: "起漲版v2：過熱股硬淘汰（RSI/量比/乖離/近3日漲幅），並新增推薦理由。",
  };

  const outToday = path.join(process.cwd(), "public", "today.json");
  const outHist = path.join(process.cwd(), "public", "history", `${historyKey}.json`);

  writeJson(outToday, payload);
  writeJson(outHist, payload);

  console.log("✅ pickStocks resolved OK");
  console.log(`   generatedAt(Taipei): ${generatedAtTaipei}`);
  console.log(`   historyKey(Taipei): ${historyKey}`);
  console.log("✅ wrote: public/today.json");
  console.log(`✅ wrote: public/history/${historyKey}.json`);
  console.log(`✅ picks count: ${top3.length}`);
}

main().catch((e) => {
  console.error("❌ generate_today failed:", e?.stack || String(e));
  process.exit(1);
});
