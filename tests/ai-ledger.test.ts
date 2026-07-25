import assert from "node:assert/strict";
import test from "node:test";
import {
  applyCanonicalZodiacObservation,
  lockCanonicalZodiacObservation,
  lockForecastSnapshot,
  readForecastLedgerSummary,
  readForecastSnapshot,
  readLatestRestorableForecast,
  settleForecastLedger,
  type CanonicalZodiacLockPayload,
  type ForecastLedgerIdentity,
} from "../lib/ai-forecast-ledger.ts";

type StoredRow = {
  forecast_id: string;
  game: string;
  target_issue: string;
  expected_draw_at: string;
  analysis_cutoff_at: string;
  window_size: number;
  focus: string;
  depth: string;
  data_fingerprint: string;
  algorithm_version: string;
  prompt_version: string;
  schema_version: string;
  model: string;
  reasoning: string;
  response_json: string;
  locked_at: string;
  actual_json: string | null;
  settled_at: string | null;
};

type CanonicalStoredRow = {
  lock_id: string;
  game: string;
  target_issue: string;
  expected_draw_at: string;
  algorithm_version: string;
  schema_version: string;
  payload_json: string;
  locked_at: string;
  actual_json: string | null;
  settled_at: string | null;
};

function isSuccessfulAiSnapshot(row: StoredRow) {
  try {
    const snapshot = JSON.parse(row.response_json) as {
      mode?: unknown;
      status?: unknown;
      fallbackReason?: unknown;
    };
    return (
      snapshot.mode === "ai" &&
      snapshot.status === "ok" &&
      snapshot.fallbackReason === null
    );
  } catch {
    return false;
  }
}

function isVerifiedActual(row: StoredRow, targetIssue: string) {
  if (!row.actual_json) return false;
  try {
    const actual = JSON.parse(row.actual_json) as {
      issue?: unknown;
      verified?: unknown;
    };
    return actual.issue === targetIssue && actual.verified === true;
  } catch {
    return false;
  }
}

function matchesLineage(
  row: StoredRow,
  firstAlgorithm: unknown,
  firstPrompt: unknown,
  secondAlgorithm: unknown,
  secondPrompt: unknown,
) {
  return (
    (
      row.algorithm_version === String(firstAlgorithm) &&
      row.prompt_version === String(firstPrompt)
    ) ||
    (
      row.algorithm_version === String(secondAlgorithm) &&
      row.prompt_version === String(secondPrompt)
    )
  );
}

