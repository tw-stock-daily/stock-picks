/**
 * 台股精選 v3.1
 * 強勢早中段 + 主題擴充版（解決只推固定幾檔問題）
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 600 });

/* =======================
   參數
======================= */
const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000;
const MIN_PRICE = 10;

const RSI_MIN = 52;
const RSI_MAX = 78;

const VOL_RATIO_MIN = 1.2;
const VOL_RATIO_CAP = 3.5;
const VOL_RATIO_HARD_MAX = 4.5;

const BIAS_SOFT_MAX = 0.12;
const BIAS_HARD_MAX = 0.15;

const RECENT_RUNUP_SOFT = 0.08;
const RECENT_RUNUP_HARD = 0.16;

/* =======================
   ⭐ 主題擴充（重點）
======================= */
const THEME_MAP = {
  "AI主題": [
    // 記憶體
    "2337","2344","2408","3006","3260","4967","8299",

    // PCB
    "2313","2368","2383","3037","3044","3189","4958","6274","8046",

    // 光通訊
    "3081","3163","3363","4908","4979","5381","6442",

    // 網通 / CPO
    "2345","2412","3013","3025","3596","3665","6285","6805",

    // AI伺服器
    "2308","2317","2356","2376","2382","3231","6669",

    // 散熱
    "3017","3324","3653","6125",

    // IC設計
    "3035","3443","5269","6533","6661",

    // 半導體設備
    "3131","3413","3583","6196","6531","6603"
  ],

  "自動化": [
    "1536","2049","3019","4540","4551","4562","4583","8374"
  ]
};

const THEME_BONUS = {
  "AI主題": 2.5,
  "自動化": 1.5
};

function findTheme(id) {
  for (const [k, arr] of Object.entries(THEME_MAP)) {
    if (arr.includes(id)) return k;
  }
  return null;
}

/* =======================
   工具
======================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toNum(x) {
  if (!x) return 0;
  return Number(String(x).replace(/,/g, "")) || 0;
}

function pct(a, b) {
  if (!a) return 0;
  return (b - a) / a;
}

/* =======================
   技術指標
======================= */
function sma(arr, n) {
  return arr.map((_, i) =>
    i < n - 1 ? null : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n
  );
}

function rsi(arr, n = 14) {
  const out = Array(arr.length).fill(null);
  let gain = 0, loss = 0;

  for (let i = 1; i <= n; i++) {
    const d = arr[i] - arr[i - 1];
    d > 0 ? gain += d : loss -= d;
  }

  gain /= n; loss /= n;
  out[n] = 100 - 100 / (1 + gain / loss);

  for (let i = n + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (n - 1) + g) / n;
    loss = (loss * (n - 1) + l) / n;
    out[i] = 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/* =======================
   Yahoo
======================= */
async function fetchBars(id) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${id}.TW`;

  const r = await axios.get(url);
  const data = r.data.chart.result[0];

  const bars = data.timestamp.map((t, i) => ({
    close: toNum(data.indicators.quote[0].close[i]),
    high: toNum(data.indicators.quote[0].high[i]),
    low: toNum(data.indicators.quote[0].low[i]),
    volume: toNum(data.indicators.quote[0].volume[i]),
  }));

  return bars.filter(b => b.close > 0);
}

/* =======================
   核心 scoring
======================= */
function scoreStock(id, bars) {
  const c = bars.map(b => b.close);
  const v = bars.map(b => b.volume);

  const ma20 = sma(c, 20);
  const ma5 = sma(c, 5);
  const rsi14 = rsi(c);

  const i = c.length - 1;

  const close = c[i];
  const r = rsi14[i];
  const volRatio = v[i] / (sma(v,20)[i] || 1);

  const bias = close / ma20[i] - 1;
  const runup = pct(c[i-3], close);

  // ❌ 硬淘汰
  if (r > 85) return null;
  if (volRatio > VOL_RATIO_HARD_MAX) return null;
  if (bias > BIAS_HARD_MAX) return null;
  if (runup > RECENT_RUNUP_HARD) return null;

  // ✅ 條件
  if (!(close > ma20[i] && ma5[i] > ma20[i])) return null;
  if (!(r >= RSI_MIN && r <= RSI_MAX)) return null;
  if (!(volRatio >= VOL_RATIO_MIN)) return null;

  // 分數
  let score = 0;

  score += (close / ma20[i] - 1) * 100 * 2;
  score += (Math.min(volRatio, VOL_RATIO_CAP) - 1) * 5;

  // 軟扣分
  if (runup > RECENT_RUNUP_SOFT) {
    score -= (runup - RECENT_RUNUP_SOFT) * 100;
  }

  if (bias > BIAS_SOFT_MAX) {
    score -= (bias - BIAS_SOFT_MAX) * 100;
  }

  // RSI甜區
  if (r >= 56 && r <= 68) score += 2;

  // ⭐ 主題加分
  const theme = findTheme(id);
  if (theme) score += THEME_BONUS[theme] || 0;

  return {
    score,
    close,
    rsi: r,
    volRatio,
    theme
  };
}

/* =======================
   主流程
======================= */
async function pickStocks() {
  const list = [];

  const pool = await axios.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");

  const stocks = pool.data
    .filter(x => toNum(x.TradeVolume) > MIN_LIQ_SHARES && toNum(x.ClosingPrice) > MIN_PRICE)
    .slice(0, POOL_SIZE);

  for (const s of stocks) {
    try {
      const bars = await fetchBars(s.Code);
      if (!bars || bars.length < 30) continue;

      const r = scoreStock(s.Code, bars);
      if (!r) continue;

      list.push({
        symbol: s.Code,
        name: s.Name,
        score: r.score,
        lastClose: r.close,
        rsi14: r.rsi,
        volRatio: r.volRatio,
        theme: r.theme
      });

      await sleep(80);

    } catch {}
  }

  list.sort((a,b) => b.score - a.score);

  return {
    picks: list.slice(0,3),
    candidates: list
  };
}

module.exports = { pickStocks };
