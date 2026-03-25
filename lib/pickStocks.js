/**
 * 台股精選 v3.4-fix
 * 強勢追蹤版（取消 RSI 篩選）+ 補齊 App 顯示欄位
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

function ymdFromTs(tsSec) {
  return new Date(tsSec * 1000).toISOString().slice(0, 10);
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
    date: ymdFromTs(t),
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
  const r = await axios.get("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", {
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  return (r.data || [])
    .filter(x => toNum(x.TradeVolume) > MIN_LIQ_SHARES && toNum(x.ClosingPrice) > MIN_PRICE)
    .slice(0, POOL_SIZE)
    .map(x => ({
      symbol: x.Code,
      name: x.Name
    }));
}

/* =======================
   T86 法人
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
    await sleep(50);
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
    latestTotalNet: toLots(latest.total),
    latestForeignNet: toLots(latest.foreign),
    latestTrustNet: toLots(latest.trust),
    latestDealerNet: toLots(latest.dealer),
    unit: "張",
    source: "TWSE T86 (json)"
  };
}

/* =======================
   交易計畫
======================= */
function buildPlan(price, atrVal) {
  const atrUse = atrVal && atrVal > 0 ? atrVal : price * 0.03;
  return {
    entryLow: +(price - atrUse * 0.25).toFixed(2),
    entryHigh: +(price + atrUse * 0.20).toFixed(2),
    stop: +(price - atrUse * 1.4).toFixed(2),
    tp1: +(price + atrUse * 1.8).toFixed(2),
    tp2: +(price + atrUse * 2.8).toFixed(2),
  };
}

/* =======================
   核心評分
======================= */
function scoreStock(id, bars) {
  const c = bars.map(b => b.close);
  const h = bars.map(b => b.high);
  const l = bars.map(b => b.low);
  const v = bars.map(b => b.volume);

  const ma20Arr = sma(c, 20);
  const ma5Arr = sma(c, 5);
  const vol20Arr = sma(v, 20);
  const rsiArr = rsi(c);
  const atrArr = atr(h, l, c, 14);

  const i = c.length - 1;

  const close = c[i];
  const ma20 = ma20Arr[i];
  const ma5 = ma5Arr[i];
  const volRatio = v[i] / (vol20Arr[i] || 1);
  const rsiVal = rsiArr[i];
  const atrVal = atrArr[i];

  const bias = ma20 ? (close / ma20 - 1) : 0;
  const runup = i >= 3 ? pct(c[i - 3], close) : 0;

  // 過熱才淘汰
  if (volRatio > VOL_RATIO_HARD_MAX) return null;
  if (bias > BIAS_HARD_MAX) return null;
  if (runup > RECENT_RUNUP_HARD) return null;

  // 趨勢條件
  if (!(close > ma20 && ma5 > ma20)) return null;

  let score = 0;

  // 趨勢強度
  score += (close / ma20 - 1) * 100 * 2.5;

  // 量能
  score += (Math.min(volRatio, VOL_RATIO_CAP) - 1) * 6;

  // 突破
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
  for (const t of themes) bonus += THEME_BONUS[t] || 0;
  score += bonus;

  return {
    score,
    close,
    volRatio,
    rsi: rsiVal,
    ma5,
    ma20,
    atr14: atrVal,
    themes,
    asOfDataDate: bars[i].date
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

      const inst = await fetchInstFromTwse(s.symbol, r.asOfDataDate);

      list.push({
        symbol: s.symbol,
        name: s.name,
        score: Number(r.score.toFixed(3)),
        lastClose: Number(r.close.toFixed(2)),
        rsi14: Number((r.rsi ?? 0).toFixed(2)),
        volRatio: Number((r.volRatio ?? 0).toFixed(2)),
        ma5: Number((r.ma5 ?? 0).toFixed(2)),
        ma20: Number((r.ma20 ?? 0).toFixed(2)),
        atr14: Number((r.atr14 ?? 0).toFixed(2)),
        plan: buildPlan(r.close, r.atr14),
        inst,
        themes: r.themes,
        theme: r.themes?.[0] || null,
        asOfDataDate: r.asOfDataDate,
        reason: "主推候選",
        tradeStyle: "強勢追蹤v3.4"
      });

      await sleep(60);
    } catch {
      await sleep(100);
    }
  }

  list.sort((a, b) => b.score - a.score);

  const picks = list.slice(0, 3).map((x, idx) => ({
    ...x,
    reason: idx === 0 ? "主推" : "補位"
  }));

  return {
    picks,
    candidates: list
  };
}

module.exports = { pickStocks };
