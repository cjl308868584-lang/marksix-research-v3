import { getZodiac } from "./zodiac.ts";
import type {
  ExpertWeights,
  ForwardLearningSlot,
} from "./forward-learning-types.ts";

const KEYS = ["baseline", "rules30", "forward"] as const;

export function exactSlotBaseline(
  slot: ForwardLearningSlot,
  values: readonly string[],
  expectedDrawAt: string,
) {
  if (slot === "special_number") return 1 / 49;
  const memberCounts = values.map((value) => {
    if (slot === "coverage_tail") {
      const tail = Number.parseInt(value, 10);
      return Array.from({ length: 49 }, (_, index) => index + 1)
        .filter((number) => number % 10 === tail).length;
    }
    return Array.from({ length: 49 }, (_, index) => index + 1)
      .filter((number) => getZodiac(number, expectedDrawAt) === value).length;
  });
  return inclusionExclusionCoverage(memberCounts, 49, 7);
}

export function brierLoss(probability: number, matched: boolean) {
  return (boundedProbability(probability) - (matched ? 1 : 0)) ** 2;
}

export function binaryLogLoss(probability: number, matched: boolean) {
  const bounded = boundedProbability(probability);
  return -(matched ? Math.log(bounded) : Math.log(1 - bounded));
}

export function updateExpertWeights(
  before: ExpertWeights,
  meanLoss: ExpertWeights,
  eta = 0.2,
): ExpertWeights {
  const raw = Object.fromEntries(KEYS.map((key) => [
    key,
    Math.max(1e-12, before[key]) * Math.exp(-eta * meanLoss[key]),
  ])) as ExpertWeights;
  const rawTotal = KEYS.reduce((sum, key) => sum + raw[key], 0);
  for (const key of KEYS) raw[key] /= rawTotal;

  const lower: ExpertWeights = {
    baseline: Math.max(0.25, before.baseline - 0.1),
    rules30: Math.max(0, before.rules30 - 0.1),
    forward: Math.max(0, before.forward - 0.1),
  };
  const upper: ExpertWeights = {
    baseline: Math.min(0.6, before.baseline + 0.1),
    rules30: Math.min(0.6, before.rules30 + 0.1),
    forward: Math.min(0.6, before.forward + 0.1),
  };
  return projectBoundedSimplex(raw, lower, upper);
}

function inclusionExclusionCoverage(
  memberCounts: readonly number[],
  population: number,
  draws: number,
) {
  const denominator = choose(population, draws);
  let probability = 0;
  for (let mask = 0; mask < 1 << memberCounts.length; mask += 1) {
    let excluded = 0;
    let selected = 0;
    for (let index = 0; index < memberCounts.length; index += 1) {
      if (mask & (1 << index)) {
        excluded += memberCounts[index];
        selected += 1;
      }
    }
    probability += (selected % 2 ? -1 : 1) *
      choose(population - excluded, draws) / denominator;
  }
  return probability;
}

function choose(n: number, k: number) {
  if (k < 0 || k > n) return 0;
  const bounded = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= bounded; index += 1) {
    result = result * (n - bounded + index) / index;
  }
  return result;
}

function boundedProbability(value: number) {
  return Math.min(1 - 1e-6, Math.max(1e-6, value));
}

function projectBoundedSimplex(
  raw: ExpertWeights,
  lower: ExpertWeights,
  upper: ExpertWeights,
) {
  const result = Object.fromEntries(KEYS.map((key) => [
    key,
    Math.min(upper[key], Math.max(lower[key], raw[key])),
  ])) as ExpertWeights;
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const difference = 1 - KEYS.reduce((sum, key) => sum + result[key], 0);
    if (Math.abs(difference) < 1e-12) break;
    const adjustable = KEYS.filter((key) =>
      difference > 0
        ? result[key] < upper[key] - 1e-12
        : result[key] > lower[key] + 1e-12
    );
    if (!adjustable.length) break;
    const share = difference / adjustable.length;
    for (const key of adjustable) {
      result[key] = difference > 0
        ? Math.min(upper[key], result[key] + share)
        : Math.max(lower[key], result[key] + share);
    }
  }
  const total = KEYS.reduce((sum, key) => sum + result[key], 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error("专家权重约束无法归一化");
  return result;
}

