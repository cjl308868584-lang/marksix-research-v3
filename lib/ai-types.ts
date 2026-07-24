import type { GameId, Wave } from "./lottery";

export const AI_FOCUS_OPTIONS = [
  { id: "comprehensive", label: "综合" },
  { id: "numbers", label: "号码" },
  { id: "zodiac", label: "生肖" },
  { id: "wave", label: "波色" },
  { id: "parity", label: "奇偶" },
  { id: "size", label: "大小" },
  { id: "tail", label: "尾数" },
  { id: "hot_cold", label: "冷热" },
  { id: "omission", label: "遗漏" },
  { id: "shape", label: "形态" },
] as const;

export type AiFocus = (typeof AI_FOCUS_OPTIONS)[number]["id"];
export type AiDimensionId = Exclude<AiFocus, "comprehensive">;
export type AiSignalLevel = "neutral" | "weak" | "moderate";
export type AiScenarioId = "balanced" | "momentum" | "contrarian";

export type AiMetric = {
  id: string;
  label: string;
  value: string;
  baseline: string;
  trend: "up" | "down" | "flat";
  window: number;
};

export type AiDimensionEvidence = {
  id: AiDimensionId;
  label: string;
  signal: AiSignalLevel;
  evidenceScore: number;
  direction: string;
  candidates: string[];
  metrics: AiMetric[];
  explanation: string;
  counterEvidence: string[];
};

export type AiScenario = {
  id: AiScenarioId;
  name: string;
  description: string;
  numbers: number[];
  special: number;
  evidenceScore: number;
  diversity: {
    uniqueMainNumbers: number;
    maxMainOverlap: number;
    averageJaccard: number;
    score: number;
  };
  structure: {
    zodiacCount: number;
    waves: Record<Wave, number>;
    odd: number;
    even: number;
    big: number;
    small: number;
    tails: number[];
  };
  supportingEvidence: string[];
  counterEvidence: string[];
};

export type AiConfidenceInterval = {
  low: number;
  high: number;
  level: 95;
  method: "wilson" | "bootstrap_percentile";
};

export type AiBacktestStrategy = {
  id: AiScenarioId;
  name: string;
  sampleSize: number;
  totalMainOverlap: number;
  averageMainOverlap: number;
  averageMainOverlapCI: AiConfidenceInterval;
  averageMainLift: number;
  anyMainOverlapCount: number;
  anyMainOverlapRate: number;
  anyMainOverlapCI: AiConfidenceInterval;
  specialExactCount: number;
  specialExactRate: number;
  specialExactCI: AiConfidenceInterval;
  specialZodiacCount: number;
  specialZodiacRate: number;
  specialZodiacCI: AiConfidenceInterval;
  specialZodiacBaseline: number;
  stabilityScore: number;
  randomPValue: number;
  evidenceScore: number;
};

export type AiBacktestStatus =
  | "insufficient"
  | "no_advantage"
  | "observed_advantage";

export type AiBacktestSegment = {
  role: "selection" | "holdout";
  startIssue: string | null;
  endIssue: string | null;
  testCount: number;
  strategies: AiBacktestStrategy[];
};

export type AiBacktest = {
  method: "nested_holdout_walk_forward";
  trainWindow: number;
  evaluationHistorySize: number;
  selectionCount: number;
  holdoutCount: number;
  testCount: number;
  noLookahead: true;
  multipleComparisonCount: number;
  validationAlpha: number;
  correction: "bonferroni";
  status: AiBacktestStatus;
  decision: "abstain" | "recommend";
  selectedStrategyId: AiScenarioId | null;
  selection: AiBacktestSegment;
  holdout: AiBacktestSegment;
  strategies: AiBacktestStrategy[];
  baseline: {
    averageMainOverlap: number;
    anyMainOverlapRate: number;
    specialExactRate: number;
  };
  conclusion: string;
};

export type AiDimensionInsight = {
  id: AiDimensionId;
  summary: string;
  counterpoint: string;
  evidenceIds: string[];
};

export type AiSynthesis = {
  headline: string;
  executiveSummary: string;
  recommendedScenarioId: AiScenarioId | null;
  recommendationReason: string;
  uncertainty: string;
  strongestSignals: string[];
  conflictingSignals: string[];
  dimensionInsights: AiDimensionInsight[];
};

export type AiFallbackReason =
  | "not_configured"
  | "timeout"
  | "upstream_rate_limited"
  | "provider_error"
  | "invalid_output"
  | "refusal";

export type AiAnalysisResponse = {
  schemaVersion: "3";
  requestId: string;
  mode: "ai" | "statistical";
  status: "ok" | "degraded";
  generatedAt: string;
  cached: boolean;
  game: GameId;
  focus: AiFocus;
  target: {
    issue: string;
    expectedDrawAt: string;
    timezone: "Asia/Shanghai";
  };
  dataQuality: {
    sampleSize: number;
    requestedWindow: number;
    latestIssue: string;
    latestDrawAt: string;
    fetchedAt: string;
    sourceMode: "live" | "snapshot";
    completeness: number;
    verifiedRatio: number;
    fingerprint: string;
    warnings: string[];
  };
  synthesis: AiSynthesis;
  dimensions: AiDimensionEvidence[];
  candidateSets: AiScenario[];
  evidenceStrength: {
    kind: "evidence_strength_not_win_probability";
    score: number;
    label: "低" | "有限" | "中等";
    drivers: string[];
    penalties: string[];
  };
  backtest: AiBacktest;
  risk: {
    randomnessNotice: string;
    noGuarantee: string;
    limitations: string[];
  };
  model: {
    name: string;
    reasoning: string;
    latencyMs: number;
  };
  notice: string;
  fallbackReason: AiFallbackReason | null;
};
