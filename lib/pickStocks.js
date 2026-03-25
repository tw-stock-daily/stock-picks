/**
 * 台股精選 v3.4
 * 強勢追蹤版（取消RSI限制）
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

const VOL_RATIO_MIN = 1.05;
const VOL_RATIO_CAP = 5.0;
const VOL_RATIO_HARD_MAX = 8.0;

const BIAS_SOFT_MAX = 0.18;
const BIAS_HARD_MAX = 0.25;

const RECENT_RUNUP_SOFT = 0.15;
const RECENT_RUNUP_HARD = 0.30;

/* =======================
   主題（完整版）
======================= */
const THEME_MAP = {
  "AI主題": [
    "2308","2317","2324","2356","2376","2382","3231","4938","6669",
    "2337","2344","2408","3006","3260","4967","8069","8299",
    "2313","2368","2383","3037","3044","3189","4958","5347","5469","6213","6274","8039","8046",
    "3081","3163","3363","3450","3596","4908","4979","5381","6442",
    "2345","2412","3013","3025","3665","5388","6216","6285","6805",
    "3014","3017","3324","3653","6125","6230",
    "2379","2454","3035","3443","4961","5269","6533","6661","8054",
    "1560","2464","3131","3413","3583","5536","6196","6531","6603"
  ],

  "IC設計": [
    "2330","2303","2454","3034","3035","3105","3443","3529",
    "4961","5269","5299","6138","6415","6451","6526","6531","6533","6661","6789","8054","8110"
  ],

  "被動元件": [
    "2327","2375","2401","2456","2472","2492","3026","3357",
    "3592","6173","6207","6284","6449","8042"
  ],

  "電源/連接器": [
    "2301","2385","3023","3032","3211","3515","3605","4912",
    "6108","6269","6271","6414"
  ],

  "自動化": [
    "1504","1536","2049","3019","4510","4540","4551","4562","4583","8374","9945"
  ]
};

const THEME_BONUS = {
  "AI主題": 3.0,
  "IC設計": 2.2,
  "被動元件": 1.8,
  "電源/連接器": 1.6,
  "自動化": 1.5
};

function findThemes(id) {
  const out = [];
  for (const [k, arr] of Object.entries(THEME_MAP)) {
    if (arr.includes(id)) out.push(k);
  }
  return out;
}

/* =======================
   工具
======================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toNum(x) {
  return Number(String(x || "").replace(/,/g, "")) || 0;
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

  gain /= n;
  loss /= n;
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

  const q = data.indicators.quote[0];

  const bars = data.timestamp.map((t, i) => ({
    close: toNum(q.close[i]),
    high: toNum(q.high[i]),
    low: toNum(q.low[i]),
    volume: toNum(q.volume[i]),
  }));

  return bars.filter(b => b.close > 0);
}

/* =======================
   股票池
======================= */
async function getPool() {
  const r = await axios.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL");

  return r.data
    .filter(x => toNum(x.TradeVolume) > MIN_LIQ_SHARES && toNum(x.ClosingPrice) > MIN_PRICE)
    .slice(0, POOL_SIZE)
    .map(x => ({
      symbol: x.Code,
      name: x.Name
    }));
}

/* =======================
   核心評分
======================= */
function scoreStock(id, bars) {
  const c = bars.map(b => b.close);
  const v = bars.map(b => b.volume);

  const ma20Arr = sma(c, 20);
  const ma5Arr = sma(c, 5);
  const vol20Arr = sma(v, 20);
  const rsiArr = rsi(c);

  const i = c.length - 1;

  const close = c[i];
  const ma20 = ma20Arr[i];
  const ma5 = ma5Arr[i];
  const volRatio = v[i] / (vol20Arr[i] || 1);
  const rsiVal = rsiArr[i];

  const bias = ma20 ? (close / ma20 - 1) : 0;
  const runup = i >= 3 ? pct(c[i - 3], close) : 0;

  // 過熱才淘汰
  if (volRatio > VOL_RATIO_HARD_MAX) return null;
  if (bias > BIAS_HARD_MAX) return null;
  if (runup > RECENT_RUNUP_HARD) return null;

  // 趨勢條件（保留）
  if (!(close > ma20 && ma5 > ma20)) return null;

  let score = 0;

  // 趨勢強度
  score += (close / ma20 - 1) * 100 * 2.5;

  // 量能
  score += (Math.min(volRatio, VOL_RATIO_CAP) - 1) * 6;

  // ⭐突破（最重要）
  const recentHigh = Math.max(...c.slice(Math.max(0, i - 5), i));
  if (close > recentHigh) score += 6;

  // 軟扣分
  if (runup > RECENT_RUNUP_SOFT) {
    score -= (runup - RECENT_RUNUP_SOFT) * 100;
  }

  if (bias > BIAS_SOFT_MAX) {
    score -= (bias - BIAS_SOFT_MAX) * 100;
  }

  // 主題加分
  const themes = findThemes(id);
  let bonus = 0;
  for (const t of themes) {
    bonus += THEME_BONUS[t] || 0;
  }

  score += bonus;

  return {
    score,
    close,
    volRatio,
    rsi: rsiVal,
    themes
  };
}

/* =======================
   主流程
======================= */
async function pickStocks() {
  const pool = await getPool();
  const list = [];

  for (const s of pool) {
    try {
      const bars = await fetchBars(s.symbol);
      if (!bars || bars.length < 30) continue;

      const r = scoreStock(s.symbol, bars);
      if (!r) continue;

      list.push({
        symbol: s.symbol,
        name: s.name,
        score: Number(r.score.toFixed(3)),
        lastClose: r.close,
        rsi14: Number(r.rsi?.toFixed(2)),
        volRatio: Number(r.volRatio?.toFixed(2)),
        themes: r.themes,
        theme: r.themes?.[0] || null,
        tradeStyle: "強勢追蹤v3.4"
      });

      await sleep(60);
    } catch {
      await sleep(100);
    }
  }

  list.sort((a, b) => b.score - a.score);

  return {
    picks: list.slice(0, 3),
    candidates: list
  };
}

module.exports = { pickStocks };
