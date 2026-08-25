import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import test, { after, before, beforeEach } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery.ts";
import type {
  RollingPatternEvent,
  RollingPatternReviewIndexPage,
  RollingPatternReviewRecord,
  RollingPatternRun,
  RollingPatternSignal,
} from "../lib/rolling-pattern-types.ts";

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

type StoreModule = {
  persistRollingPatternRun(run: RollingPatternRun): Promise<string>;
  settleRollingPatternRuns(game: "new_macau", draws: Draw[], settledAt: string): Promise<string>;
  readRollingPatternReviewIndex(
    game: "new_macau",
    limit: number,
    beforeIssue?: string | null,
  ): Promise<RollingPatternReviewIndexPage>;
  readRollingPatternReview(
    game: "new_macau",
    issue: string,
  ): Promise<RollingPatternReviewRecord | null>;
};

let server: ViteDevServer;
let store: StoreModule;
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
  store = await server.ssrLoadModule("/lib/rolling-pattern-store.ts") as StoreModule;
});

beforeEach(() => {
  db = new SqliteD1();
  runtime.__marksixD1 = db;
  delete runtime.__marksixResearchV3SchemaReady;
});

after(async () => {
  db?.close();
  delete runtime.__marksixD1;
  delete runtime.__marksixResearchV3SchemaReady;
  await server.close();
});

test("persists one immutable snapshot and one verified settlement per issue", async () => {
  const frozen = run("2026238", "2026237");
  assert.equal(await store.persistRollingPatternRun(frozen), "created");
  assert.equal(await store.persistRollingPatternRun({ ...frozen, frozenAt: "2099-01-01T00:00:00.000Z" }), "existing");

  const pending = await store.readRollingPatternReview("new_macau", "2026238");
  assert.ok(pending);
  assert.equal(pending.snapshot.frozenAt, frozen.frozenAt);
  assert.equal(pending.snapshot.purchases.length, 5);
  assert.equal(pending.score, null);

  const draw = verifiedDraw("2026238");
  assert.equal(await store.settleRollingPatternRuns("new_macau", [draw], "2026-08-25T14:00:00.000Z"), "ok");
  assert.equal(await store.settleRollingPatternRuns("new_macau", [draw], "2099-01-01T00:00:00.000Z"), "ok");

  const settled = await store.readRollingPatternReview("new_macau", "2026238");
  assert.ok(settled?.score);
  assert.equal(settled.score.scoredAt, "2026-08-25T14:00:00.000Z");
  assert.equal(settled.score.actualSpecial, draw.special);
});

test("pages every saved issue newest-first without overlap", async () => {
  await store.persistRollingPatternRun(run("2026238", "2026237"));
  await store.persistRollingPatternRun(run("2026239", "2026238"));
  await store.persistRollingPatternRun(run("2026240", "2026239"));

  const first = await store.readRollingPatternReviewIndex("new_macau", 2);
  assert.deepEqual(first.items.map((item) => item.targetIssue), ["2026240", "2026239"]);
  assert.equal(first.nextCursor, "2026239");

  const second = await store.readRollingPatternReviewIndex("new_macau", 2, first.nextCursor);
  assert.deepEqual(second.items.map((item) => item.targetIssue), ["2026238"]);
  assert.equal(second.nextCursor, null);
});

