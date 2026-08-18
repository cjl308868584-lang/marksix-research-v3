import type { Draw } from "./lottery.ts";
import { buildSpecialNumberConsensus } from "./rolling-pattern-summary.ts";
import type {
  RollingPatternProduct,
  RollingPatternProductKind,
  RollingPatternProductScore,
  RollingPatternRecommendation,
  RollingPatternRun,
  RollingPatternSignal,
  RollingPatternValueHistory,
} from "./rolling-pattern-types.ts";
import { getZodiac, ZODIAC_NAMES } from "./zodiac.ts";

const PRIOR_STRENGTH = 4;

const COVERAGE_RECOMMENDATION_KINDS: RollingPatternProductKind[] = [
  "coverage_zodiac",
  "coverage_tail",
  "coverage_zodiac_pair",
  "coverage_zodiac_triple",
];

export function netOddsForProduct(
  kind: RollingPatternProductKind,
  values: readonly string[],
) {
  switch (kind) {
    case "coverage_zodiac":
      return values.includes("马") ? 0.75 : 1;
    case "coverage_tail":
      return values.includes("0尾") ? 1 : 0.75;
    case "coverage_zodiac_pair":
      return values.includes("马") ? 2 : 3;
    case "coverage_zodiac_triple":
      return values.includes("马") ? 7 : 9;
    case "special_number":
      return 47;
  }
}

export function breakEvenProbability(netOdds: number) {
  return 1 / (netOdds + 1);
}

export function expectedUnitValue(probability: number, netOdds: number) {
  return probability * netOdds - (1 - probability);
}

export function selectRollingPatternRecommendations(
  products: readonly RollingPatternProduct[],
  scope: "coverage_6_plus_1" | "special",
): RollingPatternRecommendation[] {
  const kinds = scope === "special"
    ? (["special_number"] satisfies RollingPatternProductKind[])
    : COVERAGE_RECOMMENDATION_KINDS;
  return kinds.map((kind) => {
    const candidates = products
      .filter((product) => product.kind === kind && product.expectedValue > 0)
      .sort((left, right) =>
        right.expectedValue - left.expectedValue ||
        right.forwardSettledCount - left.forwardSettledCount ||
        right.support - left.support ||
        right.strategyCount - left.strategyCount ||
        left.label.localeCompare(right.label, "zh-CN")
      );
    const product = candidates[0] ?? null;
    return {
      kind,
      product,
      reason: product
        ? recommendationReason(product)
        : "本期不推荐：当前冻结结果中没有结果高于赔率盈亏平衡线。",
    };
  });
}

export function buildRollingPatternProducts(
  run: RollingPatternRun,
): RollingPatternProduct[] {
  const coverage = run.signals.filter((signal) =>
    signal.rule.event.scope === "coverage_6_plus_1"
  );
  const special = run.signals.filter((signal) =>
    signal.rule.event.scope === "special"
  );
  const byEvent = groupByEvent(coverage);
  const singles = [...byEvent.values()]
    .filter((signals) => ["zodiac", "tail"].includes(signals[0].rule.event.family))
    .map((signals) => buildSingleProduct(run, signals));
  const zodiacGroups = [...byEvent.values()]
    .filter((signals) => signals[0].rule.event.family === "zodiac")
    .sort((left, right) =>
      ZODIAC_NAMES.indexOf(left[0].rule.event.value as never) -
      ZODIAC_NAMES.indexOf(right[0].rule.event.value as never)
    );
  const pairs = combinations(zodiacGroups, 2).map((groups) =>
    buildZodiacCombinationProduct(run, groups, "coverage_zodiac_pair")
  );
  const triples = combinations(zodiacGroups, 3).map((groups) =>
    buildZodiacCombinationProduct(run, groups, "coverage_zodiac_triple")
  );
  const specialNumbers = buildSpecialNumberConsensus(
    special,
    run.expectedDrawAt,
    15,
  ).map((entry) => {
    const value = String(entry.number).padStart(2, "0");
    return finalizeProduct(run, {
      kind: "special_number",
      label: value,
      values: [value],
      evidenceEventIds: entry.evidence.map((item) => item.eventId),
      strategyCount: entry.strategyCount,
      support: 0,
      hits: 0,
      baselineProbability: 1 / 49,
    });
  });
  return [...singles, ...pairs, ...triples, ...specialNumbers]
    .sort((left, right) =>
      right.expectedValue - left.expectedValue ||
      right.support - left.support ||
      right.strategyCount - left.strategyCount ||
      left.label.localeCompare(right.label, "zh-CN")
    )
    .map((product, index) => ({ ...product, rank: index + 1 }));
}

