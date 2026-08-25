import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery.ts";
import type {
  RollingPatternEvent,
  RollingPatternProduct,
  RollingPatternReviewScore,
  RollingPatternReviewSnapshot,
  RollingPatternRun,
  RollingPatternSignal,
} from "../lib/rolling-pattern-types.ts";
import { buildRollingPatternProducts } from "../lib/rolling-pattern-value.ts";
import { getZodiac } from "../lib/zodiac.ts";

const DRAW_AT = "2026-08-25T21:32:00+08:00";
let server: ViteDevServer;
let buildRollingPatternReviewSnapshot: (
  run: RollingPatternRun,
  products: readonly RollingPatternProduct[],
) => RollingPatternReviewSnapshot;
let settleRollingPatternReviewSnapshot: (
  snapshot: RollingPatternReviewSnapshot,
  draw: Draw,
  scoredAt: string,
) => RollingPatternReviewScore;

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const module = await server.ssrLoadModule("/lib/rolling-pattern-review.ts") as {
    buildRollingPatternReviewSnapshot: typeof buildRollingPatternReviewSnapshot;
    settleRollingPatternReviewSnapshot: typeof settleRollingPatternReviewSnapshot;
  };
  buildRollingPatternReviewSnapshot = module.buildRollingPatternReviewSnapshot;
  settleRollingPatternReviewSnapshot = module.settleRollingPatternReviewSnapshot;
});

after(async () => {
  await server.close();
});

test("freezes five purchases, both result scopes and the special-number top 15", () => {
  const frozenRun = run([
    signal(event("coverage_6_plus_1", "zodiac", "猴"), "coverage-monkey"),
    signal(event("coverage_6_plus_1", "zodiac", "马"), "coverage-horse"),
    signal(event("coverage_6_plus_1", "zodiac", "狗"), "coverage-dog"),
    signal(event("coverage_6_plus_1", "tail", "8尾"), "coverage-tail"),
    signal(event("special", "head", "0头"), "special-head", 10, 8),
    signal(event("special", "wave", "蓝波"), "special-wave", 10, 7),
  ]);

  const snapshot = buildRollingPatternReviewSnapshot(
    frozenRun,
    buildRollingPatternProducts(frozenRun),
  );

  assert.equal(snapshot.purchases.length, 5);
  assert.deepEqual(snapshot.purchases.map((item) => item.kind), [
    "coverage_zodiac",
    "coverage_tail",
    "coverage_zodiac_pair",
    "coverage_zodiac_triple",
    "special_number",
  ]);
  assert.deepEqual(
    snapshot.coverage.resultGroups.map((item) => item.summary.label),
    ["8尾", "狗", "猴", "马"],
  );
  assert.deepEqual(
    snapshot.special.resultGroups.map((item) => item.summary.label),
    ["0头", "蓝波"],
  );
  assert.deepEqual(snapshot.specialNumbers.slice(0, 3).map((item) => item.number), [3, 4, 9]);
  assert.deepEqual(
    snapshot.specialNumbers[0].evidence.map((item) => item.label),
    ["0头", "蓝波"],
  );
  assert.equal(snapshot.targetIssue, "2026238");
  assert.equal(snapshot.frozenAt, "2026-08-24T14:27:00.000Z");
});

test("settles every frozen section from one verified draw", () => {
  const frozenRun = run([
    signal(event("coverage_6_plus_1", "zodiac", "猴"), "coverage-monkey"),
    signal(event("coverage_6_plus_1", "zodiac", "马"), "coverage-horse"),
    signal(event("coverage_6_plus_1", "zodiac", "狗"), "coverage-dog"),
    signal(event("coverage_6_plus_1", "tail", "8尾"), "coverage-tail"),
    signal(event("special", "head", "0头"), "special-head", 10, 8),
    signal(event("special", "wave", "蓝波"), "special-wave", 10, 7),
  ]);
  const snapshot = buildRollingPatternReviewSnapshot(
    frozenRun,
    buildRollingPatternProducts(frozenRun),
  );
  const monkey = findZodiacNumber("猴");
  const horse = findZodiacNumber("马");
  const verifiedDraw: Draw = {
    game: "new_macau",
    issue: "2026238",
    drawAt: DRAW_AT,
    numbers: [monkey, horse, 18, 28, 38, 48],
    special: 3,
    source: "fixture",
    verified: true,
  };

  const score = settleRollingPatternReviewSnapshot(
    snapshot,
    verifiedDraw,
    "2026-08-25T14:00:00.000Z",
  );

  assert.equal(score.actualSpecial, 3);
  assert.deepEqual(score.actualNumbers, [...verifiedDraw.numbers, verifiedDraw.special]);
  assert.equal(score.purchases.length, 5);
  assert.equal(score.coverageResults.find((item) => item.eventId.includes("tail:8尾"))?.actualMatched, true);
  assert.equal(score.specialResults.find((item) => item.eventId.includes("head:0头"))?.actualMatched, true);
  assert.equal(score.specialResults.find((item) => item.eventId.includes("wave:蓝波"))?.actualMatched, true);
  assert.deepEqual(
    score.specialNumbers.slice(0, 3).map((item) => [item.number, item.actualMatched]),
    [[3, true], [4, false], [9, false]],
  );
});

