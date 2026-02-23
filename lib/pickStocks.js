/**
 * lib/pickStocks.js
 * 完整版選股引擎（方案C：today.json 回填完整資料）
 *
 * 依據：
 * - 最近一個收盤日（即便假日也不中斷）
 * - 技術面：MA / RSI / 量比 / ATR
 * - 法人：FinMind T86（外資/投信/自營、連買、淨買），單位轉「張」
 * - 交易計畫：進場區間、TP1/TP2、停損
 * - 新增條件：
 *   (1) 120天內接近新高（<=3%）
 *   (2) 近3~5日平均漲幅 >= 5%
 *   (3) 日線趨勢發動中（MA5>MA20 且接近/突破近20日高）
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 60 * 10 });

/* ============ 參數（可微調）=========== */
const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000; // 股票池：成交股數門檻
const MIN_PRICE = 10;

const RSI_MIN = 50;
const RSI_MAX = 82;

const STAGE2_TOPK = 40;         // 第二段 FinMind 加權/精選候選數
const MIN_PICK_SCORE = 0;       // score>0 才推薦（基準版精神）

// 新增條件
const NEAR_HIGH_120D_PCT = 3.0; // 距離120日新高 <= 3%
const AVG_GAIN_3_5_MIN = 5.0;   // 近3~5日平均漲幅 >= 5%

// 價格帶
const BUCKETS = [
  { key: "lt100",   label: "100內",      min: -Infinity, max: 100 },
  { key: "100_300", label: "100~300",    min: 100,       max: 300 },
  { key: "300_600", label: "300~600",    min: 300,       max: 600 },
  { key: "600_1000",label: "600~1000",   min: 600,       max: 1000 },
  { key: "gt1000",  label: "1000以上",   min: 1000,      max: Infinity }
];

/* ============ 工具 ============ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad2 = (n) => String(n).padStart(2, "0");
function ymd(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
function toNum(x) {
  if (x == null) return 0;
  if (typeof x === "number") return x;
  const s = String(x).replace(/,/g, "").trim();
  if (s === "" || s === "--") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}
function pickFirst(obj, keys, fallback = null) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return fallback;
}
function lastNonZero(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null && Number(arr[i]) > 0) return { idx: i, val: Number(arr[i]) };
  }
  return null;
}

/* ============ 指標 ============ */
function sma(arr, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= period) sum -= arr[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(null);
  const out = Array(closes.length).fill(null);

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return Array(closes.length).fill(null);
  const tr = Array(closes.length).fill(null);
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  const out = Array(closes.length).fill(null);
  let prev = 0;
  for (let i = 1; i <= period; i++) prev += tr[i] ?? 0;
  prev /= period;
  out[period] = prev;
  for (let i = period + 1; i < closes.length; i++) {
    prev = (prev * (period - 1) + (tr[i] ?? 0)) / period;
    out[i] = prev;
  }
  return out;
}

/* ============ 來源：TWSE 股票池 ============ */
async function fetchTWSEStockDayAll() {
  const key = "twse:stock_day_all";
  const cached = cache.get(key);
  if (cached) return cached;

  const headers = { "User-Agent": "Mozilla/5.0" };

  // OpenAPI 優先
  try {
    const r1 = await axios.get(
      "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
      { timeout: 20000, headers }
    );
    if (Array.isArray(r1.data) && r1.data.length > 0) {
      cache.set(key, r1.data);
      return r1.data;
    }
  } catch (_) {}

  // 舊版備援
  const r2 = await axios.get(
    "https://www.twse.com.tw/exchangeReport/STOCK_DAY_ALL",
    {
      params: { response: "json" },
      timeout: 20000,
      headers: { ...headers, Referer: "https://www.twse.com.tw/" },
    }
  );
  const data = r2.data?.data || [];
  cache.set(key, data);
  return data;
}

function buildPool(rows) {
  return rows
    .map((r) => {
      if (Array.isArray(r)) {
        return {
          symbol: String(r[0] || "").trim(),
          name: String(r[1] || "").trim(),
          volume: toNum(r[2]),
          close: toNum(r[7]),
        };
      }
      return {
        symbol: String(pickFirst(r, ["Code", "證券代號", "股票代號"], "")).trim(),
        name: String(pickFirst(r, ["Name", "證券名稱", "股票名稱"], "")).trim(),
        volume: toNum(pickFirst(r, ["TradeVolume", "成交股數", "成交股數(股)"], 0)),
        close: toNum(pickFirst(r, ["ClosingPrice", "收盤價", "收盤"], 0)),
      };
    })
    .filter(
      (x) =>
        /^\d{4}$/.test(x.symbol) &&
        x.volume > MIN_LIQ_SHARES &&
        x.close > MIN_PRICE
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, POOL_SIZE);
}

