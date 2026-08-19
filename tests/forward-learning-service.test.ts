import assert from "node:assert/strict";
import test from "node:test";
import type { Draw, GameId } from "../lib/lottery.ts";
import type {
  ProductHistoryCounts,
  RollingPatternRun,
  RollingPatternSignal,
} from "../lib/rolling-pattern-types.ts";
import type {
  ForwardLearningCandidate,
  ForwardLearningRevisionSnapshot,
  ForwardLearningRollout,
  ResolvedForwardSnapshot,
} from "../lib/forward-learning-types.ts";
import {
  ForwardLearningPrerequisiteError,
  runForwardLearningCycle,
} from "../lib/forward-learning-service.ts";
import {
  NEW_MACAU_2026231_AUTHORITATIVE_HASH,
  NEW_MACAU_2026231_ROLLOUT,
} from "../lib/forward-learning-rollouts.ts";
import { canCorrectV1Bootstrap } from "../lib/unified-product-learning.ts";

test("an unscored v1 bootstrap is corrected append-only before draw", async () => {
  const dependencies = correctionDependencies();
  const result = await runForwardLearningCycle(correctionInput(), dependencies);

  assert.equal(result.status, "created");
  assert.equal(result.revision, 2);
  assert.deepEqual(result.forecasts.map((item) => item.resultKey), [
    "猴", "8尾", "蛇+猴", "蛇+马+猴", "01",
  ]);
  assert.equal(dependencies.deleteCalls, 0);
});

test("the next issue uses current p30 plus exactly one v2 settlement", async () => {
  const dependencies = learnedDependencies();
  const result = await runForwardLearningCycle(nextIssueInput(), dependencies);
  const monkey = result.forecasts.find((item) => item.resultKey === "猴");

  assert.ok(monkey && "learningSettledCount" in monkey);
  assert.equal(monkey.learningSettledCount, 1);
  assert.equal(dependencies.legacyQueryCutoff, "2026231");
  assert.equal(dependencies.v2HistoryReadCount, 1);
});

test("the 2026231 correction hard gate rejects every provenance mismatch", () => {
  for (const changed of correctionMismatchFixtures()) {
    const gate = canCorrectV1Bootstrap(changed);
    assert.equal(gate.allowed, false, changed.name);
  }
});

test("a missing rollout never falls back to an unbounded legacy query", async () => {
  const dependencies = dependenciesWithoutRollout();
  const result = await runForwardLearningCycle(correctionInput(), dependencies);

  assert.equal(result.status, "awaiting_rollout");
  assert.equal(dependencies.legacyQueryCount, 0);
});

test("a dynamic first rollout freezes the real five-item recommendation hash", async () => {
  const persisted: ForwardLearningRollout[] = [];
  const frozen: ForwardLearningRevisionSnapshot[] = [];
  const dependencies = correctionDependencies();
  const result = await runForwardLearningCycle({
    ...nextIssueInput(),
    draws: [],
  }, {
    ...dependencies,
    readResolved: async () => null,
    readRollout: async () => null,
    persistRollout: async (rollout) => {
      persisted.push(rollout);
      return "created" as const;
    },
    readLegacyHistory: async () => authoritativeLegacyHistories("2026232"),
    readV2History: async () => new Map(),
    freezeRevision: async (snapshot) => {
      frozen.push(snapshot);
      return "created" as const;
    },
  });

  assert.equal(result.status, "created");
  assert.equal(persisted.length, 1);
  assert.equal(frozen.length, 1);
  assert.notEqual(
    persisted[0].authoritativeRecommendationHash,
    persisted[0].sourceDataHash,
  );
  assert.equal(
    persisted[0].authoritativeRecommendationHash,
    frozen[0].recommendationHash,
  );
});

test("a concurrent dynamic rollout is reread and recomputed from stored identity", async () => {
  let stored: ForwardLearningRollout | null = null;
  let rolloutReads = 0;
  let legacyReads = 0;
  const frozen: ForwardLearningRevisionSnapshot[] = [];
  const dependencies = correctionDependencies();
  const result = await runForwardLearningCycle({
    ...nextIssueInput(),
    draws: [],
  }, {
    ...dependencies,
    readResolved: async () => null,
    readRollout: async () => {
      rolloutReads += 1;
      return stored;
    },
    persistRollout: async (rollout) => {
      stored = { ...rollout };
      return "conflict" as const;
    },
    readLegacyHistory: async () => {
      legacyReads += 1;
      return authoritativeLegacyHistories("2026232");
    },
    readV2History: async () => new Map(),
    freezeRevision: async (snapshot) => {
      frozen.push(snapshot);
      return "created" as const;
    },
  });

  assert.equal(result.status, "created");
  assert.equal(rolloutReads, 2);
  assert.equal(legacyReads, 2);
  assert.ok(stored);
  assert.equal(frozen.length, 1);
  assert.equal(
    frozen[0].rollout.authoritativeRecommendationHash,
    frozen[0].recommendationHash,
  );
});

