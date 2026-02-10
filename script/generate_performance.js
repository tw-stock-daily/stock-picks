// script/generate_performance.js
// 目的：建立/更新 public/performance/positions.json 與每檔追蹤明細
// 規格：
// - entryPrice = 推薦當日收盤價（若休市則用最近一個台股收盤日）
// - daily 只在台股有收盤日才新增
// - daysHeld = 交易日數 = daily.length - 1
// - 報酬雙軌：lastReturnPct + maxReturnPct
// - TP 有（只標記）；SL 只記錄；重複推薦合併；最長追蹤 28 天（4 週）

const fs = require("fs");
const path = require("path");
const axios = require("axios");

// ===== 可調參數（先用保守預設，之後你要改再改）=====
const MAX_HOLD_DAYS = 28; // 4 週（以日曆天判定到期）
const TP_LEVELS = [
  { name: "TP1", returnPct: 8 },
  { name: "TP2", returnPct: 15 },
];
const SL = { returnPct: -6, recordOnly: true };

// ===== 小工具 =====
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function readJsonIfExists(p, fallback = null) {
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf-8");
}
function tzDateISO(tz = "Asia/Taipei") {
  return new Date().toLocaleDateString("en-CA", { timeZone: tz });
}
function tzDateTime(tz = "Asia/Taipei") {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}
function toNum(x) {
  if (x == null) return null;
  if (typeof x === "number") return x;
  const s = String(x).replace(/,/g, "").trim();
  if (!s || s === "--") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function addDaysISO(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function diffDays(isoA, isoB) {
  // B - A (calendar days)
  const a = new Date(isoA + "T00:00:00Z").getTime();
  const b = new Date(isoB + "T00:00:00Z").getTime();
  return Math.floor((b - a) / (24 * 3600 * 1000));
}
function pct(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}
function yahooSymbolForTWStock(sym4) {
  return `${sym4}.TW`;
}

// ===== Yahoo 取日線（用來找台股最後交易日 & 收盤價）=====
async function fetchYahooBars(symbol, range = "3mo", interval = "1d") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
  const resp = await axios.get(url, {
    params: { range, interval, includePrePost: false },
    timeout: 20000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  const r = resp.data?.chart?.result?.[0];
  if (!r) return [];

  const ts = r.timestamp || [];
  const q = r.indicators?.quote?.[0] || {};
  const closes = (q.close || []).map(toNum);

  const bars = ts
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: closes[i],
    }))
    .filter((b) => b.close != null);

  return bars;
}

async function getLastTWTradingDate() {
  // 用 ^TWII 的最後一根日線當「最近台股收盤日」
  const bars = await fetchYahooBars("^TWII", "1mo", "1d");
  if (!bars.length) throw new Error("Cannot resolve TW dataDate from ^TWII");
  return bars[bars.length - 1].date;
}

async function getCloseOnOrBefore(symbol, targetDate) {
  // 找 <= targetDate 的最後一根 close（假日/缺資料會自動回退）
  const bars = await fetchYahooBars(symbol, "6mo", "1d");
  if (!bars.length) return null;

  // bars 已按時間排序
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].date <= targetDate) return { date: bars[i].date, close: bars[i].close };
  }
  return null;
}

// ===== 計算 metrics =====
function computeMetrics(daily, entryPrice) {
  const last = daily[daily.length - 1];
  let maxReturn = -Infinity;
  let maxReturnDate = null;

  for (const row of daily) {
    if (row.returnPct > maxReturn) {
      maxReturn = row.returnPct;
      maxReturnDate = row.date;
    }
  }

  const hitTP = TP_LEVELS.some((tp) => daily.some((d) => d.returnPct >= tp.returnPct));
  const hitSL = daily.some((d) => d.returnPct <= SL.returnPct);

  return {
    daysHeld: Math.max(0, daily.length - 1), // 交易日數
    lastClose: last.close,
    lastReturnPct: last.returnPct,
    maxReturnPct: maxReturn,
    maxReturnDate,
    hitTP,
    hitSL,
  };
}

