const { pickStocks } = require("../lib/pickStocks");

(async () => {
  try {
    const result = await pickStocks();

    console.log("hotThemes =", (result.hotThemes || []).map(x => x.theme));
    console.log("picks =", (result.picks || []).length);
    console.log("candidates =", (result.candidates || []).length);

    if (result.candidates && result.candidates.length) {
      console.log("top 10 candidates:");
      result.candidates.slice(0, 10).forEach((x, i) => {
        console.log(
          `${i + 1}. ${x.symbol} ${x.name} score=${x.score} base=${x.baseScore} inst=${x.instScore} theme=${x.themeScore} volRatio=${x.volRatio} macdHist=${x.macdHist} ma5=${x.ma5} ma10=${x.ma10} ma20=${x.ma20}`
        );
      });
    } else {
      console.log("No candidates passed all filters.");
    }
  } catch (e) {
    console.error(e);
  }
})();