test("a concurrent dynamic rollout with an invalid stored cutoff fails closed", async () => {
  let stored: ForwardLearningRollout | null = null;
  let freezeCount = 0;
  const result = await runForwardLearningCycle({
    ...nextIssueInput(),
    draws: [],
  }, {
    ...correctionDependencies(),
    readResolved: async () => null,
    readRollout: async () => stored,
    persistRollout: async (rollout) => {
      stored = {
        ...rollout,
        legacySeedThroughIssue: rollout.firstUnifiedTargetIssue,
      };
      return "conflict" as const;
    },
    readLegacyHistory: async () => authoritativeLegacyHistories("2026232"),
    readV2History: async () => new Map(),
    freezeRevision: async () => {
      freezeCount += 1;
      return "created" as const;
    },
  });

  assert.equal(result.status, "awaiting_rollout");
  assert.equal(freezeCount, 0);
});

test("bootstrap never synthesizes missing legacy product provenance", async () => {
  const histories = authoritativeLegacyHistories();
  histories.legacyProductIds.delete("coverage_zodiac:猴");
  let freezeCount = 0;

  await assert.rejects(() => runForwardLearningCycle(correctionInput(), {
    ...correctionDependencies(),
    readLegacyHistory: async () => histories,
    freezeRevision: async () => {
      freezeCount += 1;
      return "created" as const;
    },
  }), /权威五项哈希/);

  assert.equal(freezeCount, 0);
});

test("a conflicting bootstrap rollout is rejected before legacy history", async () => {
  let legacyQueryCount = 0;
  const result = await runForwardLearningCycle(correctionInput(), {
    ...correctionDependencies(),
    readRollout: async () => ({
      ...NEW_MACAU_2026231_ROLLOUT,
      legacySeedThroughIssue: "2026229",
    }),
    persistRollout: async (rollout) => {
      assert.deepEqual(rollout, NEW_MACAU_2026231_ROLLOUT);
      return "conflict" as const;
    },
    readLegacyHistory: async () => {
      legacyQueryCount += 1;
      return authoritativeLegacyHistories();
    },
  });

  assert.equal(result.status, "awaiting_rollout");
  assert.equal(legacyQueryCount, 0);
});

test("a v1-only target outside the checked bootstrap is never upgraded", async () => {
  const existing = v1SnapshotForIssue("2026232");
  let legacyQueryCount = 0;
  let freezeCount = 0;
  const result = await runForwardLearningCycle({
    ...nextIssueInput(),
    draws: [],
  }, {
    ...correctionDependencies(),
    readResolved: async (_game, issue) => issue === "2026232" ? existing : null,
    readRollout: async () => NEW_MACAU_2026231_ROLLOUT,
    persistRollout: async () => "existing" as const,
    readLegacyHistory: async () => {
      legacyQueryCount += 1;
      return authoritativeLegacyHistories("2026232");
    },
    freezeRevision: async () => {
      freezeCount += 1;
      return "created" as const;
    },
  });

  assert.equal(result.status, "existing");
  assert.equal(result.revision, 1);
  assert.equal(legacyQueryCount, 0);
  assert.equal(freezeCount, 0);
});

test("unavailable legacy history fails closed before revision freeze", async () => {
  let freezeCount = 0;
  await assert.rejects(() => runForwardLearningCycle(correctionInput(), {
    ...correctionDependencies(),
    readLegacyHistory: async () => null,
    freezeRevision: async () => {
      freezeCount += 1;
      return "created" as const;
    },
  }), (error) => {
    assert.ok(error instanceof ForwardLearningPrerequisiteError);
    assert.equal(error.message, "旧产品种子历史不可用");
    return true;
  });
  assert.equal(freezeCount, 0);
});