/* ============ Yahoo：個股日線（用來找最近交易日/120日新高/技術） ============ */
async function fetchYahooStockBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.TW`;
  const resp = await axios.get(url, {
    params: { range: "9mo", interval: "1d" }, // 9mo 夠抓120日+MA
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) return null;

  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};

  const bars = ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: toNum(q.open?.[i]),
    high: toNum(q.high?.[i]),
    low: toNum(q.low?.[i]),
    close: toNum(q.close?.[i]),
    volume: toNum(q.volume?.[i]),
  }));

  return bars.filter((b) => b.close > 0);
}

/* ============ FinMind：法人 T86（需要 token） ============ */
async function finmindGet(dataset, params) {
  const token = process.env.FINMIND_TOKEN || "";
  if (!token) return null;

  const key = `finmind:${dataset}:${JSON.stringify(params)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const url = "https://api.finmindtrade.com/api/v4/data";
  const resp = await axios.get(url, {
    params: { dataset, token, ...params },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  // FinMind 格式：{status, data:[]}
  const data = resp.data?.data || null;
  cache.set(key, data);
  return data;
}

// 取得最近N日法人淨買(張) + 連買 + 最新一日
async function fetchInstT86Lots(symbol, endDateYmd, windowDays = 5) {
  const end = endDateYmd;
  // 往前抓 30 天保險（遇到假日）
  const startDt = new Date(end + "T00:00:00Z");
  startDt.setDate(startDt.getDate() - 40);
  const start = ymd(startDt);

  // FinMind dataset 常用：TaiwanStockInstitutionalInvestorsBuySell
  const rows = await finmindGet("TaiwanStockInstitutionalInvestorsBuySell", {
    data_id: symbol,
    start_date: start,
    end_date: end
  });

  if (!Array.isArray(rows) || rows.length === 0) return null;

  // 依日期排序，取最後 windowDays 的交易日
  const sorted = rows.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = sorted[sorted.length - 1];
  const tail = sorted.slice(-Math.max(windowDays, 1));

  // FinMind 欄位常見：foreign_investor_buy / sell / dealer_buy / sell / investment_trust_buy / sell
  // 有些版本會用 buy/sell 與 net_buy 字段，我們做雙軌容錯
  function netOf(r, who) {
    // 優先 net_buy / buy_sell
    const keysNet = [
      `${who}_net_buy`,
      `${who}_buy_sell`,
      `${who}_buy_sell_volume`,
      `${who}_buy_sell_value`,
      `${who}_buy_sell_amount`
    ];
    for (const k of keysNet) {
      if (r[k] != null) return toNum(r[k]);
    }
    // fallback buy - sell
    const b = toNum(r[`${who}_buy`]);
    const s = toNum(r[`${who}_sell`]);
    if (b || s) return b - s;
    return 0;
  }

  // who mapping（依資料集實際常見命名）
  const foreign = netOf(last, "foreign_investor");
  const trust   = netOf(last, "investment_trust");
  const dealer  = netOf(last, "dealer");

  // 轉張：股數 / 1000
  const toLots = (shares) => Math.round(toNum(shares) / 1000);

  const latestForeign = toLots(foreign);
  const latestTrust   = toLots(trust);
  const latestDealer  = toLots(dealer);
  const latestTotal   = latestForeign + latestTrust + latestDealer;

  // 近 windowDays 合計（張）
  let sumForeign = 0, sumTrust = 0, sumDealer = 0;
  for (const r of tail) {
    sumForeign += toLots(netOf(r, "foreign_investor"));
    sumTrust   += toLots(netOf(r, "investment_trust"));
    sumDealer  += toLots(netOf(r, "dealer"));
  }
  const sumTotal = sumForeign + sumTrust + sumDealer;

  // 連買（以「合計淨買>0」連續天數）
  let buyStreak = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    const t = toLots(netOf(r, "foreign_investor")) + toLots(netOf(r, "investment_trust")) + toLots(netOf(r, "dealer"));
    if (t > 0) buyStreak++;
    else break;
  }

  return {
    windowDays,
    asOfDate: String(last.date),
    sumTotal,
    sumForeign,
    sumTrust,
    sumDealer,
    buyStreak,
    latestTotalNet: latestTotal,
    latestForeignNet: latestForeign,
    latestTrustNet: latestTrust,
    latestDealerNet: latestDealer
  };
}

/* ============ 交易日（用大盤 ^TWII 的最後日期作為 asOfDataDate） ============ */
async function fetchLastTradingDateByIndex() {
  const key = "yahoo:^TWII:lastdate";
  const cached = cache.get(key);
  if (cached) return cached;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII`;
  const resp = await axios.get(url, {
    params: { range: "30d", interval: "1d" },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) return null;

  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const closes = (q.close || []).map(toNum);

  // 找最後一個 close>0 的日期
  let lastDate = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    if (closes[i] > 0) {
      lastDate = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      break;
    }
  }

  cache.set(key, lastDate);
  return lastDate;
}

/* ============ 評分/條件 ============ */
function computeSignals(bars) {
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const vols   = bars.map(b => b.volume);

  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const rsi14 = rsi(closes, 14);
  const vol20 = sma(vols, 20);
  const atr14 = atr(highs, lows, closes, 14);

  const li = closes.length - 1;
  const lastClose = closes[li];
  const lastMA5 = ma5[li];
  const lastMA20 = ma20[li];
  const lastRSI = rsi14[li];
  const lastATR = atr14[li];
  const volRatio = (vol20[li] && vol20[li] > 0) ? (vols[li] / vol20[li]) : null;

  // 120日新高距離
  const last120 = bars.slice(-130); // 約120交易日，留 buffer
  const high120 = Math.max(...last120.map(b => b.high || b.close || 0));
  const distHighPct = high120 > 0 ? ((high120 - lastClose) / high120) * 100 : null;
  const near120High = (distHighPct != null) ? (distHighPct <= NEAR_HIGH_120D_PCT) : false;

  // 近3~5日平均漲幅
  const pct = (a, b) => (b !== 0 ? ((a - b) / b) * 100 : 0);
  const d1 = pct(closes[li], closes[li - 1]);
  const d3 = (li >= 3) ? (pct(closes[li], closes[li - 3]) / 3) : null;
  const d5 = (li >= 5) ? (pct(closes[li], closes[li - 5]) / 5) : null;
  // 取「3~5日」中較穩的：有5用5，沒有就用3
  const avgGain = (d5 != null) ? (d5 * 5) : ((d3 != null) ? (d3 * 3) : null); // 轉回總漲幅
  const okAvgGain = (avgGain != null) ? (avgGain >= AVG_GAIN_3_5_MIN) : false;

  // 趨勢發動中：MA5>MA20 且 接近/突破近20日高
  const win20 = bars.slice(-21);
  const high20 = Math.max(...win20.map(b => b.high || b.close || 0));
  const trendOn = (lastMA5 && lastMA20 && lastMA5 > lastMA20 && lastClose >= high20 * 0.99);

  // 原本條件：趨勢+RSI+量比
  const okTrend = (lastMA20 && lastMA5 && lastClose > lastMA20 && lastMA5 > lastMA20);
  const okRSI = (lastRSI == null) ? true : (lastRSI >= RSI_MIN && lastRSI <= RSI_MAX);
  const okVol = (volRatio != null) ? (volRatio >= 1.1) : false;

  const passed = okTrend && okRSI && okVol && near120High && okAvgGain && trendOn;

  // score：延續基準版精神（簡單但有效），另外加上接近新高/平均漲幅加權
  const score =
    (lastMA20 ? ((lastClose / lastMA20 - 1) * 100) : 0) * 2 +
    (volRatio != null ? (volRatio - 1) * 10 : 0) +
    (near120High ? 8 : 0) +
    (okAvgGain ? 6 : 0) +
    (trendOn ? 6 : 0);

  return {
    lastClose, lastMA5, lastMA20, lastRSI, volRatio, lastATR,
    near120High, distHighPct,
    avgGainPct: avgGain,
    trendOn,
    passed,
    score
  };
}

function makePlan(lastClose, atr14) {
  // 短中期（3天~4週）保守版計畫：用 ATR 當風險尺度
  const atr = (atr14 != null && atr14 > 0) ? atr14 : (lastClose * 0.03);

  const entryLow  = lastClose * 0.985;
  const entryHigh = lastClose * 1.01;

  const stop = entryLow - atr * 1.2;
  const tp1  = entryHigh + atr * 1.5;
  const tp2  = entryHigh + atr * 3.0;

  return {
    entryLow: Number(entryLow.toFixed(2)),
    entryHigh: Number(entryHigh.toFixed(2)),
    stop: Number(stop.toFixed(2)),
    tp1: Number(tp1.toFixed(2)),
    tp2: Number(tp2.toFixed(2))
  };
}

function bucketKeyOf(price) {
  const p = Number(price);
  if (!isFinite(p)) return "unknown";
  for (const b of BUCKETS) {
    if (p >= b.min && p < b.max) return b.key;
  }
  return "unknown";
}

/* ============ 主流程 ============ */
async function pickStocks({ generatedAt } = {}) {
  const asOfDataDate = await fetchLastTradingDateByIndex(); // 最近交易日
  const rows = await fetchTWSEStockDayAll();
  const pool = buildPool(rows);

  const meta = {
    pool: { size: pool.length, POOL_SIZE, MIN_LIQ_SHARES, MIN_PRICE },
    asOfDataDate: asOfDataDate || null,
    tradeStyle: "短中期(3天~4週)"
  };

  if (!pool || pool.length === 0) {
    return { market: "TW", generatedAt: generatedAt || new Date().toISOString(), topN: 3, picks: [], meta };
  }

  const scored = [];
  for (const p of pool) {
    try {
      const bars = await fetchYahooStockBars(p.symbol);
      if (!bars || bars.length < 60) continue;

      // 若有 asOfDataDate，確保使用 <= asOfDataDate 的最後一根 K（避免假日跑到不一致）
      let barsUse = bars;
      if (asOfDataDate) {
        barsUse = bars.filter(b => b.date <= asOfDataDate);
        if (barsUse.length < 60) continue;
      }

      const sig = computeSignals(barsUse);
      if (sig.score <= MIN_PICK_SCORE) continue;

      // 法人（用 asOfDataDate）
      const inst = asOfDataDate ? await fetchInstT86Lots(p.symbol, asOfDataDate, 5) : null;

      const pick = {
        symbol: p.symbol,
        name: p.name,

        // 核心輸出（UI 需要）
        lastClose: Number(sig.lastClose.toFixed(2)),
        ma5: sig.lastMA5 != null ? Number(sig.lastMA5.toFixed(2)) : null,
        ma20: sig.lastMA20 != null ? Number(sig.lastMA20.toFixed(2)) : null,
        rsi14: sig.lastRSI != null ? Number(sig.lastRSI.toFixed(1)) : null,
        volRatio: sig.volRatio != null ? Number(sig.volRatio.toFixed(2)) : null,
        atr14: sig.lastATR != null ? Number(sig.lastATR.toFixed(2)) : null,

        // 新增條件可視化
        near120High: !!sig.near120High,
        distHigh120Pct: sig.distHighPct != null ? Number(sig.distHighPct.toFixed(2)) : null,
        avgGain_3_5_pct: sig.avgGainPct != null ? Number(sig.avgGainPct.toFixed(2)) : null,
        trendOn: !!sig.trendOn,

        // 交易計畫
        plan: makePlan(sig.lastClose, sig.lastATR),

        // 法人（張）
        inst: inst || null,

        // 推薦結果
        score: Number(sig.score.toFixed(4)),
        passed: !!sig.passed,
        tradeStyle: "短中期"
      };

      scored.push(pick);

      await sleep(30); // 避免 Yahoo 限流
    } catch (_) {}
  }

  // 先依 score 排序
  scored.sort((a, b) => b.score - a.score);

  const passed = scored.filter(x => x.passed);
  const picks = [];
  for (const x of passed) {
    if (picks.length >= 3) break;
    picks.push({ ...x, reason: "主推" });
  }
  for (const x of scored) {
    if (picks.length >= 3) break;
    if (picks.find(p => p.symbol === x.symbol)) continue;
    picks.push({ ...x, reason: "補位" });
  }

  // 價格帶（每帶2~3檔，可與TOP重複）
  const buckets = {};
  for (const b of BUCKETS) buckets[b.key] = [];

  for (const x of scored) {
    const k = bucketKeyOf(x.lastClose);
    if (!buckets[k]) continue;
    if (buckets[k].length >= 3) continue; // 2~3檔：先上限3
    buckets[k].push({ ...x, reason: `價格帶：${BUCKETS.find(bb=>bb.key===k)?.label || k}` });
  }

  meta.buckets = Object.fromEntries(
    Object.entries(buckets).map(([k, arr]) => [k, { count: arr.length }])
  );

  // 最終輸出：picks 仍是主畫面使用（TOP3），另外在 meta 附 bucketsPick 供未來擴充
  return {
    market: "TW",
    generatedAt: generatedAt || new Date().toISOString(),
    topN: 3,
    picks,
    meta: {
      ...meta,
      bucketsPick: buckets
    }
  };
}

module.exports = { pickStocks };
