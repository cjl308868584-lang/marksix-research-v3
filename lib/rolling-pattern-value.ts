import type { Draw } from "./lottery.ts";
import { buildSpecialNumberConsensus } from "./rolling-pattern-summary.ts";
import { exactSlotBaseline } from "./forward-learning-math.ts";
import type {
  AuthoritativeRecommendation,
  ProductHistoryCounts,
  RollingPatternProduct,
  RollingPatternProductKind,
  RollingPatternProductScore,
  RollingPatternRecommendation,
  RollingPatternRun,
  RollingPatternSignal,
  RollingPatternValueHistory,
  UnifiedProductHistories,
} from "./rolling-pattern-types.ts";
import { getZodiac, ZODIAC_NAMES } from "./zodiac.ts";

const PRIOR_STRENGTH = 4;

const COVERAGE_RECOMMENDATION_KINDS: RollingPatternProductKind[] = [
  "coverage_zodiac",
  "coverage_tail",
  "coverage_zodiac_pair",
  "coverage_zodiac_triple",
];

const MANDATORY_PRODUCT_KINDS: RollingPatternProductKind[] = [
  ...COVERAGE_RECOMMENDATION_KINDS,
  "special_number",
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
    const product = selectTopProduct(products, kind);
    return {
      kind,
      product,
      reason: product
        ? recommendationReason(product)
        : "当前冻结结果中缺少该类别产品。",
    };
  });
}