test("prior v2 lookup never reads issues before the rollout boundary", async () => {
  let resolvedReadCount = 0;
  const dependencies = correctionDependencies();
  const result = await runForwardLearningCycle({
    ...correctionInput(),
    draws: Array.from({ length: 40 }, (_, index) => ({
      ...nextIssueInput().draws[0],
      issue: String(2026190 + index),
    })),
  }, {
    ...dependencies,
    readResolved: async (game, issue) => {
      resolvedReadCount += 1;
      return dependencies.readResolved(game, issue);
    },
  });

  assert.equal(result.status, "created");
  assert.equal(resolvedReadCount, 1);
});

function correctionInput() {
  return {
    game: "new_macau" as const,
    draws: [] as Draw[],
    rollingRun: authoritativeRollingRun("2026231"),
    now: new Date("2026-08-19T13:00:00.000Z"),
  };
}

function nextIssueInput() {
  return {
    game: "new_macau" as const,
    draws: [{
      game: "new_macau" as const,
      issue: "2026231",
      drawAt: "2026-08-19T13:32:00.000Z",
      numbers: [1, 2, 3, 4, 5, 6],
      special: 7,
      source: "fixture",
      verified: true,
    }],
    rollingRun: authoritativeRollingRun("2026232"),
    now: new Date("2026-08-20T12:00:00.000Z"),
  };
}

function correctionDependencies() {
  const existing = v1BootstrapSnapshot();
  const calls: string[] = [];
  return {
    deleteCalls: 0,
    readResolved: async (_game: GameId, issue?: string | null) =>
      issue === "2026231" ? existing : null,
    settleResolved: async () => ({
      status: "not_found" as const,
      source: null,
      revision: null,
      scores: [],
    }),
    readRollout: async () => null,
    persistRollout: async (rollout: ForwardLearningRollout) => {
      calls.push("rollout");
      assert.deepEqual(rollout, NEW_MACAU_2026231_ROLLOUT);
      return "created" as const;
    },
    readLegacyHistory: async (_game: GameId, cutoff: string) => {
      calls.push("legacy");
      assert.equal(cutoff, "2026231");
      assert.deepEqual(calls, ["rollout", "legacy"]);
      return authoritativeLegacyHistories();
    },
    readV2History: async () => new Map(),
    readScoreCount: async () => 0,
    freezeRevision: async (snapshot: ForwardLearningRevisionSnapshot) => {
      assert.equal(snapshot.recommendationHash, NEW_MACAU_2026231_AUTHORITATIVE_HASH);
      return "created" as const;
    },
    claimRun: async () => "claimed" as const,
    completeRun: async () => true,
  };
}

function learnedDependencies() {
  const previous = v2ResolvedSnapshot("2026231");
  const dependencies = {
    legacyQueryCutoff: "",
    v2HistoryReadCount: 0,
    readResolved: async (_game: GameId, issue?: string | null) =>
      issue === "2026231" ? previous : null,
    settleResolved: async () => ({
      status: "settled" as const,
      source: "v2" as const,
      revision: 2,
      scores: [],
    }),
    readRollout: async () => NEW_MACAU_2026231_ROLLOUT,
    persistRollout: async () => "existing" as const,
    readLegacyHistory: async (_game: GameId, cutoff: string) => {
      dependencies.legacyQueryCutoff = cutoff;
      return authoritativeLegacyHistories("2026232");
    },
    readV2History: async () => {
      dependencies.v2HistoryReadCount += 1;
      return new Map<string, ProductHistoryCounts>([[
        "coverage_zodiac:猴",
        { settledCount: 1, hitCount: 0 },
      ]]);
    },
    readScoreCount: async () => 0,
    freezeRevision: async () => "created" as const,
    claimRun: async () => "claimed" as const,
    completeRun: async () => true,
  };
  return dependencies;
}

function dependenciesWithoutRollout() {
  const dependencies = {
    legacyQueryCount: 0,
    readResolved: async () => v1BootstrapSnapshot(),
    settleResolved: async () => ({
      status: "not_found" as const,
      source: null,
      revision: null,
      scores: [],
    }),
    readRollout: async () => null,
    persistRollout: async () => "unavailable" as const,
    readLegacyHistory: async () => {
      dependencies.legacyQueryCount += 1;
      return authoritativeLegacyHistories();
    },
    readV2History: async () => new Map(),
    readScoreCount: async () => 0,
    freezeRevision: async () => "unavailable" as const,
    claimRun: async () => "unavailable" as const,
    completeRun: async () => false,
  };
  return dependencies;
}

