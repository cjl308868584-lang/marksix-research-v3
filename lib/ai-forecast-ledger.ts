import type { Draw, GameId } from "./lottery";

type LedgerState = "locked" | "existing" | "skipped" | "unavailable";

export type ForecastLedgerSummary = {
  totalForecasts: number;
  settledForecasts: number;
  trackedForecasts: number;
  observedForecasts: number;
  evaluatedObservedForecasts: number;
  totalMainOverlap: number;
  averageMainOverlap: number | null;
  specialExactHits: number;
};

export type ForecastLedgerStatus = {
  state: LedgerState;
  forecastId: string | null;
  immutable: boolean;
  lockedAt: string | null;
  settledAt: string | null;
  reason:
    | "pre_draw_lock"
    | "already_locked"
    | "after_cutoff"
    | "target_unconfirmed"
    | "database_unavailable";
  summary: ForecastLedgerSummary | null;
};

export type ForecastLedgerIdentity = {
  game: GameId;
  targetIssue: string;
  expectedDrawAt: string;
  analysisCutoffAt: string;
  windowSize: number;
  focus: string;
  depth: string;
  dataFingerprint: string;
  algorithmVersion: string;
  promptVersion: string;
  schemaVersion: string;
  model: string;
  reasoning: string;
};

type LedgerRow = {
  forecast_id: string;
  response_json: string;
  locked_at: string;
  settled_at: string | null;
};

type LedgerSummaryRow = {
  response_json: string;
  actual_json: string | null;
};

type LedgerCountRow = {
  total_forecasts: number;
  settled_forecasts: number;
};

const runtime = globalThis as typeof globalThis & {
  __marksixD1?: D1Database;
};

export async function lockForecastSnapshot<T>(
  identity: ForecastLedgerIdentity,
  snapshot: T,
): Promise<{ snapshot: T; ledger: ForecastLedgerStatus }> {
  const expectedAt = Date.parse(identity.expectedDrawAt);
  const cutoffAt = Date.parse(identity.analysisCutoffAt);
  if (
    !Number.isFinite(expectedAt) ||
    !Number.isFinite(cutoffAt) ||
    cutoffAt >= expectedAt
  ) {
    return {
      snapshot,
      ledger: status("skipped", null, null, null, "after_cutoff", false),
    };
  }

  const db = runtime.__marksixD1;
  if (!db) {
    return {
      snapshot,
      ledger: status(
        "unavailable",
        null,
        null,
        null,
        "database_unavailable",
        false,
      ),
    };
  }

  const forecastId = await buildForecastId(identity);
  const lockedAt = identity.analysisCutoffAt;
  try {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO ai_forecast_ledger (
         forecast_id, game, target_issue, expected_draw_at, analysis_cutoff_at,
         window_size, focus, depth, data_fingerprint, algorithm_version,
         prompt_version, schema_version, model, reasoning, response_json, locked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        forecastId,
        identity.game,
        identity.targetIssue,
        identity.expectedDrawAt,
        identity.analysisCutoffAt,
        identity.windowSize,
        identity.focus,
        identity.depth,
        identity.dataFingerprint,
        identity.algorithmVersion,
        identity.promptVersion,
        identity.schemaVersion,
        identity.model,
        identity.reasoning,
        JSON.stringify(snapshot),
        lockedAt,
      )
      .run();
    const row = await db.prepare(
      `SELECT forecast_id, response_json, locked_at, settled_at
       FROM ai_forecast_ledger
       WHERE forecast_id = ?
       LIMIT 1`,
    )
      .bind(forecastId)
      .first<LedgerRow>();
    if (!row) throw new Error("forecast ledger read failed");

    const stored = JSON.parse(row.response_json) as T;
    const created = Number(inserted.meta?.changes ?? 0) > 0;
    return {
      snapshot: stored,
      ledger: status(
        created ? "locked" : "existing",
        row.forecast_id,
        row.locked_at,
        row.settled_at,
        created ? "pre_draw_lock" : "already_locked",
        true,
      ),
    };
  } catch {
    return {
      snapshot,
      ledger: status(
        "unavailable",
        forecastId,
        null,
        null,
        "database_unavailable",
        false,
      ),
    };
  }
}

