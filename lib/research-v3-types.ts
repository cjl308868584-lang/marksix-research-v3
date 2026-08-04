import type { GameId } from "./lottery";

export const RESEARCH_V3_SCHEMA_VERSION = "3" as const;
export const RESEARCH_V3_ENGINE_VERSION = "high-probability-events-v3.0" as const;
export const RESEARCH_V3_MODEL_VERSION = "champion-challenger-v3.0" as const;
export const RESEARCH_V3_REVIEW_VERSION = "research-event-review-v3" as const;

export type ResearchEventSlot =
  | "zodiac_6_plus_1"
  | "tail_6_plus_1"
  | "position_parity"
  | "position_size";

export type ResearchEventFamily = "zodiac" | "tail" | "parity" | "size";

export type ResearchEventScope =
  | "draw.6_plus_1"
  | "special"
  | `main.position.${1 | 2 | 3 | 4 | 5 | 6}`;

export type ResearchExpertId =
  | "baseline"
  | "interpretable_rules"
  | "logistic"
  | "black_box";

export type ResearchEvidenceTier =
  | "baseline"
  | "shadow"
  | "challenger"
  | "verified";

export type ResearchModelWeight = {
  modelId: ResearchExpertId;
  label: string;
  weight: number;
  probability: number;
  status: "active" | "shadow" | "blocked";
  note: string;
};

export type ResearchRuleContribution = {
  ruleId: string;
  label: string;
  direction: "support" | "suppress";
  window: 40 | 120 | "all" | "python";
  observedRate: number;
  baselineRate: number;
  posteriorRate: number;
  contribution: number;
  support: number;
};

export type ResearchPythonRule = {
  ruleId: string;
  spec: {
    family: "position_transfer" | "conditional_transfer";
    lag: 1 | 2 | 3 | 4 | 5;
    source: string;
    target: string;
    condition: [string, string] | null;
    familyTarget: "zodiac";
  };
  description: string;
  support: number;
  hits: number;
  hitRate: number;
  baselineRate: number;
  shrunkenRate: number;
  pValue: number;
  qValue: number;
  direction: "positive" | "negative";
  resourceDecision: "full_backtest" | "negative_pool";
};

export type ResearchPythonArtifact = {
  schemaVersion: "python-shadow-v3";
  generatedAt: string;
  game: GameId;
  audit: {
    sampleSize: number;
    formalSampleSize: number;
    verifiedRatio: number;
    duplicateIssueCount: number;
    numericGapCount: number;
    oldestIssue: string | null;
    newestIssue: string | null;
    datasetVersion: string;
  };
  resourceFunnel: Record<string, number>;
  topPositiveRules: ResearchPythonRule[];
  topNegativeRules: ResearchPythonRule[];
  blackBox: Record<string, unknown>;
  formalDecision: string;
};

export type ResearchRuleState = {
  ruleId: string;
  slot: ResearchEventSlot;
  triggers: number;
  hits: number;
  consecutiveHits: number;
  consecutiveMisses: number;
  status: "active" | "suppressed" | "retired";
};

export type ResearchRuleStateMap = Partial<
  Record<ResearchEventSlot, Record<string, ResearchRuleState>>
>;

export type ResearchEventHistory = {
  sampleSize: number;
  hits: number;
  hitRate: number;
  expectedHits: number;
  brierSkill: number;
  logLossSkill: number;
  nonWorseFoldRatio: number;
  calibrationError: number;
  posteriorAdvantage: number;
};

export type ResearchEventForecast = {
  eventId: string;
  slot: ResearchEventSlot;
  slotLabel: string;
  scope: ResearchEventScope;
  scopeLabel: string;
  family: ResearchEventFamily;
  predictedValue: string;
  predictionLabel: string;
  /** Probability used for immutable scoring and formal performance claims. */
  probability: number;
  /** Shadow ensemble output; never scored or described as verified advantage. */
  experimentalProbability: number;
  baselineProbability: number;
  uplift: number;
  experimentalUplift: number;
  evidenceTier: ResearchEvidenceTier;
  experts: ResearchModelWeight[];
  ruleContributions: ResearchRuleContribution[];
  history: ResearchEventHistory;
  rationale: string;
  warning: string | null;
};

