import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  AuthoritativeRecommendation,
  RollingPatternProduct,
  RollingPatternProductKind,
  RollingPatternRun,
} from "../lib/rolling-pattern-types.ts";
import {
  NEW_MACAU_2026231_AUTHORITATIVE_HASH,
  NEW_MACAU_2026231_ROLLOUT,
} from "../lib/forward-learning-rollouts.ts";
import {
  canonicalRecommendationPayload,
  canonicalRevisionPayload,
  mapProductsToRevisionSnapshot,
} from "../lib/unified-product-learning.ts";

const AUTHORITATIVE_ROWS = [
  {
    kind: "coverage_zodiac" as const,
    resultKey: "猴",
    values: ["猴"],
    p30: 0.6995139714843693,
    learnedProbability: 0.7536966066105752,
    netOdds: 1,
    breakEvenProbability: 0.5,
    expectedValue: 0.5073932132211505,
    hits: 17,
    support: 23,
    legacyHitCount: 7,
    legacySettledCount: 9,
  },
  {
    kind: "coverage_tail" as const,
    resultKey: "8尾",
    values: ["8尾"],
    p30: 0.7775225083273186,
    learnedProbability: 0.8546223102545596,
    netOdds: 0.75,
    breakEvenProbability: 0.5714285714285714,
    expectedValue: 0.49558904294547923,
    hits: 18,
    support: 22,
    legacyHitCount: 8,
    legacySettledCount: 9,
  },
  {
    kind: "coverage_zodiac_pair" as const,
    resultKey: "蛇+猴",
    values: ["蛇", "猴"],
    p30: 0.3675265118104436,
    learnedProbability: 0.5746235420955211,
    netOdds: 3,
    breakEvenProbability: 0.25,
    expectedValue: 1.2984941683820845,
    hits: 8,
    support: 20,
    legacyHitCount: 6,
    legacySettledCount: 9,
  },
  {
    kind: "coverage_zodiac_triple" as const,
    resultKey: "蛇+马+猴",
    values: ["蛇", "马", "猴"],
    p30: 0.29017271661601063,
    learnedProbability: 0.47389929742031095,
    netOdds: 7,
    breakEvenProbability: 0.125,
    expectedValue: 2.7911943793624876,
    hits: 6,
    support: 18,
    legacyHitCount: 5,
    legacySettledCount: 9,
  },
  {
    kind: "special_number" as const,
    resultKey: "01",
    values: ["01"],
    p30: 0.02040816326530612,
    learnedProbability: 0.08320251177394035,
    netOdds: 47,
    breakEvenProbability: 0.020833333333333332,
    expectedValue: 2.993720565149137,
    hits: 0,
    support: 0,
    legacyHitCount: 1,
    legacySettledCount: 9,
  },
] as const;

test("the first unified revision freezes the authoritative 2026231 five", () => {
  const fixture = authoritativeRunAndProductsFixture();
  const snapshot = mapProductsToRevisionSnapshot({
    ...fixture,
    rollout: NEW_MACAU_2026231_ROLLOUT,
    revision: 2,
    reason: "correct-v1-bootstrap",
  });

  assert.equal(snapshot.candidates.length, 357);
  assert.deepEqual(snapshot.forecasts.map((item) => item.resultKey), [
    "猴", "8尾", "蛇+猴", "蛇+马+猴", "01",
  ]);
  assert.deepEqual(snapshot.forecasts.map((item) => ({
    p30: item.patternProbability,
    pLearned: item.learnedProbability,
    netOdds: item.netOdds,
    breakEven: item.breakEvenProbability,
    expectedValue: item.expectedValue,
    support: item.support,
    hits: item.hits,
    legacySettledCount: item.legacySettledCount,
    legacyHitCount: item.legacyHitCount,
  })), AUTHORITATIVE_ROWS.map((item) => ({
    p30: item.p30,
    pLearned: item.learnedProbability,
    netOdds: item.netOdds,
    breakEven: item.breakEvenProbability,
    expectedValue: item.expectedValue,
    support: item.support,
    hits: item.hits,
    legacySettledCount: item.legacySettledCount,
    legacyHitCount: item.legacyHitCount,
  })));
  assert.equal(snapshot.recommendationHash, NEW_MACAU_2026231_AUTHORITATIVE_HASH);
  assert.ok(snapshot.forecasts.every((item) => item.revision === 2));
  assert.ok(snapshot.forecasts.every((item) => item.learningSettledCount === 0));
  assert.equal(
    sha256(canonicalRecommendationPayload(snapshot.recommendations)),
    NEW_MACAU_2026231_AUTHORITATIVE_HASH,
  );
  assert.equal(sha256(canonicalRevisionPayload(snapshot)), snapshot.contentHash);
  assert.notEqual(snapshot.contentHash, snapshot.recommendationHash);
  assert.ok(snapshot.candidates.every((item) =>
    item.candidateId.startsWith(`candidate:unified-v2:${snapshot.revisionId}:`)
  ));
});

test("the revision hash covers every frozen candidate compatibility field", () => {
  const fixture = authoritativeRunAndProductsFixture();
  const snapshot = mapProductsToRevisionSnapshot({
    ...fixture,
    rollout: NEW_MACAU_2026231_ROLLOUT,
    revision: 2,
    reason: "correct-v1-bootstrap",
  });
  const changed = {
    ...snapshot,
    candidates: snapshot.candidates.map((candidate, index) =>
      index === 0 ? { ...candidate, rawRuleCount: candidate.rawRuleCount + 1 } : candidate
    ),
  };

  assert.notEqual(canonicalRevisionPayload(changed), canonicalRevisionPayload(snapshot));

  const changedForecast = {
    ...snapshot,
    forecasts: snapshot.forecasts.map((forecast, index) =>
      index === 0 ? { ...forecast, official: false as true } : forecast
    ),
  };
  assert.notEqual(
    canonicalRevisionPayload(changedForecast),
    canonicalRevisionPayload(snapshot),
  );
});

