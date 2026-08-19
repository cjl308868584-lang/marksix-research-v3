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
  assert.match(html, /<title>六合智研｜高概率策略与逐期学习<\/title>/i);
  assert.match(html, /让每一期数据/);
  assert.match(html, /北京时间/);
  assert.match(html, /香港六合彩/);
  assert.match(html, /新澳门六合彩/);
  assert.doesNotMatch(html, />澳门</);
  assert.match(html, /号码 12，羊，红波/);
  assert.match(html, /特码 25，马，蓝波/);
  assert.doesNotMatch(html, /[鼠牛虎兔龙蛇马羊猴鸡狗猪]肖/);
  assert.match(html, /进入高概率策略/);
  assert.match(html, /href="\/research"/);
  assert.match(html, /近30期条件规律/);
  assert.match(html, /href="\/patterns"/);
  assert.doesNotMatch(html, /双轨概率研究实验室/);
  assert.doesNotMatch(html, /三路候选策略/);
  assert.match(html, /历史开奖记录/);
  assert.match(html, /不构成投注建议/);
  assert.match(html, /每期固定五项/);
  assert.match(html, /产品学习/);
  assert.doesNotMatch(html, /每期固定四项/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Your site is taking shape/i);
});

test("server-renders the dedicated rule research workspace", async () => {
  const response = await render("/research");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>高概率策略中心｜六合智研<\/title>/i);
  assert.match(html, /不猜号码/);
  assert.match(html, /只研究高概率事件/);
  assert.match(html, /新澳门六合彩/);
  assert.match(html, /香港六合彩/);
  assert.match(html, /正在读取冻结策略与学习状态/);
});

test("research UI separates formal abstention from multi-source research candidates", async () => {
  const [workspace, engine, review] = await Promise.all([
    readFile(new URL("../app/research/ResearchWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/research-v3-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/research-v3-review.ts", import.meta.url), "utf8"),
  ]);
  assert.match(workspace, /正式层暂无已验证方向/);
  assert.match(workspace, /研究候选/);
  assert.match(workspace, /多源一致/);
  assert.match(engine, /calibrated_absolute_probability/);
  assert.doesNotMatch(review, /20期/);
  assert.match(review, /50期/);
});

test("server-renders the immutable period review workspace", async () => {
  const response = await render("/research/review");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>逐期学习复盘｜六合智研<\/title>/i);
  assert.match(html, /每期开奖后/);
  assert.match(html, /模型都必须交卷/);
  assert.match(html, /正在读取不可变复盘账本/);
  assert.match(html, /href="\/research"/);
});

test("server-renders the independent forward learning center", async () => {
  const response = await render("/learning");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>逐期学习中心｜六合智研<\/title>/i);
  assert.match(html, /每期固定五项/);
  assert.match(html, /开奖以后全部交卷/);
  assert.match(html, /正在读取不可变学习账本/);
  assert.match(html, /与近30期购买参考同源/);
  assert.match(html, /赔率参与排序/);
  assert.doesNotMatch(html, /赔率不参与模型排序/);
  assert.doesNotMatch(html, /THREE EXPERTS/);
  assert.doesNotMatch(html, /赔率价值分析/);
});

