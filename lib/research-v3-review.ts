import { getZodiac, type Draw } from "./lottery";
import { eventMatches } from "./research-v3-engine";
import {
  RESEARCH_V3_REVIEW_VERSION,
  type ResearchEventForecast,
  type ResearchEventReview,
  type ResearchExpertId,
  type ResearchModelWeight,
  type ResearchV3Performance,
  type ResearchV3Review,
  type ResearchV3Snapshot,
} from "./research-v3-types";

const LEARNING_RATE = 0.2;
const MAX_SINGLE_DRAW_WEIGHT_CHANGE = 0.1;
const BASELINE_WEIGHT_FLOOR = 0.25;
const SINGLE_MODEL_WEIGHT_CAP = 0.5;

export function buildResearchV3Review(
  snapshot: ResearchV3Snapshot,
  draw: Draw,
  settledAt: string,
): ResearchV3Review {
  if (snapshot.game !== draw.game || snapshot.targetIssue !== draw.issue) {
    throw new Error("v3 snapshot and draw do not match");
  }
  if (!draw.verified) {
    throw new Error("only verified draws can settle v3 forecasts");
  }
  if (Date.parse(snapshot.frozenAt) >= Date.parse(draw.drawAt)) {
    throw new Error("v3 forecast was not frozen before the draw");
  }

  const events = snapshot.events.map((event) => reviewEvent(event, draw));
  const hits = events.filter((event) => event.actualMatched).length;
  const expectedHits = events.reduce(
    (sum, event) => sum + event.baselineProbability,
    0,
  );
  const brier = average(events.map((event) => event.brier));
  const baselineBrier = average(events.map((event) => event.baselineBrier));
  const logLoss = average(events.map((event) => event.logLoss));
  const baselineLogLoss = average(
    events.map((event) => event.baselineLogLoss),
  );
  const championBefore = snapshot.learningSummary.champion;
  const weightLeaderAfter = mode(
    events.map((event) => champion(event.modelWeightsAfter)),
  );
  const championAfter = championBefore;
  const driftDetected = events.some((event) =>
    event.diagnosis.some((item) => item.includes("漂移"))
  );
  const completedAt = settledAt;

  return {
    reviewVersion: RESEARCH_V3_REVIEW_VERSION,
    runId: snapshot.runId,
    game: snapshot.game,
    targetIssue: snapshot.targetIssue,
    expectedDrawAt: snapshot.expectedDrawAt,
    frozenAt: snapshot.frozenAt,
    settledAt,
    actual: {
      issue: draw.issue,
      drawAt: draw.drawAt,
      numbers: draw.numbers,
      special: draw.special,
      source: draw.source,
      verified: draw.verified,
    },
    hits,
    total: 4,
    expectedHits,
    hitRate: hits / 4,
    baselineHitRate: expectedHits / 4,
    brier,
    baselineBrier,
    brierSkill: skill(brier, baselineBrier),
    logLoss,
    baselineLogLoss,
    logLossSkill: skill(logLoss, baselineLogLoss),
    events,
    learningRun: {
      learningRunId: `learn_${snapshot.runId}`,
      runId: snapshot.runId,
      game: snapshot.game,
      settledIssue: snapshot.targetIssue,
      startedAt: settledAt,
      completedAt,
      status: "completed",
      championBefore,
      championAfter,
      challengerPromoted: false,
      driftDetected,
      summary:
        weightLeaderAfter === championBefore
          ? `冠军保持为${modelLabel(championAfter)}；单期结果只更新权重，不触发模型替换。`
          : `${modelLabel(weightLeaderAfter)}成为本期权重领先者，但未完成连续20期验证，冠军仍为${modelLabel(championBefore)}。`,
    },
    summary:
      hits > expectedHits
        ? `本期固定四项命中 ${hits}/4，高于随机预期 ${expectedHits.toFixed(2)} 项；这只形成一个新前瞻样本。`
        : `本期固定四项命中 ${hits}/4，不高于随机预期 ${expectedHits.toFixed(2)} 项；模型已降低相关证据权重。`,
    nextAction:
      "本期结果只写入下一期训练集；冠军是否替换仍由连续前瞻Brier、校准和20期挑战窗口决定。",
  };
}

