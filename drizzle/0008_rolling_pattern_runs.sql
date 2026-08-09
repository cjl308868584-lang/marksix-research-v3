CREATE TABLE `rolling_pattern_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`source_issue` text NOT NULL,
	`target_issue` text NOT NULL,
	`window_oldest_issue` text NOT NULL,
	`window_newest_issue` text NOT NULL,
	`window_data_hash` text NOT NULL,
	`engine_version` text NOT NULL,
	`status` text NOT NULL,
	`generated_at` text NOT NULL,
	`frozen_at` text NOT NULL,
	`run_json` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rolling_pattern_target_idx` ON `rolling_pattern_runs` (`game`,`target_issue`,`window_data_hash`,`engine_version`);--> statement-breakpoint
CREATE TABLE `rolling_pattern_scores` (
	`run_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`actual_matched` integer NOT NULL,
	`score_json` text NOT NULL,
	`scored_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rolling_pattern_score_identity_idx` ON `rolling_pattern_scores` (`run_id`,`rule_id`);--> statement-breakpoint
CREATE INDEX `rolling_pattern_score_issue_idx` ON `rolling_pattern_scores` (`game`,`target_issue`);--> statement-breakpoint
CREATE TABLE `rolling_pattern_signals` (
	`run_id` text NOT NULL,
	`rule_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`rule_family` text NOT NULL,
	`event_family` text NOT NULL,
	`event_value` text NOT NULL,
	`sample_label` text NOT NULL,
	`signal_json` text NOT NULL,
	`frozen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rolling_pattern_signal_identity_idx` ON `rolling_pattern_signals` (`run_id`,`rule_id`);--> statement-breakpoint
CREATE INDEX `rolling_pattern_signal_filter_idx` ON `rolling_pattern_signals` (`game`,`target_issue`,`event_family`);