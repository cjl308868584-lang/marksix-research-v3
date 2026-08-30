import type { Draw } from "./lottery.ts";
import { evaluateRollingResultEvent } from "./rolling-pattern-events.ts";
import {
  buildSpecialNumberConsensus,
  selectRollingPatternView,
} from "./rolling-pattern-summary.ts";
import type {
  RollingPatternEvent,
  RollingPatternProduct,
  RollingPatternReviewResultGroup,
  RollingPatternReviewRecord,
  RollingPatternReviewScopeSnapshot,
  RollingPatternReviewScore,
  RollingPatternReviewSnapshot,
  RollingPatternReviewSlotPerformance,
  RollingPatternRun,
  RollingPatternScope,
  RollingPatternSignal,
} from "./rolling-pattern-types.ts";
import {
  selectMandatoryProductRecommendations,
  settleRollingPatternProduct,
} from "./rolling-pattern-value.ts";

export function buildRollingPatternReviewSnapshot(
  run: RollingPatternRun,
  products: readonly RollingPatternProduct[],
): RollingPatternReviewSnapshot {
  return {
    runId: run.runId,
    game: run.game,
    targetIssue: run.targetIssue,
    frozenAt: run.frozenAt,
    purchases: selectMandatoryProductRecommendations(products, 0),
    coverage: buildScopeSnapshot(run.signals, "coverage_6_plus_1"),
    special: buildScopeSnapshot(run.signals, "special"),
    specialNumbers: buildSpecialNumberConsensus(
      run.signals,
      run.expectedDrawAt,
      15,
    ),
  };
}

export function settleRollingPatternReviewSnapshot(
  snapshot: RollingPatternReviewSnapshot,
  draw: Draw,
  scoredAt: string,
): RollingPatternReviewScore {
  if (!draw.verified) {
    throw new Error("逐期复盘只能使用已核验开奖结果结算");
  }
  if (draw.game !== snapshot.game || draw.issue !== snapshot.targetIssue) {
    throw new Error("逐期复盘只能结算同彩种、同目标期的开奖结果");
  }
  return {
    runId: snapshot.runId,
    game: snapshot.game,
    targetIssue: snapshot.targetIssue,
    actualNumbers: [...draw.numbers, draw.special],
    actualSpecial: draw.special,
    purchases: snapshot.purchases.map((item) =>
      settleRollingPatternProduct(item.product, draw, scoredAt)
    ),
    coverageResults: settleResultGroups(snapshot.coverage.resultGroups, draw),
    specialResults: settleResultGroups(snapshot.special.resultGroups, draw),
    specialNumbers: snapshot.specialNumbers.map((item) => ({
      number: item.number,
      actualMatched: item.number === draw.special,
    })),
    scoredAt,
  };
}

export function summarizeRollingPatternReviewSlots(
  reviews: readonly RollingPatternReviewRecord[],
): RollingPatternReviewSlotPerformance {
  return {
    coverage: summarizeScopeSlots(reviews, "coverage"),
    special: summarizeScopeSlots(reviews, "special"),
  };
}

function summarizeScopeSlots(
  reviews: readonly RollingPatternReviewRecord[],
  scope: "coverage" | "special",
) {
  const slots: Array<{
    settledCount: number;
    hitCount: number;
    baselineTotal: number;
  }> = [];

  for (const { snapshot, score } of reviews) {
    if (!score) continue;
    const outcomes = new Map(
      (scope === "coverage" ? score.coverageResults : score.specialResults)
        .map((item) => [item.eventId, item]),
    );
    snapshot[scope].resultGroups.forEach((group, index) => {
      const outcome = outcomes.get(group.event.eventId);
      if (!outcome) return;
      const slot = slots[index] ?? {
        settledCount: 0,
        hitCount: 0,
        baselineTotal: 0,
      };
      slot.settledCount += 1;
      slot.hitCount += outcome.actualMatched ? 1 : 0;
      slot.baselineTotal += group.summary.baselineRate;
      slots[index] = slot;
    });
  }

  return slots.map((slot, index) => ({
    rank: index + 1,
    settledCount: slot.settledCount,
    hitCount: slot.hitCount,
    missCount: slot.settledCount - slot.hitCount,
    hitRate: slot.hitCount / slot.settledCount,
    baselineRate: slot.baselineTotal / slot.settledCount,
  }));
}

function buildScopeSnapshot(
  signals: readonly RollingPatternSignal[],
  scope: RollingPatternScope,
): RollingPatternReviewScopeSnapshot {
  const scopedSignals = signals.filter((signal) => signal.rule.event.scope === scope);
  const view = selectRollingPatternView(scopedSignals, {
    scope,
    family: null,
    resultEventId: null,
  });
  const events = new Map<string, RollingPatternEvent>();
  for (const signal of scopedSignals) {
    const event = signal.rule.event;
    const existing = events.get(event.eventId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`结果B事件定义不一致：${event.eventId}`);
    }
    events.set(event.eventId, event);
  }
  return {
    summary: view.summary,
    resultGroups: view.summary.resultGroups.map((summary) => {
      const event = events.get(summary.eventId);
      if (!event) throw new Error(`结果B缺少冻结事件：${summary.eventId}`);
      return { event, summary };
    }),
  };
}

function settleResultGroups(
  groups: readonly RollingPatternReviewResultGroup[],
  draw: Draw,
) {
  return groups.map(({ event }) => {
    const actual = evaluateRollingResultEvent(draw, event);
    return {
      eventId: event.eventId,
      actualMatched: actual.matched,
      count: actual.count,
    };
  });
}
