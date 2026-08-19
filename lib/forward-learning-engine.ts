import { netOddsForProduct } from "./rolling-pattern-value.ts";
import { signalSupportsSpecialNumber } from "./rolling-pattern-summary.ts";
import type {
  RollingPatternRun,
  RollingPatternSignal,
} from "./rolling-pattern-types.ts";
import { ZODIAC_NAMES } from "./zodiac.ts";
import { exactSlotBaseline } from "./forward-learning-math.ts";
import {
  FORWARD_LEARNING_ENGINE_VERSION,
  FORWARD_LEARNING_SLOTS,
  type ExpertWeights,
  type ForwardLearningCandidate,
  type ForwardLearningForecast,
  type ForwardLearningModelState,
  type ForwardLearningSlot,
  type ForwardRuleContribution,
} from "./forward-learning-types.ts";

const PRIOR_STRENGTH = 4;
const DEFAULT_WEIGHTS: ExpertWeights = {
  baseline: 0.34,
  rules30: 0.33,
  forward: 0.33,
};

export type ForwardResultHistory = {
  settledCount: number;
  hitCount: number;
  brier: number;
  baselineBrier: number;
};

export type ForwardLearningEngineContext = {
  modelStates?: readonly ForwardLearningModelState[];
  resultHistory?: ReadonlyMap<string, ForwardResultHistory>;
};

export function buildForwardLearningCandidates(
  run: RollingPatternRun,
  context: ForwardLearningEngineContext = {},
): ForwardLearningCandidate[] {
  const specs = candidateSpecs(run);
  return specs.map((spec) => {
    const baselineProbability = exactSlotBaseline(
      spec.slot,
      spec.values,
      run.expectedDrawAt,
    );
    const signals = matchingSignals(run, spec.slot, spec.values);
    const ruleContributions = clusterRuleEvidence(signals);
    const rules30Probability = rulesProbability(
      baselineProbability,
      ruleContributions,
      spec.slot,
    );
    const historyKey = `${spec.slot}:${spec.resultKey}`;
    const history = context.resultHistory?.get(historyKey);
    const settledCount = history?.settledCount ?? 0;
    const hitCount = history?.hitCount ?? 0;
    const forwardProbability = (hitCount + baselineProbability * PRIOR_STRENGTH) /
      (settledCount + PRIOR_STRENGTH);
    const modelState = context.modelStates?.find((state) => state.slot === spec.slot);
    const weights = modelState?.weights ?? DEFAULT_WEIGHTS;
    const unbounded = weights.baseline * baselineProbability +
      weights.rules30 * rules30Probability +
      weights.forward * forwardProbability;
    const finalProbability = boundCandidateProbability(spec.slot, unbounded);
    return {
      candidateId: `${run.runId}:${spec.slot}:${spec.resultKey}`,
      game: run.game,
      targetIssue: run.targetIssue,
      slot: spec.slot,
      resultKey: spec.resultKey,
      label: spec.label,
      values: spec.values,
      baselineProbability,
      expertProbabilities: {
        baseline: baselineProbability,
        rules30: rules30Probability,
        forward: forwardProbability,
      },
      expertWeights: { ...weights },
      finalProbability,
      netOdds: netOddsForProduct(spec.slot, spec.values),
      rawRuleCount: signals.length,
      evidenceClusterCount: new Set(ruleContributions.map((item) => item.clusterId)).size,
      ruleContributions,
      forwardSettledCount: settledCount,
      forwardHitCount: hitCount,
      forwardBrierSkill: history && history.baselineBrier > 0
        ? 1 - history.brier / history.baselineBrier
        : 0,
      frozenAt: run.frozenAt,
      modelVersion: modelState?.version ?? `${FORWARD_LEARNING_ENGINE_VERSION}:bootstrap`,
      dataVersion: run.window.dataHash,
    };
  });
}

