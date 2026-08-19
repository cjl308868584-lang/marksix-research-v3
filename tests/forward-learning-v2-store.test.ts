import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery.ts";

const V2_SCHEMA_OBJECTS = [
  "forward_learning_revision_candidate_result_idx",
  "forward_learning_revision_candidates",
  "forward_learning_revision_forecast_slot_idx",
  "forward_learning_revision_forecasts",
  "forward_learning_revision_identity_idx",
  "forward_learning_revision_score_forecast_idx",
  "forward_learning_revision_score_result_idx",
  "forward_learning_revision_scores",
  "forward_learning_revisions",
  "forward_learning_rollouts",
];

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

  count(table: string) {
    const row = this.database.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as {
      count: number;
    };
    return Number(row.count);
  }

  close() {
    this.database.close();
  }
}

type Store = typeof import("../lib/forward-learning-v2-store.ts");
let server: ViteDevServer;
let store: Store;
let db: SqliteD1;
const runtime = globalThis as typeof globalThis & {
  __marksixD1?: unknown;
  __marksixForwardLearningV2SchemaReady?: unknown;
};

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  store = await server.ssrLoadModule("/lib/forward-learning-v2-store.ts") as Store;
});

beforeEach(async () => {
  db = new SqliteD1();
  runtime.__marksixD1 = db;
  delete runtime.__marksixForwardLearningV2SchemaReady;
  await applyMigration(db, "../drizzle/0010_forward_learning.sql");
});

after(async () => {
  delete runtime.__marksixD1;
  delete runtime.__marksixForwardLearningV2SchemaReady;
  await server.close();
});

afterEach(() => {
  db.close();
});

test("an uncommitted revision never shadows the v1 snapshot", async () => {
  await seedV1Snapshot(db, v1FiveForecasts("2026231"));
  await store.ensureForwardLearningV2Store();
  const snapshot = revisionSnapshot("2026231", 2);
  db.database.prepare(
    `INSERT INTO forward_learning_revisions (
       revision_id, game, target_issue, revision, status, content_hash,
       revision_json, created_at, committed_at
     ) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, NULL)`,
  ).run(
    snapshot.revisionId,
    snapshot.game,
    snapshot.targetIssue,
    snapshot.revision,
    snapshot.contentHash,
    JSON.stringify(snapshot),
    snapshot.createdAt,
  );

  const resolved = await store.readResolvedForwardSnapshot("new_macau", "2026231");

  assert.equal(resolved?.revision, 1);
  assert.equal(resolved?.source, "v1");
});

test("the highest committed revision is the only settlement source", async () => {
  await seedV1Snapshot(db, v1FiveForecasts("2026231"));
  assert.equal(await store.freezeForwardLearningRevision(revisionSnapshot("2026231", 2)), "created");

  const settled = await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026231"),
    "2026-08-19T14:00:00.000Z",
  );

  assert.equal(settled.revision, 2);
  assert.equal(settled.scores.length, 357);
  assert.equal(settled.scores.filter((item) => item.official).length, 5);
  assert.ok(settled.scores.every((item) => item.candidateId.includes(":r2:")));
  assert.equal(db.count("forward_learning_scores"), 0);
});

test("resolved settlement rejects a v1 snapshot frozen after the draw", async () => {
  const forecasts = v1FiveForecasts("2026231").map((item) => ({
    ...item,
    frozenAt: "2026-08-19T14:00:00.000Z",
  }));
  await seedV1Snapshot(db, forecasts);

  await assert.rejects(
    store.settleResolvedForwardSnapshot(
      "new_macau",
      verifiedDraw("2026231"),
      "2026-08-19T15:00:00.000Z",
    ),
    /开奖前冻结/,
  );
  assert.equal(db.count("forward_learning_scores"), 0);
});

test("a committed revision rejects the same id with different content", async () => {
  const original = revisionSnapshot("2026231", 2);
  assert.equal(await store.freezeForwardLearningRevision(original), "created");
  assert.equal(await store.freezeForwardLearningRevision({
    ...original,
    contentHash: "content-new",
    candidates: original.candidates.map((item, index) =>
      index === 0 ? { ...item, learnedProbability: 0.99, finalProbability: 0.99 } : item
    ),
  }), "conflict");
});