export type ResearchV3DataQuality = {
  sampleSize: number;
  verifiedSampleSize: number;
  verifiedRatio: number;
  sourceMode: "live" | "snapshot";
  oldestIssue: string | null;
  newestIssue: string | null;
  missingIssueCount: number;
  conflictCount: number;
  datasetVersion: string;
  warnings: string[];
};

export type ResearchV3Snapshot = {
  schemaVersion: typeof RESEARCH_V3_SCHEMA_VERSION;
  engineVersion: typeof RESEARCH_V3_ENGINE_VERSION;
  modelVersion: string;
  runId: string;
  game: GameId;
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt: string;
  frozenAt: string;
  mode: "shadow" | "formal";
  events: [
    ResearchEventForecast,
    ResearchEventForecast,
    ResearchEventForecast,
    ResearchEventForecast,
  ];
  dataQuality: ResearchV3DataQuality;
  learningSummary: {
    settledForecasts: number;
    champion: ResearchExpertId;
    challenger: ResearchExpertId | null;
    baselineWeightFloor: number;
    fastWindow: 40;
    mediumWindow: 120;
    message: string;
  };
  notice: string;
};

export type ResearchEventReview = {
  eventId: string;
  slot: ResearchEventSlot;
  slotLabel: string;
  prediction: string;
  scopeLabel: string;
  probability: number;
  baselineProbability: number;
  actualMatched: boolean;
  actualLabel: string;
  brier: number;
  baselineBrier: number;
  brierSkill: number;
  logLoss: number;
  baselineLogLoss: number;
  logLossSkill: number;
  ruleContributions: ResearchRuleContribution[];
  modelWeightsBefore: ResearchModelWeight[];
  modelWeightsAfter: ResearchModelWeight[];
  diagnosis: string[];
};

export type ResearchLearningRun = {
  learningRunId: string;
  runId: string;
  game: GameId;
  settledIssue: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "failed";
  championBefore: ResearchExpertId;
  championAfter: ResearchExpertId;
  challengerPromoted: boolean;
  driftDetected: boolean;
  summary: string;
};

export type ResearchChampionDecision = {
  champion: ResearchExpertId;
  challenger?: ResearchExpertId | null;
  formalChampion: ResearchExpertId | null;
  sampleIssues: number;
  confidenceLowerBound: number;
  randomChampionPercentile: number;
};

export type ResearchV3Review = {
  reviewVersion: typeof RESEARCH_V3_REVIEW_VERSION;
  runId: string;
  game: GameId;
  targetIssue: string;
  expectedDrawAt: string;
  frozenAt: string;
  settledAt: string;
  actual: {
    issue: string;
    drawAt: string;
    numbers: number[];
    special: number;
    source: string;
    verified: boolean;
  };
  hits: number;
  total: 4;
  expectedHits: number;
  hitRate: number;
  baselineHitRate: number;
  brier: number;
  baselineBrier: number;
  brierSkill: number;
  logLoss: number;
  baselineLogLoss: number;
  logLossSkill: number;
  events: ResearchEventReview[];
  learningRun: ResearchLearningRun;
  summary: string;
  nextAction: string;
};

export type ResearchPerformancePoint = {
  issue: string;
  settledAt: string;
  hits: number;
  expectedHits: number;
  brierSkill: number;
  logLossSkill: number;
};

export type ResearchV3Performance = {
  game: GameId;
  settledIssues: number;
  settledEvents: number;
  hits: number;
  expectedHits: number;
  hitRate: number;
  baselineHitRate: number;
  hitLift: number;
  brierSkill: number;
  logLossSkill: number;
  windows: Array<{
    window: 20 | 50 | "all";
    issues: number;
    hitRate: number;
    baselineHitRate: number;
    brierSkill: number;
    logLossSkill: number;
  }>;
  curve: ResearchPerformancePoint[];
  conclusion: string;
};

export type ResearchV3Envelope = {
  snapshot: ResearchV3Snapshot;
  source: "computed" | "stored" | "snapshot";
  cycleStatus?: "completed" | "existing" | "awaiting_verification";
};
