/**
 * 台股精選 v3.3
 * 強勢早中段 + 主題擴充完整版
 * 修正：
 * 1) RSI 放寬，避免強勢股被濾掉
 * 2) 主題池大幅擴充（AI / PCB / 光通訊 / 記憶體 / IC / 被動元件 / 連接器）
 * 3) 避免只輪固定幾檔
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

const RSI_MIN = 50;
const RSI_MAX = 85;

const VOL_RATIO_MIN = 1.15;
const VOL_RATIO_CAP = 4.0;
const VOL_RATIO_HARD_MAX = 6.0;

const BIAS_SOFT_MAX = 0.14;
const BIAS_HARD_MAX = 0.18;

const RECENT_RUNUP_SOFT = 0.10;
const RECENT_RUNUP_HARD = 0.20;

const RSI_HARD_MAX = 92;

/* =======================
   主題擴充（上下游一起納入）
======================= */
const THEME_MAP = {
  "AI主題": [
    // AI伺服器 / 組裝
    "2308","2317","2324","2356","2376","2382","3231","4938","6669",

    // 記憶體
    "2337","2344","2408","3006","3260","4967","8069","8299",

    // PCB / 載板
    "2313","2368","2383","3037","3044","3189","4958","5347","5469","6213","6274","8039","8046",

    // 光通訊
    "3081","3163","3363","3450","3596","4908","4979","5381","6442",

    // 網通 / CPO
    "2345","2412","3013","3025","3596","3665","4908","4979","5388","6216","6285","6805",

    // 散熱
    "3014","3017","3324","3653","6125","6230",

    // IC設計 / AI晶片相關
    "2379","2454","3035","3443","4961","5269","6533","6661","8054",

    // 半導體設備 / 材料
    "1560","2464","3131","3413","3583","5536","6196","6531","6603"
  ],

  "PCB/載板": [
    "2313","2368","2383","3037","3044","3189","4958","5347","5469","6213","6274","8039","8046"
  ],

  "光通訊/網通": [
    "2345","2412","3013","3025","3081","3163","3363","3450","3596",
    "3665","4908","4979","5381","5388","6216","6285","6442","6805"
  ],

  "記憶體": [
    "2337","2344","2408","3006","3260","4967","8069","8299"
  ],

  "IC設計/半導體": [
    "2303","2330","2379","2454","3034","3035","3105","3443","3529","4961",
    "5269","5299","6138","6415","6451","6526","6531","6533","6661","6789","8054","8110"
  ],

  "被動元件": [
    "2327","2375","2401","2456","2472","2492","3026","3357","3592","6173","6207","6284","6449","8042"
  ],

  "電源/連接器/零組件": [
    "2301","2385","3023","3032","3211","3515","3605","4912","6108","6269","6271","6414"
  ],

  "自動化/機器人": [
    "1504","1536","2049","3019","4510","4540","4551","4562","4583","8374","9945"
  ]
};

const THEME_BONUS = {
  "AI主題": 2.8,
  "PCB/載板": 2.2,
  "光通訊/網通": 2.6,
  "記憶體": 2.4,
  "IC設計/半導體": 2.0,
  "被動元件": 1.6,
  "電源/連接器/零組件": 1.5,
  "自動化/機器人": 1.5
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

  const r = await axios.get(url, {
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const data = r.data?.chart?.result?.[0];
  if (!data) return null;

  const q = data.indicators?.quote?.[0];
  if (!q || !data.timestamp) return null;

  const bars = data.timestamp.map((t, i) => ({
    close: toNum(q.close?.[i]),
    high: toNum(q.high?.[i]),
    low: toNum(q.low?.[i]),
    volume: toNum(q.volume?.[i]),
  })).filter(b => b.close > 0);

  return bars.length >= 30 ? bars : null;
}

/* =======================
   股票池
======================= */
async function getPool() {
  const key = "twse_pool";
  const cached = cache.get(key);
  if (cached) return cached;

  const r = await axios.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", {
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  const stocks = (r.data || [])
    .filter(x => toNum(x.TradeVolume) > MIN_LIQ_SHARES && toNum(x.ClosingPrice) > MIN_PRICE)
    .slice(0, POOL_SIZE)
    .map(x => ({
      symbol: x.Code,
      name: x.Name
    }));

  cache.set(key, stocks);
  return stocks;
}

/* =======================
   核心評分
======================= */
function scoreStock(id, bars) {
  const c = bars.map(b => b.close);
  const v = bars.map(b => b.volume);

  const ma20Arr = sma(c, 20);
  const ma5Arr = sma(c, 5);
  const rsiArr = rsi(c);
  const vol20Arr = sma(v, 20);

  const i = c.length - 1;
  const close = c[i];
  const ma20 = ma20Arr[i];
  const ma5 = ma5Arr[i];
  const r = rsiArr[i];
  const vol20 = vol20Arr[i] || 1;
  const volRatio = v[i] / vol20;

  const bias = ma20 ? (close / ma20 - 1) : 0;
  const runup = i >= 3 ? pct(c[i - 3], close) : 0;

  // 硬淘汰：真的過熱才砍
  if (r > RSI_HARD_MAX) return null;
  if (volRatio > VOL_RATIO_HARD_MAX) return null;
  if (bias > BIAS_HARD_MAX) return null;
  if (runup > RECENT_RUNUP_HARD) return null;

  // 強勢結構
  if (!(close > ma20 && ma5 > ma20)) return null;
  if (!(r >= RSI_MIN && r <= RSI_MAX)) return null;
  if (!(volRatio >= VOL_RATIO_MIN)) return null;

  let score = 0;

  // 趨勢強度
  score += (close / ma20 - 1) * 100 * 2.2;

  // 量能
  score += (Math.min(volRatio, VOL_RATIO_CAP) - 1) * 5.5;

  // 最近突破
  const recentHigh = Math.max(...c.slice(Math.max(0, i - 5), i));
  if (close > recentHigh) score += 4.5;

  // RSI甜區：偏強最好
  if (r >= 58 && r <= 74) score += 2.5;
  else if (r >= 52 && r <= 80) score += 1.2;

  // 軟扣分：不是直接淘汰
  if (runup > RECENT_RUNUP_SOFT) {
    score -= (runup - RECENT_RUNUP_SOFT) * 100 * 0.8;
  }

  if (bias > BIAS_SOFT_MAX) {
    score -= (bias - BIAS_SOFT_MAX) * 100 * 0.9;
  }

  // 主題加分（可多重）
  const themes = findThemes(id);
  let themeBonus = 0;
  for (const t of themes) {
    themeBonus += THEME_BONUS[t] || 0;
  }
  score += themeBonus;

  return {
    score,
    close,
    rsi: r,
    volRatio,
    ma5,
    ma20,
    biasPct: bias * 100,
    runup3dPct: runup * 100,
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
      if (!bars) continue;

      const r = scoreStock(s.symbol, bars);
      if (!r) continue;

      list.push({
        symbol: s.symbol,
        name: s.name,
        score: Number(r.score.toFixed(3)),
        lastClose: r.close,
        rsi14: Number(r.rsi.toFixed(2)),
        volRatio: Number(r.volRatio.toFixed(2)),
        ma5: Number(r.ma5.toFixed(2)),
        ma20: Number(r.ma20.toFixed(2)),
        biasPct: Number(r.biasPct.toFixed(2)),
        runup3dPct: Number(r.runup3dPct.toFixed(2)),
        themes: r.themes,
        theme: r.themes?.[0] || null,
        tradeStyle: "起漲版v3.3"
      });

      await sleep(70);
    } catch (e) {
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
