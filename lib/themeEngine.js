/**
 * v3.6 題材引擎
 * - 產業鏈（上下游）
 * - 股票標籤
 * - 每日新聞題材熱度
 * - 題材分數回灌選股
 */

const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 1800 });

/* =======================
   產業鏈
======================= */
const INDUSTRY_CHAINS = {
  "AI伺服器": {
    upstream: ["PCB", "ABF載板", "散熱", "電源", "連接器", "機殼"],
    midstream: ["伺服器ODM", "伺服器組裝", "主機板"],
    downstream: ["資料中心", "雲端", "AI算力"]
  },
  "CPO/光通訊": {
    upstream: ["矽光子", "雷射", "封裝", "材料"],
    midstream: ["光通訊模組", "交換器", "高速傳輸"],
    downstream: ["資料中心", "AI伺服器", "雲端"]
  },
  "半導體": {
    upstream: ["矽晶圓", "設備", "材料", "光罩"],
    midstream: ["晶圓代工", "IC設計", "封測"],
    downstream: ["AI晶片", "車用電子", "高效能運算"]
  },
  "PCB/載板": {
    upstream: ["銅箔基板", "玻纖布", "材料"],
    midstream: ["PCB", "ABF載板", "高階板"],
    downstream: ["伺服器", "網通", "AI設備"]
  },
  "散熱": {
    upstream: ["熱管", "均熱板", "風扇", "材料"],
    midstream: ["散熱模組", "液冷", "機構件"],
    downstream: ["AI伺服器", "筆電", "工業電腦"]
  },
  "電源/連接器": {
    upstream: ["MOSFET", "功率元件", "磁性元件"],
    midstream: ["電源供應器", "連接器", "線束"],
    downstream: ["伺服器", "車用", "工控"]
  },
  "機器人/自動化": {
    upstream: ["感測器", "減速機", "控制器"],
    midstream: ["工業電腦", "伺服系統", "自動化設備"],
    downstream: ["智慧工廠", "物流", "機器人應用"]
  },
  "車用電子": {
    upstream: ["鏡頭", "功率元件", "連接器", "PCB"],
    midstream: ["ADAS", "車載模組", "電控"],
    downstream: ["電動車", "自駕", "Robotaxi"]
  },
  "重電/儲能": {
    upstream: ["銅材", "鋼材", "功率模組", "電池材料"],
    midstream: ["重電設備", "儲能系統", "電力模組"],
    downstream: ["電網", "綠能", "電廠"]
  },
  "軍工/航太": {
    upstream: ["材料", "複材", "零組件"],
    midstream: ["航太零件", "無人機", "國防設備"],
    downstream: ["軍工", "飛機", "無人載具"]
  }
};

