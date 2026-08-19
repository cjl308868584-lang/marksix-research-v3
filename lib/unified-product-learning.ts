import type { Draw, GameId } from "./lottery.ts";
import { compareForwardLearningExpectedValue } from "./forward-learning-engine.ts";
import type {
  ForwardLearningCandidate,
  ForwardLearningCandidateV2,
  ForwardLearningForecast,
  ForwardLearningForecastV2,
  ForwardLearningRevisionSnapshot,
  ForwardLearningRollout,
  ForwardLearningSlot,
  ResolvedForwardSnapshot,
} from "./forward-learning-types.ts";
import { FORWARD_LEARNING_SLOTS } from "./forward-learning-types.ts";
import {
  NEW_MACAU_2026231_AUTHORITATIVE_HASH,
  NEW_MACAU_2026231_ROLLOUT,
} from "./forward-learning-rollouts.ts";
import type {
  AuthoritativeRecommendation,
  RollingPatternProduct,
  RollingPatternRun,
} from "./rolling-pattern-types.ts";
import { ZODIAC_NAMES } from "./zodiac.ts";

const V2_MODEL_VERSION = "rolling-product-ev-v2";
const CANONICAL_V1_CANDIDATE_UNIVERSE = buildCanonicalV1CandidateUniverse();

export type V1BootstrapCorrectionInput = {
  name?: string;
  game: GameId;
  targetIssue: string;
  run: RollingPatternRun;
  rollout: ForwardLearningRollout;
  recommendationHash: string;
  existing: ResolvedForwardSnapshot | null;
  scoreCount: number;
  verifiedMatchingDraw: Draw | null;
  now: Date;
};

