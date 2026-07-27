import assert from "node:assert/strict";
import test from "node:test";

function mulberry32(seed: number) {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

test("10,000 fair-random histories do not manufacture a persistent edge", () => {
  const random = mulberry32(20260727);
  let falseChampions = 0;
  const histories = 10_000;
  for (let history = 0; history < histories; history += 1) {
    const folds = Array.from({ length: 5 }, () => {
      let hits = 0;
      for (let sample = 0; sample < 80; sample += 1) {
        if (random() < 1 / 12) hits += 1;
      }
      return hits / 80;
    });
    const mean = folds.reduce((sum, value) => sum + value, 0) / folds.length;
    const nonWorse = folds.filter((value) => value >= 1 / 12).length / folds.length;
    const stableLift = mean > 0.13 && nonWorse >= 0.8;
    if (stableLift) falseChampions += 1;
  }
  assert.ok(
    falseChampions / histories < 0.01,
    `false champion rate ${falseChampions / histories} exceeded the preregistered ceiling`,
  );
});