test("marks a legacy issue settled when its verified draw already exists", async () => {
  await store.persistRollingPatternRun(run("2026238", "2026237"));
  db.database.exec("DELETE FROM rolling_pattern_review_scores;");
  const draw = verifiedDraw("2026238");
  db.database.prepare(
    `INSERT INTO lottery_draws (
       draw_id, game, issue, draw_at, main_1, main_2, main_3, main_4,
       main_5, main_6, special, source_grade, verified, source_hash,
       available_at, ingested_at, dataset_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `fixture:${draw.issue}`,
    draw.game,
    draw.issue,
    draw.drawAt,
    ...draw.numbers,
    draw.special,
    "A",
    1,
    `hash:${draw.issue}`,
    draw.drawAt,
    draw.drawAt,
    "fixture-v1",
  );

  const page = await store.readRollingPatternReviewIndex("new_macau", 20);
  assert.equal(page.items[0]?.settled, true);
});

test("signed settlement backfills a legacy run whose compact review row is missing", async () => {
  const frozen = run("2026238", "2026237");
  await store.persistRollingPatternRun(frozen);
  db.database.exec("DELETE FROM rolling_pattern_review_snapshots; DELETE FROM rolling_pattern_review_scores;");

  assert.equal(
    await store.settleRollingPatternRuns(
      "new_macau",
      [verifiedDraw("2026238")],
      "2026-08-25T14:00:00.000Z",
    ),
    "ok",
  );
  const restored = await store.readRollingPatternReview("new_macau", "2026238");
  assert.ok(restored);
  assert.equal(restored.snapshot.purchases.length, 5);
  assert.ok(restored.score);
});

function run(targetIssue: string, sourceIssue: string): RollingPatternRun {
  const signals = [
    signal(event("coverage_6_plus_1", "zodiac", "猴"), `${targetIssue}:猴`),
    signal(event("coverage_6_plus_1", "zodiac", "马"), `${targetIssue}:马`),
    signal(event("coverage_6_plus_1", "zodiac", "狗"), `${targetIssue}:狗`),
    signal(event("coverage_6_plus_1", "tail", "8尾"), `${targetIssue}:8尾`),
    signal(event("special", "head", "0头"), `${targetIssue}:0头`, 10, 8),
    signal(event("special", "wave", "蓝波"), `${targetIssue}:蓝波`, 10, 7),
  ];
  return {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: `review-run-${targetIssue}`,
    game: "new_macau",
    sourceIssue,
    targetIssue,
    expectedDrawAt: "2026-08-25T21:32:00+08:00",
    generatedAt: "2026-08-24T14:27:00.000Z",
    frozenAt: "2026-08-24T14:27:00.000Z",
    status: "completed",
    window: {
      game: "new_macau",
      drawCount: 30,
      oldestIssue: String(Number(targetIssue) - 30),
      newestIssue: sourceIssue,
      dataHash: `fixture-${targetIssue}`,
    },
    funnel: { generated: 6, currentTriggered: 6, deduplicated: 6, aboveBaseline: 6, qualified: 6 },
    scopeFunnels: {
      coverage_6_plus_1: { generated: 4, currentTriggered: 4, deduplicated: 4, aboveBaseline: 4, qualified: 4 },
      special: { generated: 2, currentTriggered: 2, deduplicated: 2, aboveBaseline: 2, qualified: 2 },
    },
    signals,
  };
}

function event(
  scope: "coverage_6_plus_1" | "special",
  family: RollingPatternEvent["family"],
  value: string,
): RollingPatternEvent {
  return {
    eventId: `${scope}:${family}:${value}:gte1`,
    scope,
    family,
    value,
    label: scope === "special" ? `下一期的特码为${value}` : `下一期6+1至少出现一次${value}`,
    threshold: 1,
    memberCount: family === "head" ? 9 : family === "wave" ? 16 : 4,
  };
}

function signal(
  result: RollingPatternEvent,
  ruleId: string,
  support = 10,
  hits = 7,
): RollingPatternSignal {
  return {
    rule: {
      ruleId,
      family: "single_transfer",
      antecedent: {
        kind: "single",
        conditions: [{
          event: {
            eventId: "condition:tail:1尾:gte1",
            scope: "condition",
            family: "tail",
            value: "1尾",
            label: "6+1至少出现一次1尾",
            threshold: 1,
            memberCount: 5,
          },
          expectedMatched: true,
        }],
      },
      event: result,
      prediction: true,
      canonicalJson: ruleId,
      conditionLabel: "本期条件成立",
      predictionLabel: result.label,
      relationLabel: `条件 → ${result.value}`,
      description: "fixture",
    },
    currentTriggered: true,
    support,
    hits,
    rawRate: hits / support,
    baseline: result.scope === "special" ? result.memberCount / 49 : 0.472,
    rawUplift: hits / support - 0.472,
    posteriorRate: hits / support,
    posteriorUplift: hits / support - 0.472,
    pValue: 0.01,
    qValue: 1,
    evidenceTier: "experimental",
    sampleLabel: "有限样本",
    relatedRuleCount: 1,
    currentEvidence: [],
    stateHistory: [],
    audit: Array.from({ length: support }, (_, index) => ({
      sourceIssue: String(2026200 + index),
      targetIssue: String(2026201 + index),
      targetDrawAt: "2026-08-25T21:32:00+08:00",
      conditionEvidence: [],
      result: {
        issue: String(2026201 + index),
        drawAt: "2026-08-25T21:32:00+08:00",
        matched: index < hits,
        count: index < hits ? 1 : 0,
      },
      matched: index < hits,
    })),
  };
}

function verifiedDraw(issue: string): Draw {
  return {
    game: "new_macau",
    issue,
    drawAt: "2026-08-25T21:32:00+08:00",
    numbers: [3, 8, 18, 28, 38, 48],
    special: 9,
    source: "fixture",
    verified: true,
  };
}