export type CorrectionGateResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function canCorrectV1Bootstrap(
  input: V1BootstrapCorrectionInput,
): CorrectionGateResult {
  const reject = (reason: string): CorrectionGateResult => ({ allowed: false, reason });
  if (input.run.game !== input.game || input.run.targetIssue !== input.targetIssue ||
    input.run.status !== "completed" ||
    input.run.window.game !== input.game ||
    input.run.window.drawCount !== 30 ||
    input.run.window.newestIssue !== input.run.sourceIssue ||
    !input.run.runId.trim() || !input.run.window.dataHash.trim() ||
    !Number.isFinite(Date.parse(input.run.frozenAt)) ||
    !Number.isFinite(Date.parse(input.run.expectedDrawAt)) ||
    Date.parse(input.run.frozenAt) >= Date.parse(input.run.expectedDrawAt)) {
    return reject("冻结规律运行来源不匹配");
  }
  const pinnedCorrection = input.game === "new_macau" && input.targetIssue === "2026231";
  const expectedRollout = pinnedCorrection
    ? NEW_MACAU_2026231_ROLLOUT
    : {
      game: input.game,
      firstUnifiedTargetIssue: input.targetIssue,
      legacySeedThroughIssue: input.run.sourceIssue,
      seedQueryVersion: "legacy-target-cutoff-v1" as const,
      sourceRunId: input.run.runId,
      sourceDataHash: input.run.window.dataHash,
      authoritativeRecommendationHash: input.recommendationHash,
      createdAt: input.run.frozenAt,
    };
  if (pinnedCorrection && (
    input.run.runId !== NEW_MACAU_2026231_ROLLOUT.sourceRunId ||
    input.run.window.dataHash !== NEW_MACAU_2026231_ROLLOUT.sourceDataHash ||
    input.run.expectedDrawAt !== "2026-08-19T13:32:00.000Z"
  )) {
    return reject("冻结规律运行来源不匹配");
  }
  if (canonicalRolloutIdentity(input.rollout) !== canonicalRolloutIdentity(expectedRollout)) {
    return reject("不可变启动记录不匹配");
  }
  if ((pinnedCorrection &&
      input.recommendationHash !== NEW_MACAU_2026231_AUTHORITATIVE_HASH) ||
    input.recommendationHash !== input.rollout.authoritativeRecommendationHash) {
    return reject("权威五项哈希不匹配");
  }
  const existing = input.existing;
  const candidateIds = new Set(existing?.candidates.map((candidate) =>
    candidate.candidateId
  ));
  const candidateResults = new Set(existing?.candidates.map((candidate) =>
    `${candidate.slot}:${candidate.resultKey}`
  ));
  const slotCounts = new Map<ForwardLearningSlot, number>();
  for (const candidate of existing?.candidates ?? []) {
    slotCounts.set(candidate.slot, (slotCounts.get(candidate.slot) ?? 0) + 1);
  }
  const expectedSlotCounts = new Map<ForwardLearningSlot, number>([
    ["coverage_zodiac", 12],
    ["coverage_tail", 10],
    ["coverage_zodiac_pair", 66],
    ["coverage_zodiac_triple", 220],
    ["special_number", 49],
  ]);
  if (!existing || existing.source !== "v1" || existing.revision !== 1 ||
    existing.revisionId !== null ||
    existing.game !== input.game || existing.targetIssue !== input.targetIssue ||
    existing.candidates.length !== 357 ||
    candidateIds.size !== 357 || candidateResults.size !== 357 ||
    [...expectedSlotCounts].some(([slot, count]) => slotCounts.get(slot) !== count) ||
    existing.candidates.some((candidate) =>
      candidate.game !== input.game || candidate.targetIssue !== input.targetIssue ||
      candidate.candidateId !==
        `${input.run.runId}:${candidate.slot}:${candidate.resultKey}` ||
      candidate.dataVersion !== input.run.window.dataHash ||
      candidate.frozenAt !== input.run.frozenAt ||
      !candidate.modelVersion.startsWith("forward-learning-v1") ||
      !matchesCanonicalV1Candidate(candidate)
    )) {
    return reject("v1候选快照不完整");
  }
  const candidatesById = new Map(existing.candidates.map((candidate) => [
    candidate.candidateId,
    candidate,
  ]));
  const officialSlots = new Set(existing.forecasts.map((forecast) => forecast.slot));
  const forecastIds = new Set(existing.forecasts.map((forecast) => forecast.forecastId));
  if (existing.forecasts.length !== FORWARD_LEARNING_SLOTS.length ||
    officialSlots.size !== FORWARD_LEARNING_SLOTS.length ||
    forecastIds.size !== FORWARD_LEARNING_SLOTS.length ||
    !FORWARD_LEARNING_SLOTS.every((slot) => officialSlots.has(slot)) ||
    existing.forecasts.some((forecast) => {
      const candidate = candidatesById.get(forecast.candidateId);
      return !candidate || !forecast.official || forecast.rank !== 1 ||
        forecast.game !== input.game ||
        forecast.targetIssue !== input.targetIssue ||
        forecast.forecastId !== `forecast:${forecast.candidateId}` ||
        canonicalJson(v1CandidateProjection(forecast)) !==
          canonicalJson(v1CandidateProjection(candidate));
    })) {
    return reject("v1正式五槽位不完整");
  }
  if (!Number.isInteger(input.scoreCount) || input.scoreCount !== 0) {
    return reject("已存在候选或修订评分");
  }
  if (input.verifiedMatchingDraw?.verified &&
    input.verifiedMatchingDraw.game === input.game &&
    input.verifiedMatchingDraw.issue === input.targetIssue) {
    return reject("已存在核验开奖结果");
  }
  const now = input.now.getTime();
  const deadline = Date.parse(input.run.expectedDrawAt);
  if (!Number.isFinite(now) || !Number.isFinite(deadline) || now >= deadline) {
    return reject("开奖时间已到");
  }
  return { allowed: true };
}

