import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import test, { after, before, beforeEach } from "node:test";
import { NextRequest } from "next/server.js";
import { createServer, type ViteDevServer } from "vite";

class SqliteD1Statement {
  private values: SQLInputValue[] = [];
  private readonly statement: StatementSync;
  constructor(statement: StatementSync) { this.statement = statement; }
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  async run() {
    const result = this.statement.run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
  async first<T>() { return (this.statement.get(...this.values) ?? null) as T | null; }
  async all<T>() { return { results: this.statement.all(...this.values) as T[] }; }
}

class SqliteD1 {
  readonly database = new DatabaseSync(":memory:");
  prepare(sql: string) { return new SqliteD1Statement(this.database.prepare(sql)); }
  async batch(statements: SqliteD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
  close() { this.database.close(); }
}

type Route = { GET(request: NextRequest): Promise<Response> };
let server: ViteDevServer;
let route: Route;
let initialize: (game: "new_macau", limit: number) => Promise<unknown>;
let db: SqliteD1;
const runtime = globalThis as typeof globalThis & {
  __marksixD1?: unknown;
  __marksixResearchV3SchemaReady?: Promise<void>;
};

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  route = await server.ssrLoadModule("/app/api/research/patterns/reviews/route.ts") as Route;
  const store = await server.ssrLoadModule("/lib/rolling-pattern-store.ts") as {
    readRollingPatternReviewIndex: typeof initialize;
  };
  initialize = store.readRollingPatternReviewIndex;
});

beforeEach(async () => {
  db = new SqliteD1();
  runtime.__marksixD1 = db;
  delete runtime.__marksixResearchV3SchemaReady;
  await initialize("new_macau", 1);
  seedReview(db.database, "2026238");
});

after(async () => {
  db?.close();
  delete runtime.__marksixD1;
  delete runtime.__marksixResearchV3SchemaReady;
  await server.close();
});

test("returns a no-store cursor index and an immutable issue detail", async () => {
  const index = await get("?game=new_macau&limit=20");
  assert.equal(index.response.status, 200);
  assert.equal(index.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(index.payload.items.map((item: { targetIssue: string }) => item.targetIssue), ["2026238"]);
  assert.equal(index.payload.nextCursor, null);

  const detail = await get("?game=new_macau&issue=2026238");
  assert.equal(detail.response.status, 200);
  assert.equal(detail.payload.review.snapshot.targetIssue, "2026238");
  assert.equal(detail.payload.review.snapshot.purchases.length, 5);
  assert.equal(detail.payload.review.score.actualSpecial, 9);
});

test("rejects unknown, conflicting and malformed review parameters", async () => {
  for (const query of [
    "?game=new_macau&write=true",
    "?game=new_macau&issue=2026238&before=2026237",
    "?game=new_macau&issue=abc",
    "?game=new_macau&limit=0",
  ]) {
    const result = await get(query);
    assert.equal(result.response.status, 400);
  }
});

test("returns an explicit 404 for a missing review issue", async () => {
  const result = await get("?game=new_macau&issue=2026999");
  assert.equal(result.response.status, 404);
  assert.equal(result.response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(result.payload, { game: "new_macau", review: null });
});

async function get(query: string) {
  const response = await route.GET(new NextRequest(`https://example.test/api/research/patterns/reviews${query}`));
  return { response, payload: await response.json() as any };
}

function seedReview(database: DatabaseSync, issue: string) {
  const snapshot = {
    runId: `review-run-${issue}`,
    game: "new_macau",
    targetIssue: issue,
    frozenAt: "2026-08-24T14:27:00.000Z",
    purchases: Array.from({ length: 5 }, (_, index) => ({ kind: `kind-${index}` })),
    coverage: { summary: {}, resultGroups: [] },
    special: { summary: {}, resultGroups: [] },
    specialNumbers: [],
  };
  const score = {
    runId: snapshot.runId,
    game: "new_macau",
    targetIssue: issue,
    actualNumbers: [3, 8, 18, 28, 38, 48, 9],
    actualSpecial: 9,
    purchases: Array.from({ length: 5 }, (_, index) => ({ productId: `product-${index}` })),
    coverageResults: [],
    specialResults: [],
    specialNumbers: [],
    scoredAt: "2026-08-25T14:00:00.000Z",
  };
  database.prepare(
    `INSERT INTO rolling_pattern_runs (
       run_id, game, source_issue, target_issue, window_oldest_issue,
       window_newest_issue, window_data_hash, engine_version, status,
       generated_at, frozen_at, run_json
     ) VALUES (?, 'new_macau', '2026237', ?, '2026208', '2026237',
       'fixture', 'conditional-patterns-v3', 'completed', ?, ?, '{}')`,
  ).run(snapshot.runId, issue, snapshot.frozenAt, snapshot.frozenAt);
  database.prepare(
    `INSERT INTO rolling_pattern_review_snapshots
       (run_id, game, target_issue, snapshot_json, frozen_at)
     VALUES (?, 'new_macau', ?, ?, ?)`,
  ).run(snapshot.runId, issue, JSON.stringify(snapshot), snapshot.frozenAt);
  database.prepare(
    `INSERT INTO rolling_pattern_review_scores
       (run_id, game, target_issue, actual_json, score_json, scored_at)
     VALUES (?, 'new_macau', ?, ?, ?, ?)`,
  ).run(
    snapshot.runId,
    issue,
    JSON.stringify({ numbers: score.actualNumbers, special: score.actualSpecial }),
    JSON.stringify(score),
    score.scoredAt,
  );
}