test("rejects an unverified or mismatched draw", () => {
  const frozenRun = run([
    signal(event("coverage_6_plus_1", "zodiac", "猴"), "coverage-monkey"),
    signal(event("coverage_6_plus_1", "zodiac", "马"), "coverage-horse"),
    signal(event("coverage_6_plus_1", "zodiac", "狗"), "coverage-dog"),
    signal(event("coverage_6_plus_1", "tail", "8尾"), "coverage-tail"),
    signal(event("special", "head", "0头"), "special-head"),
  ]);
  const snapshot = buildRollingPatternReviewSnapshot(
    frozenRun,
    buildRollingPatternProducts(frozenRun),
  );
  const base: Draw = {
    game: "new_macau",
    issue: "2026238",
    drawAt: DRAW_AT,
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "fixture",
    verified: false,
  };

  assert.throws(
    () => settleRollingPatternReviewSnapshot(snapshot, base, "2026-08-25T14:00:00.000Z"),
    /已核验/,
  );
  assert.throws(
    () => settleRollingPatternReviewSnapshot(
      snapshot,
      { ...base, verified: true, issue: "2026239" },
      "2026-08-25T14:00:00.000Z",
    ),
    /目标期/,
  );
});

function event(
  scope: "coverage_6_plus_1" | "special",
  family: RollingPatternEvent["family"],
  value: string,
): RollingPatternEvent {
  return {
    eventId: `${scope}:${family}:${value}:gte1`,
    scope,
    family,
    value,
    label: scope === "special" ? `下一期的特码为${value}` : `下一期6+1至少出现一次${value}`,
    threshold: 1,
    memberCount: family === "head" ? 9 : family === "wave" ? 16 : 4,
  };
}

function signal(
  result: RollingPatternEvent,
  ruleId: string,
  support = 10,
  hits = 7,
): RollingPatternSignal {
  return {
    rule: {
      ruleId,
      family: "single_transfer",
      antecedent: {
        kind: "single",
        conditions: [{
          event: {
            eventId: "condition:tail:1尾:gte1",
            scope: "condition",
            family: "tail",
            value: "1尾",
            label: "6+1至少出现一次1尾",
            threshold: 1,
            memberCount: 5,
          },
          expectedMatched: true,
        }],
      },
      event: result,
      prediction: true,
      canonicalJson: ruleId,
      conditionLabel: "本期条件成立",
      predictionLabel: result.label,
      relationLabel: `条件 → ${result.value}`,
      description: "fixture",
    },
    currentTriggered: true,
    support,
    hits,
    rawRate: hits / support,
    baseline: result.scope === "special" ? result.memberCount / 49 : 0.472,
    rawUplift: hits / support - 0.472,
    posteriorRate: hits / support,
    posteriorUplift: hits / support - 0.472,
    pValue: 0.01,
    qValue: 1,
    evidenceTier: "experimental",
    sampleLabel: "有限样本",
    relatedRuleCount: 1,
    currentEvidence: [],
    stateHistory: [],
    audit: Array.from({ length: support }, (_, index) => ({
      sourceIssue: String(2026200 + index),
      targetIssue: String(2026201 + index),
      targetDrawAt: DRAW_AT,
      conditionEvidence: [],
      result: {
        issue: String(2026201 + index),
        drawAt: DRAW_AT,
        matched: index < hits,
        count: index < hits ? 1 : 0,
      },
      matched: index < hits,
    })),
  };
}

function run(signals: RollingPatternSignal[]): RollingPatternRun {
  return {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: "review-run-2026238",
    game: "new_macau",
    sourceIssue: "2026237",
    targetIssue: "2026238",
    expectedDrawAt: DRAW_AT,
    generatedAt: "2026-08-24T14:27:00.000Z",
    frozenAt: "2026-08-24T14:27:00.000Z",
    status: "completed",
    window: {
      game: "new_macau",
      drawCount: 30,
      oldestIssue: "2026208",
      newestIssue: "2026237",
      dataHash: "review-fixture",
    },
    funnel: { generated: 6, currentTriggered: 6, deduplicated: 6, aboveBaseline: 6, qualified: 6 },
    scopeFunnels: {
      coverage_6_plus_1: { generated: 4, currentTriggered: 4, deduplicated: 4, aboveBaseline: 4, qualified: 4 },
      special: { generated: 2, currentTriggered: 2, deduplicated: 2, aboveBaseline: 2, qualified: 2 },
    },
    signals,
  };
}

function findZodiacNumber(zodiac: string) {
  const number = Array.from({ length: 49 }, (_, index) => index + 1)
    .find((candidate) => getZodiac(candidate, DRAW_AT) === zodiac);
  assert.ok(number);
  return number;
}
