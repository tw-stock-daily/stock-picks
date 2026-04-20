/**
 * 台股精選 v3.7T
 * themeEngine
 * - 每日熱門題材
 * - 股票標籤
 * - 題材加分
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 1800 });

/* =======================
   股票標籤（v3.7T 穩定版）
======================= */
const STOCK_TAGS = {
  // AI伺服器 / ODM / 組裝 / 板卡
  "2317": ["AI伺服器", "伺服器ODM"],
  "2382": ["AI伺服器", "伺服器ODM"],
  "3231": ["AI伺服器", "伺服器組裝"],
  "6669": ["AI伺服器", "伺服器組裝"],
  "3017": ["AI伺服器", "伺服器組裝"],
  "2376": ["AI伺服器", "主機板"],
  "2356": ["AI伺服器", "主機板"],
  "2383": ["AI伺服器", "主機板", "PCB/載板", "PCB"],
  "3037": ["AI伺服器", "PCB/載板", "PCB"],
  "3044": ["AI伺服器", "PCB/載板", "PCB"],
  "3189": ["AI伺服器", "PCB/載板", "PCB"],
  "4958": ["AI伺服器", "PCB/載板", "PCB"],
  "5469": ["AI伺服器", "PCB/載板", "PCB"],
  "6213": ["AI伺服器", "PCB/載板", "PCB"],
  "6274": ["AI伺服器", "PCB/載板", "PCB"],
  "8046": ["AI伺服器", "PCB/載板", "ABF載板"],
  "6153": ["AI伺服器", "PCB/載板", "ABF載板"],

  // 半導體 / IC設計 / 記憶體 / 封測 / 設備
  "2330": ["半導體", "晶圓代工", "AI晶片"],
  "2303": ["半導體", "晶圓代工"],
  "2454": ["半導體", "IC設計", "AI晶片"],
  "3035": ["半導體", "IC設計"],
  "3443": ["半導體", "IC設計"],
  "5269": ["半導體", "IC設計"],
  "4961": ["半導體", "IC設計"],
  "6533": ["半導體", "IC設計"],
  "6661": ["半導體", "IC設計"],
  "2344": ["半導體", "記憶體"],
  "2337": ["半導體", "記憶體"],
  "2408": ["半導體", "記憶體"],
  "3711": ["半導體", "封測"],
  "2449": ["半導體", "封測"],
  "2369": ["半導體", "封測"],
  "2325": ["半導體", "設備"],
  "3131": ["半導體", "設備"],
  "3583": ["半導體", "設備"],
  "1560": ["半導體", "設備"],
  "2464": ["半導體", "設備"],

  // CPO / 光通訊 / 網通
  "4908": ["CPO/光通訊", "光通訊模組"],
  "4979": ["CPO/光通訊", "光通訊模組"],
  "3163": ["CPO/光通訊", "高速傳輸"],
  "3363": ["CPO/光通訊", "高速傳輸"],
  "3450": ["CPO/光通訊", "高速傳輸"],
  "3081": ["CPO/光通訊", "交換器"],
  "3596": ["CPO/光通訊", "矽光子"],
  "2455": ["CPO/光通訊", "光通訊模組"],
  "3031": ["CPO/光通訊", "網通"],
  "3704": ["CPO/光通訊", "網通"],

  // PCB / 載板
  "2368": ["PCB/載板", "主機板"],
  "2353": ["PCB/載板", "主機板"],
  "2376": ["PCB/載板", "主機板"],
  "2356": ["PCB/載板", "主機板"],

  // 散熱
  "3014": ["散熱", "散熱模組"],
  "3324": ["散熱", "散熱模組"],
  "3653": ["散熱", "均熱板"],
  "6230": ["散熱", "熱管"],
  "6125": ["散熱", "散熱模組"],
  "3032": ["散熱", "風扇"],
  "3013": ["散熱", "機構件"],
  "2421": ["散熱", "機構件"],

  // 電源 / 連接器
  "2301": ["電源/連接器", "電源供應器"],
  "2385": ["電源/連接器", "電源供應器"],
  "3023": ["電源/連接器", "電源供應器"],
  "3211": ["電源/連接器", "電源供應器"],
  "4912": ["電源/連接器", "連接器"],
  "3605": ["電源/連接器", "連接器"],
  "6414": ["電源/連接器", "連接器"],
  "6271": ["電源/連接器", "連接器"],
  "6269": ["電源/連接器", "連接器"],

  // 機器人 / 自動化
  "1504": ["機器人/自動化", "工業設備"],
  "1536": ["機器人/自動化", "自動化設備"],
  "2049": ["機器人/自動化", "控制元件"],
  "3019": ["機器人/自動化", "工業電腦"],
  "4510": ["機器人/自動化", "自動化設備"],
  "4540": ["機器人/自動化", "自動化設備"],
  "4551": ["機器人/自動化", "自動化設備"],
  "4562": ["機器人/自動化", "自動化設備"],
  "4583": ["機器人/自動化", "自動化設備"],
  "8374": ["機器人/自動化", "工業電腦"],
  "9945": ["機器人/自動化", "工業電腦"],

  // 車用電子
  "1533": ["車用電子", "電控"],
  "2201": ["車用電子"],
  "2204": ["車用電子"],
  "4976": ["車用電子", "ADAS"],
  "6279": ["車用電子", "鏡頭"],
  "2379": ["車用電子", "IC"],
};

