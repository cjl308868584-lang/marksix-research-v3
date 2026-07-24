import assert from "node:assert/strict";
import test from "node:test";
import {
  lockForecastSnapshot,
  readForecastLedgerSummary,
  type ForecastLedgerIdentity,
} from "../lib/ai-forecast-ledger.ts";

type StoredRow = {
  forecast_id: string;
  game: string;
  target_issue: string;
  response_json: string;
  locked_at: string;
  actual_json: string | null;
  settled_at: string | null;
};

class FakeD1 {
  rows = new Map<string, StoredRow>();

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
            response_json: String(values[14]),
            locked_at: String(values[15]),
            actual_json: null,
            settled_at: null,
          });
          return { results: [], success: true, meta: { changes: 1 } };
        }
        return { results: [], success: true, meta: { changes: 0 } };
      },
      first: async <T>() => {
        if (sql.includes("WHERE forecast_id = ?")) {
          return (this.rows.get(String(values[0])) ?? null) as T | null;
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
        if (sql.includes("SELECT response_json, actual_json")) {
          const game = String(values[0]);
          return {
            results: [...this.rows.values()]
              .filter((row) => row.game === game)
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

  async batch() {
    return [];
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
  algorithmVersion: "forecast-engine-v3.1",
  promptVersion: "evidence-synthesis-v3",
  schemaVersion: "3",
  model: "gpt-test",
  reasoning: "medium",
};

test("forecast ledger keeps the first pre-draw snapshot immutable", async () => {
  const runtime = globalThis as typeof globalThis & {
    __marksixD1?: D1Database;
  };
  const previous = runtime.__marksixD1;
  const database = new FakeD1();
  runtime.__marksixD1 = database as unknown as D1Database;
  try {
    const firstSnapshot = {
      decision: { kind: "observe", scenarioId: "balanced" },
      candidateSets: [
        { id: "balanced", numbers: [1, 2, 3, 4, 5, 6], special: 7 },
      ],
    };
    const secondSnapshot = {
      decision: { kind: "observe", scenarioId: "balanced" },
      candidateSets: [
        { id: "balanced", numbers: [41, 42, 43, 44, 45, 46], special: 47 },
      ],
    };

    const first = await lockForecastSnapshot(identity, firstSnapshot);
    const second = await lockForecastSnapshot(
      { ...identity, dataFingerprint: "later-fingerprint" },
      secondSnapshot,
    );

    assert.equal(first.ledger.state, "locked");
    assert.equal(first.ledger.immutable, true);
    assert.equal(second.ledger.state, "existing");
    assert.equal(second.ledger.immutable, true);
    assert.deepEqual(second.snapshot, firstSnapshot);
    assert.equal(database.rows.size, 1);
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
    await lockForecastSnapshot(identity, {
      decision: { kind: "observe", scenarioId: "balanced" },
      candidateSets: [
        { id: "balanced", numbers: [1, 2, 3, 4, 5, 6], special: 7 },
      ],
    });
    const row = [...database.rows.values()][0];
    row.actual_json = JSON.stringify({
      numbers: [1, 2, 20, 21, 22, 23],
      special: 7,
    });
    row.settled_at = "2026-07-25T14:00:00.000Z";

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
    });
  } finally {
    runtime.__marksixD1 = previous;
  }
});
