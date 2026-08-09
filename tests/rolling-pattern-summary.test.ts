import assert from "node:assert/strict";
import test from "node:test";
import { summarizeRollingPatterns } from "../lib/rolling-pattern-summary.ts";
import type {
  RollingPatternEvidenceTier,
  RollingPatternFamily,
  RollingPatternSignal,
} from "../lib/rolling-pattern-types";

function signal(input: {
  ruleId: string;
  eventId: string;
  label: string;
  family?: RollingPatternFamily;
  support: number;
  hits: number;
  baseline: number;
  evidenceTier?: RollingPatternEvidenceTier;
}): RollingPatternSignal {
  const rawRate = input.hits / input.support;
  return {
    rule: {
      ruleId: input.ruleId,
      family: "single_transfer",
      antecedent: {
        kind: "single",
        conditions: [{
          event: {
            eventId: "condition:fixture",
            family: "tail",
            value: "4",
            label: "6+1至少出现一次4尾",
            threshold: 1,
            memberCount: 5,
          },
          expectedMatched: true,
        }],
      },
      event: {
        eventId: input.eventId,
        family: input.family ?? "zodiac",
        value: input.label,
        label: input.label,
        threshold: 1,
        memberCount: 4,
      },
      prediction: true,
      canonicalJson: input.ruleId,
      conditionLabel: "本期条件成立",
      predictionLabel: input.label,
      relationLabel: `本期条件成立 → ${input.label}`,
      description: "fixture",
    },
    currentTriggered: true,
    support: input.support,
    hits: input.hits,
    rawRate,
    baseline: input.baseline,
    rawUplift: rawRate - input.baseline,
    posteriorRate: rawRate,
    posteriorUplift: rawRate - input.baseline,
    pValue: 0.05,
    qValue: 0.1,
    evidenceTier: input.evidenceTier ?? "experimental",
    sampleLabel: "有限样本",
    relatedRuleCount: 1,
    currentEvidence: [],
    stateHistory: [],
    audit: [],
  };
}

test("summarizes unique strategies across mixed result baselines", () => {
  const duplicate = signal({
    ruleId: "rule-a",
    eventId: "zodiac:羊:1",
    label: "下一期6+1至少出现一次羊",
    support: 10,
    hits: 7,
    baseline: 0.472,
    evidenceTier: "strong",
  });
  const summary = summarizeRollingPatterns([
    duplicate,
    duplicate,
    signal({
      ruleId: "rule-b",
      eventId: "zodiac:羊:1",
      label: "下一期6+1至少出现一次羊",
      support: 6,
      hits: 4,
      baseline: 0.472,
    }),
    signal({
      ruleId: "rule-c",
      eventId: "tail:0:1",
      label: "下一期6+1至少出现一次0尾",
      family: "tail",
      support: 4,
      hits: 2,
      baseline: 0.414,
    }),
  ]);

  assert.equal(summary.strategyCount, 3);
  assert.equal(summary.resultCount, 2);
  assert.equal(summary.triggerCount, 20);
  assert.equal(summary.hitCount, 13);
  assert.equal(summary.missCount, 7);
  assert.ok(Math.abs(summary.expectedHits - 9.208) < 1e-12);
  assert.ok(Math.abs(summary.expectedMisses - 10.792) < 1e-12);
  assert.equal(summary.strongStrategyCount, 1);
  assert.equal(summary.experimentalStrategyCount, 2);
  assert.equal(summary.resultGroups[0].eventId, "zodiac:羊:1");
  assert.equal(summary.resultGroups[0].strategyCount, 2);
  assert.equal(summary.resultGroups[0].hitCount, 11);
  assert.equal(summary.resultGroups[0].missCount, 5);
});

test("returns an explicit zero summary for no active rules", () => {
  assert.deepEqual(summarizeRollingPatterns([]), {
    strategyCount: 0,
    resultCount: 0,
    triggerCount: 0,
    hitCount: 0,
    missCount: 0,
    hitRate: 0,
    expectedHits: 0,
    expectedMisses: 0,
    baselineRate: 0,
    uplift: 0,
    strongStrategyCount: 0,
    experimentalStrategyCount: 0,
    resultGroups: [],
  });
});

test("sorts result support by strong evidence, strategies, uplift, then label", () => {
  const summary = summarizeRollingPatterns([
    signal({ ruleId: "a", eventId: "a", label: "甲", support: 4, hits: 3, baseline: 0.5 }),
    signal({ ruleId: "b", eventId: "b", label: "乙", support: 4, hits: 2, baseline: 0.5, evidenceTier: "strong" }),
    signal({ ruleId: "c", eventId: "c", label: "丙", support: 4, hits: 3, baseline: 0.5, evidenceTier: "strong" }),
  ]);

  assert.deepEqual(summary.resultGroups.map((group) => group.eventId), ["c", "b", "a"]);
});
