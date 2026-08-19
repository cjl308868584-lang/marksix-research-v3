import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery.ts";
import type {
  ForwardLearningCandidate,
  ForwardLearningForecast,
} from "../lib/forward-learning-types.ts";

class FakeLearningD1 {
  forecasts = new Map<string, string>();
  candidates = new Map<string, string>();
  scores = new Map<string, string>();

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO forward_learning_forecasts")) {
          const key = `${values[1]}:${values[2]}:${values[3]}`;
          if (this.forecasts.has(key)) return { meta: { changes: 0 } };
          this.forecasts.set(key, String(values[11]));
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO forward_learning_candidates")) {
          const key = String(values[0]);
          if (this.candidates.has(key)) return { meta: { changes: 0 } };
          this.candidates.set(key, String(values[9]));
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO forward_learning_scores")) {
          const key = String(values[2]);
          if (this.scores.has(key)) return { meta: { changes: 0 } };
          this.scores.set(key, String(values[16]));
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      first: async <T>() => {
        if (sql.includes("SELECT target_issue FROM forward_learning_forecasts")) {
          return { target_issue: "2026230" } as T;
        }
        return null;
      },
      all: async <T>() => {
        if (sql.includes("FROM forward_learning_forecasts")) {
          return {
            results: [...this.forecasts.values()].map((forecast_json) => ({ forecast_json })) as T[],
          };
        }
        if (sql.includes("FROM forward_learning_candidates")) {
          return {
            results: [...this.candidates.values()].map((candidate_json) => ({ candidate_json })) as T[],
          };
        }
        if (sql.includes("FROM forward_learning_scores")) {
          return {
            results: [...this.scores.values()].map((score_json) => ({ score_json })) as T[],
          };
        }
        return { results: [] as T[] };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

type Store = typeof import("../lib/forward-learning-store.ts");
let server: ViteDevServer;
let store: Store;
let db: FakeLearningD1;
const runtime = globalThis as typeof globalThis & {
  __marksixD1?: unknown;
  __marksixForwardLearningSchemaReady?: unknown;
};

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  store = await server.ssrLoadModule("/lib/forward-learning-store.ts") as Store;
});

beforeEach(() => {
  db = new FakeLearningD1();
  runtime.__marksixD1 = db;
  delete runtime.__marksixForwardLearningSchemaReady;
});

after(async () => {
  delete runtime.__marksixD1;
  delete runtime.__marksixForwardLearningSchemaReady;
  await server.close();
});

test("freeze writes five official rows once and preserves the first snapshot", async () => {
  const forecasts = fiveForecasts();
  const candidates = forecasts.map(({ forecastId: _forecastId, official: _official, rank: _rank,
    previousResultKey: _previousResultKey, previousProbability: _previousProbability,
    probabilityDelta: _probabilityDelta, topAlternative: _topAlternative,
    explanation: _explanation, ...candidate }) => candidate);
  assert.equal(await store.freezeForwardLearningIssue(candidates, forecasts), "created");
  const original = [...db.forecasts.values()];
  assert.equal(await store.freezeForwardLearningIssue(
    candidates,
    forecasts.map((item) => ({ ...item, finalProbability: 0.99 })),
  ), "existing");
  assert.equal(db.forecasts.size, 5);
  assert.deepEqual([...db.forecasts.values()], original);
});

test("settlement rejects a forecast frozen after the draw", async () => {
  const forecasts = fiveForecasts().map((item) => ({
    ...item,
    frozenAt: "2026-08-18T22:00:00+08:00",
  }));
  const candidates = forecasts.map((item) => item as ForwardLearningCandidate);
  await store.freezeForwardLearningIssue(candidates, forecasts);
  await assert.rejects(
    store.settleForwardLearningIssue("new_macau", draw(), "2026-08-18T22:10:00+08:00"),
    /开奖前冻结/,
  );
});

test("settlement is idempotent and official totals contain one score per slot", async () => {
  const forecasts = fiveForecasts();
  await store.freezeForwardLearningIssue(
    forecasts.map((item) => item as ForwardLearningCandidate),
    forecasts,
  );
  const first = await store.settleForwardLearningIssue(
    "new_macau",
    draw(),
    "2026-08-18T22:10:00+08:00",
  );
  const second = await store.settleForwardLearningIssue(
    "new_macau",
    draw(),
    "2026-08-18T22:11:00+08:00",
  );
  assert.equal(first.status, "settled");
  assert.equal(second.status, "existing");
  assert.equal(first.scores.filter((score) => score.official).length, 5);
  assert.equal(db.scores.size, 5);
});

test("settlement retry repairs a partially written candidate score batch", async () => {
  const forecasts = fiveForecasts();
  await store.freezeForwardLearningIssue(
    forecasts.map((item) => item as ForwardLearningCandidate),
    forecasts,
  );
  await store.settleForwardLearningIssue(
    "new_macau",
    draw(),
    "2026-08-18T22:10:00+08:00",
  );
  const first = [...db.scores.entries()][0];
  db.scores.clear();
  db.scores.set(first[0], first[1]);
  const repaired = await store.settleForwardLearningIssue(
    "new_macau",
    draw(),
    "2026-08-18T22:11:00+08:00",
  );
  assert.equal(repaired.status, "settled");
  assert.equal(repaired.scores.length, 5);
  assert.equal(db.scores.size, 5);
});

function fiveForecasts(): ForwardLearningForecast[] {
  const slots = [
    ["coverage_zodiac", "猴", ["猴"]],
    ["coverage_tail", "1尾", ["1尾"]],
    ["coverage_zodiac_pair", "猴+鸡", ["猴", "鸡"]],
    ["coverage_zodiac_triple", "猴+鸡+狗", ["猴", "鸡", "狗"]],
    ["special_number", "01", ["01"]],
  ] as const;
  return slots.map(([slot, label, values]) => ({
    candidateId: `candidate:${slot}`,
    forecastId: `forecast:${slot}`,
    game: "new_macau",
    targetIssue: "2026230",
    slot,
    resultKey: label,
    label: label.replaceAll("+", "＋"),
    values: [...values],
    baselineProbability: slot === "special_number" ? 1 / 49 : 0.4,
    expertProbabilities: { baseline: 0.4, rules30: 0.5, forward: 0.4 },
    expertWeights: { baseline: 0.34, rules30: 0.33, forward: 0.33 },
    finalProbability: slot === "special_number" ? 0.03 : 0.45,
    netOdds: 1,
    rawRuleCount: 1,
    evidenceClusterCount: 1,
    ruleContributions: [],
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardBrierSkill: 0,
    frozenAt: "2026-08-18T20:00:00+08:00",
    modelVersion: "m1",
    dataVersion: "fixture",
    official: true,
    rank: 1,
    previousResultKey: null,
    previousProbability: null,
    probabilityDelta: null,
    topAlternative: null,
    explanation: ["fixture"],
  }));
}

function draw(): Draw {
  return {
    game: "new_macau",
    issue: "2026230",
    drawAt: "2026-08-18T21:32:00+08:00",
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "fixture",
    verified: true,
  };
}
