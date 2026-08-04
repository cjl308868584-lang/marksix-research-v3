import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";

type Draw = {
  game: "new_macau";
  issue: string;
  drawAt: string;
  numbers: number[];
  special: number;
  source: string;
  verified: boolean;
};

let server: ViteDevServer;
let buildSnapshot: (input: {
  game: "new_macau";
  draws: Draw[];
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt: string;
  ruleStates?: Record<string, Record<string, unknown>>;
  researchArtifact?: Record<string, unknown>;
  formalChampion?: "baseline" | "interpretable_rules" | "logistic" | "black_box" | null;
}) => any;
let baseline: (
  scope: string,
  family: string,
  value: string,
  drawAt: string,
) => number;
let buildReview: (snapshot: any, draw: Draw, settledAt: string, decision?: any) => any;
let buildPerformance: (game: "new_macau", reviews: any[]) => any;
let zodiacFor: (number: number, drawAt: string) => string;
let cycleAction: (
  latestVerified: boolean,
  hasFrozenSnapshot: boolean,
) => "compute" | "await_verification" | "bootstrap";

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const engine = await server.ssrLoadModule("/lib/research-v3-engine.ts") as any;
  const review = await server.ssrLoadModule("/lib/research-v3-review.ts") as any;
  const lottery = await server.ssrLoadModule("/lib/lottery.ts") as any;
  buildSnapshot = engine.buildResearchV3Snapshot;
  baseline = engine.exactEventBaseline;
  buildReview = review.buildResearchV3Review;
  buildPerformance = review.buildResearchV3Performance;
  zodiacFor = lottery.getZodiac;
  cycleAction = engine.researchCycleAction;
});

test("a new database bootstraps a baseline forecast without learning from an unverified latest draw", () => {
  assert.equal(cycleAction(false, false), "bootstrap");
  assert.equal(cycleAction(false, true), "await_verification");
  assert.equal(cycleAction(true, false), "compute");
});

after(async () => {
  await server.close();
});

test("v3 freezes exactly four high-probability events and never predicts numbers", () => {
  const draws = makeHistory(160);
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws,
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  assert.equal(snapshot.schemaVersion, "3");
  assert.deepEqual(
    snapshot.events.map((event: any) => event.slot),
    [
      "zodiac_6_plus_1",
      "tail_6_plus_1",
      "position_parity",
      "position_size",
    ],
  );
  for (const event of snapshot.events) {
    assert.ok(event.probability >= 0.4 && event.probability <= 0.7);
    assert.ok(
      event.baselineProbability >= 0.4 &&
        event.baselineProbability <= 0.7,
    );
    assert.ok(event.probability >= event.baselineProbability);
    assert.ok(event.uplift >= 0);
    assert.notEqual(event.family, "number");
    assert.doesNotMatch(event.predictionLabel, /候选号码|最高交集号码|号码前三/);
    assert.equal(event.experts.length, 4);
  }
});

test("shadow experts remain diagnostic and cannot change the formal probability", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  assert.equal(snapshot.mode, "shadow");
  assert.ok(
    snapshot.events.some((event: any) =>
      Math.abs(event.experimentalProbability - event.baselineProbability) > 1e-9
    ),
    "fixture must contain a non-baseline shadow estimate",
  );
  for (const event of snapshot.events) {
    assert.equal(event.probability, event.baselineProbability);
    assert.equal(event.uplift, 0);
  }
});

test("persisted formal champion evidence makes verified mode reachable", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
    formalChampion: "interpretable_rules",
  });
  assert.equal(snapshot.mode, "formal");
  assert.ok(snapshot.events.every((event: any) => event.evidenceTier === "verified"));
  assert.ok(snapshot.events.every((event: any) => event.probability === event.experts.find((expert: any) => expert.modelId === "interpretable_rules").probability));
});

test("reported model history comes only from outer walk-forward selection rows", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  for (const event of snapshot.events) {
    assert.equal(event.history.sampleSize, 30);
    assert.ok(event.history.hits <= event.history.sampleSize);
    assert.ok(event.history.expectedHits > 0);
  }
});

