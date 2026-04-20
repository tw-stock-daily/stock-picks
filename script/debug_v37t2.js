const axios = require("axios");
const {
  getDailyHotThemes,
  calcThemeScoreForStock
} = require("../lib/themeEngine");

const POOL_SIZE = 1000;
const MIN_LIQ_SHARES = 600000;
const MIN_PRICE = 10;
const MIN_AVG_VOL20 = 800;

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
function hasAny(arr, setObj) {
  return (arr || []).some(x => setObj.has(x));
}

const TECH_PRIORITY_THEMES = new Set([
  "CPO/光通訊",
  "半導體",
  "AI伺服器",
  "PCB/載板",
  "散熱",
  "電源/連接器",
  "機器人/自動化",
  "車用電子"
]);

const CORE_TECH_TAGS = new Set([
  "CPO/光通訊","光通訊模組","高速傳輸","交換器","矽光子",
  "半導體","晶圓代工","IC設計","封測","記憶體","AI晶片",
  "AI伺服器","伺服器ODM","伺服器組裝","主機板",
  "PCB/載板","PCB","ABF載板",
  "散熱","散熱模組","均熱板","熱管",
  "電源/連接器","電源供應器","連接器"
]);

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
    .slice(0, POOL_SIZE);
}

async function fetchBars(id) {
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

  return bars.length >= 60 ? bars : null;
}

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
  if (i < 35 || ma20Arr[i] == null) return null;

  const open = o[i];
  const close = c[i];
  const prevClose = c[i - 1];
  const ma5 = ma5Arr[i];
  const ma10 = ma10Arr[i];
  const ma20 = ma20Arr[i];
  const ma20Prev3 = ma20Arr[i - 3];
  const avgVol20 = vol20Arr[i] || 0;
  const volRatio = avgVol20 ? v[i] / avgVol20 : 0;
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

  if (avgVol20 < MIN_AVG_VOL20) return null;
  if (!(close > ma20 || ma5 > ma20)) return null;
  if (volRatio > 8.0) return null;
  if (volRatio < 0.9) return null;
  if (bias > 0.28) return null;
  if (runup5 > 0.35) return null;

  let score = 0;

  if (close > ma20) score += 2.8;
  if (ma5 > ma20) score += 2.8;
  if (ma5 > ma10) score += 2.2;
  if (ma10 > ma20) score += 2.0;
  if (close > ma5) score += 1.6;
  if (ma20Rising) score += 1.4;
  score += Math.max(0, (close / ma20 - 1) * 100 * 1.6);

  if (volRatio >= 1.0) score += 1.2;
  if (volRatio >= 1.3) score += 3.8;
  if (volRatio >= 1.8) score += 4.8;
  if (volAboveAvg) score += 1.2;
  if (v[i] > avgVol20 * 1.3) score += 1.2;

  if (difNow >= deaNow) score += 2.0;
  else score -= 1.0;

  if (histNow >= 0) score += 1.6;
  else score -= 1.0;

  if (histTurnUp) score += 4.8;
  if (histNow > histPrev) score += 1.8;
  if (zeroAxisUp) score += 1.5;

  if (difNow > deaNow && histNow > histPrev) score += 3.0;

  if (breakout20 && volRatio >= 1.1) score += 5.5;
  else if (breakout10 && volRatio >= 1.0) score += 3.8;
  else if (closeBreak10) score += 1.2;

  if (dayChg > 0.02) score += 1.8;
  if (close >= h[i] * 0.985) score += 1.5;
  if (lowerShadow > candleBody * 0.8 && dayChg > 0) score += 0.8;

  if (runup3 > 0.15) score -= (runup3 - 0.15) * 100 * 0.8;
  if (bias > 0.15) score -= (bias - 0.15) * 100 * 0.9;
  if (runup5 > 0.15) score -= 1.8;
  if (bias > 0.15) score -= 1.8;

  if (volRatio > 3.2 && upperShadow > Math.max(candleBody * 1.2, candleRange * 0.35)) score -= 2.8;
  if (dayChg < 0 && volRatio > 2.0) score -= 1.8;
  if (histNow < histPrev && histNow > 0) score -= 1.5;
  if ((breakout10 || breakout20) && close < open) score -= 2.0;
  if (upperShadow / candleRange > 0.45 && volRatio > 1.8) score -= 2.0;
  if (rsiVal != null && rsiVal > 88) score -= 1.2;

  return {
    score,
    asOfDataDate: bars[i].date
  };
}

