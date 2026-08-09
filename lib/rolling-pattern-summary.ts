import type {
  RollingPatternResultSummary,
  RollingPatternSignal,
  RollingPatternSummary,
} from "./rolling-pattern-types";

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
      label: signal.rule.predictionLabel,
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
      right.strongStrategyCount - left.strongStrategyCount ||
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

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}
