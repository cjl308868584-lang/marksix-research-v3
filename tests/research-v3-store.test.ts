import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import test, { after, before } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";

type TaskRow = {
  game: string;
  request_hash: string;
  status: string;
  response_json: string | null;
  error_message: string | null;
};

type ForecastRow = {
  run_id: string;
  game: string;
  target_issue: string;
  expected_draw_at: string;
  engine_version: string;
  snapshot_json: string;
  frozen_at: string;
  review_json: string | null;
  settled_at: string | null;
};

type ChampionRow = ReturnType<typeof championRows>[number] & {
  run_id: string;
  engine_version: string;
};

type ModelWeightRow = {
  engine_version?: string;
  slot: string;
  model_id: "baseline" | "interpretable_rules" | "logistic" | "black_box";
  weight_after: number;
};

type RuleStateRow = {
  state_id?: string;
  engine_version?: string;
  slot: string;
  rule_id: string;
  triggers: number;
  hits: number;
  consecutive_hits: number;
  consecutive_misses: number;
  status: "active" | "suppressed" | "retired";
};

class SqliteD1Statement {
  private values: SQLInputValue[] = [];
  private readonly statement: StatementSync;
  constructor(statement: StatementSync) { this.statement = statement; }
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
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
  prepare(sql: string) { return new SqliteD1Statement(this.database.prepare(sql)); }
  async batch(statements: SqliteD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
  close() { this.database.close(); }
}

function sqliteCount(database: DatabaseSync, table: string) {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { count: number }
    | undefined;
  return Number(row?.count ?? 0);
}

class FakeTaskD1 {
  tasks = new Map<string, TaskRow>();
  forecasts = new Map<string, ForecastRow>();
  indexes = new Set<string>();
  championEvidence: ChampionRow[] = [];
  modelWeights: ModelWeightRow[] = [];
  ruleStates: RuleStateRow[] = [];
  promotedChampions: Array<{
    run_id: string;
    engine_version: string;
    champion_after: "baseline" | "interpretable_rules" | "logistic" | "black_box";
    completed_at: string;
  }> = [];
  schemaObjectCount = 0;

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      run: async () => {
        const createIndex = sql.match(
          /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+([a-zA-Z0-9_]+)/i,
        );
        if (createIndex) {
          this.indexes.add(createIndex[1]);
          this.schemaObjectCount += 1;
          return { meta: { changes: 0 } };
        }
        const dropIndex = sql.match(
          /^DROP INDEX IF EXISTS\s+([a-zA-Z0-9_]+)/i,
        );
        if (dropIndex) {
          this.indexes.delete(dropIndex[1]);
          return { meta: { changes: 0 } };
        }
        if (/^CREATE TABLE IF NOT EXISTS/i.test(sql)) {
          this.schemaObjectCount += 1;
          return { meta: { changes: 0 } };
        }
        if (sql.includes("INSERT OR IGNORE INTO research_v3_forecasts")) {
          const [
            runId,
            game,
            targetIssue,
            expectedDrawAt,
            ,
            ,
            engineVersion,
            ,
            ,
            snapshotJson,
            frozenAt,
          ] = values.map(String);
          const duplicateRun = this.forecasts.has(runId);
          const duplicateLegacyIdentity = this.indexes.has(
            "research_v3_forecast_identity_idx",
          ) && [...this.forecasts.values()].some((row) =>
            row.game === game && row.target_issue === targetIssue
          );
          const duplicateEngineIdentity = this.indexes.has(
            "research_v3_forecast_engine_identity_idx",
          ) && [...this.forecasts.values()].some((row) =>
            row.game === game && row.target_issue === targetIssue &&
            row.engine_version === engineVersion
          );
          if (duplicateRun || duplicateLegacyIdentity || duplicateEngineIdentity) {
            return { meta: { changes: 0 } };
          }
          this.forecasts.set(runId, {
            run_id: runId,
            game,
            target_issue: targetIssue,
            expected_draw_at: expectedDrawAt,
            engine_version: engineVersion,
            snapshot_json: snapshotJson,
            frozen_at: frozenAt,
            review_json: null,
            settled_at: null,
          });
          return { meta: { changes: 1 } };
        }
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
        if (sql.includes("FROM sqlite_master")) {
          return { present: this.schemaObjectCount };
        }
        if (sql.includes("FROM research_v3_forecasts") && sql.includes("COUNT(*)")) {
          const rows = this.filteredForecasts(sql, values);
          return { count: rows.filter((row) => row.settled_at !== null).length };
        }
        if (sql.includes("FROM research_v3_forecasts")) {
          const rows = this.filteredForecasts(sql, values).sort((left, right) => {
            if (!sql.includes("expected_draw_at DESC")) {
              return left.frozen_at.localeCompare(right.frozen_at) ||
                left.run_id.localeCompare(right.run_id);
            }
            return right.expected_draw_at.localeCompare(left.expected_draw_at) ||
              left.frozen_at.localeCompare(right.frozen_at);
          });
          return rows[0] ? { ...rows[0] } : null;
        }
        if (sql.includes("FROM research_learning_runs")) {
          const engineVersion = sql.includes("engine_version = ?")
            ? String(values[1])
            : null;
          const rows = this.promotedChampions
            .filter((row) => !engineVersion || row.engine_version === engineVersion)
            .sort((left, right) => right.completed_at.localeCompare(left.completed_at));
          return rows[0] ? { champion_after: rows[0].champion_after } : null;
        }
        if (sql.includes("FROM research_task_runs")) {
          const row = this.tasks.get(String(values[0]));
          return row ? { ...row } : null;
        }
        return null;
      },
      all: async () => {
        if (sql.includes("FROM research_v3_forecasts")) {
          const limit = Number(values.at(-1));
          const rows = this.filteredForecasts(sql, values)
            .filter((row) => row.settled_at !== null && row.review_json !== null)
            .sort((left, right) =>
              right.expected_draw_at.localeCompare(left.expected_draw_at)
            )
            .slice(0, Number.isFinite(limit) ? limit : undefined);
          return {
            results: rows.map((row) => ({ review_json: row.review_json! })),
          };
        }
        if (sql.includes("FROM research_model_weights")) {
          if (!sql.includes("JOIN research_event_scores")) {
            const engineVersion = sql.includes("engine_version = ?")
              ? String(values[1])
              : null;
            return {
              results: this.modelWeights.filter((row) =>
                !engineVersion || row.engine_version === engineVersion
              ),
            };
          }
          const engineVersion = sql.includes("engine_version = ?")
            ? String(values[1])
            : null;
          return {
            results: this.championEvidence
              .filter((row) => !engineVersion || row.engine_version === engineVersion)
              .map(({ run_id: _runId, engine_version: _engineVersion, ...row }) => row),
          };
        }
        if (sql.includes("FROM research_rule_states")) {
          const engineVersion = sql.includes("engine_version = ?")
            ? String(values[1])
            : null;
          return {
            results: this.ruleStates.filter((row) =>
              !engineVersion || row.engine_version === engineVersion
            ),
          };
        }
        return { results: [] };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  private filteredForecasts(sql: string, values: unknown[]) {
    const game = String(values[0]);
    const targetIssue = sql.includes("target_issue = ?") ? String(values[1]) : null;
    const engineVersion = sql.includes("engine_version = ?")
      ? String(values[targetIssue ? 2 : 1])
      : null;
    return [...this.forecasts.values()].filter((row) =>
      row.game === game &&
      (!targetIssue || row.target_issue === targetIssue) &&
      (!engineVersion || row.engine_version === engineVersion)
    );
  }
}

class FakeResearchD1 extends FakeTaskD1 {}

class FakeSettlementD1 {
  claimed = false;
  persistedReviewVersion: string | null = null;
  persistedReview: any = null;
  private readonly snapshot: any;
  private readonly priorEvidence: ReturnType<typeof championRows>;