function buildCanonicalV1CandidateUniverse() {
  const specs: Array<{
    slot: ForwardLearningSlot;
    resultKey: string;
    label: string;
    values: string[];
  }> = [];
  for (const zodiac of ZODIAC_NAMES) {
    specs.push({
      slot: "coverage_zodiac",
      resultKey: zodiac,
      label: zodiac,
      values: [zodiac],
    });
  }
  for (let tail = 0; tail <= 9; tail += 1) {
    const label = `${tail}尾`;
    specs.push({
      slot: "coverage_tail",
      resultKey: label,
      label,
      values: [label],
    });
  }
  for (const values of combinations(ZODIAC_NAMES, 2)) {
    specs.push({
      slot: "coverage_zodiac_pair",
      resultKey: values.join("+"),
      label: values.join("＋"),
      values: [...values],
    });
  }
  for (const values of combinations(ZODIAC_NAMES, 3)) {
    specs.push({
      slot: "coverage_zodiac_triple",
      resultKey: values.join("+"),
      label: values.join("＋"),
      values: [...values],
    });
  }
  for (let number = 1; number <= 49; number += 1) {
    const label = String(number).padStart(2, "0");
    specs.push({
      slot: "special_number",
      resultKey: label,
      label,
      values: [label],
    });
  }
  const universe = new Map(specs.map((spec) => [
    `${spec.slot}:${spec.resultKey}`,
    spec,
  ]));
  if (universe.size !== 357) {
    throw new Error(`v1规范候选宇宙无效：${universe.size}/357`);
  }
  return universe;
}

function matchesCanonicalV1Candidate(candidate: ForwardLearningCandidate) {
  const expected = CANONICAL_V1_CANDIDATE_UNIVERSE.get(
    `${candidate.slot}:${candidate.resultKey}`,
  );
  return Boolean(expected) && candidate.label === expected?.label &&
    canonicalJson(candidate.values) === canonicalJson(expected?.values);
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  const visit = (start: number, current: T[]) => {
    if (current.length === size) {
      result.push([...current]);
      return;
    }
    for (let index = start; index < items.length; index += 1) {
      current.push(items[index]);
      visit(index + 1, current);
      current.pop();
    }
  };
  visit(0, []);
  return result;
}

export function mapProductsToRevisionSnapshot(input: {
  run: RollingPatternRun;
  products: readonly RollingPatternProduct[];
  recommendations: readonly AuthoritativeRecommendation[];
  rollout: ForwardLearningRollout;
  revision: number;
  reason: "initial" | "correct-v1-bootstrap" | "migrate-unscored-v1";
  previousForecasts?: readonly ForwardLearningForecast[];
}): ForwardLearningRevisionSnapshot {
  assertMapperInput(input);
  const revisionId = `${input.run.game}:${input.run.targetIssue}:r${input.revision}`;
  const candidates = input.products.map((product) =>
    mapProductToCandidate(product, revisionId, input.revision)
  );
  const candidatesByResult = new Map(candidates.map((candidate) => [
    `${candidate.slot}:${candidate.resultKey}`,
    candidate,
  ]));
  const recommendations = [...input.recommendations]
    .sort((left, right) => slotIndex(left.kind) - slotIndex(right.kind));
  const forecasts = recommendations.map((recommendation) => {
    const candidate = candidatesByResult.get(
      `${recommendation.kind}:${recommendation.resultKey}`,
    );
    if (!candidate || !recommendationMatchesCandidate(recommendation, candidate)) {
      throw new Error(`权威推荐与冻结产品不一致：${recommendation.kind}`);
    }
    return mapCandidateToForecast(
      candidate,
      candidates,
      input.previousForecasts ?? [],
    );
  });
  const base = {
    revisionId,
    game: input.run.game,
    targetIssue: input.run.targetIssue,
    revision: input.revision,
    status: "processing" as const,
    selectionPolicy: V2_MODEL_VERSION,
    sourceRunId: input.run.runId,
    dataVersion: input.run.window.dataHash,
    contentHash: "",
    reason: input.reason,
    createdAt: input.run.frozenAt,
    committedAt: null,
    recommendationHash: sha256Hex(canonicalRecommendationPayload(recommendations)),
    rollout: { ...input.rollout },
    recommendations,
    candidates,
    forecasts,
  } satisfies ForwardLearningRevisionSnapshot;
  return {
    ...base,
    contentHash: sha256Hex(canonicalRevisionPayload(base)),
  };
}

