import type { GameId } from "./lottery.ts";
import type { AuthoritativeRecommendation } from "./rolling-pattern-types.ts";

export const FORWARD_LEARNING_ENGINE_VERSION = "forward-learning-v1";

export const FORWARD_LEARNING_SLOTS = [
  "coverage_zodiac",
  "coverage_tail",
  "coverage_zodiac_pair",
  "coverage_zodiac_triple",
  "special_number",
] as const;

export type ForwardLearningSlot = (typeof FORWARD_LEARNING_SLOTS)[number];

export type ExpertWeights = {
  baseline: number;
  rules30: number;
  forward: number;
};

export type ExpertProbabilities = ExpertWeights;

export type ForwardRuleContribution = {
  ruleId: string;
  clusterId: string;
  conditionLabel: string;
  support: number;
  hits: number;
  baselineProbability: number;
  posteriorProbability: number;
  logOddsLift: number;
  effectiveContribution: number;
  primary: boolean;
};

export type ForwardLearningCandidate = {
  candidateId: string;
  game: GameId;
  targetIssue: string;
  slot: ForwardLearningSlot;
  resultKey: string;
  label: string;
  values: string[];
  baselineProbability: number;
  expertProbabilities: ExpertProbabilities;
  expertWeights: ExpertWeights;
  finalProbability: number;
  netOdds: number;
  rawRuleCount: number;
  evidenceClusterCount: number;
  ruleContributions: ForwardRuleContribution[];
  forwardSettledCount: number;
  forwardHitCount: number;
  forwardBrierSkill: number;
  frozenAt: string;
  modelVersion: string;
  dataVersion: string;
};

export type ForwardLearningForecast = ForwardLearningCandidate & {
  forecastId: string;
  official: true;
  rank: 1;
  previousResultKey: string | null;
  previousProbability: number | null;
  probabilityDelta: number | null;
  topAlternative: string | null;
  explanation: string[];
};

export type ForwardLearningCandidateV2 = ForwardLearningCandidate & {
  revisionId: string;
  revision: number;
  sourceRunId: string;
  sourceProductId: string | null;
  sourceKind: "ledger" | "derived_baseline";
  derivedDefinitionHash: string;
  selectionPolicy: "rolling-product-ev-v2";
  patternProbability: number;
  legacySeedProbability: number;
  learnedProbability: number;
  breakEvenProbability: number;
  expectedValue: number;
  support: number;
  hits: number;
  legacySettledCount: number;
  legacyHitCount: number;
  learningSettledCount: number;
  learningHitCount: number;
};

export type ForwardLearningForecastV2 = ForwardLearningCandidateV2 & {
  forecastId: string;
  official: true;
  rank: 1;
  previousResultKey: string | null;
  previousProbability: number | null;
  probabilityDelta: number | null;
  topAlternative: string | null;
  explanation: string[];
};

export type ForwardLearningRollout = {
  game: GameId;
  firstUnifiedTargetIssue: string;
  legacySeedThroughIssue: string;
  seedQueryVersion: "legacy-target-cutoff-v1";
  sourceRunId: string;
  sourceDataHash: string;
  authoritativeRecommendationHash: string;
  createdAt: string;
};

export type ForwardLearningRevision = {
  revisionId: string;
  game: GameId;
  targetIssue: string;
  revision: number;
  status: "processing" | "committed";
  selectionPolicy: "rolling-product-ev-v2";
  sourceRunId: string;
  dataVersion: string;
  contentHash: string;
  reason: "initial" | "correct-v1-bootstrap" | "migrate-unscored-v1";
  createdAt: string;
  committedAt: string | null;
};

export type ForwardLearningRevisionSnapshot = ForwardLearningRevision & {
  recommendationHash: string;
  rollout: ForwardLearningRollout;
  recommendations: AuthoritativeRecommendation[];
  candidates: ForwardLearningCandidateV2[];
  forecasts: ForwardLearningForecastV2[];
};

