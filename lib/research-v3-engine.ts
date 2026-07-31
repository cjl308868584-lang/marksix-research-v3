import {
  getZodiac,
  type Draw,
  type GameId,
} from "./lottery";
import { ZODIAC_NAMES } from "./zodiac";
import {
  RESEARCH_V3_ENGINE_VERSION,
  RESEARCH_V3_MODEL_VERSION,
  RESEARCH_V3_SCHEMA_VERSION,
  type ResearchEventFamily,
  type ResearchEventForecast,
  type ResearchEventHistory,
  type ResearchEventScope,
  type ResearchEventSlot,
  type ResearchExpertId,
  type ResearchModelWeight,
  type ResearchRuleContribution,
  type ResearchV3Snapshot,
} from "./research-v3-types";

const FAST_WINDOW = 40 as const;
const MEDIUM_WINDOW = 120 as const;
const BASELINE_WEIGHT_FLOOR = 0.25;
const MIN_TRAINING_ROWS = 30;
const DEFAULT_WEIGHTS: Record<ResearchExpertId, number> = {
  baseline: 0.35,
  interpretable_rules: 0.35,
  logistic: 0.3,
  black_box: 0,
};

type Candidate = {
  slot: ResearchEventSlot;
  scope: ResearchEventScope;
  family: ResearchEventFamily;
  value: string;
};

type CandidateEvaluation = {
  candidate: Candidate;
  probability: number;
  baseline: number;
  rulesProbability: number;
  logisticProbability: number;
  blackBoxProbability: number;
  weights: Record<ResearchExpertId, number>;
  history: ResearchEventHistory;
  contributions: ResearchRuleContribution[];
};

export function buildResearchV3Snapshot({
  game,
  draws,
  targetIssue,
  expectedDrawAt,
  generatedAt = new Date().toISOString(),
  sourceMode = "snapshot",
  sourceWarning = null,
  previousWeights = {},
  settledForecasts = 0,
  champion = "interpretable_rules",
  challenger = "logistic",
}: {
  game: GameId;
  draws: Draw[];
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt?: string;
  sourceMode?: "live" | "snapshot";
  sourceWarning?: string | null;
  previousWeights?: Partial<
    Record<ResearchEventSlot, Partial<Record<ResearchExpertId, number>>>
  >;
  settledForecasts?: number;
  champion?: ResearchExpertId;
  challenger?: ResearchExpertId | null;
}): ResearchV3Snapshot {
  const chronological = [...draws]
    .filter(isUsableDraw)
    .sort(
      (left, right) =>
        Date.parse(left.drawAt) - Date.parse(right.drawAt) ||
        left.issue.localeCompare(right.issue, "en", { numeric: true }),
    );
  const candidates = eventCandidates();
  const selected = (
    [
      "zodiac_6_plus_1",
      "tail_6_plus_1",
      "position_parity",
      "position_size",
    ] as const
  ).map((slot) => {
    const evaluations = candidates
      .filter((candidate) => candidate.slot === slot)
      .map((candidate) =>
        evaluateCandidate(
          candidate,
          chronological,
          expectedDrawAt,
          previousWeights[slot],
        )
      )
      .sort(compareCandidateEvaluation);
    return toEventForecast(evaluations[0], chronological, expectedDrawAt);
  }) as ResearchV3Snapshot["events"];

  const verifiedSampleSize = chronological.filter((draw) => draw.verified).length;
  const datasetVersion = `data_${stableHash(
    chronological.map((draw) =>
      [draw.issue, draw.drawAt, ...draw.numbers, draw.special, draw.verified].join(
        ":",
      )
    ).join("|"),
  )}`;
  const modelVersion = `${RESEARCH_V3_MODEL_VERSION}-${datasetVersion.slice(-8)}`;
  const formal = selected.every((event) => event.evidenceTier === "verified");

  return {
    schemaVersion: RESEARCH_V3_SCHEMA_VERSION,
    engineVersion: RESEARCH_V3_ENGINE_VERSION,
    modelVersion,
    runId: `rv3_${game}_${targetIssue}_${stableHash(
      `${datasetVersion}:${expectedDrawAt}:${modelVersion}`,
    )}`,
    game,
    targetIssue,
    expectedDrawAt,
    generatedAt,
    frozenAt: generatedAt,
    mode: formal ? "formal" : "shadow",
    events: selected,
    dataQuality: {
      sampleSize: chronological.length,
      verifiedSampleSize,
      verifiedRatio: verifiedSampleSize / Math.max(chronological.length, 1),
      sourceMode,
      oldestIssue: chronological[0]?.issue ?? null,
      newestIssue: chronological.at(-1)?.issue ?? null,
      datasetVersion,
      warnings: [
        sourceWarning,
        chronological.length < 80
          ? "历史样本不足80期，所有结果仅作影子观察。"
          : null,
        verifiedSampleSize < 50
          ? "独立核验前瞻样本不足50期，暂不标记已验证优势。"
          : null,
      ].filter((message): message is string => Boolean(message)),
    },
    learningSummary: {
      settledForecasts,
      champion,
      challenger: chronological.length >= 80 ? challenger : null,
      baselineWeightFloor: BASELINE_WEIGHT_FLOOR,
      fastWindow: FAST_WINDOW,
      mediumWindow: MEDIUM_WINDOW,
      message:
        settledForecasts > 0
          ? `已经结算 ${settledForecasts} 期固定四项策略；新结果只影响下一期模型。`
          : "等待首期固定四项策略开奖后，开始前瞻学习。",
    },
    notice:
      "只预测四类40%–70%基线事件；原始号码仅用于计算分类特征，不作为预测输出。",
  };
}

