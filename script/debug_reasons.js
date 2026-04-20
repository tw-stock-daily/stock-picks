const axios = require("axios");

const POOL_SIZE = 1000;
const MIN_LIQ_SHARES = 600000;
const MIN_PRICE = 10;

const MIN_AVG_VOL20 = 800;
const VOL_RATIO_MIN = 1.05;
const VOL_RATIO_HARD_MAX = 8.0;

const BIAS_HARD_MAX = 0.25;
const RECENT_RUNUP_HARD = 0.30;

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

function diagnoseStock(bars) {
  const o = bars.map(b => b.open);
  const c = bars.map(b => b.close);
  const v = bars.map(b => b.volume);

  const ma5Arr = sma(c, 5);
  const ma20Arr = sma(c, 20);
  const vol20Arr = sma(v, 20);
  const { dif, dea, hist } = macd(c);

  const i = c.length - 1;
  if (i < 35) return "bars_too_short";
  if (ma20Arr[i] == null) return "ma20_missing";

  const close = c[i];
  const ma5 = ma5Arr[i];
  const ma20 = ma20Arr[i];
  const avgVol20 = vol20Arr[i] || 0;
  const volRatio = avgVol20 ? v[i] / avgVol20 : 0;

  const difNow = dif[i] ?? 0;
  const deaNow = dea[i] ?? 0;
  const histNow = hist[i] ?? 0;

  const bias = ma20 ? (close / ma20 - 1) : 0;
  const runup5 = i >= 5 ? pct(c[i - 5], close) : 0;

  if (avgVol20 < MIN_AVG_VOL20) return "avgVol20_too_low";
  if (volRatio > VOL_RATIO_HARD_MAX) return "volRatio_too_high";
  if (bias > BIAS_HARD_MAX) return "bias_too_high";
  if (runup5 > RECENT_RUNUP_HARD) return "runup5_too_high";

  if (!(close > ma20 && ma5 >= ma20)) return "trend_not_ok";
  if (volRatio < VOL_RATIO_MIN) return "volRatio_too_low";
  if (difNow < deaNow && histNow < 0) return "macd_bearish";

  return "passed";
}

(async () => {
  try {
    const pool = await getPool();
    const counts = {};
    const samples = {};

    console.log(`pool size = ${pool.length}`);

    for (let idx = 0; idx < pool.length; idx++) {
      const s = pool[idx];
      let reason = "unknown_error";

      try {
        const bars = await fetchBars(s.symbol);
        if (!bars) {
          reason = "bars_fetch_failed";
        } else {
          reason = diagnoseStock(bars);
        }
      } catch {
        reason = "bars_fetch_failed";
      }

      counts[reason] = (counts[reason] || 0) + 1;
      if (!samples[reason]) samples[reason] = [];
      if (samples[reason].length < 8) {
        samples[reason].push(`${s.symbol}-${s.name}`);
      }

      if ((idx + 1) % 100 === 0) {
        console.log(`processed ${idx + 1}/${pool.length}`);
      }
    }

    console.log("\n=== reason counts ===");
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => {
        console.log(`${k}: ${v}`);
      });

    console.log("\n=== samples ===");
    Object.entries(samples).forEach(([k, arr]) => {
      console.log(`\n[${k}]`);
      arr.forEach(x => console.log(`  ${x}`));
    });
  } catch (e) {
    console.error(e);
  }
})();