import assert from "node:assert/strict";
import test from "node:test";
import {
  benjaminiHochberg,
  poissonBinomialUpperTail,
} from "../lib/rolling-pattern-statistics.ts";

test("computes the exact Poisson-binomial upper tail", () => {
  assert.equal(poissonBinomialUpperTail([0.5, 0.5, 0.5], 2), 0.5);
  assert.ok(Math.abs(poissonBinomialUpperTail([0.2, 0.4], 2) - 0.08) < 1e-12);
  assert.equal(poissonBinomialUpperTail([0.2, 0.4], 0), 1);
});

test("BH correction is monotone in p-value order and preserves row order", () => {
  const corrected = benjaminiHochberg(
    [{ id: "third", p: 0.04 }, { id: "first", p: 0.01 }, { id: "second", p: 0.03 }],
    (row) => row.p,
  );
  assert.deepEqual(
    corrected.map(({ id, qValue }) => [id, Number(qValue.toFixed(6))]),
    [["third", 0.04], ["first", 0.03], ["second", 0.04]],
  );
});

test("empty evidence and impossible hit counts fail closed", () => {
  assert.equal(poissonBinomialUpperTail([], 1), 0);
  assert.deepEqual(benjaminiHochberg([], () => 1), []);
});