export function eventMatches(
  event: Pick<ResearchEventForecast, "scope" | "family" | "predictedValue">,
  draw: Draw,
) {
  const values = actualValues(event.scope, event.family, draw);
  return values.has(event.predictedValue);
}

export function exactEventBaseline(
  scope: ResearchEventScope,
  family: ResearchEventFamily,
  value: string,
  drawAt: string,
) {
  if (scope === "draw.6_plus_1") {
    const memberCount = Array.from({ length: 49 }, (_, index) => index + 1)
      .filter((number) => categoryValue(family, number, drawAt) === value)
      .length;
    return hypergeometricCoverage(memberCount, 7);
  }
  const memberCount = Array.from({ length: 49 }, (_, index) => index + 1)
    .filter((number) => categoryValue(family, number, drawAt) === value)
    .length;
  return memberCount / 49;
}

function eventCandidates(): Candidate[] {
  const coverage: Candidate[] = [
    ...ZODIAC_NAMES.map((value) => ({
      slot: "zodiac_6_plus_1" as const,
      scope: "draw.6_plus_1" as const,
      family: "zodiac" as const,
      value,
    })),
    ...Array.from({ length: 10 }, (_, index) => ({
      slot: "tail_6_plus_1" as const,
      scope: "draw.6_plus_1" as const,
      family: "tail" as const,
      value: `${index}尾`,
    })),
  ];
  const scopes = [
    "special",
    "main.position.1",
    "main.position.2",
    "main.position.3",
    "main.position.4",
    "main.position.5",
    "main.position.6",
  ] as const;
  const positionEvents = scopes.flatMap((scope) => [
    {
      slot: "position_parity" as const,
      scope,
      family: "parity" as const,
      value: "单",
    },
    {
      slot: "position_parity" as const,
      scope,
      family: "parity" as const,
      value: "双",
    },
    {
      slot: "position_size" as const,
      scope,
      family: "size" as const,
      value: "大",
    },
    {
      slot: "position_size" as const,
      scope,
      family: "size" as const,
      value: "小",
    },
  ]);
  return [...coverage, ...positionEvents];
}

