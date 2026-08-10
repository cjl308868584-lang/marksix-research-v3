import type {
  RollingPatternFamily,
  RollingPatternResultSummary,
  RollingPatternScope,
  RollingPatternSignal,
  RollingPatternSummary,
  SpecialNumberConsensus,
  SpecialNumberEvidence,
} from "./rolling-pattern-types";
import { getZodiac } from "./zodiac.ts";

const RED_WAVE_NUMBERS = new Set([1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46]);
const BLUE_WAVE_NUMBERS = new Set([3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48]);

export function selectRollingPatternView(
  signals: readonly RollingPatternSignal[],
  filters: {
    scope: RollingPatternScope;
    family: RollingPatternFamily | null;
    resultEventId: string | null;
  },
) {
  const scoped = signals.filter((signal) =>
    signal.rule.event.scope === filters.scope &&
    (!filters.family || signal.rule.event.family === filters.family)
  );
  return {
    summary: summarizeRollingPatterns(scoped),
    signals: filters.resultEventId
      ? scoped.filter((signal) => signal.rule.event.eventId === filters.resultEventId)
      : scoped,
  };
}

type MutableResultSummary = Omit<
  RollingPatternResultSummary,
  "hitRate" | "baselineRate" | "uplift"
>;

export function summarizeRollingPatterns(
  signals: readonly RollingPatternSignal[],
): RollingPatternSummary {
  const uniqueSignals = [...new Map(
    signals.map((signal) => [signal.rule.ruleId, signal]),
  ).values()];
  const resultGroups = new Map<string, MutableResultSummary>();
  let triggerCount = 0;
  let hitCount = 0;
  let expectedHits = 0;
  let strongStrategyCount = 0;

  for (const signal of uniqueSignals) {
    const misses = signal.support - signal.hits;
    const expected = signal.support * signal.baseline;
    triggerCount += signal.support;
    hitCount += signal.hits;
    expectedHits += expected;
    if (signal.evidenceTier === "strong") strongStrategyCount += 1;

    const event = signal.rule.event;
    const existing = resultGroups.get(event.eventId) ?? {
      eventId: event.eventId,
      label: event.value,
      family: event.family,
      strategyCount: 0,
      triggerCount: 0,
      hitCount: 0,
      missCount: 0,
      expectedHits: 0,
      strongStrategyCount: 0,
      experimentalStrategyCount: 0,
    };
    existing.strategyCount += 1;
    existing.triggerCount += signal.support;
    existing.hitCount += signal.hits;
    existing.missCount += misses;
    existing.expectedHits += expected;
    if (signal.evidenceTier === "strong") {
      existing.strongStrategyCount += 1;
    } else {
      existing.experimentalStrategyCount += 1;
    }
    resultGroups.set(event.eventId, existing);
  }

  const groups = [...resultGroups.values()]
    .map((group): RollingPatternResultSummary => {
      const hitRate = ratio(group.hitCount, group.triggerCount);
      const baselineRate = ratio(group.expectedHits, group.triggerCount);
      return { ...group, hitRate, baselineRate, uplift: hitRate - baselineRate };
    })
    .sort((left, right) =>
      right.hitRate - left.hitRate ||
      right.triggerCount - left.triggerCount ||
      right.strategyCount - left.strategyCount ||
      right.uplift - left.uplift ||
      left.label.localeCompare(right.label, "zh-CN")
    );
  const missCount = triggerCount - hitCount;
  const hitRate = ratio(hitCount, triggerCount);
  const baselineRate = ratio(expectedHits, triggerCount);

  return {
    strategyCount: uniqueSignals.length,
    resultCount: groups.length,
    triggerCount,
    hitCount,
    missCount,
    hitRate,
    expectedHits,
    expectedMisses: triggerCount - expectedHits,
    baselineRate,
    uplift: hitRate - baselineRate,
    strongStrategyCount,
    experimentalStrategyCount: uniqueSignals.length - strongStrategyCount,
    resultGroups: groups,
  };
}

