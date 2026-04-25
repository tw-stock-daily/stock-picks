/**
 * 台股精選 v3.9.1
 * 市場燈號產生器
 *
 * 修正重點：
 * 1. 美股使用 ^GSPC
 * 2. 台指期夜盤使用 Yahoo 台指期近一 WTX&
 * 3. 輸出 public/market.json
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const OUTPUT_PATH = path.join(process.cwd(), "public", "market.json");

function toNum(x) {
  const n = Number(String(x ?? "").replace(/,/g, "").replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

function nowTaipeiISO() {
  const now = new Date();
  const taipei = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Taipei" }));

  const yyyy = taipei.getFullYear();
  const mm = String(taipei.getMonth() + 1).padStart(2, "0");
  const dd = String(taipei.getDate()).padStart(2, "0");
  const hh = String(taipei.getHours()).padStart(2, "0");
  const mi = String(taipei.getMinutes()).padStart(2, "0");
  const ss = String(taipei.getSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;

  const r = await axios.get(url, {
    timeout: 20000,
    params: {
      range: "5d",
      interval: "1d",
      includePrePost: false,
      events: "div,splits"
    },
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const data = r.data?.chart?.result?.[0];
  const meta = data?.meta;
  const q = data?.indicators?.quote?.[0];

  if (!meta || !q || !data.timestamp?.length) {
    throw new Error(`Yahoo chart no data: ${symbol}`);
  }

  const lastIdx = data.timestamp.length - 1;
  const close = toNum(q.close?.[lastIdx] ?? meta.regularMarketPrice);
  const prevClose = toNum(meta.chartPreviousClose || meta.previousClose);
  const change = close - prevClose;
  const changePct = prevClose ? change / prevClose : 0;

  return {
    symbol,
    name: meta.shortName || symbol,
    price: Number(close.toFixed(2)),
    previousClose: Number(prevClose.toFixed(2)),
    change: Number(change.toFixed(2)),
    changePct: Number(changePct.toFixed(4)),
    source: "Yahoo Finance chart"
  };
}

async function fetchTwFutureFromYahooPage() {
  const url = "https://tw.stock.yahoo.com/quote/WTX%26";

  const r = await axios.get(url, {
    timeout: 20000,
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  const html = String(r.data || "");

  const priceMatch =
    html.match(/"regularMarketPrice"\s*:\s*\{\s*"raw"\s*:\s*([0-9.]+)/) ||
    html.match(/"price"\s*:\s*\{\s*"raw"\s*:\s*([0-9.]+)/) ||
    html.match(/成交<\/span><span[^>]*>([0-9,]+\.\d+|[0-9,]+)/);

  const changeMatch =
    html.match(/"regularMarketChange"\s*:\s*\{\s*"raw"\s*:\s*(-?[0-9.]+)/) ||
    html.match(/漲跌<\/span><span[^>]*>(-?[0-9,]+\.\d+|-?[0-9,]+)/);

  const changePctMatch =
    html.match(/"regularMarketChangePercent"\s*:\s*\{\s*"raw"\s*:\s*(-?[0-9.]+)/) ||
    html.match(/漲跌幅<\/span><span[^>]*>(-?[0-9.]+)%/);

  const price = priceMatch ? toNum(priceMatch[1]) : 0;
  const change = changeMatch ? toNum(changeMatch[1]) : 0;
  let changePct = changePctMatch ? toNum(changePctMatch[1]) : 0;

  if (Math.abs(changePct) > 1) changePct = changePct / 100;

  if (!price) {
    throw new Error("WTX& price not found");
  }

  return {
    symbol: "WTX&",
    name: "台指期近一",
    price,
    change,
    changePct,
    source: "Yahoo Taiwan WTX& page"
  };
}

function calcMarketSignal(sp500, twFuture) {
  const usPct = sp500?.changePct ?? 0;
  const twPct = twFuture?.changePct ?? 0;

  let score = 0;

  if (usPct >= 0.008) score += 2;
  else if (usPct >= 0.003) score += 1;
  else if (usPct <= -0.008) score -= 2;
  else if (usPct <= -0.003) score -= 1;

  if (twPct >= 0.006) score += 2;
  else if (twPct >= 0.002) score += 1;
  else if (twPct <= -0.006) score -= 2;
  else if (twPct <= -0.002) score -= 1;

  if (score >= 2) {
    return {
      state: "good",
      label: "🟢 偏多",
      text: "美股與台指期訊號偏多，短線有利強勢股表現。"
    };
  }

  if (score <= -2) {
    return {
      state: "bad",
      label: "🔴 偏弱",
      text: "美股或台指期訊號偏弱，短線操作需保守。"
    };
  }

  return {
    state: "warn",
    label: "🟡 震盪",
    text: "外部市場訊號中性，留意強勢股能否續航。"
  };
}

async function main() {
  let sp500 = null;
  let nasdaq = null;
  let twFuture = null;

  try {
    sp500 = await fetchYahooChart("^GSPC");
  } catch (err) {
    console.log("⚠️ ^GSPC 抓取失敗:", err.message);
  }

  try {
    nasdaq = await fetchYahooChart("^IXIC");
  } catch (err) {
    console.log("⚠️ ^IXIC 抓取失敗:", err.message);
  }

  try {
    twFuture = await fetchTwFutureFromYahooPage();
  } catch (err) {
    console.log("⚠️ WTX& 抓取失敗:", err.message);
  }

  const signal = calcMarketSignal(sp500, twFuture);

  const payload = {
    version: "market-v3.9.1",
    generatedAt: nowTaipeiISO(),
    signal,
    us: {
      sp500,
      nasdaq
    },
    taiwan: {
      nightFuture: twFuture
    },
    note: "美股以 S&P 500 為主，台期夜盤以 Yahoo 台指期近一 WTX& 為參考。"
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2), "utf8");

  console.log("✅ market.json generated");
  console.log(`盤勢燈號: ${signal.label}`);
  console.log(`S&P500: ${sp500 ? `${(sp500.changePct * 100).toFixed(2)}%` : "N/A"}`);
  console.log(`台指期近一: ${twFuture ? `${(twFuture.changePct * 100).toFixed(2)}%` : "N/A"}`);
  console.log(`✅ 已輸出: public/market.json`);
}

main().catch(err => {
  console.error("❌ generate_market failed");
  console.error(err);
  process.exit(1);
});