class FakeD1 {
  rows = new Map<string, StoredRow>();
  canonicalRows = new Map<string, CanonicalStoredRow>();

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...nextValues: unknown[]) => {
        values = nextValues;
        return statement;
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO ai_forecast_ledger")) {
          const id = String(values[0]);
          if (this.rows.has(id)) {
            return { results: [], success: true, meta: { changes: 0 } };
          }
          this.rows.set(id, {
            forecast_id: id,
            game: String(values[1]),
            target_issue: String(values[2]),
            expected_draw_at: String(values[3]),
            analysis_cutoff_at: String(values[4]),
            window_size: Number(values[5]),
            focus: String(values[6]),
            depth: String(values[7]),
            data_fingerprint: String(values[8]),
            algorithm_version: String(values[9]),
            prompt_version: String(values[10]),
            schema_version: String(values[11]),
            model: String(values[12]),
            reasoning: String(values[13]),
            response_json: String(values[14]),
            locked_at: String(values[15]),
            actual_json: null,
            settled_at: null,
          });
          return { results: [], success: true, meta: { changes: 1 } };
        }
        if (
          sql.includes(
            "INSERT OR IGNORE INTO ai_primary_observation_locks",
          )
        ) {
          const id = String(values[0]);
          if (this.canonicalRows.has(id)) {
            return { results: [], success: true, meta: { changes: 0 } };
          }
          this.canonicalRows.set(id, {
            lock_id: id,
            game: String(values[1]),
            target_issue: String(values[2]),
            expected_draw_at: String(values[3]),
            algorithm_version: String(values[4]),
            schema_version: String(values[5]),
            payload_json: String(values[6]),
            locked_at: String(values[7]),
            actual_json: null,
            settled_at: null,
          });
          return { results: [], success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE ai_forecast_ledger")) {
          let changes = 0;
          for (const row of this.rows.values()) {
            if (
              row.game === String(values[2]) &&
              row.target_issue === String(values[3]) &&
              row.settled_at === null
            ) {
              row.actual_json = String(values[0]);
              row.settled_at = String(values[1]);
              changes += 1;
            }
          }
          return { results: [], success: true, meta: { changes } };
        }
        if (sql.includes("UPDATE ai_primary_observation_locks")) {
          let changes = 0;
          for (const row of this.canonicalRows.values()) {
            if (
              row.game === String(values[2]) &&
              row.target_issue === String(values[3]) &&
              row.settled_at === null
            ) {
              row.actual_json = String(values[0]);
              row.settled_at = String(values[1]);
              changes += 1;
            }
          }
          return { results: [], success: true, meta: { changes } };
        }
        return { results: [], success: true, meta: { changes: 0 } };
      },
      first: async <T>() => {
        if (
          sql.includes("FROM ai_forecast_ledger") &&
          sql.includes("settled_at IS NOT NULL") &&
          sql.includes("AND target_issue = ?")
        ) {
          const asOfAt = String(values[2]);
          const requestedWindow = values[15];
          const requestedFocus = values[17];
          return (
            [...this.rows.values()]
              .filter(
                (row) =>
                  row.game === String(values[0]) &&
                  row.target_issue === String(values[1]) &&
                  row.settled_at !== null &&
                  row.settled_at <= asOfAt &&
                  row.expected_draw_at <= String(values[3]) &&
                  row.analysis_cutoff_at < row.expected_draw_at &&
                  row.locked_at < row.expected_draw_at &&
                  row.analysis_cutoff_at <= String(values[4]) &&
                  row.locked_at <= String(values[5]) &&
                  isVerifiedActual(row, String(values[6])) &&
                  matchesLineage(
                    row,
                    values[7],
                    values[8],
                    values[9],
                    values[10],
                  ) &&
                  row.schema_version === String(values[11]) &&
                  row.model === String(values[12]) &&
                  row.reasoning === String(values[13]) &&
                  row.depth === String(values[14]) &&
                  (
                    requestedWindow === null ||
                    row.window_size === Number(requestedWindow)
                  ) &&
                  (
                    requestedFocus === null ||
                    row.focus === String(requestedFocus)
                  ) &&
                  isSuccessfulAiSnapshot(row),
              )
              .sort(
                (left, right) =>
                  left.locked_at.localeCompare(right.locked_at) ||
                  left.forecast_id.localeCompare(right.forecast_id),
              )[0] ?? null
          ) as T | null;
        }
        if (
          sql.includes("FROM ai_forecast_ledger") &&
          sql.includes("settled_at IS NULL") &&
          sql.includes("(? IS NULL OR window_size = ?)")
        ) {
          const requestedWindow = values[13];
          const requestedFocus = values[15];
          return (
            [...this.rows.values()]
              .filter(
                (row) =>
                  row.game === String(values[0]) &&
                  row.target_issue === String(values[1]) &&
                  row.expected_draw_at === String(values[2]) &&
                  row.settled_at === null &&
                  row.analysis_cutoff_at <= String(values[3]) &&
                  row.locked_at <= String(values[4]) &&
                  matchesLineage(
                    row,
                    values[5],
                    values[6],
                    values[7],
                    values[8],
                  ) &&
                  row.schema_version === String(values[9]) &&
                  row.model === String(values[10]) &&
                  row.reasoning === String(values[11]) &&
                  row.depth === String(values[12]) &&
                  (
                    requestedWindow === null ||
                    row.window_size === Number(requestedWindow)
                  ) &&
                  (
                    requestedFocus === null ||
                    row.focus === String(requestedFocus)
                  ) &&
                  isSuccessfulAiSnapshot(row),
              )
              .sort(
                (left, right) =>
                  left.locked_at.localeCompare(right.locked_at) ||
                  left.forecast_id.localeCompare(right.forecast_id),
              )[0] ?? null
          ) as T | null;
        }
        if (
          sql.includes("FROM ai_forecast_ledger") &&
          sql.includes("AND window_size = ?")
        ) {
          return (
            [...this.rows.values()]
              .filter(
                (row) =>
                  row.game === String(values[0]) &&
                  row.target_issue === String(values[1]) &&
                  row.expected_draw_at === String(values[2]) &&
                  row.window_size === Number(values[3]) &&
                  row.focus === String(values[4]) &&
                  row.depth === String(values[5]) &&
                  matchesLineage(
                    row,
                    values[6],
                    values[7],
                    values[8],
                    values[9],
                  ) &&
                  row.schema_version === String(values[10]) &&
                  row.model === String(values[11]) &&
                  row.reasoning === String(values[12]) &&
                  row.settled_at === null &&
                  row.analysis_cutoff_at <= String(values[13]) &&
                  row.locked_at <= String(values[14]) &&
                  isSuccessfulAiSnapshot(row),
              )
              .sort(
                (left, right) =>
                  left.locked_at.localeCompare(right.locked_at) ||
                  left.forecast_id.localeCompare(right.forecast_id),
              )[0] ?? null
          ) as T | null;
        }
        if (sql.includes("WHERE forecast_id = ?")) {
          const row = this.rows.get(String(values[0])) ?? null;
          if (!row) return null;
          return row as T;
        }
        if (
          sql.includes("FROM ai_primary_observation_locks") &&
          sql.includes("AND target_issue = ?") &&
          sql.includes("ORDER BY locked_at ASC")
        ) {
          return (
            [...this.canonicalRows.values()]
              .filter(
                (row) =>
                  row.game === String(values[0]) &&
                  row.target_issue === String(values[1]) &&
                  row.locked_at <= String(values[2]),
              )
              .sort(
                (left, right) =>
                  left.locked_at.localeCompare(right.locked_at) ||
                  left.lock_id.localeCompare(right.lock_id),
              )[0] ?? null
          ) as T | null;
        }
        if (
          sql.includes("FROM ai_primary_observation_locks") &&
          sql.includes("WHERE lock_id = ?")
        ) {
          return (
            this.canonicalRows.get(String(values[0])) ?? null
          ) as T | null;
        }
        if (sql.includes("COUNT(*) AS total_forecasts")) {
          const game = String(values[0]);
          const rows = [...this.rows.values()].filter((row) => row.game === game);
          return {
            total_forecasts: rows.length,
            settled_forecasts: rows.filter((row) => row.settled_at).length,
          } as T;
        }
        return null;
      },
      all: async <T>() => {
        if (sql.includes("SELECT DISTINCT target_issue")) {
          const game = String(values[0]);
          const source = sql.includes("ai_primary_observation_locks")
            ? [...this.canonicalRows.values()]
            : [...this.rows.values()];
          return {
            results: [
              ...new Set(
                source
                  .filter(
                    (row) => row.game === game && row.settled_at === null,
                  )
                  .map((row) => row.target_issue),
              ),
            ].map((target_issue) => ({ target_issue })) as T[],
            success: true,
          };
        }
        if (
          sql.includes(
            "SELECT target_issue, expected_draw_at, payload_json, actual_json",
          )
        ) {
          const game = String(values[0]);
          return {
            results: [...this.canonicalRows.values()]
              .filter((row) => row.game === game)
              .sort(
                (left, right) =>
                  left.locked_at.localeCompare(right.locked_at) ||
                  left.lock_id.localeCompare(right.lock_id),
              )
              .map((row) => ({
                target_issue: row.target_issue,
                expected_draw_at: row.expected_draw_at,
                payload_json: row.payload_json,
                actual_json: row.actual_json,
              })) as T[],
            success: true,
          };
        }
        if (sql.includes("SELECT response_json, actual_json")) {
          const game = String(values[0]);
          return {
            results: [...this.rows.values()]
              .filter((row) => row.game === game)
              .sort(
                (left, right) =>
                  right.locked_at.localeCompare(left.locked_at) ||
                  right.forecast_id.localeCompare(left.forecast_id),
              )
              .map((row) => ({
                response_json: row.response_json,
                actual_json: row.actual_json,
              })) as T[],
            success: true,
          };
        }
        return { results: [] as T[], success: true };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

const identity: ForecastLedgerIdentity = {
  game: "new_macau",
  targetIssue: "2026205",
  expectedDrawAt: "2026-07-25T13:32:00.000Z",
  analysisCutoffAt: "2026-07-24T09:00:00.000Z",
  windowSize: 30,
  focus: "comprehensive",
  depth: "deep",
  dataFingerprint: "first-fingerprint",
  algorithmVersion: "forecast-engine-v4.0",
  promptVersion: "evidence-synthesis-v4",
  schemaVersion: "4",
  model: "gpt-test",
  reasoning: "medium",
};

const canonicalIdentity = {
  game: identity.game,
  targetIssue: identity.targetIssue,
  expectedDrawAt: identity.expectedDrawAt,
  analysisCutoffAt: identity.analysisCutoffAt,
  algorithmVersion: identity.algorithmVersion,
  schemaVersion: identity.schemaVersion,
};

function lockEligibleCanonical(
  lockIdentity: Parameters<typeof lockCanonicalZodiacObservation>[0],
  payload: CanonicalZodiacLockPayload,
) {
  return lockCanonicalZodiacObservation(lockIdentity, payload, {
    persistenceEligible: true,
  });
}

function lockEligibleForecast<T>(
  lockIdentity: ForecastLedgerIdentity,
  snapshot: T,
) {
  return lockForecastSnapshot(lockIdentity, snapshot, {
    persistenceEligible: true,
    generationSuccessful: true,
  });
}

function successfulSnapshot(
  marker: string,
  lockIdentity: ForecastLedgerIdentity = identity,
) {
  return {
    schemaVersion: lockIdentity.schemaVersion,
    mode: "ai",
    status: "ok",
    fallbackReason: null,
    marker,
    generatedAt: lockIdentity.analysisCutoffAt,
    game: lockIdentity.game,
    focus: lockIdentity.focus,
    target: {
      issue: lockIdentity.targetIssue,
      expectedDrawAt: lockIdentity.expectedDrawAt,
    },
    dataQuality: {
      latestDrawAt: "2026-07-23T13:32:00.000Z",
    },
    synthesis: { executiveSummary: marker },
    candidateSets: [{}, {}, {}],
    zodiacObservation: {
      kind: "zodiac_coverage_6_plus_1",
      zodiac: "狗",
    },
    decision: { kind: "abstain", scenarioId: null },
  };
}

function canonicalPayload(
  zodiac = "狗",
  scenarioId: "balanced" | "momentum" | "contrarian" = "balanced",
): CanonicalZodiacLockPayload {
  const backtest = {
    id: "zodiac_coverage" as const,
    label: "6+1 生肖覆盖",
    sampleSize: 40,
    hitCount: 20,
    hitRate: 50,
    confidenceInterval: {
      low: 35,
      high: 65,
      level: 95 as const,
      method: "wilson" as const,
    },
    baselineRate: 48,
    lift: 2,
    randomPValue: 0.4,
    status: "not_above_random" as const,
  };
  return {
    primary: {
      kind: "zodiac_coverage_6_plus_1",
      scenarioId,
      zodiac,
      target: "当期 6+1 至少出现 1 个该生肖",
      configuration: {
        focus: "comprehensive",
        trainWindow: 30,
        userSelectable: false,
      },
      baselineRate: 48,
      validation: "no_advantage",
      backtest,
      conclusion: `首次冻结方向为${zodiac}`,
    },
    scenarioObservation: {
      id: "zodiac_coverage",
      label: "6+1 生肖覆盖",
      pick: zodiac,
      target: "正码与特码至少出现一个",
      threshold: 1,
      memberCount: 4,
      baselineRate: 48,
      backtest,
    },
  };
}

function settleFakeRows(
  database: FakeD1,
  actual: {
    drawAt: string;
    numbers: number[];
    special: number;
  },
  settledAt = "2026-07-25T14:00:00.000Z",
) {
  const actualJson = JSON.stringify(actual);
  for (const row of database.rows.values()) {
    row.actual_json = actualJson;
    row.settled_at = settledAt;
  }
  for (const row of database.canonicalRows.values()) {
    row.actual_json = actualJson;
    row.settled_at = settledAt;
  }
}

test("canonical primary lock reuses the earliest direction across engine versions", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const firstPayload = canonicalPayload("狗", "balanced");
    const secondPayload = canonicalPayload("虎", "momentum");
    const first = await lockEligibleCanonical(
      canonicalIdentity,
      firstPayload,
    );
    const second = await lockEligibleCanonical(
      {
        ...canonicalIdentity,
        analysisCutoffAt: "2026-07-24T10:00:00.000Z",
        algorithmVersion: "forecast-engine-v5.0",
      },
      secondPayload,
    );

    assert.equal(first.state, "locked");
    assert.equal(second.state, "existing");
    assert.equal(second.payload.primary.zodiac, "狗");
    assert.equal(second.payload.primary.scenarioId, "balanced");
    assert.equal(database.canonicalRows.size, 1);

    const currentPack = {
      zodiacObservation: secondPayload.primary,
      candidateSets: [
        {
          id: "balanced",
          description: "当前综合报告仍应保留",
          observations: [canonicalPayload("兔").scenarioObservation],
        },
        {
          id: "momentum",
          description: "当前生肖焦点报告仍应保留",
          observations: [secondPayload.scenarioObservation],
        },
      ],
      localSynthesis: {
        executiveSummary: "当前报告",
        recommendedScenarioId: "momentum",
        recommendationReason: "当前报告",
      },
    } as unknown as Parameters<typeof applyCanonicalZodiacObservation>[0];
    const applied = applyCanonicalZodiacObservation(
      currentPack,
      second.payload,
    );
    assert.equal(applied.zodiacObservation.zodiac, "狗");
    assert.equal(
      applied.candidateSets
        .find((candidate) => candidate.id === "balanced")
        ?.observations.find(
          (observation) => observation.id === "zodiac_coverage",
        )?.pick,
      "狗",
    );
    assert.equal(
      applied.candidateSets.find(
        (candidate) => candidate.id === "momentum",
      )?.description,
      "当前生肖焦点报告仍应保留",
    );
    await lockEligibleForecast(identity, {
      focusMarker: "comprehensive",
      zodiacObservation: first.payload.primary,
    });
    const focusedReport = await lockEligibleForecast(
      { ...identity, focus: "zodiac" },
      {
        focusMarker: "zodiac",
        zodiacObservation: applied.zodiacObservation,
      },
    );
    assert.equal(focusedReport.snapshot.focusMarker, "zodiac");
    assert.equal(
      focusedReport.snapshot.zodiacObservation.zodiac,
      "狗",
    );
    assert.equal(database.rows.size, 2);
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("an unverified first proposal cannot occupy the canonical lock", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const unverified = await lockCanonicalZodiacObservation(
      canonicalIdentity,
      canonicalPayload("狗"),
      { persistenceEligible: false },
    );
    assert.equal(unverified.state, "skipped");
    assert.equal(unverified.payload.primary.zodiac, "狗");
    assert.equal(database.canonicalRows.size, 0);

    const verified = await lockCanonicalZodiacObservation(
      {
        ...canonicalIdentity,
        analysisCutoffAt: "2026-07-24T10:00:00.000Z",
      },
      canonicalPayload("虎"),
      { persistenceEligible: true },
    );
    assert.equal(verified.state, "locked");
    assert.equal(verified.payload.primary.zodiac, "虎");
    assert.equal(database.canonicalRows.size, 1);

    const later = await lockCanonicalZodiacObservation(
      {
        ...canonicalIdentity,
        analysisCutoffAt: "2026-07-24T11:00:00.000Z",
      },
      canonicalPayload("狗"),
      { persistenceEligible: true },
    );
    assert.equal(later.state, "existing");
    assert.equal(later.payload.primary.zodiac, "虎");
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("forecast ledger keeps the first successful report immutable across source corrections", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const firstSnapshot = {
      ...successfulSnapshot("v4-first"),
      decision: { kind: "observe", scenarioId: "balanced" },
      zodiacObservation: {
        kind: "zodiac_coverage_6_plus_1",
        zodiac: "狗",
      },
      candidateSets: [
        { id: "balanced", numbers: [1, 2, 3, 4, 5, 6], special: 7 },
      ],
    };
    const secondSnapshot = {
      ...successfulSnapshot("v5-later", {
        ...identity,
        analysisCutoffAt: "2026-07-24T10:00:00.000Z",
        algorithmVersion: "forecast-engine-v5.0",
        promptVersion: "evidence-synthesis-v5",
      }),
      decision: { kind: "observe", scenarioId: "balanced" },
      candidateSets: [
        { id: "balanced", numbers: [41, 42, 43, 44, 45, 46], special: 47 },
      ],
    };

    const first = await lockEligibleForecast(identity, firstSnapshot);
    const corrected = await lockEligibleForecast(
      {
        ...identity,
        analysisCutoffAt: "2026-07-24T10:00:00.000Z",
        dataFingerprint: "later-fingerprint",
        algorithmVersion: "forecast-engine-v5.0",
        promptVersion: "evidence-synthesis-v5",
      },
      secondSnapshot,
    );

    assert.equal(first.ledger.state, "locked");
    assert.equal(first.ledger.immutable, true);
    assert.equal(corrected.ledger.state, "existing");
    assert.equal(corrected.ledger.immutable, true);
    assert.deepEqual(corrected.snapshot, firstSnapshot);
    assert.equal(database.rows.size, 1);
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("rolling v4/v5 workers converge on one report and one canonical direction", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const v5Identity = {
      ...identity,
      algorithmVersion: "forecast-engine-v5.0",
      promptVersion: "evidence-synthesis-v5",
    };
    const [v4Report, v5Report] = await Promise.all([
      lockEligibleForecast(
        identity,
        successfulSnapshot("v4-worker"),
      ),
      lockEligibleForecast(
        v5Identity,
        successfulSnapshot("v5-worker", v5Identity),
      ),
    ]);
    assert.equal(database.rows.size, 1);
    assert.equal(v4Report.snapshot.marker, v5Report.snapshot.marker);
    assert.deepEqual(
      new Set([v4Report.ledger.state, v5Report.ledger.state]),
      new Set(["locked", "existing"]),
    );

    const [v4Canonical, v5Canonical] = await Promise.all([
      lockEligibleCanonical(
        canonicalIdentity,
        canonicalPayload("狗"),
      ),
      lockEligibleCanonical(
        {
          ...canonicalIdentity,
          algorithmVersion: "forecast-engine-v5.0",
        },
        canonicalPayload("虎"),
      ),
    ]);
    assert.equal(database.canonicalRows.size, 1);
    assert.equal(
      v4Canonical.payload.primary.zodiac,
      v5Canonical.payload.primary.zodiac,
    );
    assert.deepEqual(
      new Set([v4Canonical.state, v5Canonical.state]),
      new Set(["locked", "existing"]),
    );
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("exact D1 recovery is model-config exact, pre-draw only, and compatible with legacy ids", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const snapshot = successfulSnapshot("persisted");
    await lockEligibleForecast(identity, snapshot);

    // Recovery deliberately queries the established columns rather than
    // recomputing the v1/v2 forecast id, so already-deployed rows still work.
    const stored = [...database.rows.values()][0];
    database.rows.delete(stored.forecast_id);
    stored.forecast_id = "legacy-v1-forecast-id";
    database.rows.set(stored.forecast_id, stored);

    const restored = await readForecastSnapshot<typeof snapshot>(
      identity,
      "2026-07-24T12:00:00.000Z",
    );
    assert.equal(restored?.snapshot.marker, "persisted");
    assert.equal(restored?.ledger.forecastId, "legacy-v1-foreca");
    assert.equal(restored?.ledger.state, "existing");
    assert.equal(restored?.ledger.immutable, true);

    const correctedSource = await readForecastSnapshot<typeof snapshot>(
      { ...identity, dataFingerprint: "corrected-source-state" },
      "2026-07-24T12:00:00.000Z",
    );
    assert.equal(correctedSource?.snapshot.marker, "persisted");
    const upgradedEngine = await readForecastSnapshot<typeof snapshot>(
      {
        ...identity,
        algorithmVersion: "forecast-engine-v5.0",
        promptVersion: "evidence-synthesis-v5",
      },
      "2026-07-24T12:00:00.000Z",
    );
    assert.equal(upgradedEngine?.snapshot.marker, "persisted");

    for (const mismatch of [
      { promptVersion: "different-prompt" },
      { model: "different-model" },
      { reasoning: "low" },
      { depth: "standard" },
    ]) {
      assert.equal(
        await readForecastSnapshot(
          { ...identity, ...mismatch },
          "2026-07-24T12:00:00.000Z",
        ),
        null,
      );
    }
    assert.equal(
      await readForecastSnapshot(identity, identity.expectedDrawAt),
      null,
    );
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("latest recovery filters the complete model configuration and excludes degraded rows", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const snapshot = successfulSnapshot("latest");
    await lockEligibleForecast(identity, snapshot);
    const query = {
      state: "pending" as const,
      game: identity.game,
      targetIssue: identity.targetIssue,
      expectedDrawAt: identity.expectedDrawAt,
      asOfAt: "2026-07-24T12:00:00.000Z",
      algorithmVersion: identity.algorithmVersion,
      promptVersion: identity.promptVersion,
      schemaVersion: identity.schemaVersion,
      model: identity.model,
      reasoning: identity.reasoning,
      depth: identity.depth,
      windowSize: identity.windowSize,
      focus: identity.focus,
    };
    const restored =
      await readLatestRestorableForecast<typeof snapshot>(query);
    assert.equal(restored?.snapshot.marker, "latest");
    const upgraded =
      await readLatestRestorableForecast<typeof snapshot>({
        ...query,
        algorithmVersion: "forecast-engine-v5.0",
        promptVersion: "evidence-synthesis-v5",
      });
    assert.equal(upgraded?.snapshot.marker, "latest");

    assert.equal(
      await readLatestRestorableForecast({
        ...query,
        promptVersion: "old-prompt",
      }),
      null,
    );
    assert.equal(
      await readLatestRestorableForecast({
        ...query,
        model: "old-model",
      }),
      null,
    );
    assert.equal(
      await readLatestRestorableForecast({
        ...query,
        reasoning: "low",
      }),
      null,
    );
    assert.equal(
      await readLatestRestorableForecast({
        ...query,
        depth: "standard",
      }),
      null,
    );

    const row = [...database.rows.values()][0];
    row.response_json = JSON.stringify({
      ...snapshot,
      mode: "statistical",
      status: "degraded",
      fallbackReason: "timeout",
    });
    assert.equal(await readLatestRestorableForecast(query), null);
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("quality or generation failures never occupy a full-report ledger id", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const unverified = await lockForecastSnapshot(
      identity,
      successfulSnapshot("unverified"),
      {
        persistenceEligible: false,
        generationSuccessful: true,
      },
    );
    assert.equal(unverified.ledger.state, "skipped");
    assert.equal(unverified.ledger.reason, "quality_gate_failed");
    assert.equal(database.rows.size, 0);

    const degraded = await lockForecastSnapshot(
      identity,
      {
        ...successfulSnapshot("timeout"),
        mode: "statistical",
        status: "degraded",
        fallbackReason: "timeout",
      },
      {
        persistenceEligible: true,
        generationSuccessful: false,
      },
    );
    assert.equal(degraded.ledger.state, "skipped");
    assert.equal(degraded.ledger.reason, "generation_degraded");
    assert.equal(database.rows.size, 0);

    const verifiedIdentity = {
      ...identity,
      analysisCutoffAt: "2026-07-24T10:00:00.000Z",
      dataFingerprint: "verified-fingerprint",
    };
    const verified = await lockForecastSnapshot(
      verifiedIdentity,
      successfulSnapshot("verified", verifiedIdentity),
      {
        persistenceEligible: true,
        generationSuccessful: true,
      },
    );
    assert.equal(verified.ledger.state, "locked");
    assert.equal(database.rows.size, 1);
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("post-draw recovery returns only the exact latest verified settled target", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const snapshot = successfulSnapshot("settled-review");
    await lockEligibleForecast(identity, snapshot);
    await settleForecastLedger(
      identity.game,
      [{
        game: identity.game,
        issue: identity.targetIssue,
        drawAt: identity.expectedDrawAt,
        numbers: [5, 9, 14, 26, 31, 37],
        special: 48,
        source: "cross-check",
        verified: true,
      }],
      "2026-07-25T14:00:00.000Z",
    );
    const query = {
      state: "settled" as const,
      game: identity.game,
      targetIssue: identity.targetIssue,
      asOfAt: "2026-07-25T14:05:00.000Z",
      algorithmVersion: identity.algorithmVersion,
      promptVersion: identity.promptVersion,
      schemaVersion: identity.schemaVersion,
      model: identity.model,
      reasoning: identity.reasoning,
      depth: identity.depth,
      windowSize: identity.windowSize,
      focus: identity.focus,
    };
    const restored =
      await readLatestRestorableForecast<typeof snapshot>(query);
    assert.equal(restored?.snapshot.marker, "settled-review");
    assert.equal(
      restored?.ledger.settledAt,
      "2026-07-25T14:00:00.000Z",
    );
    assert.equal(restored?.expectedDrawAt, identity.expectedDrawAt);
    const upgradedReview =
      await readLatestRestorableForecast<typeof snapshot>({
        ...query,
        algorithmVersion: "forecast-engine-v5.0",
        promptVersion: "evidence-synthesis-v5",
      });
    assert.equal(
      upgradedReview?.snapshot.marker,
      "settled-review",
    );
    assert.equal(
      await readLatestRestorableForecast({
        ...query,
        targetIssue: "2026204",
      }),
      null,
    );
    assert.equal(
      await readLatestRestorableForecast({
        ...query,
        asOfAt: "2026-07-25T13:59:59.000Z",
      }),
      null,
    );
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("forward summary scores every settled observed forecast", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    await lockEligibleForecast(identity, {
      target: {
        issue: identity.targetIssue,
        expectedDrawAt: identity.expectedDrawAt,
      },
      decision: { kind: "observe", scenarioId: "balanced" },
      zodiacObservation: {
        kind: "zodiac_coverage_6_plus_1",
        zodiac: "狗",
      },
      candidateSets: [
        { id: "balanced", numbers: [1, 2, 3, 4, 5, 6], special: 7 },
      ],
    });
    await lockEligibleCanonical(
      canonicalIdentity,
      canonicalPayload("狗"),
    );
    settleFakeRows(database, {
      drawAt: "2026-07-25T13:32:00.000Z",
      numbers: [1, 2, 20, 21, 22, 23],
      special: 7,
    });

    const summary = await readForecastLedgerSummary("new_macau");
    assert.deepEqual(summary, {
      totalForecasts: 1,
      settledForecasts: 1,
      trackedForecasts: 1,
      observedForecasts: 1,
      evaluatedObservedForecasts: 1,
      totalMainOverlap: 2,
      averageMainOverlap: 2,
      specialExactHits: 1,
      zodiacObservedForecasts: 1,
      zodiacEvaluatedForecasts: 1,
      zodiacCoverageHits: 1,
      zodiacCoverageRate: 100,
    });
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("forward summary settles a 6+1 zodiac direction even when advantage is unproven", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    await lockEligibleForecast(identity, {
      target: {
        issue: identity.targetIssue,
        expectedDrawAt: identity.expectedDrawAt,
      },
      decision: { kind: "abstain", scenarioId: null },
      zodiacObservation: {
        kind: "zodiac_coverage_6_plus_1",
        scenarioId: "balanced",
        zodiac: "狗",
      },
      candidateSets: [
        { id: "balanced", numbers: [1, 2, 3, 4, 5, 6], special: 7 },
      ],
    });
    await lockEligibleCanonical(
      canonicalIdentity,
      canonicalPayload("狗"),
    );
    settleFakeRows(database, {
      drawAt: "2026-07-25T13:32:00.000Z",
      numbers: [9, 14, 26, 31, 37, 48],
      special: 5,
    });

    const summary = await readForecastLedgerSummary("new_macau");
    assert.deepEqual(summary, {
      totalForecasts: 1,
      settledForecasts: 1,
      trackedForecasts: 1,
      observedForecasts: 0,
      evaluatedObservedForecasts: 0,
      totalMainOverlap: 0,
      averageMainOverlap: null,
      specialExactHits: 0,
      zodiacObservedForecasts: 1,
      zodiacEvaluatedForecasts: 1,
      zodiacCoverageHits: 1,
      zodiacCoverageRate: 100,
    });
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("zodiac forward summary counts one sample per target issue", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const snapshot = {
      target: {
        issue: identity.targetIssue,
        expectedDrawAt: identity.expectedDrawAt,
      },
      decision: { kind: "abstain", scenarioId: null },
      zodiacObservation: {
        kind: "zodiac_coverage_6_plus_1",
        scenarioId: "balanced",
        zodiac: "狗",
      },
      candidateSets: [],
    };
    await lockEligibleForecast(identity, snapshot);
    await lockEligibleForecast(
      { ...identity, focus: "zodiac" },
      snapshot,
    );
    await lockEligibleCanonical(
      canonicalIdentity,
      canonicalPayload("狗"),
    );
    settleFakeRows(database, {
      drawAt: "2026-07-25T13:32:00.000Z",
      numbers: [9, 14, 26, 31, 37, 48],
      special: 5,
    });

    const summary = await readForecastLedgerSummary("new_macau");
    assert.equal(summary?.totalForecasts, 2);
    assert.equal(summary?.settledForecasts, 2);
    assert.equal(summary?.zodiacObservedForecasts, 1);
    assert.equal(summary?.zodiacEvaluatedForecasts, 1);
    assert.equal(summary?.zodiacCoverageHits, 1);
    assert.equal(summary?.zodiacCoverageRate, 100);
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("canonical zodiac summary is not truncated at five hundred snapshots", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    for (let index = 0; index < 501; index += 1) {
      await lockEligibleCanonical(
        {
          ...canonicalIdentity,
          targetIssue: String(2027000 + index),
        },
        canonicalPayload("狗"),
      );
    }
    settleFakeRows(database, {
      drawAt: "2026-07-25T13:32:00.000Z",
      numbers: [9, 14, 26, 31, 37, 48],
      special: 5,
    });

    const summary = await readForecastLedgerSummary("new_macau");
    assert.equal(summary?.zodiacObservedForecasts, 501);
    assert.equal(summary?.zodiacEvaluatedForecasts, 501);
    assert.equal(summary?.zodiacCoverageHits, 501);
    assert.equal(summary?.zodiacCoverageRate, 100);
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("conflicting snapshots for one issue cannot inflate the zodiac sample", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const snapshotFor = (zodiac: string) => ({
      target: {
        issue: identity.targetIssue,
        expectedDrawAt: identity.expectedDrawAt,
      },
      decision: { kind: "abstain", scenarioId: null },
      zodiacObservation: {
        kind: "zodiac_coverage_6_plus_1",
        scenarioId: "balanced",
        zodiac,
      },
      candidateSets: [],
    });
    await lockEligibleForecast(identity, snapshotFor("狗"));
    await lockEligibleForecast(
      { ...identity, focus: "zodiac" },
      snapshotFor("虎"),
    );
    await lockEligibleCanonical(
      canonicalIdentity,
      canonicalPayload("狗"),
    );
    settleFakeRows(database, {
      drawAt: "2026-07-25T13:32:00.000Z",
      numbers: [5, 9, 14, 26, 31, 37],
      special: 48,
    });

    const summary = await readForecastLedgerSummary("new_macau");
    assert.equal(summary?.zodiacObservedForecasts, 1);
    assert.equal(summary?.zodiacEvaluatedForecasts, 1);
    assert.equal(summary?.zodiacCoverageHits, 1);
    assert.equal(summary?.zodiacCoverageRate, 100);
  } finally {
    runtime.__marksixD1 = previous;
  }
});

test("settlement waits for cross-source verification before scoring the frozen zodiac", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    await lockEligibleForecast(identity, {
      target: {
        issue: identity.targetIssue,
        expectedDrawAt: identity.expectedDrawAt,
      },
      decision: { kind: "abstain", scenarioId: null },
      zodiacObservation: {
        kind: "zodiac_coverage_6_plus_1",
        scenarioId: "balanced",
        zodiac: "狗",
      },
      candidateSets: [],
    });
    await lockEligibleCanonical(
      canonicalIdentity,
      canonicalPayload("狗"),
    );

    const unverifiedDraw = {
      game: "new_macau" as const,
      issue: identity.targetIssue,
      drawAt: "2026-07-25T13:32:00.000Z",
      numbers: [9, 14, 26, 31, 37, 48],
      special: 5,
      source: "test",
      verified: false,
    };
    assert.equal(await settleForecastLedger(
      "new_macau",
      [unverifiedDraw],
      "2026-07-25T13:40:00.000Z",
    ), "ok");
    const stored = [...database.rows.values()][0];
    const canonicalStored = [...database.canonicalRows.values()][0];
    assert.equal(stored.settled_at, null);
    assert.equal(stored.actual_json, null);
    assert.equal(canonicalStored.settled_at, null);
    assert.equal(canonicalStored.actual_json, null);

    assert.equal(await settleForecastLedger(
      "new_macau",
      [{ ...unverifiedDraw, verified: true }],
      "2026-07-25T14:00:00.000Z",
    ), "ok");

    assert.equal(stored.settled_at, "2026-07-25T14:00:00.000Z");
    assert.ok(stored.actual_json);
    assert.equal(
      canonicalStored.settled_at,
      "2026-07-25T14:00:00.000Z",
    );
    assert.ok(canonicalStored.actual_json);
    const summary = await readForecastLedgerSummary("new_macau");
    assert.equal(summary?.zodiacEvaluatedForecasts, 1);
    assert.equal(summary?.zodiacCoverageHits, 1);
    assert.equal(summary?.zodiacCoverageRate, 100);
  } finally {
    runtime.__marksixD1 = previous;
  }
});