export function canonicalRecommendationPayload(
  recommendations: readonly AuthoritativeRecommendation[],
): string {
  return JSON.stringify([...recommendations]
    .sort((left, right) => slotIndex(left.kind) - slotIndex(right.kind))
    .map((recommendation) => ({
      kind: recommendation.kind,
      resultKey: recommendation.resultKey,
      values: recommendation.values,
      sourceProductId: recommendation.sourceProductId,
      p30: recommendation.p30,
      legacySeedProbability: recommendation.legacySeedProbability,
      learnedProbability: recommendation.learnedProbability,
      netOdds: recommendation.netOdds,
      breakEvenProbability: recommendation.breakEvenProbability,
      expectedValue: recommendation.expectedValue,
      support: recommendation.product.support,
      hits: recommendation.product.hits,
      legacySettledCount: recommendation.legacySettledCount,
      legacyHitCount: recommendation.legacyHitCount,
    })));
}

export function hashAuthoritativeRecommendations(
  recommendations: readonly AuthoritativeRecommendation[],
) {
  return sha256Hex(canonicalRecommendationPayload(recommendations));
}

export function canonicalRevisionPayload(
  snapshot: ForwardLearningRevisionSnapshot,
): string {
  return canonicalJson({
    revision: {
      revisionId: snapshot.revisionId,
      game: snapshot.game,
      targetIssue: snapshot.targetIssue,
      revision: snapshot.revision,
      selectionPolicy: snapshot.selectionPolicy,
      sourceRunId: snapshot.sourceRunId,
      dataVersion: snapshot.dataVersion,
      reason: snapshot.reason,
      createdAt: snapshot.createdAt,
    },
    rollout: {
      game: snapshot.rollout.game,
      firstUnifiedTargetIssue: snapshot.rollout.firstUnifiedTargetIssue,
      legacySeedThroughIssue: snapshot.rollout.legacySeedThroughIssue,
      seedQueryVersion: snapshot.rollout.seedQueryVersion,
      sourceRunId: snapshot.rollout.sourceRunId,
      sourceDataHash: snapshot.rollout.sourceDataHash,
      authoritativeRecommendationHash: snapshot.rollout.authoritativeRecommendationHash,
      createdAt: snapshot.rollout.createdAt,
    },
    recommendationHash: snapshot.recommendationHash,
    candidates: [...snapshot.candidates]
      .sort(compareCandidateIdentity)
      .map(candidateProjection),
    forecasts: [...snapshot.forecasts]
      .sort((left, right) => slotIndex(left.slot) - slotIndex(right.slot))
      .map(forecastProjection),
  });
}

