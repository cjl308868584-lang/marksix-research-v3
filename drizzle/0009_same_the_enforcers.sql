CREATE TABLE `rolling_pattern_consensus_ledger` (
	`run_id` text NOT NULL,
	`product_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`scope` text NOT NULL,
	`product_kind` text NOT NULL,
	`result_key` text NOT NULL,
	`rank` integer NOT NULL,
	`product_json` text NOT NULL,
	`frozen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rolling_pattern_consensus_identity_idx` ON `rolling_pattern_consensus_ledger` (`run_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `rolling_pattern_consensus_issue_idx` ON `rolling_pattern_consensus_ledger` (`game`,`target_issue`,`scope`);--> statement-breakpoint
CREATE TABLE `rolling_pattern_consensus_scores` (
	`run_id` text NOT NULL,
	`product_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`scope` text NOT NULL,
	`product_kind` text NOT NULL,
	`actual_matched` integer NOT NULL,
	`unit_profit` real NOT NULL,
	`actual_json` text NOT NULL,
	`score_json` text NOT NULL,
	`scored_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rolling_pattern_consensus_score_identity_idx` ON `rolling_pattern_consensus_scores` (`run_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `rolling_pattern_consensus_score_issue_idx` ON `rolling_pattern_consensus_scores` (`game`,`target_issue`,`scope`);