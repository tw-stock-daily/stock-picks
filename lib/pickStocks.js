/**
 * 台股精選 v3.7
 * 強評分版
 * - 只做上市股（TWSE）
 * - 股票池 1000
 * - 主體：趨勢 + 量能 + MACD
 * - 題材 / 法人輔助
 * - 少量必要硬條件，其餘改為評分制
 * - 支援週末 / 非交易日：自動使用最後一個有效交易日
 */

const axios = require("axios");
const NodeCache = require("node-cache");
const {
  getDailyHotThemes,
  calcThemeScoreForStock
} = require("./themeEngine");

const cache = new NodeCache({ stdTTL: 600 });

/* =======================
   參數
======================= */
const POOL_SIZE = 1000;
const MAX_CONCURRENCY = 6;

const MIN_LIQ_SHARES = 600000;
const MIN_PRICE = 10;

// Yahoo volume 以張數尺度處理
const MIN_AVG_VOL20 = 800;

const VOL_RATIO_SOFT = 1.00;
const VOL_RATIO_STRONG = 1.30;
const VOL_RATIO_VERY_STRONG = 1.80;
const VOL_RATIO_EXTREME = 3.20;
const VOL_RATIO_HARD_MAX = 8.0;

const BIAS_SOFT_MAX = 0.15;
const BIAS_HARD_MAX = 0.28;

const RECENT_RUNUP_SOFT = 0.15;
const RECENT_RUNUP_HARD = 0.35;

const MIN_FINAL_SCORE = 8.0;

/* =======================
   工具
======================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toNum(x) {
  return Number(String(x ?? "").replace(/,/g, "").trim()) || 0;
}

function pct(a, b) {
  if (!a) return 0;
  return (b - a) / a;
}

function ymdFromTs(tsSec) {
  return new Date(tsSec * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function round(num, digits = 2) {
  return Number((num ?? 0).toFixed(digits));
}

function safeDiv(a, b, fallback = 0) {
  return b ? a / b : fallback;
}

function rollingMax(arr, start, end) {
  const s = Math.max(0, start);
  const e = Math.min(arr.length, end);
  if (s >= e) return null;
  let m = -Infinity;
  for (let i = s; i < e; i++) {
    if (arr[i] > m) m = arr[i];
  }
  return Number.isFinite(m) ? m : null;
}

/* =======================
   技術指標
======================= */
function sma(arr, n) {
  return arr.map((_, i) =>
    i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n
  );
}

function ema(arr, n) {
  if (!arr.length) return [];
  const k = 2 / (n + 1);
  const out = Array(arr.length).fill(null);
  let prev = arr[0];
  out[0] = prev;

  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function macd(arr) {
  const ema12 = ema(arr, 12);
  const ema26 = ema(arr, 26);
  const dif = arr.map((_, i) => (ema12[i] ?? 0) - (ema26[i] ?? 0));
  const dea = ema(dif, 9);
  const hist = dif.map((v, i) => v - (dea[i] ?? 0));
  return { dif, dea, hist };
}

function rsi(arr, n = 14) {
  const out = Array(arr.length).fill(null);
  if (arr.length <= n) return out;

  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = arr[i] - arr[i - 1];
    d > 0 ? gain += d : loss -= d;
  }

  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = n + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (n - 1) + g) / n;
    loss = (loss * (n - 1) + l) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(highs, lows, closes, n = 14) {
  const out = Array(closes.length).fill(null);
  if (closes.length < n + 1) return out;

  const tr = Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }

  let prev = 0;
  for (let i = 1; i <= n; i++) prev += tr[i] ?? 0;
  prev /= n;
  out[n] = prev;

  for (let i = n + 1; i < closes.length; i++) {
    prev = (prev * (n - 1) + (tr[i] ?? 0)) / n;
    out[i] = prev;
  }
  return out;
}

