// scripts/generate_market.js
import fs from "fs";
import path from "path";

const OUT_FILE = path.join(process.cwd(), "public", "market.json");

function fmtTaipeiISO(ms) {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(d)
    .reduce((a, p) => {
      a[p.type] = p.value;
      return a;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function fmtTaipeiDate(ms) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=10d&interval=1d`;

  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`Yahoo ${symbol} HTTP ${r.status}`);
  const j = await r.json();

  const result = j?.chart?.result?.[0];
  const tsArr = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!tsArr?.length || !quote?.close?.length) {
    throw new Error(`Yahoo ${symbol} parse fail`);
  }

  let idx = tsArr.length - 1;
  while (idx >= 0 && (quote.close[idx] == null)) idx--;
  if (idx < 0) throw new Error(`Yahoo ${symbol} no valid close`);

  let pidx = idx - 1;
  while (pidx >= 0 && (quote.close[pidx] == null)) pidx--;
  if (pidx < 0) throw new Error(`Yahoo ${symbol} no prev close`);

  const lastTsMs = tsArr[idx] * 1000;
  const last = quote.close[idx];
  const prev = quote.close[pidx];

  return { lastTsMs, last, prev };
}

function buildSignal(usChangePct, nightChangePct) {
  const usUp = usChangePct >= 0;
  const nightUp = nightChangePct >= 0;

  if (usUp !== nightUp) {
    return {
      signal: "caution",
      label: "🟡 震盪",
      message:
        `美股與夜盤訊號不一致（美股${usUp ? "上漲" : "下跌"} / 夜盤${
          nightUp ? "上漲" : "下跌"
        }），今日盤勢可能震盪：建議分批、降低槓桿與部位。`,
    };
  }

  const avgAbs = (Math.abs(usChangePct) + Math.abs(nightChangePct)) / 2;

  if (usUp && nightUp) {
    const strong = avgAbs >= 0.8;
    return {
      signal: strong ? "good" : "ok",
      label: strong ? "🟢 偏多" : "🟩 偏多(溫和)",
      message: strong
        ? "美股與夜盤同向上漲，偏多盤勢：可分批布局，控制風險。"
        : "美股與夜盤同向小漲，偏多但力道溫和：可分批布局，避免追價。",
    };
  } else {
    const strong = avgAbs >= 0.8;
    return {
      signal: strong ? "bad" : "warn",
      label: strong ? "🔴 偏空" : "🟠 偏空(溫和)",
      message: strong
        ? "美股與夜盤同向下跌，偏空盤勢：建議保守、降低部位或等待。"
        : "美股與夜盤同向小跌，偏空但力道溫和：建議降低曝險，分批觀望。",
    };
  }
}

async function main() {
  const now = Date.now();

  const out = {
    generatedAt: new Date(now).toISOString(),
    asOfLocal: fmtTaipeiISO(now).replace("T", " ").replace("+08:00", ""),
    signalDate: null,
    stale: true,
    signal: "unknown",
    label: "⚪️ 未知",
    sources: {
      usMarket: {
        symbol: "^GSPC",
        last: null,
        prev: null,
        change: null,
        changePct: null,
        lastDate: null,
        lastTs: null,
        ok: false,
        error: null,
      },
      nightProxy: {
        symbol: "^N225",
        direction: null,
        last: null,
        prev: null,
        change: null,
        changePct: null,
        lastDate: null,
        lastTs: null,
        note: null,
        ok: false,
        error: null,
      },
    },
    message: "",
    note: "夜盤目前先用 ^N225 作為穩定 proxy；後續可替換為台指期夜盤更精準資料源（不影響個股推薦）。",
  };

  try {
    const us = await fetchYahooChart("^GSPC");
    const change = us.last - us.prev;
    const changePct = (change / us.prev) * 100;

    out.sources.usMarket.last = us.last;
    out.sources.usMarket.prev = us.prev;
    out.sources.usMarket.change = change;
    out.sources.usMarket.changePct = changePct;
    out.sources.usMarket.lastTs = fmtTaipeiISO(us.lastTsMs);
    out.sources.usMarket.lastDate = fmtTaipeiDate(us.lastTsMs);
    out.sources.usMarket.ok = true;
  } catch (e) {
    out.sources.usMarket.error = String(e?.message || e);
  }

  try {
    const nk = await fetchYahooChart("^N225");
    const change = nk.last - nk.prev;
    const changePct = (change / nk.prev) * 100;

    out.sources.nightProxy.last = nk.last;
    out.sources.nightProxy.prev = nk.prev;
    out.sources.nightProxy.change = change;
    out.sources.nightProxy.changePct = changePct;
    out.sources.nightProxy.direction = changePct >= 0 ? "up" : "down";
    out.sources.nightProxy.lastTs = fmtTaipeiISO(nk.lastTsMs);
    out.sources.nightProxy.lastDate = fmtTaipeiDate(nk.lastTsMs);
    out.sources.nightProxy.ok = true;
  } catch (e) {
    out.sources.nightProxy.error = String(e?.message || e);
  }

  const tsCandidates = [];
  if (out.sources.usMarket.ok) {
    tsCandidates.push(new Date(out.sources.usMarket.lastTs).getTime());
  }
  if (out.sources.nightProxy.ok) {
    tsCandidates.push(new Date(out.sources.nightProxy.lastTs).getTime());
  }

  const bestTs = tsCandidates.length ? Math.max(...tsCandidates) : null;
  out.signalDate = bestTs ? fmtTaipeiDate(bestTs) : null;
  out.stale = !bestTs ? true : now - bestTs > 36 * 3600 * 1000;

  if (out.sources.usMarket.ok && out.sources.nightProxy.ok) {
    const sig = buildSignal(out.sources.usMarket.changePct, out.sources.nightProxy.changePct);
    out.signal = sig.signal;
    out.label = sig.label;
    out.message = sig.message;
  } else {
    out.signal = "unknown";
    out.label = "⚪️ 資料延遲";
    out.message = "盤勢資料來源尚未更新或抓取失敗（可能是資料延遲或網路問題）。請稍後再試。";
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), "utf8");

  console.log(`[OK] wrote ${OUT_FILE}`);
  console.log(`signalDate=${out.signalDate} stale=${out.stale}`);
}

main().catch((e) => {
  console.error("[FAIL]", e);
  process.exit(1);
});