function evaluateCandidate(
  candidate: Candidate,
  draws: Draw[],
  expectedDrawAt: string,
  priorWeights?: Partial<Record<ResearchExpertId, number>>,
): CandidateEvaluation {
  const outcomes = draws.map((draw) =>
    actualValues(candidate.scope, candidate.family, draw).has(candidate.value)
      ? 1
      : 0
  );
  const baselines = draws.map((draw) =>
    exactEventBaseline(
      candidate.scope,
      candidate.family,
      candidate.value,
      draw.drawAt,
    )
  );
  const baseline = exactEventBaseline(
    candidate.scope,
    candidate.family,
    candidate.value,
    expectedDrawAt,
  );
  const contributions = [
    posteriorContribution(candidate, outcomes, baselines, FAST_WINDOW),
    posteriorContribution(candidate, outcomes, baselines, MEDIUM_WINDOW),
    posteriorContribution(candidate, outcomes, baselines, "all"),
  ];
  const rulesProbability = clamp(
    contributions[0].posteriorRate * 0.45 +
      contributions[1].posteriorRate * 0.35 +
      contributions[2].posteriorRate * 0.2,
    0.4,
    0.7,
  );
  const logistic = logisticForecast(outcomes, baselines, baseline);
  const blackBoxProbability =
    draws.length >= 1_000 ? logistic.probability : baseline;
  const weights = normalizeWeights({
    ...DEFAULT_WEIGHTS,
    ...priorWeights,
    black_box: draws.length >= 1_000
      ? (priorWeights?.black_box ?? 0.1)
      : 0,
  });
  const probability = clamp(
    weights.baseline * baseline +
      weights.interpretable_rules * rulesProbability +
      weights.logistic * logistic.probability +
      weights.black_box * blackBoxProbability,
    0.4,
    0.7,
  );
  const sampleSize = outcomes.length;
  const hits = outcomes.reduce<number>((sum, outcome) => sum + outcome, 0);
  const hitRate = hits / Math.max(sampleSize, 1);
  const expectedHits = baselines.reduce((sum, value) => sum + value, 0);
  const baselineBrier = average(
    outcomes.map((outcome, index) => square(baselines[index] - outcome)),
  );
  const modelBrier = logistic.validationBrier;
  const baselineLogLoss = average(
    outcomes.map((outcome, index) =>
      binaryLogLoss(outcome, baselines[index])
    ),
  );
  const modelLogLoss = logistic.validationLogLoss;
  const history: ResearchEventHistory = {
    sampleSize,
    hits,
    hitRate,
    expectedHits,
    brierSkill:
      Number.isFinite(modelBrier) && baselineBrier > 0
        ? 1 - modelBrier / baselineBrier
        : 0,
    logLossSkill:
      Number.isFinite(modelLogLoss) && baselineLogLoss > 0
        ? 1 - modelLogLoss / baselineLogLoss
        : 0,
    nonWorseFoldRatio: logistic.nonWorseFoldRatio,
    calibrationError: Math.abs(logistic.validationMean - logistic.validationRate),
    posteriorAdvantage: probabilityAdvantageProbability(
      hits,
      sampleSize,
      average(baselines),
    ),
  };
  return {
    candidate,
    probability,
    baseline,
    rulesProbability,
    logisticProbability: logistic.probability,
    blackBoxProbability,
    weights,
    history,
    contributions,
  };
}

function posteriorContribution(
  candidate: Candidate,
  outcomes: number[],
  baselines: number[],
  window: 40 | 120 | "all",
): ResearchRuleContribution {
  const count = window === "all" ? outcomes.length : Math.min(window, outcomes.length);
  const selectedOutcomes = outcomes.slice(-count);
  const selectedBaselines = baselines.slice(-count);
  const hits = selectedOutcomes.reduce((sum, value) => sum + value, 0);
  const baseline = average(selectedBaselines);
  const priorStrength = 20;
  const posterior = (hits + baseline * priorStrength) /
    Math.max(count + priorStrength, 1);
  const delta = posterior - baseline;
  return {
    ruleId: `rv3_${candidate.slot}_${scopeKey(candidate.scope)}_${candidate.value}_${window}`,
    label:
      window === "all"
        ? "全部历史后验"
        : window === 40
          ? "快速40期后验"
          : "中速120期后验",
    direction: delta >= 0 ? "support" : "suppress",
    window,
    observedRate: hits / Math.max(count, 1),
    baselineRate: baseline,
    posteriorRate: posterior,
    contribution: delta,
    support: count,
  };
}

