import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const aiRateLimits = sqliteTable(
  "ai_rate_limits",
  {
    bucketKey: text("bucket_key").primaryKey(),
    count: integer("count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("ai_rate_limits_expires_idx").on(table.expiresAt)],
);
