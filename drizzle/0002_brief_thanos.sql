CREATE TABLE `ai_primary_observation_locks` (
	`lock_id` text PRIMARY KEY NOT NULL,
	`game` text NOT NULL,
	`target_issue` text NOT NULL,
	`expected_draw_at` text NOT NULL,
	`algorithm_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`payload_json` text NOT NULL,
	`locked_at` text NOT NULL,
	`actual_json` text,
	`settled_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_primary_observation_identity_idx` ON `ai_primary_observation_locks` (`game`,`target_issue`,`algorithm_version`,`schema_version`);