function logisticForecast(
  outcomes: number[],
  baselines: number[],
  currentBaseline: number,
) {
  if (outcomes.length < MIN_TRAINING_ROWS) {
    return {
      probability: currentBaseline,
      validationBrier: average(
        outcomes.map((outcome, index) => square(baselines[index] - outcome)),
      ),
      validationLogLoss: average(
        outcomes.map((outcome, index) =>
          binaryLogLoss(outcome, baselines[index])
        ),
      ),
      validationMean: currentBaseline,
      validationRate: average(outcomes),
      nonWorseFoldRatio: 0,
    };
  }
  const rows = outcomes.map((_, index) =>
    featureVector(outcomes, baselines, index)
  );
  const foldStarts = [0.5, 0.6, 0.7, 0.8, 0.9].map((ratio) =>
    Math.max(MIN_TRAINING_ROWS, Math.floor(outcomes.length * ratio))
  );
  const foldResults = foldStarts.map((start, foldIndex) => {
    const end =
      foldIndex === foldStarts.length - 1
        ? outcomes.length
        : foldStarts[foldIndex + 1];
    if (end <= start) return null;
    const weights = fitLogistic(rows.slice(0, start), outcomes.slice(0, start));
    const predictions = rows.slice(start, end).map((row, index) => {
      const raw = sigmoid(dot(weights, row));
      const baseline = baselines[start + index];
      const shrink = start / (start + 100);
      return clamp(baseline + (raw - baseline) * shrink, 0.4, 0.7);
    });
    const actual = outcomes.slice(start, end);
    const foldBaselines = baselines.slice(start, end);
    const brier = average(
      predictions.map((probability, index) =>
        square(probability - actual[index])
      ),
    );
    const baselineBrier = average(
      foldBaselines.map((probability, index) =>
        square(probability - actual[index])
      ),
    );
    return {
      brier,
      baselineBrier,
      logLoss: average(
        predictions.map((probability, index) =>
          binaryLogLoss(actual[index], probability)
        ),
      ),
      mean: average(predictions),
      rate: average(actual),
    };
  }).filter((result): result is NonNullable<typeof result> => Boolean(result));
  const trained = fitLogistic(rows, outcomes);
  const rawCurrent = sigmoid(
    dot(trained, featureVector(outcomes, baselines, outcomes.length)),
  );
  const shrink = outcomes.length / (outcomes.length + 100);
  const validationSkill = average(
    foldResults.map((result) =>
      result.baselineBrier > 0
        ? 1 - result.brier / result.baselineBrier
        : 0
    ),
  );
  const evidenceShrink = validationSkill > 0 ? 1 : 0.25;
  return {
    probability: clamp(
      currentBaseline +
        (rawCurrent - currentBaseline) * shrink * evidenceShrink,
      0.4,
      0.7,
    ),
    validationBrier: average(foldResults.map((result) => result.brier)),
    validationLogLoss: average(foldResults.map((result) => result.logLoss)),
    validationMean: average(foldResults.map((result) => result.mean)),
    validationRate: average(foldResults.map((result) => result.rate)),
    nonWorseFoldRatio:
      foldResults.filter((result) => result.brier <= result.baselineBrier)
        .length / Math.max(foldResults.length, 1),
  };
}

function featureVector(
  outcomes: number[],
  baselines: number[],
  index: number,
) {
  const prior = outcomes.slice(0, index);
  const baseline = baselines[Math.min(index, baselines.length - 1)] ??
    average(baselines) ??
    0.5;
  const lag = (offset: number) => prior.at(-offset) ?? baseline;
  const rate = (window: number) => {
    const values = prior.slice(-window);
    return values.length ? average(values) - baseline : 0;
  };
  let gap = 0;
  for (let cursor = prior.length - 1; cursor >= 0; cursor -= 1) {
    if (prior[cursor] === 1) break;
    gap += 1;
  }
  return [
    1,
    lag(1),
    lag(2),
    lag(3),
    lag(4),
    lag(5),
    rate(FAST_WINDOW),
    rate(MEDIUM_WINDOW),
    rate(Math.max(prior.length, 1)),
    Math.min(gap, 20) / 20,
  ];
}

function fitLogistic(rows: number[][], outcomes: number[]) {
  const dimension = rows[0]?.length ?? 10;
  const weights = Array(dimension).fill(0) as number[];
  const learningRate = 0.18;
  const l2 = 0.08;
  for (let iteration = 0; iteration < 120; iteration += 1) {
    const gradient = Array(dimension).fill(0) as number[];
    rows.forEach((row, index) => {
      const error = sigmoid(dot(weights, row)) - outcomes[index];
      row.forEach((value, feature) => {
        gradient[feature] += error * value;
      });
    });
    weights.forEach((weight, feature) => {
      const regularization = feature === 0 ? 0 : l2 * weight;
      weights[feature] -=
        learningRate *
        (gradient[feature] / Math.max(rows.length, 1) + regularization);
    });
  }
  return weights;
}

