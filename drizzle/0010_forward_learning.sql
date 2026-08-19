CREATE TABLE IF NOT EXISTS forward_learning_forecasts (
  forecast_id text PRIMARY KEY, game text NOT NULL, target_issue text NOT NULL,
  slot text NOT NULL, result_key text NOT NULL, probability real NOT NULL,
  baseline_probability real NOT NULL, model_version text NOT NULL,
  data_version text NOT NULL, frozen_at text NOT NULL, official integer NOT NULL,
  forecast_json text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_forecast_slot_idx
  ON forward_learning_forecasts (game, target_issue, slot);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_candidates (
  candidate_id text PRIMARY KEY, game text NOT NULL, target_issue text NOT NULL,
  slot text NOT NULL, result_key text NOT NULL, probability real NOT NULL,
  baseline_probability real NOT NULL, model_version text NOT NULL,
  frozen_at text NOT NULL, candidate_json text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_candidate_issue_idx
  ON forward_learning_candidates (game, target_issue, candidate_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_scores (
  score_id text PRIMARY KEY, forecast_id text, candidate_id text NOT NULL,
  game text NOT NULL, target_issue text NOT NULL, slot text NOT NULL,
  result_key text NOT NULL, official integer NOT NULL, actual_matched integer NOT NULL,
  probability real NOT NULL, baseline_probability real NOT NULL,
  brier real NOT NULL, baseline_brier real NOT NULL, log_loss real NOT NULL,
  baseline_log_loss real NOT NULL, scored_at text NOT NULL, score_json text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_score_candidate_idx
  ON forward_learning_scores (candidate_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_score_forecast_idx
  ON forward_learning_scores (forecast_id) WHERE forecast_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_rule_snapshots (
  candidate_id text NOT NULL, rule_id text NOT NULL, cluster_id text NOT NULL,
  game text NOT NULL, target_issue text NOT NULL, snapshot_json text NOT NULL,
  frozen_at text NOT NULL, PRIMARY KEY (candidate_id, rule_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_rule_updates (
  run_id text NOT NULL, slot text NOT NULL, rule_id text NOT NULL,
  game text NOT NULL, settled_issue text NOT NULL, update_json text NOT NULL,
  generated_at text NOT NULL, PRIMARY KEY (run_id, slot, rule_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_model_states (
  state_id text PRIMARY KEY, game text NOT NULL, slot text NOT NULL,
  version text NOT NULL, learned_through_issue text, state_json text NOT NULL,
  generated_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_model_version_idx
  ON forward_learning_model_states (game, slot, version);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_runs (
  run_id text PRIMARY KEY, task_id text NOT NULL, game text NOT NULL,
  settled_issue text, target_issue text NOT NULL, engine_version text NOT NULL,
  status text NOT NULL, run_json text NOT NULL, started_at text NOT NULL,
  completed_at text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_run_issue_idx
  ON forward_learning_runs (game, settled_issue, engine_version)
  WHERE settled_issue IS NOT NULL;
