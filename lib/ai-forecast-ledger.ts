import type { ForecastPack } from "./ai-engine";
import type {
  AiPrimaryZodiacObservation,
  AiScenarioObservation,
} from "./ai-types";
import type { Draw, GameId } from "./lottery";
import { getZodiac, ZODIAC_NAMES } from "./zodiac.ts";

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
  zodiacObservedForecasts: number;
  zodiacEvaluatedForecasts: number;
  zodiacCoverageHits: number;
  /** Percentage on a 0–100 scale. */
  zodiacCoverageRate: number | null;
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

export type CanonicalZodiacLockIdentity = {
  game: GameId;
  targetIssue: string;
  expectedDrawAt: string;
  analysisCutoffAt: string;
  algorithmVersion: string;
  schemaVersion: string;
};

export type CanonicalZodiacLockPayload = {
  primary: AiPrimaryZodiacObservation;
  scenarioObservation: AiScenarioObservation;
};

export type CanonicalZodiacLockResult = {
  payload: CanonicalZodiacLockPayload;
  state: "locked" | "existing" | "skipped" | "unavailable";
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

type CanonicalZodiacRow = {
  payload_json: string;
};

type CanonicalZodiacSummaryRow = {
  target_issue: string;
  expected_draw_at: string;
  payload_json: string;
  actual_json: string | null;
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

export function canonicalZodiacPayloadFromPack(
  pack: ForecastPack,
): CanonicalZodiacLockPayload | null {
  const scenario = pack.candidateSets.find(
    (candidate) => candidate.id === pack.zodiacObservation.scenarioId,
  );
  const scenarioObservation = scenario?.observations.find(
    (observation) => observation.id === "zodiac_coverage",
  );
  if (
    !scenarioObservation ||
    scenarioObservation.pick !== pack.zodiacObservation.zodiac
  ) {
    return null;
  }
  return {
    primary: pack.zodiacObservation,
    scenarioObservation,
  };
}

export async function lockCanonicalZodiacObservation(
  identity: CanonicalZodiacLockIdentity,
  payload: CanonicalZodiacLockPayload,
  policy: { persistenceEligible: boolean },
): Promise<CanonicalZodiacLockResult> {
  const expectedAt = Date.parse(identity.expectedDrawAt);
  const cutoffAt = Date.parse(identity.analysisCutoffAt);
  if (
    !policy.persistenceEligible ||
    !/^\d+$/.test(identity.targetIssue) ||
    !Number.isFinite(expectedAt) ||
    !Number.isFinite(cutoffAt) ||
    cutoffAt >= expectedAt ||
    !isCanonicalZodiacPayload(payload)
  ) {
    return { payload, state: "skipped" };
  }

  const db = runtime.__marksixD1;
  if (!db) return { payload, state: "unavailable" };
  const lockId = await buildCanonicalZodiacLockId(identity);
  try {
    const inserted = await db.prepare(
      `INSERT OR IGNORE INTO ai_primary_observation_locks (
         lock_id, game, target_issue, expected_draw_at, algorithm_version,
         schema_version, payload_json, locked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        lockId,
        identity.game,
        identity.targetIssue,
        identity.expectedDrawAt,
        identity.algorithmVersion,
        identity.schemaVersion,
        JSON.stringify(payload),
        identity.analysisCutoffAt,
      )
      .run();
    const row = await db.prepare(
      `SELECT payload_json
       FROM ai_primary_observation_locks
       WHERE lock_id = ?
       LIMIT 1`,
    )
      .bind(lockId)
      .first<CanonicalZodiacRow>();
    const stored = row
      ? parseJson(row.payload_json)
      : null;
    if (!isCanonicalZodiacPayload(stored)) {
      throw new Error("canonical zodiac lock read failed");
    }
    return {
      payload: stored,
      state:
        Number(inserted.meta?.changes ?? 0) > 0
          ? "locked"
          : "existing",
    };
  } catch {
    return { payload, state: "unavailable" };
  }
}

export function applyCanonicalZodiacObservation(
  pack: ForecastPack,
  payload: CanonicalZodiacLockPayload,
): ForecastPack {
  const candidateSets = pack.candidateSets.map((candidate) =>
    candidate.id !== payload.primary.scenarioId
      ? candidate
      : {
        ...candidate,
        observations: candidate.observations.map((observation) =>
          observation.id === "zodiac_coverage"
            ? payload.scenarioObservation
            : observation,
        ),
      },
  );
  return {
    ...pack,
    candidateSets,
    zodiacObservation: payload.primary,
    localSynthesis: {
      ...pack.localSynthesis,
      executiveSummary: payload.primary.conclusion,
      recommendedScenarioId:
        payload.primary.validation === "observed_advantage"
          ? payload.primary.scenarioId
          : null,
      recommendationReason: payload.primary.conclusion,
    },
  };
}

export async function settleForecastLedger(
  game: GameId,
  draws: Draw[],
  settledAt = new Date().toISOString(),
): Promise<void> {
  const db = runtime.__marksixD1;
  if (!db || draws.length === 0) return;

  try {
    const [forecastRows, canonicalRows] = await Promise.all([
      db.prepare(
        `SELECT DISTINCT target_issue
         FROM ai_forecast_ledger
         WHERE game = ? AND settled_at IS NULL`,
      )
        .bind(game)
        .all<{ target_issue: string }>(),
      db.prepare(
        `SELECT DISTINCT target_issue
         FROM ai_primary_observation_locks
         WHERE game = ? AND settled_at IS NULL`,
      )
        .bind(game)
        .all<{ target_issue: string }>(),
    ]);
    // A single-source result can still be corrected. Only cross-source verified
    // draws may permanently settle an immutable pre-draw snapshot.
    const drawByIssue = new Map(
      draws
        .filter((draw) => draw.verified)
        .map((draw) => [draw.issue, draw]),
    );
    const unsettledIssues = new Set(
      [...(forecastRows.results ?? []), ...(canonicalRows.results ?? [])]
        .map((row) => row.target_issue),
    );
    const updates = [...unsettledIssues].flatMap((targetIssue) => {
      const draw = drawByIssue.get(targetIssue);
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
        ).bind(JSON.stringify(actual), settledAt, game, targetIssue),
        db.prepare(
          `UPDATE ai_primary_observation_locks
           SET actual_json = ?, settled_at = ?
           WHERE game = ? AND target_issue = ? AND settled_at IS NULL`,
        ).bind(JSON.stringify(actual), settledAt, game, targetIssue),
      ];
    });
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
       ORDER BY locked_at DESC, forecast_id DESC
       LIMIT 500`,
    )
      .bind(game)
      .all<LedgerSummaryRow>();
    const canonicalRows = await db.prepare(
      `SELECT target_issue, expected_draw_at, payload_json, actual_json
       FROM ai_primary_observation_locks
       WHERE game = ?
       ORDER BY locked_at DESC, lock_id DESC`,
    )
      .bind(game)
      .all<CanonicalZodiacSummaryRow>();

    let observedForecasts = 0;
    let evaluatedObservedForecasts = 0;
    let totalMainOverlap = 0;
    let specialExactHits = 0;
    let zodiacObservedForecasts = 0;
    let zodiacEvaluatedForecasts = 0;
    let zodiacCoverageHits = 0;
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

    const trackedZodiacIssues = new Set<string>();
    for (const row of canonicalRows.results ?? []) {
      if (trackedZodiacIssues.has(row.target_issue)) continue;
      const payload = parseJson(row.payload_json);
      if (!isCanonicalZodiacPayload(payload)) continue;
      trackedZodiacIssues.add(row.target_issue);
      zodiacObservedForecasts += 1;
      if (!row.actual_json) continue;
      const actual = parseJson(row.actual_json) as {
        drawAt?: unknown;
        numbers?: unknown;
        special?: unknown;
      } | null;
      const drawAt =
        typeof actual?.drawAt === "string"
          ? actual.drawAt
          : row.expected_draw_at;
      const actualNumbers = Array.isArray(actual?.numbers)
        ? actual.numbers.filter(
          (number): number is number =>
            typeof number === "number" &&
            Number.isInteger(number) &&
            number >= 1 &&
            number <= 49,
        )
        : [];
      if (
        actualNumbers.length !== 6 ||
        typeof actual?.special !== "number" ||
        !Number.isInteger(actual.special) ||
        actual.special < 1 ||
        actual.special > 49
      ) {
        continue;
      }
      zodiacEvaluatedForecasts += 1;
      if (
        [...actualNumbers, actual.special].some(
          (number) =>
            getZodiac(number, drawAt) === payload.primary.zodiac,
        )
      ) {
        zodiacCoverageHits += 1;
      }
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
      zodiacObservedForecasts,
      zodiacEvaluatedForecasts,
      zodiacCoverageHits,
      zodiacCoverageRate:
        zodiacEvaluatedForecasts > 0
          ? Math.round(
            (zodiacCoverageHits / zodiacEvaluatedForecasts) * 100_000,
          ) / 1_000
          : null,
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

async function buildCanonicalZodiacLockId(
  identity: CanonicalZodiacLockIdentity,
) {
  const stableIdentity = [
    "canonical-zodiac-lock-v1",
    identity.game,
    identity.targetIssue,
    identity.algorithmVersion,
    identity.schemaVersion,
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

const ZODIACS = new Set<string>(ZODIAC_NAMES);

function isCanonicalZodiacPayload(
  value: unknown,
): value is CanonicalZodiacLockPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as {
    primary?: {
      kind?: unknown;
      scenarioId?: unknown;
      zodiac?: unknown;
      target?: unknown;
      validation?: unknown;
      baselineRate?: unknown;
      backtest?: unknown;
      conclusion?: unknown;
    };
    scenarioObservation?: {
      id?: unknown;
      pick?: unknown;
      baselineRate?: unknown;
      backtest?: unknown;
    };
  };
  return (
    payload.primary?.kind === "zodiac_coverage_6_plus_1" &&
    ["balanced", "momentum", "contrarian"].includes(
      String(payload.primary.scenarioId),
    ) &&
    typeof payload.primary.zodiac === "string" &&
    ZODIACS.has(payload.primary.zodiac) &&
    typeof payload.primary.target === "string" &&
    ["insufficient", "no_advantage", "observed_advantage"].includes(
      String(payload.primary.validation),
    ) &&
    typeof payload.primary.baselineRate === "number" &&
    Boolean(payload.primary.backtest) &&
    typeof payload.primary.conclusion === "string" &&
    payload.scenarioObservation?.id === "zodiac_coverage" &&
    payload.scenarioObservation.pick === payload.primary.zodiac &&
    typeof payload.scenarioObservation.baselineRate === "number" &&
    Boolean(payload.scenarioObservation.backtest)
  );
}