export type ResolvedForwardSnapshot = {
  source: "v1" | "v2";
  revision: number;
  revisionId: string | null;
  game: GameId;
  targetIssue: string;
  candidates: Array<ForwardLearningCandidate | ForwardLearningCandidateV2>;
  forecasts: Array<ForwardLearningForecast | ForwardLearningForecastV2>;
};

export type ForwardLearningScore = {
  scoreId: string;
  forecastId: string | null;
  candidateId: string;
  game: GameId;
  targetIssue: string;
  slot: ForwardLearningSlot;
  resultKey: string;
  official: boolean;
  actualMatched: boolean;
  probability: number;
  baselineProbability: number;
  brier: number;
  baselineBrier: number;
  logLoss: number;
  baselineLogLoss: number;
  actualNumbers: number[];
  actualSpecial: number;
  scoredAt: string;
};

export type ForwardLearningScoreV2 = ForwardLearningScore & {
  revisionId: string;
  revision: number;
  learnedProbability: number;
};

export type ResolvedSettlement = {
  status: "settled" | "repaired" | "existing" | "not_found";
  source: "v1" | "v2" | null;
  revision: number | null;
  scores: Array<ForwardLearningScore | ForwardLearningScoreV2>;
};

export type ForwardLearningModelState = {
  stateId: string;
  game: GameId;
  slot: ForwardLearningSlot;
  version: string;
  weights: ExpertWeights;
  previousVersion: string | null;
  learnedThroughIssue: string | null;
  generatedAt: string;
};

export type ForwardRuleUpdate = {
  runId: string;
  game: GameId;
  settledIssue: string;
  slot: ForwardLearningSlot;
  ruleId: string;
  beforeWeight: number;
  afterWeight: number;
  action: "rewarded" | "reduced" | "unchanged" | "paused";
  reason: string;
};

export type ForwardLearningRun = {
  runId: string;
  taskId: string;
  game: GameId;
  settledIssue: string | null;
  targetIssue: string;
  engineVersion: string;
  status: "processing" | "completed" | "failed";
  modelVersionBefore: string | null;
  modelVersionAfter: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type ForwardLearningPerformanceWindow = {
  window: "recent10" | "recent30" | "all";
  settledCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  meanBaseline: number;
  brier: number;
  baselineBrier: number;
  brierSkill: number;
  logLoss: number;
  baselineLogLoss: number;
  logLossSkill: number;
};

export type ForwardLearningSlotPerformance = {
  slot: ForwardLearningSlot;
  windows: ForwardLearningPerformanceWindow[];
};

export type ResolvedV2SlotPerformance = ForwardLearningSlotPerformance & {
  revisionSource: "resolved-v2";
};

export type ProductLearningSlotStatus = {
  slot: ForwardLearningSlot;
  settledCandidates: number;
  officialSamples: number;
  latestAdjustmentPoints: number;
  learnedThroughIssue: string | null;
};

export type AuthoritativeLearningForecast = AuthoritativeRecommendation & {
  slot: ForwardLearningSlot;
  forecastId: string;
  official: true;
  targetIssue: string;
  label: string;
  frozenAt: string;
  explanation: string[];
};

export type ResolvedV2ForwardLearningRun = ForwardLearningRun & {
  revision: number;
  revisionSource: "resolved-v2";
};

export type ResolvedV2OfficialScore = ForwardLearningScoreV2 & {
  official: true;
};

export type ForwardLearningReview = {
  run: ResolvedV2ForwardLearningRun;
  scores: ResolvedV2OfficialScore[];
  modelBefore: ForwardLearningModelState[];
  modelAfter: ForwardLearningModelState[];
  ruleUpdates: ForwardRuleUpdate[];
};

export type ForwardLearningCycleResult = {
  status: "created" | "existing" | "awaiting_verification" | "awaiting_rollout";
  runId: string | null;
  settledIssue: string | null;
  targetIssue: string;
  revision: number | null;
  modelVersion: string;
  forecasts: ForwardLearningForecast[];
};
