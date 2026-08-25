CREATE TABLE `rolling_pattern_review_snapshots` (
	`run_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`frozen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rolling_pattern_review_snapshot_issue_idx` ON `rolling_pattern_review_snapshots` (`game`,`target_issue`);
--> statement-breakpoint
CREATE TABLE `rolling_pattern_review_scores` (
	`run_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`actual_json` text NOT NULL,
	`score_json` text NOT NULL,
	`scored_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rolling_pattern_review_score_issue_idx` ON `rolling_pattern_review_scores` (`game`,`target_issue`);