test("coverage and position baselines use exact without-replacement probabilities", () => {
  const drawAt = "2026-10-01T21:32:32+08:00";
  const zodiac = baseline("draw.6_plus_1", "zodiac", "鼠", drawAt);
  const tail4 = baseline("draw.6_plus_1", "tail", "4尾", drawAt);
  const odd = baseline("main.position.3", "parity", "单", drawAt);
  const big = baseline("special", "size", "大", drawAt);
  assert.ok(zodiac > 0.47 && zodiac < 0.56);
  assert.ok(tail4 > 0.47 && tail4 < 0.56);
  assert.ok(Math.abs(odd - 25 / 49) < 1e-9);
  assert.ok(Math.abs(big - 25 / 49) < 1e-9);
});

test("unverified history never changes a frozen production forecast", () => {
  const verified = makeHistory(160).map((draw) => ({ ...draw, verified: true }));
  const input = {
    game: "new_macau" as const,
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  };
  const before = buildSnapshot({ ...input, draws: verified });
  const poisoned = verified.concat({
    ...verified.at(-1)!,
    issue: "2026998",
    drawAt: "2026-09-29T21:32:32+08:00",
    numbers: [49, 48, 47, 46, 45, 44],
    special: 43,
    source: "单源未核验测试",
    verified: false,
  });
  const after = buildSnapshot({ ...input, draws: poisoned });
  assert.deepEqual(after.events, before.events);
  assert.equal(after.dataQuality.sampleSize, before.dataQuality.sampleSize);
});

test("verified settlement scores frozen events before updating weights", () => {
  const draws = makeHistory(160);
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws,
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  const draw: Draw = {
    game: "new_macau",
    issue: "2026999",
    drawAt: "2026-10-01T21:32:32+08:00",
    numbers: [1, 12, 23, 34, 45, 49],
    special: 8,
    source: "双源一致测试",
    verified: true,
  };
  const review = buildReview(
    snapshot,
    draw,
    "2026-10-01T21:35:00+08:00",
  );
  assert.equal(review.events.length, 4);
  assert.equal(review.total, 4);
  assert.ok(review.hits >= 0 && review.hits <= 4);
  for (const event of review.events) {
    const before = Object.fromEntries(
      event.modelWeightsBefore.map((item: any) => [item.modelId, item.weight]),
    );
    const after = Object.fromEntries(
      event.modelWeightsAfter.map((item: any) => [item.modelId, item.weight]),
    );
    assert.ok(after.baseline >= 0.25);
    assert.ok(
      event.modelWeightsAfter.every((item: any) => item.weight <= 0.5 + 1e-9),
    );
    for (const id of Object.keys(before)) {
      assert.ok(Math.abs(after[id] - before[id]) <= 0.100001);
    }
    assert.ok(Number.isFinite(event.brier));
    assert.ok(Number.isFinite(event.logLoss));
  }
});

test("learning review records a validated champion promotion", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  const draw: Draw = {
    game: "new_macau",
    issue: "2026999",
    drawAt: "2026-10-01T21:32:32+08:00",
    numbers: [1, 12, 23, 34, 45, 49],
    special: 8,
    source: "双源一致测试",
    verified: true,
  };
  const review = buildReview(snapshot, draw, "2026-10-01T21:35:00+08:00", {
    champion: "logistic",
    formalChampion: "logistic",
    sampleIssues: 50,
    confidenceLowerBound: 0.01,
    randomChampionPercentile: 0.995,
  });
  assert.equal(review.learningRun.championBefore, "interpretable_rules");
  assert.equal(review.learningRun.championAfter, "logistic");
  assert.equal(review.learningRun.challengerPromoted, true);
  assert.match(review.learningRun.summary, /完成.*验证|晋级/);
});