function mapProductToCandidate(
  product: RollingPatternProduct,
  revisionId: string,
  revision: number,
): ForwardLearningCandidateV2 {
  const slot = product.kind;
  const resultKey = product.values.join("+");
  return {
    candidateId: `candidate:unified-v2:${revisionId}:${slot}:${resultKey}`,
    revisionId,
    revision,
    game: product.game,
    targetIssue: product.targetIssue,
    slot,
    resultKey,
    label: product.label,
    values: [...product.values],
    baselineProbability: product.baselineProbability,
    expertProbabilities: {
      baseline: product.patternProbability,
      rules30: product.legacySeedProbability,
      forward: product.estimatedProbability,
    },
    expertWeights: { baseline: 0, rules30: 0, forward: 1 },
    finalProbability: product.estimatedProbability,
    netOdds: product.netOdds,
    rawRuleCount: product.strategyCount,
    evidenceClusterCount: product.evidenceEventIds.length,
    ruleContributions: [],
    forwardSettledCount: product.learningSettledCount,
    forwardHitCount: product.learningHitCount,
    forwardBrierSkill: 0,
    frozenAt: product.frozenAt,
    modelVersion: V2_MODEL_VERSION,
    dataVersion: product.dataVersion,
    sourceRunId: product.runId,
    sourceProductId: product.sourceProductId,
    sourceKind: product.sourceKind,
    derivedDefinitionHash: product.derivedDefinitionHash,
    selectionPolicy: V2_MODEL_VERSION,
    patternProbability: product.patternProbability,
    legacySeedProbability: product.legacySeedProbability,
    learnedProbability: product.estimatedProbability,
    breakEvenProbability: product.breakEvenProbability,
    expectedValue: product.expectedValue,
    support: product.support,
    hits: product.hits,
    legacySettledCount: product.legacySettledCount,
    legacyHitCount: product.legacyHitCount,
    learningSettledCount: product.learningSettledCount,
    learningHitCount: product.learningHitCount,
  };
}

function mapCandidateToForecast(
  candidate: ForwardLearningCandidateV2,
  candidates: readonly ForwardLearningCandidateV2[],
  previousForecasts: readonly ForwardLearningForecast[],
): ForwardLearningForecastV2 {
  const previous = previousForecasts.find((item) => item.slot === candidate.slot) ?? null;
  const alternative = candidates
    .filter((item) => item.slot === candidate.slot && item.candidateId !== candidate.candidateId)
    .sort(compareForwardLearningExpectedValue)[0] ?? null;
  const probabilityDelta = previous
    ? candidate.learnedProbability - previous.finalProbability
    : null;
  return {
    ...candidate,
    forecastId: `forecast:${candidate.candidateId}`,
    official: true,
    rank: 1,
    previousResultKey: previous?.resultKey ?? null,
    previousProbability: previous?.finalProbability ?? null,
    probabilityDelta,
    topAlternative: alternative?.label ?? null,
    explanation: [
      `按冻结期望值排序选出：EV ${candidate.expectedValue.toFixed(6)}`,
      `30期模式概率 ${(candidate.patternProbability * 100).toFixed(2)}%，旧种子后 ${(candidate.legacySeedProbability * 100).toFixed(2)}%`,
      `新版已结算 ${candidate.learningSettledCount} 次，命中 ${candidate.learningHitCount} 次`,
    ],
  };
}

function assertMapperInput(input: {
  run: RollingPatternRun;
  products: readonly RollingPatternProduct[];
  recommendations: readonly AuthoritativeRecommendation[];
  rollout: ForwardLearningRollout;
  revision: number;
}) {
  if (input.run.status !== "completed" || input.products.length !== 357) {
    throw new Error("统一逐期学习只接受完整的不可变357产品快照");
  }
  if (!Number.isInteger(input.revision) || input.revision < 1) {
    throw new Error("逐期学习修订号无效");
  }
  if (input.rollout.game !== input.run.game ||
    input.run.targetIssue.localeCompare(
      input.rollout.firstUnifiedTargetIssue,
      "en",
      { numeric: true },
    ) < 0 ||
    !input.rollout.sourceRunId.trim() || !input.rollout.sourceDataHash.trim()) {
    throw new Error("启动记录与冻结规律运行不一致");
  }
  if (input.recommendations.length !== FORWARD_LEARNING_SLOTS.length ||
    new Set(input.recommendations.map((item) => item.kind)).size !==
      FORWARD_LEARNING_SLOTS.length) {
    throw new Error("权威推荐必须恰好包含五个唯一槽位");
  }
  const identities = new Set(input.products.map((product) =>
    `${product.kind}:${product.values.join("+")}`
  ));
  if (identities.size !== input.products.length || input.products.some((product) =>
    product.runId !== input.run.runId ||
    product.game !== input.run.game ||
    product.targetIssue !== input.run.targetIssue ||
    product.dataVersion !== input.run.window.dataHash
  )) {
    throw new Error("统一产品快照来源不一致");
  }
}

