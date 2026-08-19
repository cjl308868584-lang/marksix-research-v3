import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";

type TaskRow = {
  game: string;
  request_hash: string;
  status: string;
  response_json: string | null;
  error_message: string | null;
};

class FakeTaskD1 {
  tasks = new Map<string, TaskRow>();

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO research_task_runs")) {
          const taskId = String(values[0]);
          if (this.tasks.has(taskId)) return { meta: { changes: 0 } };
          this.tasks.set(taskId, {
            game: String(values[1]),
            request_hash: String(values[2]),
            status: "processing",
            response_json: null,
            error_message: null,
          });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'completed'")) {
          const taskId = String(values[2]);
          const row = this.tasks.get(taskId);
          if (!row || row.status !== "processing") return { meta: { changes: 0 } };
          row.status = "completed";
          row.response_json = String(values[0]);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'failed'")) {
          const taskId = String(values[2]);
          const row = this.tasks.get(taskId);
          if (!row || row.status !== "processing") return { meta: { changes: 0 } };
          row.status = "failed";
          row.error_message = String(values[0]);
          return { meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'processing'") && sql.includes("status = 'failed'")) {
          const taskId = String(values[1]);
          const row = this.tasks.get(taskId);
          if (!row || row.status !== "failed") return { meta: { changes: 0 } };
          row.status = "processing";
          row.response_json = null;
          row.error_message = null;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
      first: async () => {
        if (!sql.includes("FROM research_task_runs")) return null;
        const row = this.tasks.get(String(values[0]));
        return row ? { ...row } : null;
      },
      all: async () => ({ results: [] }),
    };
    return statement;
  }
}

let server: ViteDevServer;
type Claim =
  | { status: "claimed" | "processing" | "conflict" | "unavailable" }
  | { status: "existing"; response: unknown };
type StoreModule = {
  ensureResearchV3Store(): Promise<boolean>;
  isResearchV3Snapshot(value: unknown): boolean;
  claimResearchTask(input: {
    taskId: string;
    game: "new_macau";
    requestHash: string;
    startedAt: string;
  }): Promise<Claim>;
  completeResearchTask(
    taskId: string,
    response: unknown,
    completedAt: string,
  ): Promise<boolean>;
  evaluateChampionEvidence(rows: Array<{
    target_issue: string;
    model_id: "baseline" | "interpretable_rules" | "logistic" | "black_box";
    probability: number;
    status: string;
    actual_matched: number;
  }>): {
    champion: string;
    formalChampion: string | null;
    sampleIssues: number;
    confidenceLowerBound: number;
    randomChampionPercentile: number;
  };
};
let store: StoreModule;
const testRuntime = globalThis as typeof globalThis & {
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
  store = await server.ssrLoadModule("/lib/research-v3-store.ts") as StoreModule;
});

after(async () => {
  delete testRuntime.__marksixD1;
  delete testRuntime.__marksixResearchV3SchemaReady;
  await server.close();
});

test("snapshot reader accepts frozen v3.0 ledgers but rejects unknown future engines", () => {
  const snapshot = {
    schemaVersion: "3",
    engineVersion: "high-probability-events-v3.0",
    modelVersion: "champion-challenger-v3.0-deadbeef",
    runId: "legacy_run",
    game: "new_macau",
    targetIssue: "2026218",
    events: Array.from({ length: 4 }, (_, index) => ({
      eventId: `legacy_${index}`,
      probability: 0.5,
      baselineProbability: 0.5,
    })),
  };
  assert.equal(store.isResearchV3Snapshot(snapshot), true);
  assert.equal(store.isResearchV3Snapshot({
    ...snapshot,
    engineVersion: "high-probability-events-v4.0",
    modelVersion: "champion-challenger-v4.0-deadbeef",
  }), false);
});

test("a warm research database does not replay schema DDL in a fresh isolate", async () => {
  const prepared: string[] = [];
  testRuntime.__marksixD1 = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        first: async () => ({ present: 48 }),
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
  };
  delete testRuntime.__marksixResearchV3SchemaReady;
  assert.equal(await store.ensureResearchV3Store(), true);
  assert.equal(prepared.filter((sql) => /^CREATE\s/im.test(sql)).length, 0);
});

test("a research database missing one index replays idempotent schema repair", async () => {
  const prepared: string[] = [];
  testRuntime.__marksixD1 = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        bind: () => this,
        first: async () => ({ present: 47 }),
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
  };
  delete testRuntime.__marksixResearchV3SchemaReady;
  assert.equal(await store.ensureResearchV3Store(), true);
  assert.ok(prepared.some((sql) => /^CREATE UNIQUE INDEX\s/im.test(sql)));
});

test("concurrent task claims allow exactly one learner and restore the immutable result", async () => {
  const db = new FakeTaskD1();
  testRuntime.__marksixD1 = db;
  delete testRuntime.__marksixResearchV3SchemaReady;
  const input = {
    taskId: "scheduled-new_macau-2026213-abc",
    game: "new_macau" as const,
    requestHash: "same-request",
    startedAt: "2026-08-01T14:00:00.000Z",
  };
  const claims = await Promise.all([
    store.claimResearchTask(input),
    store.claimResearchTask(input),
  ]);
  assert.deepEqual(
    claims.map((claim) => claim.status).sort(),
    ["claimed", "processing"],
  );

  const response = { status: "completed", runId: "run-1", immutable: true };
  assert.equal(
    await store.completeResearchTask(input.taskId, response, "2026-08-01T14:01:00.000Z"),
    true,
  );
  const replay = await store.claimResearchTask({
    ...input,
    startedAt: "2026-08-01T14:02:00.000Z",
  });
  assert.equal(replay.status, "existing");
  assert.deepEqual(replay.response, response);

  const conflict = await store.claimResearchTask({
    ...input,
    requestHash: "different-request",
  });
  assert.equal(conflict.status, "conflict");
});

test("champion evidence counts independent issues rather than four correlated slots", () => {
  const rows = championRows(20);
  const evidence = store.evaluateChampionEvidence(rows);
  assert.equal(evidence.sampleIssues, 20);
  assert.equal(evidence.champion, "baseline");
  assert.equal(evidence.formalChampion, null);
});

test("a challenger is verified only after issue-level confidence and random gates pass", () => {
  const evidence = store.evaluateChampionEvidence(championRows(50));
  assert.equal(evidence.sampleIssues, 50);
  assert.equal(evidence.champion, "logistic");
  assert.equal(evidence.formalChampion, "logistic");
  assert.ok(evidence.confidenceLowerBound > 0);
  assert.ok(evidence.randomChampionPercentile >= 0.99);
});

function championRows(issueCount: number) {
  return Array.from({ length: issueCount }, (_, issueIndex) =>
    Array.from({ length: 4 }, (__, slotIndex) => {
      const actual = (issueIndex + slotIndex) % 2;
      return ([
        {
          target_issue: String(2026001 + issueIndex),
          model_id: "baseline" as const,
          probability: 0.5,
          status: "active",
          actual_matched: actual,
        },
        {
          target_issue: String(2026001 + issueIndex),
          model_id: "interpretable_rules" as const,
          probability: 0.5,
          status: "active",
          actual_matched: actual,
        },
        {
          target_issue: String(2026001 + issueIndex),
          model_id: "logistic" as const,
          probability: actual ? 0.6 : 0.4,
          status: "shadow",
          actual_matched: actual,
        },
      ]);
    }).flat()
  ).flat();
}