test("review summary does not call a high hit count an advantage when probability scoring loses", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  });
  const draw: Draw = {
    game: "new_macau",
    issue: "2026999",
    drawAt: "2026-10-01T21:32:32+08:00",
    numbers: [1, 3, 5, 7, 9, 11],
    special: 13,
    source: "双源一致测试",
    verified: true,
  };
  snapshot.events = snapshot.events.map((event: any) => ({
    ...event,
    probability: 0.4,
    predictedValue:
      event.family === "zodiac" ? zodiacFor(1, draw.drawAt)
        : event.family === "tail" ? "1尾"
          : event.family === "parity" ? "单"
            : "小",
  }));
  const review = buildReview(snapshot, draw, "2026-10-01T21:35:00+08:00");
  assert.equal(review.hits, 4);
  assert.ok(review.brierSkill < 0);
  assert.match(review.summary, /概率评分.*低于随机基线/);
});

test("performance skill is calculated from aggregate scores, not an average of ratios", () => {
  const reviews = [
    { targetIssue: "1", settledAt: "2026-01-01", hits: 2, total: 4, expectedHits: 2, brier: 0.1, baselineBrier: 0.2, logLoss: 0.4, baselineLogLoss: 0.5, brierSkill: 0.5, logLossSkill: 0.2 },
    { targetIssue: "2", settledAt: "2026-01-02", hits: 2, total: 4, expectedHits: 2, brier: 0.3, baselineBrier: 0.4, logLoss: 0.8, baselineLogLoss: 1, brierSkill: 0.25, logLossSkill: 0.2 },
  ];
  const performance = buildPerformance("new_macau", reviews);
  assert.ok(Math.abs(performance.brierSkill - (1 - 0.2 / 0.3)) < 1e-12);
  assert.ok(Math.abs(performance.logLossSkill - 0.2) < 1e-12);
});

test("a result cannot settle a forecast frozen after draw time", () => {
  const snapshot = buildSnapshot({
    game: "new_macau",
    draws: makeHistory(80),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-10-01T22:00:00+08:00",
  });
  const draw: Draw = {
    game: "new_macau",
    issue: "2026999",
    drawAt: "2026-10-01T21:32:32+08:00",
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "双源一致测试",
    verified: true,
  };
  assert.throws(
    () => buildReview(snapshot, draw, "2026-10-01T22:01:00+08:00"),
    /not frozen before/,
  );
});

test("retired rule states are consumed by the next frozen forecast", () => {
  const input = {
    game: "new_macau" as const,
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  };
  const before = buildSnapshot(input);
  const event = before.events[0];
  const ruleStates = {
    zodiac_6_plus_1: Object.fromEntries(
      event.ruleContributions.map((rule: any) => [
        rule.ruleId,
        {
          ruleId: rule.ruleId,
          slot: event.slot,
          triggers: 8,
          hits: 0,
          consecutiveHits: 0,
          consecutiveMisses: 8,
          status: "suppressed",
        },
      ]),
    ),
  };
  const after = buildSnapshot({ ...input, ruleStates });
  const sameCandidate = after.events[0].predictedValue === event.predictedValue;
  assert.ok(
    !sameCandidate || after.events[0].probability < event.probability,
    "a retired rule must either lower its candidate or cause another candidate to win",
  );
  assert.ok(
    after.events[0].ruleContributions.every(
      (rule: any) => !ruleStates.zodiac_6_plus_1[rule.ruleId] || rule.contribution === 0,
    ),
  );
});

test("successful active rule states strengthen their next-forecast contribution", () => {
  const input = {
    game: "new_macau" as const,
    draws: makeHistory(160),
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  };
  const before = buildSnapshot(input);
  const event = before.events.find((item: any) =>
    item.ruleContributions.some((rule: any) => rule.contribution !== 0)
  );
  assert.ok(event);
  const ruleStates = {
    [event!.slot]: Object.fromEntries(
      event!.ruleContributions.map((rule: any) => [
        rule.ruleId,
        {
          ruleId: rule.ruleId,
          slot: event!.slot,
          triggers: 20,
          hits: 20,
          consecutiveHits: 5,
          consecutiveMisses: 0,
          status: "active",
        },
      ]),
    ),
  };
  const after = buildSnapshot({ ...input, ruleStates });
  const afterEvent = after.events.find((item: any) => item.slot === event!.slot);
  assert.ok(afterEvent);
  for (const beforeRule of event!.ruleContributions) {
    const afterRule = afterEvent!.ruleContributions.find(
      (rule: any) => rule.ruleId === beforeRule.ruleId,
    );
    assert.ok(afterRule);
    assert.ok(
      Math.abs(afterRule.contribution) >= Math.abs(beforeRule.contribution),
      "a consistently successful active rule must not be weakened",
    );
  }
});

