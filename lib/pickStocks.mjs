// lib/pickStocks.mjs
export async function pickStocks({ FINMIND_TOKEN }) {
  return {
    topN: 3,
    picks: [
      { symbol: "2330", name: "台積電", score: 92, reason: "法人買超、趨勢偏多" },
      { symbol: "2454", name: "聯發科", score: 88, reason: "技術面轉強" },
      { symbol: "2317", name: "鴻海", score: 85, reason: "低檔反彈" }
    ]
  };
}
