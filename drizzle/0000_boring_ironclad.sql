CREATE TABLE `ai_rate_limits` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_rate_limits_expires_idx` ON `ai_rate_limits` (`expires_at`);