test("server-renders the mobile-first rolling 30 pattern workspace", async () => {
  const response = await render("/patterns");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>近30期条件规律｜六合智研<\/title>/i);
  assert.match(html, /条件 A/);
  assert.match(html, /下一期结果 B/);
  assert.match(html, /不是热号/);
  assert.match(html, /6\+1覆盖规律/);
  assert.match(html, /特码规律/);
  assert.match(html, /正在读取冻结的近期规律/);
  assert.doesNotMatch(html, /aria-label="研究页面"/);
  assert.doesNotMatch(html, /href="\/research(?:\/review)?"/);

  const workspace = await readFile(
    new URL("../app/patterns/RollingPatternWorkspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workspace, /支持策略数/);
  assert.match(workspace, /总命中次数/);
  assert.match(workspace, /总失败次数/);
  assert.match(workspace, /结果 B 支持汇总/);
  assert.match(workspace, /特码号码交集前15/);
  assert.match(workspace, /规律交集研究分，不是01–49的真实中奖概率/);
  assert.match(workspace, /query\.set\("number"/);
  assert.match(workspace, /selectedNumber/);
  assert.match(workspace, /历史汇总.*percent\(item\.hitRate\)/s);
  assert.match(workspace, /规则审计次数，不是独立期开奖期数/);
  assert.doesNotMatch(workspace, /赔率价值分析/);
  assert.match(workspace, /本期购买参考/);
  assert.match(workspace, /推荐理由/);
  assert.match(workspace, /二连肖/);
  assert.match(workspace, /三连肖/);
  assert.match(workspace, /盈亏平衡/);
  assert.match(workspace, /逐期汇总结算/);
  assert.doesNotMatch(workspace, /本期不推荐/);
});

test("legacy rolling pattern route redirects to the independent page", async () => {
  const response = await render("/research/patterns");
  assert.ok([307, 308].includes(response.status));
  assert.equal(new URL(response.headers.get("location"), "http://localhost").pathname, "/patterns");
});

test("strategy and review stay linked while patterns remain a standalone workspace", async () => {
  for (const path of ["/research", "/research/review"]) {
    const response = await render(path);
    const html = await response.text();
    assert.match(html, /href="\/research"/);
    assert.match(html, /href="\/research\/review"/);
    assert.doesNotMatch(html, /href="\/patterns"/);
  }
});

test("review API accepts the fifty-period history requested by the review page", async () => {
  const response = await fetchWorker(
    "/api/research/reviews?game=new_macau&limit=50",
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload, { game: "new_macau", reviews: [] });
});

test("learning APIs remain read-only and return an explicit empty ledger", async () => {
  const forecast = await fetchWorker("/api/learning/forecast?game=new_macau");
  assert.equal(forecast.status, 404);
  assert.equal(forecast.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await forecast.json(), {
    game: "new_macau",
    status: "unavailable",
    forecasts: [],
  });
  for (const path of ["reviews", "performance", "model"]) {
    const response = await fetchWorker(`/api/learning/${path}?game=new_macau&write=true`);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "请求包含不受支持的参数。" });
  }
});

test("rolling pattern API rejects unsupported parameters before reading storage", async () => {
  const response = await fetchWorker(
    "/api/research/patterns?game=new_macau&write=true",
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "请求包含不受支持的参数。",
  });
});

test("rolling pattern API returns an explicit no-store unavailable state", async () => {
  const response = await fetchWorker(
    "/api/research/patterns?game=new_macau&scope=special",
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    game: "new_macau",
    status: "unavailable",
    run: null,
    signals: [],
    scores: [],
    summary: null,
    specialNumberConsensus: [],
    recommendations: [],
    valueAnalysis: [],
    settlementHistory: [],
    pagination: { page: 1, pageSize: 20, total: 0, pages: 0 },
  });
});

test("rolling pattern API accepts only a valid special-number detail filter", async () => {
  const invalidNumber = await fetchWorker(
    "/api/research/patterns?game=new_macau&scope=special&number=50",
  );
  assert.equal(invalidNumber.status, 400);

  const wrongScope = await fetchWorker(
    "/api/research/patterns?game=new_macau&scope=coverage_6_plus_1&number=3",
  );
  assert.equal(wrongScope.status, 400);

  const valid = await fetchWorker(
    "/api/research/patterns?game=new_macau&scope=special&number=3",
  );
  assert.equal(valid.status, 404);
  const payload = await valid.json();
  assert.deepEqual(payload.specialNumberConsensus, []);
});

test("rolling pattern API rejects a family that is unavailable in the selected scope", async () => {
  const response = await fetchWorker(
    "/api/research/patterns?game=new_macau&scope=coverage_6_plus_1&family=wave",
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "彩种、期号、结果域、分类、结果或页码无效。",
  });
});

