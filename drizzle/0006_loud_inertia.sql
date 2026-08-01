CREATE TABLE `research_settlement_claims` (
	`run_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`status` text NOT NULL,
	`claimed_at` text NOT NULL,
	`completed_at` text,
	`error_message` text
);
--> statement-breakpoint
CREATE INDEX `research_settlement_claim_game_idx` ON `research_settlement_claims` (`game`,`status`,`claimed_at`);--> statement-breakpoint
CREATE TABLE `research_task_runs` (
	`task_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`response_json` text,
	`error_message` text,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `research_task_status_idx` ON `research_task_runs` (`game`,`status`,`started_at`);