function correctionMismatchFixtures() {
  const base = correctionGateInput();
  const firstForecast = base.existing.forecasts[0];
  const mutateFirstForecast = (
    changed: Partial<typeof firstForecast>,
  ) => ({
    ...base,
    existing: {
      ...base.existing,
      forecasts: base.existing.forecasts.map((forecast, index) =>
        index === 0 ? { ...forecast, ...changed } : forecast
      ),
    },
  });
  const mutations = [
    { name: "game", value: { ...base, game: "hk" as const } },
    { name: "target issue", value: { ...base, targetIssue: "2026232" } },
    { name: "source run", value: { ...base, run: { ...base.run, runId: "changed" } } },
    { name: "data hash", value: { ...base, run: { ...base.run, window: { ...base.run.window, dataHash: "changed" } } } },
    { name: "draw deadline", value: { ...base, run: { ...base.run, expectedDrawAt: "2026-08-19T13:33:00.000Z" } } },
    { name: "authority hash", value: { ...base, recommendationHash: "changed" } },
    { name: "rollout", value: { ...base, rollout: { ...base.rollout, legacySeedThroughIssue: "2026229" } } },
    { name: "v1 candidate count", value: { ...base, existing: { ...base.existing, candidates: base.existing.candidates.slice(1) } } },
    { name: "duplicate v1 candidate", value: { ...base, existing: { ...base.existing, candidates: base.existing.candidates.map((item, index) => index === 1 ? base.existing.candidates[0] : item) } } },
    { name: "v1 source", value: { ...base, existing: { ...base.existing, source: "v2" as const } } },
    { name: "duplicate official slot", value: { ...base, existing: { ...base.existing, forecasts: base.existing.forecasts.map((item, index) => index === 1 ? { ...item, slot: "coverage_zodiac" as const } : item) } } },
    { name: "forecast candidate does not exist", value: mutateFirstForecast({ candidateId: "candidate:v1:missing" }) },
    { name: "forecast id is not derived from candidate", value: mutateFirstForecast({ forecastId: "forecast:v1:unrelated" }) },
    { name: "forecast rank is not the frozen official rank", value: mutateFirstForecast({ rank: 2 as 1 }) },
    { name: "forecast result is not the candidate result", value: mutateFirstForecast({ resultKey: "猪", values: ["猪"], label: "猪" }) },
    { name: "forecast frozen time differs from candidate", value: mutateFirstForecast({ frozenAt: "2026-08-19T12:00:01.000Z" }) },
    { name: "forecast data version differs from candidate", value: mutateFirstForecast({ dataVersion: "changed" }) },
    { name: "forecast model identity differs from candidate", value: mutateFirstForecast({ modelVersion: "changed" }) },
    { name: "forecast frozen probability differs from candidate", value: mutateFirstForecast({ finalProbability: firstForecast.finalProbability + 0.01 }) },
    { name: "score", value: { ...base, scoreCount: 1 } },
    { name: "verified draw", value: { ...base, verifiedMatchingDraw: { ...nextIssueInput().draws[0], issue: "2026231" } } },
    { name: "deadline passed", value: { ...base, now: new Date("2026-08-19T13:32:00.000Z") } },
  ];
  return mutations.map((item) => ({ ...item.value, name: item.name }));
}

function correctionGateInput() {
  return {
    game: "new_macau" as const,
    targetIssue: "2026231",
    run: authoritativeRollingRun("2026231"),
    rollout: NEW_MACAU_2026231_ROLLOUT,
    recommendationHash: NEW_MACAU_2026231_AUTHORITATIVE_HASH,
    existing: v1BootstrapSnapshot(),
    scoreCount: 0,
    verifiedMatchingDraw: null,
    now: new Date("2026-08-19T13:00:00.000Z"),
  };
}

function authoritativeLegacyHistories(targetIssue = "2026231") {
  const runId = targetIssue === "2026231"
    ? NEW_MACAU_2026231_ROLLOUT.sourceRunId
    : "rp_new_macau_2026232_fixture";
  const rows = [
    ["coverage_zodiac:猴", 9, 7, `coverage_zodiac:猴`],
    ["coverage_tail:8尾", 9, 8, `coverage_tail:8尾`],
    ["coverage_zodiac_pair:蛇+猴", 9, 6, `coverage_zodiac_pair:蛇-猴`],
    ["coverage_zodiac_triple:蛇+马+猴", 9, 5, `coverage_zodiac_triple:蛇-马-猴`],
    ["special_number:01", 9, 1, "special_number:01"],
  ] as const;
  return {
    legacy: new Map<string, ProductHistoryCounts>(rows.map(([key, settledCount, hitCount]) => [
      key,
      { settledCount, hitCount },
    ])),
    legacyProductIds: new Map(rows.map(([key, , , suffix]) => [key, `${runId}:${suffix}`])),
  };
}