test("baseline-only Python artifacts contribute only to the experimental track", () => {
  const draws = makeHistory(160);
  const input = {
    game: "new_macau" as const,
    draws,
    targetIssue: "2026999",
    expectedDrawAt: "2026-10-01T21:32:32+08:00",
    generatedAt: "2026-09-30T10:00:00.000Z",
  };
  const selected = buildSnapshot(input).events[0].predictedValue;
  const positions = ["main.1", "main.2", "main.3", "main.4", "main.5", "main.6", "special"];
  const matching = Array.from({ length: 5 }, (_, index) => index + 1)
    .flatMap((lag) => positions.map((source) => ({ lag, source })))
    .find(({ lag, source }) => {
      const draw = draws.at(-lag)!;
      const number = source === "special"
        ? draw.special
        : draw.numbers[Number(source.split(".")[1]) - 1];
      return zodiacFor(number, draw.drawAt) === selected;
    });
  assert.ok(matching);
  const artifact = {
    schemaVersion: "python-shadow-v3",
    generatedAt: "2026-09-30T09:00:00.000Z",
    game: "new_macau",
    audit: {
      sampleSize: 160,
      formalSampleSize: 60,
      verifiedRatio: 0.375,
      duplicateIssueCount: 0,
      numericGapCount: 0,
      oldestIssue: "2026001",
      newestIssue: "2026160",
      datasetVersion: "python-test-data",
    },
    resourceFunnel: {
      generated: 1,
      eligible: 1,
      fullBacktest: 1,
      negativePool: 0,
      reductionRate: 0,
    },
    topPositiveRules: [{
      ruleId: "python-zodiac-transfer",
      spec: {
        family: "position_transfer",
        lag: matching!.lag,
        source: matching!.source,
        target: "main.1",
        condition: null,
        familyTarget: "zodiac",
      },
      description: "读取前1期特码生肖，预测下期第1正码生肖",
      support: 120,
      hits: 24,
      hitRate: 0.2,
      baselineRate: 1 / 12,
      shrunkenRate: 0.18,
      pValue: 0.001,
      qValue: 0.01,
      direction: "positive",
      resourceDecision: "full_backtest",
    }],
    topNegativeRules: [],
    blackBox: { status: "blocked", reason: "sample_lt_1000" },
    formalDecision: "baseline_only",
  };
  const snapshot = buildSnapshot({ ...input, researchArtifact: artifact });
  assert.ok(
    snapshot.events[0].ruleContributions.some(
      (rule: any) => rule.window === "python" && rule.ruleId === "python-zodiac-transfer",
    ),
  );
  assert.equal(snapshot.mode, "shadow");
  assert.equal(snapshot.events[0].probability, snapshot.events[0].baselineProbability);
  assert.ok(snapshot.events[0].experimentalProbability >= snapshot.events[0].probability);
});

function makeHistory(count: number): Draw[] {
  const start = Date.parse("2026-01-01T21:32:32+08:00");
  return Array.from({ length: count }, (_, index) => {
    const pool = Array.from({ length: 49 }, (__, numberIndex) => numberIndex + 1);
    const shift = (index * 11) % 49;
    const ordered = [...pool.slice(shift), ...pool.slice(0, shift)];
    return {
      game: "new_macau",
      issue: String(2026001 + index),
      drawAt: new Date(start + index * 86_400_000).toISOString(),
      numbers: ordered.slice(0, 6),
      special: ordered[6],
      source: "合成测试",
      verified: index >= count - 60,
    };
  });
}