function recommendationMatchesCandidate(
  recommendation: AuthoritativeRecommendation,
  candidate: ForwardLearningCandidateV2,
) {
  return recommendation.sourceRunId === candidate.sourceRunId &&
    recommendation.sourceProductId === candidate.sourceProductId &&
    recommendation.sourceKind === candidate.sourceKind &&
    recommendation.dataVersion === candidate.dataVersion &&
    recommendation.revision === candidate.revision &&
    recommendation.p30 === candidate.patternProbability &&
    recommendation.legacySeedProbability === candidate.legacySeedProbability &&
    recommendation.learnedProbability === candidate.learnedProbability &&
    recommendation.netOdds === candidate.netOdds &&
    recommendation.breakEvenProbability === candidate.breakEvenProbability &&
    recommendation.expectedValue === candidate.expectedValue &&
    recommendation.legacySettledCount === candidate.legacySettledCount &&
    recommendation.legacyHitCount === candidate.legacyHitCount &&
    recommendation.learningSettledCount === candidate.learningSettledCount &&
    recommendation.learningHitCount === candidate.learningHitCount;
}

function compareCandidateIdentity(
  left: ForwardLearningCandidateV2,
  right: ForwardLearningCandidateV2,
) {
  return slotIndex(left.slot) - slotIndex(right.slot) ||
    asciiCompare(left.resultKey, right.resultKey);
}

function candidateProjection(candidate: ForwardLearningCandidateV2) {
  return {
    candidateId: candidate.candidateId,
    revisionId: candidate.revisionId,
    game: candidate.game,
    targetIssue: candidate.targetIssue,
    revision: candidate.revision,
    slot: candidate.slot,
    resultKey: candidate.resultKey,
    label: candidate.label,
    values: candidate.values,
    baselineProbability: candidate.baselineProbability,
    expertProbabilities: candidate.expertProbabilities,
    expertWeights: candidate.expertWeights,
    finalProbability: candidate.finalProbability,
    netOdds: candidate.netOdds,
    rawRuleCount: candidate.rawRuleCount,
    evidenceClusterCount: candidate.evidenceClusterCount,
    ruleContributions: candidate.ruleContributions,
    frozenAt: candidate.frozenAt,
    dataVersion: candidate.dataVersion,
    sourceRunId: candidate.sourceRunId,
    sourceProductId: candidate.sourceProductId,
    sourceKind: candidate.sourceKind,
    derivedDefinitionHash: candidate.derivedDefinitionHash,
    selectionPolicy: candidate.selectionPolicy,
    patternProbability: candidate.patternProbability,
    legacySeedProbability: candidate.legacySeedProbability,
    learnedProbability: candidate.learnedProbability,
    breakEvenProbability: candidate.breakEvenProbability,
    expectedValue: candidate.expectedValue,
    support: candidate.support,
    hits: candidate.hits,
    legacySettledCount: candidate.legacySettledCount,
    legacyHitCount: candidate.legacyHitCount,
    learningSettledCount: candidate.learningSettledCount,
    learningHitCount: candidate.learningHitCount,
    forwardSettledCount: candidate.forwardSettledCount,
    forwardHitCount: candidate.forwardHitCount,
    forwardBrierSkill: candidate.forwardBrierSkill,
    modelVersion: candidate.modelVersion,
  };
}