function authoritativeRollingRun(targetIssue: "2026231" | "2026232"): RollingPatternRun {
  const sourceIssue = String(Number(targetIssue) - 1);
  const fixed = targetIssue === "2026231";
  const signals = authoritativeSignals();
  return {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: fixed
      ? NEW_MACAU_2026231_ROLLOUT.sourceRunId
      : "rp_new_macau_2026232_fixture",
    game: "new_macau",
    sourceIssue,
    targetIssue,
    expectedDrawAt: fixed
      ? "2026-08-19T13:32:00.000Z"
      : "2026-08-20T13:32:00.000Z",
    generatedAt: fixed ? NEW_MACAU_2026231_ROLLOUT.createdAt : "2026-08-20T12:00:00.000Z",
    frozenAt: fixed ? NEW_MACAU_2026231_ROLLOUT.createdAt : "2026-08-20T12:00:00.000Z",
    status: "completed",
    window: {
      game: "new_macau",
      drawCount: 30,
      oldestIssue: String(Number(sourceIssue) - 29),
      newestIssue: sourceIssue,
      dataHash: fixed ? NEW_MACAU_2026231_ROLLOUT.sourceDataHash : "data-2026232",
    },
    funnel: { generated: signals.length, currentTriggered: signals.length, deduplicated: signals.length, aboveBaseline: signals.length, qualified: signals.length },
    scopeFunnels: {
      coverage_6_plus_1: { generated: signals.length, currentTriggered: signals.length, deduplicated: signals.length, aboveBaseline: signals.length, qualified: signals.length },
      special: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    },
    signals,
  };
}

function authoritativeSignals(): RollingPatternSignal[] {
  const issues = Array.from({ length: 23 }, (_, index) => String(2026208 + index));
  return [
    signalFixture("猴", "zodiac", 4, issues, new Set(issues.slice(0, 17))),
    signalFixture("蛇", "zodiac", 4, issues.slice(0, 20), new Set(issues.slice(0, 8))),
    signalFixture("马", "zodiac", 5, issues.slice(0, 18), new Set(issues.slice(0, 6))),
    signalFixture("8尾", "tail", 5, issues.slice(0, 22), new Set(issues.slice(0, 18))),
  ];
}

function signalFixture(
  value: string,
  family: "zodiac" | "tail",
  memberCount: number,
  issues: string[],
  matched: Set<string>,
): RollingPatternSignal {
  const eventId = `coverage_6_plus_1:${family}:${value}:gte1`;
  const baseline = family === "tail"
    ? 0.5538963041275711
    : value === "猴"
      ? 0.47171930751949276
      : value === "马"
        ? 0.5564786200737735
        : 0.4741494500976464;
  return {
    rule: {
      ruleId: `rule-${family}-${value}`,
      family: "single_transfer",
      antecedent: {
        kind: "single",
        conditions: [{
          event: { eventId: "condition", scope: "condition", family, value, label: value, threshold: 1, memberCount },
          expectedMatched: true,
        }],
      },
      event: { eventId, scope: "coverage_6_plus_1", family, value, label: value, threshold: 1, memberCount },
      prediction: true,
      canonicalJson: eventId,
      conditionLabel: value,
      predictionLabel: value,
      relationLabel: value,
      description: "fixture",
    },
    currentTriggered: true,
    support: issues.length,
    hits: matched.size,
    rawRate: matched.size / issues.length,
    baseline,
    rawUplift: 0,
    posteriorRate: 0,
    posteriorUplift: 0,
    pValue: 1,
    qValue: 1,
    evidenceTier: "experimental",
    sampleLabel: "近期重复",
    relatedRuleCount: 1,
    currentEvidence: [],
    stateHistory: [],
    audit: issues.map((issue) => ({
      sourceIssue: String(Number(issue) - 1),
      targetIssue: issue,
      targetDrawAt: "2026-08-01T13:32:00.000Z",
      conditionEvidence: [],
      result: { issue, drawAt: "2026-08-01T13:32:00.000Z", matched: matched.has(issue), count: matched.has(issue) ? 1 : 0 },
      matched: matched.has(issue),
    })),
  };
}

