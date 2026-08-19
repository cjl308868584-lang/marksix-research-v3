import test from "node:test";
import assert from "node:assert/strict";
import {
  brierLoss,
  binaryLogLoss,
  exactSlotBaseline,
  updateExpertWeights,
} from "../lib/forward-learning-math.ts";

test("special number baseline is exactly 1/49", () => {
  assert.equal(
    exactSlotBaseline("special_number", ["01"], "2026-08-20T13:40:00Z"),
    1 / 49,
  );
});

test("pair and triple baselines use joint inclusion-exclusion", () => {
  const pair = exactSlotBaseline(
    "coverage_zodiac_pair",
    ["鼠", "牛"],
    "2026-08-20T13:40:00Z",
  );
  const triple = exactSlotBaseline(
    "coverage_zodiac_triple",
    ["鼠", "牛", "虎"],
    "2026-08-20T13:40:00Z",
  );
  assert.ok(pair > triple);
  assert.ok(pair > 0 && pair < 1);
  assert.ok(triple > 0 && triple < 1);
});

test("high-confidence failure has worse loss than baseline failure", () => {
  assert.ok(binaryLogLoss(0.9, false) > binaryLogLoss(0.5, false));
  assert.ok(brierLoss(0.9, false) > brierLoss(0.5, false));
});

test("expert update keeps safety bounds and per-issue movement cap", () => {
  const next = updateExpertWeights(
    { baseline: 0.34, rules30: 0.33, forward: 0.33 },
    { baseline: 0.1, rules30: 2, forward: 0.2 },
  );
  assert.ok(next.baseline >= 0.25);
  assert.ok(Math.max(...Object.values(next)) <= 0.6000001);
  assert.ok(Math.abs(next.rules30 - 0.33) <= 0.1000001);
  assert.ok(Math.abs(Object.values(next).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
});

test("tail baseline reflects four versus five member tails", () => {
  const zero = exactSlotBaseline("coverage_tail", ["0尾"], "2026-08-20T13:40:00Z");
  const one = exactSlotBaseline("coverage_tail", ["1尾"], "2026-08-20T13:40:00Z");
  assert.ok(one > zero);
});
