import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import test, { after, before, beforeEach } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { NextRequest } from "next/server.js";

const root = new URL("../", import.meta.url);

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

  close() {
    this.database.close();
  }
}

type Route = { GET(request: NextRequest): Promise<Response> };
let server: ViteDevServer;
let patternsRoute: Route;
let forecastRoute: Route;
let reviewsRoute: Route;
let performanceRoute: Route;
let db: SqliteD1;
const runtime = globalThis as typeof globalThis & {
  __marksixD1?: unknown;
  __marksixResearchV3SchemaReady?: Promise<void>;
  __marksixForwardLearningSchemaReady?: Promise<void>;
  __marksixForwardLearningV2SchemaReady?: Promise<void>;
};

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  [patternsRoute, forecastRoute, reviewsRoute, performanceRoute] = await Promise.all([
    server.ssrLoadModule("/app/api/research/patterns/route.ts") as Promise<Route>,
    server.ssrLoadModule("/app/api/learning/forecast/route.ts") as Promise<Route>,
    server.ssrLoadModule("/app/api/learning/reviews/route.ts") as Promise<Route>,
    server.ssrLoadModule("/app/api/learning/performance/route.ts") as Promise<Route>,
  ]);
});

beforeEach(() => {
  db = new SqliteD1();
  runtime.__marksixD1 = db;
  runtime.__marksixResearchV3SchemaReady = Promise.resolve();
  runtime.__marksixForwardLearningSchemaReady = Promise.resolve();
  runtime.__marksixForwardLearningV2SchemaReady = Promise.resolve();
  createApiSchema(db.database);
  seedPatternRun(db.database, "2026231");
  seedRevision(db.database, "2026231", 1, "lower");
  seedRevision(db.database, "2026231", 2, "resolved");
  seedScores(db.database, "2026231", 1, "lower");
  seedScores(db.database, "2026231", 2, "resolved");
  seedV1Scores(db.database, "2026231");
  seedCompletedRun(db.database, "2026231");
});

after(async () => {
  db?.close();
  delete runtime.__marksixD1;
  delete runtime.__marksixResearchV3SchemaReady;
  delete runtime.__marksixForwardLearningSchemaReady;
  delete runtime.__marksixForwardLearningV2SchemaReady;
  await server.close();
});

test("learning read APIs are no-store and never trigger training", async () => {
  const paths = [
    "app/api/learning/forecast/route.ts",
    "app/api/learning/reviews/route.ts",
    "app/api/learning/performance/route.ts",
    "app/api/learning/model/route.ts",
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, root), "utf8")));
  for (const source of sources) {
    assert.match(source, /private, no-store/);
    assert.doesNotMatch(source, /runForwardLearningCycle|runStoredForwardLearningCycle/);
  }
  assert.match(sources[0], /readResolvedProductRecommendations/);
  assert.match(sources[1], /readForwardLearningReviews/);
  assert.match(sources[2], /readForwardLearningPerformance/);
  assert.match(sources[3], /readForwardLearningModel/);
});

test("learning API validators reject unknown query parameters", async () => {
  const paths = [
    "app/api/learning/forecast/route.ts",
    "app/api/learning/reviews/route.ts",
    "app/api/learning/performance/route.ts",
    "app/api/learning/model/route.ts",
  ];
  const sources = await Promise.all(paths.map((path) => readFile(new URL(path, root), "utf8")));
  for (const source of sources) {
    assert.match(source, /不受支持的参数/);
    assert.match(source, /GAME_IDS/);
  }
});

test("signed learning treats a missing 30-draw prerequisite as an explicit abstention", async () => {
  const route = await readFile(
    new URL("app/api/internal/learning/settle-and-freeze/route.ts", root),
    "utf8",
  );
  const service = await readFile(
    new URL("lib/forward-learning-service.ts", root),
    "utf8",
  );
  assert.match(service, /ForwardLearningPrerequisiteError/);
  assert.match(route, /instanceof ForwardLearningPrerequisiteError/);
  assert.match(route, /awaiting_pattern_window/);
  assert.match(route, /status:\s*425/);
});

test("patterns and learning expose the same authoritative recommendation fields", async () => {
  const [patterns, learning] = await Promise.all([
    getJson(patternsRoute, "/api/research/patterns?game=new_macau&issue=2026231&scope=special"),
    getJson(forecastRoute, "/api/learning/forecast?game=new_macau"),
  ]);

  assert.equal(patterns.response.status, 200);
  assert.equal(learning.response.status, 200);
  assert.equal(patterns.payload.recommendations.length, 5);
  assert.deepEqual(
    projectRecommendations(learning.payload.forecasts),
    projectRecommendations(patterns.payload.recommendations),
  );
});