export function selectMandatoryProductRecommendations(
  products: readonly RollingPatternProduct[],
  revision: number,
): AuthoritativeRecommendation[] {
  return MANDATORY_PRODUCT_KINDS.map((kind) => {
    const product = selectTopProduct(products, kind);
    if (!product) throw new Error(`统一产品类别缺失：${kind}`);
    return buildAuthoritativeRecommendation(product, revision);
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

export function buildUnifiedRollingPatternProducts(
  run: RollingPatternRun,
  histories?: UnifiedProductHistories,
): RollingPatternProduct[] {
  const coverage = run.signals.filter((signal) =>
    signal.rule.event.scope === "coverage_6_plus_1"
  );
  const special = run.signals.filter((signal) =>
    signal.rule.event.scope === "special"
  );
  const coverageGroups = groupByEvent(coverage);
  const zodiacGroups = new Map(ZODIAC_NAMES.map((value) => [
    value,
    coverageGroups.get(`coverage_6_plus_1:zodiac:${value}:gte1`),
  ]));
  const singles = [
    ...ZODIAC_NAMES.map((value) => {
      const signals = zodiacGroups.get(value);
      return signals?.length
        ? buildSingleProduct(run, signals, histories)
        : buildBaselineProduct(run, "coverage_zodiac", [value], histories);
    }),
    ...Array.from({ length: 10 }, (_, tail) => `${tail}尾`).map((value) => {
      const signals = coverageGroups.get(`coverage_6_plus_1:tail:${value}:gte1`);
      return signals?.length
        ? buildSingleProduct(run, signals, histories)
        : buildBaselineProduct(run, "coverage_tail", [value], histories);
    }),
  ];
  const zodiacValues = [...ZODIAC_NAMES];
  const pairs = combinations(zodiacValues, 2).map((values) => {
    const groups = values.map((value) => zodiacGroups.get(value));
    return groups.every((group): group is RollingPatternSignal[] => Boolean(group?.length))
      ? buildZodiacCombinationProduct(run, groups, "coverage_zodiac_pair", histories)
      : buildBaselineProduct(run, "coverage_zodiac_pair", values, histories);
  });
  const triples = combinations(zodiacValues, 3).map((values) => {
    const groups = values.map((value) => zodiacGroups.get(value));
    return groups.every((group): group is RollingPatternSignal[] => Boolean(group?.length))
      ? buildZodiacCombinationProduct(run, groups, "coverage_zodiac_triple", histories)
      : buildBaselineProduct(run, "coverage_zodiac_triple", values, histories);
  });
  const specialEvidence = new Map(buildSpecialNumberConsensus(
    special,
    run.expectedDrawAt,
    49,
  ).map((entry) => [entry.number, entry]));
  const specialNumbers = Array.from({ length: 49 }, (_, index) => index + 1).map((number) => {
    const value = String(number).padStart(2, "0");
    const entry = specialEvidence.get(number);
    return entry
      ? finalizeProduct(run, {
        kind: "special_number",
        label: value,
        values: [value],
        evidenceEventIds: entry.evidence.map((item) => item.eventId),
        strategyCount: entry.strategyCount,
        support: 0,
        hits: 0,
        baselineProbability: exactSlotBaseline(
          "special_number",
          [value],
          run.expectedDrawAt,
        ),
      }, histories)
      : buildBaselineProduct(run, "special_number", [value], histories);
  });
  const products = [...singles, ...pairs, ...triples, ...specialNumbers]
    .sort(compareProductsForRecommendation)
    .map((product, index) => ({ ...product, rank: index + 1 }));
  if (products.length !== 357) {
    throw new Error(`统一产品候选不完整：${products.length}/357`);
  }
  return products;
}

export function applyForwardProductHistory(
  product: RollingPatternProduct,
  settledCount: number,
  hitCount: number,
): RollingPatternProduct {
  const boundedSettled = Math.max(0, Math.trunc(settledCount));
  const boundedHits = Math.max(0, Math.min(boundedSettled, Math.trunc(hitCount)));
  if (boundedSettled === 0) return product;
  const estimatedProbability = posteriorFromHistory(
    product.legacySeedProbability ?? product.patternProbability ?? product.estimatedProbability,
    { settledCount: boundedSettled, hitCount: boundedHits },
  );
  const expectedValue = expectedUnitValue(estimatedProbability, product.netOdds);
  return {
    ...product,
    estimatedProbability,
    expectedValue,
    valueStatus: expectedValue > 0 ? "positive" : "negative",
    learningSettledCount: boundedSettled,
    learningHitCount: boundedHits,
    learningMissCount: boundedSettled - boundedHits,
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
  const learningSettledCount = product.learningSettledCount ??
    product.forwardSettledCount ?? 0;
  const learningHitCount = product.learningHitCount ?? product.forwardHitCount ?? 0;
  const forward = learningSettledCount > 0
    ? `已前瞻结算${learningSettledCount}期，命中${learningHitCount}期`
    : "尚无独立前瞻结算";
  const risk = product.expectedValue >= 0
    ? `高于赔率盈亏线${percent(product.breakEvenProbability)}`
    : `低于赔率盈亏线${percent(product.breakEvenProbability)}，属于负期望风险项`;
  return `当前30期共同审计${product.support}次、命中${product.hits}次；${forward}。参考概率${percent(product.estimatedProbability)}${risk}，每1单位期望${expected}。`;
}

function buildSingleProduct(
  run: RollingPatternRun,
  signals: RollingPatternSignal[],
  histories?: UnifiedProductHistories,
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
  }, histories);
}

function buildZodiacCombinationProduct(
  run: RollingPatternRun,
  groups: RollingPatternSignal[][],
  kind: "coverage_zodiac_pair" | "coverage_zodiac_triple",
  histories?: UnifiedProductHistories,
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
  }, histories);
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
  histories?: UnifiedProductHistories,
): RollingPatternProduct {
  const patternProbability = (input.hits + input.baselineProbability * PRIOR_STRENGTH) /
    (input.support + PRIOR_STRENGTH);
  const historyKey = `${input.kind}:${input.values.join("+")}`;
  const legacyHistory = boundedHistory(histories?.legacy.get(historyKey));
  const learnedHistory = boundedHistory(histories?.learned.get(historyKey));
  const legacySeedProbability = posteriorFromHistory(patternProbability, legacyHistory);
  const estimatedProbability = posteriorFromHistory(legacySeedProbability, learnedHistory);
  const netOdds = netOddsForProduct(input.kind, input.values);
  const expectedValue = expectedUnitValue(estimatedProbability, netOdds);
  const sourceProductId = histories?.legacyProductIds.has(historyKey)
    ? histories.legacyProductIds.get(historyKey) ?? null
    : null;
  return {
    runId: run.runId,
    productId: `${run.runId}:${input.kind}:${input.values.join("-")}`,
    dataVersion: run.window.dataHash,
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
    patternProbability,
    legacySeedProbability,
    estimatedProbability,
    netOdds,
    breakEvenProbability: breakEvenProbability(netOdds),
    expectedValue,
    valueStatus: expectedValue > 0 ? "positive" : "negative",
    legacySettledCount: legacyHistory?.settledCount ?? 0,
    legacyHitCount: legacyHistory?.hitCount ?? 0,
    learningSettledCount: learnedHistory?.settledCount ?? 0,
    learningHitCount: learnedHistory?.hitCount ?? 0,
    learningMissCount: (learnedHistory?.settledCount ?? 0) -
      (learnedHistory?.hitCount ?? 0),
    sourceKind: sourceProductId === null ? "derived_baseline" : "ledger",
    sourceProductId,
    derivedDefinitionHash: definitionHash(input.kind, input.values),
    forwardSettledCount: learnedHistory?.settledCount ?? 0,
    forwardHitCount: learnedHistory?.hitCount ?? 0,
    forwardMissCount: (learnedHistory?.settledCount ?? 0) -
      (learnedHistory?.hitCount ?? 0),
    rank: 0,
    frozenAt: run.frozenAt,
  };
}

