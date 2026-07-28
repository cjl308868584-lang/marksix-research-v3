import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let buildResearchReview: (snapshot: unknown, draw: unknown, settledAt: string) => {
  availableRuleCount: number;
  positiveHits: number;
  negativeAvoided: number;
  directionalCorrect: number;
  directionalSuccessRate: number;
  passedRuleCount: number;
  passedRuleCorrect: number;
  rules: Array<{
    ruleId: string;
    prediction: string;
    actualValue: string;
    actualNumber: number;
    outcome: string;
    directionCorrect: boolean;
  }>;
};

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const module = await server.ssrLoadModule("/lib/research-review.ts") as {
    buildResearchReview: typeof buildResearchReview;
  };
  buildResearchReview = module.buildResearchReview;
});

after(async () => {
  await server.close();
});

test("settles every frozen positive and negative rule against the verified draw", () => {
  const snapshot = {
    schemaVersion: "1",
    engineVersion: "research-v2.1",
    ruleEngineVersion: "rule-dsl-v1",
    modelVersion: "dual-track-shadow-v2",
    runId: "review-run-1",
    game: "new_macau",
    targetIssue: "2026209",
    expectedDrawAt: "2026-07-28T13:32:00.000Z",
    generatedAt: "2026-07-27T13:00:00.000Z",
    mode: "shadow",
    evidenceTier: "experimental",
    dataQuality: {},
    targetForecasts: [],
    verifiedRules: [],
    experimentalRules: [
      mockRule("positive-tail", "main.position.2", "tail", "4尾", "positive", true),
      mockRule("positive-parity", "main.position.2", "parity", "单", "positive"),
    ],
    negativeRules: [
      mockRule("negative-zone", "special", "zone", "一区", "negative"),
      mockRule("negative-tail", "special", "tail", "5尾", "negative"),
    ],
    archivedRuleCount: 0,
    generatedRuleCount: 4,
    fullBacktestRuleCount: 4,
    resourceReductionRate: 0,
    modelComparison: [],
    previousForecastDelta: {
      comparable: false,
      largestChanges: [],
      summary: "",
    },
    postmortem: null,
    notice: "",
  };
  const draw = {
    game: "new_macau",
    issue: "2026209",
    drawAt: "2026-07-28T13:32:00.000Z",
    numbers: [1, 24, 3, 4, 5, 6],
    special: 45,
    source: "双源核验",
    verified: true,
  };
  const review = buildResearchReview(
    snapshot,
    draw,
    "2026-07-28T13:35:00.000Z",
  );

  assert.equal(review.availableRuleCount, 4);
  assert.equal(review.positiveHits, 1);
  assert.equal(review.negativeAvoided, 1);
  assert.equal(review.directionalCorrect, 2);
  assert.equal(review.directionalSuccessRate, 0.5);
  assert.equal(review.passedRuleCount, 1);
  assert.equal(review.passedRuleCorrect, 1);
  assert.deepEqual(
    review.rules.map((rule) => [rule.ruleId, rule.outcome]),
    [
      ["positive-tail", "positive_hit"],
      ["positive-parity", "positive_miss"],
      ["negative-zone", "negative_avoided"],
      ["negative-tail", "negative_failed"],
    ],
  );
  assert.deepEqual(
    review.rules.map((rule) => [rule.prediction, rule.actualValue, rule.actualNumber]),
    [
      ["4尾", "4尾", 24],
      ["单", "双", 24],
      ["一区", "三区", 45],
      ["5尾", "5尾", 45],
    ],
  );
});

function mockRule(
  ruleId: string,
  scope: "special" | `main.position.${1 | 2 | 3 | 4 | 5 | 6}`,
  targetFamily: "tail" | "parity" | "zone",
  prediction: string,
  direction: "positive" | "negative",
  passed = false,
) {
  return {
    ruleId,
    family: "position_transfer",
    description: `${scope} ${targetFamily} ${prediction}`,
    direction,
    tier: "experimental",
    targetId: `${scope}.${targetFamily}`,
    support: 120,
    hits: direction === "positive" ? 45 : 15,
    hitRate: direction === "positive" ? 0.375 : 0.125,
    baselineRate: targetFamily === "parity" ? 25 / 49 : 5 / 49,
    shrunkenRate: direction === "positive" ? 0.35 : 0.14,
    lift: direction === "positive" ? 0.08 : -0.08,
    brierSkill: 0.04,
    nonWorseFoldRatio: passed ? 0.8 : 0.6,
    pValue: 0.01,
    qValue: passed ? 0.08 : 0.16,
    stabilityScore: 0.9,
    currentPrediction: prediction,
    currentTriggerMatched: true,
    resourceDecision: direction === "positive" ? "full_backtest" : "negative_pool",
    spec: {
      schemaVersion: 1,
      family: "position_transfer",
      target: { scope, family: targetFamily },
      source: {
        field: "main.1",
        lag: 1,
        family: targetFamily,
        transform: "identity",
      },
      predicates: [],
    },
  };
}
