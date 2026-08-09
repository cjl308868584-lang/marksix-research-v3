import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery";
import type { RollingPatternEvent, RollingPatternScope } from "../lib/rolling-pattern-types";

const TARGET_AT = "2026-08-10T21:32:00+08:00";
let server: ViteDevServer;
let enumerateRollingConditionEvents: (drawAt: string) => RollingPatternEvent[];
let enumerateRollingResultEvents: (
  drawAt: string,
  scope: RollingPatternScope,
) => RollingPatternEvent[];
let evaluateRollingConditionEvent: (
  draw: Draw,
  event: RollingPatternEvent,
) => { matched: boolean; count: number };
let evaluateRollingResultEvent: (
  draw: Draw,
  event: RollingPatternEvent,
) => { matched: boolean; count: number };
let rollingResultEventBaseline: (
  event: RollingPatternEvent,
  drawAt: string,
) => number;

before(async () => {
  server = await createServer({
    root: process.cwd(),
    configFile: false,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });
  const loadedModule = await server.ssrLoadModule("/lib/rolling-pattern-events.ts");
  enumerateRollingConditionEvents = loadedModule.enumerateRollingConditionEvents;
  enumerateRollingResultEvents = loadedModule.enumerateRollingResultEvents;
  evaluateRollingConditionEvent = loadedModule.evaluateRollingConditionEvent;
  evaluateRollingResultEvent = loadedModule.evaluateRollingResultEvent;
  rollingResultEventBaseline = loadedModule.rollingResultEventBaseline;
});

after(async () => {
  await server.close();
});

test("zodiac and tail coverage use exact four-member and five-member baselines", () => {
  const events = enumerateRollingResultEvents(TARGET_AT, "coverage_6_plus_1");
  const zodiacCounts = new Set(
    events.filter((event) => event.family === "zodiac").map((event) => event.memberCount),
  );
  const tail0 = events.find(
    (event) => event.family === "tail" && event.value === "0尾",
  );
  const tail1 = events.find(
    (event) => event.family === "tail" && event.value === "1尾",
  );

  assert.deepEqual([...zodiacCounts].sort(), [4, 5]);
  assert.ok(tail0);
  assert.ok(tail1);
  assert.equal(tail0.memberCount, 4);
  assert.equal(tail1.memberCount, 5);
  assert.ok(
    Math.abs(rollingResultEventBaseline(tail0, TARGET_AT) - 0.47171930751949254) < 1e-12,
  );
  assert.ok(
    Math.abs(rollingResultEventBaseline(tail1, TARGET_AT) - 0.5538963041275715) < 1e-12,
  );
});

test("condition events use all six main balls plus the special ball", () => {
  const events = enumerateRollingConditionEvents(TARGET_AT);
  const redAtLeastThree = events.find(
    (event) => event.family === "wave" && event.value === "红波",
  );
  const zeroHeadAtLeastTwo = events.find(
    (event) => event.family === "head" && event.value === "0头",
  );
  assert.ok(redAtLeastThree);
  assert.ok(zeroHeadAtLeastTwo);
  assert.equal(redAtLeastThree.threshold, 3);
  assert.equal(zeroHeadAtLeastTwo.threshold, 2);
  const draw: Draw = {
    game: "new_macau",
    issue: "2026221",
    drawAt: TARGET_AT,
    numbers: [1, 2, 7, 3, 4, 9],
    special: 12,
    source: "双源一致测试",
    verified: true,
  };
  assert.equal(evaluateRollingConditionEvent(draw, redAtLeastThree).matched, true);
  assert.equal(evaluateRollingConditionEvent(draw, redAtLeastThree).count, 4);
  assert.equal(evaluateRollingConditionEvent(draw, zeroHeadAtLeastTwo).matched, true);
  assert.equal(evaluateRollingConditionEvent(draw, zeroHeadAtLeastTwo).count, 6);
});

test("6+1 targets contain only zodiac and tail", () => {
  const first = enumerateRollingResultEvents(TARGET_AT, "coverage_6_plus_1");
  const second = enumerateRollingResultEvents(TARGET_AT, "coverage_6_plus_1");
  assert.deepEqual(first, second);
  assert.equal(first.length, 22);
  assert.deepEqual(
    [...new Set(first.map((event) => event.family))],
    ["zodiac", "tail"],
  );
  assert.ok(first.every((event) => event.scope === "coverage_6_plus_1"));
  assert.equal(new Set(first.map((event) => event.eventId)).size, first.length);
});

test("special targets contain all four classifications and inspect only special", () => {
  const events = enumerateRollingResultEvents(TARGET_AT, "special");
  assert.equal(events.length, 30);
  assert.deepEqual(
    [...new Set(events.map((event) => event.family))],
    ["zodiac", "tail", "wave", "head"],
  );
  assert.ok(events.every((event) => event.scope === "special"));
  const blue = events.find((event) => event.family === "wave" && event.value === "蓝波");
  assert.ok(blue);
  const draw: Draw = {
    game: "new_macau",
    issue: "2026221",
    drawAt: TARGET_AT,
    numbers: [1, 2, 7, 3, 4, 9],
    special: 12,
    source: "双源一致测试",
    verified: true,
  };
  assert.equal(evaluateRollingResultEvent(draw, blue).matched, false);
  assert.equal(evaluateRollingResultEvent(draw, blue).count, 0);
  assert.ok(Math.abs(rollingResultEventBaseline(blue, TARGET_AT) - 16 / 49) < 1e-12);
});