export function selectOfficialForecasts(
  candidates: readonly ForwardLearningCandidate[],
  previousForecasts: readonly ForwardLearningForecast[] = [],
): ForwardLearningForecast[] {
  return FORWARD_LEARNING_SLOTS.flatMap((slot) => {
    const ranked = candidates
      .filter((candidate) => candidate.slot === slot)
      .sort(compareCandidates);
    const selected = ranked[0];
    if (!selected) return [];
    const previous = previousForecasts.find((forecast) => forecast.slot === slot) ?? null;
    const unchanged = previous?.resultKey === selected.resultKey;
    const delta = previous ? selected.finalProbability - previous.finalProbability : null;
    return [{
      ...selected,
      forecastId: `forecast:${selected.candidateId}`,
      official: true as const,
      rank: 1 as const,
      previousResultKey: previous?.resultKey ?? null,
      previousProbability: previous?.finalProbability ?? null,
      probabilityDelta: delta,
      topAlternative: ranked[1]?.label ?? null,
      explanation: buildExplanation(selected, unchanged, delta),
    }];
  });
}

export function clusterRuleEvidence(
  signals: readonly RollingPatternSignal[],
): ForwardRuleContribution[] {
  const clusters: Array<{ id: string; signals: RollingPatternSignal[] }> = [];
  for (const signal of [...signals].sort((a, b) => stableCompare(a.rule.ruleId, b.rule.ruleId))) {
    const exact = clusters.find((cluster) =>
      cluster.signals[0].rule.canonicalJson === signal.rule.canonicalJson
    );
    const overlap = exact ?? clusters.find((cluster) =>
      jaccardIssues(cluster.signals[0], signal) >= 0.8
    );
    if (overlap) overlap.signals.push(signal);
    else clusters.push({ id: `cluster:${signal.rule.ruleId}`, signals: [signal] });
  }
  return clusters.flatMap((cluster) => {
    const ranked = cluster.signals
      .map((signal) => ({ signal, lift: signalLogOddsLift(signal) }))
      .sort((left, right) =>
        Math.abs(right.lift) - Math.abs(left.lift) ||
        stableCompare(left.signal.rule.ruleId, right.signal.rule.ruleId)
      );
    return ranked.map(({ signal, lift }, index) => {
      const exactDuplicate = index > 0 &&
        signal.rule.canonicalJson === ranked[0].signal.rule.canonicalJson;
      return {
        ruleId: signal.rule.ruleId,
        clusterId: cluster.id,
        conditionLabel: signal.rule.conditionLabel,
        support: signal.support,
        hits: signal.hits,
        baselineProbability: signal.baseline,
        posteriorProbability: posterior(signal.hits, signal.support, signal.baseline),
        logOddsLift: lift,
        effectiveContribution: index === 0 ? lift : exactDuplicate ? 0 : lift * 0.2,
        primary: index === 0,
      } satisfies ForwardRuleContribution;
    });
  });
}

function candidateSpecs(run: RollingPatternRun) {
  const specs: Array<{
    slot: ForwardLearningSlot;
    resultKey: string;
    label: string;
    values: string[];
  }> = [];
  for (const zodiac of ZODIAC_NAMES) {
    specs.push({ slot: "coverage_zodiac", resultKey: zodiac, label: zodiac, values: [zodiac] });
  }
  for (let tail = 0; tail <= 9; tail += 1) {
    const label = `${tail}尾`;
    specs.push({ slot: "coverage_tail", resultKey: label, label, values: [label] });
  }
  const activeZodiacs = ZODIAC_NAMES.filter((zodiac) => run.signals.some((signal) =>
    signal.rule.event.scope === "coverage_6_plus_1" &&
    signal.rule.event.family === "zodiac" &&
    signal.rule.event.value === zodiac
  ));
  for (const values of combinations(activeZodiacs, 2)) {
    const label = values.join("＋");
    specs.push({ slot: "coverage_zodiac_pair", resultKey: values.join("+"), label, values: [...values] });
  }
  for (const values of combinations(activeZodiacs, 3)) {
    const label = values.join("＋");
    specs.push({ slot: "coverage_zodiac_triple", resultKey: values.join("+"), label, values: [...values] });
  }
  for (let number = 1; number <= 49; number += 1) {
    const label = String(number).padStart(2, "0");
    specs.push({ slot: "special_number", resultKey: label, label, values: [label] });
  }
  return specs;
}