test("public research reads never settle, train, or freeze forecasts", async () => {
  const [forecastRoute, reviewRoute, modelRoute, rulesRoute, lotteryRoute, analyzeRoute] =
    await Promise.all([
      readFile(new URL("../app/api/research/forecast/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/research/reviews/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/research/models/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/research/rules/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/lottery/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    ]);
  for (const route of [forecastRoute, reviewRoute, modelRoute, rulesRoute]) {
    assert.doesNotMatch(route, /loadResearchV3Envelope/);
    assert.doesNotMatch(route, /settleResearchV3Forecasts/);
  }
  assert.doesNotMatch(lotteryRoute, /settleResearchForecasts/);
  assert.doesNotMatch(lotteryRoute, /settleLatestResearch/);
  assert.match(forecastRoute, /readResearchV3Envelope/);
  const analyzeGet = analyzeRoute.slice(
    analyzeRoute.indexOf("export async function GET"),
    analyzeRoute.indexOf("export async function POST"),
  );
  assert.doesNotMatch(analyzeGet, /settleForecastLedger/);
});

test("public feeds preserve official verification and require conflict-free cross-source agreement", async () => {
  const lotteryRoute = await readFile(
    new URL("../app/api/lottery/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    lotteryRoute,
    /source: "香港赛马会",\s+verified: true,/,
  );
  assert.match(
    lotteryRoute,
    /verified: item\.verified \|\| \(!hasConflict && agreeingSources\.size >= 2\)/,
  );
  assert.match(
    lotteryRoute,
    /history\.macaumarksix\.com\/history\/macaujc2\/y\/\$\{value\}/,
  );
});

test("research writes are guarded by task idempotency and a settlement claim", async () => {
  const [store, internalRoute, schema] = await Promise.all([
    readFile(new URL("../lib/research-v3-store.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../app/api/internal/research/settle-and-learn/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(store, /INSERT OR IGNORE INTO research_settlement_claims/);
  assert.match(store, /status = 'completed'/);
  assert.ok(
    store.indexOf("claimResearchSettlement") <
      store.indexOf("INSERT INTO research_rule_states"),
  );
  assert.match(internalRoute, /claimResearchTask/);
  assert.match(internalRoute, /completeResearchTask/);
  assert.match(schema, /research_settlement_claims/);
  assert.match(schema, /research_task_runs/);
});

test("scheduled learning sends Python artifacts and verified-only data through the signed writer", async () => {
  const [workflow, service, engine, pipeline, store] = await Promise.all([
    readFile(new URL("../.github/workflows/research-v2.yml", import.meta.url), "utf8"),
    readFile(new URL("../lib/research-v3-service.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/research-v3-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../research/src/marksix_research/pipeline.py", import.meta.url), "utf8"),
    readFile(new URL("../lib/research-v3-store.ts", import.meta.url), "utf8"),
  ]);
  const crons = [...workflow.matchAll(/cron:\s*["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(crons, [
    "40,45,50,55 13 * * *",
    "0,5,10,15,20,25,30 14 * * *",
    "17 */2 * * *",
  ]);
  assert.match(workflow, /matrix:[\s\S]*game:\s*\[hk, new_macau\]/);
  assert.match(workflow, /fail-fast:\s*false/);
  assert.match(workflow, /group:\s*research-v3-learning-\$\{\{ github\.ref \}\}/);
  assert.doesNotMatch(workflow, /github\.event\.schedule/);
  assert.match(workflow, /marksix-research cycle[\s\S]*--game "\$GAME"/);
  assert.match(workflow, /marksix-research health-check[\s\S]*--game "\$GAME"/);
  assert.match(workflow, /check-update[\s\S]*should_run/);
  assert.match(workflow, /steps\.update_check\.outputs\.should_run == 'true'/);
  assert.doesNotMatch(workflow, /--max-wait-seconds\s+3600/);
  assert.doesNotMatch(workflow, /npm run test:ai|npm run typecheck/);
  assert.match(workflow, /test -n "\$RESEARCH_SECRET"/);
  assert.match(service, /previous frozen forecasts could not be settled/);
  assert.match(service, /persistResearchDataset/);
  assert.match(engine, /draw\.verified === true/);
  assert.match(pipeline, /formal_draws = \[draw for draw in draws if draw\.verified\]/);
  assert.match(store, /draw_source_snapshots/);
  assert.match(store, /dataset_versions/);
});

test("keeps the product implementation free of starter preview artifacts", async () => {
  const [page, layout, dashboard, researchWorkspace, reviewWorkspace, researchStore, reviewEngine, reviewMigration, styles, packageJson, lotteryLib, lotteryRoute, analyzeRoute, aiEngine, aiTypes, aiRateLimit, aiLedger, aiOnlineLearning, primaryLockMigration] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/LotteryDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/research/ResearchWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/research/review/ResearchReviewWorkspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/research-v2-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/research-review.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0004_black_night_nurse.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/lottery.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/lottery/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/analyze/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-types.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-rate-limit.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-forecast-ledger.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/ai-online-learning.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_brief_thanos.sql", import.meta.url), "utf8"),
  ]);

  assert.match(
    page,
    /<LotteryDashboard initialNow=\{new Date\(\)\.toISOString\(\)\} \/>/,
  );
  assert.match(dashboard, /useState\(\(\) => new Date\(initialNow\)\)/);
  assert.match(dashboard, /drawAt=\{liveWindow\.target\.toISOString\(\)\}/);
  assert.match(dashboard, /const marker = window\.innerHeight \* 0\.28/);
  assert.match(lotteryLib, /ZODIAC_NAMES\.indexOf/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(layout, /width: "device-width"/);
  assert.match(layout, /viewportFit: "cover"/);
  assert.match(dashboard, /开奖前 3 分钟自动开启开奖台/);
  assert.match(dashboard, /useState<GameId>\("new_macau"\)/);
  assert.match(dashboard, /const LIVE_POLL_MS = 3_000/);
  assert.match(dashboard, /const BACKGROUND_POLL_MS = 60_000/);
  assert.match(dashboard, /liveGameKey/);
  assert.match(dashboard, /visibilitychange/);
  assert.match(dashboard, /mergeDrawLists/);
  assert.match(dashboard, /mergeLiveProgress/);
  assert.match(dashboard, /Number\(incoming\.special !== null\)/);
  assert.match(dashboard, /drawToLiveProgress/);
  assert.match(dashboard, /number-wave-\$\{wave\}/);
  assert.match(dashboard, /WAVE_LABEL\[wave\]/);
  assert.match(dashboard, /progress=\{selectedProgress\}/);
  assert.match(dashboard, /高频检测每 3 秒/);
  assert.match(dashboard, /const orderedGames = \[/);
  assert.match(dashboard, /orderedGames\.map/);
  assert.match(dashboard, /drawGridRef\.current\?\.scrollTo/);
  assert.match(dashboard, /function ScratchSpecialBall/);
  assert.match(dashboard, /new ResizeObserver/);
  assert.match(dashboard, /destination-out/);
  assert.match(dashboard, /onLostPointerCapture/);
  assert.match(dashboard, /tabIndex=\{complete \? -1 : 0\}/);
  assert.match(dashboard, /href="\/research"/);
  assert.doesNotMatch(
    dashboard.slice(
      dashboard.indexOf("export function LotteryDashboard"),
      dashboard.indexOf("function Ball"),
    ),
    /三路候选策略|双轨概率研究实验室|冻结概率与规律挑战场/,
  );
  assert.match(researchWorkspace, /不猜号码/);
  assert.match(researchWorkspace, /下一期固定四项/);
  assert.match(researchWorkspace, /每期只冻结四项40%/);
  assert.match(researchWorkspace, /随机基线/);
  assert.match(researchWorkspace, /Brier skill/);
  assert.match(researchWorkspace, /逐期开奖学习闭环/);
  assert.match(researchWorkspace, /快中慢证据/);
  assert.match(researchWorkspace, /不输出01–49候选/);
  assert.match(researchWorkspace, /href="\/research\/review"/);
  assert.doesNotMatch(researchWorkspace, /最高交集号码|共识号码前三/);
  assert.match(reviewWorkspace, /模型都必须交卷/);
  assert.match(reviewWorkspace, /误差归因/);
  assert.match(reviewWorkspace, /模型权重如何变化/);
  assert.match(reviewWorkspace, /模型是否真的在进步/);
  assert.match(reviewEngine, /buildResearchReview/);
  assert.match(reviewEngine, /negative_avoided/);
  assert.match(researchStore, /INSERT OR IGNORE INTO research_rule_ledger/);
  assert.match(researchStore, /review_json/);
  assert.match(reviewMigration, /CREATE TABLE `research_rule_ledger`/);
  assert.match(reviewMigration, /ADD `review_json` text/);
  assert.match(dashboard, /aria-current=/);
  assert.match(dashboard, /ball-zodiac/);
  assert.match(dashboard, /historyVisible/);
  assert.match(dashboard, /再加载/);
  assert.match(styles, /history-mobile-list/);
  assert.match(styles, /@media \(max-width: 760px\)/);
  assert.match(styles, /scroll-snap-type: x mandatory/);
  assert.match(styles, /env\(safe-area-inset-top\)/);
  assert.match(styles, /width: min\(76vw, 240px\)/);
  assert.match(styles, /\.draw-card > \.ball-row \.special-item \.ball[\s\S]*width: 58px/);
  assert.match(styles, /\.strategy-card > \.ball-row\.compact \.ball[\s\S]*width: min\(46px, 100%\)/);
  assert.match(styles, /\.scratch-reward \.stage-ball[\s\S]*width: 72px/);
  assert.match(styles, /\.number-cell\.number-wave-red[\s\S]*--number-wave: var\(--red\)/);
  assert.match(styles, /\.number-cell\.number-wave-blue[\s\S]*--number-wave: var\(--blue\)/);
  assert.match(styles, /\.number-cell\.number-wave-green[\s\S]*--number-wave: var\(--green\)/);
  assert.match(styles, /\.rule-research-shell/);
  assert.match(styles, /\.rule-controls/);
  assert.match(styles, /\.rule-audit-card/);
  assert.match(styles, /\.rule-primary-metrics/);
  assert.match(styles, /\.rule-score-grid/);
  assert.match(styles, /\.review-rule-card/);
  assert.match(styles, /\.review-ball-row/);
  assert.match(styles, /\.topbar[\s\S]*position: sticky/);
  assert.match(styles, /\.mobile-nav a[\s\S]*min-height: 52px/);
  assert.match(styles, /@media \(max-width: 680px\)/);
  assert.match(styles, /max-width: 370px/);
  assert.match(
    styles,
    /@media \(max-width: 370px\)[\s\S]*?\.v3-issue-picker \{ margin-inline: -9px; padding-inline: 9px; \}/,
  );
  assert.match(styles, /touch-action: none/);
  assert.match(styles, /\.special-stage-wrap[\s\S]*grid-column: 1 \/ -1/);
  assert.match(lotteryLib, /new_macau/);
  assert.match(lotteryLib, /export const GAME_IDS: readonly GameId\[\] = \["hk", "new_macau"\]/);
  assert.match(lotteryLib, /ALL_GAME_IDS\.map/);
  assert.match(lotteryLib, /export type LiveDrawProgress/);
  assert.match(lotteryLib, /\[12, 11, 31, 3, 44, 37\], 25/);
  assert.match(lotteryRoute, /info\.cld\.hkjc\.com/);
  assert.match(lotteryRoute, /api3\.marksix6\.net/);
  assert.match(lotteryRoute, /api\.api16868\.com/);
  assert.match(lotteryRoute, /10092/);
  assert.match(lotteryRoute, /const liveRequest =/);
  assert.match(lotteryRoute, /private, no-store, max-age=0/);
  assert.match(lotteryRoute, /getLiveDraws/);
  assert.match(lotteryRoute, /getCachedLiveDraws/);
  assert.match(lotteryRoute, /LIVE_MICRO_CACHE_MS = 2_000/);
  assert.match(lotteryRoute, /Promise\.race\(\[historyRequest, progressRequest\]\)/);
  assert.match(lotteryRoute, /fetchMarksixProgress/);
  assert.match(lotteryRoute, /progressToDraw/);
  assert.match(lotteryRoute, /isDrawForTarget/);
  assert.match(lotteryRoute, /高频检测已开启/);
  assert.match(lotteryRoute, /已获取本期完整结果/);
  assert.doesNotMatch(lotteryRoute, /settleLatestResearch/);
  assert.doesNotMatch(lotteryRoute, /settleResearchForecasts/);
  assert.doesNotMatch(lotteryRoute, /最新一期为 12·11·31·03·44·37 \+ 25/);
  assert.match(analyzeRoute, /AI_API_KEY/);
  assert.match(analyzeRoute, /\/responses/);
  assert.match(analyzeRoute, /json_schema/);
  assert.match(analyzeRoute, /safety_identifier/);
  assert.match(analyzeRoute, /store: false/);
  assert.match(analyzeRoute, /isSafeModelText/);
  assert.match(analyzeRoute, /forecast-engine-v6\.0/);
  assert.match(analyzeRoute, /evidence-synthesis-v6/);
  assert.match(
    analyzeRoute,
    /loadServerDraws\(\s*game,\s*MAX_HISTORY_DRAWS,\s*analysisCutoff,\s*\)/,
  );
  assert.match(analyzeRoute, /zodiacObservation: pack\.zodiacObservation/);
  assert.match(analyzeRoute, /lockCanonicalZodiacObservation/);
  assert.match(analyzeRoute, /applyCanonicalZodiacObservation/);
  assert.match(analyzeRoute, /persistenceEligible: qualityGate\.eligible/);
  assert.match(analyzeRoute, /readForecastSnapshot/);
  assert.match(analyzeRoute, /readLatestRestorableForecast/);
  assert.match(analyzeRoute, /buildLearningStateFingerprint\(pack\.learning\)/);
  assert.match(analyzeRoute, /learningStateFingerprint/);
  assert.match(analyzeRoute, /learningReview/);
  assert.match(analyzeRoute, /const activeAfterGate = inflightReports\.get\(cacheKey\)/);
  assert.match(analyzeRoute, /appliesTo: "next_report"/);
  assert.match(analyzeRoute, /readSettledForecastLearningState/);
  assert.match(analyzeRoute, /sourceStatus: learningState\.sourceStatus/);
  assert.match(analyzeRoute, /if \(settlementStatus !== "ok"\)/);
  assert.match(
    analyzeRoute,
    /onlineLearningInput\.sourceStatus = "unavailable"/,
  );
  assert.match(
    analyzeRoute,
    /if \(qualityGate\.targetConfirmed\) \{\s*const persisted = await readForecastSnapshot/,
  );
  assert.ok(
    analyzeRoute.indexOf("const persisted = await readForecastSnapshot") <
      analyzeRoute.indexOf(
        "const rate = await consumeAiRateLimit(safetyIdentifier)",
      ),
  );
  assert.equal(
    (analyzeRoute.match(/max_output_tokens:\s*3_600/g) ?? []).length,
    1,
  );
  assert.match(analyzeRoute, /不能改变服务器决策、概率、证据等级或生肖观察方向/);
  assert.doesNotMatch(analyzeRoute, /request\.headers\.get\("user-agent"\)/);
  assert.match(aiEngine, /buildWalkForwardBacktest/);
  assert.match(aiEngine, /noLookahead: true/);
  assert.match(aiTypes, /schemaVersion: "5"/);
  assert.match(aiTypes, /nested_holdout_walk_forward/);
  assert.match(aiTypes, /correction: "bonferroni"/);
  assert.match(aiTypes, /averageMainOverlapCI/);
  assert.match(aiTypes, /specialZodiacBaseline/);
  assert.match(aiTypes, /evidence_strength_not_win_probability/);
  assert.match(aiRateLimit, /limitReached\(db, globalKey/);
  assert.match(aiRateLimit, /WHERE ai_rate_limits\.count < \?/);
  assert.match(aiRateLimit, /return denied\(now \+ 60_000, now\)/);
  assert.match(aiLedger, /INSERT OR IGNORE INTO ai_primary_observation_locks/);
  assert.match(aiLedger, /readForecastSnapshot/);
  assert.match(aiLedger, /readLatestRestorableForecast/);
  assert.match(aiLedger, /json_extract\(response_json, '\$\.mode'\) = 'ai'/);
  assert.match(aiLedger, /generation_degraded/);
  assert.match(aiLedger, /quality_gate_failed/);
  assert.match(aiLedger, /ORDER BY locked_at ASC, lock_id ASC/);
  assert.match(aiOnlineLearning, /ROW_NUMBER\(\) OVER/);
  assert.match(aiOnlineLearning, /sample\.actual\.issue === sample\.targetIssue/);
  assert.match(aiOnlineLearning, /settledTime <= asOfTime/);
  assert.match(aiOnlineLearning, /minimumTargetIssues: 12/);
  assert.match(aiOnlineLearning, /maximumAdjustment: 0\.06/);
  assert.match(aiOnlineLearning, /在线学习不参与历史 walk-forward 重算/);
  assert.match(primaryLockMigration, /CREATE TABLE `ai_primary_observation_locks`/);
  assert.match(primaryLockMigration, /ai_primary_observation_identity_idx/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og-v3.png", import.meta.url));
  await access(new URL("../lib/lottery.ts", import.meta.url));
  await access(templateRoot);
});

test("retired Macau feed is not exposed by the public lottery endpoint", async () => {
  const response = await fetchWorker("/api/lottery?game=macau");
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(payload.error, /仅支持香港与新澳门/);
});

test("AI report restore endpoint returns no content when no saved ledger is bound", async () => {
  const response = await fetchWorker("/api/analyze?game=new_macau", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(await response.text(), "");
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

test("AI endpoint returns a server-locked scientific abstention on stale snapshot data", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      url.startsWith("https://api.api16868.com/") ||
      url.startsWith("https://api3.marksix6.net/")
    ) {
      return new Response("upstream unavailable", { status: 503 });
    }
    return originalFetch(input, init);
  };

  try {
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
        depth: "standard",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const payload = await response.json();
    assert.equal(payload.schemaVersion, "5");
    assert.equal(payload.research.mode, "shadow");
    assert.ok(Array.isArray(payload.research.targetForecasts));
    assert.equal(payload.dataQuality.sourceMode, "snapshot");
    assert.equal(payload.decision.kind, "abstain");
    assert.equal(payload.decision.scenarioId, null);
    assert.equal(payload.synthesis.recommendedScenarioId, null);
    assert.equal(
      payload.zodiacObservation.kind,
      "zodiac_coverage_6_plus_1",
    );
    assert.match(
      payload.zodiacObservation.zodiac,
      /^[鼠牛虎兔龙蛇马羊猴鸡狗猪]$/,
    );
    assert.equal(
      payload.zodiacObservation.target,
      "当期 6+1 至少出现 1 个该生肖",
    );
    assert.equal(
      payload.zodiacObservation.configuration.userSelectable,
      false,
    );
    assert.equal(payload.backtest.method, "nested_holdout_walk_forward");
    assert.equal(payload.backtest.correction, "bonferroni");
    assert.equal(payload.backtest.multipleComparisonCount, 40);
    assert.ok(payload.backtest.selectionCount >= 20);
    assert.ok(payload.backtest.holdoutCount >= 20);
    assert.equal(payload.ledger.state, "skipped");
    assert.equal(payload.ledger.reason, "target_unconfirmed");
    assert.equal(payload.candidateSets.length, 3);
    for (const candidate of payload.candidateSets) {
      assert.equal(candidate.numbers.length, 6);
      assert.equal(new Set(candidate.numbers).size, 6);
      assert.ok(!candidate.numbers.includes(candidate.special));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = originalApiKey;
  }
});

test("model output cannot override the server abstention decision", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = {
    AI_API_KEY: process.env.AI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_MODEL: process.env.AI_MODEL,
  };
  process.env.AI_API_KEY = "test-only-key";
  process.env.AI_BASE_URL = "https://mock.openai.test/v1";
  process.env.AI_MODEL = "mock-override-attempt";
  globalThis.fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (
      url.startsWith("https://api.api16868.com/") ||
      url.startsWith("https://api3.marksix6.net/")
    ) {
      return new Response("upstream unavailable", { status: 503 });
    }
    if (url === "https://mock.openai.test/v1/responses") {
      const requestBody = JSON.parse(String(init?.body ?? "{}"));
      const analysisPack = JSON.parse(requestBody.input);
      const attemptedOverride = {
        headline: "证据归纳完成",
        executiveSummary: "当前证据不足，但模型试图改写服务器决定。",
        recommendedScenarioId: "balanced",
        recommendationReason: "模型自行选择场景。",
        uncertainty: "随机性仍是主导，历史结构不能决定未来结果。",
        strongestSignals: [
          "样本结构存在局部集中",
          "不同维度方向并不完全一致",
          "留出结果未支持优势结论",
        ],
        conflictingSignals: [
          "历史波动可能来自随机噪声",
          "数据来源仍需持续核验",
        ],
        dimensionInsights: analysisPack.dimensions.map((dimension) => ({
          id: dimension.id,
          summary: "该维度存在样本波动。",
          counterpoint: "波动不足以构成预测保证。",
          evidenceIds: [dimension.metrics[0].id],
        })),
      };
      return Response.json({
        id: "mock-response",
        model: "mock-override-attempt",
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify(attemptedOverride),
              },
            ],
          },
        ],
      });
    }
    return originalFetch(input, init);
  };

  try {
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
        depth: "standard",
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.decision.kind, "abstain");
    assert.equal(payload.decision.scenarioId, null);
    assert.equal(payload.synthesis.recommendedScenarioId, null);
    assert.equal(
      payload.zodiacObservation.kind,
      "zodiac_coverage_6_plus_1",
    );
    assert.match(
      payload.zodiacObservation.zodiac,
      /^[鼠牛虎兔龙蛇马羊猴鸡狗猪]$/,
    );
    assert.equal(payload.mode, "statistical");
    assert.equal(payload.fallbackReason, "invalid_output");
    assert.equal(payload.candidateSets.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