test("reviews expose only five official scores from the resolved revision", async () => {
  const { response, payload } = await getJson(
    reviewsRoute,
    "/api/learning/reviews?game=new_macau&limit=30",
  );

  assert.equal(response.status, 200);
  assert.equal(payload.reviews[0].scores.length, 5);
  assert.ok(payload.reviews[0].scores.every((item: { official: boolean }) => item.official));
  assert.equal(payload.reviews[0].run.revision, 2);
});

test("reviews and performance exclude v1 and lower committed revisions", async () => {
  const [reviews, performance] = await Promise.all([
    getJson(reviewsRoute, "/api/learning/reviews?game=new_macau&limit=30"),
    getJson(performanceRoute, "/api/learning/performance?game=new_macau"),
  ]);

  assert.equal(reviews.payload.reviews[0].run.revision, 2);
  assert.equal(reviews.payload.reviews[0].scores.length, 5);
  assert.equal(performance.payload.officialSettledCount, 5);
  assert.ok(performance.payload.slots.every(
    (item: { revisionSource: string }) => item.revisionSource === "resolved-v2",
  ));
});

test("performance rejects a partially written resolved-v2 official denominator", async () => {
  db.database.exec(`DELETE FROM forward_learning_revision_scores
    WHERE revision = 2 AND slot = 'special_number'`);

  const { response } = await getJson(
    performanceRoute,
    "/api/learning/performance?game=new_macau",
  );

  assert.equal(response.status, 503);
});

async function getJson(route: Route, path: string) {
  const response = await route.GET(new NextRequest(`http://localhost${path}`));
  return { response, payload: await response.json() as any };
}

function projectRecommendations(items: Array<Record<string, unknown>>) {
  return items.map((item) => ({
    kind: item.kind,
    resultKey: item.resultKey,
    values: item.values,
    sourceRunId: item.sourceRunId,
    sourceProductId: item.sourceProductId,
    sourceKind: item.sourceKind,
    dataVersion: item.dataVersion,
    revision: item.revision,
    p30: item.p30,
    legacySeedProbability: item.legacySeedProbability,
    learnedProbability: item.learnedProbability,
    netOdds: item.netOdds,
    breakEvenProbability: item.breakEvenProbability,
    expectedValue: item.expectedValue,
    legacySettledCount: item.legacySettledCount,
    legacyHitCount: item.legacyHitCount,
    learningSettledCount: item.learningSettledCount,
    learningHitCount: item.learningHitCount,
    reason: item.reason,
  }));
}

