import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
