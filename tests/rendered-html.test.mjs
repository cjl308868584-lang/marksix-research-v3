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
  assert.match(html, /<title>六合智研｜香港与新澳门开奖及 AI 预测研究<\/title>/i);
  assert.match(html, /让每一期数据/);
  assert.match(html, /北京时间/);
  assert.match(html, /香港六合彩/);
  assert.match(html, /新澳门六合彩/);
  assert.doesNotMatch(html, />澳门</);
  assert.match(html, /号码 12，羊，红波/);
  assert.match(html, /特码 25，马，蓝波/);
  assert.doesNotMatch(html, /[鼠牛虎兔龙蛇马羊猴鸡狗猪]肖/);
  assert.match(html, /AI 6\+1 多维观察实验室/);
  assert.match(html, /每个方向独立回测/);
  assert.match(html, /6\+1 生肖观察/);
  assert.match(html, /三路候选策略/);
  assert.match(html, /6\+1 生肖观察/);
  assert.match(html, /三路策略共识与冲突/);
  assert.match(html, /正码命中/);
  assert.match(html, /九维证据/);
  assert.match(html, /滚动回测/);
  assert.match(html, /历史开奖记录/);
  assert.match(html, /不构成投注建议/);
  assert.doesNotMatch(html, /codex-preview|Building your site|Your site is taking shape/i);
});

