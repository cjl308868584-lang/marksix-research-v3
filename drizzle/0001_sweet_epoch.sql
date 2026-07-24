CREATE TABLE `ai_forecast_ledger` (
	`forecast_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`expected_draw_at` text NOT NULL,
	`analysis_cutoff_at` text NOT NULL,
	`window_size` integer NOT NULL,
	`focus` text NOT NULL,
	`depth` text NOT NULL,
	`data_fingerprint` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`model` text NOT NULL,
	`reasoning` text NOT NULL,
	`response_json` text NOT NULL,
	`locked_at` text NOT NULL,
	`actual_json` text,
	`settled_at` text
);
--> statement-breakpoint
CREATE INDEX `ai_forecast_ledger_game_target_idx` ON `ai_forecast_ledger` (`game`,`target_issue`);--> statement-breakpoint
CREATE INDEX `ai_forecast_ledger_unsettled_idx` ON `ai_forecast_ledger` (`game`,`settled_at`,`target_issue`);