async function main() {
  const TZ = "Asia/Taipei";
  const runDate = tzDateISO(TZ);     // 檔案日期（每天）
  const generatedAt = tzDateTime(TZ);

  const outPublic = path.join(process.cwd(), "public");
  const perfDir = path.join(outPublic, "performance");
  const posDir = path.join(perfDir, "positions");
  ensureDir(outPublic);
  ensureDir(perfDir);
  ensureDir(posDir);

  // 1) 取台股最近交易日 dataDate（關鍵：休市不中斷）
  const asOfDataDate = await getLastTWTradingDate();

  // 2) 讀今日推薦（today.json）
  const todayPath = path.join(outPublic, "today.json");
  const today = readJsonIfExists(todayPath, null);
  if (!today) throw new Error("public/today.json not found. Run generate_today first.");

  const picks = Array.isArray(today.picks) ? today.picks.slice(0, 3) : [];
  // 只追蹤 TOP3（你已定稿）
  const topSymbols = picks.map((p) => String(p.symbol));

  // 3) 讀 positions.json（總表）
  const positionsPath = path.join(perfDir, "positions.json");
  const base = readJsonIfExists(positionsPath, {
    generatedAt,
    asOfDataDate,
    rules: {
      maxHoldDays: MAX_HOLD_DAYS,
      returnMode: "last+max",
      tpEnabled: true,
      slRecordOnly: true,
      mergeOnRepeat: true,
      daysHeld: "tradingDays",
      dataDateSource: "^TWII",
    },
    open: [],
    closed: [],
    summary: { openCount: 0, expiredToday: 0 },
  });

  // 4) 先把今天 TOP3 加入追蹤池（重複推薦合併）
  for (const p of picks) {
    const symbol = String(p.symbol);
    const name = p.name || "";

    // 先找 open 有沒有
    let openItem = base.open.find((x) => x.symbol === symbol);

    if (!openItem) {
      // 新 position
      const ySym = yahooSymbolForTWStock(symbol);
      const snap = await getCloseOnOrBefore(ySym, asOfDataDate);
      if (!snap) continue;

      const entryPrice = snap.close;
      const entryDataDate = snap.date; // 可能 <= asOfDataDate（保險）

      // 建立單檔檔案
      const symPath = path.join(posDir, `${symbol}.json`);
      const symObj = {
        symbol,
        name,
        status: "open",
        entry: {
          entryDate: runDate,
          entryDataDate,
          entryPrice,
          lastRecommendedDate: runDate,
        },
        rules: {
          maxHoldDays: MAX_HOLD_DAYS,
          tp: TP_LEVELS,
          sl: SL,
        },
        daily: [
          {
            date: entryDataDate,
            close: entryPrice,
            returnPct: 0.0,
          },
        ],
        metrics: {
          daysHeld: 0,
          lastClose: entryPrice,
          lastReturnPct: 0.0,
          maxReturnPct: 0.0,
          maxReturnDate: entryDataDate,
          hitTP: false,
          hitSL: false,
          lastUpdatedDataDate: entryDataDate,
          expireDate: addDaysISO(runDate, MAX_HOLD_DAYS),
        },
      };

      writeJson(symPath, symObj);

      // 同步寫入總表 open
      openItem = {
        symbol,
        name,
        entryDate: runDate,
        entryDataDate,
        entryPrice,
        daysHeld: 0,
        lastClose: entryPrice,
        lastReturnPct: 0.0,
        maxReturnPct: 0.0,
        hitTP: false,
        hitSL: false,
        lastUpdatedDataDate: entryDataDate,
      };
      base.open.push(openItem);
    } else {
      // 合併：更新 lastRecommendedDate（寫到單檔檔案）
      const symPath = path.join(posDir, `${symbol}.json`);
      const symObj = readJsonIfExists(symPath, null);
      if (symObj && symObj.entry) {
        symObj.entry.lastRecommendedDate = runDate;
        writeJson(symPath, symObj);
      }
    }
  }

  // 5) 更新所有 open positions：若 today 的台股 dataDate 有新收盤，才寫入 daily
  // 判斷方式：如果 position 的 lastUpdatedDataDate < asOfDataDate，表示台股有新收盤
  const stillOpen = [];
  const newlyClosed = [];
  let expiredToday = 0;

  for (const pos of base.open) {
    const symbol = String(pos.symbol);
    const symPath = path.join(posDir, `${symbol}.json`);
    const symObj = readJsonIfExists(symPath, null);
    if (!symObj) continue;

    // 到期判斷（以日曆天 28 天）
    const heldCalendarDays = diffDays(symObj.entry.entryDate, runDate);
    const expireDate = addDaysISO(symObj.entry.entryDate, MAX_HOLD_DAYS);
    symObj.metrics.expireDate = expireDate;

    if (heldCalendarDays >= MAX_HOLD_DAYS) {
      // expired
      symObj.status = "expired";
      // 封存：不再新增 daily
      writeJson(symPath, symObj);

      newlyClosed.push({
        symbol,
        name: symObj.name || pos.name || "",
        entryDate: symObj.entry.entryDate,
        entryPrice: symObj.entry.entryPrice,
        exitType: "expired",
        exitDate: runDate,
        lastReturnPct: symObj.metrics.lastReturnPct,
        maxReturnPct: symObj.metrics.maxReturnPct,
      });
      expiredToday++;
      continue;
    }

    // 只在台股有新收盤時才新增 daily
    const lastUpdated = symObj.metrics.lastUpdatedDataDate;
    if (lastUpdated < asOfDataDate) {
      const ySym = yahooSymbolForTWStock(symbol);
      const snap = await getCloseOnOrBefore(ySym, asOfDataDate);
      if (snap && snap.date > lastUpdated) {
        // 避免重複寫同一天
        const exists = symObj.daily.some((d) => d.date === snap.date);
        if (!exists) {
          const ret = ((snap.close - symObj.entry.entryPrice) / symObj.entry.entryPrice) * 100;
          symObj.daily.push({
            date: snap.date,
            close: snap.close,
            returnPct: pct(ret),
          });
        }
        // 更新 lastUpdatedDataDate
        symObj.metrics.lastUpdatedDataDate = snap.date;
      }
    }

    // 重算 metrics（雙軌）
    const m = computeMetrics(symObj.daily, symObj.entry.entryPrice);
    symObj.metrics.daysHeld = m.daysHeld;
    symObj.metrics.lastClose = m.lastClose;
    symObj.metrics.lastReturnPct = pct(m.lastReturnPct);
    symObj.metrics.maxReturnPct = pct(m.maxReturnPct);
    symObj.metrics.maxReturnDate = m.maxReturnDate;
    symObj.metrics.hitTP = m.hitTP;
    symObj.metrics.hitSL = m.hitSL;

    // 回寫單檔
    writeJson(symPath, symObj);

    // 同步回寫總表
    pos.daysHeld = symObj.metrics.daysHeld;
    pos.lastClose = symObj.metrics.lastClose;
    pos.lastReturnPct = symObj.metrics.lastReturnPct;
    pos.maxReturnPct = symObj.metrics.maxReturnPct;
    pos.hitTP = symObj.metrics.hitTP;
    pos.hitSL = symObj.metrics.hitSL;
    pos.lastUpdatedDataDate = symObj.metrics.lastUpdatedDataDate;

    stillOpen.push(pos);
  }

  // 6) 寫回總表
  base.generatedAt = generatedAt;
  base.asOfDataDate = asOfDataDate;
  base.open = stillOpen;
  base.closed = (base.closed || []).concat(newlyClosed);
  base.summary = {
    openCount: stillOpen.length,
    expiredToday,
  };

  writeJson(positionsPath, base);

  console.log("✅ performance updated");
  console.log("   runDate:", runDate);
  console.log("   asOfDataDate(TW):", asOfDataDate);
  console.log("   open:", stillOpen.length, "closed added:", newlyClosed.length);
}

main().catch((e) => {
  console.error("❌ generate_performance failed:", e);
  process.exit(1);
});