  constructor(
    snapshot: any,
    priorEvidence: ReturnType<typeof championRows>,
  ) {
    this.snapshot = snapshot;
    this.priorEvidence = priorEvidence;
  }

  prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      first: async () => {
        if (sql.includes("FROM sqlite_master")) return { present: 52 };
        return null;
      },
      all: async () => {
        if (sql.includes("FROM research_rule_states")) {
          return { results: [] };
        }
        if (
          sql.includes("FROM research_v3_forecasts") &&
          sql.includes("settled_at IS NULL")
        ) {
          return {
            results: [{
              run_id: this.snapshot.runId,
              snapshot_json: JSON.stringify(this.snapshot),
              review_json: null,
              settled_at: null,
            }],
          };
        }
        if (sql.includes("FROM research_model_weights")) {
          return {
            results: values[1] === this.snapshot.engineVersion
              ? this.priorEvidence
              : [],
          };
        }
        return { results: [] };
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO research_settlement_claims")) {
          if (this.claimed) return { meta: { changes: 0 } };
          this.claimed = true;
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE research_v3_forecasts")) {
          this.persistedReviewVersion = String(values[1]);
          this.persistedReview = JSON.parse(String(values[2]));
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return statement;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

let server: ViteDevServer;
type Claim =
  | { status: "claimed" | "processing" | "conflict" | "unavailable" }
  | { status: "existing"; response: unknown };
type StoreModule = {
  ensureResearchV3Store(): Promise<boolean>;
  isResearchV3Snapshot(value: unknown): boolean;
  isCurrentResearchV3Snapshot(value: unknown): boolean;
  readResearchV3Snapshot(
    game: "new_macau",
    targetIssue?: string | null,
    scope?: "current" | "any",
  ): Promise<{ runId: string } | null>;
  persistResearchV3Snapshot(snapshot: any): Promise<
    "created" | "existing" | "unavailable" | "invalid"
  >;
  countSettledResearchV3Forecasts(game: "new_macau"): Promise<number>;
  readResearchV3Reviews(
    game: "new_macau",
    limit?: number,
    scope?: "current" | "all",
  ): Promise<any[]>;
  readResearchV3Performance(game: "new_macau"): Promise<{
    settledIssues: number;
    settledEvents: number;
    curve: Array<{ issue: string }>;
  }>;
  readLatestModelWeights(game: "new_macau"): Promise<Record<string, unknown>>;
  readResearchRuleStates(game: "new_macau"): Promise<Record<string, unknown>>;
  settleResearchV3Forecasts(
    game: "new_macau",
    draws: Array<{
      game: "new_macau";
      issue: string;
      drawAt: string;
      numbers: number[];
      special: number;
      source: string;
      verified: boolean;
    }>,
    settledAt?: string,
  ): Promise<"ok" | "unavailable">;
  readChampionChallengeState(game: "new_macau"): Promise<{
    champion: string;
    formalChampion: string | null;
    sampleIssues: number;
  }>;
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
type EngineModule = {
  buildResearchV3Snapshot(input: {
    game: "new_macau";
    draws: Array<{
      game: "new_macau";
      issue: string;
      drawAt: string;
      numbers: number[];
      special: number;
      source: string;
      verified: boolean;
    }>;
    targetIssue: string;
    expectedDrawAt: string;
    generatedAt: string;
    previousWeights?: Record<string, Record<string, number>>;
  }): unknown;
};
type ServiceModule = {
  runResearchV3Cycle(input: {
    game: "new_macau";
    asOf: Date;
    forceCompute?: boolean;
  }): Promise<{ snapshot: { runId: string }; cycleStatus: string }>;
  researchV3FreezeWindow(
    game: "new_macau",
    latest: { issue: string; drawAt: string },
    asOf: Date,
  ): { targetIssue: string; expectedDrawAt: string; canFreeze: boolean };
};
type ReviewUiModule = {
  IssuePicker(props: {
    reviews: any[];
    selectedRunId: string;
    onSelect: (runId: string) => void;
  }): unknown;
};
let store: StoreModule;
let engine: EngineModule;
let service: ServiceModule;
let reviewUi: ReviewUiModule;
let fallbackDraws: any[];
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
  engine = await server.ssrLoadModule("/lib/research-v3-engine.ts") as EngineModule;
  service = await server.ssrLoadModule("/lib/research-v3-service.ts") as ServiceModule;
  reviewUi = await server.ssrLoadModule(
    "/app/research/review/ResearchReviewWorkspace.tsx",
  ) as ReviewUiModule;
  const lottery = await server.ssrLoadModule("/lib/lottery.ts") as any;
  fallbackDraws = lottery.FALLBACK_DRAWS.new_macau;
});

after(async () => {
  delete testRuntime.__marksixD1;
  delete testRuntime.__marksixResearchV3SchemaReady;
  await server.close();
});

function snapshotFixture(input: {
  engineVersion: string;
  modelVersion: string;
  reviewVersion: string;
  slots: [string, string, string, string];
  runId?: string;
  targetIssue?: string;
  frozenAt?: string;
}) {
  const eventContract = (slot: string) => {
    if (slot === "zodiac_6_plus_1") {
      return { scope: "draw.6_plus_1", family: "zodiac", predictedValue: "猴" };
    }
    if (slot === "tail_6_plus_1") {
      return { scope: "draw.6_plus_1", family: "tail", predictedValue: "7尾" };
    }
    if (slot === "special_parity") {
      return { scope: "special", family: "parity", predictedValue: "单" };
    }
    if (slot === "special_size") {
      return { scope: "special", family: "size", predictedValue: "大" };
    }
    if (slot === "position_parity") {
      return { scope: "main.position.3", family: "parity", predictedValue: "单" };
    }
    return { scope: "main.position.4", family: "size", predictedValue: "大" };
  };
  return {
    schemaVersion: "3",
    engineVersion: input.engineVersion,
    modelVersion: input.modelVersion,
    reviewVersion: input.reviewVersion,
    runId: input.runId ?? "run_1",
    game: "new_macau",
    targetIssue: input.targetIssue ?? "2026218",
    expectedDrawAt: "2026-08-02T14:00:00.000Z",
    generatedAt: "2026-08-01T14:00:00.000Z",
    frozenAt: input.frozenAt ?? "2026-08-01T14:01:00.000Z",
    mode: "shadow",
    events: input.slots.map((slot, index) => ({
      eventId: `event_${index}`,
      slot,
      ...eventContract(slot),
      probability: 0.5,
      baselineProbability: 0.5,
    })),
    dataQuality: {
      sampleSize: 60,
      verifiedSampleSize: 60,
      verifiedRatio: 1,
      sourceMode: "live",
      oldestIssue: "2026158",
      newestIssue: "2026217",
      missingIssueCount: 0,
      conflictCount: 0,
      datasetVersion: "dataset-test",
      warnings: [],
    },
    learningSummary: {
      settledForecasts: 0,
      champion: "baseline",
      challenger: "logistic",
      baselineWeightFloor: 0.25,
      fastWindow: 40,
      mediumWindow: 120,
      message: "test fixture",
    },
    notice: "test fixture",
  };
}

function reviewFixture(input: {
  reviewVersion: "research-event-review-v3" | "research-event-review-v4";
  runId: string;
  targetIssue: string;
  settledAt: string;
  slots: [string, string, string, string];
}) {
  return {
    reviewVersion: input.reviewVersion,
    runId: input.runId,
    game: "new_macau",
    targetIssue: input.targetIssue,
    expectedDrawAt: input.settledAt,
    frozenAt: "2026-08-01T12:00:00.000Z",
    settledAt: input.settledAt,
    hits: 2,
    total: 4,
    expectedHits: 2,
    hitRate: 0.5,
    baselineHitRate: 0.5,
    brier: 0.2,
    baselineBrier: 0.25,
    brierSkill: 0.2,
    logLoss: 0.6,
    baselineLogLoss: 0.7,
    logLossSkill: 1 - 0.6 / 0.7,
    events: input.slots.map((slot, index) => ({
      eventId: `${input.runId}:event:${index}`,
      slot,
      scopeLabel: slot.startsWith("position_") ? `第${index + 1}个正码` : "特码",
      prediction: `${slot}:frozen-prediction`,
    })),
    learningRun: {
      learningRunId: `learn_${input.runId}`,
      runId: input.runId,
      game: "new_macau",
      settledIssue: input.targetIssue,
      startedAt: input.settledAt,
      completedAt: input.settledAt,
      status: "completed",
      championBefore: "baseline",
      championAfter: "baseline",
      challengerPromoted: false,
      driftDetected: false,
      summary: "fixture",
    },
    summary: "fixture",
    nextAction: "fixture",
  };
}

function addSettledReview(
  db: FakeResearchD1,
  engineVersion: string,
  review: ReturnType<typeof reviewFixture>,
) {
  db.forecasts.set(review.runId, {
    run_id: review.runId,
    game: "new_macau",
    target_issue: review.targetIssue,
    expected_draw_at: review.expectedDrawAt,
    engine_version: engineVersion,
    snapshot_json: "{}",
    frozen_at: review.frozenAt,
    review_json: JSON.stringify(review),
    settled_at: review.settledAt,
  });
}

test("snapshot reader accepts frozen v3.0 ledgers but rejects unknown future engines", () => {
  const snapshot = snapshotFixture({
    engineVersion: "high-probability-events-v3.0",
    modelVersion: "champion-challenger-v3.0-deadbeef",
    reviewVersion: "research-event-review-v3",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });
  assert.equal(store.isResearchV3Snapshot(snapshot), true);
  assert.equal(store.isResearchV3Snapshot({
    ...snapshot,
    engineVersion: "high-probability-events-v4.0",
    modelVersion: "champion-challenger-v4.0-deadbeef",
  }), false);
});

test("v3.2 requires the two special-only slots while v3.1 stays readable", () => {
  const current = snapshotFixture({
    engineVersion: "high-probability-events-v3.2",
    modelVersion: "champion-challenger-v3.2-deadbeef",
    reviewVersion: "research-event-review-v4",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size"],
  });
  const prior = snapshotFixture({
    engineVersion: "high-probability-events-v3.1",
    modelVersion: "champion-challenger-v3.1-deadbeef",
    reviewVersion: "research-event-review-v3",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });

  assert.equal(store.isResearchV3Snapshot(current), true);
  assert.equal(store.isCurrentResearchV3Snapshot(current), true);
  assert.equal(store.isResearchV3Snapshot(prior), true);
  assert.equal(store.isCurrentResearchV3Snapshot(prior), false);
  assert.equal(store.isResearchV3Snapshot({
    ...current,
    events: current.events.map((event, index) =>
      index === 2 ? { ...event, slot: "position_parity" } : event
    ),
  }), false);
  assert.equal(store.isResearchV3Snapshot({
    ...current,
    frozenAt: current.expectedDrawAt,
  }), false);
  for (const mutation of [
    { index: 0, patch: { scope: "special" } },
    { index: 1, patch: { family: "zodiac" } },
    { index: 2, patch: { predictedValue: "奇" } },
    { index: 3, patch: { predictedValue: "中" } },
  ]) {
    assert.equal(store.isResearchV3Snapshot({
      ...current,
      events: current.events.map((event, index) =>
        index === mutation.index ? { ...event, ...mutation.patch } : event
      ),
    }), false);
  }
});

test("the review picker renders same-issue engine revisions as separate selectable runs", () => {
  const shared = {
    targetIssue: "2026237",
    hits: 2,
    settledAt: "2026-08-26T14:05:00.000Z",
  };
  const html = renderToStaticMarkup(createElement(reviewUi.IssuePicker as any, {
    reviews: [
      {
        ...shared,
        runId: "run-v31",
        reviewVersion: "research-event-review-v3",
      },
      {
        ...shared,
        runId: "run-v32",
        reviewVersion: "research-event-review-v4",
      },
    ],
    selectedRunId: "run-v32",
    onSelect: () => undefined,
  }));

  assert.equal((html.match(/2026237/g) ?? []).length, 2);
  assert.match(html, /v3\.1 历史口径/);
  assert.match(html, /v3\.2 当前口径/);
  assert.match(html, /<button type="button" class="active"><span>2026237<\/span><strong>2\/4<\/strong><small>v3\.2 当前口径/);
});

test("a real D1-compatible ledger stores all eight old/new child events for one issue", async () => {
  const db = new SqliteD1();
  testRuntime.__marksixD1 = db;
  delete testRuntime.__marksixResearchV3SchemaReady;
  try {
    assert.equal(await store.ensureResearchV3Store(), true);
    const current = engine.buildResearchV3Snapshot({
      game: "new_macau",
      draws: engineHistory(60),
      targetIssue: "2026237",
      expectedDrawAt: "2026-08-02T14:00:00.000Z",
      generatedAt: "2026-08-01T14:00:00.000Z",
    }) as any;
    const prior = structuredClone(current);
    prior.runId = "prior-engine-run";
    prior.engineVersion = "high-probability-events-v3.1";
    prior.modelVersion = "champion-challenger-v3.1-deadbeef";
    prior.events[0].eventId = `evt_zodiac_6_plus_1_draw_6_plus_1_${prior.events[0].predictedValue}_b4a8ac54`;
    prior.events[1].eventId = `evt_tail_6_plus_1_draw_6_plus_1_${prior.events[1].predictedValue}_b4a8ac54`;
    prior.events[2] = {
      ...prior.events[2], eventId: "prior-position-parity", slot: "position_parity",
      scope: "main.position.3", family: "parity", predictedValue: "单",
    };
    prior.events[3] = {
      ...prior.events[3], eventId: "prior-position-size", slot: "position_size",
      scope: "main.position.4", family: "size", predictedValue: "大",
    };

    assert.equal(await store.persistResearchV3Snapshot(prior), "created");
    assert.equal(await store.persistResearchV3Snapshot(current), "created");
    assert.equal(
      sqliteCount(db.database, "research_event_ledger"),
      8,
    );
    assert.equal(await store.persistResearchV3Snapshot(current), "existing");
    assert.equal(
      sqliteCount(db.database, "research_event_ledger"),
      8,
    );
  } finally {
    db.close();
  }
});

test("the service returns the frozen snapshot without writes when a stale source is past cutoff", async () => {
  const db = new SqliteD1();
  testRuntime.__marksixD1 = db;
  delete testRuntime.__marksixResearchV3SchemaReady;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline fixture"); };
  try {
    assert.equal(await store.ensureResearchV3Store(), true);
    const latest = fallbackDraws[0];
    const initialWindow = service.researchV3FreezeWindow(
      "new_macau",
      latest,
      new Date(latest.drawAt),
    );
    const frozen = engine.buildResearchV3Snapshot({
      game: "new_macau",
      draws: fallbackDraws,
      targetIssue: initialWindow.targetIssue,
      expectedDrawAt: initialWindow.expectedDrawAt,
      generatedAt: new Date(
        Date.parse(initialWindow.expectedDrawAt) - 60 * 60_000,
      ).toISOString(),
    }) as any;
    assert.equal(await store.persistResearchV3Snapshot(frozen), "created");
    const forecastCount = sqliteCount(db.database, "research_v3_forecasts");
    const eventCount = sqliteCount(db.database, "research_event_ledger");

    const envelope = await service.runResearchV3Cycle({
      game: "new_macau",
      asOf: new Date(Date.parse(initialWindow.expectedDrawAt) + 60_000),
      forceCompute: true,
    });

    assert.equal(envelope.cycleStatus, "awaiting_verification");
    assert.equal(envelope.snapshot.runId, frozen.runId);
    assert.equal(
      sqliteCount(db.database, "research_v3_forecasts"),
      forecastCount,
    );
    assert.equal(
      sqliteCount(db.database, "research_event_ledger"),
      eventCount,
    );
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("engine-generated special slots are accepted as the current snapshot", () => {
  const snapshot = engine.buildResearchV3Snapshot({
    game: "new_macau",
    draws: engineHistory(60),
    targetIssue: "2026999",
    expectedDrawAt: "2026-08-02T14:00:00.000Z",
    generatedAt: "2026-08-01T14:00:00.000Z",
  }) as {
    engineVersion: unknown;
    modelVersion: unknown;
    events: Array<{ slot: unknown }>;
  };

  assert.equal(snapshot.engineVersion, "high-probability-events-v3.2");
  assert.match(String(snapshot.modelVersion), /^champion-challenger-v3\.2-/);
  assert.deepEqual(snapshot.events.map((event) => event.slot), [
    "zodiac_6_plus_1",
    "tail_6_plus_1",
    "special_parity",
    "special_size",
  ]);
  assert.equal(store.isResearchV3Snapshot(snapshot), true);
  assert.equal(store.isCurrentResearchV3Snapshot(snapshot), true);
});

function engineHistory(count: number) {
  const start = Date.parse("2026-01-01T21:32:32+08:00");
  return Array.from({ length: count }, (_, index) => {
    const pool = Array.from({ length: 49 }, (__, numberIndex) => numberIndex + 1);
    const shift = (index * 11) % 49;
    const ordered = [...pool.slice(shift), ...pool.slice(0, shift)];
    return {
      game: "new_macau" as const,
      issue: String(2026001 + index),
      drawAt: new Date(start + index * 86_400_000).toISOString(),
      numbers: ordered.slice(0, 6),
      special: ordered[6],
      source: "engine-store regression",
      verified: index >= count - 60,
    };
  });
}

test("a warm research database does not replay schema DDL in a fresh isolate", async () => {
  const prepared: string[] = [];
  testRuntime.__marksixD1 = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        all: async () => ({ results: [] }),
        first: async () => ({ present: 52 }),
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
        all: async () => ({ results: [] }),
        first: async () => ({ present: 51 }),
        run: async () => ({ meta: { changes: 0 } }),
      };
    },
  };
  delete testRuntime.__marksixResearchV3SchemaReady;
  assert.equal(await store.ensureResearchV3Store(), true);
  assert.ok(prepared.some((sql) => /^CREATE UNIQUE INDEX\s/im.test(sql)));
});

test("the ledger preserves an old engine row and appends one current row for the same issue", async () => {
  const db = new FakeResearchD1();
  testRuntime.__marksixD1 = db;
  delete testRuntime.__marksixResearchV3SchemaReady;
  assert.equal(await store.ensureResearchV3Store(), true);

  const prior = snapshotFixture({
    runId: "prior-run",
    targetIssue: "2026237",
    frozenAt: "2026-08-01T13:59:00.000Z",
    engineVersion: "high-probability-events-v3.1",
    modelVersion: "champion-challenger-v3.1-deadbeef",
    reviewVersion: "research-event-review-v3",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });
  const current = snapshotFixture({
    runId: "current-run",
    targetIssue: "2026237",
    frozenAt: "2026-08-01T14:01:00.000Z",
    engineVersion: "high-probability-events-v3.2",
    modelVersion: "champion-challenger-v3.2-deadbeef",
    reviewVersion: "research-event-review-v4",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size"],
  });

  assert.equal(await store.persistResearchV3Snapshot(prior), "created");
  assert.equal(await store.persistResearchV3Snapshot(current), "created");
  assert.equal(db.forecasts.size, 2);
  assert.equal(
    (await store.readResearchV3Snapshot("new_macau", "2026237"))?.runId,
    "current-run",
  );
  assert.equal(
    (await store.readResearchV3Snapshot("new_macau", "2026237", "any"))?.runId,
    "prior-run",
  );
});

test("schema repair replaces the legacy forecast identity without rewriting snapshots", async () => {
  const db = new FakeResearchD1();
  db.indexes.add("research_v3_forecast_identity_idx");
  db.schemaObjectCount = 51;
  testRuntime.__marksixD1 = db;
  const prior = snapshotFixture({
    runId: "frozen-prior-run",
    targetIssue: "2026237",
    engineVersion: "high-probability-events-v3.1",
    modelVersion: "champion-challenger-v3.1-deadbeef",
    reviewVersion: "research-event-review-v3",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });
  assert.equal(await store.persistResearchV3Snapshot(prior), "created");
  const rowCountBeforeRepair = db.forecasts.size;
  delete testRuntime.__marksixResearchV3SchemaReady;

  assert.equal(await store.ensureResearchV3Store(), true);
  assert.equal(db.indexes.has("research_v3_forecast_engine_identity_idx"), true);
  assert.equal(db.indexes.has("research_v3_forecast_identity_idx"), false);
  assert.equal(db.forecasts.size, rowCountBeforeRepair);
});

test("current performance and champion evidence exclude prior-engine rows", async () => {
  const db = new FakeResearchD1();
  const current = snapshotFixture({
    runId: "current-settled",
    targetIssue: "2026236",
    engineVersion: "high-probability-events-v3.2",
    modelVersion: "champion-challenger-v3.2-deadbeef",
    reviewVersion: "research-event-review-v4",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size"],
  });
  const prior = snapshotFixture({
    runId: "prior-settled",
    targetIssue: "2026235",
    engineVersion: "high-probability-events-v3.1",
    modelVersion: "champion-challenger-v3.1-deadbeef",
    reviewVersion: "research-event-review-v3",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });
  const currentReview = reviewFixture({
    reviewVersion: "research-event-review-v4",
    runId: "current-settled",
    targetIssue: "2026236",
    settledAt: "2026-08-02T14:01:00.000Z",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size"],
  });
  const priorReview = reviewFixture({
    reviewVersion: "research-event-review-v3",
    runId: "prior-settled",
    targetIssue: "2026235",
    settledAt: "2026-08-01T14:01:00.000Z",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });
  db.forecasts.set("current-settled", {
    run_id: "current-settled",
    game: "new_macau",
    target_issue: "2026236",
    expected_draw_at: current.expectedDrawAt,
    engine_version: current.engineVersion,
    snapshot_json: JSON.stringify(current),
    frozen_at: current.frozenAt,
    review_json: JSON.stringify(currentReview),
    settled_at: "2026-08-02T14:01:00.000Z",
  });
  db.forecasts.set("prior-settled", {
    run_id: "prior-settled",
    game: "new_macau",
    target_issue: "2026235",
    expected_draw_at: prior.expectedDrawAt,
    engine_version: prior.engineVersion,
    snapshot_json: JSON.stringify(prior),
    frozen_at: prior.frozenAt,
    review_json: JSON.stringify(priorReview),
    settled_at: "2026-08-01T14:01:00.000Z",
  });
  db.championEvidence = championRows(50).map((row) => ({
    ...row,
    run_id: "prior-settled",
    engine_version: "high-probability-events-v3.1",
  }));
  db.promotedChampions.push({
    run_id: "prior-settled",
    engine_version: "high-probability-events-v3.1",
    champion_after: "logistic",
    completed_at: "2026-08-01T14:02:00.000Z",
  });
  testRuntime.__marksixD1 = db;

  assert.equal(await store.countSettledResearchV3Forecasts("new_macau"), 1);
  const performance = await store.readResearchV3Performance("new_macau");
  assert.equal(performance.settledIssues, 1);
  assert.equal(performance.settledEvents, 4);
  assert.deepEqual(performance.curve.map((point) => point.issue), ["2026236"]);
  const challenge = await store.readChampionChallengeState("new_macau");
  assert.equal(challenge.sampleIssues, 0);
  assert.equal(challenge.champion, "baseline");
  assert.equal(challenge.formalChampion, null);
});

test("the audit reader keeps prior and current reviews while current scope isolates v3.2", async () => {
  const db = new FakeResearchD1();
  const prior = reviewFixture({
    reviewVersion: "research-event-review-v3",
    runId: "prior-audit",
    targetIssue: "2026235",
    settledAt: "2026-08-01T14:01:00.000Z",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size"],
  });
  const current = reviewFixture({
    reviewVersion: "research-event-review-v4",
    runId: "current-audit",
    targetIssue: "2026236",
    settledAt: "2026-08-02T14:01:00.000Z",
    slots: ["zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size"],
  });
  addSettledReview(db, "high-probability-events-v3.1", prior);
  addSettledReview(db, "high-probability-events-v3.2", current);
  testRuntime.__marksixD1 = db;

  const defaultAudit = await store.readResearchV3Reviews("new_macau", 10);
  const explicitAudit = await store.readResearchV3Reviews("new_macau", 10, "all");
  const currentOnly = await store.readResearchV3Reviews("new_macau", 10, "current");
  assert.deepEqual(defaultAudit, explicitAudit);
  assert.deepEqual(
    explicitAudit.map((review) => review.reviewVersion).sort(),
    ["research-event-review-v3", "research-event-review-v4"],
  );
  assert.deepEqual(
    explicitAudit.flatMap((review) => review.events.map((event: any) => event.slot)),
    [
      "zodiac_6_plus_1", "tail_6_plus_1", "special_parity", "special_size",
      "zodiac_6_plus_1", "tail_6_plus_1", "position_parity", "position_size",
    ],
  );
  assert.deepEqual(currentOnly.map((review) => review.runId), ["current-audit"]);
});

test("current learning readers exclude legacy position slots without remapping them", async () => {
  const db = new FakeResearchD1();
  db.modelWeights = [
    { engine_version: "high-probability-events-v3.1", slot: "zodiac_6_plus_1", model_id: "baseline", weight_after: 0.99 },
    { engine_version: "high-probability-events-v3.2", slot: "zodiac_6_plus_1", model_id: "baseline", weight_after: 0.4 },
    { engine_version: "high-probability-events-v3.2", slot: "tail_6_plus_1", model_id: "baseline", weight_after: 0.4 },
    { engine_version: "high-probability-events-v3.2", slot: "special_parity", model_id: "baseline", weight_after: 0.35 },
    { engine_version: "high-probability-events-v3.2", slot: "special_size", model_id: "baseline", weight_after: 0.35 },
    { engine_version: "high-probability-events-v3.1", slot: "position_parity", model_id: "baseline", weight_after: 0.99 },
    { engine_version: "high-probability-events-v3.1", slot: "position_size", model_id: "baseline", weight_after: 0.98 },
  ];
  db.ruleStates = [
    {
      engine_version: "high-probability-events-v3.2",
      slot: "special_parity",
      rule_id: "shared-rule",
      triggers: 8,
      hits: 5,
      consecutive_hits: 1,
      consecutive_misses: 0,
      status: "active",
    },
    {
      engine_version: "high-probability-events-v3.1",
      slot: "special_parity",
      rule_id: "shared-rule",
      triggers: 80,
      hits: 79,
      consecutive_hits: 20,
      consecutive_misses: 0,
      status: "active",
    },
    {
      engine_version: "high-probability-events-v3.1",
      slot: "position_parity",
      rule_id: "legacy-rule",
      triggers: 80,
      hits: 79,
      consecutive_hits: 20,
      consecutive_misses: 0,
      status: "active",
    },
  ];
  testRuntime.__marksixD1 = db;

  const weights = await store.readLatestModelWeights("new_macau");
  const ruleStates = await store.readResearchRuleStates("new_macau");
  assert.deepEqual(Object.keys(weights), [
    "zodiac_6_plus_1",
    "tail_6_plus_1",
    "special_parity",
    "special_size",
  ]);
  assert.equal((weights as any).zodiac_6_plus_1?.baseline, 0.4);
  assert.equal(weights.position_parity, undefined);
  assert.deepEqual(Object.keys(ruleStates), ["special_parity"]);
  assert.equal((ruleStates as any).special_parity?.["shared-rule"]?.triggers, 8);
  assert.equal(ruleStates.position_parity, undefined);
});

test("rule-state migration is idempotent and preserves legacy rows", async () => {
  const db = new SqliteD1();
  db.database.exec(`
    CREATE TABLE research_rule_states (
      state_id text PRIMARY KEY NOT NULL, game text NOT NULL, slot text NOT NULL,
      rule_id text NOT NULL, posterior_alpha real NOT NULL, posterior_beta real NOT NULL,
      triggers integer NOT NULL, hits integer NOT NULL, consecutive_hits integer NOT NULL,
      consecutive_misses integer NOT NULL, recent_20_json text NOT NULL,
      recent_50_json text NOT NULL, status text NOT NULL, updated_at text NOT NULL
    );
    CREATE UNIQUE INDEX research_rule_state_identity_idx
      ON research_rule_states (game, slot, rule_id);
  `);
  db.database.prepare(
    `INSERT INTO research_rule_states VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "legacy-state", "new_macau", "zodiac_6_plus_1", "shared-rule",
    2, 2, 1, 1, 1, 0, "[true]", "[true]", "active",
    "2026-08-01T14:00:00.000Z",
  );
  testRuntime.__marksixD1 = db;
  delete testRuntime.__marksixResearchV3SchemaReady;
  try {
    assert.equal(await store.ensureResearchV3Store(), true);
    delete testRuntime.__marksixResearchV3SchemaReady;
    assert.equal(await store.ensureResearchV3Store(), true);
    const columns = db.database.prepare("PRAGMA table_info(research_rule_states)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "engine_version"));
    const legacy = db.database.prepare(
      "SELECT state_id, engine_version, triggers FROM research_rule_states WHERE state_id = 'legacy-state'",
    ).get() as { state_id: string; engine_version: string; triggers: number };
    assert.equal(legacy.state_id, "legacy-state");
    assert.equal(legacy.engine_version, "legacy");
    assert.equal(legacy.triggers, 1);
    const identityColumns = db.database.prepare(
      "PRAGMA index_info(research_rule_state_identity_idx)",
    ).all() as Array<{ name: string }>;
    assert.deepEqual(identityColumns.map((column) => column.name), [
      "game", "engine_version", "slot", "rule_id",
    ]);
  } finally {
    db.close();
  }
});

test("settling old and new engines for one issue records separate rule-state updates", async () => {
  const db = new SqliteD1();
  testRuntime.__marksixD1 = db;
  delete testRuntime.__marksixResearchV3SchemaReady;
  try {
    assert.equal(await store.ensureResearchV3Store(), true);
    const current = engine.buildResearchV3Snapshot({
      game: "new_macau",
      draws: engineHistory(60),
      targetIssue: "2026237",
      expectedDrawAt: "2026-08-02T14:00:00.000Z",
      generatedAt: "2026-08-01T14:00:00.000Z",
    }) as any;
    const prior = structuredClone(current);
    prior.runId = "prior-shared-rule-run";
    prior.engineVersion = "high-probability-events-v3.1";
    prior.modelVersion = "champion-challenger-v3.1-deadbeef";
    prior.events[0].eventId = "prior-shared-zodiac";
    prior.events[1].eventId = "prior-shared-tail";
    prior.events[2] = {
      ...prior.events[2], eventId: "prior-shared-position-parity",
      slot: "position_parity", scope: "main.position.3", family: "parity",
      predictedValue: "单", predictionLabel: "下一期：第3个正码单",
    };
    prior.events[3] = {
      ...prior.events[3], eventId: "prior-shared-position-size",
      slot: "position_size", scope: "main.position.4", family: "size",
      predictedValue: "大", predictionLabel: "下一期：第4个正码大",
    };
    assert.equal(await store.persistResearchV3Snapshot(prior), "created");
    assert.equal(await store.persistResearchV3Snapshot(current), "created");
    assert.equal(await store.settleResearchV3Forecasts(
      "new_macau",
      [{
        game: "new_macau", issue: "2026237",
        drawAt: "2026-08-02T14:00:00.000Z",
        numbers: [1, 3, 25, 49, 8, 10], special: 24,
        source: "dual-engine settlement", verified: true,
      }],
      "2026-08-02T14:05:00.000Z",
    ), "ok");

    const sharedRuleId = current.events[0].ruleContributions[0].ruleId;
    const rows = db.database.prepare(
      `SELECT engine_version, triggers
       FROM research_rule_states
       WHERE game = ? AND slot = ? AND rule_id = ?
       ORDER BY engine_version`,
    ).all("new_macau", "zodiac_6_plus_1", sharedRuleId) as Array<{
      engine_version: string;
      triggers: number;
    }>;
    assert.deepEqual(rows.map((row) => [row.engine_version, row.triggers]), [
      ["high-probability-events-v3.1", 1],
      ["high-probability-events-v3.2", 1],
    ]);
    const currentStates = await store.readResearchRuleStates("new_macau");
    assert.equal((currentStates as any).zodiac_6_plus_1?.[sharedRuleId]?.triggers, 1);
  } finally {
    db.close();
  }
});

test("settling a frozen prior-engine snapshot preserves its review version and evidence", async () => {
  const generated = engine.buildResearchV3Snapshot({
    game: "new_macau",
    draws: engineHistory(60),
    targetIssue: "2026999",
    expectedDrawAt: "2026-08-02T14:00:00.000Z",
    generatedAt: "2026-08-01T14:00:00.000Z",
  }) as any;
  const prior = structuredClone(generated);
  prior.engineVersion = "high-probability-events-v3.1";
  prior.modelVersion = "champion-challenger-v3.1-deadbeef";
  prior.runId = "prior-settlement";
  prior.events[2] = {
    ...prior.events[2],
    eventId: "prior-position-parity",
    slot: "position_parity",
    slotLabel: "指定位置单双",
    scope: "main.position.3",
    scopeLabel: "第3个正码",
    predictedValue: "单",
    predictionLabel: "下一期：第3个正码单",
  };
  prior.events[3] = {
    ...prior.events[3],
    eventId: "prior-position-size",
    slot: "position_size",
    slotLabel: "指定位置大小",
    scope: "main.position.4",
    scopeLabel: "第4个正码",
    predictedValue: "大",
    predictionLabel: "下一期：第4个正码大",
  };
  const db = new FakeSettlementD1(prior, championRows(50));
  testRuntime.__marksixD1 = db;
  delete testRuntime.__marksixResearchV3SchemaReady;

  const result = await store.settleResearchV3Forecasts(
    "new_macau",
    [{
      game: "new_macau",
      issue: "2026999",
      drawAt: "2026-08-02T14:00:00.000Z",
      numbers: [1, 3, 25, 49, 8, 10],
      special: 24,
      source: "prior settlement regression",
      verified: true,
    }],
    "2026-08-02T14:05:00.000Z",
  );

  assert.equal(result, "ok");
  assert.equal(db.persistedReviewVersion, "research-event-review-v3");
  assert.equal(db.persistedReview.reviewVersion, "research-event-review-v3");
  assert.equal(db.persistedReview.learningRun.championAfter, "logistic");
  assert.deepEqual(
    db.persistedReview.events.slice(2).map((event: any) => ({
      slot: event.slot,
      scopeLabel: event.scopeLabel,
      prediction: event.prediction,
    })),
    [
      {
        slot: "position_parity",
        scopeLabel: "第3个正码",
        prediction: "下一期：第3个正码单",
      },
      {
        slot: "position_size",
        scopeLabel: "第4个正码",
        prediction: "下一期：第4个正码大",
      },
    ],
  );
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
