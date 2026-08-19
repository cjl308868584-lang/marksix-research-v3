import type { GameId } from "./lottery";

export const ROLLING_PATTERN_ENGINE_VERSION = "conditional-patterns-v3";

export type RollingPatternFamily = "zodiac" | "tail" | "wave" | "head";
export type RollingPatternScope = "coverage_6_plus_1" | "special";
export type RollingPatternEventScope = RollingPatternScope | "condition";

export type RollingPatternEvent = {
  eventId: string;
  scope: RollingPatternEventScope;
  family: RollingPatternFamily;
  value: string;
  label: string;
  threshold: 1 | 2 | 3;
  memberCount: number;
};

export type RollingPatternEventState = {
  issue: string;
  drawAt: string;
  matched: boolean;
  count: number;
};

export type RollingPatternCondition = {
  event: RollingPatternEvent;
  expectedMatched: boolean;
};

export type RollingPatternAntecedent =
  | {
      kind: "single";
      conditions: [RollingPatternCondition];
    }
  | {
      kind: "conjunction";
      conditions: [RollingPatternCondition, RollingPatternCondition];
    }
  | {
      kind: "sequence";
      event: RollingPatternEvent;
      states: boolean[];
      requireBoundaryFlip: boolean;
    };

export type RollingPatternConditionEvidence = {
  issue: string;
  drawAt: string;
  eventId: string;
  eventLabel: string;
  expectedMatched: boolean;
  actualMatched: boolean;
  count: number;
};

export type RollingPatternHistoricalAudit = {
  sourceIssue: string;
  targetIssue: string;
  targetDrawAt: string;
  conditionEvidence: RollingPatternConditionEvidence[];
  result: RollingPatternEventState;
  matched: boolean;
};

export type RollingPatternEvidenceTier = "experimental" | "strong";

export type RollingPatternWindow = {
  game: GameId;
  drawCount: number;
  oldestIssue: string;
  newestIssue: string;
  dataHash: string;
};

export type RollingPatternRuleFamily =
  | "single_transfer"
  | "conjunction_transfer"
  | "sequence_transition";

export type RollingPatternRule = {
  ruleId: string;
  family: RollingPatternRuleFamily;
  antecedent: RollingPatternAntecedent;
  event: RollingPatternEvent;
  prediction: true;
  canonicalJson: string;
  conditionLabel: string;
  predictionLabel: string;
  relationLabel: string;
  description: string;
};

export type RollingPatternTriggerAudit = RollingPatternHistoricalAudit;

export type RollingPatternSampleLabel = "小样本" | "有限样本" | "近期重复";

export type RollingPatternSignal = {
  rule: RollingPatternRule;
  currentTriggered: true;
  support: number;
  hits: number;
  rawRate: number;
  baseline: number;
  rawUplift: number;
  posteriorRate: number;
  posteriorUplift: number;
  pValue: number;
  qValue: number;
  evidenceTier: RollingPatternEvidenceTier;
  sampleLabel: RollingPatternSampleLabel;
  relatedRuleCount: number;
  currentEvidence: RollingPatternConditionEvidence[];
  stateHistory: RollingPatternEventState[];
  audit: RollingPatternTriggerAudit[];
};

export type RollingPatternRun = {
  schemaVersion: "rolling-patterns-2";
  engineVersion: string;
  runId: string;
  game: GameId;
  sourceIssue: string;
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt: string;
  frozenAt: string;
  status: "completed";
  window: RollingPatternWindow;
  funnel: RollingPatternFunnel;
  scopeFunnels: Record<RollingPatternScope, RollingPatternFunnel>;
  signals: RollingPatternSignal[];
};

export type RollingPatternFunnel = {
    generated: number;
    currentTriggered: number;
    deduplicated: number;
    aboveBaseline: number;
    qualified: number;
};

export type RollingPatternScore = {
  runId: string;
  ruleId: string;
  game: GameId;
  targetIssue: string;
  actualMatched: boolean;
  actual: RollingPatternEventState;
  scoredAt: string;
};

export type RollingPatternEnvelope = {
  run: RollingPatternRun;
  signals: RollingPatternSignal[];
  scores: RollingPatternScore[];
};

