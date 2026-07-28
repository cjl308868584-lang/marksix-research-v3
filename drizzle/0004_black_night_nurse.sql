CREATE TABLE `research_rule_ledger` (
	`ledger_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`rule_id` text NOT NULL,
	`target_id` text NOT NULL,
	`direction` text NOT NULL,
	`predicted_value` text NOT NULL,
	`frozen_rule_json` text NOT NULL,
	`frozen_at` text NOT NULL,
	`actual_value` text,
	`actual_number` integer,
	`outcome` text,
	`direction_correct` integer,
	`scored_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `research_rule_ledger_identity_idx` ON `research_rule_ledger` (`run_id`,`rule_id`);--> statement-breakpoint
CREATE INDEX `research_rule_ledger_issue_idx` ON `research_rule_ledger` (`game`,`target_issue`,`scored_at`);--> statement-breakpoint
ALTER TABLE `research_forecasts` ADD `review_version` text;--> statement-breakpoint
ALTER TABLE `research_forecasts` ADD `review_json` text;