/* =======================
   股票標籤（第一版）
   你之後可以一直擴充
======================= */
const STOCK_TAGS = {
  // AI伺服器 / ODM / 組裝
  "2317": ["AI伺服器", "伺服器ODM"],
  "2382": ["AI伺服器", "伺服器ODM"],
  "3231": ["AI伺服器", "伺服器組裝", "散熱"],
  "6669": ["AI伺服器", "伺服器組裝"],
  "3017": ["AI伺服器", "伺服器組裝"],
  "2376": ["AI伺服器", "主機板"],
  "2356": ["AI伺服器", "主機板"],
  "2383": ["AI伺服器", "主機板"],
  "4938": ["AI伺服器", "高速傳輸"],
  "8210": ["AI伺服器"],

  // 半導體 / IC設計 / 晶圓代工 / 封測
  "2330": ["半導體", "晶圓代工", "AI晶片"],
  "2303": ["半導體", "晶圓代工"],
  "2454": ["半導體", "IC設計", "AI晶片"],
  "3035": ["半導體", "IC設計"],
  "3443": ["半導體", "IC設計"],
  "5269": ["半導體", "IC設計"],
  "4961": ["半導體", "IC設計"],
  "6533": ["半導體", "IC設計"],
  "6661": ["半導體", "IC設計"],
  "3711": ["半導體", "封測"],
  "2449": ["半導體", "封測"],
  "2369": ["半導體", "封測"],
  "2325": ["半導體", "設備"],
  "3131": ["半導體", "設備"],
  "3583": ["半導體", "設備"],

  // CPO / 光通訊 / 網通
  "4908": ["CPO/光通訊", "光通訊模組"],
  "4979": ["CPO/光通訊", "光通訊模組"],
  "3163": ["CPO/光通訊", "高速傳輸"],
  "3363": ["CPO/光通訊", "高速傳輸"],
  "3450": ["CPO/光通訊", "高速傳輸"],
  "3081": ["CPO/光通訊", "交換器"],
  "2345": ["CPO/光通訊", "網通"],
  "5388": ["CPO/光通訊", "網通"],
  "3596": ["CPO/光通訊", "矽光子"],

  // PCB / ABF載板
  "3037": ["PCB/載板", "PCB"],
  "3044": ["PCB/載板", "PCB"],
  "3189": ["PCB/載板", "PCB"],
  "4958": ["PCB/載板", "PCB"],
  "5469": ["PCB/載板", "PCB"],
  "6213": ["PCB/載板", "PCB"],
  "6274": ["PCB/載板", "PCB"],
  "8046": ["PCB/載板", "ABF載板"],
  "2383": ["PCB/載板", "主機板", "AI伺服器"],
  "6153": ["PCB/載板", "ABF載板"],

  // 散熱
  "3014": ["散熱", "散熱模組"],
  "3324": ["散熱", "散熱模組"],
  "3653": ["散熱", "均熱板"],
  "6230": ["散熱", "熱管"],
  "6125": ["散熱", "散熱模組"],
  "3032": ["散熱", "風扇"],
  "3013": ["散熱", "機構件"],

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

  // 自動化 / 機器人
  "1504": ["機器人/自動化", "工業設備"],
  "1536": ["機器人/自動化", "自動化設備"],
  "2049": ["機器人/自動化", "控制元件"],
  "3019": ["機器人/自動化", "工業電腦", "車用電子"],
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
  "3019": ["車用電子", "工業電腦"],
  "4976": ["車用電子", "ADAS"],
  "6279": ["車用電子", "鏡頭"],
  "3019": ["車用電子", "鏡頭"],
  "2379": ["車用電子", "IC"],
  "2454": ["車用電子", "IC設計", "半導體"],

  // 重電 / 儲能
  "1503": ["重電/儲能", "重電設備"],
  "1513": ["重電/儲能", "重電設備"],
  "1519": ["重電/儲能", "重電設備"],
  "2371": ["重電/儲能", "儲能系統"],
  "3708": ["重電/儲能", "電力設備"],
  "6806": ["重電/儲能", "儲能系統"],

  // 軍工 / 航太
  "2634": ["軍工/航太", "航太零件"],
  "3004": ["軍工/航太", "航太零件"],
  "4541": ["軍工/航太", "航太零件"],
  "4572": ["軍工/航太", "無人機"],
  "8222": ["軍工/航太", "無人機"]
};

/* =======================
   題材關鍵字
======================= */
const THEME_KEYWORDS = {
  "AI伺服器": [
    "ai伺服器","伺服器","gpu","資料中心","csp","機櫃","b300","gb200","ai server"
  ],
  "CPO/光通訊": [
    "cpo","光通訊","矽光子","800g","1.6t","高速傳輸","光模組","交換器"
  ],
  "半導體": [
    "半導體","晶圓代工","先進製程","封測","先進封裝","cowos","hbm","ic設計","晶片"
  ],
  "PCB/載板": [
    "pcb","載板","abf","銅箔基板","高階板"
  ],
  "散熱": [
    "散熱","液冷","均熱板","熱管","風扇"
  ],
  "電源/連接器": [
    "電源","power","連接器","線束","伺服器電源","功率元件"
  ],
  "機器人/自動化": [
    "機器人","自動化","智慧工廠","工業電腦","人形機器人","伺服系統"
  ],
  "車用電子": [
    "車用","電動車","adas","robotaxi","自駕","車載","充電樁"
  ],
  "重電/儲能": [
    "重電","儲能","電網","變壓器","綠能","電力設備"
  ],
  "軍工/航太": [
    "軍工","航太","無人機","國防","飛機","軍備"
  ]
};

