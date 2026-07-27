import { getZodiac } from "./zodiac.ts";
import type {
  ResearchRuleEvidence,
  ResearchTargetFamily,
} from "./research-v2-types.ts";

export type ConsensusNumber = {
  number: number;
  probability: number;
  baseline: number;
  delta: number;
  positiveRuleCount: number;
  negativeRuleCount: number;
};

export type ConsensusDimension = {
  family: ResearchTargetFamily;
  value: string;
  probability: number;
  baseline: number;
  delta: number;
  positiveRuleCount: number;
  negativeRuleCount: number;
};

export type ResearchConsensus = {
  scope: ResearchRuleEvidence["spec"]["target"]["scope"];
  label: string;
  ruleIds: string[];
  positiveRuleCount: number;
  negativeRuleCount: number;
  topNumbers: ConsensusNumber[];
  dimensions: ConsensusDimension[];
  explanation: string;
};

const NUMBERS = Array.from({ length: 49 }, (_, index) => index + 1);
const RED_WAVE = new Set([1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46]);
const BLUE_WAVE = new Set([3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48]);

export function buildResearchConsensus(
  rules: ResearchRuleEvidence[],
  expectedDrawAt: string,
): ResearchConsensus[] {
  const active = rules.filter(
    (rule) =>
      rule.currentTriggerMatched &&
      rule.currentPrediction !== null &&
      (rule.direction === "positive" || rule.direction === "negative"),
  );
  const groups = new Map<string, ResearchRuleEvidence[]>();
  active.forEach((rule) => {
    const scope = rule.spec.target.scope;
    groups.set(scope, [...(groups.get(scope) ?? []), rule]);
  });

  return [...groups.entries()]
    .map(([scope, scopedRules]) =>
      buildScopeConsensus(
        scope as ResearchConsensus["scope"],
        scopedRules,
        expectedDrawAt,
      ),
    )
    .filter((item) => item.ruleIds.length >= 2)
    .sort(
      (left, right) =>
        consensusStrength(right) - consensusStrength(left) ||
        right.positiveRuleCount - left.positiveRuleCount ||
        left.label.localeCompare(right.label, "zh-CN", { numeric: true }),
    );
}

function buildScopeConsensus(
  scope: ResearchConsensus["scope"],
  rules: ResearchRuleEvidence[],
  expectedDrawAt: string,
): ResearchConsensus {
  const scores = new Map(NUMBERS.map((number) => [number, 0]));
  rules.forEach((rule) => {
    const matching = new Set(
      NUMBERS.filter(
        (number) =>
          categoryValue(rule.spec.target.family, number, expectedDrawAt) ===
          rule.currentPrediction,
      ),
    );
    const weight = evidenceWeight(rule);
    const signed = rule.direction === "negative" ? -weight : weight;
    matching.forEach((number) => {
      scores.set(number, (scores.get(number) ?? 0) + signed);
    });
  });

  const probabilities = softmax(scores);
  const numberRows = NUMBERS.map((number) => {
    const positiveRuleCount = rules.filter(
      (rule) =>
        rule.direction === "positive" &&
        ruleMatchesNumber(rule, number, expectedDrawAt),
    ).length;
    const negativeRuleCount = rules.filter(
      (rule) =>
        rule.direction === "negative" &&
        ruleMatchesNumber(rule, number, expectedDrawAt),
    ).length;
    const probability = probabilities.get(number) ?? 1 / 49;
    return {
      number,
      probability,
      baseline: 1 / 49,
      delta: probability - 1 / 49,
      positiveRuleCount,
      negativeRuleCount,
    };
  }).sort(
    (left, right) =>
      right.probability - left.probability ||
      right.positiveRuleCount - left.positiveRuleCount ||
      left.number - right.number,
  );

  const families = [...new Set(rules.map((rule) => rule.spec.target.family))];
  const dimensions = families
    .flatMap((family) =>
      familyValues(family, expectedDrawAt).map((value) => {
        const members = NUMBERS.filter(
          (number) => categoryValue(family, number, expectedDrawAt) === value,
        );
        const probability = members.reduce(
          (sum, number) => sum + (probabilities.get(number) ?? 0),
          0,
        );
        const baseline = members.length / 49;
        return {
          family,
          value,
          probability,
          baseline,
          delta: probability - baseline,
          positiveRuleCount: rules.filter(
            (rule) =>
              rule.direction === "positive" &&
              rule.spec.target.family === family &&
              rule.currentPrediction === value,
          ).length,
          negativeRuleCount: rules.filter(
            (rule) =>
              rule.direction === "negative" &&
              rule.spec.target.family === family &&
              rule.currentPrediction === value,
          ).length,
        };
      }),
    )
    .filter(
      (dimension) =>
        dimension.positiveRuleCount > 0 || dimension.negativeRuleCount > 0,
    )
    .sort(
      (left, right) =>
        Math.abs(right.delta) - Math.abs(left.delta) ||
        right.delta - left.delta ||
        right.positiveRuleCount - left.positiveRuleCount ||
        left.value.localeCompare(right.value, "zh-CN", { numeric: true }),
    );

  const topNumber = numberRows[0];
  return {
    scope,
    label: scopeLabel(scope),
    ruleIds: rules.map((rule) => rule.ruleId),
    positiveRuleCount: rules.filter((rule) => rule.direction === "positive").length,
    negativeRuleCount: rules.filter((rule) => rule.direction === "negative").length,
    topNumbers: numberRows.slice(0, 5),
    dimensions: dimensions.slice(0, 5),
    explanation: explainConsensus(rules, dimensions, topNumber, expectedDrawAt),
  };
}