function v1BootstrapSnapshot(): ResolvedForwardSnapshot {
  const candidates = v1Universe();
  const officialKeys = new Map([
    ["coverage_zodiac", "龙"],
    ["coverage_tail", "1尾"],
    ["coverage_zodiac_pair", "鼠+牛"],
    ["coverage_zodiac_triple", "鼠+牛+虎"],
    ["special_number", "49"],
  ]);
  const forecasts = [...officialKeys].map(([slot, resultKey]) => {
    const candidate = candidates.find((item) => item.slot === slot && item.resultKey === resultKey)!;
    return {
      ...candidate,
      forecastId: `forecast:${candidate.candidateId}`,
      official: true as const,
      rank: 1 as const,
      previousResultKey: null,
      previousProbability: null,
      probabilityDelta: null,
      topAlternative: null,
      explanation: ["legacy v1"],
    };
  });
  return {
    source: "v1",
    revision: 1,
    revisionId: null,
    game: "new_macau",
    targetIssue: "2026231",
    candidates,
    forecasts,
  };
}

function v2ResolvedSnapshot(targetIssue: string): ResolvedForwardSnapshot {
  const legacy = v1BootstrapSnapshot();
  return {
    ...legacy,
    source: "v2",
    revision: 2,
    revisionId: `new_macau:${targetIssue}:r2`,
    targetIssue,
  };
}

function v1SnapshotForIssue(targetIssue: string): ResolvedForwardSnapshot {
  const legacy = v1BootstrapSnapshot();
  const candidates = legacy.candidates.map((candidate) => ({
    ...candidate,
    candidateId: candidate.candidateId.replace("2026231", targetIssue),
    targetIssue,
  }));
  const byIdentity = new Map(candidates.map((candidate) => [
    `${candidate.slot}:${candidate.resultKey}`,
    candidate,
  ]));
  return {
    ...legacy,
    targetIssue,
    candidates,
    forecasts: legacy.forecasts.map((forecast) => {
      const candidate = byIdentity.get(`${forecast.slot}:${forecast.resultKey}`)!;
      return {
        ...forecast,
        ...candidate,
        forecastId: `forecast:${candidate.candidateId}`,
      };
    }),
  };
}

function v1Universe(): ForwardLearningCandidate[] {
  const zodiacs = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
  const definitions = [
    ...zodiacs.map((resultKey) => ({ slot: "coverage_zodiac" as const, resultKey, values: [resultKey] })),
    ...Array.from({ length: 10 }, (_, index) => ({ slot: "coverage_tail" as const, resultKey: `${index}尾`, values: [`${index}尾`] })),
    ...testCombinations(zodiacs, 2).map((values) => ({ slot: "coverage_zodiac_pair" as const, resultKey: values.join("+"), values })),
    ...testCombinations(zodiacs, 3).map((values) => ({ slot: "coverage_zodiac_triple" as const, resultKey: values.join("+"), values })),
    ...Array.from({ length: 49 }, (_, index) => ({ slot: "special_number" as const, resultKey: String(index + 1).padStart(2, "0"), values: [String(index + 1).padStart(2, "0")] })),
  ];
  assert.equal(definitions.length, 357);
  return definitions.map(({ slot, resultKey, values }) => ({
    candidateId: `candidate:v1:2026231:${slot}:${resultKey}`,
    game: "new_macau",
    targetIssue: "2026231",
    slot,
    resultKey,
    label: resultKey,
    values,
    baselineProbability: 0.1,
    expertProbabilities: { baseline: 0.1, rules30: 0.1, forward: 0.1 },
    expertWeights: { baseline: 1, rules30: 0, forward: 0 },
    finalProbability: 0.1,
    netOdds: 1,
    rawRuleCount: 0,
    evidenceClusterCount: 0,
    ruleContributions: [],
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardBrierSkill: 0,
    frozenAt: "2026-08-19T12:00:00.000Z",
    modelVersion: "forward-learning-v1",
    dataVersion: "legacy-v1",
  }));
}

function testCombinations(values: string[], size: number) {
  const result: string[][] = [];
  const visit = (start: number, selected: string[]) => {
    if (selected.length === size) {
      result.push(selected);
      return;
    }
    for (let index = start; index < values.length; index += 1) {
      visit(index + 1, [...selected, values[index]]);
    }
  };
  visit(0, []);
  return result;
}