export async function settleForecastLedger(
  game: GameId,
  draws: Draw[],
  settledAt = new Date().toISOString(),
): Promise<void> {
  const db = runtime.__marksixD1;
  if (!db || draws.length === 0) return;

  try {
    const rows = await db.prepare(
      `SELECT DISTINCT target_issue
       FROM ai_forecast_ledger
       WHERE game = ? AND settled_at IS NULL`,
    )
      .bind(game)
      .all<{ target_issue: string }>();
    const drawByIssue = new Map(draws.map((draw) => [draw.issue, draw]));
    const updates = (rows.results ?? []).flatMap(
      (row: { target_issue: string }) => {
      const draw = drawByIssue.get(row.target_issue);
      if (!draw) return [];
      const actual = {
        issue: draw.issue,
        drawAt: draw.drawAt,
        numbers: draw.numbers,
        special: draw.special,
        source: draw.source,
        verified: draw.verified,
      };
      return [
        db.prepare(
          `UPDATE ai_forecast_ledger
           SET actual_json = ?, settled_at = ?
           WHERE game = ? AND target_issue = ? AND settled_at IS NULL`,
        ).bind(JSON.stringify(actual), settledAt, game, row.target_issue),
      ];
      },
    );
    if (updates.length > 0) await db.batch(updates);
  } catch {
    // Ledger settlement must never make the analysis endpoint unavailable.
  }
}

export function skippedForecastLedger(
  reason: "after_cutoff" | "target_unconfirmed",
): ForecastLedgerStatus {
  return status("skipped", null, null, null, reason, false);
}

export async function readForecastLedgerSummary(
  game: GameId,
): Promise<ForecastLedgerSummary | null> {
  const db = runtime.__marksixD1;
  if (!db) return null;
  try {
    const counts = await db.prepare(
      `SELECT
         COUNT(*) AS total_forecasts,
         SUM(CASE WHEN settled_at IS NOT NULL THEN 1 ELSE 0 END) AS settled_forecasts
       FROM ai_forecast_ledger
       WHERE game = ?`,
    )
      .bind(game)
      .first<LedgerCountRow>();
    const rows = await db.prepare(
      `SELECT response_json, actual_json
       FROM ai_forecast_ledger
       WHERE game = ?
       ORDER BY locked_at DESC
       LIMIT 500`,
    )
      .bind(game)
      .all<LedgerSummaryRow>();

    let observedForecasts = 0;
    let evaluatedObservedForecasts = 0;
    let totalMainOverlap = 0;
    let specialExactHits = 0;
    for (const row of rows.results ?? []) {
      const snapshot = parseJson(row.response_json) as {
        decision?: { kind?: unknown; scenarioId?: unknown };
        candidateSets?: Array<{
          id?: unknown;
          numbers?: unknown;
          special?: unknown;
        }>;
      } | null;
      if (
        snapshot?.decision?.kind !== "observe" ||
        typeof snapshot.decision.scenarioId !== "string"
      ) {
        continue;
      }
      observedForecasts += 1;
      if (!row.actual_json) continue;
      const actual = parseJson(row.actual_json) as {
        numbers?: unknown;
        special?: unknown;
      } | null;
      const candidate = snapshot.candidateSets?.find(
        (item) => item.id === snapshot.decision?.scenarioId,
      );
      if (
        !candidate ||
        !Array.isArray(candidate.numbers) ||
        !Array.isArray(actual?.numbers) ||
        typeof candidate.special !== "number" ||
        typeof actual.special !== "number"
      ) {
        continue;
      }
      const actualMain = new Set(
        actual.numbers.filter((number): number is number => typeof number === "number"),
      );
      totalMainOverlap += candidate.numbers.filter(
        (number): number is number =>
          typeof number === "number" && actualMain.has(number),
      ).length;
      if (candidate.special === actual.special) specialExactHits += 1;
      evaluatedObservedForecasts += 1;
    }

    return {
      totalForecasts: Number(counts?.total_forecasts ?? 0),
      settledForecasts: Number(counts?.settled_forecasts ?? 0),
      trackedForecasts: rows.results?.length ?? 0,
      observedForecasts,
      evaluatedObservedForecasts,
      totalMainOverlap,
      averageMainOverlap:
        evaluatedObservedForecasts > 0
          ? Math.round(
            (totalMainOverlap / evaluatedObservedForecasts) * 1_000,
          ) / 1_000
          : null,
      specialExactHits,
    };
  } catch {
    return null;
  }
}

async function buildForecastId(identity: ForecastLedgerIdentity) {
  const stableIdentity = [
    "forecast-ledger-v1",
    identity.game,
    identity.targetIssue,
    identity.windowSize,
    identity.focus,
    identity.depth,
    identity.algorithmVersion,
    identity.promptVersion,
    identity.schemaVersion,
    identity.model,
    identity.reasoning,
  ].join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableIdentity),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function status(
  state: LedgerState,
  forecastId: string | null,
  lockedAt: string | null,
  settledAt: string | null,
  reason: ForecastLedgerStatus["reason"],
  immutable: boolean,
): ForecastLedgerStatus {
  return {
    state,
    forecastId: forecastId ? forecastId.slice(0, 16) : null,
    immutable,
    lockedAt,
    settledAt,
    reason,
    summary: null,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
