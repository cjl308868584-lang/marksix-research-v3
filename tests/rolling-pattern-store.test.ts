import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery";
import type {
  RollingPatternEnvelope,
  RollingPatternProduct,
  RollingPatternProductScore,
  RollingPatternRun,
} from "../lib/rolling-pattern-types";

type RunRow = {
  run_id: string;
  game: string;
  target_issue: string;
  engine_version: string;
  frozen_at: string;
  status: string;
  run_json: string;
};

class FakePatternD1 {
  runs = new Map<string, RunRow>();
  signals = new Map<string, { run_id: string; rule_id: string; signal_json: string }>();
  scores = new Map<string, { run_id: string; rule_id: string; score_json: string }>();
  products = new Map<string, { run_id: string; product_id: string; product_json: string }>();
  productScores = new Map<string, { run_id: string; product_id: string; score_json: string }>();
  currentTargets = new Map<string, string>();
  batchSizes: number[] = [];

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO rolling_pattern_runs")) {
          const runId = String(values[0]);
          if (this.runs.has(runId)) return { meta: { changes: 0 } };
          this.runs.set(runId, {
            run_id: runId,
            game: String(values[1]),
            target_issue: String(values[3]),
            engine_version: String(values[7]),
            frozen_at: String(values[10]),
            status: String(values[8]),
            run_json: String(values[11]),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE rolling_pattern_runs SET status = 'completed'")) {
          const row = this.runs.get(String(values[0]));
          if (!row || row.engine_version !== String(values[1])) {
            return { meta: { changes: 0 } };
          }
          row.status = "completed";
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO rolling_pattern_signals")) {
          const key = `${values[0]}:${values[1]}`;
          if (this.signals.has(key)) return { meta: { changes: 0 } };
          this.signals.set(key, {
            run_id: String(values[0]),
            rule_id: String(values[1]),
            signal_json: String(values[8]),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO rolling_pattern_scores")) {
          const key = `${values[0]}:${values[1]}`;
          if (this.scores.has(key)) return { meta: { changes: 0 } };
          this.scores.set(key, {
            run_id: String(values[0]),
            rule_id: String(values[1]),
            score_json: String(values[5]),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO rolling_pattern_consensus_ledger")) {
          const key = `${values[0]}:${values[1]}`;
          if (this.products.has(key)) return { meta: { changes: 0 } };
          this.products.set(key, {
            run_id: String(values[0]),
            product_id: String(values[1]),
            product_json: String(values[8]),
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO rolling_pattern_consensus_scores")) {
          const key = `${values[0]}:${values[1]}`;
          if (this.productScores.has(key)) return { meta: { changes: 0 } };
          this.productScores.set(key, {
            run_id: String(values[0]),
            product_id: String(values[1]),
            score_json: String(values[9]),
          });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      first: async <T>() => {
        if (sql.includes("FROM research_v3_forecasts")) {
          const target_issue = this.currentTargets.get(String(values[0]));
          return (target_issue ? { target_issue } : null) as T | null;
        }
        if (sql.includes("FROM rolling_pattern_runs")) {
          const requestedEngine = sql.includes("engine_version = ?")
            ? String(values[2])
            : null;
          const row = [...this.runs.values()].filter(
            (item) => item.game === String(values[0]) &&
              item.target_issue === String(values[1]) &&
              (!requestedEngine || item.engine_version === requestedEngine),
          ).filter(
            (item) => !sql.includes("status = 'completed'") ||
              item.status === "completed",
          ).sort((left, right) => left.frozen_at.localeCompare(right.frozen_at))[0];
          return (row ?? null) as T | null;
        }
        return null;
      },
      all: async <T>() => {
        if (sql.includes("CAST(l.target_issue AS INTEGER) < CAST(? AS INTEGER)")) {
          const game = String(values[0]);
          const cutoff = Number(values[1]);
          return {
            results: [...this.products.values()].flatMap((row) => {
              const product = JSON.parse(row.product_json) as RollingPatternProduct;
              const score = this.productScores.get(`${row.run_id}:${row.product_id}`);
              return product.game === game && Number(product.targetIssue) < cutoff && score
                ? [{ product_json: row.product_json, score_json: score.score_json } as T]
                : [];
            }),
          };
        }
        if (sql.includes("FROM rolling_pattern_signals")) {
          return {
            results: [...this.signals.values()].filter(
              (row) => row.run_id === String(values[0]),
            ) as T[],
          };
        }
        if (sql.includes("FROM rolling_pattern_scores")) {
          return {
            results: [...this.scores.values()].filter(
              (row) => row.run_id === String(values[0]),
            ) as T[],
          };
        }
        if (sql.includes("FROM rolling_pattern_consensus_ledger")) {
          return {
            results: [...this.products.values()].filter(
              (row) => row.run_id === String(values[0]),
            ) as T[],
          };
        }
        if (sql.includes("FROM rolling_pattern_consensus_scores")) {
          return {
            results: [...this.productScores.values()].filter(
              (row) => row.run_id === String(values[0]),
            ) as T[],
          };
        }
        if (sql.includes("FROM rolling_pattern_runs")) {
          return {
            results: [...this.runs.values()].filter(
              (row) => row.game === String(values[0]) &&
                row.target_issue === String(values[1]),
            ) as T[],
          };
        }
        return { results: [] as T[] };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    this.batchSizes.push(statements.length);
    if (statements.length > 100) throw new Error("D1 batch limit exceeded");
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

type StoreModule = {
  persistRollingPatternRun(run: RollingPatternRun): Promise<string>;
  readRollingPatternRun(
    game: "new_macau",
    issue?: string,
  ): Promise<RollingPatternEnvelope | null>;
  settleRollingPatternRuns(
    game: "new_macau",
    draws: Draw[],
    settledAt: string,
  ): Promise<string>;
  readRollingPatternValueLedger(
    game: "new_macau",
    issue?: string,
  ): Promise<{ products: RollingPatternProduct[]; scores: RollingPatternProductScore[] } | null>;
  readBoundedLegacyProductHistory(
    game: "new_macau",
    beforeIssue: string,
  ): Promise<{
    legacy: Map<string, { settledCount: number; hitCount: number }>;
    legacyProductIds: Map<string, string>;
  }>;
};

let server: ViteDevServer;
let store: StoreModule;
let runFixture: RollingPatternRun;
let db: FakePatternD1;
let runRollingPatternCycle: (
  input: {
    game: "new_macau";
    draws: Draw[];
    targetIssue: string;
    expectedDrawAt: string;
    generatedAt: string;
  },
  dependencies: {
    settle: () => Promise<"ok">;
    build: () => Promise<RollingPatternRun>;
    persist: () => Promise<"created">;
  },
) => Promise<{ status: string; runId?: string }>;
let requireRollingPatternTaskSuccess: (
  result: { status: string; reason?: string } | undefined,
) => void;
const runtime = globalThis as typeof globalThis & {
  __marksixD1?: unknown;
  __marksixResearchV3SchemaReady?: unknown;
};

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  store = await server.ssrLoadModule("/lib/rolling-pattern-store.ts") as StoreModule;
  const engine = await server.ssrLoadModule("/lib/rolling-pattern-engine.ts");
  const service = await server.ssrLoadModule("/lib/rolling-pattern-service.ts");
  runRollingPatternCycle = service.runRollingPatternCycle;
  requireRollingPatternTaskSuccess = service.requireRollingPatternTaskSuccess;
  runFixture = await engine.buildRollingPatternRun({
    game: "new_macau",
    draws: patternDraws(),
    targetIssue: "2026031",
    expectedDrawAt: "2026-01-31T21:32:00+08:00",
    generatedAt: "2026-01-30T13:40:00.000Z",
  });
  assert.ok(runFixture.signals.length > 0);
});

beforeEach(() => {
  db = new FakePatternD1();
  db.currentTargets.set("new_macau", runFixture.targetIssue);
  runtime.__marksixD1 = db;
  delete runtime.__marksixResearchV3SchemaReady;
});

after(async () => {
  delete runtime.__marksixD1;
  delete runtime.__marksixResearchV3SchemaReady;
  await server.close();
});

test("replaying one run id restores the immutable result without duplicate signals", async () => {
  assert.equal(await store.persistRollingPatternRun(runFixture), "created");
  assert.equal(await store.persistRollingPatternRun(runFixture), "existing");
  assert.equal(db.runs.size, 1);
  assert.equal(db.signals.size, runFixture.signals.length);

  const restored = await store.readRollingPatternRun("new_macau");
  assert.equal(restored?.run.runId, runFixture.runId);
  assert.equal(restored?.signals.length, runFixture.signals.length);
});

test("legacy seed aggregation excludes the rollout target and later rows", async () => {
  const before = legacyProductFixture("legacy-before", "2026230", true);
  const cutoff = legacyProductFixture("legacy-cutoff", "2026231", false);
  db.products.set(`${before.runId}:${before.productId}`, {
    run_id: before.runId,
    product_id: before.productId,
    product_json: JSON.stringify(before),
  });
  db.products.set(`${cutoff.runId}:${cutoff.productId}`, {
    run_id: cutoff.runId,
    product_id: cutoff.productId,
    product_json: JSON.stringify(cutoff),
  });
  for (const product of [before, cutoff]) {
    db.productScores.set(`${product.runId}:${product.productId}`, {
      run_id: product.runId,
      product_id: product.productId,
      score_json: JSON.stringify({
        runId: product.runId,
        productId: product.productId,
        game: product.game,
        targetIssue: product.targetIssue,
        actualMatched: product.runId === "legacy-before",
        unitProfit: product.runId === "legacy-before" ? 1 : -1,
        actualNumbers: [1, 2, 3, 4, 5, 6, 7],
        actualSpecial: 7,
        scoredAt: "2026-08-19T14:00:00.000Z",
      }),
    });
  }

  const history = await store.readBoundedLegacyProductHistory("new_macau", "2026231");

  assert.deepEqual(history.legacy.get("coverage_zodiac:猴"), {
    settledCount: 1,
    hitCount: 1,
  });
  assert.equal(history.legacyProductIds.get("coverage_zodiac:猴"), before.productId);
});

test("freezes result-level value products and repairs missing ledger children idempotently", async () => {
  assert.equal(await store.persistRollingPatternRun(runFixture), "created");
  const count = db.products.size;
  assert.ok(count > 0);
  assert.equal(await store.persistRollingPatternRun(runFixture), "existing");
  assert.equal(db.products.size, count);
  const missing = [...db.products.keys()][0];
  db.products.delete(missing);
  assert.equal(await store.persistRollingPatternRun(runFixture), "existing");
  assert.equal(db.products.size, count);

  const ledger = await store.readRollingPatternValueLedger("new_macau", runFixture.targetIssue);
  assert.equal(ledger?.products.length, count);
  assert.equal(ledger?.scores.length, 0);
});

test("large conditional runs are persisted in bounded, retry-safe D1 batches", async () => {
  const seed = runFixture.signals[0];
  assert.ok(seed);
  const largeRun: RollingPatternRun = {
    ...runFixture,
    runId: `${runFixture.runId}_large`,
    signals: Array.from({ length: 205 }, (_, index) => ({
      ...seed,
      rule: {
        ...seed.rule,
        ruleId: `large-rule-${index}`,
      },
    })),
  };
  assert.equal(await store.persistRollingPatternRun(largeRun), "created");
  assert.equal(db.signals.size, 205);
  assert.ok(db.batchSizes.every((size) => size <= 100));

  // Replaying an existing run must refill any missing signal rows instead of
  // returning before the immutable child ledger has been repaired.
  db.signals.delete(`${largeRun.runId}:large-rule-204`);
  assert.equal(await store.persistRollingPatternRun(largeRun), "existing");
  assert.equal(db.signals.size, 205);
});

test("current reads never fall back to a previous target issue", async () => {
  await store.persistRollingPatternRun(runFixture);
  db.currentTargets.set("new_macau", "2026032");
  assert.equal(await store.readRollingPatternRun("new_macau"), null);
  assert.equal(
    (await store.readRollingPatternRun("new_macau", "2026031"))?.run.targetIssue,
    "2026031",
  );
});

test("current reads ignore a frozen v1 heat-like run for the same target", async () => {
  const legacy = {
    ...runFixture,
    schemaVersion: "rolling-patterns-1",
    engineVersion: "rolling-patterns-v1",
    runId: `legacy_${runFixture.runId}`,
    frozenAt: "2026-01-30T12:00:00.000Z",
  } as unknown as RollingPatternRun;
  assert.equal(await store.persistRollingPatternRun(legacy), "created");
  assert.equal(await store.persistRollingPatternRun(runFixture), "created");

  const restored = await store.readRollingPatternRun("new_macau");
  assert.equal(restored?.run.engineVersion, runFixture.engineVersion);
  assert.equal(restored?.run.runId, runFixture.runId);
});

test("settlement scores only the previously frozen verified target and is idempotent", async () => {
  await store.persistRollingPatternRun(runFixture);
  const actual: Draw = {
    game: "new_macau",
    issue: runFixture.targetIssue,
    drawAt: runFixture.expectedDrawAt,
    numbers: [10, 1, 2, 3, 4, 5],
    special: 6,
    source: "双源一致测试",
    verified: true,
  };
  assert.equal(
    await store.settleRollingPatternRuns("new_macau", [actual], "2026-01-31T13:40:00Z"),
    "ok",
  );
  assert.equal(db.scores.size, runFixture.signals.length);
  assert.equal(db.productScores.size, db.products.size);
  assert.equal(
    await store.settleRollingPatternRuns("new_macau", [actual], "2026-01-31T13:41:00Z"),
    "ok",
  );
  assert.equal(db.scores.size, runFixture.signals.length);
  assert.equal(db.productScores.size, db.products.size);
});

test("rolling lifecycle settles the old target before building and freezing the next window", async () => {
  const calls: string[] = [];
  const result = await runRollingPatternCycle(
    {
      game: "new_macau",
      draws: patternDraws(),
      targetIssue: runFixture.targetIssue,
      expectedDrawAt: runFixture.expectedDrawAt,
      generatedAt: runFixture.generatedAt,
    },
    {
      settle: async () => {
        calls.push("settle");
        return "ok";
      },
      build: async () => {
        calls.push("build");
        return runFixture;
      },
      persist: async () => {
        calls.push("persist");
        return "created";
      },
    },
  );
  assert.deepEqual(calls, ["settle", "build", "persist"]);
  assert.deepEqual(result, {
    status: "created",
    runId: runFixture.runId,
    qualified: runFixture.signals.length,
  });
});

test("a failed auxiliary pattern freeze keeps the signed task retryable", () => {
  assert.throws(
    () => requireRollingPatternTaskSuccess({
      status: "failed",
      reason: "rolling pattern freeze unavailable",
    }),
    /rolling pattern freeze unavailable/,
  );
  assert.doesNotThrow(() => requireRollingPatternTaskSuccess({
    status: "created",
  }));
});

function patternDraws() {
  const states = [
    true, false, false, false, true,
    true, false, false, false, false,
    true, false, false, false, true,
    true, false, true, false, true,
    false, true, false, true, false,
    true, true, false, false, false,
  ];
  return states.map((matched, index) => ({
    game: "new_macau" as const,
    issue: String(2026001 + index),
    drawAt: `2026-01-${String(index + 1).padStart(2, "0")}T21:32:00+08:00`,
    numbers: matched ? [10, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6],
    special: matched ? 6 : 7,
    source: "双源一致测试",
    verified: true,
  })).reverse();
}

function legacyProductFixture(
  runId: string,
  targetIssue: string,
  matched: boolean,
): RollingPatternProduct {
  return {
    runId,
    productId: `${runId}:coverage_zodiac:猴`,
    dataVersion: `${runId}-data`,
    game: "new_macau",
    targetIssue,
    scope: "coverage_6_plus_1",
    kind: "coverage_zodiac",
    label: "猴",
    values: ["猴"],
    evidenceEventIds: [],
    strategyCount: 0,
    support: 0,
    hits: 0,
    misses: 0,
    baselineProbability: 0.47,
    patternProbability: 0.47,
    legacySeedProbability: 0.47,
    estimatedProbability: 0.47,
    netOdds: 1,
    breakEvenProbability: 0.5,
    expectedValue: -0.06,
    valueStatus: "negative",
    legacySettledCount: 0,
    legacyHitCount: 0,
    learningSettledCount: 0,
    learningHitCount: 0,
    learningMissCount: 0,
    sourceKind: "derived_baseline",
    sourceProductId: null,
    derivedDefinitionHash: "fixture-definition",
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardMissCount: 0,
    rank: matched ? 1 : 2,
    frozenAt: "2026-08-18T12:00:00.000Z",
  };
}
