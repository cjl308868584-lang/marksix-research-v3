import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
