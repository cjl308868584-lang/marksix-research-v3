const MINUTE_LIMIT = 5;
const DAILY_LIMIT = 30;
const GLOBAL_DAILY_LIMIT = 400;

type MemoryEntry = {
  count: number;
  expiresAt: number;
};

const runtime = globalThis as typeof globalThis & {
  __marksixAiFallbackRate?: Map<string, MemoryEntry>;
  __marksixD1?: D1Database;
};
const fallbackBuckets =
  runtime.__marksixAiFallbackRate ?? new Map<string, MemoryEntry>();
runtime.__marksixAiFallbackRate = fallbackBuckets;

export type AiRateResult = {
  allowed: boolean;
  retryAfter: number;
};

export async function consumeAiRateLimit(identifier: string): Promise<AiRateResult> {
  const now = Date.now();
  const minuteExpires = Math.floor(now / 60_000) * 60_000 + 60_000;
  const dayExpires = nextUtcDay(now);
  const minuteKey = `minute:${Math.floor(now / 60_000)}:${identifier}`;
  const dayKey = `day:${Math.floor(now / 86_400_000)}:${identifier}`;
  const globalKey = `global:${Math.floor(now / 86_400_000)}`;
  const db = runtime.__marksixD1;

  if (!db) {
    return consumeFallback([
      [minuteKey, MINUTE_LIMIT, minuteExpires],
      [dayKey, DAILY_LIMIT, dayExpires],
      [globalKey, GLOBAL_DAILY_LIMIT, dayExpires],
    ], now);
  }

  try {
    if (await limitReached(db, globalKey, GLOBAL_DAILY_LIMIT)) {
      return denied(dayExpires, now);
    }
    const minuteCount = await incrementD1(
      db,
      minuteKey,
      minuteExpires,
      MINUTE_LIMIT,
    );
    if (minuteCount === null) return denied(minuteExpires, now);

    const dailyCount = await incrementD1(db, dayKey, dayExpires, DAILY_LIMIT);
    if (dailyCount === null) return denied(dayExpires, now);

    const globalCount = await incrementD1(
      db,
      globalKey,
      dayExpires,
      GLOBAL_DAILY_LIMIT,
    );
    if (globalCount === null) return denied(dayExpires, now);
  } catch {
    return denied(now + 60_000, now);
  }

  if (Math.random() < 0.02) {
    await db.prepare("DELETE FROM ai_rate_limits WHERE expires_at < ?")
      .bind(now)
      .run()
      .catch(() => undefined);
  }
  return { allowed: true, retryAfter: 0 };
}

async function incrementD1(
  db: D1Database,
  key: string,
  expiresAt: number,
  limit: number,
): Promise<number | null> {
  const row = await db.prepare(
    `INSERT INTO ai_rate_limits (bucket_key, count, expires_at)
     VALUES (?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET
       count = ai_rate_limits.count + 1,
       expires_at = excluded.expires_at
     WHERE ai_rate_limits.count < ?
     RETURNING count`,
  )
    .bind(key, expiresAt, limit)
    .first<{ count: number }>();
  if (!row) return null;
  if (typeof row.count !== "number") throw new Error("D1 rate update failed");
  return row.count;
}

async function limitReached(
  db: D1Database,
  key: string,
  limit: number,
): Promise<boolean> {
  const row = await db.prepare(
    "SELECT count FROM ai_rate_limits WHERE bucket_key = ? LIMIT 1",
  )
    .bind(key)
    .first<{ count: number }>();
  return Boolean(row && row.count >= limit);
}

function consumeFallback(
  limits: Array<[string, number, number]>,
  now: number,
): AiRateResult {
  for (const [key, limit, expiresAt] of limits) {
    const current = fallbackBuckets.get(key);
    const next =
      !current || current.expiresAt <= now
        ? { count: 1, expiresAt }
        : { ...current, count: current.count + 1 };
    fallbackBuckets.set(key, next);
    if (next.count > limit) return denied(expiresAt, now);
  }
  if (fallbackBuckets.size > 1_000) {
    fallbackBuckets.forEach((entry, key) => {
      if (entry.expiresAt <= now) fallbackBuckets.delete(key);
    });
  }
  return { allowed: true, retryAfter: 0 };
}

function denied(expiresAt: number, now: number): AiRateResult {
  return {
    allowed: false,
    retryAfter: Math.max(Math.ceil((expiresAt - now) / 1_000), 1),
  };
}

function nextUtcDay(now: number) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