export function buildResearchV3Performance(
  game: ResearchV3Review["game"],
  reviews: ResearchV3Review[],
): ResearchV3Performance {
  const ordered = [...reviews].sort(
    (left, right) =>
      Date.parse(left.settledAt) - Date.parse(right.settledAt),
  );
  const summarize = (items: ResearchV3Review[]) => {
    const hits = items.reduce((sum, item) => sum + item.hits, 0);
    const events = items.reduce((sum, item) => sum + item.total, 0);
    const expected = items.reduce((sum, item) => sum + item.expectedHits, 0);
    return {
      issues: items.length,
      hits,
      events,
      expected,
      hitRate: hits / Math.max(events, 1),
      baselineHitRate: expected / Math.max(events, 1),
      brierSkill: average(items.map((item) => item.brierSkill)),
      logLossSkill: average(items.map((item) => item.logLossSkill)),
    };
  };
  const all = summarize(ordered);
  const windows = ([20, 50, "all"] as const).map((window) => {
    const summary = summarize(
      window === "all" ? ordered : ordered.slice(-window),
    );
    return {
      window,
      issues: summary.issues,
      hitRate: summary.hitRate,
      baselineHitRate: summary.baselineHitRate,
      brierSkill: summary.brierSkill,
      logLossSkill: summary.logLossSkill,
    };
  });
  return {
    game,
    settledIssues: all.issues,
    settledEvents: all.events,
    hits: all.hits,
    expectedHits: all.expected,
    hitRate: all.hitRate,
    baselineHitRate: all.baselineHitRate,
    hitLift: all.hitRate - all.baselineHitRate,
    brierSkill: all.brierSkill,
    logLossSkill: all.logLossSkill,
    windows,
    curve: ordered.slice(-50).map((review) => ({
      issue: review.targetIssue,
      settledAt: review.settledAt,
      hits: review.hits,
      expectedHits: review.expectedHits,
      brierSkill: review.brierSkill,
      logLossSkill: review.logLossSkill,
    })),
    conclusion:
      all.issues < 20
        ? `当前只有 ${all.issues} 期前瞻复盘，尚不足以判断模型是否进步。`
        : all.brierSkill > 0 && all.hitRate > all.baselineHitRate
          ? "累计概率评分与命中率均优于对应随机基线，继续前瞻观察。"
          : "尚未证明稳定优势；系统应继续收缩置信度并淘汰伪规律。",
  };
}

function reviewEvent(
  event: ResearchEventForecast,
  draw: Draw,
): ResearchEventReview {
  const matched = eventMatches(event, draw);
  const outcome = matched ? 1 : 0;
  const brier = square(event.probability - outcome);
  const baselineBrier = square(event.baselineProbability - outcome);
  const logLoss = binaryLogLoss(outcome, event.probability);
  const baselineLogLoss = binaryLogLoss(
    outcome,
    event.baselineProbability,
  );
  const modelWeightsAfter = updateExpertWeights(
    event.experts,
    outcome,
    event.baselineProbability,
  );
  const diagnosis = diagnose(event, outcome, brier, baselineBrier);
  return {
    eventId: event.eventId,
    slot: event.slot,
    slotLabel: event.slotLabel,
    prediction: event.predictionLabel,
    scopeLabel: event.scopeLabel,
    probability: event.probability,
    baselineProbability: event.baselineProbability,
    actualMatched: matched,
    actualLabel: actualLabel(event, draw),
    brier,
    baselineBrier,
    brierSkill: skill(brier, baselineBrier),
    logLoss,
    baselineLogLoss,
    logLossSkill: skill(logLoss, baselineLogLoss),
    ruleContributions: event.ruleContributions,
    modelWeightsBefore: event.experts,
    modelWeightsAfter,
    diagnosis,
  };
}

export function updateExpertWeights(
  experts: ResearchModelWeight[],
  outcome: 0 | 1,
  baselineProbability: number,
) {
  const baselineLoss = binaryLogLoss(outcome, baselineProbability);
  const proposed = experts.map((expert) => {
    if (expert.status === "blocked") return { ...expert, weight: 0 };
    const loss = binaryLogLoss(outcome, expert.probability);
    const relativeLoss = loss - baselineLoss;
    return {
      ...expert,
      weight: expert.weight * Math.exp(-LEARNING_RATE * relativeLoss),
    };
  });
  let normalized = normalize(proposed);
  normalized = normalized.map((expert, index) => {
    const before = experts[index]?.weight ?? 0;
    return {
      ...expert,
      weight: clamp(
        expert.weight,
        Math.max(0, before - MAX_SINGLE_DRAW_WEIGHT_CHANGE),
        Math.min(SINGLE_MODEL_WEIGHT_CAP, before + MAX_SINGLE_DRAW_WEIGHT_CHANGE),
      ),
    };
  });
  normalized = normalize(normalized);
  const baselineIndex = normalized.findIndex(
    (expert) => expert.modelId === "baseline",
  );
  if (
    baselineIndex >= 0 &&
    normalized[baselineIndex].weight < BASELINE_WEIGHT_FLOOR
  ) {
    const otherTotal = normalized.reduce(
      (sum, expert, index) =>
        sum + (index === baselineIndex ? 0 : expert.weight),
      0,
    );
    normalized = normalized.map((expert, index) => ({
      ...expert,
      weight:
        index === baselineIndex
          ? BASELINE_WEIGHT_FLOOR
          : expert.weight /
            Math.max(otherTotal, 1e-9) *
            (1 - BASELINE_WEIGHT_FLOOR),
    }));
  }
  return normalized;
}

