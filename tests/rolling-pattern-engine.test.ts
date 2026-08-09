import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery";
import type { RollingPatternRun } from "../lib/rolling-pattern-types";

let server: ViteDevServer;
let buildRollingPatternRun: (input: {
  game: "new_macau";
  draws: Draw[];
  targetIssue: string;
  expectedDrawAt: string;
  generatedAt: string;
}) => Promise<RollingPatternRun>;

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const module = await server.ssrLoadModule("/lib/rolling-pattern-engine.ts");
  buildRollingPatternRun = module.buildRollingPatternRun;
});

after(async () => {
  await server.close();
});

test("uses exactly the newest 30 verified draws and drops the oldest", async () => {
  const draws = makeDraws([
    false, true, false, true, false, true, false, true,
    false, true, false, true, false, true, false, true,
    false, true, false, true, false, true, false, true,
    false, true, false, true, false, true, false,
  ]);
  const run = await buildRollingPatternRun(input(draws));

  assert.equal(run.window.drawCount, 30);
  assert.equal(run.window.oldestIssue, "2026002");
  assert.equal(run.window.newestIssue, "2026031");
  assert.equal(run.sourceIssue, "2026031");
  assert.ok(run.signals.every((signal) => signal.currentTriggered));
});

test("finds a current missing-three recovery with three historical triggers and two hits", async () => {
  const chronological = [
    true, false, false, false, true,
    true, false, false, false, false,
    true, false, false, false, true,
    true, false, true, false, true,
    false, true, false, true, false,
    true, true, false, false, false,
  ];
  const run = await buildRollingPatternRun(input(makeDraws(chronological)));
  const signal = run.signals.find((item) =>
    item.rule.family === "omission_recovery" &&
    item.rule.event.family === "tail" &&
    item.rule.event.value === "0尾" &&
    item.rule.parameters.length === 3
  );

  assert.ok(signal);
  assert.equal(signal.support, 3);
  assert.equal(signal.hits, 2);
  assert.equal(signal.rawRate, 2 / 3);
  assert.ok(Math.abs(signal.baseline - 0.47171930751949254) < 1e-12);
  assert.ok(Math.abs(signal.posteriorRate - 0.5248867691050855) < 1e-12);
  assert.equal(signal.sampleLabel, "小样本");
  assert.equal(signal.audit.length, 3);
  assert.equal(signal.currentTriggered, true);
});

test("normalizes equivalent active rules to unique stable ids", async () => {
  const chronological = [
    true, false, false, false, true,
    true, false, false, false, true,
    true, false, false, false, true,
    true, false, false, false, true,
    true, false, true, false, true,
    true, true, false, false, false,
  ];
  const first = await buildRollingPatternRun(input(makeDraws(chronological)));
  const second = await buildRollingPatternRun(input(makeDraws(chronological)));
  const ids = first.signals.map((signal) => signal.rule.ruleId);

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(first, second);
  assert.ok(first.funnel.generated > first.funnel.deduplicated);
});

test("freezes a completed empty run instead of searching until something appears", async () => {
  const chronological = Array.from({ length: 30 }, (_, index) => index % 2 === 0);
  const run = await buildRollingPatternRun(input(makeDraws(chronological)));
  assert.equal(run.status, "completed");
  assert.equal(run.signals.length, run.funnel.qualified);
  if (run.signals.length === 0) {
    assert.equal(run.funnel.qualified, 0);
  }
});

function input(draws: Draw[]) {
  return {
    game: "new_macau" as const,
    draws,
    targetIssue: "2026032",
    expectedDrawAt: "2026-02-01T21:32:00+08:00",
    generatedAt: "2026-02-01T13:40:00.000Z",
  };
}

function makeDraws(chronologicalTail0: boolean[]) {
  return chronologicalTail0.map((matched, index) => ({
    game: "new_macau" as const,
    issue: String(2026001 + index),
    drawAt: `2026-01-${String(index + 1).padStart(2, "0")}T21:32:00+08:00`,
    numbers: matched ? [10, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 6],
    special: matched ? 6 : 7,
    source: "双源一致测试",
    verified: true,
  })).reverse();
}
