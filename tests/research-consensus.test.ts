import assert from "node:assert/strict";
import test from "node:test";
import { buildResearchConsensus } from "../lib/research-consensus.ts";
import type {
  ResearchRuleEvidence,
  ResearchTargetFamily,
} from "../lib/research-v2-types.ts";

function rule(
  id: string,
  family: ResearchTargetFamily,
  prediction: string,
  direction: "positive" | "negative" = "positive",
): ResearchRuleEvidence {
  return {
    ruleId: id,
    family: "position_transfer",
    description: `${family} ${prediction}`,
    direction,
    tier: "experimental",
    targetId: `main.position.2.${family}`,
    support: 120,
    hits: 55,
    hitRate: 0.458,
    baselineRate: family === "tail" ? 5 / 49 : 24 / 49,
    shrunkenRate: 0.44,
    lift: direction === "positive" ? 0.08 : -0.08,
    brierSkill: 0.04,
    nonWorseFoldRatio: 0.8,
    pValue: 0.01,
    qValue: 0.08,
    stabilityScore: 0.9,
    currentPrediction: prediction,
    currentTriggerMatched: true,
    resourceDecision: direction === "positive" ? "full_backtest" : "negative_pool",
    spec: {
      schemaVersion: 1,
      family: "position_transfer",
      target: { scope: "main.position.2", family },
      source: {
        field: "main.1",
        lag: 1,
        family,
        transform: "identity",
      },
      predicates: [],
    },
  };
}

test("compatible tail and parity rules reinforce their number intersection", () => {
  const [consensus] = buildResearchConsensus(
    [rule("tail-4", "tail", "4尾"), rule("even", "parity", "双")],
    "2026-07-28T13:30:00.000Z",
  );
  assert.equal(consensus.label, "下一期 · 第2正码");
  assert.deepEqual(
    consensus.topNumbers.map((item) => item.number).sort((a, b) => a - b),
    [4, 14, 24, 34, 44],
  );
  assert.ok(consensus.topNumbers.every((item) => item.probability > 1 / 49));
  assert.match(consensus.explanation, /(?:4尾与双|双与4尾)可以同时成立/);
});

test("repeated positive rules increase the same category while negative rules lower it", () => {
  const [positive] = buildResearchConsensus(
    [rule("tail-4-a", "tail", "4尾"), rule("tail-4-b", "tail", "4尾")],
    "2026-07-28T13:30:00.000Z",
  );
  const supported = positive.dimensions.find((item) => item.value === "4尾");
  assert.ok(supported);
  assert.equal(supported.positiveRuleCount, 2);
  assert.ok(supported.probability > supported.baseline);
  assert.match(positive.explanation, /2条正向规律同时指向4尾/);

  const [negative] = buildResearchConsensus(
    [
      rule("tail-4-negative", "tail", "4尾", "negative"),
      rule("even-negative", "parity", "双", "negative"),
    ],
    "2026-07-28T13:30:00.000Z",
  );
  const suppressed = negative.dimensions.find((item) => item.value === "4尾");
  assert.ok(suppressed);
  assert.ok(suppressed.probability < suppressed.baseline);
  assert.match(negative.explanation, /(?:4尾|双).*负向规律压低/);
});
