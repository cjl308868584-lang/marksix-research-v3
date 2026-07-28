import { getWave, getZodiac, type Draw } from "./lottery";
import type {
  ResearchReview,
  ResearchRuleEvidence,
  ResearchRuleReview,
  ResearchSnapshot,
  ResearchTargetFamily,
} from "./research-v2-types";

export const RESEARCH_REVIEW_VERSION = "research-review-v1" as const;

export function buildResearchReview(
  snapshot: ResearchSnapshot,
  draw: Draw,
  settledAt: string,
): ResearchReview {
  if (snapshot.game !== draw.game || snapshot.targetIssue !== draw.issue) {
    throw new Error("research snapshot and draw do not match");
  }
  const frozenAt = snapshot.generatedAt;
  const rules = frozenRules(snapshot).map((rule) =>
    reviewRule(rule, draw),
  );
  const positive = rules.filter((rule) => rule.direction === "positive");
  const negative = rules.filter((rule) => rule.direction === "negative");
  const passed = rules.filter((rule) => rule.passedHistoricalGate);
  const directionalCorrect = rules.filter(
    (rule) => rule.directionCorrect,
  ).length;
  const baselineDirectionalRate = average(
    rules.map((rule) => rule.baselineSuccessRate),
  );
  const directionalSuccessRate = directionalCorrect / Math.max(rules.length, 1);
  const positiveHits = positive.filter((rule) => rule.directionCorrect).length;
  const negativeAvoided = negative.filter((rule) => rule.directionCorrect).length;
  const passedRuleCorrect = passed.filter(
    (rule) => rule.directionCorrect,
  ).length;

  return {
    reviewVersion: RESEARCH_REVIEW_VERSION,
    runId: snapshot.runId,
    game: snapshot.game,
    targetIssue: snapshot.targetIssue,
    expectedDrawAt: snapshot.expectedDrawAt,
    frozenAt,
    settledAt,
    actual: {
      issue: draw.issue,
      drawAt: draw.drawAt,
      numbers: draw.numbers,
      special: draw.special,
      source: draw.source,
      verified: draw.verified,
    },
    availableRuleCount: rules.length,
    positiveRuleCount: positive.length,
    positiveHits,
    negativeRuleCount: negative.length,
    negativeAvoided,
    passedRuleCount: passed.length,
    passedRuleCorrect,
    directionalCorrect,
    directionalSuccessRate,
    baselineDirectionalRate,
    directionalLift: directionalSuccessRate - baselineDirectionalRate,
    summary: buildSummary({
      ruleCount: rules.length,
      positiveCount: positive.length,
      positiveHits,
      negativeCount: negative.length,
      negativeAvoided,
      passedCount: passed.length,
      passedCorrect: passedRuleCorrect,
      directionalSuccessRate,
      baselineDirectionalRate,
    }),
    nextAction:
      "本期结果已写入结算账本；下一期规则重新评估会包含这期已核验开奖。单期命中只小幅奖励，连续失效和高置信错误才会明显降权。",
    rules,
  };
}

export function frozenRules(snapshot: ResearchSnapshot) {
  return [
    ...snapshot.verifiedRules,
    ...snapshot.experimentalRules,
    ...snapshot.negativeRules,
  ].filter(
    (rule): rule is ResearchRuleEvidence & {
      direction: "positive" | "negative";
      currentPrediction: string;
    } =>
      rule.currentTriggerMatched &&
      rule.currentPrediction !== null &&
      (rule.direction === "positive" || rule.direction === "negative"),
  );
}

