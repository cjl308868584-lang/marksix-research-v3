CREATE TABLE `research_event_ledger` (
	`event_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`slot` text NOT NULL,
	`scope` text NOT NULL,
	`family` text NOT NULL,
	`predicted_value` text NOT NULL,
	`probability` real NOT NULL,
	`baseline_probability` real NOT NULL,
	`evidence_tier` text NOT NULL,
	`frozen_event_json` text NOT NULL,
	`frozen_at` text NOT NULL,
	`actual_matched` integer,
	`actual_label` text,
	`scored_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_event_slot_identity_idx` ON `research_event_ledger` (`run_id`,`slot`);--> statement-breakpoint
CREATE INDEX `research_event_issue_idx` ON `research_event_ledger` (`game`,`target_issue`,`scored_at`);--> statement-breakpoint
CREATE TABLE `research_event_scores` (
	`score_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`event_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`slot` text NOT NULL,
	`probability` real NOT NULL,
	`baseline_probability` real NOT NULL,
	`actual_matched` integer NOT NULL,
	`brier_score` real NOT NULL,
	`baseline_brier_score` real NOT NULL,
	`log_loss` real NOT NULL,
	`baseline_log_loss` real NOT NULL,
	`score_json` text NOT NULL,
	`scored_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_event_score_identity_idx` ON `research_event_scores` (`run_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `research_event_score_game_idx` ON `research_event_scores` (`game`,`target_issue`,`slot`);--> statement-breakpoint
CREATE TABLE `research_learning_runs` (
	`learning_run_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`game` text NOT NULL,
	`settled_issue` text NOT NULL,
	`status` text NOT NULL,
	`champion_before` text NOT NULL,
	`champion_after` text NOT NULL,
	`challenger_promoted` integer NOT NULL,
	`drift_detected` integer NOT NULL,
	`summary_json` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_learning_run_identity_idx` ON `research_learning_runs` (`run_id`,`settled_issue`);--> statement-breakpoint
CREATE INDEX `research_learning_game_idx` ON `research_learning_runs` (`game`,`completed_at`);--> statement-breakpoint
CREATE TABLE `research_model_artifacts` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`model_version` text NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`dataset_version` text NOT NULL,
	`parent_artifact_id` text,
	`config_json` text NOT NULL,
	`metrics_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_model_artifact_identity_idx` ON `research_model_artifacts` (`game`,`model_version`,`kind`);--> statement-breakpoint
CREATE INDEX `research_model_artifact_status_idx` ON `research_model_artifacts` (`game`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `research_model_weights` (
	`weight_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`slot` text NOT NULL,
	`model_id` text NOT NULL,
	`weight_before` real NOT NULL,
	`weight_after` real NOT NULL,
	`probability` real NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_model_weight_identity_idx` ON `research_model_weights` (`run_id`,`slot`,`model_id`);--> statement-breakpoint
CREATE INDEX `research_model_weight_latest_idx` ON `research_model_weights` (`game`,`slot`,`updated_at`);--> statement-breakpoint
CREATE TABLE `research_rule_states` (
	`state_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`slot` text NOT NULL,
	`rule_id` text NOT NULL,
	`posterior_alpha` real NOT NULL,
	`posterior_beta` real NOT NULL,
	`triggers` integer NOT NULL,
	`hits` integer NOT NULL,
	`consecutive_hits` integer NOT NULL,
	`consecutive_misses` integer NOT NULL,
	`recent_20_json` text NOT NULL,
	`recent_50_json` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_rule_state_identity_idx` ON `research_rule_states` (`game`,`slot`,`rule_id`);--> statement-breakpoint
CREATE INDEX `research_rule_state_status_idx` ON `research_rule_states` (`game`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `research_v3_forecasts` (
	`run_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`expected_draw_at` text NOT NULL,
	`generated_at` text NOT NULL,
	`dataset_version` text NOT NULL,
	`engine_version` text NOT NULL,
	`model_version` text NOT NULL,
	`mode` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`frozen_at` text NOT NULL,
	`actual_json` text,
	`review_version` text,
	`review_json` text,
	`settled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_v3_forecast_identity_idx` ON `research_v3_forecasts` (`game`,`target_issue`);--> statement-breakpoint
CREATE INDEX `research_v3_forecast_unsettled_idx` ON `research_v3_forecasts` (`game`,`settled_at`,`target_issue`);