/* =======================
   題材關鍵字
======================= */
const THEME_KEYWORDS = {
  "AI伺服器": ["ai伺服器","伺服器","gpu","資料中心","gb200","ai server"],
  "CPO/光通訊": ["cpo","光通訊","矽光子","800g","1.6t","高速傳輸","光模組","交換器"],
  "半導體": ["半導體","晶圓代工","封測","先進封裝","cowos","hbm","ic設計","記憶體","晶片"],
  "PCB/載板": ["pcb","載板","abf","銅箔基板","高階板"],
  "散熱": ["散熱","液冷","均熱板","熱管","風扇"],
  "電源/連接器": ["電源","power","連接器","線束","伺服器電源","功率元件"],
  "機器人/自動化": ["機器人","自動化","智慧工廠","工業電腦","人形機器人"],
  "車用電子": ["車用","電動車","adas","robotaxi","自駕","車載"]
};

const INDUSTRY_BASE_BONUS = {
  "AI伺服器": 4.5,
  "CPO/光通訊": 4.2,
  "半導體": 4.0,
  "PCB/載板": 3.8,
  "散熱": 3.4,
  "電源/連接器": 3.2,
  "機器人/自動化": 3.0,
  "車用電子": 2.8
};

function unique(arr) {
  return [...new Set(arr || [])];
}

function normalizeText(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripCdata(s) {
  return String(s || "").replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function parseRssItems(xml) {
  const items = [];
  const matches = String(xml || "").match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const raw of matches) {
    const title = stripCdata((raw.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "");
    const link = stripCdata((raw.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || "");
    const pubDate = stripCdata((raw.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || "");
    const description = stripCdata((raw.match(/<description>([\s\S]*?)<\/description>/i) || [])[1] || "");

    if (!title) continue;

    items.push({
      title: title.trim(),
      link: link.trim(),
      pubDate: pubDate.trim(),
      description: description.trim()
    });
  }

  return items;
}

function buildGoogleNewsRssUrl(query) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
}

function getHoursAgo(pubDate) {
  const t = new Date(pubDate).getTime();
  if (!t) return 999;
  return Math.max(0, (Date.now() - t) / 3600000);
}

function getRecencyWeight(pubDate) {
  const hours = getHoursAgo(pubDate);
  if (hours <= 12) return 1.6;
  if (hours <= 24) return 1.35;
  if (hours <= 48) return 1.15;
  if (hours <= 72) return 1.0;
  if (hours <= 120) return 0.8;
  return 0.55;
}

const NEWS_QUERIES = [
  "台股 財經",
  "台股 AI 伺服器",
  "台股 半導體 IC設計 記憶體",
  "台股 CPO 光通訊",
  "台股 散熱 電源 PCB 載板",
  "台股 機器人 自動化 車用電子"
];

async function fetchNewsItems() {
  const cacheKey = "theme-news-items";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const all = [];

  for (const q of NEWS_QUERIES) {
    try {
      const url = buildGoogleNewsRssUrl(q);
      const resp = await axios.get(url, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const items = parseRssItems(resp.data);
      for (const item of items.slice(0, 20)) all.push(item);
    } catch {}
  }

  const seen = new Set();
  const deduped = [];

  for (const item of all) {
    const key = `${item.title}__${item.pubDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  cache.set(cacheKey, deduped);
  return deduped;
}

async function getDailyHotThemes() {
  const cacheKey = "daily-hot-themes";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const items = await fetchNewsItems();
  const themeScores = {};
  const matchedNews = {};

  for (const theme of Object.keys(THEME_KEYWORDS)) {
    themeScores[theme] = 0;
    matchedNews[theme] = [];
  }

  for (const item of items) {
    const text = normalizeText(`${item.title} ${item.description}`);
    const recencyWeight = getRecencyWeight(item.pubDate);

    for (const [theme, keywords] of Object.entries(THEME_KEYWORDS)) {
      let hit = 0;
      for (const kw of keywords) {
        if (text.includes(String(kw).toLowerCase())) hit++;
      }
      if (!hit) continue;

      const score = hit * recencyWeight;
      themeScores[theme] += score;

      if (matchedNews[theme].length < 5) {
        matchedNews[theme].push({
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
          score: Number(score.toFixed(2))
        });
      }
    }
  }

  const sorted = Object.entries(themeScores)
    .map(([theme, score]) => ({
      theme,
      score: Number(score.toFixed(2)),
      news: matchedNews[theme] || []
    }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const hotThemes = sorted.slice(0, 5);
  cache.set(cacheKey, hotThemes);
  return hotThemes;
}

function getStockTags(stockId) {
  return unique(STOCK_TAGS[stockId] || []);
}

function calcThemeScoreForStock(stockId, hotThemes) {
  const tags = getStockTags(stockId);

  let score = 0;
  const matchedThemes = [];
  const matchedReasons = [];

  for (const ht of hotThemes || []) {
    const themeName = ht.theme;
    const hotScore = ht.score || 0;

    if (tags.includes(themeName)) {
      score += Math.min(INDUSTRY_BASE_BONUS[themeName] || 2, hotScore * 0.6);
      matchedThemes.push(themeName);
      matchedReasons.push(`核心題材:${themeName}`);
      continue;
    }

    // 關鍵標籤延伸比對
    const tagText = tags.join(" / ").toLowerCase();
    const themeKeyText = String(themeName || "").toLowerCase();

    if (tagText.includes(themeKeyText)) {
      score += Math.min((INDUSTRY_BASE_BONUS[themeName] || 2) * 0.5, hotScore * 0.3);
      matchedThemes.push(themeName);
      matchedReasons.push(`延伸題材:${themeName}`);
    }
  }

  return {
    themeScore: Number(score.toFixed(3)),
    stockTags: tags,
    industryRoots: unique(matchedThemes),
    industryRoles: [],
    matchedThemes: unique(matchedThemes),
    matchedReasons: unique(matchedReasons)
  };
}

module.exports = {
  STOCK_TAGS,
  THEME_KEYWORDS,
  getDailyHotThemes,
  getStockTags,
  calcThemeScoreForStock
};