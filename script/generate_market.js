// script/generate_market.js
// 目的：早上 08:00 產生盤勢燈號 market.json（不影響 today.json / 個股推薦）
//
// 資料來源（穩定版）：Yahoo Finance 指數日線
// - 美股：^GSPC（S&P 500）
// - 夜盤代理：先用 ^N225 作 fallback（明天再換成更準的台指期夜盤資料源）
//
// 規則（最簡單、最穩）：
// - 取「上一交易日」(last) vs 「前一日」(prev) 漲跌
// - up/up => riskOn
// - down/down => riskOff
// - 其他 => caution

const fs = require("fs");
const path = require("path");
const axios = require("axios");

function toNum(x) {
  if (x == null) return null;
  if (typeof x === "number") return x;
  const s = String(x).replace(/,/g, "").trim();
  if (!s || s === "--") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchYahooLast2(symbol) {
  // 取最近 10 天日線，找出最後兩個有效 close
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const resp = await axios.get(url, {
    params: { range: "10d", interval: "1d", includePrePost: false },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo chart no result: ${symbol}`);

  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const closes = (q.close || []).map(toNum);

  const bars = ts.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    close: closes[i],
  })).filter(b => b.close != null);

  if (bars.length < 2) throw new Error(`Not enough bars: ${symbol}`);

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];

  const change = last.close - prev.close;
  const changePct = (prev.close !== 0) ? (change / prev.close) * 100 : 0;

  return {
    symbol,
    last: last.close,
    prev: prev.close,
    change,
    changePct,
    lastDate: last.date,
    prevDate: prev.date,
    direction: change > 0 ? "up" : (change < 0 ? "down" : "flat"),
  };
}

function decideSignal(usDir, nightDir) {
  if (usDir === "down" && nightDir === "down") return "riskOff";
  if (usDir === "up" && nightDir === "up") return "riskOn";
  return "caution";
}

function messageFor(signal, us, night) {
  const usTxt = us?.direction === "up" ? "上漲" : (us?.direction === "down" ? "下跌" : "持平");
  const nTxt = night?.direction === "up" ? "上漲" : (night?.direction === "down" ? "下跌" : "持平");

  if (signal === "riskOff") {
    return `美股與夜盤同向走弱（美股${usTxt} / 夜盤${nTxt}），今日盤勢風險偏高：可觀察為主、降低部位、嚴守停損。`;
  }
  if (signal === "riskOn") {
    return `美股與夜盤同向偏強（美股${usTxt} / 夜盤${nTxt}），今日盤勢偏多：可依策略正常執行，仍請留意突發消息。`;
  }
  return `美股與夜盤訊號不一致（美股${usTxt} / 夜盤${nTxt}），今日盤勢可能震盪：建議分批、降低槓桿與部位。`;
}

async function main() {
  // 你要的：早上 08:00 產生燈號
  // 美股（S&P500）與夜盤代理（先用日經做 fallback）
  const us = await fetchYahooLast2("^GSPC");

  let night = null;
  try {
    night = await fetchYahooLast2("^N225"); // fallback 先用日經
  } catch (e) {
    // 若夜盤代理抓不到，就退化成只看美股，避免 workflow 失敗
    night = { symbol: "^N225", direction: "flat", note: "night fallback unavailable" };
  }

  const signal = decideSignal(us.direction, night.direction);
  const levelLabel = signal === "riskOn" ? "偏多" : (signal === "riskOff" ? "風險高" : "震盪");
  const emoji = signal === "riskOn" ? "🟢" : (signal === "riskOff" ? "🔴" : "🟡");

  const out = {
    generatedAt: new Date().toISOString(),
    asOfLocal: new Date().toLocaleString("sv-SE", { timeZone: "Asia/Taipei" }).replace("T", " "),
    signal,
    label: `${emoji} ${levelLabel}`,
    sources: {
      usMarket: {
        symbol: us.symbol,
        last: us.last,
        prev: us.prev,
        change: us.change,
        changePct: us.changePct,
        lastDate: us.lastDate,
      },
      nightProxy: {
        symbol: night.symbol,
        direction: night.direction,
        last: night.last ?? null,
        prev: night.prev ?? null,
        change: night.change ?? null,
        changePct: night.changePct ?? null,
        lastDate: night.lastDate ?? null,
        note: night.note ?? null,
      }
    },
    message: messageFor(signal, us, night),
    note: "夜盤目前先用 ^N225 作為穩定 proxy；後續可替換為台指期夜盤更精準資料源（不影響個股推薦）。"
  };

  const publicDir = path.join(process.cwd(), "public");
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  const file = path.join(publicDir, "market.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");

  console.log("✅ wrote:", file);
  console.log("✅ signal:", out.signal, out.label);
}

main().catch((e) => {
  console.error("❌ generate_market failed:", e);
  process.exit(1);
});