const INDUSTRY_BASE_BONUS = {
  "AI伺服器": 7,
  "CPO/光通訊": 6.5,
  "半導體": 6,
  "PCB/載板": 5,
  "散熱": 4.8,
  "電源/連接器": 4.5,
  "機器人/自動化": 5.2,
  "車用電子": 4.8,
  "重電/儲能": 4.8,
  "軍工/航太": 4.6
};

/* =======================
   工具
======================= */
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

/* =======================
   新聞抓取
======================= */
const NEWS_QUERIES = [
  "台股 財經",
  "台股 AI 伺服器",
  "台股 半導體 IC設計",
  "台股 CPO 光通訊",
  "台股 散熱 電源 PCB",
  "台股 車用電子 重電 儲能 軍工"
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
      for (const item of items.slice(0, 20)) {
        all.push(item);
      }
    } catch {}
  }

  // 依 title + date 去重
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

/* =======================
   題材熱度
======================= */
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

/* =======================
   股票題材分析
======================= */
function getStockTags(stockId) {
  return unique(STOCK_TAGS[stockId] || []);
}

function expandToIndustryChains(tags) {
  const roots = [];
  const roles = [];

  for (const tag of tags || []) {
    if (INDUSTRY_CHAINS[tag]) roots.push(tag);

    for (const [industry, chain] of Object.entries(INDUSTRY_CHAINS)) {
      if (industry === tag) roots.push(industry);

      for (const part of ["upstream", "midstream", "downstream"]) {
        const arr = chain[part] || [];
        if (arr.includes(tag)) {
          roots.push(industry);
          roles.push(`${industry}:${part}`);
        }
      }
    }
  }

  return {
    roots: unique(roots),
    roles: unique(roles)
  };
}

function calcThemeScoreForStock(stockId, hotThemes) {
  const tags = getStockTags(stockId);
  const { roots, roles } = expandToIndustryChains(tags);

  let score = 0;
  const matchedThemes = [];
  const matchedReasons = [];

  for (const ht of hotThemes || []) {
    const themeName = ht.theme;
    const hotScore = ht.score || 0;

    // 核心題材直接命中
    if (roots.includes(themeName) || tags.includes(themeName)) {
      score += Math.min(INDUSTRY_BASE_BONUS[themeName] || 4, hotScore * 0.9);
      matchedThemes.push(themeName);
      matchedReasons.push(`核心題材:${themeName}`);
      continue;
    }

    // 上下游延伸
    const chain = INDUSTRY_CHAINS[themeName];
    if (!chain) continue;

    const allParts = [...(chain.upstream || []), ...(chain.midstream || []), ...(chain.downstream || [])];
    const linked = tags.some(t => allParts.includes(t));
    if (linked) {
      score += Math.min((INDUSTRY_BASE_BONUS[themeName] || 4) * 0.55, hotScore * 0.45);
      matchedThemes.push(themeName);
      matchedReasons.push(`上下游延伸:${themeName}`);
    }
  }

  return {
    themeScore: Number(score.toFixed(3)),
    stockTags: tags,
    industryRoots: roots,
    industryRoles: roles,
    matchedThemes: unique(matchedThemes),
    matchedReasons: unique(matchedReasons)
  };
}

module.exports = {
  INDUSTRY_CHAINS,
  STOCK_TAGS,
  THEME_KEYWORDS,
  getDailyHotThemes,
  getStockTags,
  expandToIndustryChains,
  calcThemeScoreForStock
};
