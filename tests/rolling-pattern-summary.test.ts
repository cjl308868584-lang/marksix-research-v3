import assert from "node:assert/strict";
import test from "node:test";
import {
  selectRollingPatternView,
  summarizeRollingPatterns,
} from "../lib/rolling-pattern-summary.ts";
import type {
  RollingPatternEvidenceTier,
  RollingPatternFamily,
  RollingPatternSignal,
  RollingPatternScope,
} from "../lib/rolling-pattern-types";

function signal(input: {
  ruleId: string;
  eventId: string;
  label: string;
  value?: string;
  scope?: RollingPatternScope;
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
            scope: "condition",
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
        scope: input.scope ?? "coverage_6_plus_1",
        family: input.family ?? "zodiac",
        value: input.value ?? input.label,
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
    value: "羊",
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
      value: "羊",
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
  assert.equal(summary.resultGroups[0].label, "羊");
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

test("sorts result support by hit rate before evidence or strategy counts", () => {
  const summary = summarizeRollingPatterns([
    signal({ ruleId: "a", eventId: "a", label: "甲", support: 10, hits: 8, baseline: 0.5 }),
    signal({ ruleId: "b", eventId: "b", label: "乙", support: 20, hits: 14, baseline: 0.5, evidenceTier: "strong" }),
    signal({ ruleId: "c", eventId: "c", label: "丙", support: 4, hits: 4, baseline: 0.5 }),
  ]);

  assert.deepEqual(summary.resultGroups.map((group) => group.eventId), ["c", "a", "b"]);
});

test("selects one scope before summary and applies result filtering only to details", () => {
  const coverage = signal({
    ruleId: "coverage",
    eventId: "coverage:tail:7尾:gte1",
    label: "下一期6+1至少出现一次7尾",
    value: "7尾",
    family: "tail",
    support: 8,
    hits: 6,
    baseline: 0.55,
  });
  const specialTail = signal({
    ruleId: "special-tail",
    eventId: "special:tail:7尾:gte1",
    label: "下一期的特码为7尾",
    value: "7尾",
    family: "tail",
    scope: "special",
    support: 5,
    hits: 4,
    baseline: 0.1,
  });
  const specialWave = signal({
    ruleId: "special-wave",
    eventId: "special:wave:红波:gte1",
    label: "下一期的特码为红波",
    value: "红波",
    family: "wave",
    scope: "special",
    support: 4,
    hits: 3,
    baseline: 17 / 49,
  });

  const view = selectRollingPatternView(
    [coverage, specialTail, specialWave],
    { scope: "special", family: null, resultEventId: specialTail.rule.event.eventId },
  );
  assert.equal(view.summary.strategyCount, 2);
  assert.deepEqual(view.summary.resultGroups.map((group) => group.eventId), [
    specialTail.rule.event.eventId,
    specialWave.rule.event.eventId,
  ]);
  assert.deepEqual(view.signals.map((item) => item.rule.ruleId), ["special-tail"]);
});