test("keeps the product implementation free of starter preview artifacts", async () => {
  const [page, layout, dashboard, styles, packageJson, lotteryLib, lotteryRoute, analyzeRoute, aiEngine, aiTypes, aiRateLimit, aiLedger, primaryLockMigration] = await Promise.all([
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
    readFile(new URL("../lib/ai-forecast-ledger.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0002_brief_thanos.sql", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<LotteryDashboard \/>/);
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
  assert.match(dashboard, /AI_FOCUS_OPTIONS/);
  assert.match(dashboard, /AiEvidenceSection/);
  assert.match(dashboard, /scientific-verdict/);
  assert.match(dashboard, /统计校准状态/);
  assert.match(dashboard, /结构观察 · 未证实优势/);
  assert.match(dashboard, /PrimaryZodiacObservation/);
  assert.match(dashboard, /ObservationDeck/);
  assert.match(dashboard, /ObservationConsensus/);
  assert.match(dashboard, /observationHit/);
  assert.match(dashboard, /report\.backtest\.decision === "recommend"/);
  assert.match(dashboard, /scientificReport\.decision\.kind === "observe"/);
  assert.match(dashboard, /ledgerStatusLabel/);
  assert.match(dashboard, /已锁定 · 不可篡改/);
  assert.match(dashboard, /全量前瞻复核/);
  assert.match(dashboard, /系统不会只挑命中期展示/);
  assert.match(dashboard, /String\(payload\.schemaVersion\) !== "4"/);
  assert.match(dashboard, /嵌套走步 · 独立留出验证/);
  assert.match(dashboard, /selectionCount/);
  assert.match(dashboard, /holdoutCount/);
  assert.match(dashboard, /multipleComparisonCount/);
  assert.match(dashboard, /Bonferroni/);
  assert.match(dashboard, /averageMainOverlapCI/);
  assert.match(dashboard, /anyMainOverlapCount/);
  assert.match(dashboard, /specialExactCount/);
  assert.match(dashboard, /specialExactCI/);
  assert.match(dashboard, /zodiacObservation/);
  assert.match(dashboard, /strategy\.observations/);
  assert.match(dashboard, /observationComparisonCount/);
  assert.match(dashboard, /configuration\.trainWindow/);
  assert.match(dashboard, /dataQuality\.verifiedRatio/);
  assert.match(dashboard, /report\.model\.name/);
  assert.doesNotMatch(dashboard, /GPT‑5\.6/);
  assert.match(dashboard, /ai-recommendation-balls/);
  assert.match(dashboard, /diversity-strip/);
  assert.match(dashboard, /uniqueMainNumbers/);
  assert.match(dashboard, /maxMainOverlap/);
  assert.match(dashboard, /averageJaccard/);
  assert.match(dashboard, /strategy-review-result/);
  assert.match(dashboard, /特码号码/);
  assert.match(dashboard, /6\+1 生肖命中/);
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
  assert.match(styles, /\.draw-card > \.ball-row \.special-item \.ball[\s\S]*width: 58px/);
  assert.match(styles, /\.strategy-card > \.ball-row\.compact \.ball[\s\S]*width: min\(46px, 100%\)/);
  assert.match(styles, /\.scratch-reward \.stage-ball[\s\S]*width: 72px/);
  assert.match(styles, /\.number-cell\.number-wave-red[\s\S]*--number-wave: var\(--red\)/);
  assert.match(styles, /\.number-cell\.number-wave-blue[\s\S]*--number-wave: var\(--blue\)/);
  assert.match(styles, /\.number-cell\.number-wave-green[\s\S]*--number-wave: var\(--green\)/);
  assert.match(styles, /\.ai-processing p[\s\S]*transform: none/);
  assert.match(styles, /\.scientific-calibration/);
  assert.match(styles, /\.scientific-verdict/);
  assert.match(styles, /\.primary-zodiac-observation/);
  assert.match(styles, /\.observation-scroll/);
  assert.match(styles, /\.observation-consensus/);
  assert.match(styles, /\.strategy-observation-review/);
  assert.match(styles, /\.forward-ledger-summary/);
  assert.match(styles, /\.calibration-metrics/);
  assert.match(styles, /\.diversity-strip/);
  assert.match(styles, /\.backtest-strategy-list/);
  assert.match(styles, /\.calibration-metrics span,[\s\S]*font-size: 11px/);
  assert.match(styles, /\.strategy-card:not\(\.active\)[\s\S]*display: block/);
  assert.match(styles, /\.strategy-grid[\s\S]*scroll-snap-type: x mandatory/);
  assert.match(styles, /\.topbar[\s\S]*position: sticky/);
  assert.match(styles, /\.mobile-nav a[\s\S]*min-height: 52px/);
  assert.match(styles, /max-width: 370px/);
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
  assert.doesNotMatch(lotteryRoute, /最新一期为 12·11·31·03·44·37 \+ 25/);
  assert.match(analyzeRoute, /AI_API_KEY/);
  assert.match(analyzeRoute, /\/responses/);
  assert.match(analyzeRoute, /json_schema/);
  assert.match(analyzeRoute, /safety_identifier/);
  assert.match(analyzeRoute, /store: false/);
  assert.match(analyzeRoute, /isSafeModelText/);
  assert.match(analyzeRoute, /forecast-engine-v4\.0/);
  assert.match(analyzeRoute, /evidence-synthesis-v4/);
  assert.match(
    analyzeRoute,
    /loadServerDraws\(\s*game,\s*MAX_HISTORY_DRAWS,\s*analysisCutoff,\s*\)/,
  );
  assert.match(analyzeRoute, /zodiacObservation: pack\.zodiacObservation/);
  assert.match(analyzeRoute, /lockCanonicalZodiacObservation/);
  assert.match(analyzeRoute, /applyCanonicalZodiacObservation/);
  assert.match(analyzeRoute, /persistenceEligible: qualityGate\.eligible/);
  assert.match(analyzeRoute, /不能改变服务器决策或生肖观察方向/);
  assert.doesNotMatch(analyzeRoute, /request\.headers\.get\("user-agent"\)/);
  assert.match(aiEngine, /buildWalkForwardBacktest/);
  assert.match(aiEngine, /noLookahead: true/);
  assert.match(aiTypes, /schemaVersion: "4"/);
  assert.match(aiTypes, /nested_holdout_walk_forward/);
  assert.match(aiTypes, /correction: "bonferroni"/);
  assert.match(aiTypes, /averageMainOverlapCI/);
  assert.match(aiTypes, /specialZodiacBaseline/);
  assert.match(aiTypes, /evidence_strength_not_win_probability/);
  assert.match(aiRateLimit, /limitReached\(db, globalKey/);
  assert.match(aiRateLimit, /WHERE ai_rate_limits\.count < \?/);
  assert.match(aiRateLimit, /return denied\(now \+ 60_000, now\)/);
  assert.match(aiLedger, /INSERT OR IGNORE INTO ai_primary_observation_locks/);
  assert.match(aiLedger, /ORDER BY locked_at DESC, lock_id DESC/);
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
    assert.equal(payload.schemaVersion, "4");
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