function explainConsensus(
  rules: ResearchRuleEvidence[],
  dimensions: ConsensusDimension[],
  topNumber: ConsensusNumber,
  expectedDrawAt: string,
) {
  const repeated = dimensions.find((item) => item.positiveRuleCount >= 2);
  if (repeated) {
    return `${repeated.positiveRuleCount}条正向规律同时指向${repeated.value}，相同方向被重复支持；${formatBall(topNumber.number)}同时符合该条件，规则加权概率相对基线${deltaText(topNumber.delta)}。`;
  }
  const compatible = dimensions.filter(
    (item) =>
      item.positiveRuleCount > 0 &&
      categoryValue(item.family, topNumber.number, expectedDrawAt) === item.value,
  );
  if (compatible.length >= 2) {
    return `${compatible[0].value}与${compatible[1].value}可以同时成立，交集号码${formatBall(topNumber.number)}获得叠加支持；规则加权概率相对基线${deltaText(topNumber.delta)}。`;
  }
  const suppressed = dimensions
    .filter((item) => item.negativeRuleCount > 0 && item.delta < 0)
    .sort((left, right) => left.delta - right.delta);
  if (!rules.some((rule) => rule.direction === "positive") && suppressed.length) {
    return `${suppressed[0].value}受到${suppressed[0].negativeRuleCount}条负向规律压低，规则加权概率相对基线${deltaText(suppressed[0].delta)}；负向证据只用于降权，不代表它一定不开。`;
  }
  if (topNumber.negativeRuleCount > 0) {
    return `${formatBall(topNumber.number)}受到${topNumber.negativeRuleCount}条负向规律压低；负向证据只用于降权，不代表该号码一定不开。`;
  }
  const positive = rules.filter((rule) => rule.direction === "positive").length;
  return `${positive}条正向规律在该位置形成加权分布；当前最高号码为${formatBall(topNumber.number)}，相对随机基线${deltaText(topNumber.delta)}。`;
}

function evidenceWeight(rule: ResearchRuleEvidence) {
  const relativeLift =
    Math.abs(rule.lift) / Math.max(rule.baselineRate, 0.05);
  return (
    clamp(relativeLift, 0.02, 0.35) *
    clamp(rule.stabilityScore, 0.25, 1) *
    clamp(rule.nonWorseFoldRatio, 0.2, 1) *
    clamp(1 - rule.qValue, 0.2, 1)
  );
}

function softmax(scores: Map<number, number>) {
  const maximum = Math.max(...scores.values());
  const exponentials = [...scores.entries()].map(
    ([number, score]) => [number, Math.exp(score - maximum)] as const,
  );
  const total = exponentials.reduce((sum, [, value]) => sum + value, 0);
  return new Map(
    exponentials.map(([number, value]) => [number, value / Math.max(total, 1e-12)]),
  );
}

function ruleMatchesNumber(
  rule: ResearchRuleEvidence,
  number: number,
  expectedDrawAt: string,
) {
  return (
    categoryValue(rule.spec.target.family, number, expectedDrawAt) ===
    rule.currentPrediction
  );
}

function familyValues(family: ResearchTargetFamily, drawAt: string) {
  return [...new Set(NUMBERS.map((number) => categoryValue(family, number, drawAt)))];
}

function categoryValue(
  family: ResearchTargetFamily,
  number: number,
  drawAt: string,
) {
  if (family === "number") return String(number);
  if (family === "zodiac") return getZodiac(number, drawAt);
  if (family === "wave") {
    return RED_WAVE.has(number) ? "红波" : BLUE_WAVE.has(number) ? "蓝波" : "绿波";
  }
  if (family === "tail") return `${number % 10}尾`;
  if (family === "parity") return number % 2 ? "单" : "双";
  if (family === "size") return number >= 25 ? "大" : "小";
  return number <= 16 ? "一区" : number <= 33 ? "二区" : "三区";
}

function scopeLabel(scope: ResearchConsensus["scope"]) {
  if (scope === "special") return "下一期 · 特码";
  return `下一期 · 第${scope.split(".")[2]}正码`;
}

function consensusStrength(consensus: ResearchConsensus) {
  return Math.max(
    Math.abs(consensus.topNumbers[0]?.delta ?? 0),
    ...consensus.dimensions.map((item) => Math.abs(item.delta)),
  );
}

function deltaText(delta: number) {
  return `${delta >= 0 ? "提高" : "降低"}${Math.abs(delta * 100).toFixed(2)}个百分点`;
}

function formatBall(number: number) {
  return String(number).padStart(2, "0");
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