test("official forecasts cannot disguise five zodiac candidates as five distinct slots", async () => {
  await store.ensureForwardLearningV2Store();
  const snapshot = revisionSnapshot("2026231", 2);
  const zodiacCandidates = snapshot.candidates.filter((item) =>
    item.slot === "coverage_zodiac"
  ).slice(0, snapshot.forecasts.length);
  const disguised = snapshot.forecasts.map((forecast, index) => {
    const candidate = zodiacCandidates[index];
    return {
      ...candidate,
      slot: forecast.slot,
      forecastId: `forecast:${candidate.candidateId}`,
      official: true as const,
      rank: 1 as const,
      previousResultKey: null,
      previousProbability: null,
      probabilityDelta: null,
      topAlternative: null,
      explanation: ["disguised slot"],
    };
  });

  const result = await store.freezeForwardLearningRevision({
    ...snapshot,
    forecasts: disguised,
  });

  assert.equal(result, "conflict");
  assert.equal(db.count("forward_learning_revisions"), 0);
});

test("a production database with only v1 tables repairs the complete v2 schema on first use", async () => {

  await store.ensureForwardLearningV2Store();

  const rows = db.database.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type IN ('table', 'index') AND name IN (${V2_SCHEMA_OBJECTS.map(() => "?").join(",")})
     ORDER BY name`,
  ).all(...V2_SCHEMA_OBJECTS) as Array<{ name: string }>;
  assert.deepEqual(rows.map((row) => row.name), V2_SCHEMA_OBJECTS);
});

test("settlement retry cannot duplicate any candidate or official score", async () => {
  assert.equal(await store.freezeForwardLearningRevision(revisionSnapshot("2026232", 1)), "created");
  const first = await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026232"),
    "2026-08-20T14:00:00.000Z",
  );
  const second = await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026232"),
    "2026-08-20T14:01:00.000Z",
  );

  assert.equal(first.status, "settled");
  assert.equal(second.status, "existing");
  assert.equal(db.count("forward_learning_revision_scores"), 357);
  assert.equal(first.scores.filter((item) => item.official).length, 5);
});

test("a rollout cutoff is immutable per game", async () => {
  const rollout = newMacauRollout();

  assert.equal(await store.persistForwardLearningRollout(rollout), "created");
  assert.equal(await store.persistForwardLearningRollout(rollout), "existing");
  assert.deepEqual(await store.readForwardLearningRollout("new_macau"), rollout);
  assert.equal(await store.persistForwardLearningRollout({
    ...rollout,
    firstUnifiedTargetIssue: "2026232",
  }), "conflict");
});

test("score presence includes committed v2 candidate scores", async () => {
  assert.equal(await store.freezeForwardLearningRevision(revisionSnapshot("2026232", 1)), "created");
  await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026232"),
    "2026-08-20T14:00:00.000Z",
  );

  assert.equal(await store.readForwardLearningScoreCount("new_macau", "2026232"), 357);
});

test("partial settlement is repaired without changing already frozen scores", async () => {
  const snapshot = revisionSnapshot("2026232", 1);
  assert.equal(await store.freezeForwardLearningRevision(snapshot), "created");
  const originalScoredAt = "2026-08-20T14:00:00.000Z";
  await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026232"),
    originalScoredAt,
  );
  db.database.exec(
    `DELETE FROM forward_learning_revision_scores
     WHERE rowid NOT IN (
       SELECT rowid FROM forward_learning_revision_scores ORDER BY slot, result_key LIMIT 37
     )`,
  );
  const firstCandidateId = String((db.database.prepare(
    `SELECT candidate_id FROM forward_learning_revision_scores
     ORDER BY slot, result_key LIMIT 1`,
  ).get() as { candidate_id: string }).candidate_id);

  const repaired = await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026232"),
    "2026-08-20T14:01:00.000Z",
  );

  assert.equal(repaired.status, "repaired");
  assert.equal(db.count("forward_learning_revision_scores"), 357);
  const preserved = db.database.prepare(
    `SELECT score_json FROM forward_learning_revision_scores WHERE candidate_id = ?`,
  ).get(firstCandidateId) as { score_json: string };
  assert.equal((JSON.parse(preserved.score_json) as { scoredAt: string }).scoredAt, originalScoredAt);
  const existing = await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026232"),
    "2026-08-20T14:02:00.000Z",
  );
  assert.equal(existing.status, "existing");
});

test("candidate history counts only the highest committed revision for each issue", async () => {
  assert.equal(await store.freezeForwardLearningRevision(revisionSnapshot("2026232", 1)), "created");
  await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026232"),
    "2026-08-20T14:00:00.000Z",
  );
  assert.equal(await store.freezeForwardLearningRevision(revisionSnapshot("2026232", 2)), "created");
  await store.settleResolvedForwardSnapshot(
    "new_macau",
    verifiedDraw("2026232"),
    "2026-08-20T14:01:00.000Z",
  );

  const history = await store.readUnifiedCandidateHistory("new_macau", "2026233");

  assert.equal(history.get("coverage_zodiac:猴")?.settledCount, 1);
});

async function applyMigration(database: SqliteD1, relativePath: string) {
  const migration = await readFile(new URL(relativePath, import.meta.url), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) database.database.exec(statement);
  }
}

async function seedV1Snapshot(database: SqliteD1, forecasts: ReturnType<typeof v1FiveForecasts>) {
  for (const forecast of forecasts) {
    database.database.prepare(
      `INSERT INTO forward_learning_candidates (
         candidate_id, game, target_issue, slot, result_key, probability,
         baseline_probability, model_version, frozen_at, candidate_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      forecast.candidateId,
      forecast.game,
      forecast.targetIssue,
      forecast.slot,
      forecast.resultKey,
      forecast.finalProbability,
      forecast.baselineProbability,
      forecast.modelVersion,
      forecast.frozenAt,
      JSON.stringify(forecast),
    );
    database.database.prepare(
      `INSERT INTO forward_learning_forecasts (
         forecast_id, game, target_issue, slot, result_key, probability,
         baseline_probability, model_version, data_version, frozen_at,
         official, forecast_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      forecast.forecastId,
      forecast.game,
      forecast.targetIssue,
      forecast.slot,
      forecast.resultKey,
      forecast.finalProbability,
      forecast.baselineProbability,
      forecast.modelVersion,
      forecast.dataVersion,
      forecast.frozenAt,
      JSON.stringify(forecast),
    );
  }
}

function revisionSnapshot(targetIssue: string, revision: number) {
  const revisionId = `new_macau:${targetIssue}:r${revision}`;
  const candidates = candidateDefinitions().map(({ slot, resultKey, values }, index) => ({
    candidateId: `candidate:unified-v2:${revisionId}:${slot}:${resultKey}`,
    revisionId,
    game: "new_macau" as const,
    targetIssue,
    revision,
    slot,
    resultKey,
    label: resultKey,
    values,
    baselineProbability: slot === "special_number" ? 1 / 49 : 0.4,
    expertProbabilities: { baseline: 0.4, rules30: 0.4, forward: 0.4 },
    expertWeights: { baseline: 1, rules30: 0, forward: 0 },
    finalProbability: 0.4,
    netOdds: 1,
    rawRuleCount: 0,
    evidenceClusterCount: 0,
    ruleContributions: [],
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardBrierSkill: 0,
    frozenAt: "2026-08-18T12:00:00.000Z",
    modelVersion: "unified-v2",
    dataVersion: "data-v2",
    sourceRunId: "run-v2",
    sourceProductId: null,
    sourceKind: "derived_baseline" as const,
    derivedDefinitionHash: `definition-${index}`,
    selectionPolicy: "rolling-product-ev-v2" as const,
    patternProbability: 0.4,
    legacySeedProbability: 0.4,
    learnedProbability: 0.4,
    breakEvenProbability: 0.5,
    expectedValue: -0.2,
    support: 0,
    hits: 0,
    legacySettledCount: 0,
    legacyHitCount: 0,
    learningSettledCount: 0,
    learningHitCount: 0,
  }));
  const forecasts = [
    "coverage_zodiac",
    "coverage_tail",
    "coverage_zodiac_pair",
    "coverage_zodiac_triple",
    "special_number",
  ].map((slot) => {
    const candidate = candidates.find((item) => item.slot === slot)!;
    return {
      ...candidate,
      forecastId: `forecast:${candidate.candidateId}`,
      official: true as const,
      rank: 1 as const,
      previousResultKey: null,
      previousProbability: null,
      probabilityDelta: null,
      topAlternative: null,
      explanation: ["fixture"],
    };
  });
  return {
    revisionId,
    game: "new_macau" as const,
    targetIssue,
    revision,
    status: "processing" as const,
    selectionPolicy: "rolling-product-ev-v2" as const,
    sourceRunId: "run-v2",
    dataVersion: "data-v2",
    contentHash: `content-r${revision}`,
    reason: revision === 1 ? "initial" as const : "correct-v1-bootstrap" as const,
    createdAt: "2026-08-18T12:00:00.000Z",
    committedAt: null,
    recommendationHash: `recommendation-r${revision}`,
    rollout: {
      game: "new_macau" as const,
      firstUnifiedTargetIssue: "2026231",
      legacySeedThroughIssue: "2026230",
      seedQueryVersion: "legacy-target-cutoff-v1" as const,
      sourceRunId: "run-v2",
      sourceDataHash: "data-v2",
      authoritativeRecommendationHash: "recommendation-r2",
      createdAt: "2026-08-18T12:00:00.000Z",
    },
    recommendations: [],
    candidates,
    forecasts,
  };
}

function candidateDefinitions() {
  const zodiacs = ["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"];
  const singles = zodiacs.map((value) => ({
    slot: "coverage_zodiac" as const,
    resultKey: value,
    values: [value],
  }));
  const tails = Array.from({ length: 10 }, (_, value) => ({
    slot: "coverage_tail" as const,
    resultKey: `${value}尾`,
    values: [`${value}尾`],
  }));
  const combinations = (size: 2 | 3) => {
    const result: string[][] = [];
    const visit = (start: number, values: string[]) => {
      if (values.length === size) {
        result.push(values);
        return;
      }
      for (let index = start; index < zodiacs.length; index += 1) {
        visit(index + 1, [...values, zodiacs[index]]);
      }
    };
    visit(0, []);
    return result.map((values) => ({
      slot: size === 2 ? "coverage_zodiac_pair" as const : "coverage_zodiac_triple" as const,
      resultKey: values.join("+"),
      values,
    }));
  };
  const specials = Array.from({ length: 49 }, (_, index) => {
    const resultKey = String(index + 1).padStart(2, "0");
    return { slot: "special_number" as const, resultKey, values: [resultKey] };
  });
  return [...singles, ...tails, ...combinations(2), ...combinations(3), ...specials];
}

function v1FiveForecasts(targetIssue: string) {
  const definitions = [
    ["coverage_zodiac", "猴", ["猴"]],
    ["coverage_tail", "8尾", ["8尾"]],
    ["coverage_zodiac_pair", "蛇+猴", ["蛇", "猴"]],
    ["coverage_zodiac_triple", "蛇+马+猴", ["蛇", "马", "猴"]],
    ["special_number", "01", ["01"]],
  ] as const;
  return definitions.map(([slot, resultKey, values]) => ({
    candidateId: `candidate:v1:${targetIssue}:${slot}`,
    forecastId: `forecast:v1:${targetIssue}:${slot}`,
    game: "new_macau" as const,
    targetIssue,
    slot,
    resultKey,
    label: resultKey,
    values: [...values],
    baselineProbability: 0.4,
    expertProbabilities: { baseline: 0.4, rules30: 0.4, forward: 0.4 },
    expertWeights: { baseline: 1, rules30: 0, forward: 0 },
    finalProbability: 0.4,
    netOdds: 1,
    rawRuleCount: 0,
    evidenceClusterCount: 0,
    ruleContributions: [],
    forwardSettledCount: 0,
    forwardHitCount: 0,
    forwardBrierSkill: 0,
    frozenAt: "2026-08-18T12:00:00.000Z",
    modelVersion: "v1",
    dataVersion: "data-v1",
    official: true as const,
    rank: 1 as const,
    previousResultKey: null,
    previousProbability: null,
    probabilityDelta: null,
    topAlternative: null,
    explanation: ["fixture"],
  }));
}

function verifiedDraw(issue: string): Draw {
  return {
    game: "new_macau",
    issue,
    drawAt: "2026-08-19T13:00:00.000Z",
    numbers: [1, 2, 3, 4, 5, 6],
    special: 7,
    source: "fixture",
    verified: true,
  };
}

function newMacauRollout() {
  return {
    game: "new_macau" as const,
    firstUnifiedTargetIssue: "2026231",
    legacySeedThroughIssue: "2026230",
    seedQueryVersion: "legacy-target-cutoff-v1" as const,
    sourceRunId: "run-v2",
    sourceDataHash: "data-v2",
    authoritativeRecommendationHash: "recommendation-r2",
    createdAt: "2026-08-18T12:00:00.000Z",
  };
}
