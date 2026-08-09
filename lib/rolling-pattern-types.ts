import type { GameId } from "./lottery";

export const ROLLING_PATTERN_ENGINE_VERSION = "rolling-patterns-v1";

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

export type RollingPatternWindow = {
  game: GameId;
  drawCount: number;
  oldestIssue: string;
  newestIssue: string;
  dataHash: string;
};

export type RollingPatternRuleFamily =
  | "omission_recovery"
  | "continuation"
  | "state_transition"
  | "lag_recurrence";

export type RollingPatternRule = {
  ruleId: string;
  family: RollingPatternRuleFamily;
  event: RollingPatternEvent;
  statePattern: Array<boolean | null>;
  parameters: { length?: number; lag?: number };
  prediction: true;
  canonicalJson: string;
  description: string;
};

export type RollingPatternTriggerAudit = {
  sourceIssue: string;
  targetIssue: string;
  targetDrawAt: string;
  matched: boolean;
};

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
  sampleLabel: RollingPatternSampleLabel;
  relatedRuleCount: number;
  stateHistory: RollingPatternEventState[];
  audit: RollingPatternTriggerAudit[];
};

export type RollingPatternRun = {
  schemaVersion: "rolling-patterns-1";
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
