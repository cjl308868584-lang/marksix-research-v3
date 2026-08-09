import {
  WAVE_LABEL,
  getWave,
  type Draw,
  type Wave,
} from "./lottery";
import {
  getZodiac,
  ZODIAC_NAMES,
} from "./zodiac";
import type {
  RollingPatternEvent,
  RollingPatternEventState,
  RollingPatternScope,
} from "./rolling-pattern-types";

const WAVES: readonly Wave[] = ["red", "blue", "green"];

export function enumerateRollingConditionEvents(expectedDrawAt: string) {
  return enumerateEvents(expectedDrawAt, "condition", [
    "zodiac",
    "tail",
    "wave",
    "head",
  ]);
}

export function enumerateRollingResultEvents(
  expectedDrawAt: string,
  scope: RollingPatternScope,
) {
  return enumerateEvents(
    expectedDrawAt,
    scope,
    scope === "coverage_6_plus_1"
      ? ["zodiac", "tail"]
      : ["zodiac", "tail", "wave", "head"],
  );
}

function enumerateEvents(
  expectedDrawAt: string,
  scope: RollingPatternEvent["scope"],
  families: readonly RollingPatternEvent["family"][],
) {
  const zodiacEvents = ZODIAC_NAMES.map((zodiac) =>
    makeEvent(scope, "zodiac", zodiac, 1, expectedDrawAt)
  );
  const tailEvents = Array.from({ length: 10 }, (_, tail) =>
    makeEvent(scope, "tail", `${tail}尾`, 1, expectedDrawAt)
  );
  const waveEvents = WAVES.map((wave) =>
    makeEvent(scope, "wave", WAVE_LABEL[wave], scope === "special" ? 1 : 3, expectedDrawAt)
  );
  const headEvents = Array.from({ length: 5 }, (_, head) =>
    makeEvent(scope, "head", `${head}头`, scope === "special" ? 1 : 2, expectedDrawAt)
  );
  const byFamily = { zodiac: zodiacEvents, tail: tailEvents, wave: waveEvents, head: headEvents };
  return families.flatMap((family) => byFamily[family]);
}

export function evaluateRollingConditionEvent(
  draw: Draw,
  event: RollingPatternEvent,
): RollingPatternEventState {
  const count = [...draw.numbers, draw.special].filter((number) =>
    numberMatchesEvent(number, draw.drawAt, event)
  ).length;
  return {
    issue: draw.issue,
    drawAt: draw.drawAt,
    matched: count >= event.threshold,
    count,
  };
}

export function evaluateRollingResultEvent(
  draw: Draw,
  event: RollingPatternEvent,
): RollingPatternEventState {
  const numbers = event.scope === "special"
    ? [draw.special]
    : [...draw.numbers, draw.special];
  const count = numbers.filter((number) =>
    numberMatchesEvent(number, draw.drawAt, event)
  ).length;
  return {
    issue: draw.issue,
    drawAt: draw.drawAt,
    matched: count >= event.threshold,
    count,
  };
}

export function rollingResultEventBaseline(
  event: RollingPatternEvent,
  expectedDrawAt: string,
) {
  const members = countMembers(event, expectedDrawAt);
  if (event.scope === "special") return members / 49;
  return hypergeometricAtLeast(49, members, 7, event.threshold);
}

export function hypergeometricAtLeast(
  population: number,
  members: number,
  draws: number,
  threshold: number,
) {
  const denominator = choose(population, draws);
  let numerator = 0;
  for (let hits = threshold; hits <= Math.min(members, draws); hits += 1) {
    const misses = draws - hits;
    if (misses > population - members) continue;
    numerator += choose(members, hits) * choose(population - members, misses);
  }
  return numerator / denominator;
}

function makeEvent(
  scope: RollingPatternEvent["scope"],
  family: RollingPatternEvent["family"],
  value: string,
  threshold: RollingPatternEvent["threshold"],
  expectedDrawAt: string,
): RollingPatternEvent {
  const event = {
    eventId: `${scope}:${family}:${value}:gte${threshold}`,
    scope,
    family,
    value,
    label: eventLabel(family, value, threshold, scope),
    threshold,
    memberCount: 0,
  } satisfies RollingPatternEvent;
  event.memberCount = countMembers(event, expectedDrawAt);
  return event;
}

function eventLabel(
  family: RollingPatternEvent["family"],
  value: string,
  threshold: number,
  scope?: RollingPatternEvent["scope"],
) {
  if (scope === "special") return `下一期的特码为${value}`;
  if (family === "wave") return `下一期6+1至少出现${threshold}个${value}`;
  if (family === "head") return `下一期6+1至少出现${threshold}个${value}`;
  return `下一期6+1至少出现一次${value}`;
}

function countMembers(event: RollingPatternEvent, drawAt: string) {
  let count = 0;
  for (let number = 1; number <= 49; number += 1) {
    if (numberMatchesEvent(number, drawAt, event)) count += 1;
  }
  return count;
}

function numberMatchesEvent(
  number: number,
  drawAt: string,
  event: RollingPatternEvent,
) {
  switch (event.family) {
    case "zodiac":
      return getZodiac(number, drawAt) === event.value;
    case "tail":
      return `${number % 10}尾` === event.value;
    case "wave":
      return WAVE_LABEL[getWave(number)] === event.value;
    case "head":
      return `${Math.floor(number / 10)}头` === event.value;
  }
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
