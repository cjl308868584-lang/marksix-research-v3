import assert from "node:assert/strict";
import test from "node:test";
import { binaryLogLoss, updateExpertWeights } from "../lib/forward-learning-math.ts";
import type { ExpertWeights } from "../lib/forward-learning-types.ts";

test("fair synthetic outcomes move the ensemble toward the exact baseline", () => {
  const outcomes = bernoulliSequence(600, 0.5, 20260819);
  const weights = learn(outcomes, { baseline: 0.5, rules30: 0.68, forward: 0.62 });
  assert.ok(weights.baseline > weights.rules30);
  assert.ok(weights.baseline > weights.forward);
  assert.ok(weights.baseline >= 0.45);
});

test("a stable planted bias raises the calibrated expert only in forward time", () => {
  const outcomes = bernoulliSequence(600, 0.7, 7301);
  const weights = learn(outcomes, { baseline: 0.5, rules30: 0.7, forward: 0.64 });
  assert.ok(weights.rules30 > weights.baseline);
  assert.ok(weights.rules30 > weights.forward);
  assert.ok(weights.rules30 >= 0.45);
});

test("consecutive high-confidence errors significantly reduce that expert", () => {
  let weights: ExpertWeights = { baseline: 0.34, rules30: 0.5, forward: 0.16 };
  for (let index = 0; index < 20; index += 1) {
    weights = updateExpertWeights(weights, {
      baseline: binaryLogLoss(0.5, false),
      rules30: binaryLogLoss(0.9, false),
      forward: binaryLogLoss(0.55, false),
    });
  }
  assert.ok(weights.rules30 < 0.3);
  assert.ok(weights.baseline >= 0.25);
});

function learn(
  outcomes: readonly boolean[],
  probabilities: { baseline: number; rules30: number; forward: number },
) {
  let weights: ExpertWeights = { baseline: 0.34, rules30: 0.33, forward: 0.33 };
  for (const outcome of outcomes) {
    weights = updateExpertWeights(weights, {
      baseline: binaryLogLoss(probabilities.baseline, outcome),
      rules30: binaryLogLoss(probabilities.rules30, outcome),
      forward: binaryLogLoss(probabilities.forward, outcome),
    });
  }
  return weights;
}

function bernoulliSequence(length: number, probability: number, seed: number) {
  let state = seed >>> 0;
  return Array.from({ length }, () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32 < probability;
  });
}
