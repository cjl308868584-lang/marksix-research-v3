import test from "node:test";
import assert from "node:assert/strict";
import type { Draw } from "../lib/lottery.ts";
import type { RollingPatternRun } from "../lib/rolling-pattern-types.ts";
import type {
  ForwardLearningCandidate,
  ForwardLearningForecast,
  ForwardLearningModelState,
  ForwardLearningScore,
} from "../lib/forward-learning-types.ts";
import { runForwardLearningCycle } from "../lib/forward-learning-service.ts";

test("cycle settles previous forecast before updating and freezing next", async () => {
  const calls: string[] = [];
  const candidates = candidateSet();
  const forecasts = forecastSet(candidates);
  const result = await runForwardLearningCycle(
    { game: "new_macau", draws: [verifiedDraw()], rollingRun: rollingRun(), now: new Date("2026-08-19T14:00:00Z") },
    {
      readForecast: async (_game, issue) => issue === "2026230" ? forecasts : [],
      settle: async () => {
        calls.push("settle");
        return { status: "settled" as const, scores: scoreSet(candidates) };
      },
      readCandidates: async () => candidates,
      readModel: async () => initialStates(),
      readHistory: async () => new Map(),
      readRuleWeights: async () => new Map(),
      persistStates: async () => {
        calls.push("update");
        return "ok" as const;
      },
      persistRuleUpdates: async () => "ok" as const,
      freeze: async () => {
        calls.push("freeze");
        return "created" as const;
      },
      claimRun: async () => "claimed" as const,
      completeRun: async () => true,
    },
  );
  assert.deepEqual(calls, ["settle", "update", "freeze"]);
  assert.equal(result.status, "created");
  assert.equal(result.settledIssue, "2026230");
  assert.equal(result.forecasts.length, 5);
});

test("cycle bootstraps next forecasts without fabricating a settled review", async () => {
  let settled = false;
  const result = await runForwardLearningCycle(
    { game: "new_macau", draws: [], rollingRun: rollingRun(), now: new Date("2026-08-19T14:00:00Z") },
    {
      readForecast: async () => [],
      settle: async () => {
        settled = true;
        return { status: "not_found" as const, scores: [] };
      },
      readCandidates: async () => [],
      readModel: async () => [],
      readHistory: async () => new Map(),
      readRuleWeights: async () => new Map(),
      persistStates: async () => "ok" as const,
      persistRuleUpdates: async () => "ok" as const,
      freeze: async () => "created" as const,
      claimRun: async () => "claimed" as const,
      completeRun: async () => true,
    },
  );
  assert.equal(settled, false);
  assert.equal(result.settledIssue, null);
  assert.equal(result.forecasts.length, 5);
});

test("completed cycle retry returns the frozen result without learning twice", async () => {
  const candidates = candidateSet();
  const previous = forecastSet(candidates);
  const next = forecastSet(candidates).map((forecast) => ({
    ...forecast,
    forecastId: forecast.forecastId.replace("old:", "next:"),
    candidateId: forecast.candidateId.replace("old:", "next:"),
    targetIssue: "2026231",
  }));
  let updates = 0;
  let completions = 0;
  const result = await runForwardLearningCycle(
    { game: "new_macau", draws: [verifiedDraw()], rollingRun: rollingRun(), now: new Date("2026-08-19T14:05:00Z") },
    {
      readForecast: async (_game, issue) => issue === "2026230" ? previous : issue === "2026231" ? next : [],
      settle: async () => ({ status: "existing" as const, scores: scoreSet(candidates) }),
      readCandidates: async () => candidates,
      readModel: async () => initialStates(),
      readHistory: async () => new Map(),
      readRuleWeights: async () => new Map(),
      persistStates: async () => {
        updates += 1;
        return "ok" as const;
      },
      persistRuleUpdates: async () => {
        updates += 1;
        return "ok" as const;
      },
      freeze: async () => {
        throw new Error("retry must not freeze again");
      },
      claimRun: async () => "existing" as const,
      completeRun: async () => {
        completions += 1;
        return false;
      },
    },
  );
  assert.equal(result.status, "existing");
  assert.equal(result.forecasts.length, 5);
  assert.equal(updates, 0);
  assert.equal(completions, 0);
});

