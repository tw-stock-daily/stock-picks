const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 600 });

const POOL_SIZE = 600;
const MIN_LIQ_SHARES = 500000;
const MIN_PRICE = 10;

const RSI_MIN = 50;
const RSI_MAX = 82;

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

/* =======================
   TWSE 股票池（雙來源）
======================= */
async function fetchTWSEStockDayAll() {
  const key = "twse:stock_day_all";
  const cached = cache.get(key);
  if (cached) return cached;

  const headers = { "User-Agent": "Mozilla/5.0" };

  // ① OpenAPI（優先）
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

  // ② 舊版 API（備援）
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

function parseRows(rows) {
  return rows
    .map(r => {
      // 舊版：array
      if (Array.isArray(r)) {
        return {
          symbol: String(r[0] || "").trim(),
          name: String(r[1] || "").trim(),
          volume: toNum(r[2]),
          close: toNum(r[7]),
        };
      }
      // OpenAPI：object
      return {
        symbol: String(
          pickFirst(r, ["Code", "證券代號", "股票代號"], "")
        ).trim(),
        name: String(
          pickFirst(r, ["Name", "證券名稱", "股票名稱"], "")
        ).trim(),
        volume: toNum(
          pickFirst(r, ["TradeVolume", "成交股數", "成交股數(股)"], 0)
        ),
        close: toNum(
          pickFirst(r, ["ClosingPrice", "收盤價", "收盤"], 0)
        ),
      };
    })
    .filter(
      x =>
        /^\d{4}$/.test(x.symbol) &&
        x.volume > MIN_LIQ_SHARES &&
        x.close > MIN_PRICE
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, POOL_SIZE);
}

/* =======================
   主流程（暫時只回假分數）
   👉 之後再把你完整 server.js
      的 scoring 塞回來
======================= */
async function pickStocks() {
  const rows = await fetchTWSEStockDayAll();
  const pool = parseRows(rows);

  if (!pool || pool.length === 0) {
    return {
      market: "TW",
      generatedAt: new Date().toISOString(),
      topN: 3,
      picks: [],
      meta: {
        pool: { size: 0, POOL_SIZE, MIN_LIQ_SHARES, MIN_PRICE },
      },
    };
  }

  // 先用假排序（確保 pipeline 穩）
  const picks = pool.slice(0, 3).map((x, i) => ({
    symbol: x.symbol,
    name: x.name,
    score: 100 - i * 5,
    reason: "資料來源正常（驗證用）",
  }));

  return {
    market: "TW",
    generatedAt: new Date().toISOString(),
    topN: 3,
    picks,
    meta: {
      pool: {
        size: pool.length,
        POOL_SIZE,
        MIN_LIQ_SHARES,
        MIN_PRICE,
      },
    },
  };
}

module.exports = { pickStocks };
