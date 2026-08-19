import test from "node:test";
import assert from "node:assert/strict";
import type { RollingPatternRun, RollingPatternSignal } from "../lib/rolling-pattern-types.ts";
import type { ForwardLearningCandidate } from "../lib/forward-learning-types.ts";
import {
  buildForwardLearningCandidates,
  selectOfficialForecasts,
} from "../lib/forward-learning-engine.ts";

test("selects exactly one official forecast for every slot", () => {
  const candidates = buildForwardLearningCandidates(run(false));
  const result = selectOfficialForecasts(candidates);
  assert.deepEqual(result.map((item) => item.slot), [
    "coverage_zodiac",
    "coverage_tail",
    "coverage_zodiac_pair",
    "coverage_zodiac_triple",
    "special_number",
  ]);
  assert.equal(result.length, 5);
});

test("triple odds cannot displace a higher-probability candidate in another slot", () => {
  const forecasts = selectOfficialForecasts([
    candidate("coverage_zodiac", "猴", 0.62, 1),
    candidate("coverage_zodiac", "马", 0.58, 0.75),
    candidate("coverage_tail", "1尾", 0.6, 0.75),
    candidate("coverage_zodiac_pair", "猴＋鸡", 0.4, 3),
    candidate("coverage_zodiac_triple", "猴＋鸡＋狗", 0.3, 9),
    candidate("special_number", "01", 0.03, 47),
  ]);
  assert.equal(forecasts.find((item) => item.slot === "coverage_zodiac")?.label, "猴");
  assert.equal(forecasts.find((item) => item.slot === "coverage_zodiac_triple")?.label, "猴＋鸡＋狗");
});

test("duplicated rules form one evidence cluster and do not raise probability", () => {
  const once = buildForwardLearningCandidates(run(false));
  const twice = buildForwardLearningCandidates(run(true));
  const first = once.find((item) => item.slot === "coverage_zodiac" && item.label === "猴");
  const second = twice.find((item) => item.slot === "coverage_zodiac" && item.label === "猴");
  assert.ok(first && second);
  assert.equal(first.finalProbability, second.finalProbability);
  assert.equal(first.evidenceClusterCount, second.evidenceClusterCount);
  assert.ok(second.rawRuleCount > first.rawRuleCount);
});

test("selection is probability-first and deterministic", () => {
  const forecasts = selectOfficialForecasts([
    candidate("coverage_zodiac", "马", 0.6, 0.75),
    candidate("coverage_zodiac", "猴", 0.6, 1),
  ]);
  assert.equal(forecasts[0].resultKey, "猴");
});

function candidate(
  slot: ForwardLearningCandidate["slot"],
  label: string,
  probability: number,
  netOdds: number,
): ForwardLearningCandidate {
  return {
    candidateId: `c:${slot}:${label}`,
    game: "new_macau",
    targetIssue: "2026230",
    slot,
    resultKey: label,
    label,
    values: label.split("＋"),
    baselineProbability: Math.min(probability, 0.5),
    expertProbabilities: { baseline: 0.5, rules30: probability, forward: 0.5 },
    expertWeights: { baseline: 0.34, rules30: 0.33, forward: 0.33 },
    finalProbability: probability,
    netOdds,
    rawRuleCount: 1,
    evidenceClusterCount: 1,
    ruleContributions: [],
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardBrierSkill: 0,
    frozenAt: "2026-08-17T14:02:00.000Z",
    modelVersion: "m1",
    dataVersion: "fixture",
  };
}

function run(duplicate: boolean): RollingPatternRun {
  const signals = [
    signal("zodiac", "猴", "same-condition", "monkey-1"),
    ...(duplicate ? [signal("zodiac", "猴", "same-condition", "monkey-copy")] : []),
    signal("zodiac", "鸡", "condition-chicken", "chicken"),
    signal("zodiac", "狗", "condition-dog", "dog"),
    signal("tail", "1尾", "condition-tail", "tail"),
  ];
  return {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: `run-${duplicate}`,
    game: "new_macau",
    sourceIssue: "2026229",
    targetIssue: "2026230",
    expectedDrawAt: "2026-08-18T21:32:00+08:00",
    generatedAt: "2026-08-17T14:02:00.000Z",
    frozenAt: "2026-08-17T14:02:00.000Z",
    status: "completed",
    window: {
      game: "new_macau",
      drawCount: 30,
      oldestIssue: "2026200",
      newestIssue: "2026229",
      dataHash: "fixture",
    },
    funnel: { generated: 5, currentTriggered: 5, deduplicated: 5, aboveBaseline: 5, qualified: 5 },
    scopeFunnels: {
      coverage_6_plus_1: { generated: 5, currentTriggered: 5, deduplicated: 5, aboveBaseline: 5, qualified: 5 },
      special: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    },
    signals,
  };
}

function signal(
  family: "zodiac" | "tail",
  value: string,
  canonicalJson: string,
  id: string,
): RollingPatternSignal {
  const baseline = family === "tail" ? 0.55 : 0.47;
  return {
    rule: {
      ruleId: id,
      family: "single_transfer",
      antecedent: {
        kind: "single",
        conditions: [{
          event: {
            eventId: "condition:tail:4尾:gte1",
            scope: "condition",
            family: "tail",
            value: "4尾",
            label: "6+1至少出现一次4尾",
            threshold: 1,
            memberCount: 5,
          },
          expectedMatched: true,
        }],
      },
      event: {
        eventId: `coverage_6_plus_1:${family}:${value}:gte1`,
        scope: "coverage_6_plus_1",
        family,
        value,
        label: `下一期6+1至少出现一次${value}`,
        threshold: 1,
        memberCount: 4,
      },
      prediction: true,
      canonicalJson,
      conditionLabel: "本期4尾出现",
      predictionLabel: `下一期${value}`,
      relationLabel: `4尾 → ${value}`,
      description: "fixture",
    },
    currentTriggered: true,
    support: 6,
    hits: 5,
    rawRate: 5 / 6,
    baseline,
    rawUplift: 5 / 6 - baseline,
    posteriorRate: 0.7,
    posteriorUplift: 0.2,
    pValue: 0.1,
    qValue: 1,
    evidenceTier: "experimental",
    sampleLabel: "有限样本",
    relatedRuleCount: 1,
    currentEvidence: [],
    stateHistory: [],
    audit: Array.from({ length: 6 }, (_, index) => ({
      sourceIssue: String(2026200 + index),
      targetIssue: String(2026201 + index),
      targetDrawAt: "2026-08-01T21:32:00+08:00",
      conditionEvidence: [],
      result: {
        issue: String(2026201 + index),
        drawAt: "2026-08-01T21:32:00+08:00",
        matched: index < 5,
        count: index < 5 ? 1 : 0,
      },
      matched: index < 5,
    })),
  };
}