function diagnose(
  event: ResearchEventForecast,
  outcome: 0 | 1,
  brier: number,
  baselineBrier: number,
) {
  const diagnoses: string[] = [];
  const fast = event.ruleContributions.find((item) => item.window === 40);
  const slow = event.ruleContributions.find((item) => item.window === "all");
  const supportCount = event.ruleContributions.filter(
    (item) => item.direction === "support",
  ).length;
  const suppressCount = event.ruleContributions.length - supportCount;
  if (outcome === 1) {
    diagnoses.push(
      brier < baselineBrier
        ? "本期命中且概率评分优于基线，相关专家获得小幅奖励。"
        : "本期虽然命中，但预测概率未优于随机基线，不追加优势奖励。",
    );
  } else {
    diagnoses.push(
      event.probability >= 0.6
        ? "发生高置信错误，log-loss对相关专家施加更重处罚。"
        : "本期未命中，按普通概率误差有限降权，不追随开奖结果。",
    );
  }
  if (supportCount > 0 && suppressCount > 0) {
    diagnoses.push("正负证据同时存在，模型已识别冲突并限制总置信度。");
  }
  if (
    fast &&
    slow &&
    Math.abs(fast.posteriorRate - slow.posteriorRate) >= 0.1
  ) {
    diagnoses.push("快速40期与全历史差异达到10个百分点，标记为潜在数据漂移。");
  }
  if (event.history.sampleSize < 80) {
    diagnoses.push("历史样本不足80期，本期变化不会推动模型晋级。");
  }
  return diagnoses;
}

function actualLabel(event: ResearchEventForecast, draw: Draw) {
  if (event.scope === "draw.6_plus_1") {
    const numbers = [...draw.numbers, draw.special];
    const values = [
      ...new Set(
        numbers.map((number) =>
          event.family === "zodiac"
            ? getZodiac(number, draw.drawAt)
            : `${number % 10}尾`
        ),
      ),
    ];
    return values.includes(event.predictedValue)
      ? `已出现${event.predictedValue}`
      : `未出现${event.predictedValue}`;
  }
  const number =
    event.scope === "special"
      ? draw.special
      : draw.numbers[Number(event.scope.split(".")[2]) - 1];
  if (event.family === "parity") return number % 2 ? "单" : "双";
  return number >= 25 ? "大" : "小";
}

function normalize(experts: ResearchModelWeight[]) {
  const total = experts.reduce((sum, expert) => sum + expert.weight, 0);
  return experts.map((expert) => ({
    ...expert,
    weight: expert.weight / Math.max(total, 1e-9),
  }));
}

function champion(weights: ResearchModelWeight[]): ResearchExpertId {
  return [...weights]
    .filter((item) => item.status !== "blocked")
    .sort((left, right) => right.weight - left.weight)[0]?.modelId ?? "baseline";
}

function mode(values: ResearchExpertId[]): ResearchExpertId {
  const counts = new Map<ResearchExpertId, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1],
  )[0]?.[0] ?? "baseline";
}

function modelLabel(model: ResearchExpertId) {
  return {
    baseline: "精确随机基线",
    interpretable_rules: "可解释规则集成",
    logistic: "正则化逻辑回归",
    black_box: "黑盒挑战者",
  }[model];
}

function skill(value: number, baseline: number) {
  return baseline > 0 ? 1 - value / baseline : 0;
}

function binaryLogLoss(outcome: number, probability: number) {
  const safe = clamp(probability, 1e-9, 1 - 1e-9);
  return -(outcome * Math.log(safe) + (1 - outcome) * Math.log(1 - safe));
}

function average(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function square(value: number) {
  return value * value;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}
