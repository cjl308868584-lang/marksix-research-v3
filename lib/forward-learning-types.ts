import type { GameId } from "./lottery.ts";

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

export type ForwardLearningReview = {
  run: ForwardLearningRun;
  scores: ForwardLearningScore[];
  modelBefore: ForwardLearningModelState[];
  modelAfter: ForwardLearningModelState[];
  ruleUpdates: ForwardRuleUpdate[];
};

export type ForwardLearningCycleResult = {
  status: "created" | "existing" | "awaiting_verification";
  runId: string | null;
  settledIssue: string | null;
  targetIssue: string;
  modelVersion: string;
  forecasts: ForwardLearningForecast[];
};

