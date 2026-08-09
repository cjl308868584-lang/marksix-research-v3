import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer, type ViteDevServer } from "vite";
import type { Draw } from "../lib/lottery";
import type { RollingPatternEvent } from "../lib/rolling-pattern-types";

const TARGET_AT = "2026-08-10T21:32:00+08:00";
let server: ViteDevServer;
let enumerateRollingEvents: (drawAt: string) => RollingPatternEvent[];
let evaluateRollingEvent: (
  draw: Draw,
  event: RollingPatternEvent,
) => { matched: boolean; count: number };
let rollingEventBaseline: (
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
  const module = await server.ssrLoadModule("/lib/rolling-pattern-events.ts");
  enumerateRollingEvents = module.enumerateRollingEvents;
  evaluateRollingEvent = module.evaluateRollingEvent;
  rollingEventBaseline = module.rollingEventBaseline;
});

after(async () => {
  await server.close();
});

test("zodiac and tail coverage use exact four-member and five-member baselines", () => {
  const events = enumerateRollingEvents(TARGET_AT);
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
    Math.abs(rollingEventBaseline(tail0, TARGET_AT) - 0.47171930751949254) < 1e-12,
  );
  assert.ok(
    Math.abs(rollingEventBaseline(tail1, TARGET_AT) - 0.5538963041275715) < 1e-12,
  );
});

test("wave and head events use all six main balls plus the special ball", () => {
  const events = enumerateRollingEvents(TARGET_AT);
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
  assert.ok(
    Math.abs(rollingEventBaseline(redAtLeastThree, TARGET_AT) - 0.4626549221132187) <
      1e-12,
  );
  assert.ok(
    Math.abs(rollingEventBaseline(zeroHeadAtLeastTwo, TARGET_AT) - 0.38080770207569253) <
      1e-12,
  );

  const draw: Draw = {
    game: "new_macau",
    issue: "2026221",
    drawAt: TARGET_AT,
    numbers: [1, 2, 7, 3, 4, 9],
    special: 12,
    source: "双源一致测试",
    verified: true,
  };
  assert.equal(evaluateRollingEvent(draw, redAtLeastThree).matched, true);
  assert.equal(evaluateRollingEvent(draw, redAtLeastThree).count, 4);
  assert.equal(evaluateRollingEvent(draw, zeroHeadAtLeastTwo).matched, true);
  assert.equal(evaluateRollingEvent(draw, zeroHeadAtLeastTwo).count, 6);
});

test("event enumeration is deterministic and contains only the four approved families", () => {
  const first = enumerateRollingEvents(TARGET_AT);
  const second = enumerateRollingEvents(TARGET_AT);
  assert.deepEqual(first, second);
  assert.equal(first.length, 30);
  assert.deepEqual(
    [...new Set(first.map((event) => event.family))],
    ["zodiac", "tail", "wave", "head"],
  );
  assert.equal(new Set(first.map((event) => event.eventId)).size, first.length);
});
