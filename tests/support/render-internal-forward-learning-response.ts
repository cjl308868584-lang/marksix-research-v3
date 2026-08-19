import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { createServer } from "vite";
import { NextRequest } from "next/server.js";

class SqliteD1Statement {
  private values: SQLInputValue[] = [];
  private readonly statement: StatementSync;

  constructor(statement: StatementSync) {
    this.statement = statement;
  }

  bind(...values: SQLInputValue[]) {
    this.values = values;
    return this;
  }

  async run() {
    const result = this.statement.run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }

  async first<T>() {
    return (this.statement.get(...this.values) ?? null) as T | null;
  }

  async all<T>() {
    return { results: this.statement.all(...this.values) as T[] };
  }
}

class SqliteD1 {
  readonly database = new DatabaseSync(":memory:");

  prepare(sql: string) {
    return new SqliteD1Statement(this.database.prepare(sql));
  }

  async batch(statements: SqliteD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

const runtime = globalThis as typeof globalThis & {
  __marksixBindings?: Record<string, unknown>;
  __marksixD1?: unknown;
  __marksixResearchV3SchemaReady?: Promise<void>;
  __marksixForwardLearningSchemaReady?: Promise<void>;
  __marksixForwardLearningV2SchemaReady?: Promise<void>;
};
const database = new SqliteD1();
const originalFetch = globalThis.fetch;
const scenario = process.argv[2] === "transition"
  ? "transition"
  : process.argv[2] === "transition-blocked"
    ? "transition-blocked"
    : "fresh";
const game = scenario === "fresh" ? "hk" : "new_macau";
runtime.__marksixBindings = { RESEARCH_INGEST_SECRET: "contract-secret" };
runtime.__marksixD1 = database;
globalThis.fetch = async () => {
  throw new Error("contract fixture forces the checked fallback history");
};

const server = await createServer({
  root: process.cwd(),
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});

try {
  const researchStore = await server.ssrLoadModule("/lib/research-v3-store.ts") as {
    ensureResearchV3Store(): Promise<boolean>;
  };
  await researchStore.ensureResearchV3Store();
  await applyMigration("../../drizzle/0010_forward_learning.sql");
  await applyMigration("../../drizzle/0011_unified_forward_learning.sql");
  const run = seedImmutablePatternRun(game, scenario === "transition-blocked");
  if (scenario !== "fresh") {
    const engine = await server.ssrLoadModule("/lib/forward-learning-engine.ts") as {
      buildForwardLearningCandidates(run: unknown): unknown[];
      selectOfficialForecasts(candidates: readonly unknown[]): unknown[];
    };
    const store = await server.ssrLoadModule("/lib/forward-learning-store.ts") as {
      freezeForwardLearningIssue(
        candidates: readonly unknown[],
        forecasts: readonly unknown[],
      ): Promise<string>;
    };
    const candidates = engine.buildForwardLearningCandidates(run);
    const forecasts = engine.selectOfficialForecasts(candidates);
    const status = await store.freezeForwardLearningIssue(candidates, forecasts);
    if (status !== "created") throw new Error(`failed to seed v1 transition: ${status}`);
  }

  const route = await server.ssrLoadModule(
    "/app/api/internal/learning/settle-and-freeze/route.ts",
  ) as { POST(request: NextRequest): Promise<Response> };
  const body = JSON.stringify({
    taskId: `contract:${game}:2099001`,
    game,
    asOf: "2026-08-19T12:30:00.000Z",
  });
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", "contract-secret")
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const response = await route.POST(new NextRequest(
    "http://localhost/api/internal/learning/settle-and-freeze",
    {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-research-timestamp": timestamp,
        "x-research-signature": signature,
      },
    },
  ));
  const payload = await response.json();
  const expectedStatus = scenario === "transition-blocked" ? 425 : 200;
  if (response.status !== expectedStatus) {
    throw new Error(`internal route returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  process.stdout.write(JSON.stringify({ ...payload, _httpStatus: response.status }));
} finally {
  await server.close();
  database.database.close();
  globalThis.fetch = originalFetch;
  delete runtime.__marksixBindings;
  delete runtime.__marksixD1;
  delete runtime.__marksixResearchV3SchemaReady;
  delete runtime.__marksixForwardLearningSchemaReady;
  delete runtime.__marksixForwardLearningV2SchemaReady;
}

async function applyMigration(relativePath: string) {
  const migration = await readFile(new URL(relativePath, import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) database.database.exec(statement);
  }
}

function seedImmutablePatternRun(
  game: "hk" | "new_macau",
  blockedTransition = false,
) {
  const targetIssue = "2099001";
  const frozenAt = "2026-08-19T12:00:00.000Z";
  const run = {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: `pattern:${game}:2099001:contract`,
    game,
    sourceIssue: "2099000",
    targetIssue,
    expectedDrawAt: blockedTransition
      ? "2026-08-19T13:32:00.000Z"
      : "2099-08-20T13:30:00.000Z",
    generatedAt: frozenAt,
    frozenAt,
    status: "completed",
    window: {
      game,
      drawCount: 30,
      oldestIssue: "2098971",
      newestIssue: "2099000",
      dataHash: "contract-window-data-hash",
    },
    funnel: {
      generated: 0,
      currentTriggered: 0,
      deduplicated: 0,
      aboveBaseline: 0,
      qualified: 0,
    },
    scopeFunnels: {
      coverage_6_plus_1: {
        generated: 0,
        currentTriggered: 0,
        deduplicated: 0,
        aboveBaseline: 0,
        qualified: 0,
      },
      special: {
        generated: 0,
        currentTriggered: 0,
        deduplicated: 0,
        aboveBaseline: 0,
        qualified: 0,
      },
    },
    signals: [],
  };
  database.database.prepare(
    `INSERT INTO rolling_pattern_runs (
       run_id, game, source_issue, target_issue, window_oldest_issue,
       window_newest_issue, window_data_hash, engine_version, status,
       generated_at, frozen_at, run_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
  ).run(
    run.runId,
    run.game,
    run.sourceIssue,
    run.targetIssue,
    run.window.oldestIssue,
    run.window.newestIssue,
    run.window.dataHash,
    run.engineVersion,
    run.generatedAt,
    run.frozenAt,
    JSON.stringify({ ...run, signals: [] }),
  );
  database.database.prepare(
    `INSERT INTO research_v3_forecasts (
       run_id, game, target_issue, expected_draw_at, generated_at,
       dataset_version, engine_version, model_version, mode,
       snapshot_json, frozen_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `research:${game}:2099001:contract`,
    game,
    targetIssue,
    run.expectedDrawAt,
    frozenAt,
    run.window.dataHash,
    "research-v3",
    "research-v3",
    "contract",
    "{}",
    frozenAt,
  );
  return run;
}
