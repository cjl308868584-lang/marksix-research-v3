CREATE TABLE IF NOT EXISTS forward_learning_rollouts (
  game text PRIMARY KEY,
  first_unified_target_issue text NOT NULL,
  legacy_seed_through_issue text NOT NULL,
  seed_query_version text NOT NULL,
  rollout_json text NOT NULL,
  created_at text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_revisions (
  revision_id text PRIMARY KEY,
  game text NOT NULL,
  target_issue text NOT NULL,
  revision integer NOT NULL,
  status text NOT NULL,
  content_hash text NOT NULL,
  revision_json text NOT NULL,
  created_at text NOT NULL,
  committed_at text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_identity_idx
  ON forward_learning_revisions (game, target_issue, revision);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_revision_candidates (
  candidate_id text PRIMARY KEY,
  revision_id text NOT NULL,
  game text NOT NULL,
  target_issue text NOT NULL,
  revision integer NOT NULL,
  slot text NOT NULL,
  result_key text NOT NULL,
  candidate_json text NOT NULL,
  frozen_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_candidate_result_idx
  ON forward_learning_revision_candidates (game, target_issue, revision, slot, result_key);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_revision_forecasts (
  forecast_id text PRIMARY KEY,
  candidate_id text NOT NULL,
  revision_id text NOT NULL,
  game text NOT NULL,
  target_issue text NOT NULL,
  revision integer NOT NULL,
  slot text NOT NULL,
  result_key text NOT NULL,
  forecast_json text NOT NULL,
  frozen_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_forecast_slot_idx
  ON forward_learning_revision_forecasts (game, target_issue, revision, slot);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS forward_learning_revision_scores (
  score_id text PRIMARY KEY,
  forecast_id text,
  candidate_id text NOT NULL UNIQUE,
  revision_id text NOT NULL,
  game text NOT NULL,
  target_issue text NOT NULL,
  revision integer NOT NULL,
  slot text NOT NULL,
  result_key text NOT NULL,
  official integer NOT NULL,
  actual_matched integer NOT NULL,
  score_json text NOT NULL,
  scored_at text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_score_result_idx
  ON forward_learning_revision_scores (game, target_issue, revision, slot, result_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS forward_learning_revision_score_forecast_idx
  ON forward_learning_revision_scores (forecast_id) WHERE forecast_id IS NOT NULL;