function toEventForecast(
  evaluation: CandidateEvaluation,
  draws: Draw[],
  expectedDrawAt: string,
): ResearchEventForecast {
  const { candidate, history } = evaluation;
  const hasPositiveEdge = evaluation.probability > evaluation.baseline + 1e-9;
  const displayedProbability = hasPositiveEdge
    ? evaluation.probability
    : evaluation.baseline;
  const verifiedCount = draws.filter((draw) => draw.verified).length;
  const historicalGate =
    hasPositiveEdge &&
    history.sampleSize >= 80 &&
    history.brierSkill > 0 &&
    history.nonWorseFoldRatio >= 0.8 &&
    evaluation.probability - evaluation.baseline >= 0.03;
  const tier =
    historicalGate && verifiedCount >= 50
      ? "verified"
      : historicalGate
        ? "challenger"
        : draws.length >= MIN_TRAINING_ROWS
          ? "shadow"
          : "baseline";
  const experts: ResearchModelWeight[] = [
    expert(
      "baseline",
      "精确随机基线",
      evaluation.weights.baseline,
      evaluation.baseline,
      "active",
      "永久保留，模型失效时自动回归。",
    ),
    expert(
      "interpretable_rules",
      "快中慢规则集成",
      evaluation.weights.interpretable_rules,
      evaluation.rulesProbability,
      "active",
      "Beta-Binomial收缩后的40期、120期及全历史后验。",
    ),
    expert(
      "logistic",
      "正则化逻辑回归",
      evaluation.weights.logistic,
      evaluation.logisticProbability,
      draws.length >= MIN_TRAINING_ROWS ? "shadow" : "blocked",
      draws.length >= MIN_TRAINING_ROWS
        ? "按时间滚动训练与验证，尚未达到前瞻晋级门槛。"
        : "样本不足，当前退回基线。",
    ),
    expert(
      "black_box",
      "黑盒挑战者",
      evaluation.weights.black_box,
      evaluation.blackBoxProbability,
      draws.length >= 1_000 ? "shadow" : "blocked",
      draws.length >= 1_000
        ? "仅作为挑战者，不直接控制正式结果。"
        : "高质量历史不足1,000期，暂不启用。",
    ),
  ];
  const strongest = [...evaluation.contributions].sort(
    (left, right) =>
      Math.abs(right.contribution) - Math.abs(left.contribution),
  )[0];
  return {
    eventId: `evt_${candidate.slot}_${scopeKey(candidate.scope)}_${candidate.value}_${stableHash(expectedDrawAt)}`,
    slot: candidate.slot,
    slotLabel: slotLabel(candidate.slot),
    scope: candidate.scope,
    scopeLabel: scopeLabel(candidate.scope),
    family: candidate.family,
    predictedValue: candidate.value,
    predictionLabel: predictionLabel(candidate),
    probability: displayedProbability,
    baselineProbability: evaluation.baseline,
    uplift: displayedProbability - evaluation.baseline,
    evidenceTier: tier,
    experts,
    ruleContributions: evaluation.contributions,
    history,
    rationale:
      hasPositiveEdge && strongest.contribution >= 0
        ? `${strongest.label}对“${candidate.value}”提供当前最强支持；概率已与随机基线及其他模型加权。`
        : `现有证据没有形成正优势；该槽位只保留精确随机基线，不将负提升包装成预测优势。`,
    warning:
      tier === "verified"
        ? null
        : "尚未完成50次独立前瞻验证，只能作为影子研究结果。",
  };
}

function compareCandidateEvaluation(
  left: CandidateEvaluation,
  right: CandidateEvaluation,
) {
  const leftUplift = left.probability - left.baseline;
  const rightUplift = right.probability - right.baseline;
  const leftPositive = leftUplift > 1e-9 ? 1 : 0;
  const rightPositive = rightUplift > 1e-9 ? 1 : 0;
  const leftScore =
    leftUplift * 8 +
    Math.max(left.history.brierSkill, -0.2) * 0.2 +
    left.history.nonWorseFoldRatio * 0.1 +
    left.history.posteriorAdvantage * 0.03;
  const rightScore =
    rightUplift * 8 +
    Math.max(right.history.brierSkill, -0.2) * 0.2 +
    right.history.nonWorseFoldRatio * 0.1 +
    right.history.posteriorAdvantage * 0.03;
  return (
    rightPositive - leftPositive ||
    rightScore - leftScore ||
    right.probability - left.probability ||
    left.candidate.value.localeCompare(right.candidate.value, "zh-Hans-CN")
  );
}