function forecastProjection(forecast: ForwardLearningForecastV2) {
  return {
    candidateId: forecast.candidateId,
    forecastId: forecast.forecastId,
    revisionId: forecast.revisionId,
    game: forecast.game,
    targetIssue: forecast.targetIssue,
    revision: forecast.revision,
    slot: forecast.slot,
    resultKey: forecast.resultKey,
    official: forecast.official,
    rank: forecast.rank,
    previousResultKey: forecast.previousResultKey,
    previousProbability: forecast.previousProbability,
    probabilityDelta: forecast.probabilityDelta,
    topAlternative: forecast.topAlternative,
    explanation: forecast.explanation,
  };
}

function v1CandidateProjection(
  candidate: ForwardLearningCandidate,
) {
  return {
    candidateId: candidate.candidateId,
    game: candidate.game,
    targetIssue: candidate.targetIssue,
    slot: candidate.slot,
    resultKey: candidate.resultKey,
    label: candidate.label,
    values: candidate.values,
    baselineProbability: candidate.baselineProbability,
    expertProbabilities: candidate.expertProbabilities,
    expertWeights: candidate.expertWeights,
    finalProbability: candidate.finalProbability,
    netOdds: candidate.netOdds,
    rawRuleCount: candidate.rawRuleCount,
    evidenceClusterCount: candidate.evidenceClusterCount,
    ruleContributions: candidate.ruleContributions,
    forwardSettledCount: candidate.forwardSettledCount,
    forwardHitCount: candidate.forwardHitCount,
    forwardBrierSkill: candidate.forwardBrierSkill,
    frozenAt: candidate.frozenAt,
    modelVersion: candidate.modelVersion,
    dataVersion: candidate.dataVersion,
  };
}

function canonicalJson(value: unknown) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort(asciiCompare)
    .map((key) => [
      key,
      canonicalize((value as Record<string, unknown>)[key]),
    ]));
}

function slotIndex(slot: ForwardLearningSlot) {
  return FORWARD_LEARNING_SLOTS.indexOf(slot);
}

function canonicalRolloutIdentity(rollout: ForwardLearningRollout) {
  return JSON.stringify({
    game: rollout.game,
    firstUnifiedTargetIssue: rollout.firstUnifiedTargetIssue,
    legacySeedThroughIssue: rollout.legacySeedThroughIssue,
    seedQueryVersion: rollout.seedQueryVersion,
    sourceRunId: rollout.sourceRunId,
    sourceDataHash: rollout.sourceDataHash,
    authoritativeRecommendationHash: rollout.authoritativeRecommendationHash,
    createdAt: rollout.createdAt,
  });
}

function asciiCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Hex(value: string) {
  const words = sha256Words(value);
  return words.map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
}

function sha256Words(value: string) {
  const bytes = [...new TextEncoder().encode(value)];
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((high >>> shift) & 0xff);
  for (let shift = 24; shift >= 0; shift -= 8) bytes.push((low >>> shift) & 0xff);
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const start = offset + index * 4;
      schedule[index] = (
        (bytes[start] << 24) | (bytes[start + 1] << 16) |
        (bytes[start + 2] << 8) | bytes[start + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const left = smallSigma0(schedule[index - 15]);
      const right = smallSigma1(schedule[index - 2]);
      schedule[index] = (schedule[index - 16] + left + schedule[index - 7] + right) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const t1 = (h + bigSigma1(e) + ((e & f) ^ (~e & g)) + SHA256_K[index] + schedule[index]) >>> 0;
      const t2 = (bigSigma0(a) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < state.length; index += 1) {
      state[index] = (state[index] + next[index]) >>> 0;
    }
  }
  return state;
}

function rotateRight(value: number, amount: number) {
  return (value >>> amount) | (value << (32 - amount));
}

function bigSigma0(value: number) {
  return rotateRight(value, 2) ^ rotateRight(value, 13) ^ rotateRight(value, 22);
}

function bigSigma1(value: number) {
  return rotateRight(value, 6) ^ rotateRight(value, 11) ^ rotateRight(value, 25);
}

function smallSigma0(value: number) {
  return rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3);
}

function smallSigma1(value: number) {
  return rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10);
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
