import assert from "node:assert/strict";
import test from "node:test";
import type { RollingPatternRun, RollingPatternSignal } from "../lib/rolling-pattern-types";
import {
  breakEvenProbability,
  applyForwardProductHistory,
  buildRollingPatternProducts,
  netOddsForProduct,
  settleRollingPatternProduct,
} from "../lib/rolling-pattern-value.ts";
import { getZodiac } from "../lib/zodiac.ts";

function signal(value: string, issues: Array<[string, boolean]>): RollingPatternSignal {
  const eventId = `coverage_6_plus_1:zodiac:${value}:gte1`;
  return {
    rule: {
      ruleId: `rule-${value}`,
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
      event: {
        eventId,
        scope: "coverage_6_plus_1",
        family: "zodiac",
        value,
        label: `下一期6+1至少出现一次${value}`,
        threshold: 1,
        memberCount: value === "马" ? 5 : 4,
      },
      prediction: true,
      canonicalJson: eventId,
      conditionLabel: "本期条件成立",
      predictionLabel: `下一期6+1至少出现一次${value}`,
      relationLabel: `条件 → ${value}`,
      description: "fixture",
    },
    currentTriggered: true,
    support: issues.length,
    hits: issues.filter(([, matched]) => matched).length,
    rawRate: 0.8,
    baseline: value === "马" ? 0.554 : 0.472,
    rawUplift: 0.2,
    posteriorRate: 0.7,
    posteriorUplift: 0.15,
    pValue: 0.2,
    qValue: 1,
    evidenceTier: "experimental",
    sampleLabel: "有限样本",
    relatedRuleCount: 1,
    currentEvidence: [],
    stateHistory: [],
    audit: issues.map(([issue, matched]) => ({
      sourceIssue: `${Number(issue) - 1}`,
      targetIssue: issue,
      targetDrawAt: "2026-08-01T21:32:00+08:00",
      conditionEvidence: [],
      result: {
        issue,
        drawAt: "2026-08-01T21:32:00+08:00",
        matched,
        count: matched ? 1 : 0,
      },
      matched,
    })),
  };
}

function run(signals: RollingPatternSignal[]): RollingPatternRun {
  return {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: "run-230",
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
    funnel: { generated: 1, currentTriggered: 1, deduplicated: 1, aboveBaseline: 1, qualified: 1 },
    scopeFunnels: {
      coverage_6_plus_1: { generated: 1, currentTriggered: 1, deduplicated: 1, aboveBaseline: 1, qualified: 1 },
      special: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    },
    signals,
  };
}

test("maps the supplied net odds and break-even probabilities", () => {
  assert.equal(netOddsForProduct("coverage_zodiac", ["马"]), 0.75);
  assert.equal(netOddsForProduct("coverage_zodiac", ["猴"]), 1);
  assert.equal(netOddsForProduct("coverage_tail", ["0尾"]), 1);
  assert.equal(netOddsForProduct("coverage_tail", ["7尾"]), 0.75);
  assert.equal(netOddsForProduct("coverage_zodiac_pair", ["马", "猴"]), 2);
  assert.equal(netOddsForProduct("coverage_zodiac_pair", ["猴", "鸡"]), 3);
  assert.equal(netOddsForProduct("coverage_zodiac_triple", ["马", "猴", "鸡"]), 7);
  assert.equal(netOddsForProduct("coverage_zodiac_triple", ["猴", "鸡", "狗"]), 9);
  assert.equal(netOddsForProduct("special_number", ["03"]), 47);
  assert.equal(breakEvenProbability(2), 1 / 3);
  assert.equal(breakEvenProbability(9), 0.1);
  assert.equal(breakEvenProbability(47), 1 / 48);
});

test("updates the frozen value probability from prior forward settlements without a sample gate", () => {
  const base = buildRollingPatternProducts(run([
    signal("猴", [["1", true], ["2", false]]),
  ])).find((item) => item.kind === "coverage_zodiac");
  assert.ok(base);
  const adjusted = applyForwardProductHistory(base, 3, 3);
  assert.equal(adjusted.forwardSettledCount, 3);
  assert.equal(adjusted.forwardHitCount, 3);
  assert.equal(adjusted.forwardMissCount, 0);
  assert.equal(adjusted.valueStatus, "positive");
  assert.ok(adjusted.estimatedProbability > base.estimatedProbability);
});

test("builds pair and triple evidence from joint target issues rather than multiplying rates", () => {
  const products = buildRollingPatternProducts(run([
    signal("马", [["1", true], ["2", true], ["3", false], ["4", true]]),
    signal("猴", [["1", true], ["2", false], ["4", true], ["5", true]]),
    signal("鸡", [["1", true], ["2", true], ["4", false], ["6", true]]),
  ]));
  const pair = products.find((item) =>
    item.kind === "coverage_zodiac_pair" && item.values.join("+") === "马+猴"
  );
  const triple = products.find((item) => item.kind === "coverage_zodiac_triple");
  assert.ok(pair);
  assert.equal(pair.support, 3);
  assert.equal(pair.hits, 2);
  assert.ok(triple);
  assert.equal(triple.support, 3);
  assert.equal(triple.hits, 1);
  assert.equal(pair.netOdds, 2);
  assert.equal(triple.netOdds, 7);
});

test("exact-number odds are evaluated immediately at the 1-in-49 baseline", () => {
  const product = buildRollingPatternProducts(run([])).find(
    (item) => item.kind === "special_number",
  );
  assert.equal(product, undefined);
  assert.ok((1 / 49) < breakEvenProbability(47));
});

test("settles one frozen product once using the actual 6+1 result", () => {
  const product = buildRollingPatternProducts(run([
    signal("马", [["1", true]]),
    signal("猴", [["1", true]]),
  ])).find((item) => item.kind === "coverage_zodiac_pair");
  assert.ok(product);
  const drawAt = "2026-08-18T21:32:00+08:00";
  const horse = Array.from({ length: 49 }, (_, index) => index + 1)
    .find((number) => getZodiac(number, drawAt) === "马");
  const monkey = Array.from({ length: 49 }, (_, index) => index + 1)
    .find((number) => getZodiac(number, drawAt) === "猴");
  assert.ok(horse && monkey);
  const score = settleRollingPatternProduct(product, {
    game: "new_macau",
    issue: "2026230",
    drawAt,
    numbers: [horse, monkey, 3, 4, 5, 6],
    special: 7,
    source: "fixture",
    verified: true,
  }, "2026-08-18T14:00:00.000Z");
  assert.equal(score.targetIssue, "2026230");
  assert.equal(score.actualMatched, true);
  assert.equal(score.unitProfit, 2);
});