function reviewRule(
  rule: ReturnType<typeof frozenRules>[number],
  draw: Draw,
): ResearchRuleReview {
  const actualNumber = numberAtScope(rule.spec.target.scope, draw);
  const actualValue = categoryValue(
    rule.spec.target.family,
    actualNumber,
    draw.drawAt,
  );
  const prediction = normalizeValue(
    rule.spec.target.family,
    rule.currentPrediction,
  );
  const matched = prediction === normalizeValue(
    rule.spec.target.family,
    actualValue,
  );
  const directionCorrect =
    rule.direction === "positive" ? matched : !matched;
  const outcome =
    rule.direction === "positive"
      ? matched
        ? "positive_hit"
        : "positive_miss"
      : matched
        ? "negative_failed"
        : "negative_avoided";
  const baselineSuccessRate =
    rule.direction === "positive"
      ? rule.baselineRate
      : 1 - rule.baselineRate;
  const historicalHitRate =
    rule.direction === "positive"
      ? rule.hitRate
      : 1 - rule.hitRate;

  return {
    ruleId: rule.ruleId,
    family: rule.family,
    description: rule.description,
    targetId: rule.targetId,
    targetLabel: targetLabel(rule),
    direction: rule.direction,
    prediction: rule.currentPrediction,
    actualValue,
    actualNumber,
    outcome,
    directionCorrect,
    baselineSuccessRate,
    historicalHitRate,
    lift: historicalHitRate - baselineSuccessRate,
    brierSkill: rule.brierSkill,
    qValue: rule.qValue,
    support: rule.support,
    passedHistoricalGate:
      rule.qValue <= 0.1 &&
      rule.brierSkill > 0 &&
      rule.nonWorseFoldRatio >= 0.7,
  };
}

function numberAtScope(
  scope: ResearchRuleEvidence["spec"]["target"]["scope"],
  draw: Draw,
) {
  if (scope === "special") return draw.special;
  const position = Number(scope.split(".")[2]);
  const number = draw.numbers[position - 1];
  if (!number) throw new Error("draw is missing a main number");
  return number;
}

function categoryValue(
  family: ResearchTargetFamily,
  number: number,
  drawAt: string,
) {
  if (family === "number") return String(number);
  if (family === "zodiac") return getZodiac(number, drawAt);
  if (family === "wave") {
    const wave = getWave(number);
    return wave === "red" ? "红波" : wave === "blue" ? "蓝波" : "绿波";
  }
  if (family === "tail") return `${number % 10}尾`;
  if (family === "parity") return number % 2 ? "单" : "双";
  if (family === "size") return number >= 25 ? "大" : "小";
  return number <= 16 ? "一区" : number <= 33 ? "二区" : "三区";
}

function normalizeValue(family: ResearchTargetFamily, value: string) {
  if (family !== "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : value;
}

function targetLabel(rule: ResearchRuleEvidence) {
  const family = {
    number: "号码",
    zodiac: "生肖",
    wave: "波色",
    tail: "尾数",
    parity: "单双",
    size: "大小",
    zone: "区间",
  }[rule.spec.target.family];
  if (rule.spec.target.scope === "special") return `特码 · ${family}`;
  return `第${rule.spec.target.scope.split(".")[2]}正码 · ${family}`;
}

function buildSummary({
  ruleCount,
  positiveCount,
  positiveHits,
  negativeCount,
  negativeAvoided,
  passedCount,
  passedCorrect,
  directionalSuccessRate,
  baselineDirectionalRate,
}: {
  ruleCount: number;
  positiveCount: number;
  positiveHits: number;
  negativeCount: number;
  negativeAvoided: number;
  passedCount: number;
  passedCorrect: number;
  directionalSuccessRate: number;
  baselineDirectionalRate: number;
}) {
  if (ruleCount === 0) {
    return "本期没有在开奖前触发可用规律，因此没有可结算项目。";
  }
  const relation =
    directionalSuccessRate >= baselineDirectionalRate ? "高于" : "低于";
  return [
    `开奖前共冻结${ruleCount}条可用规律。`,
    `正向规律命中${positiveHits}/${positiveCount}，负向规律成功避开${negativeAvoided}/${negativeCount}。`,
    `方向正确率${percent(directionalSuccessRate)}，${relation}对应随机期望${percent(baselineDirectionalRate)}。`,
    passedCount
      ? `其中历史门槛通过的规律方向正确${passedCorrect}/${passedCount}。`
      : "本期没有已通过历史门槛的规律。",
  ].join("");
}

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) /
    Math.max(values.length, 1);
}