function createApiSchema(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE rolling_pattern_runs (run_id TEXT PRIMARY KEY, game TEXT, target_issue TEXT, engine_version TEXT, status TEXT, frozen_at TEXT, run_json TEXT);
    CREATE TABLE rolling_pattern_signals (run_id TEXT, signal_json TEXT);
    CREATE TABLE rolling_pattern_scores (run_id TEXT, score_json TEXT);
    CREATE TABLE rolling_pattern_consensus_ledger (run_id TEXT, product_id TEXT, game TEXT, target_issue TEXT, scope TEXT, product_kind TEXT, result_key TEXT, rank INTEGER, product_json TEXT);
    CREATE TABLE rolling_pattern_consensus_scores (run_id TEXT, product_id TEXT, game TEXT, target_issue TEXT, scope TEXT, score_json TEXT);
    CREATE TABLE forward_learning_revisions (revision_id TEXT PRIMARY KEY, game TEXT, target_issue TEXT, revision INTEGER, status TEXT, revision_json TEXT);
    CREATE TABLE forward_learning_revision_forecasts (forecast_id TEXT PRIMARY KEY, candidate_id TEXT, revision_id TEXT, game TEXT, target_issue TEXT, revision INTEGER, slot TEXT, result_key TEXT, forecast_json TEXT, frozen_at TEXT);
    CREATE TABLE forward_learning_revision_candidates (candidate_id TEXT PRIMARY KEY, revision_id TEXT, game TEXT, target_issue TEXT, revision INTEGER, slot TEXT, result_key TEXT, candidate_json TEXT, frozen_at TEXT);
    CREATE TABLE forward_learning_revision_scores (score_id TEXT PRIMARY KEY, forecast_id TEXT, candidate_id TEXT, revision_id TEXT, game TEXT, target_issue TEXT, revision INTEGER, slot TEXT, result_key TEXT, official INTEGER, actual_matched INTEGER, score_json TEXT, scored_at TEXT);
    CREATE TABLE forward_learning_forecasts (forecast_id TEXT PRIMARY KEY, game TEXT, target_issue TEXT, slot TEXT, forecast_json TEXT, frozen_at TEXT);
    CREATE TABLE forward_learning_candidates (candidate_id TEXT PRIMARY KEY, game TEXT, target_issue TEXT, candidate_json TEXT);
    CREATE TABLE forward_learning_scores (score_id TEXT PRIMARY KEY, forecast_id TEXT, candidate_id TEXT, game TEXT, target_issue TEXT, slot TEXT, result_key TEXT, official INTEGER, actual_matched INTEGER, probability REAL, baseline_probability REAL, brier REAL, baseline_brier REAL, log_loss REAL, baseline_log_loss REAL, scored_at TEXT, score_json TEXT);
    CREATE TABLE forward_learning_runs (run_id TEXT PRIMARY KEY, game TEXT, settled_issue TEXT, target_issue TEXT, status TEXT, run_json TEXT, completed_at TEXT);
    CREATE TABLE forward_learning_model_states (state_id TEXT PRIMARY KEY, game TEXT, version TEXT, state_json TEXT, generated_at TEXT);
    CREATE TABLE forward_learning_rule_updates (run_id TEXT, game TEXT, update_json TEXT, generated_at TEXT);
  `);
}

function seedPatternRun(database: DatabaseSync, targetIssue: string) {
  const run = {
    schemaVersion: "rolling-patterns-2",
    engineVersion: "conditional-patterns-v3",
    runId: `pattern:${targetIssue}`,
    game: "new_macau",
    sourceIssue: String(Number(targetIssue) - 1),
    targetIssue,
    expectedDrawAt: "2026-08-19T13:32:00.000Z",
    generatedAt: "2026-08-19T12:00:00.000Z",
    frozenAt: "2026-08-19T12:00:00.000Z",
    status: "completed",
    window: { game: "new_macau", drawCount: 30, oldestIssue: "2026201", newestIssue: "2026230", dataHash: "data-v2" },
    funnel: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    scopeFunnels: {
      coverage_6_plus_1: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
      special: { generated: 0, currentTriggered: 0, deduplicated: 0, aboveBaseline: 0, qualified: 0 },
    },
    signals: [],
  };
  database.prepare(`INSERT INTO rolling_pattern_runs VALUES (?, ?, ?, ?, 'completed', ?, ?)`)
    .run(run.runId, run.game, targetIssue, run.engineVersion, run.frozenAt, JSON.stringify(run));
}

const OFFICIAL = [
  ["coverage_zodiac", "猴", ["猴"]],
  ["coverage_tail", "8尾", ["8尾"]],
  ["coverage_zodiac_pair", "蛇+猴", ["蛇", "猴"]],
  ["coverage_zodiac_triple", "蛇+马+猴", ["蛇", "马", "猴"]],
  ["special_number", "01", ["01"]],
] as const;

function seedRevision(database: DatabaseSync, targetIssue: string, revision: number, marker: string) {
  const revisionId = `new_macau:${targetIssue}:r${revision}`;
  const sourceRunId = marker === "resolved" ? `pattern:${targetIssue}` : `run-${marker}`;
  const dataVersion = marker === "resolved" ? "data-v2" : `data-${marker}`;
  const manifest = { revisionId, game: "new_macau", targetIssue, revision, status: "committed", sourceRunId, dataVersion };
  database.prepare(`INSERT INTO forward_learning_revisions VALUES (?, 'new_macau', ?, ?, 'committed', ?)`)
    .run(revisionId, targetIssue, revision, JSON.stringify(manifest));
  for (const [index, [slot, resultKey, values]] of OFFICIAL.entries()) {
    const candidateId = `candidate:${marker}:${slot}`;
    const forecastId = `forecast:${candidateId}`;
    const learnedProbability = index === 4 ? 0.01 : 0.55 + index * 0.01;
    const netOdds = index === 4 ? 47 : 1;
    const forecast = {
      candidateId,
      forecastId,
      revisionId,
      revision,
      game: "new_macau",
      targetIssue,
      slot,
      kind: slot,
      resultKey,
      label: values.join("＋"),
      values,
      sourceRunId,
      sourceProductId: `product-${marker}-${slot}`,
      sourceKind: "ledger",
      dataVersion,
      patternProbability: 0.5,
      legacySeedProbability: 0.52,
      learnedProbability,
      finalProbability: learnedProbability,
      baselineProbability: 0.4,
      netOdds,
      breakEvenProbability: 1 / (netOdds + 1),
      expectedValue: learnedProbability * netOdds - (1 - learnedProbability),
      support: 20,
      hits: 11,
      legacySettledCount: 9,
      legacyHitCount: 5,
      learningSettledCount: 2,
      learningHitCount: 1,
      forwardSettledCount: 2,
      forwardHitCount: 1,
      rawRuleCount: 3,
      evidenceClusterCount: 2,
      derivedDefinitionHash: `definition-${slot}`,
      sourceProductKind: slot,
      frozenAt: "2026-08-19T12:00:00.000Z",
      modelVersion: "rolling-product-ev-v2",
      selectionPolicy: "rolling-product-ev-v2",
      expertProbabilities: { baseline: 0.4, rules30: 0.5, forward: learnedProbability },
      expertWeights: { baseline: 0, rules30: 0, forward: 1 },
      ruleContributions: [],
      forwardBrierSkill: 0,
      official: true,
      rank: 1,
      previousResultKey: null,
      previousProbability: null,
      probabilityDelta: null,
      topAlternative: null,
      explanation: [`${marker} explanation`],
    };
    database.prepare(`INSERT INTO forward_learning_revision_forecasts VALUES (?, ?, ?, 'new_macau', ?, ?, ?, ?, ?, ?)`)
      .run(forecastId, candidateId, revisionId, targetIssue, revision, slot, resultKey, JSON.stringify(forecast), forecast.frozenAt);
  }
}

function seedScores(database: DatabaseSync, targetIssue: string, revision: number, marker: string) {
  const revisionId = `new_macau:${targetIssue}:r${revision}`;
  for (const [index, [slot, resultKey]] of OFFICIAL.entries()) {
    const candidateId = `candidate:${marker}:${slot}`;
    const score = {
      scoreId: `score:${candidateId}`,
      forecastId: `forecast:${candidateId}`,
      candidateId,
      revisionId,
      revision,
      game: "new_macau",
      targetIssue,
      slot,
      resultKey,
      official: true,
      actualMatched: index === 0,
      probability: 0.55,
      learnedProbability: 0.55,
      baselineProbability: 0.4,
      brier: 0.2,
      baselineBrier: 0.24,
      logLoss: 0.6,
      baselineLogLoss: 0.7,
      actualNumbers: [1, 2, 3, 4, 5, 6, 7],
      actualSpecial: 7,
      scoredAt: "2026-08-19T14:00:00.000Z",
    };
    database.prepare(`INSERT INTO forward_learning_revision_scores VALUES (?, ?, ?, ?, 'new_macau', ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(score.scoreId, score.forecastId, candidateId, revisionId, targetIssue, revision, slot, resultKey, score.actualMatched ? 1 : 0, JSON.stringify(score), score.scoredAt);
  }
}