export function applyForwardProductHistory(
  product: RollingPatternProduct,
  settledCount: number,
  hitCount: number,
): RollingPatternProduct {
  const boundedSettled = Math.max(0, Math.trunc(settledCount));
  const boundedHits = Math.max(0, Math.min(boundedSettled, Math.trunc(hitCount)));
  if (boundedSettled === 0) return product;
  const estimatedProbability = (boundedHits + product.estimatedProbability * PRIOR_STRENGTH) /
    (boundedSettled + PRIOR_STRENGTH);
  const expectedValue = expectedUnitValue(estimatedProbability, product.netOdds);
  return {
    ...product,
    estimatedProbability,
    expectedValue,
    valueStatus: expectedValue > 0 ? "positive" : "negative",
    forwardSettledCount: boundedSettled,
    forwardHitCount: boundedHits,
    forwardMissCount: boundedSettled - boundedHits,
  };
}

export function settleRollingPatternProduct(
  product: RollingPatternProduct,
  draw: Draw,
  scoredAt: string,
): RollingPatternProductScore {
  if (!draw.verified || draw.game !== product.game || draw.issue !== product.targetIssue) {
    throw new Error("只能结算同彩种、同目标期的已核验开奖结果");
  }
  const allNumbers = [...draw.numbers, draw.special];
  let actualMatched = false;
  if (product.kind === "special_number") {
    actualMatched = draw.special === Number(product.values[0]);
  } else if (product.kind === "coverage_tail") {
    actualMatched = product.values.every((value) =>
      allNumbers.some((number) => `${number % 10}尾` === value)
    );
  } else {
    const actualZodiacs = new Set(allNumbers.map((number) => getZodiac(number, draw.drawAt)));
    actualMatched = product.values.every((value) => actualZodiacs.has(value as never));
  }
  return {
    runId: product.runId,
    productId: product.productId,
    game: product.game,
    targetIssue: product.targetIssue,
    actualMatched,
    unitProfit: actualMatched ? product.netOdds : -1,
    actualNumbers: allNumbers,
    actualSpecial: draw.special,
    scoredAt,
  };
}

export function summarizeProductPerformance(
  products: readonly RollingPatternProduct[],
  scores: readonly RollingPatternProductScore[],
): RollingPatternValueHistory[] {
  const productByIdentity = new Map(products.map((item) => [item.productId, item]));
  const groups = new Map<string, RollingPatternValueHistory>();
  for (const score of scores) {
    const product = productByIdentity.get(score.productId);
    if (!product) continue;
    const key = `${product.kind}:${product.values.join("+")}`;
    const current = groups.get(key) ?? {
      productId: key,
      kind: product.kind,
      label: product.label,
      values: product.values,
      settledCount: 0,
      hitCount: 0,
      missCount: 0,
      cumulativeProfit: 0,
      roi: 0,
    };
    current.settledCount += 1;
    current.hitCount += score.actualMatched ? 1 : 0;
    current.missCount += score.actualMatched ? 0 : 1;
    current.cumulativeProfit += score.unitProfit;
    current.roi = current.cumulativeProfit / current.settledCount;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.roi - left.roi);
}

function recommendationReason(product: RollingPatternProduct) {
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
  const expected = `${product.expectedValue >= 0 ? "+" : ""}${product.expectedValue.toFixed(2)}`;
  const forward = product.forwardSettledCount > 0
    ? `已前瞻结算${product.forwardSettledCount}期，命中${product.forwardHitCount}期`
    : "尚无独立前瞻结算";
  return `当前30期共同审计${product.support}次、命中${product.hits}次；${forward}。参考概率${percent(product.estimatedProbability)}高于赔率盈亏线${percent(product.breakEvenProbability)}，每1单位期望${expected}。`;
}

function buildSingleProduct(
  run: RollingPatternRun,
  signals: RollingPatternSignal[],
) {
  const event = signals[0].rule.event;
  const audit = combinedAudit(signals);
  return finalizeProduct(run, {
    kind: event.family === "zodiac" ? "coverage_zodiac" : "coverage_tail",
    label: event.value,
    values: [event.value],
    evidenceEventIds: [event.eventId],
    strategyCount: new Set(signals.map((signal) => signal.rule.ruleId)).size,
    support: audit.size,
    hits: [...audit.values()].filter(Boolean).length,
    baselineProbability: weightedBaseline(signals),
  });
}

