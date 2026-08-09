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
  const loadedModule = await server.ssrLoadModule("/lib/rolling-pattern-engine.ts");
  buildRollingPatternRun = loadedModule.buildRollingPatternRun;
});

after(async () => {
  await server.close();
});

test("uses exactly the newest 30 verified draws and drops the oldest", async () => {
  const draws = makeCrossEventDraws(31);
  const run = await buildRollingPatternRun(input(draws));

  assert.equal(run.window.drawCount, 30);
  assert.equal(run.window.oldestIssue, "2026002");
  assert.equal(run.window.newestIssue, "2026031");
  assert.equal(run.sourceIssue, "2026031");
  assert.ok(run.signals.every((signal) => signal.currentTriggered));
});

test("discovers a current A-to-next-draw-B rule with explicit evidence", async () => {
  const run = await buildRollingPatternRun(input(makeCrossEventDraws(30)));
  const signal = run.signals.find((item) =>
    item.rule.antecedent.kind === "single" &&
    item.rule.antecedent.conditions[0].event.value === "0尾" &&
    item.rule.event.value === "9尾"
  );

  assert.ok(signal);
  assert.equal(signal.rule.family, "single_transfer");
  assert.match(signal.rule.relationLabel, /当.*0尾.*下一期.*9尾/);
  assert.equal(signal.support, 3);
  assert.equal(signal.hits, 2);
  assert.equal(signal.rawRate, 2 / 3);
  assert.equal(signal.currentEvidence.at(-1)?.issue, "2026030");
  assert.equal(signal.currentEvidence.at(-1)?.actualMatched, true);
  assert.equal(signal.audit.length, 3);
  assert.ok(signal.audit.every((row) => row.conditionEvidence.length === 1));
});

test("finds a current missing-three recovery and writes the full condition", async () => {
  const chronologicalTail0 = [
    true, false, false, false, true,
    true, false, false, false, false,
    true, false, false, false, true,
    true, false, true, false, true,
    false, true, false, true, false,
    true, true, false, false, false,
  ];
  const run = await buildRollingPatternRun(input(makeTailDraws(chronologicalTail0)));
  const signal = run.signals.find((item) =>
    item.rule.family === "sequence_transition" &&
    item.rule.event.value === "0尾" &&
    item.rule.antecedent.kind === "sequence" &&
    item.rule.antecedent.states.join(",") === "false,false,false"
  );

  assert.ok(signal);
  assert.equal(signal.support, 3);
  assert.equal(signal.hits, 2);
  assert.match(signal.rule.conditionLabel, /连续3期未出现/);
  assert.match(signal.rule.relationLabel, /连续3期未出现.*下一期/);
  assert.equal(signal.evidenceTier, "experimental");
  assert.ok(signal.qValue > 0.1);
});

test("never generates hotness, simple lag, or one-draw self continuation", async () => {
  const run = await buildRollingPatternRun(input(makeCrossEventDraws(30)));
  assert.ok(run.signals.every((item) => [
    "single_transfer",
    "conjunction_transfer",
    "sequence_transition",
  ].includes(item.rule.family)));
  assert.ok(run.signals.every((item) => item.rule.antecedent.kind !== "single" ||
    item.rule.antecedent.conditions[0].event.eventId !== item.rule.event.eventId));
  assert.ok(run.signals.every((item) => item.rule.antecedent.kind !== "sequence" ||
    item.rule.antecedent.states.length >= 2));
  assert.ok(run.signals.every((item) => item.rule.conditionLabel.length > 0));
  assert.ok(run.signals.every((item) => item.rule.predictionLabel.startsWith("下一期")));
  assert.ok(run.signals.length <= 180);
  const perResult = new Map<string, number>();
  for (const signal of run.signals) {
    perResult.set(
      signal.rule.event.eventId,
      (perResult.get(signal.rule.event.eventId) ?? 0) + 1,
    );
  }
  assert.ok([...perResult.values()].every((count) => count <= 6));
});

test("normalizes every active condition to one stable rule id", async () => {
  const first = await buildRollingPatternRun(input(makeCrossEventDraws(30)));
  const second = await buildRollingPatternRun(input(makeCrossEventDraws(30)));
  const ids = first.signals.map((signal) => signal.rule.ruleId);

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(first, second);
});

function input(draws: Draw[]) {
  return {
    game: "new_macau" as const,
    draws,
    targetIssue: "2026031",
    expectedDrawAt: "2026-02-01T21:32:00+08:00",
    generatedAt: "2026-02-01T13:40:00.000Z",
  };
}

function makeCrossEventDraws(length: number) {
  const sourceIndexes = new Set([2, 10, 20, length - 1]);
  const successfulTargetIndexes = new Set([3, 11]);
  return Array.from({ length }, (_, index) => {
    const hasTail0 = sourceIndexes.has(index);
    const hasTail9 = successfulTargetIndexes.has(index);
    return makeDraw(index, hasTail0, hasTail9);
  }).reverse();
}

function makeTailDraws(chronologicalTail0: boolean[]) {
  return chronologicalTail0.map((matched, index) =>
    makeDraw(index, matched, false)
  ).reverse();
}

function makeDraw(index: number, hasTail0: boolean, hasTail9: boolean): Draw {
  const numbers = hasTail0 ? [10, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6];
  return {
    game: "new_macau",
    issue: String(2026001 + index),
    drawAt: `2026-01-${String(index + 1).padStart(2, "0")}T21:32:00+08:00`,
    numbers,
    special: hasTail9 ? 9 : 7,
    source: "双源一致测试",
    verified: true,
  };
}