test("cycle never settles a draw at or after the next target issue", async () => {
  const candidates = candidateSet();
  const forecasts = forecastSet(candidates);
  let settledIssue = "";
  const future = { ...verifiedDraw(), issue: "2026232" };
  const result = await runForwardLearningCycle(
    { game: "new_macau", draws: [future, verifiedDraw()], rollingRun: rollingRun(), now: new Date("2026-08-19T14:00:00Z") },
    {
      readForecast: async (_game, issue) => issue === "2026230" || issue === "2026232" ? forecasts.map((item) => ({ ...item, targetIssue: issue! })) : [],
      settle: async (_game, draw) => {
        settledIssue = draw.issue;
        return { status: "settled" as const, scores: scoreSet(candidates) };
      },
      readCandidates: async () => candidates,
      readModel: async () => initialStates(),
      readHistory: async () => new Map(),
      readRuleWeights: async () => new Map(),
      persistStates: async () => "ok" as const,
      persistRuleUpdates: async () => "ok" as const,
      freeze: async () => "created" as const,
      claimRun: async () => "claimed" as const,
      completeRun: async () => true,
    },
  );
  assert.equal(settledIssue, "2026230");
  assert.equal(result.settledIssue, "2026230");
});

function rollingRun(): RollingPatternRun {
  return {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: "rolling-231",
    game: "new_macau",
    sourceIssue: "2026230",
    targetIssue: "2026231",
    expectedDrawAt: "2026-08-19T21:32:00+08:00",
    generatedAt: "2026-08-19T14:00:00Z",
    frozenAt: "2026-08-19T14:00:00Z",
    status: "completed",
    window: { game: "new_macau", drawCount: 30, oldestIssue: "2026201", newestIssue: "2026230", dataHash: "next" },
    funnel: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    scopeFunnels: {
      coverage_6_plus_1: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
      special: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    },
    signals: [],
  };
}

function candidateSet(): ForwardLearningCandidate[] {
  const slots = ["coverage_zodiac", "coverage_tail", "coverage_zodiac_pair", "coverage_zodiac_triple", "special_number"] as const;
  return slots.map((slot, index) => ({
    candidateId: `old:${slot}`,
    game: "new_macau",
    targetIssue: "2026230",
    slot,
    resultKey: String(index),
    label: String(index),
    values: slot === "special_number" ? ["01"] : ["猴"],
    baselineProbability: slot === "special_number" ? 1 / 49 : 0.47,
    expertProbabilities: { baseline: 0.47, rules30: 0.55, forward: 0.5 },
    expertWeights: { baseline: 0.34, rules30: 0.33, forward: 0.33 },
    finalProbability: slot === "special_number" ? 0.03 : 0.5,
    netOdds: 1,
    rawRuleCount: 0,
    evidenceClusterCount: 0,
    ruleContributions: [],
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardBrierSkill: 0,
    frozenAt: "2026-08-18T14:00:00Z",
    modelVersion: "m0",
    dataVersion: "old",
  }));
}

function forecastSet(candidates: ForwardLearningCandidate[]): ForwardLearningForecast[] {
  return candidates.map((candidate) => ({
    ...candidate,
    forecastId: `forecast:${candidate.candidateId}`,
    official: true,
    rank: 1,
    previousResultKey: null,
    previousProbability: null,
    probabilityDelta: null,
    topAlternative: null,
    explanation: [],
  }));
}

function scoreSet(candidates: ForwardLearningCandidate[]): ForwardLearningScore[] {
  return candidates.map((candidate) => ({
    scoreId: `score:${candidate.candidateId}`,
    forecastId: `forecast:${candidate.candidateId}`,
    candidateId: candidate.candidateId,
    game: candidate.game,
    targetIssue: candidate.targetIssue,
    slot: candidate.slot,
    resultKey: candidate.resultKey,
    official: true,
    actualMatched: false,
    probability: candidate.finalProbability,
    baselineProbability: candidate.baselineProbability,
    brier: candidate.finalProbability ** 2,
    baselineBrier: candidate.baselineProbability ** 2,
    logLoss: -Math.log(1 - candidate.finalProbability),
    baselineLogLoss: -Math.log(1 - candidate.baselineProbability),
    actualNumbers: [1, 2, 3, 4, 5, 6, 7],
    actualSpecial: 7,
    scoredAt: "2026-08-18T22:00:00Z",
  }));
}

function initialStates(): ForwardLearningModelState[] {
  return candidateSet().map((candidate) => ({
    stateId: `state:${candidate.slot}`,
    game: "new_macau",
    slot: candidate.slot,
    version: "m0",
    weights: { baseline: 0.34, rules30: 0.33, forward: 0.33 },
    previousVersion: null,
    learnedThroughIssue: null,
    generatedAt: "2026-08-18T14:00:00Z",
  }));
}

function verifiedDraw(): Draw {
  return {
    game: "new_macau",
    issue: "2026230",
    drawAt: "2026-08-18T21:32:00+08:00",
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "fixture",
    verified: true,
  };
}