function applyTechPriority(raw, themeInfo, hotThemes) {
  let score = raw;

  const matchedThemes = themeInfo?.matchedThemes || [];
  const stockTags = themeInfo?.stockTags || [];
  const industryRoots = themeInfo?.industryRoots || [];

  const techThemeHit =
    matchedThemes.some(x => TECH_PRIORITY_THEMES.has(x)) ||
    industryRoots.some(x => TECH_PRIORITY_THEMES.has(x));

  const coreTechTagHit = hasAny(stockTags, CORE_TECH_TAGS);

  if (techThemeHit) score += 4.0;
  if (coreTechTagHit) score += 2.8;

  const hotTop3 = (hotThemes || []).slice(0, 3).map(x => x.theme);
  const hotTop3Hit = matchedThemes.some(x => hotTop3.includes(x));
  if (hotTop3Hit) score += 3.0;

  if (!techThemeHit && !coreTechTagHit) score -= 2.5;

  return score;
}

(async () => {
  const stats = {
    pool: 0,
    barsOk: 0,
    techOk: 0,
    themeOk: 0,
    finalOk: 0,
    errors: 0
  };

  const samples = {
    barsOk: [],
    techOk: [],
    themeOk: [],
    finalOk: [],
    errors: []
  };

  try {
    const hotThemes = await getDailyHotThemes();
    console.log("hotThemes =", (hotThemes || []).map(x => x.theme));

    const pool = await getPool();
    stats.pool = pool.length;
    console.log("pool =", stats.pool);

    for (let idx = 0; idx < pool.length; idx++) {
      const s = pool[idx];

      try {
        const bars = await fetchBars(s.symbol);
        if (!bars) continue;
        stats.barsOk++;
        if (samples.barsOk.length < 8) samples.barsOk.push(`${s.symbol}-${s.name}`);

        const tech = scoreStock(bars);
        if (!tech) continue;
        stats.techOk++;
        if (samples.techOk.length < 8) samples.techOk.push(`${s.symbol}-${s.name}`);

        const themeInfo = calcThemeScoreForStock(s.symbol, hotThemes);
        stats.themeOk++;
        if (samples.themeOk.length < 8) {
          samples.themeOk.push(`${s.symbol}-${s.name} themes=${(themeInfo?.matchedThemes || []).join("/") || "-"}`);
        }

        const finalScore = applyTechPriority(
          tech.score + ((themeInfo?.themeScore || 0) * 0.8),
          themeInfo,
          hotThemes
        );

        if (finalScore >= 6.0) {
          stats.finalOk++;
          if (samples.finalOk.length < 12) {
            samples.finalOk.push(`${s.symbol}-${s.name} score=${finalScore.toFixed(3)} themeScore=${themeInfo?.themeScore || 0}`);
          }
        }
      } catch (e) {
        stats.errors++;
        if (samples.errors.length < 12) {
          samples.errors.push(`${s.symbol}-${s.name} ERROR: ${e.message}`);
        }
      }

      if ((idx + 1) % 100 === 0) {
        console.log(`processed ${idx + 1}/${pool.length}`);
      }
    }

    console.log("\n=== stats ===");
    console.log(stats);

    console.log("\n=== samples.barsOk ===");
    console.log(samples.barsOk);

    console.log("\n=== samples.techOk ===");
    console.log(samples.techOk);

    console.log("\n=== samples.themeOk ===");
    console.log(samples.themeOk);

    console.log("\n=== samples.finalOk ===");
    console.log(samples.finalOk);

    console.log("\n=== samples.errors ===");
    console.log(samples.errors);

  } catch (e) {
    console.error("FATAL:", e);
  }
})();