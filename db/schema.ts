import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const aiRateLimits = sqliteTable(
  "ai_rate_limits",
  {
    bucketKey: text("bucket_key").primaryKey(),
    count: integer("count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("ai_rate_limits_expires_idx").on(table.expiresAt)],
);

export const aiForecastLedger = sqliteTable(
  "ai_forecast_ledger",
  {
    forecastId: text("forecast_id").primaryKey(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    expectedDrawAt: text("expected_draw_at").notNull(),
    analysisCutoffAt: text("analysis_cutoff_at").notNull(),
    windowSize: integer("window_size").notNull(),
    focus: text("focus").notNull(),
    depth: text("depth").notNull(),
    dataFingerprint: text("data_fingerprint").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    model: text("model").notNull(),
    reasoning: text("reasoning").notNull(),
    responseJson: text("response_json").notNull(),
    lockedAt: text("locked_at").notNull(),
    actualJson: text("actual_json"),
    settledAt: text("settled_at"),
  },
  (table) => [
    index("ai_forecast_ledger_game_target_idx").on(table.game, table.targetIssue),
    index("ai_forecast_ledger_unsettled_idx").on(
      table.game,
      table.settledAt,
      table.targetIssue,
    ),
  ],
);

export const aiPrimaryObservationLocks = sqliteTable(
  "ai_primary_observation_locks",
  {
    lockId: text("lock_id").primaryKey(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    expectedDrawAt: text("expected_draw_at").notNull(),
    algorithmVersion: text("algorithm_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    payloadJson: text("payload_json").notNull(),
    lockedAt: text("locked_at").notNull(),
    actualJson: text("actual_json"),
    settledAt: text("settled_at"),
  },
  (table) => [
    uniqueIndex("ai_primary_observation_identity_idx").on(
      table.game,
      table.targetIssue,
      table.algorithmVersion,
      table.schemaVersion,
    ),
  ],
);

export const lotteryDraws = sqliteTable(
  "lottery_draws",
  {
    drawId: text("draw_id").primaryKey(),
    game: text("game").notNull(),
    issue: text("issue").notNull(),
    drawAt: text("draw_at").notNull(),
    main1: integer("main_1").notNull(),
    main2: integer("main_2").notNull(),
    main3: integer("main_3").notNull(),
    main4: integer("main_4").notNull(),
    main5: integer("main_5").notNull(),
    main6: integer("main_6").notNull(),
    special: integer("special").notNull(),
    sourceGrade: text("source_grade").notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    sourceHash: text("source_hash").notNull(),
    availableAt: text("available_at").notNull(),
    ingestedAt: text("ingested_at").notNull(),
    datasetVersion: text("dataset_version").notNull(),
  },
  (table) => [
    uniqueIndex("lottery_draws_game_issue_idx").on(table.game, table.issue),
    index("lottery_draws_game_draw_at_idx").on(table.game, table.drawAt),
    index("lottery_draws_dataset_idx").on(table.datasetVersion),
  ],
);

export const drawSourceSnapshots = sqliteTable(
  "draw_source_snapshots",
  {
    snapshotId: text("snapshot_id").primaryKey(),
    game: text("game").notNull(),
    issue: text("issue").notNull(),
    source: text("source").notNull(),
    sourceGrade: text("source_grade").notNull(),
    fetchedAt: text("fetched_at").notNull(),
    bodyHash: text("body_hash").notNull(),
    rawJson: text("raw_json").notNull(),
    status: text("status").notNull(),
  },
  (table) => [
    uniqueIndex("draw_source_snapshot_identity_idx").on(
      table.game,
      table.issue,
      table.source,
      table.bodyHash,
    ),
    index("draw_source_snapshot_issue_idx").on(table.game, table.issue),
  ],
);

export const datasetVersions = sqliteTable(
  "dataset_versions",
  {
    datasetVersion: text("dataset_version").primaryKey(),
    game: text("game").notNull(),
    generatedAt: text("generated_at").notNull(),
    oldestIssue: text("oldest_issue"),
    newestIssue: text("newest_issue"),
    drawCount: integer("draw_count").notNull(),
    formalDrawCount: integer("formal_draw_count").notNull(),
    missingIssueCount: integer("missing_issue_count").notNull().default(0),
    conflictCount: integer("conflict_count").notNull().default(0),
    fingerprint: text("fingerprint").notNull(),
    summaryJson: text("summary_json").notNull(),
  },
  (table) => [
    index("dataset_versions_game_generated_idx").on(
      table.game,
      table.generatedAt,
    ),
  ],
);

export const researchRuleDefinitions = sqliteTable(
  "research_rule_definitions",
  {
    ruleId: text("rule_id").primaryKey(),
    ruleEngineVersion: text("rule_engine_version").notNull(),
    family: text("family").notNull(),
    targetId: text("target_id").notNull(),
    direction: text("direction").notNull(),
    canonicalJson: text("canonical_json").notNull(),
    description: text("description").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("research_rule_canonical_idx").on(
      table.ruleEngineVersion,
      table.canonicalJson,
    ),
    index("research_rule_target_idx").on(table.targetId, table.family),
  ],
);

export const researchRuleEvaluations = sqliteTable(
  "research_rule_evaluations",
  {
    evaluationId: text("evaluation_id").primaryKey(),
    runId: text("run_id").notNull(),
    ruleId: text("rule_id").notNull(),
    game: text("game").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    tier: text("tier").notNull(),
    direction: text("direction").notNull(),
    support: integer("support").notNull(),
    hits: integer("hits").notNull(),
    metricsJson: text("metrics_json").notNull(),
    resourceDecision: text("resource_decision").notNull(),
    evaluatedAt: text("evaluated_at").notNull(),
  },
  (table) => [
    uniqueIndex("research_rule_evaluation_identity_idx").on(
      table.runId,
      table.ruleId,
    ),
    index("research_rule_evaluation_rank_idx").on(
      table.game,
      table.tier,
      table.evaluatedAt,
    ),
  ],
);

export const researchModelRegistry = sqliteTable(
  "research_model_registry",
  {
    modelVersion: text("model_version").primaryKey(),
    game: text("game").notNull(),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    codeVersion: text("code_version").notNull(),
    configJson: text("config_json").notNull(),
    metricsJson: text("metrics_json").notNull(),
    registeredAt: text("registered_at").notNull(),
  },
  (table) => [
    index("research_model_game_status_idx").on(table.game, table.status),
  ],
);

export const researchForecasts = sqliteTable(
  "research_forecasts",
  {
    runId: text("run_id").primaryKey(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    expectedDrawAt: text("expected_draw_at").notNull(),
    generatedAt: text("generated_at").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    ruleEngineVersion: text("rule_engine_version").notNull(),
    modelVersion: text("model_version").notNull(),
    evidenceTier: text("evidence_tier").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    frozenAt: text("frozen_at").notNull(),
    actualJson: text("actual_json"),
    reviewVersion: text("review_version"),
    reviewJson: text("review_json"),
    settledAt: text("settled_at"),
  },
  (table) => [
    uniqueIndex("research_forecast_target_idx").on(
      table.game,
      table.targetIssue,
      table.ruleEngineVersion,
      table.modelVersion,
    ),
    index("research_forecast_unsettled_idx").on(
      table.game,
      table.settledAt,
      table.targetIssue,
    ),
  ],
);

export const researchRuleLedger = sqliteTable(
  "research_rule_ledger",
  {
    ledgerId: text("ledger_id").primaryKey(),
    runId: text("run_id").notNull(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    ruleId: text("rule_id").notNull(),
    targetId: text("target_id").notNull(),
    direction: text("direction").notNull(),
    predictedValue: text("predicted_value").notNull(),
    frozenRuleJson: text("frozen_rule_json").notNull(),
    frozenAt: text("frozen_at").notNull(),
    actualValue: text("actual_value"),
    actualNumber: integer("actual_number"),
    outcome: text("outcome"),
    directionCorrect: integer("direction_correct", { mode: "boolean" }),
    scoredAt: text("scored_at"),
  },
  (table) => [
    uniqueIndex("research_rule_ledger_identity_idx").on(
      table.runId,
      table.ruleId,
    ),
    index("research_rule_ledger_issue_idx").on(
      table.game,
      table.targetIssue,
      table.scoredAt,
    ),
  ],
);

export const researchForecastScores = sqliteTable(
  "research_forecast_scores",
  {
    scoreId: text("score_id").primaryKey(),
    runId: text("run_id").notNull(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    targetId: text("target_id").notNull(),
    brierScore: real("brier_score").notNull(),
    baselineBrierScore: real("baseline_brier_score").notNull(),
    logLoss: real("log_loss").notNull(),
    baselineLogLoss: real("baseline_log_loss").notNull(),
    scoreJson: text("score_json").notNull(),
    scoredAt: text("scored_at").notNull(),
  },
  (table) => [
    uniqueIndex("research_forecast_score_identity_idx").on(
      table.runId,
      table.targetId,
    ),
    index("research_forecast_score_game_idx").on(
      table.game,
      table.targetIssue,
    ),
  ],
);

export const researchV3Forecasts = sqliteTable(
  "research_v3_forecasts",
  {
    runId: text("run_id").primaryKey(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    expectedDrawAt: text("expected_draw_at").notNull(),
    generatedAt: text("generated_at").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    engineVersion: text("engine_version").notNull(),
    modelVersion: text("model_version").notNull(),
    mode: text("mode").notNull(),
    snapshotJson: text("snapshot_json").notNull(),
    frozenAt: text("frozen_at").notNull(),
    actualJson: text("actual_json"),
    reviewVersion: text("review_version"),
    reviewJson: text("review_json"),
    settledAt: text("settled_at"),
  },
  (table) => [
    uniqueIndex("research_v3_forecast_identity_idx").on(
      table.game,
      table.targetIssue,
    ),
    index("research_v3_forecast_unsettled_idx").on(
      table.game,
      table.settledAt,
      table.targetIssue,
    ),
  ],
);

export const researchEventLedger = sqliteTable(
  "research_event_ledger",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id").notNull(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    slot: text("slot").notNull(),
    scope: text("scope").notNull(),
    family: text("family").notNull(),
    predictedValue: text("predicted_value").notNull(),
    probability: real("probability").notNull(),
    baselineProbability: real("baseline_probability").notNull(),
    evidenceTier: text("evidence_tier").notNull(),
    frozenEventJson: text("frozen_event_json").notNull(),
    frozenAt: text("frozen_at").notNull(),
    actualMatched: integer("actual_matched", { mode: "boolean" }),
    actualLabel: text("actual_label"),
    scoredAt: text("scored_at"),
  },
  (table) => [
    uniqueIndex("research_event_slot_identity_idx").on(
      table.runId,
      table.slot,
    ),
    index("research_event_issue_idx").on(
      table.game,
      table.targetIssue,
      table.scoredAt,
    ),
  ],
);

export const researchEventScores = sqliteTable(
  "research_event_scores",
  {
    scoreId: text("score_id").primaryKey(),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    slot: text("slot").notNull(),
    probability: real("probability").notNull(),
    baselineProbability: real("baseline_probability").notNull(),
    actualMatched: integer("actual_matched", { mode: "boolean" }).notNull(),
    brierScore: real("brier_score").notNull(),
    baselineBrierScore: real("baseline_brier_score").notNull(),
    logLoss: real("log_loss").notNull(),
    baselineLogLoss: real("baseline_log_loss").notNull(),
    scoreJson: text("score_json").notNull(),
    scoredAt: text("scored_at").notNull(),
  },
  (table) => [
    uniqueIndex("research_event_score_identity_idx").on(
      table.runId,
      table.eventId,
    ),
    index("research_event_score_game_idx").on(
      table.game,
      table.targetIssue,
      table.slot,
    ),
  ],
);

export const researchLearningRuns = sqliteTable(
  "research_learning_runs",
  {
    learningRunId: text("learning_run_id").primaryKey(),
    runId: text("run_id").notNull(),
    game: text("game").notNull(),
    settledIssue: text("settled_issue").notNull(),
    status: text("status").notNull(),
    championBefore: text("champion_before").notNull(),
    championAfter: text("champion_after").notNull(),
    challengerPromoted: integer("challenger_promoted", { mode: "boolean" })
      .notNull(),
    driftDetected: integer("drift_detected", { mode: "boolean" }).notNull(),
    summaryJson: text("summary_json").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at").notNull(),
  },
  (table) => [
    uniqueIndex("research_learning_run_identity_idx").on(
      table.runId,
      table.settledIssue,
    ),
    index("research_learning_game_idx").on(table.game, table.completedAt),
  ],
);

export const researchModelWeights = sqliteTable(
  "research_model_weights",
  {
    weightId: text("weight_id").primaryKey(),
    runId: text("run_id").notNull(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    slot: text("slot").notNull(),
    modelId: text("model_id").notNull(),
    weightBefore: real("weight_before").notNull(),
    weightAfter: real("weight_after").notNull(),
    probability: real("probability").notNull(),
    status: text("status").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("research_model_weight_identity_idx").on(
      table.runId,
      table.slot,
      table.modelId,
    ),
    index("research_model_weight_latest_idx").on(
      table.game,
      table.slot,
      table.updatedAt,
    ),
  ],
);

export const researchRuleStates = sqliteTable(
  "research_rule_states",
  {
    stateId: text("state_id").primaryKey(),
    game: text("game").notNull(),
    slot: text("slot").notNull(),
    ruleId: text("rule_id").notNull(),
    posteriorAlpha: real("posterior_alpha").notNull(),
    posteriorBeta: real("posterior_beta").notNull(),
    triggers: integer("triggers").notNull(),
    hits: integer("hits").notNull(),
    consecutiveHits: integer("consecutive_hits").notNull(),
    consecutiveMisses: integer("consecutive_misses").notNull(),
    recent20Json: text("recent_20_json").notNull(),
    recent50Json: text("recent_50_json").notNull(),
    status: text("status").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("research_rule_state_identity_idx").on(
      table.game,
      table.slot,
      table.ruleId,
    ),
    index("research_rule_state_status_idx").on(
      table.game,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const researchSettlementClaims = sqliteTable(
  "research_settlement_claims",
  {
    runId: text("run_id").primaryKey(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    status: text("status").notNull(),
    claimedAt: text("claimed_at").notNull(),
    completedAt: text("completed_at"),
    errorMessage: text("error_message"),
  },
  (table) => [
    index("research_settlement_claim_game_idx").on(
      table.game,
      table.status,
      table.claimedAt,
    ),
  ],
);

export const researchTaskRuns = sqliteTable(
  "research_task_runs",
  {
    taskId: text("task_id").primaryKey(),
    game: text("game").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    responseJson: text("response_json"),
    errorMessage: text("error_message"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    index("research_task_status_idx").on(
      table.game,
      table.status,
      table.startedAt,
    ),
  ],
);

export const rollingPatternRuns = sqliteTable(
  "rolling_pattern_runs",
  {
    runId: text("run_id").primaryKey(),
    game: text("game").notNull(),
    sourceIssue: text("source_issue").notNull(),
    targetIssue: text("target_issue").notNull(),
    windowOldestIssue: text("window_oldest_issue").notNull(),
    windowNewestIssue: text("window_newest_issue").notNull(),
    windowDataHash: text("window_data_hash").notNull(),
    engineVersion: text("engine_version").notNull(),
    status: text("status").notNull(),
    generatedAt: text("generated_at").notNull(),
    frozenAt: text("frozen_at").notNull(),
    runJson: text("run_json").notNull(),
  },
  (table) => [
    uniqueIndex("rolling_pattern_target_idx").on(
      table.game,
      table.targetIssue,
      table.windowDataHash,
      table.engineVersion,
    ),
  ],
);

export const rollingPatternSignals = sqliteTable(
  "rolling_pattern_signals",
  {
    runId: text("run_id").notNull(),
    ruleId: text("rule_id").notNull(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    ruleFamily: text("rule_family").notNull(),
    eventFamily: text("event_family").notNull(),
    eventValue: text("event_value").notNull(),
    sampleLabel: text("sample_label").notNull(),
    signalJson: text("signal_json").notNull(),
    frozenAt: text("frozen_at").notNull(),
  },
  (table) => [
    uniqueIndex("rolling_pattern_signal_identity_idx").on(
      table.runId,
      table.ruleId,
    ),
    index("rolling_pattern_signal_filter_idx").on(
      table.game,
      table.targetIssue,
      table.eventFamily,
    ),
  ],
);

export const rollingPatternScores = sqliteTable(
  "rolling_pattern_scores",
  {
    runId: text("run_id").notNull(),
    ruleId: text("rule_id").notNull(),
    game: text("game").notNull(),
    targetIssue: text("target_issue").notNull(),
    actualMatched: integer("actual_matched", { mode: "boolean" }).notNull(),
    scoreJson: text("score_json").notNull(),
    scoredAt: text("scored_at").notNull(),
  },
  (table) => [
    uniqueIndex("rolling_pattern_score_identity_idx").on(
      table.runId,
      table.ruleId,
    ),
    index("rolling_pattern_score_issue_idx").on(
      table.game,
      table.targetIssue,
    ),
  ],
);

export const researchModelArtifacts = sqliteTable(
  "research_model_artifacts",
  {
    artifactId: text("artifact_id").primaryKey(),
    game: text("game").notNull(),
    modelVersion: text("model_version").notNull(),
    kind: text("kind").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    datasetVersion: text("dataset_version").notNull(),
    parentArtifactId: text("parent_artifact_id"),
    configJson: text("config_json").notNull(),
    metricsJson: text("metrics_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("research_model_artifact_identity_idx").on(
      table.game,
      table.modelVersion,
      table.kind,
    ),
    index("research_model_artifact_status_idx").on(
      table.game,
      table.status,
      table.createdAt,
    ),
  ],
);
