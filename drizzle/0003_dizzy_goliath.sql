CREATE TABLE `dataset_versions` (
	`dataset_version` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`generated_at` text NOT NULL,
	`oldest_issue` text,
	`newest_issue` text,
	`draw_count` integer NOT NULL,
	`formal_draw_count` integer NOT NULL,
	`missing_issue_count` integer DEFAULT 0 NOT NULL,
	`conflict_count` integer DEFAULT 0 NOT NULL,
	`fingerprint` text NOT NULL,
	`summary_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dataset_versions_game_generated_idx` ON `dataset_versions` (`game`,`generated_at`);--> statement-breakpoint
CREATE TABLE `draw_source_snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`issue` text NOT NULL,
	`source` text NOT NULL,
	`source_grade` text NOT NULL,
	`fetched_at` text NOT NULL,
	`body_hash` text NOT NULL,
	`raw_json` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draw_source_snapshot_identity_idx` ON `draw_source_snapshots` (`game`,`issue`,`source`,`body_hash`);--> statement-breakpoint
CREATE INDEX `draw_source_snapshot_issue_idx` ON `draw_source_snapshots` (`game`,`issue`);--> statement-breakpoint
CREATE TABLE `lottery_draws` (
	`draw_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`issue` text NOT NULL,
	`draw_at` text NOT NULL,
	`main_1` integer NOT NULL,
	`main_2` integer NOT NULL,
	`main_3` integer NOT NULL,
	`main_4` integer NOT NULL,
	`main_5` integer NOT NULL,
	`main_6` integer NOT NULL,
	`special` integer NOT NULL,
	`source_grade` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`source_hash` text NOT NULL,
	`available_at` text NOT NULL,
	`ingested_at` text NOT NULL,
	`dataset_version` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lottery_draws_game_issue_idx` ON `lottery_draws` (`game`,`issue`);--> statement-breakpoint
CREATE INDEX `lottery_draws_game_draw_at_idx` ON `lottery_draws` (`game`,`draw_at`);--> statement-breakpoint
CREATE INDEX `lottery_draws_dataset_idx` ON `lottery_draws` (`dataset_version`);--> statement-breakpoint
CREATE TABLE `research_forecast_scores` (
	`score_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`target_id` text NOT NULL,
	`brier_score` real NOT NULL,
	`baseline_brier_score` real NOT NULL,
	`log_loss` real NOT NULL,
	`baseline_log_loss` real NOT NULL,
	`score_json` text NOT NULL,
	`scored_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_forecast_score_identity_idx` ON `research_forecast_scores` (`run_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `research_forecast_score_game_idx` ON `research_forecast_scores` (`game`,`target_issue`);--> statement-breakpoint
CREATE TABLE `research_forecasts` (
	`run_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`expected_draw_at` text NOT NULL,
	`generated_at` text NOT NULL,
	`dataset_version` text NOT NULL,
	`rule_engine_version` text NOT NULL,
	`model_version` text NOT NULL,
	`evidence_tier` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`frozen_at` text NOT NULL,
	`actual_json` text,
	`settled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_forecast_target_idx` ON `research_forecasts` (`game`,`target_issue`,`rule_engine_version`,`model_version`);--> statement-breakpoint
CREATE INDEX `research_forecast_unsettled_idx` ON `research_forecasts` (`game`,`settled_at`,`target_issue`);--> statement-breakpoint
CREATE TABLE `research_model_registry` (
	`model_version` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`kind` text NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`dataset_version` text NOT NULL,
	`code_version` text NOT NULL,
	`config_json` text NOT NULL,
	`metrics_json` text NOT NULL,
	`registered_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_model_game_status_idx` ON `research_model_registry` (`game`,`status`);--> statement-breakpoint
CREATE TABLE `research_rule_definitions` (
	`rule_id` text PRIMARY KEY NOT NULL,
	`rule_engine_version` text NOT NULL,
	`family` text NOT NULL,
	`target_id` text NOT NULL,
	`direction` text NOT NULL,
	`canonical_json` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_rule_canonical_idx` ON `research_rule_definitions` (`rule_engine_version`,`canonical_json`);--> statement-breakpoint
CREATE INDEX `research_rule_target_idx` ON `research_rule_definitions` (`target_id`,`family`);--> statement-breakpoint
CREATE TABLE `research_rule_evaluations` (
	`evaluation_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`game` text NOT NULL,
	`dataset_version` text NOT NULL,
	`tier` text NOT NULL,
	`direction` text NOT NULL,
	`support` integer NOT NULL,
	`hits` integer NOT NULL,
	`metrics_json` text NOT NULL,
	`resource_decision` text NOT NULL,
	`evaluated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_rule_evaluation_identity_idx` ON `research_rule_evaluations` (`run_id`,`rule_id`);--> statement-breakpoint
CREATE INDEX `research_rule_evaluation_rank_idx` ON `research_rule_evaluations` (`game`,`tier`,`evaluated_at`);