import assert from "node:assert/strict";
import test from "node:test";
import type {
  RollingPatternProduct,
  RollingPatternProductKind,
  RollingPatternRun,
  RollingPatternSignal,
} from "../lib/rolling-pattern-types.ts";
import {
  buildUnifiedRollingPatternProducts,
  selectMandatoryProductRecommendations,
} from "../lib/rolling-pattern-value.ts";

function runFixture(signals: RollingPatternSignal[]): RollingPatternRun {
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
      dataHash: "fixture-data-v1",
    },
    funnel: {
      generated: signals.length,
      currentTriggered: signals.length,
      deduplicated: signals.length,
      aboveBaseline: signals.length,
      qualified: signals.length,
    },
    scopeFunnels: {
      coverage_6_plus_1: {
        generated: signals.length,
        currentTriggered: signals.length,
        deduplicated: signals.length,
        aboveBaseline: signals.length,
        qualified: signals.length,
      },
      special: {
        generated: 0,
        currentTriggered: 0,
        deduplicated: 0,
        aboveBaseline: 0,
        qualified: 0,
      },
    },
    signals,
  };
}

function countByKind(products: readonly RollingPatternProduct[]) {
  return Object.fromEntries([
    "coverage_zodiac",
    "coverage_tail",
    "coverage_zodiac_pair",
    "coverage_zodiac_triple",
    "special_number",
  ].map((kind) => [
    kind,
    products.filter((product) => product.kind === kind).length,
  ])) as Record<RollingPatternProductKind, number>;
}

function monkeySignal(): RollingPatternSignal {
  const eventId = "coverage_6_plus_1:zodiac:猴:gte1";
  return {
    rule: {
      ruleId: "rule-monkey",
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
        value: "猴",
        label: "下一期6+1至少出现一次猴",
        threshold: 1,
        memberCount: 4,
      },
      prediction: true,
      canonicalJson: eventId,
      conditionLabel: "本期条件成立",
      predictionLabel: "下一期6+1至少出现一次猴",
      relationLabel: "条件 → 猴",
      description: "fixture",
    },
    currentTriggered: true,
    support: 3,
    hits: 3,
    rawRate: 1,
    baseline: 0.4741494500976464,
    rawUplift: 0.5258505499023537,
    posteriorRate: 0.6995139714843693,
    posteriorUplift: 0.225364521386723,
    pValue: 0.2,
    qValue: 1,
    evidenceTier: "experimental",
    sampleLabel: "有限样本",
    relatedRuleCount: 1,
    currentEvidence: [],
    stateHistory: [],
    audit: ["2026226", "2026227", "2026228"].map((issue) => ({
      sourceIssue: String(Number(issue) - 1),
      targetIssue: issue,
      targetDrawAt: "2026-08-01T21:32:00+08:00",
      conditionEvidence: [],
      result: {
        issue,
        drawAt: "2026-08-01T21:32:00+08:00",
        matched: true,
        count: 1,
      },
      matched: true,
    })),
  };
}

function runFixtureWithMonkey() {
  return runFixture([monkeySignal()]);
}

function literalProduct(
  kind: RollingPatternProductKind,
  values: string[],
  expectedValue: number,
) {
  return {
    runId: "run-negative",
    productId: `run-negative:${kind}:${values.join("-")}`,
    dataVersion: "fixture-data-v1",
    game: "new_macau" as const,
    targetIssue: "2026230",
    scope: kind === "special_number" ? "special" as const : "coverage_6_plus_1" as const,
    kind,
    label: values.join("＋"),
    values,
    evidenceEventIds: [],
    strategyCount: 0,
    support: 0,
    hits: 0,
    misses: 0,
    baselineProbability: 0.1,
    patternProbability: 0.1,
    legacySeedProbability: 0.1,
    estimatedProbability: 0.1,
    netOdds: 1,
    breakEvenProbability: 0.5,
    expectedValue,
    valueStatus: "negative" as const,
    legacySettledCount: 0,
    legacyHitCount: 0,
    learningSettledCount: 0,
    learningHitCount: 0,
    learningMissCount: 0,
    sourceKind: "derived_baseline" as const,
    sourceProductId: null,
    derivedDefinitionHash: "fixture-definition-v1",
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardMissCount: 0,
    rank: 0,
    frozenAt: "2026-08-17T14:02:00.000Z",
  };
}

function allNegativeProductFixture() {
  return [
    literalProduct("coverage_zodiac", ["猴"], -0.1),
    literalProduct("coverage_tail", ["7尾"], -0.2),
    literalProduct("coverage_zodiac_pair", ["猴", "鸡"], -0.3),
    literalProduct("coverage_zodiac_triple", ["猴", "鸡", "狗"], -0.4),
    literalProduct("special_number", ["03"], -0.5),
  ];
}