export function buildSpecialNumberConsensus(
  signals: readonly RollingPatternSignal[],
  expectedDrawAt: string,
  limit = 15,
): SpecialNumberConsensus[] {
  const uniqueSignals = [...new Map(
    signals
      .filter((signal) => signal.rule.event.scope === "special")
      .map((signal) => [signal.rule.ruleId, signal]),
  ).values()];
  const byEvent = new Map<string, RollingPatternSignal[]>();
  for (const signal of uniqueSignals) {
    const eventId = signal.rule.event.eventId;
    byEvent.set(eventId, [...(byEvent.get(eventId) ?? []), signal]);
  }
  const evidence = [...byEvent.values()].map(summarizeSpecialEvidence);
  const numbers: SpecialNumberConsensus[] = [];

  for (let number = 1; number <= 49; number += 1) {
    const matching = evidence.filter((entry) =>
      numberMatchesSpecialEvent(number, expectedDrawAt, entry)
    );
    if (matching.length === 0) continue;
    const triggerCount = matching.reduce((total, entry) => total + entry.triggerCount, 0);
    const hitCount = matching.reduce((total, entry) => total + entry.hitCount, 0);
    numbers.push({
      number,
      score: matching.reduce((total, entry) => total + entry.contribution, 0),
      resultCount: matching.length,
      strategyCount: matching.reduce((total, entry) => total + entry.strategyCount, 0),
      triggerCount,
      hitCount,
      missCount: triggerCount - hitCount,
      hitRate: ratio(hitCount, triggerCount),
      evidence: matching,
    });
  }

  return numbers
    .sort((left, right) =>
      right.score - left.score ||
      right.resultCount - left.resultCount ||
      right.strategyCount - left.strategyCount ||
      right.hitRate - left.hitRate ||
      left.number - right.number
    )
    .slice(0, Math.max(0, Math.min(49, Math.trunc(limit))));
}

export function signalSupportsSpecialNumber(
  signal: RollingPatternSignal,
  number: number,
  expectedDrawAt: string,
) {
  if (signal.rule.event.scope !== "special" || number < 1 || number > 49) return false;
  return numberMatchesSpecialEvent(number, expectedDrawAt, {
    family: signal.rule.event.family,
    label: signal.rule.event.value,
  });
}

function summarizeSpecialEvidence(
  signals: RollingPatternSignal[],
): SpecialNumberEvidence {
  const event = signals[0].rule.event;
  const triggerCount = signals.reduce((total, signal) => total + signal.support, 0);
  const hitCount = signals.reduce((total, signal) => total + signal.hits, 0);
  const baselineWeight = signals.reduce(
    (total, signal) => total + signal.baseline * signal.support,
    0,
  );
  const posteriorWeight = signals.reduce(
    (total, signal) => total + signal.posteriorRate * signal.support,
    0,
  );
  const baselineRate = ratio(baselineWeight, triggerCount);
  const posteriorRate = ratio(posteriorWeight, triggerCount);
  const reliability = triggerCount / (triggerCount + 10);
  return {
    eventId: event.eventId,
    label: event.value,
    family: event.family,
    strategyCount: signals.length,
    triggerCount,
    hitCount,
    missCount: triggerCount - hitCount,
    hitRate: ratio(hitCount, triggerCount),
    baselineRate,
    posteriorRate,
    contribution: Math.min(0.35, Math.max(0, posteriorRate - baselineRate) * reliability),
  };
}

function numberMatchesSpecialEvent(
  number: number,
  expectedDrawAt: string,
  event: Pick<SpecialNumberEvidence, "family" | "label">,
) {
  switch (event.family) {
    case "zodiac":
      return getZodiac(number, expectedDrawAt) === event.label;
    case "tail":
      return `${number % 10}尾` === event.label;
    case "wave":
      return specialWaveLabel(number) === event.label;
    case "head":
      return `${Math.floor(number / 10)}头` === event.label;
  }
}

function specialWaveLabel(number: number) {
  if (RED_WAVE_NUMBERS.has(number)) return "红波";
  if (BLUE_WAVE_NUMBERS.has(number)) return "蓝波";
  return "绿波";
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}
