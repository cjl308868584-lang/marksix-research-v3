import type { GameId } from "./lottery";

export const ROLLING_PATTERN_ENGINE_VERSION = "conditional-patterns-v2";

export type RollingPatternFamily = "zodiac" | "tail" | "wave" | "head";

export type RollingPatternEvent = {
  eventId: string;
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
  funnel: {
    generated: number;
    currentTriggered: number;
    deduplicated: number;
    aboveBaseline: number;
    qualified: number;
  };
  signals: RollingPatternSignal[];
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