function buildBaselineProduct(
  run: RollingPatternRun,
  kind: RollingPatternProductKind,
  values: string[],
  histories?: UnifiedProductHistories,
) {
  return finalizeProduct(run, {
    kind,
    label: values.join("＋"),
    values,
    evidenceEventIds: [],
    strategyCount: 0,
    support: 0,
    hits: 0,
    baselineProbability: exactSlotBaseline(kind, values, run.expectedDrawAt),
  }, histories);
}

function posteriorFromHistory(
  prior: number,
  history: ProductHistoryCounts | undefined,
): number {
  if (!history || history.settledCount === 0) return prior;
  return (history.hitCount + prior * 4) / (history.settledCount + 4);
}

function boundedHistory(
  history: ProductHistoryCounts | undefined,
): ProductHistoryCounts | undefined {
  if (!history) return undefined;
  const settledCount = Math.max(0, Math.trunc(history.settledCount));
  return {
    settledCount,
    hitCount: Math.max(0, Math.min(settledCount, Math.trunc(history.hitCount))),
  };
}

function compareProductsForRecommendation(
  left: RollingPatternProduct,
  right: RollingPatternProduct,
) {
  return right.expectedValue - left.expectedValue ||
    (right.learningSettledCount ?? right.forwardSettledCount ?? 0) -
      (left.learningSettledCount ?? left.forwardSettledCount ?? 0) ||
    right.support - left.support ||
    right.strategyCount - left.strategyCount ||
    asciiCompare(left.values.join("+"), right.values.join("+"));
}

function selectTopProduct(
  products: readonly RollingPatternProduct[],
  kind: RollingPatternProductKind,
): RollingPatternProduct | null {
  return products
    .filter((candidate) => candidate.kind === kind)
    .sort(compareProductsForRecommendation)[0] ?? null;
}

function buildAuthoritativeRecommendation(
  product: RollingPatternProduct,
  revision: number,
): AuthoritativeRecommendation {
  const hasLedgerSource = product.sourceKind === "ledger" &&
    product.sourceProductId !== null &&
    product.sourceProductId !== undefined;
  const sourceKind = hasLedgerSource ? "ledger" : "derived_baseline";
  const patternProbability = product.patternProbability ?? product.estimatedProbability;
  const legacySeedProbability = product.legacySeedProbability ?? patternProbability;
  const learningSettledCount = product.learningSettledCount ??
    product.forwardSettledCount ?? 0;
  const learningHitCount = product.learningHitCount ?? product.forwardHitCount ?? 0;
  return {
    kind: product.kind,
    resultKey: product.values.join("+"),
    values: [...product.values],
    sourceRunId: product.runId,
    sourceProductId: hasLedgerSource ? product.sourceProductId : null,
    sourceKind,
    dataVersion: product.dataVersion ?? product.runId,
    revision,
    p30: patternProbability,
    legacySeedProbability,
    learnedProbability: product.estimatedProbability,
    netOdds: product.netOdds,
    breakEvenProbability: product.breakEvenProbability,
    expectedValue: product.expectedValue,
    legacySettledCount: product.legacySettledCount ?? 0,
    legacyHitCount: product.legacyHitCount ?? 0,
    learningSettledCount,
    learningHitCount,
    product,
    reason: recommendationReason(product),
  };
}

function asciiCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function definitionHash(kind: RollingPatternProductKind, values: readonly string[]) {
  const definition = `rolling-pattern-product-v2:${kind}:${values.join("+")}`;
  let hash = 2166136261;
  for (let index = 0; index < definition.length; index += 1) {
    hash ^= definition.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
