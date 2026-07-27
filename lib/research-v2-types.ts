import type { GameId } from "./lottery";

export const RESEARCH_SCHEMA_VERSION = "1" as const;
export const RESEARCH_ENGINE_VERSION = "research-v2.1" as const;
export const RULE_ENGINE_VERSION = "rule-dsl-v1" as const;
export const MODEL_VERSION = "dual-track-shadow-v2" as const;

export type ResearchSourceGrade =
  | "official_verified"
  | "multi_source_consistent"
  | "single_source_unverified"
  | "conflicted";

export type ResearchEvidenceTier =
  | "baseline"
  | "insufficient"
  | "archived"
  | "experimental"
  | "challenger"
  | "verified";

export type ResearchRuleDirection = "positive" | "negative" | "neutral";

export type ResearchTargetFamily =
  | "number"
  | "zodiac"
  | "wave"
  | "tail"
  | "parity"
  | "size"
  | "zone";

export type ResearchTargetScope =
  | "special"
  | `main.position.${1 | 2 | 3 | 4 | 5 | 6}`
  | "main.any"
  | "draw.6_plus_1";

export type ResearchTargetId = `${ResearchTargetScope}.${ResearchTargetFamily}`;

export type RuleField =
  | "special"
  | `main.${1 | 2 | 3 | 4 | 5 | 6}`;

export type RuleTransform =
  | "identity"
  | "mirror"
  | `offset.${number}`;

export type RulePredicate = {
  field: RuleField;
  lag: 1 | 2 | 3 | 4 | 5;
  family: ResearchTargetFamily;
  operator: "equals";
  value: string;
};

export type ResearchRuleSpec = {
  schemaVersion: 1;
  family: "position_transfer" | "conditional_transfer" | "number_transform";
  target: {
    scope: Exclude<ResearchTargetScope, "main.any" | "draw.6_plus_1">;
    family: ResearchTargetFamily;
  };
  source: {
    field: RuleField;
    lag: 1 | 2 | 3 | 4 | 5;
    family: ResearchTargetFamily;
    transform: RuleTransform;
  };
  predicates: RulePredicate[];
};

export type ResearchRuleEvidence = {
  ruleId: string;
  family: ResearchRuleSpec["family"];
  description: string;
  direction: ResearchRuleDirection;
  tier: ResearchEvidenceTier;
  targetId: ResearchTargetId;
  support: number;
  hits: number;
  hitRate: number;
  baselineRate: number;
  shrunkenRate: number;
  lift: number;
  brierSkill: number;
  nonWorseFoldRatio: number;
  pValue: number;
  qValue: number;
  stabilityScore: number;
  currentPrediction: string | null;
  currentTriggerMatched: boolean;
  resourceDecision:
    | "full_backtest"
    | "negative_pool"
    | "insufficient_support"
    | "not_above_baseline"
    | "archived_by_cap";
  spec: ResearchRuleSpec;
};

export type ResearchProbability = {
  value: string;
  label: string;
  probability: number;
  baseline: number;
  deltaPrevious: number;
};

export type ResearchTargetForecast = {
  targetId: ResearchTargetId;
  label: string;
  scope: ResearchTargetScope;
  family: ResearchTargetFamily;
  evidenceTier: ResearchEvidenceTier;
  formalProbabilities: ResearchProbability[];
  experimentalProbabilities: ResearchProbability[];
  top1: string;
  top3: string[];
  activeRuleIds: string[];
  conclusion: string;
};

export type ResearchModelSummary = {
  id: "uniform" | "interpretable_fast" | "interpretable_medium" | "interpretable_slow" | "black_box";
  label: string;
  role: "baseline" | "interpretable" | "challenger";
  status: "active" | "shadow" | "blocked_insufficient_data";
  window: number | null;
  brierSkill: number | null;
  logLossSkill: number | null;
  sampleSize: number;
  note: string;
};

export type ResearchPostmortem = {
  settledIssue: string;
  settledAt: string;
  actualSpecial: number;
  actualSpecialZodiac: string;
  previousTopSpecialZodiac: string | null;
  previousActualProbability: number | null;
  ruleHits: number;
  ruleMisses: number;
  summary: string;
  nextAction: string;
} | null;

export type ResearchDataQuality = {
  sampleSize: number;
  formalSampleSize: number;
  sourceGrade: ResearchSourceGrade;
  datasetVersion: string;
  verifiedRatio: number;
  oldestIssue: string | null;
  newestIssue: string | null;
  warnings: string[];
};

export type ResearchSnapshot = {
  schemaVersion: typeof RESEARCH_SCHEMA_VERSION;
  engineVersion: typeof RESEARCH_ENGINE_VERSION;
  ruleEngineVersion: typeof RULE_ENGINE_VERSION;
  modelVersion: typeof MODEL_VERSION;
  runId: string;
  game: GameId;
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt: string;
  mode: "shadow";
  evidenceTier: ResearchEvidenceTier;
  dataQuality: ResearchDataQuality;
  targetForecasts: ResearchTargetForecast[];
  verifiedRules: ResearchRuleEvidence[];
  experimentalRules: ResearchRuleEvidence[];
  negativeRules: ResearchRuleEvidence[];
  archivedRuleCount: number;
  generatedRuleCount: number;
  fullBacktestRuleCount: number;
  resourceReductionRate: number;
  modelComparison: ResearchModelSummary[];
  previousForecastDelta: {
    comparable: boolean;
    largestChanges: Array<{
      targetId: ResearchTargetId;
      value: string;
      delta: number;
    }>;
    summary: string;
  };
  postmortem: ResearchPostmortem;
  notice: string;
};

export type ResearchRunEnvelope = {
  snapshot: ResearchSnapshot;
  rules: ResearchRuleEvidence[];
  source: "computed" | "stored" | "snapshot";
};