/* =======================
   Yahoo Bars
======================= */
async function fetchBars(id) {
  const cacheKey = `bars:${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${id}.TW`;

  const r = await axios.get(url, {
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const data = r.data?.chart?.result?.[0];
  if (!data) return null;

  const q = data.indicators?.quote?.[0];
  if (!q || !data.timestamp) return null;

  const bars = data.timestamp.map((t, i) => ({
    date: ymdFromTs(t),
    open: toNum(q.open?.[i]),
    close: toNum(q.close?.[i]),
    high: toNum(q.high?.[i]),
    low: toNum(q.low?.[i]),
    volume: toNum(q.volume?.[i]),
  })).filter(b =>
    b.open > 0 &&
    b.close > 0 &&
    b.high > 0 &&
    b.low > 0 &&
    b.volume >= 0
  );

  const out = bars.length >= 60 ? bars : null;
  cache.set(cacheKey, out);
  return out;
}

/* =======================
   股票池（只做上市股）
======================= */
async function getPool() {
  const r = await axios.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", {
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  return (r.data || [])
    .map(x => ({
      symbol: String(x.Code || "").trim(),
      name: x.Name,
      tradeVolume: toNum(x.TradeVolume),
      close: toNum(x.ClosingPrice)
    }))
    .filter(x =>
      /^\d{4}$/.test(x.symbol) &&
      x.tradeVolume > MIN_LIQ_SHARES &&
      x.close > MIN_PRICE
    )
    .sort((a, b) => b.tradeVolume - a.tradeVolume)
    .slice(0, POOL_SIZE)
    .map(x => ({
      symbol: x.symbol,
      name: x.name
    }));
}

/* =======================
   法人 T86
======================= */
async function fetchTwseT86ByDate(yyyymmdd) {
  const key = `t86:${yyyymmdd}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const resp = await axios.get("https://www.twse.com.tw/rwd/zh/fund/T86", {
      params: { response: "json", date: yyyymmdd, selectType: "ALL" },
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.twse.com.tw/"
      }
    });

    const j = resp.data;
    if (String(j?.stat || "") !== "OK") {
      cache.set(key, null);
      return null;
    }

    const fields = j?.fields || [];
    const data = j?.data || [];
    if (!fields.length || !data.length) {
      cache.set(key, null);
      return null;
    }

    const idx = (cands) => cands.map(n => fields.indexOf(n)).find(i => i >= 0);

    const iCode = idx(["證券代號", "代號", "股票代號"]);
    const iF = idx([
      "外資及陸資買賣超股數(不含外資自營商)",
      "外資及陸資買賣超股數",
      "外資買賣超股數"
    ]);
    const iI = idx(["投信買賣超股數", "投信買賣超"]);
    const iD = idx(["自營商買賣超股數", "自營商(合計)買賣超股數"]);
    const iT = idx(["三大法人買賣超股數", "合計買賣超股數", "三大法人買賣超"]);

    const map = new Map();
    for (const row of data) {
      const code = String(row[iCode] || "").trim();
      if (!/^\d{4}$/.test(code)) continue;

      const foreign = iF != null ? toNum(row[iF]) : 0;
      const trust = iI != null ? toNum(row[iI]) : 0;
      const dealer = iD != null ? toNum(row[iD]) : 0;
      const total = iT != null ? toNum(row[iT]) : foreign + trust + dealer;

      map.set(code, { foreign, trust, dealer, total });
    }

    const out = { date: yyyymmdd, map };
    cache.set(key, out);
    return out;
  } catch {
    cache.set(key, null);
    return null;
  }
}

function ymdToYYYYMMDD(ymd) {
  return String(ymd || "").replace(/-/g, "");
}

async function fetchInstFromTwse(stockId, asOfDate) {
  const base = new Date(asOfDate + "T00:00:00Z");
  const rows = [];

  for (let back = 0; back <= 45; back++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - back);

    const ds = ymdToYYYYMMDD(d.toISOString().slice(0, 10));
    const t86 = await fetchTwseT86ByDate(ds);
    if (!t86?.map) continue;

    const row = t86.map.get(stockId);
    if (!row) continue;

    rows.push({ date: ds, ...row });
    if (rows.length >= 20) break;
    await sleep(30);
  }

  if (!rows.length) return null;

  const latest = rows[0];
  const sum = rows.reduce((acc, x) => {
    acc.foreign += x.foreign;
    acc.trust += x.trust;
    acc.dealer += x.dealer;
    acc.total += x.total;
    return acc;
  }, { foreign: 0, trust: 0, dealer: 0, total: 0 });

  let buyStreak = 0;
  for (const x of rows) {
    if ((x.total ?? 0) > 0) buyStreak++;
    else break;
  }

  let trustBuyStreak = 0;
  for (const x of rows) {
    if ((x.trust ?? 0) > 0) trustBuyStreak++;
    else break;
  }

  const toLots = n => Math.round((n || 0) / 1000);

  return {
    windowDays: rows.length,
    asOfDate,
    latestDate: latest.date,
    sumTotal: toLots(sum.total),
    sumForeign: toLots(sum.foreign),
    sumTrust: toLots(sum.trust),
    sumDealer: toLots(sum.dealer),
    buyStreak,
    trustBuyStreak,
    latestTotalNet: toLots(latest.total),
    latestForeignNet: toLots(latest.foreign),
    latestTrustNet: toLots(latest.trust),
    latestDealerNet: toLots(latest.dealer),
    unit: "張",
    source: "TWSE T86 (json)"
  };
}

/* =======================
   法人分數（輔助）
======================= */
function calcInstitutionScore(inst) {
  if (!inst) {
    return {
      instScore: 0,
      instFlags: []
    };
  }

  let score = 0;
  const flags = [];

  if ((inst.sumTrust ?? 0) > 300) {
    score += 3.2;
    flags.push("投信波段加碼");
  } else if ((inst.sumTrust ?? 0) > 100) {
    score += 1.8;
    flags.push("投信偏多");
  } else if ((inst.sumTrust ?? 0) < -100) {
    score -= 2.2;
    flags.push("投信偏空");
  }

  if ((inst.trustBuyStreak ?? 0) >= 3) {
    score += 1.6;
    flags.push("投信連買");
  }

  if ((inst.sumForeign ?? 0) > 500) {
    score += 1.5;
    flags.push("外資加碼");
  } else if ((inst.sumForeign ?? 0) < -300) {
    score -= 1.2;
    flags.push("外資偏空");
  }

  if ((inst.sumTotal ?? 0) > 500) {
    score += 1.3;
    flags.push("三大法人偏多");
  } else if ((inst.sumTotal ?? 0) < -300) {
    score -= 1.5;
    flags.push("三大法人偏空");
  }

  if ((inst.buyStreak ?? 0) >= 3) {
    score += 1.0;
    flags.push("連續買超");
  }

  if ((inst.latestTrustNet ?? 0) > 50) score += 0.5;
  if ((inst.latestTotalNet ?? 0) < 0) score -= 0.6;

  return {
    instScore: Number(score.toFixed(3)),
    instFlags: flags
  };
}

/* =======================
   交易計畫
======================= */
function buildPlan(price, atrVal) {
  const atrUse = atrVal && atrVal > 0 ? atrVal : price * 0.03;
  return {
    entryLow: round(price - atrUse * 0.25, 2),
    entryHigh: round(price + atrUse * 0.20, 2),
    stop: round(price - atrUse * 1.4, 2),
    tp1: round(price + atrUse * 1.8, 2),
    tp2: round(price + atrUse * 2.8, 2),
  };
}

/* =======================
   推薦文字
======================= */
function buildReasonText({
  breakout20,
  breakout10,
  volRatio,
  histTurnUp,
  difAboveDea,
  instFlags,
  themeInfo
}) {
  const parts = [];

  if (breakout20 && volRatio >= 1.2) parts.push("20日突破");
  else if (breakout10 && volRatio >= 1.05) parts.push("10日轉強");

  if (volRatio >= VOL_RATIO_VERY_STRONG) parts.push("爆量");
  else if (volRatio >= VOL_RATIO_STRONG) parts.push("量增");

  if (histTurnUp) parts.push("MACD翻強");
  else if (difAboveDea) parts.push("MACD多方");

  if (themeInfo?.matchedThemes?.length) parts.push(`主流:${themeInfo.matchedThemes[0]}`);
  if (instFlags?.length) parts.push(instFlags[0]);

  return parts.length ? parts.join(" / ") : "主推候選";
}

/* =======================
   核心評分
======================= */
function scoreStock(bars) {
  const o = bars.map(b => b.open);
  const c = bars.map(b => b.close);
  const h = bars.map(b => b.high);
  const l = bars.map(b => b.low);
  const v = bars.map(b => b.volume);

  const ma5Arr = sma(c, 5);
  const ma10Arr = sma(c, 10);
  const ma20Arr = sma(c, 20);
  const vol20Arr = sma(v, 20);
  const rsiArr = rsi(c);
  const atrArr = atr(h, l, c, 14);
  const { dif, dea, hist } = macd(c);

  const i = c.length - 1;
  if (i < 35) return null;
  if (ma20Arr[i] == null) return null;

  const open = o[i];
  const close = c[i];
  const prevClose = c[i - 1];
  const ma5 = ma5Arr[i];
  const ma10 = ma10Arr[i];
  const ma20 = ma20Arr[i];
  const ma20Prev3 = ma20Arr[i - 3];
  const avgVol20 = vol20Arr[i] || 0;
  const volRatio = safeDiv(v[i], avgVol20 || 1, 0);
  const rsiVal = rsiArr[i];
  const atrVal = atrArr[i];

  const difNow = dif[i] ?? 0;
  const deaNow = dea[i] ?? 0;
  const histNow = hist[i] ?? 0;
  const histPrev = hist[i - 1] ?? 0;

  const bias = ma20 ? (close / ma20 - 1) : 0;
  const runup3 = i >= 3 ? pct(c[i - 3], close) : 0;
  const runup5 = i >= 5 ? pct(c[i - 5], close) : 0;
  const dayChg = prevClose ? pct(prevClose, close) : 0;

  const candleBody = Math.abs(close - open);
  const candleRange = Math.max(h[i] - l[i], 0.0001);
  const upperShadow = h[i] - Math.max(open, close);
  const lowerShadow = Math.min(open, close) - l[i];

  const prev10High = rollingMax(h, i - 10, i);
  const prev20High = rollingMax(h, i - 20, i);
  const prev10CloseHigh = rollingMax(c, i - 10, i);

  const breakout10 = prev10High != null ? close > prev10High : false;
  const breakout20 = prev20High != null ? close > prev20High : false;
  const closeBreak10 = prev10CloseHigh != null ? close > prev10CloseHigh : false;

  const histTurnUp = histNow > 0 && histPrev <= 0;
  const difAboveDea = difNow > deaNow;
  const zeroAxisUp = difNow > 0 && deaNow > 0;
  const ma20Rising = ma20Prev3 != null ? ma20 > ma20Prev3 : false;
  const volAboveAvg = v[i] > avgVol20;

  /* ===== 必要硬條件 ===== */
  if (avgVol20 < MIN_AVG_VOL20) return null;
  if (close <= ma20) return null;
  if (volRatio > VOL_RATIO_HARD_MAX) return null;
  if (bias > BIAS_HARD_MAX) return null;
  if (runup5 > RECENT_RUNUP_HARD) return null;

  let score = 0;

  /* ===== 趨勢分 ===== */
  score += (close / ma20 - 1) * 100 * 2.0;

  if (ma5 >= ma20) score += 3.0;
  if (ma5 > ma10) score += 2.5;
  if (ma10 > ma20) score += 2.2;
  if (close > ma5) score += 1.8;
  if (ma20Rising) score += 1.8;

  /* ===== 量能分 ===== */
  if (volRatio >= VOL_RATIO_SOFT) score += 1.5;
  else score -= 1.8;

  if (volRatio >= VOL_RATIO_STRONG) score += 4.5;
  if (volRatio >= VOL_RATIO_VERY_STRONG) score += 5.5;
  if (volAboveAvg) score += 1.5;
  if (v[i] > avgVol20 * 1.3) score += 1.5;

  /* ===== MACD 分 ===== */
  if (difNow >= deaNow) score += 2.5;
  else score -= 1.5;

  if (histNow >= 0) score += 2.0;
  else score -= 1.5;

  if (histTurnUp) score += 5.5;
  if (histNow > histPrev) score += 2.2;
  if (zeroAxisUp) score += 1.8;

  /* ===== 突破分 ===== */
  if (breakout20 && volRatio >= 1.15) score += 6.0;
  else if (breakout10 && volRatio >= 1.05) score += 4.0;
  else if (closeBreak10) score += 1.5;

  /* ===== K 棒強度 ===== */
  if (dayChg > 0.02) score += 2.0;
  if (close >= h[i] * 0.985) score += 1.8;
  if (lowerShadow > candleBody * 0.8 && dayChg > 0) score += 1.0;

  /* ===== 風險扣分 ===== */
  if (runup3 > RECENT_RUNUP_SOFT) {
    score -= (runup3 - RECENT_RUNUP_SOFT) * 100 * 0.9;
  }
  if (bias > BIAS_SOFT_MAX) {
    score -= (bias - BIAS_SOFT_MAX) * 100 * 1.0;
  }
  if (runup5 > 0.15) score -= 2.0;
  if (bias > 0.15) score -= 2.0;

  if (volRatio > VOL_RATIO_EXTREME && upperShadow > Math.max(candleBody * 1.2, candleRange * 0.35)) score -= 3.0;
  if (dayChg < 0 && volRatio > 2.0) score -= 2.0;
  if (histNow < histPrev && histNow > 0) score -= 1.8;
  if ((breakout10 || breakout20) && close < open) score -= 2.2;
  if (upperShadow / candleRange > 0.45 && volRatio > 1.8) score -= 2.2;
  if (rsiVal != null && rsiVal > 85) score -= 1.5;

  return {
    score: Number(score.toFixed(3)),
    close,
    volRatio,
    rsi: rsiVal,
    ma5,
    ma10,
    ma20,
    atr14: atrVal,
    macdDif: difNow,
    macdDea: deaNow,
    macdHist: histNow,
    breakout10,
    breakout20,
    histTurnUp,
    difAboveDea,
    asOfDataDate: bars[i].date
  };
}

/* =======================
   單檔處理
======================= */
async function processStock(s, hotThemes) {
  try {
    const bars = await fetchBars(s.symbol);
    if (!bars || bars.length < 60) return null;

    const tech = scoreStock(bars);
    if (!tech) return null;

    const inst = await fetchInstFromTwse(s.symbol, tech.asOfDataDate);
    const { instScore, instFlags } = calcInstitutionScore(inst);

    const themeInfo = calcThemeScoreForStock(s.symbol, hotThemes);

    const finalScore = tech.score + instScore * 0.6 + (themeInfo.themeScore || 0) * 0.5;

    if (finalScore < MIN_FINAL_SCORE) return null;

    return {
      symbol: s.symbol,
      name: s.name,
      score: round(finalScore, 3),
      baseScore: round(tech.score, 3),
      instScore: round(instScore, 3),
      themeScore: round(themeInfo.themeScore || 0, 3),

      lastClose: round(tech.close, 2),
      rsi14: round(tech.rsi ?? 0, 2),
      volRatio: round(tech.volRatio ?? 0, 2),
      ma5: round(tech.ma5 ?? 0, 2),
      ma10: round(tech.ma10 ?? 0, 2),
      ma20: round(tech.ma20 ?? 0, 2),
      atr14: round(tech.atr14 ?? 0, 2),
      macdDif: round(tech.macdDif ?? 0, 4),
      macdDea: round(tech.macdDea ?? 0, 4),
      macdHist: round(tech.macdHist ?? 0, 4),

      plan: buildPlan(tech.close, tech.atr14),
      inst,

      stockTags: themeInfo.stockTags,
      industryRoots: themeInfo.industryRoots,
      industryRoles: themeInfo.industryRoles,
      matchedThemes: themeInfo.matchedThemes,
      matchedThemeReasons: themeInfo.matchedReasons,
      theme: themeInfo.matchedThemes?.[0] || themeInfo.industryRoots?.[0] || null,

      asOfDataDate: tech.asOfDataDate,
      reason: buildReasonText({
        breakout20: tech.breakout20,
        breakout10: tech.breakout10,
        volRatio: tech.volRatio,
        histTurnUp: tech.histTurnUp,
        difAboveDea: tech.difAboveDea,
        instFlags,
        themeInfo
      }),
      tradeStyle: "強評分v3.7"
    };
  } catch {
    return null;
  }
}

/* =======================
   小量並行
======================= */
async function mapLimit(items, limit, worker) {
  const results = [];
  let idx = 0;

  async function runner() {
    while (idx < items.length) {
      const current = idx++;
      const result = await worker(items[current], current);
      if (result) results.push(result);
      await sleep(40);
    }
  }

  const jobs = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(jobs);
  return results;
}

/* =======================
   主流程
======================= */
async function pickStocks() {
  const [pool, hotThemes] = await Promise.all([
    getPool(),
    getDailyHotThemes()
  ]);

  const list = await mapLimit(pool, MAX_CONCURRENCY, async (s) => {
    return await processStock(s, hotThemes);
  });

  list.sort((a, b) => b.score - a.score);

  const picks = list.slice(0, 3).map((x, idx) => ({
    ...x,
    reason: idx === 0 ? `主推｜${x.reason}` : `補位｜${x.reason}`
  }));

  return {
    hotThemes,
    picks,
    candidates: list
  };
}

module.exports = { pickStocks };