function historiesFixture(input: {
  key: string;
  legacy: { settledCount: number; hitCount: number };
  learned: { settledCount: number; hitCount: number };
}) {
  return {
    legacy: new Map([[input.key, input.legacy]]),
    learned: new Map([[input.key, input.learned]]),
    legacyProductIds: new Map([[input.key, "legacy-product-monkey"]]),
  };
}

function findProduct(
  products: readonly RollingPatternProduct[],
  kind: RollingPatternProductKind,
  value: string,
) {
  const product = products.find((item) =>
    item.kind === kind && item.values.join("+") === value
  );
  assert.ok(product);
  return product;
}

test("a complete window always builds the full five-category universe", () => {
  const products = buildUnifiedRollingPatternProducts(runFixture([]));
  assert.equal(products.length, 357);
  assert.deepEqual(countByKind(products), {
    coverage_zodiac: 12,
    coverage_tail: 10,
    coverage_zodiac_pair: 66,
    coverage_zodiac_triple: 220,
    special_number: 49,
  });
  assert.ok(products.every((item) => item.support === 0));
});

test("public ranks use learned sample count and ASCII result keys", () => {
  const histories = {
    legacy: new Map(),
    learned: new Map([
      ["special_number:01", { settledCount: 49, hitCount: 1 }],
      ["special_number:02", { settledCount: 98, hitCount: 2 }],
    ]),
    legacyProductIds: new Map(),
  };
  const products = buildUnifiedRollingPatternProducts(runFixture([]), histories);
  const special01 = findProduct(products, "special_number", "01");
  const special02 = findProduct(products, "special_number", "02");
  const ox = findProduct(products, "coverage_zodiac", "牛");
  const dragon = findProduct(products, "coverage_zodiac", "龙");
  const selected = selectMandatoryProductRecommendations(products, 1);

  assert.equal(special01.expectedValue, special02.expectedValue);
  assert.ok(special02.learningSettledCount > special01.learningSettledCount);
  assert.ok(special02.rank < special01.rank);
  assert.equal(selected.find((item) => item.kind === "special_number")?.resultKey, "02");
  assert.equal(ox.expectedValue, dragon.expectedValue);
  assert.ok(ox.rank < dragon.rank);
  assert.equal(products[special02.rank - 1], special02);
  assert.equal(products[ox.rank - 1], ox);
});

test("every category selects one item even when every EV is negative", () => {
  const products = allNegativeProductFixture();
  const selected = selectMandatoryProductRecommendations(products, 1);
  assert.equal(selected.length, 5);
  assert.deepEqual(selected.map((item) => item.kind), [
    "coverage_zodiac",
    "coverage_tail",
    "coverage_zodiac_pair",
    "coverage_zodiac_triple",
    "special_number",
  ]);
  assert.ok(selected.every((item) => item.expectedValue < 0));
  assert.ok(selected.every((item) => !item.reason.includes("本期不推荐")));
});

test("authoritative recommendations never infer ledger provenance from v1 products", () => {
  const v1Products = allNegativeProductFixture().map((product) => {
    const copy: Partial<RollingPatternProduct> = { ...product };
    delete copy.sourceKind;
    delete copy.sourceProductId;
    return copy as RollingPatternProduct;
  });
  const selected = selectMandatoryProductRecommendations(v1Products, 2);

  assert.ok(selected.every((item) => item.sourceKind === "derived_baseline"));
  assert.ok(selected.every((item) => item.sourceProductId === null));
});

test("legacy seed and new learning are applied once in separate stages", () => {
  const histories = historiesFixture({
    key: "coverage_zodiac:猴",
    legacy: { settledCount: 9, hitCount: 7 },
    learned: { settledCount: 1, hitCount: 0 },
  });
  const products = buildUnifiedRollingPatternProducts(runFixtureWithMonkey(), histories);
  const monkey = findProduct(products, "coverage_zodiac", "猴");
  const selectedMonkey = selectMandatoryProductRecommendations(products, 3)
    .find((item) => item.kind === "coverage_zodiac");
  assert.equal(monkey.patternProbability, 0.6995139714843693);
  assert.equal(monkey.legacySeedProbability, 0.7536966066105752);
  assert.equal(monkey.estimatedProbability, 0.6029572852884601);
  assert.equal(monkey.learningSettledCount, 1);
  assert.equal(monkey.learningHitCount, 0);
  assert.equal(monkey.sourceKind, "ledger");
  assert.equal(monkey.sourceProductId, "legacy-product-monkey");
  assert.notEqual(monkey.productId, monkey.sourceProductId);
  assert.equal(selectedMonkey?.sourceKind, "ledger");
  assert.equal(selectedMonkey?.sourceProductId, "legacy-product-monkey");
});
