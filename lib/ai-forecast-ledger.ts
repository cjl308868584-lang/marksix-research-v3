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
    | "quality_gate_failed"
    | "generation_degraded"
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

type ReadableLedgerRow = LedgerRow & {
  expected_draw_at: string;
  analysis_cutoff_at: string;
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
  lock_id?: string;
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

export async function readForecastSnapshot<T>(
  identity: ForecastLedgerIdentity,
  asOfAt = new Date().toISOString(),
): Promise<{ snapshot: T; ledger: ForecastLedgerStatus } | null> {
  const db = runtime.__marksixD1;
  const expectedAt = Date.parse(identity.expectedDrawAt);
  const asOf = Date.parse(asOfAt);
  if (
    !db ||
    !/^\d+$/.test(identity.targetIssue) ||
    !Number.isFinite(expectedAt) ||
    !Number.isFinite(asOf) ||
    asOf >= expectedAt
  ) {
    return null;
  }
  const [primaryLineage, legacyLineage] = compatibleForecastLineages(
    identity.algorithmVersion,
    identity.promptVersion,
  );
  try {
    const row = await db.prepare(
      `SELECT forecast_id, response_json, locked_at, settled_at,
              expected_draw_at, analysis_cutoff_at
       FROM ai_forecast_ledger
       WHERE game = ?
         AND target_issue = ?
         AND expected_draw_at = ?
         AND window_size = ?
         AND focus = ?
         AND depth = ?
         AND (
           (algorithm_version = ? AND prompt_version = ?)
           OR (algorithm_version = ? AND prompt_version = ?)
         )
         AND schema_version = ?
         AND model = ?
         AND reasoning = ?
         AND settled_at IS NULL
         AND analysis_cutoff_at <= ?
         AND locked_at <= ?
         AND json_valid(response_json) = 1
         AND json_extract(response_json, '$.mode') = 'ai'
         AND json_extract(response_json, '$.status') = 'ok'
         AND json_extract(response_json, '$.fallbackReason') IS NULL
       ORDER BY locked_at ASC, forecast_id ASC
       LIMIT 1`,
    )
      .bind(
        identity.game,
        identity.targetIssue,
        identity.expectedDrawAt,
        identity.windowSize,
        identity.focus,
        identity.depth,
        primaryLineage.algorithmVersion,
        primaryLineage.promptVersion,
        legacyLineage.algorithmVersion,
        legacyLineage.promptVersion,
        identity.schemaVersion,
        identity.model,
        identity.reasoning,
        asOfAt,
        asOfAt,
      )
      .first<ReadableLedgerRow>();
    if (!row || Date.parse(row.expected_draw_at) <= asOf) return null;
    const snapshot = parseJson(row.response_json) as T | null;
    if (!snapshot) return null;
    return {
      snapshot,
      ledger: status(
        "existing",
        row.forecast_id,
        row.locked_at,
        row.settled_at,
        "already_locked",
        true,
      ),
    };
  } catch {
    return null;
  }
}

export async function readLatestRestorableForecast<T>({
  state,
  game,
  targetIssue,
  expectedDrawAt,
  asOfAt,
  algorithmVersion,
  promptVersion,
  schemaVersion,
  model,
  reasoning,
  windowSize = null,
  focus = null,
  depth,
}: {
  state: "pending" | "settled";
  game: GameId;
  targetIssue: string;
  expectedDrawAt?: string;
  asOfAt: string;
  algorithmVersion: string;
  promptVersion: string;
  schemaVersion: string;
  model: string;
  reasoning: string;
  windowSize?: number | null;
  focus?: string | null;
  depth: string;
}): Promise<{
  snapshot: T;
  ledger: ForecastLedgerStatus;
  expectedDrawAt: string;
} | null> {
  const db = runtime.__marksixD1;
  const asOf = Date.parse(asOfAt);
  if (
    !db ||
    !/^\d+$/.test(targetIssue) ||
    !Number.isFinite(asOf) ||
    (state === "pending" &&
      (
        !expectedDrawAt ||
        !Number.isFinite(Date.parse(expectedDrawAt)) ||
        asOf >= Date.parse(expectedDrawAt)
      ))
  ) {
    return null;
  }
  const [primaryLineage, legacyLineage] = compatibleForecastLineages(
    algorithmVersion,
    promptVersion,
  );
  try {
    const row = state === "pending"
      ? await db.prepare(
        `SELECT forecast_id, response_json, locked_at, settled_at,
                expected_draw_at, analysis_cutoff_at
         FROM ai_forecast_ledger
         WHERE game = ?
           AND target_issue = ?
           AND expected_draw_at = ?
           AND settled_at IS NULL
           AND analysis_cutoff_at <= ?
           AND locked_at <= ?
           AND (
             (algorithm_version = ? AND prompt_version = ?)
             OR (algorithm_version = ? AND prompt_version = ?)
           )
           AND schema_version = ?
           AND model = ?
           AND reasoning = ?
           AND depth = ?
           AND (? IS NULL OR window_size = ?)
           AND (? IS NULL OR focus = ?)
           AND json_valid(response_json) = 1
           AND json_extract(response_json, '$.mode') = 'ai'
           AND json_extract(response_json, '$.status') = 'ok'
           AND json_extract(response_json, '$.fallbackReason') IS NULL
         ORDER BY locked_at ASC, forecast_id ASC
         LIMIT 1`,
      )
        .bind(
          game,
          targetIssue,
          expectedDrawAt,
          asOfAt,
          asOfAt,
          primaryLineage.algorithmVersion,
          primaryLineage.promptVersion,
          legacyLineage.algorithmVersion,
          legacyLineage.promptVersion,
          schemaVersion,
          model,
          reasoning,
          depth,
          windowSize,
          windowSize,
          focus,
          focus,
        )
        .first<ReadableLedgerRow>()
      : await db.prepare(
        `SELECT forecast_id, response_json, locked_at, settled_at,
                expected_draw_at, analysis_cutoff_at
         FROM ai_forecast_ledger
         WHERE game = ?
           AND target_issue = ?
           AND settled_at IS NOT NULL
           AND settled_at <= ?
           AND expected_draw_at <= ?
           AND analysis_cutoff_at < expected_draw_at
           AND locked_at < expected_draw_at
           AND analysis_cutoff_at <= ?
           AND locked_at <= ?
           AND actual_json IS NOT NULL
           AND json_valid(actual_json) = 1
           AND json_extract(actual_json, '$.issue') = ?
           AND json_extract(actual_json, '$.verified') = 1
           AND (
             (algorithm_version = ? AND prompt_version = ?)
             OR (algorithm_version = ? AND prompt_version = ?)
           )
           AND schema_version = ?
           AND model = ?
           AND reasoning = ?
           AND depth = ?
           AND (? IS NULL OR window_size = ?)
           AND (? IS NULL OR focus = ?)
           AND json_valid(response_json) = 1
           AND json_extract(response_json, '$.mode') = 'ai'
           AND json_extract(response_json, '$.status') = 'ok'
           AND json_extract(response_json, '$.fallbackReason') IS NULL
         ORDER BY locked_at ASC, forecast_id ASC
         LIMIT 1`,
      )
        .bind(
          game,
          targetIssue,
          asOfAt,
          asOfAt,
          asOfAt,
          asOfAt,
          targetIssue,
          primaryLineage.algorithmVersion,
          primaryLineage.promptVersion,
          legacyLineage.algorithmVersion,
          legacyLineage.promptVersion,
          schemaVersion,
          model,
          reasoning,
          depth,
          windowSize,
          windowSize,
          focus,
          focus,
        )
        .first<ReadableLedgerRow>();
    if (!row) return null;
    const rowExpectedAt = Date.parse(row.expected_draw_at);
    const rowSettledAt = row.settled_at
      ? Date.parse(row.settled_at)
      : Number.NaN;
    if (
      !Number.isFinite(rowExpectedAt) ||
      (state === "pending"
        ? rowExpectedAt <= asOf || row.settled_at !== null
        : (
          !Number.isFinite(rowSettledAt) ||
          rowExpectedAt > asOf ||
          rowSettledAt > asOf
        ))
    ) {
      return null;
    }
    const snapshot = parseJson(row.response_json) as T | null;
    if (!snapshot) return null;
    return {
      snapshot,
      expectedDrawAt: row.expected_draw_at,
      ledger: status(
        "existing",
        row.forecast_id,
        row.locked_at,
        row.settled_at,
        "already_locked",
        true,
      ),
    };
  } catch {
    return null;
  }
}

export async function lockForecastSnapshot<T>(
  identity: ForecastLedgerIdentity,
  snapshot: T,
  policy: {
    persistenceEligible: boolean;
    generationSuccessful: boolean;
  },
): Promise<{ snapshot: T; ledger: ForecastLedgerStatus }> {
  const expectedAt = Date.parse(identity.expectedDrawAt);
  const cutoffAt = Date.parse(identity.analysisCutoffAt);
  if (
    !policy.persistenceEligible ||
    !policy.generationSuccessful ||
    !Number.isFinite(expectedAt) ||
    !Number.isFinite(cutoffAt) ||
    cutoffAt >= expectedAt
  ) {
    return {
      snapshot,
      ledger: status(
        "skipped",
        null,
        null,
        null,
        !policy.persistenceEligible
          ? "quality_gate_failed"
          : !policy.generationSuccessful
            ? "generation_degraded"
            : "after_cutoff",
        false,
      ),
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

  const established = await readForecastSnapshot<T>(
    identity,
    identity.analysisCutoffAt,
  );
  if (established) return established;

  const forecastId = await buildForecastId(identity);
  const lockedAt = identity.analysisCutoffAt;
  try {
    // The deployed primary key is lineage-specific. Re-reading the earliest
    // compatible row after INSERT makes concurrent v4/v5 callers converge on
    // one immutable response without a destructive schema rewrite.
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
    const earliest = await readForecastSnapshot<T>(
      identity,
      identity.analysisCutoffAt,
    );
    if (earliest) {
      const created =
        Number(inserted.meta?.changes ?? 0) > 0 &&
        earliest.ledger.forecastId === forecastId.slice(0, 16);
      return {
        snapshot: earliest.snapshot,
        ledger: created
          ? status(
            "locked",
            forecastId,
            lockedAt,
            null,
            "pre_draw_lock",
            true,
          )
          : earliest.ledger,
      };
    }
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
    !/^\d+$/.test(identity.targetIssue) ||
    !Number.isFinite(expectedAt) ||
    !Number.isFinite(cutoffAt) ||
    cutoffAt >= expectedAt ||
    !isCanonicalZodiacPayload(payload)
  ) {
    return { payload, state: "skipped" };
  }

  const db = runtime.__marksixD1;
  if (!db) {
    return {
      payload,
      state: policy.persistenceEligible ? "unavailable" : "skipped",
    };
  }
  const lockId = await buildCanonicalZodiacLockId(identity);
  try {
    const established = await readEarliestCanonicalZodiacLock(
      db,
      identity,
    );
    if (established) {
      return { payload: established.payload, state: "existing" };
    }
    if (!policy.persistenceEligible) {
      return { payload, state: "skipped" };
    }
    // The legacy unique index includes algorithm_version. The pre/post reads
    // keep rolling v4/v5 deployments converged on the earliest target lock;
    // a future cleanup migration can tighten the index after duplicate audit.
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
    const earliest = await readEarliestCanonicalZodiacLock(
      db,
      identity,
    );
    if (!earliest) {
      throw new Error("canonical zodiac lock read failed");
    }
    return {
      payload: earliest.payload,
      state:
        Number(inserted.meta?.changes ?? 0) > 0 &&
          earliest.lockId === lockId
          ? "locked"
          : "existing",
    };
  } catch {
    return { payload, state: "unavailable" };
  }
}

async function readEarliestCanonicalZodiacLock(
  db: D1Database,
  identity: CanonicalZodiacLockIdentity,
): Promise<{
  lockId: string;
  payload: CanonicalZodiacLockPayload;
} | null> {
  const row = await db.prepare(
    `SELECT lock_id, payload_json
     FROM ai_primary_observation_locks
     WHERE game = ?
       AND target_issue = ?
       AND locked_at <= ?
     ORDER BY locked_at ASC, lock_id ASC
     LIMIT 1`,
  )
    .bind(
      identity.game,
      identity.targetIssue,
      identity.analysisCutoffAt,
    )
    .first<CanonicalZodiacRow>();
  const stored = row ? parseJson(row.payload_json) : null;
  return row?.lock_id && isCanonicalZodiacPayload(stored)
    ? { lockId: row.lock_id, payload: stored }
    : null;
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
): Promise<"ok" | "unavailable"> {
  const db = runtime.__marksixD1;
  if (!db) return "unavailable";
  if (draws.length === 0) return "ok";

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
    return "ok";
  } catch {
    // Ledger settlement must never make the analysis endpoint unavailable.
    return "unavailable";
  }
}

export function skippedForecastLedger(
  reason:
    | "after_cutoff"
    | "target_unconfirmed"
    | "quality_gate_failed"
    | "generation_degraded",
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
       ORDER BY locked_at ASC, lock_id ASC`,
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
  const [, stableLineage] = compatibleForecastLineages(
    identity.algorithmVersion,
    identity.promptVersion,
  );
  const stableIdentity = [
    "forecast-ledger-v1",
    identity.game,
    identity.targetIssue,
    identity.windowSize,
    identity.focus,
    identity.depth,
    stableLineage.algorithmVersion,
    stableLineage.promptVersion,
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

function compatibleForecastLineages(
  algorithmVersion: string,
  promptVersion: string,
) {
  const current = { algorithmVersion, promptVersion };
  if (
    algorithmVersion === "forecast-engine-v5.0" &&
    promptVersion === "evidence-synthesis-v5"
  ) {
    return [
      current,
      {
        algorithmVersion: "forecast-engine-v4.0",
        promptVersion: "evidence-synthesis-v4",
      },
    ] as const;
  }
  return [current, current] as const;
}

async function buildCanonicalZodiacLockId(
  identity: CanonicalZodiacLockIdentity,
) {
  const stableAlgorithmVersion =
    identity.algorithmVersion === "forecast-engine-v5.0"
      ? "forecast-engine-v4.0"
      : identity.algorithmVersion;
  const stableIdentity = [
    "canonical-zodiac-lock-v1",
    identity.game,
    identity.targetIssue,
    stableAlgorithmVersion,
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