function buildZodiacCombinationProduct(
  run: RollingPatternRun,
  groups: RollingPatternSignal[][],
  kind: "coverage_zodiac_pair" | "coverage_zodiac_triple",
) {
  const audits = groups.map(combinedAudit);
  const sharedIssues = [...audits[0].keys()].filter((issue) =>
    audits.every((audit) => audit.has(issue))
  );
  const hits = sharedIssues.filter((issue) =>
    audits.every((audit) => audit.get(issue) === true)
  ).length;
  const values = groups.map((signals) => signals[0].rule.event.value);
  return finalizeProduct(run, {
    kind,
    label: values.join("＋"),
    values,
    evidenceEventIds: groups.map((signals) => signals[0].rule.event.eventId),
    strategyCount: new Set(groups.flatMap((signals) =>
      signals.map((signal) => signal.rule.ruleId)
    )).size,
    support: sharedIssues.length,
    hits,
    baselineProbability: zodiacCombinationBaseline(
      groups.map((signals) => signals[0].rule.event.memberCount),
    ),
  });
}

function finalizeProduct(
  run: RollingPatternRun,
  input: {
    kind: RollingPatternProductKind;
    label: string;
    values: string[];
    evidenceEventIds: string[];
    strategyCount: number;
    support: number;
    hits: number;
    baselineProbability: number;
  },
): RollingPatternProduct {
  const estimatedProbability = (input.hits + input.baselineProbability * PRIOR_STRENGTH) /
    (input.support + PRIOR_STRENGTH);
  const netOdds = netOddsForProduct(input.kind, input.values);
  const expectedValue = expectedUnitValue(estimatedProbability, netOdds);
  return {
    runId: run.runId,
    productId: `${run.runId}:${input.kind}:${input.values.join("-")}`,
    game: run.game,
    targetIssue: run.targetIssue,
    scope: input.kind === "special_number" ? "special" : "coverage_6_plus_1",
    kind: input.kind,
    label: input.label,
    values: input.values,
    evidenceEventIds: input.evidenceEventIds,
    strategyCount: input.strategyCount,
    support: input.support,
    hits: input.hits,
    misses: input.support - input.hits,
    baselineProbability: input.baselineProbability,
    estimatedProbability,
    netOdds,
    breakEvenProbability: breakEvenProbability(netOdds),
    expectedValue,
    valueStatus: expectedValue > 0 ? "positive" : "negative",
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardMissCount: 0,
    rank: 0,
    frozenAt: run.frozenAt,
  };
}

function groupByEvent(signals: readonly RollingPatternSignal[]) {
  const groups = new Map<string, RollingPatternSignal[]>();
  for (const signal of signals) {
    const eventId = signal.rule.event.eventId;
    groups.set(eventId, [...(groups.get(eventId) ?? []), signal]);
  }
  return groups;
}

function combinedAudit(signals: readonly RollingPatternSignal[]) {
  const audit = new Map<string, boolean>();
  for (const signal of signals) {
    for (const entry of signal.audit) audit.set(entry.targetIssue, entry.matched);
  }
  return audit;
}

function weightedBaseline(signals: readonly RollingPatternSignal[]) {
  const weight = signals.reduce((total, signal) => total + Math.max(1, signal.support), 0);
  return signals.reduce(
    (total, signal) => total + signal.baseline * Math.max(1, signal.support),
    0,
  ) / weight;
}

function zodiacCombinationBaseline(memberCounts: readonly number[]) {
  const denominator = choose(49, 7);
  let probability = 0;
  const subsetCount = 1 << memberCounts.length;
  for (let mask = 0; mask < subsetCount; mask += 1) {
    let excluded = 0;
    let bits = 0;
    for (let index = 0; index < memberCounts.length; index += 1) {
      if (mask & (1 << index)) {
        excluded += memberCounts[index];
        bits += 1;
      }
    }
    probability += (bits % 2 === 0 ? 1 : -1) * choose(49 - excluded, 7) / denominator;
  }
  return probability;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (selected.length === size) {
      result.push(selected);
      return;
    }
    for (let index = start; index <= items.length - (size - selected.length); index += 1) {
      visit(index + 1, [...selected, items[index]]);
    }
  };
  visit(0, []);
  return result;
}

function choose(n: number, k: number) {
  if (k < 0 || k > n) return 0;
  const bounded = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= bounded; index += 1) {
    result = result * (n - bounded + index) / index;
  }
  return result;
}