export type RollingPatternResultSummary = {
  eventId: string;
  label: string;
  family: RollingPatternFamily;
  strategyCount: number;
  triggerCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  expectedHits: number;
  baselineRate: number;
  uplift: number;
  strongStrategyCount: number;
  experimentalStrategyCount: number;
};

export type RollingPatternSummary = {
  strategyCount: number;
  resultCount: number;
  triggerCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  expectedHits: number;
  expectedMisses: number;
  baselineRate: number;
  uplift: number;
  strongStrategyCount: number;
  experimentalStrategyCount: number;
  resultGroups: RollingPatternResultSummary[];
};

export type SpecialNumberEvidence = {
  eventId: string;
  label: string;
  family: RollingPatternFamily;
  strategyCount: number;
  triggerCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  baselineRate: number;
  posteriorRate: number;
  contribution: number;
};

export type SpecialNumberConsensus = {
  number: number;
  score: number;
  resultCount: number;
  strategyCount: number;
  triggerCount: number;
  hitCount: number;
  missCount: number;
  hitRate: number;
  evidence: SpecialNumberEvidence[];
};

export type RollingPatternProductKind =
  | "coverage_zodiac"
  | "coverage_tail"
  | "coverage_zodiac_pair"
  | "coverage_zodiac_triple"
  | "special_number";

export type RollingPatternValueStatus = "positive" | "negative" | "pending";

export type RollingPatternProduct = {
  runId: string;
  productId: string;
  dataVersion: string;
  game: GameId;
  targetIssue: string;
  scope: RollingPatternScope;
  kind: RollingPatternProductKind;
  label: string;
  values: string[];
  evidenceEventIds: string[];
  strategyCount: number;
  support: number;
  hits: number;
  misses: number;
  baselineProbability: number;
  patternProbability: number;
  legacySeedProbability: number;
  estimatedProbability: number;
  netOdds: number;
  breakEvenProbability: number;
  expectedValue: number;
  valueStatus: RollingPatternValueStatus;
  legacySettledCount: number;
  legacyHitCount: number;
  learningSettledCount: number;
  learningHitCount: number;
  learningMissCount: number;
  sourceKind: "ledger" | "derived_baseline";
  sourceProductId: string | null;
  derivedDefinitionHash: string;
  forwardSettledCount: number;
  forwardHitCount: number;
  forwardMissCount: number;
  rank: number;
  frozenAt: string;
};

export type ProductHistoryCounts = {
  settledCount: number;
  hitCount: number;
};

export type UnifiedProductHistories = {
  legacy: ReadonlyMap<string, ProductHistoryCounts>;
  learned: ReadonlyMap<string, ProductHistoryCounts>;
  legacyProductIds: ReadonlyMap<string, string>;
};

export type AuthoritativeRecommendation = {
  kind: RollingPatternProductKind;
  resultKey: string;
  values: string[];
  sourceRunId: string;
  sourceProductId: string | null;
  sourceKind: "ledger" | "derived_baseline";
  dataVersion: string;
  revision: number;
  p30: number;
  legacySeedProbability: number;
  learnedProbability: number;
  netOdds: number;
  breakEvenProbability: number;
  expectedValue: number;
  legacySettledCount: number;
  legacyHitCount: number;
  learningSettledCount: number;
  learningHitCount: number;
  product: RollingPatternProduct;
  reason: string;
};

export type RollingPatternRecommendation = {
  kind: RollingPatternProductKind;
  product: RollingPatternProduct | null;
  reason: string;
};

export type RollingPatternProductScore = {
  runId: string;
  productId: string;
  game: GameId;
  targetIssue: string;
  actualMatched: boolean;
  unitProfit: number;
  actualNumbers: number[];
  actualSpecial: number;
  scoredAt: string;
};

export type RollingPatternValueHistory = {
  productId: string;
  kind: RollingPatternProductKind;
  label: string;
  values: string[];
  settledCount: number;
  hitCount: number;
  missCount: number;
  cumulativeProfit: number;
  roi: number;
};

export type RollingPatternValueLedgerEntry = {
  product: RollingPatternProduct;
  score: RollingPatternProductScore | null;
};

export type RollingPatternCycleResult =
  | {
      status: "created" | "existing";
      runId: string;
      qualified: number;
    }
  | {
      status: "insufficient_data";
      missing: number;
      qualified: 0;
    }
  | {
      status: "failed";
      qualified: 0;
      reason: string;
    };