function authoritativeRunAndProductsFixture(): {
  run: RollingPatternRun;
  products: RollingPatternProduct[];
  recommendations: AuthoritativeRecommendation[];
} {
  const run = authoritativeRun();
  const selectedByKey = new Map(AUTHORITATIVE_ROWS.map((item) => [
    `${item.kind}:${item.resultKey}`,
    item,
  ]));
  const products = candidateDefinitions().map(({ kind, values }, index) => {
    const resultKey = values.join("+");
    const selected = selectedByKey.get(`${kind}:${resultKey}`);
    return productFixture(run, kind, values, index, selected);
  });
  const recommendations = AUTHORITATIVE_ROWS.map((row) => {
    const product = products.find((item) =>
      item.kind === row.kind && item.values.join("+") === row.resultKey
    );
    assert.ok(product);
    return {
      kind: row.kind,
      resultKey: row.resultKey,
      values: [...row.values],
      sourceRunId: run.runId,
      sourceProductId: product.productId,
      sourceKind: "ledger" as const,
      dataVersion: run.window.dataHash,
      revision: 2,
      p30: row.p30,
      legacySeedProbability: row.learnedProbability,
      learnedProbability: row.learnedProbability,
      netOdds: row.netOdds,
      breakEvenProbability: row.breakEvenProbability,
      expectedValue: row.expectedValue,
      legacySettledCount: row.legacySettledCount,
      legacyHitCount: row.legacyHitCount,
      learningSettledCount: 0,
      learningHitCount: 0,
      product,
      reason: "fixture authority",
    };
  });
  return { run, products, recommendations };
}

function authoritativeRun(): RollingPatternRun {
  return {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: "rp_new_macau_2026231_ce1e7c5e05d6a18a",
    game: "new_macau",
    sourceIssue: "2026230",
    targetIssue: "2026231",
    expectedDrawAt: "2026-08-19T13:32:00.000Z",
    generatedAt: "2026-08-19T12:00:00.000Z",
    frozenAt: "2026-08-19T12:00:00.000Z",
    status: "completed",
    window: {
      game: "new_macau",
      drawCount: 30,
      oldestIssue: "2026201",
      newestIssue: "2026230",
      dataHash: "e1bb9fe08f06fa838a4959f8cd5d4b7c9c6154480089e03e562d3df943ecec6a",
    },
    funnel: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    scopeFunnels: {
      coverage_6_plus_1: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
      special: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    },
    signals: [],
  };
}

function productFixture(
  run: RollingPatternRun,
  kind: RollingPatternProductKind,
  values: string[],
  index: number,
  selected: typeof AUTHORITATIVE_ROWS[number] | undefined,
): RollingPatternProduct {
  const learnedProbability = selected?.learnedProbability ?? 0.001;
  const netOdds = selected?.netOdds ?? 0.1;
  return {
    runId: run.runId,
    productId: `${run.runId}:${kind}:${values.join("-")}`,
    dataVersion: run.window.dataHash,
    game: run.game,
    targetIssue: run.targetIssue,
    scope: kind === "special_number" ? "special" : "coverage_6_plus_1",
    kind,
    label: values.join("＋"),
    values,
    evidenceEventIds: [],
    strategyCount: 0,
    support: selected?.support ?? 0,
    hits: selected?.hits ?? 0,
    misses: (selected?.support ?? 0) - (selected?.hits ?? 0),
    baselineProbability: selected?.p30 ?? 0.001,
    patternProbability: selected?.p30 ?? 0.001,
    legacySeedProbability: learnedProbability,
    estimatedProbability: learnedProbability,
    netOdds,
    breakEvenProbability: selected?.breakEvenProbability ?? 1 / (netOdds + 1),
    expectedValue: selected?.expectedValue ?? -0.99 - index / 1_000_000,
    valueStatus: selected ? "positive" : "negative",
    legacySettledCount: selected?.legacySettledCount ?? 0,
    legacyHitCount: selected?.legacyHitCount ?? 0,
    learningSettledCount: 0,
    learningHitCount: 0,
    learningMissCount: 0,
    sourceKind: selected ? "ledger" : "derived_baseline",
    sourceProductId: selected ? `${run.runId}:${kind}:${values.join("-")}` : null,
    derivedDefinitionHash: `fixture-definition-${index}`,
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardMissCount: 0,
    rank: index + 1,
    frozenAt: run.frozenAt,
  };
}

function candidateDefinitions() {
  const zodiacs = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
  const definitions: Array<{ kind: RollingPatternProductKind; values: string[] }> = [
    ...zodiacs.map((value) => ({ kind: "coverage_zodiac" as const, values: [value] })),
    ...Array.from({ length: 10 }, (_, tail) => ({ kind: "coverage_tail" as const, values: [`${tail}尾`] })),
    ...combinations(zodiacs, 2).map((values) => ({ kind: "coverage_zodiac_pair" as const, values })),
    ...combinations(zodiacs, 3).map((values) => ({ kind: "coverage_zodiac_triple" as const, values })),
    ...Array.from({ length: 49 }, (_, index) => ({
      kind: "special_number" as const,
      values: [String(index + 1).padStart(2, "0")],
    })),
  ];
  assert.equal(definitions.length, 357);
  return definitions;
}

function combinations(values: string[], size: number) {
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

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
