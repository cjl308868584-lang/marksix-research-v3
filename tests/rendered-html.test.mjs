import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function fetchWorker(path = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, init),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function render(path = "/") {
  return fetchWorker(path, {
    headers: { accept: "text/html", host: "localhost" },
  });
}

test("server-renders the finished lottery research dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>六合智研｜港澳三彩开奖与 AI 预测研究<\/title>/i);
  assert.match(html, /让每一期数据/);
  assert.match(html, /北京时间/);
  assert.match(html, /香港六合彩/);
  assert.match(html, /澳门六合彩/);
  assert.match(html, /新澳门六合彩/);
  assert.match(html, /号码 12，羊，红波/);
  assert.match(html, /特码 25，马，蓝波/);
  assert.doesNotMatch(html, /[鼠牛虎兔龙蛇马羊猴鸡狗猪]肖/);
  assert.match(html, /AI 多策略预测实验室/);
  assert.match(html, /三路候选策略/);
  assert.match(html, /生肖方向命中/);
  assert.match(html, /九维证据/);
  assert.match(html, /滚动回测/);
  assert.match(html, /历史开奖记录/);
  assert.match(html, /不构成投注建议/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Your site is taking shape/i);
});

test("keeps the product implementation free of starter preview artifacts", async () => {
  const [page, layout, dashboard, styles, packageJson, lotteryLib, lotteryRoute, analyzeRoute, aiEngine, aiTypes, aiRateLimit] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/LotteryDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/lottery.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/lottery/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-types.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-rate-limit.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<LotteryDashboard \/>/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(layout, /width: "device-width"/);
  assert.match(layout, /viewportFit: "cover"/);
  assert.match(dashboard, /开奖前 3 分钟自动开启开奖台/);
  assert.match(dashboard, /const orderedGames = \[/);
  assert.match(dashboard, /orderedGames\.map/);
  assert.match(dashboard, /drawGridRef\.current\?\.scrollTo/);
  assert.match(dashboard, /function ScratchSpecialBall/);
  assert.match(dashboard, /new ResizeObserver/);
  assert.match(dashboard, /destination-out/);
  assert.match(dashboard, /onLostPointerCapture/);
  assert.match(dashboard, /tabIndex=\{complete \? -1 : 0\}/);
  assert.match(dashboard, /AI_FOCUS_OPTIONS/);
  assert.match(dashboard, /AiEvidenceSection/);
  assert.match(dashboard, /ai-recommendation-balls/);
  assert.match(dashboard, /strategy-review-result/);
  assert.match(dashboard, /特码号码/);
  assert.match(dashboard, /特码生肖/);
  assert.match(dashboard, /结果已返回 · 待交叉核验/);
  assert.match(dashboard, /aria-current=/);
  assert.match(dashboard, /ball-zodiac/);
  assert.match(dashboard, /historyVisible/);
  assert.match(dashboard, /再加载/);
  assert.match(styles, /history-mobile-list/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /scroll-snap-type: x mandatory/);
  assert.match(styles, /env\(safe-area-inset-top\)/);
  assert.match(styles, /width: min\(76vw, 240px\)/);
  assert.match(styles, /\.ai-processing p[\s\S]*transform: none/);
  assert.match(styles, /\.strategy-card:not\(\.active\)[\s\S]*display: block/);
  assert.match(styles, /\.strategy-grid[\s\S]*scroll-snap-type: x mandatory/);
  assert.match(styles, /\.topbar[\s\S]*position: sticky/);
  assert.match(styles, /\.mobile-nav a[\s\S]*min-height: 52px/);
  assert.match(styles, /max-width: 370px/);
  assert.match(styles, /touch-action: none/);
  assert.match(styles, /\.special-stage-wrap[\s\S]*grid-column: 1 \/ -1/);
  assert.match(lotteryLib, /new_macau/);
  assert.match(lotteryLib, /\[12, 11, 31, 3, 44, 37\], 25/);
  assert.match(lotteryRoute, /info\.cld\.hkjc\.com/);
  assert.match(lotteryRoute, /api3\.marksix6\.net/);
  assert.match(lotteryRoute, /api\.api16868\.com/);
  assert.match(lotteryRoute, /10092/);
  assert.match(analyzeRoute, /AI_API_KEY/);
  assert.match(analyzeRoute, /\/responses/);
  assert.match(analyzeRoute, /json_schema/);
  assert.match(analyzeRoute, /safety_identifier/);
  assert.match(analyzeRoute, /store: false/);
  assert.match(analyzeRoute, /isSafeModelText/);
  assert.doesNotMatch(analyzeRoute, /request\.headers\.get\("user-agent"\)/);
  assert.match(aiEngine, /buildWalkForwardBacktest/);
  assert.match(aiEngine, /noLookahead: true/);
  assert.match(aiTypes, /evidence_strength_not_win_probability/);
  assert.match(aiRateLimit, /limitReached\(db, globalKey/);
  assert.match(aiRateLimit, /WHERE ai_rate_limits\.count < \?/);
  assert.match(aiRateLimit, /return denied\(now \+ 60_000, now\)/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og-v2.png", import.meta.url));
  await access(new URL("../lib/lottery.ts", import.meta.url));
  await access(templateRoot);
});

test("AI endpoint rejects client-supplied history data", async () => {
  const response = await fetchWorker("/api/analyze", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({
      game: "new_macau",
      window: 30,
      focus: "comprehensive",
      depth: "deep",
      draws: [{ issue: "forged" }],
    }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(payload.error, /不受支持的字段/);
});