function seedV1Scores(database: DatabaseSync, targetIssue: string) {
  for (const [index, [slot, resultKey]] of OFFICIAL.entries()) {
    const score = {
      scoreId: `score:v1:${slot}`,
      forecastId: `forecast:v1:${slot}`,
      candidateId: `candidate:v1:${slot}`,
      game: "new_macau",
      targetIssue,
      slot,
      resultKey,
      official: true,
      actualMatched: false,
      probability: 0.99,
      baselineProbability: 0.4,
      brier: 0.9,
      baselineBrier: 0.2,
      logLoss: 4,
      baselineLogLoss: 0.7,
      actualNumbers: [],
      actualSpecial: 7,
      scoredAt: "2026-08-19T14:00:00.000Z",
    };
    database.prepare(`INSERT INTO forward_learning_scores VALUES (?, ?, ?, 'new_macau', ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(score.scoreId, score.forecastId, score.candidateId, targetIssue, slot, resultKey, score.probability, score.baselineProbability, score.brier, score.baselineBrier, score.logLoss, score.baselineLogLoss, score.scoredAt, JSON.stringify(score));
  }
}

function seedCompletedRun(database: DatabaseSync, settledIssue: string) {
  const run = {
    runId: `learning:${settledIssue}`,
    taskId: `task:${settledIssue}`,
    game: "new_macau",
    settledIssue,
    targetIssue: String(Number(settledIssue) + 1),
    engineVersion: "forward-learning-v1",
    status: "completed",
    modelVersionBefore: null,
    modelVersionAfter: null,
    error: null,
    startedAt: "2026-08-19T14:00:00.000Z",
    completedAt: "2026-08-19T14:01:00.000Z",
  };
  database.prepare(`INSERT INTO forward_learning_runs VALUES (?, 'new_macau', ?, ?, 'completed', ?, ?)`)
    .run(run.runId, settledIssue, run.targetIssue, JSON.stringify(run), run.completedAt);
}
