import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("Sites owns the production database through one logical binding", async () => {
  const hosting = JSON.parse(
    await readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  );
  const wrangler = await readFile(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8",
  );

  assert.equal(hosting.project_id, "appgprj_6a71775ca2a0819187c157155bc9353c");
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
  assert.doesNotMatch(wrangler, /b55d1eaa-847a-4079-ab17-a140c2ae3345/);
  assert.doesNotMatch(wrangler, /"d1_databases"/);
});

test("the production source has no workers.dev dependency", async () => {
  const files = [
    "../lib/research-v3-service.ts",
    "../app/api/internal/research/settle-and-learn/route.ts",
    "../package.json",
  ];
  const source = (await Promise.all(
    files.map((file) => readFile(new URL(file, import.meta.url), "utf8")),
  )).join("\n");

  assert.doesNotMatch(source, /marksix-research-v3\.cjl308868584\.workers\.dev/);
});

test("scheduled research cannot hide a failed cycle behind tee", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/research-v2.yml", import.meta.url),
    "utf8",
  );
  const pipedSteps = workflow.match(/run: \|[\s\S]*?\| tee[\s\S]*?(?=\n      - |$)/g) ?? [];
  assert.ok(pipedSteps.length >= 2);
  assert.ok(pipedSteps.every((step) => /set -o pipefail/.test(step)));
});

test("the Sites seed preserves the audited immutable research ledger", async () => {
  const seed = await readFile(
    new URL("../drizzle/0007_sites_seed.sql", import.meta.url),
    "utf8",
  );
  const expected = {
    research_event_ledger: 8,
    research_event_scores: 4,
    research_learning_runs: 1,
    research_model_weights: 16,
    research_rule_states: 12,
    research_v3_forecasts: 2,
    research_model_artifacts: 10,
  };

  for (const [table, count] of Object.entries(expected)) {
    assert.equal(
      seed.match(new RegExp(`INSERT OR IGNORE INTO "${table}"`, "g"))?.length ?? 0,
      count,
      `${table} row count must match the verified export`,
    );
  }
});

test("the rolling pattern migration creates immutable run, signal and score identities", async () => {
  const migration = await readFile(
    new URL("../drizzle/0008_rolling_pattern_runs.sql", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
  const tables = database.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name LIKE 'rolling_pattern_%'
     ORDER BY name`,
  ).all().map((row) => row.name);
  assert.deepEqual(tables, [
    "rolling_pattern_runs",
    "rolling_pattern_scores",
    "rolling_pattern_signals",
  ]);
  const insertRun = database.prepare(
    `INSERT INTO rolling_pattern_runs (
       run_id, game, source_issue, target_issue, window_oldest_issue,
       window_newest_issue, window_data_hash, engine_version, status,
       generated_at, frozen_at, run_json
     ) VALUES (?, 'new_macau', '2026220', '2026221', '2026191',
       '2026220', 'same-window', ?, 'completed',
       '2026-08-09T13:40:00Z', '2026-08-09T13:40:00Z', '{}')`,
  );
  insertRun.run("legacy-run", "rolling-patterns-v1");
  insertRun.run("conditional-run", "conditional-patterns-v2");
  const versions = database.prepare(
    `SELECT engine_version FROM rolling_pattern_runs
     WHERE game = 'new_macau' AND target_issue = '2026221'
     ORDER BY engine_version`,
  ).all().map((row) => row.engine_version);
  assert.deepEqual(versions, ["conditional-patterns-v2", "rolling-patterns-v1"]);
  assert.throws(() => insertRun.run("duplicate-v2", "conditional-patterns-v2"));
  database.exec(
    `INSERT INTO rolling_pattern_signals (
       run_id, rule_id, game, target_issue, rule_family, event_family,
       event_value, sample_label, signal_json, frozen_at
     ) VALUES ('run-1','rule-1','new_macau','2026222','omission_recovery',
       'tail','0尾','小样本','{}','2026-08-09T13:40:00Z')`,
  );
  assert.throws(() => database.exec(
    `INSERT INTO rolling_pattern_signals (
       run_id, rule_id, game, target_issue, rule_family, event_family,
       event_value, sample_label, signal_json, frozen_at
     ) VALUES ('run-1','rule-1','new_macau','2026222','omission_recovery',
       'tail','0尾','小样本','{}','2026-08-09T13:40:00Z')`,
  ));
  database.close();
});

test("the value ledger migration enforces one frozen product and score per run", async () => {
  const migration = await readFile(
    new URL("../drizzle/0009_same_the_enforcers.sql", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
  const tables = database.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name LIKE 'rolling_pattern_consensus_%'
     ORDER BY name`,
  ).all().map((row) => row.name);
  assert.deepEqual(tables, [
    "rolling_pattern_consensus_ledger",
    "rolling_pattern_consensus_scores",
  ]);
  const row = `('run-1','product-1','new_macau','2026230','coverage_6_plus_1',
    'coverage_zodiac','马',1,'{}','2026-08-17T14:02:00Z')`;
  database.exec(`INSERT INTO rolling_pattern_consensus_ledger VALUES ${row}`);
  assert.throws(() => database.exec(
    `INSERT INTO rolling_pattern_consensus_ledger VALUES ${row}`,
  ));
  database.close();
});

test("the forward learning migration creates seven independent learning tables", async () => {
  const migration = await readFile(
    new URL("../drizzle/0010_forward_learning.sql", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(":memory:");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
  const tables = database.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = 'table' AND name LIKE 'forward_learning_%'
     ORDER BY name`,
  ).all().map((row) => row.name);
  assert.deepEqual(tables, [
    "forward_learning_candidates",
    "forward_learning_forecasts",
    "forward_learning_model_states",
    "forward_learning_rule_snapshots",
    "forward_learning_rule_updates",
    "forward_learning_runs",
    "forward_learning_scores",
  ]);
  database.close();
});