function actualValues(
  scope: ResearchEventScope,
  family: ResearchEventFamily,
  draw: Draw,
) {
  const numbers =
    scope === "draw.6_plus_1"
      ? [...draw.numbers, draw.special]
      : scope === "special"
        ? [draw.special]
        : [draw.numbers[Number(scope.split(".")[2]) - 1]];
  return new Set(
    numbers
      .filter((number): number is number => Number.isInteger(number))
      .map((number) => categoryValue(family, number, draw.drawAt)),
  );
}

function categoryValue(
  family: ResearchEventFamily,
  number: number,
  drawAt: string,
) {
  if (family === "zodiac") return getZodiac(number, drawAt);
  if (family === "tail") return `${number % 10}尾`;
  if (family === "parity") return number % 2 ? "单" : "双";
  return number >= 25 ? "大" : "小";
}

function slotLabel(slot: ResearchEventSlot) {
  return {
    zodiac_6_plus_1: "6+1生肖覆盖",
    tail_6_plus_1: "6+1尾数覆盖",
    position_parity: "指定位置单双",
    position_size: "指定位置大小",
  }[slot];
}

function scopeLabel(scope: ResearchEventScope) {
  if (scope === "draw.6_plus_1") return "6个正码＋特码";
  if (scope === "special") return "特码";
  return `第${scope.split(".")[2]}正码`;
}

function predictionLabel(candidate: Candidate) {
  if (candidate.scope === "draw.6_plus_1") {
    return `下一期6+1至少出现一次${candidate.value}`;
  }
  return `下一期${scopeLabel(candidate.scope)}：${candidate.value}`;
}

function scopeKey(scope: ResearchEventScope) {
  return scope.replaceAll(".", "_");
}

function expert(
  modelId: ResearchExpertId,
  label: string,
  weight: number,
  probability: number,
  status: ResearchModelWeight["status"],
  note: string,
): ResearchModelWeight {
  return { modelId, label, weight, probability, status, note };
}

function normalizeWeights(
  source: Record<ResearchExpertId, number>,
): Record<ResearchExpertId, number> {
  const clean = {
    baseline: Math.max(source.baseline, BASELINE_WEIGHT_FLOOR),
    interpretable_rules: Math.max(source.interpretable_rules, 0),
    logistic: Math.max(source.logistic, 0),
    black_box: Math.max(source.black_box, 0),
  };
  const total = Object.values(clean).reduce((sum, value) => sum + value, 0);
  const normalized = Object.fromEntries(
    Object.entries(clean).map(([key, value]) => [key, value / Math.max(total, 1)]),
  ) as Record<ResearchExpertId, number>;
  if (normalized.baseline >= BASELINE_WEIGHT_FLOOR) return normalized;
  const remainder = 1 - BASELINE_WEIGHT_FLOOR;
  const nonBaseline = 1 - normalized.baseline;
  return {
    baseline: BASELINE_WEIGHT_FLOOR,
    interpretable_rules:
      normalized.interpretable_rules / Math.max(nonBaseline, 1e-9) * remainder,
    logistic: normalized.logistic / Math.max(nonBaseline, 1e-9) * remainder,
    black_box: normalized.black_box / Math.max(nonBaseline, 1e-9) * remainder,
  };
}

function hypergeometricCoverage(memberCount: number, drawCount: number) {
  let miss = 1;
  for (let index = 0; index < drawCount; index += 1) {
    miss *= (49 - memberCount - index) / (49 - index);
  }
  return 1 - miss;
}

function probabilityAdvantageProbability(
  hits: number,
  total: number,
  baseline: number,
) {
  if (total <= 0) return 0.5;
  const priorStrength = 20;
  const posteriorMean = (hits + baseline * priorStrength) /
    (total + priorStrength);
  const variance =
    posteriorMean * (1 - posteriorMean) /
    Math.max(total + priorStrength + 1, 1);
  const z = (posteriorMean - baseline) / Math.sqrt(Math.max(variance, 1e-9));
  return clamp(normalCdf(z), 0, 1);
}

function normalCdf(value: number) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t -
      0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function binaryLogLoss(outcome: number, probability: number) {
  const safe = clamp(probability, 1e-9, 1 - 1e-9);
  return -(outcome * Math.log(safe) + (1 - outcome) * Math.log(1 - safe));
}

function isUsableDraw(draw: Draw) {
  return (
    Number.isFinite(Date.parse(draw.drawAt)) &&
    draw.numbers.length === 6 &&
    draw.numbers.every((number) => Number.isInteger(number)) &&
    Number.isInteger(draw.special)
  );
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function dot(left: number[], right: number[]) {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function sigmoid(value: number) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
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