function matchingSignals(
  run: RollingPatternRun,
  slot: ForwardLearningSlot,
  values: readonly string[],
) {
  if (slot === "special_number") {
    const number = Number(values[0]);
    return run.signals.filter((signal) =>
      signal.rule.event.scope === "special" &&
      signalSupportsSpecialNumber(signal, number, run.expectedDrawAt)
    );
  }
  const family = slot === "coverage_tail" ? "tail" : "zodiac";
  return run.signals.filter((signal) =>
    signal.rule.event.scope === "coverage_6_plus_1" &&
    signal.rule.event.family === family &&
    values.includes(signal.rule.event.value)
  );
}

function rulesProbability(
  baseline: number,
  contributions: readonly ForwardRuleContribution[],
  slot: ForwardLearningSlot,
) {
  if (!contributions.length) return baseline;
  const effective = contributions.reduce(
    (total, item) => total + item.effectiveContribution,
    0,
  );
  const clusters = Math.max(1, new Set(contributions.map((item) => item.clusterId)).size);
  const probability = logistic(logit(baseline) + effective / Math.sqrt(clusters));
  return boundCandidateProbability(slot, probability);
}

function signalLogOddsLift(signal: RollingPatternSignal) {
  return logit(posterior(signal.hits, signal.support, signal.baseline)) -
    logit(signal.baseline);
}

function posterior(hits: number, support: number, baseline: number) {
  return (hits + baseline * PRIOR_STRENGTH) / (support + PRIOR_STRENGTH);
}

function jaccardIssues(left: RollingPatternSignal, right: RollingPatternSignal) {
  const leftIssues = new Set(left.audit.map((row) => row.targetIssue));
  const rightIssues = new Set(right.audit.map((row) => row.targetIssue));
  const union = new Set([...leftIssues, ...rightIssues]);
  if (!union.size) return 0;
  const intersection = [...leftIssues].filter((issue) => rightIssues.has(issue)).length;
  return intersection / union.size;
}

function compareCandidates(left: ForwardLearningCandidate, right: ForwardLearningCandidate) {
  return right.finalProbability - left.finalProbability ||
    (right.finalProbability - right.baselineProbability) -
      (left.finalProbability - left.baselineProbability) ||
    right.forwardSettledCount - left.forwardSettledCount ||
    right.forwardBrierSkill - left.forwardBrierSkill ||
    stableCompare(left.resultKey, right.resultKey);
}

function buildExplanation(
  candidate: ForwardLearningCandidate,
  unchanged: boolean,
  delta: number | null,
) {
  const facts = [
    `当前30期原始支持${candidate.rawRuleCount}条，去相关后${candidate.evidenceClusterCount}组有效证据。`,
    candidate.forwardSettledCount
      ? `相同结果此前前瞻结算${candidate.forwardSettledCount}次，命中${candidate.forwardHitCount}次。`
      : "相同结果尚无新版独立前瞻结算。",
    `专家权重：基线${percent(candidate.expertWeights.baseline)}、近30期${percent(candidate.expertWeights.rules30)}、前瞻${percent(candidate.expertWeights.forward)}。`,
  ];
  if (delta !== null) {
    facts.push(
      unchanged
        ? `本期仍保持该结果，结算学习后概率变化${signedPoints(delta)}。`
        : `结算学习后改选该结果，概率变化${signedPoints(delta)}。`,
    );
  }
  if (candidate.finalProbability <= candidate.baselineProbability + 1e-9) {
    facts.push("当前校准概率接近随机基线，属于低置信参考。");
  }
  return facts;
}

function boundCandidateProbability(slot: ForwardLearningSlot, value: number) {
  return slot === "special_number"
    ? Math.min(0.2, Math.max(0.001, value))
    : Math.min(0.99, Math.max(0.01, value));
}

function logit(value: number) {
  const bounded = Math.min(1 - 1e-6, Math.max(1e-6, value));
  return Math.log(bounded / (1 - bounded));
}

function logistic(value: number) {
  return 1 / (1 + Math.exp(-value));
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

function stableCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPoints(value: number) {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)}个百分点`;
}

