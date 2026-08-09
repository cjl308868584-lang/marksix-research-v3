import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery";
import type {
  RollingPatternEnvelope,
  RollingPatternRun,
} from "../lib/rolling-pattern-types";

type RunRow = {
  run_id: string;
  game: string;
  target_issue: string;
  run_json: string;
};

class FakePatternD1 {
  runs = new Map<string, RunRow>();
  signals = new Map<string, { run_id: string; rule_id: string; signal_json: string }>();
  scores = new Map<string, { run_id: string; rule_id: string; score_json: string }>();
  currentTargets = new Map<string, string>();

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
            run_json: String(values[11]),
          });
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
        return { meta: { changes: 0 } };
      },
      first: async <T>() => {
        if (sql.includes("FROM research_v3_forecasts")) {
          const target_issue = this.currentTargets.get(String(values[0]));
          return (target_issue ? { target_issue } : null) as T | null;
        }
        if (sql.includes("FROM rolling_pattern_runs")) {
          const row = [...this.runs.values()].find(
            (item) => item.game === String(values[0]) &&
              item.target_issue === String(values[1]),
          );
          return (row ?? null) as T | null;
        }
        return null;
      },
      all: async <T>() => {
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
};

let server: ViteDevServer;
let store: StoreModule;
let runFixture: RollingPatternRun;
let db: FakePatternD1;
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

test("current reads never fall back to a previous target issue", async () => {
  await store.persistRollingPatternRun(runFixture);
  db.currentTargets.set("new_macau", "2026032");
  assert.equal(await store.readRollingPatternRun("new_macau"), null);
  assert.equal(
    (await store.readRollingPatternRun("new_macau", "2026031"))?.run.targetIssue,
    "2026031",
  );
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
  assert.equal(
    await store.settleRollingPatternRuns("new_macau", [actual], "2026-01-31T13:41:00Z"),
    "ok",
  );
  assert.equal(db.scores.size, runFixture.signals.length);
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
