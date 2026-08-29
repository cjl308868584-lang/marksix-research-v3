import assert from "node:assert/strict";
import test from "node:test";

import {
  matchLiveStagePrediction,
  type LiveStagePrediction,
} from "../lib/live-stage-prediction.ts";

const prediction: LiveStagePrediction = {
  coverageZodiac: "蛇",
  coverageTail: 7,
  specialZodiac: "龙",
  specialNumber: 27,
};

test("6+1生肖和尾数在正码揭晓时即可命中", () => {
  const hits = matchLiveStagePrediction(prediction, {
    drawAt: "2026-08-28T21:32:32+08:00",
    revealedNumbers: [2, 34, 22, 26, 28, 37],
    special: 27,
    specialRevealed: false,
  });

  assert.deepEqual(hits.map((hit) => hit.kind), [
    "coverage_zodiac",
    "coverage_tail",
  ]);
  assert.deepEqual(hits.map((hit) => hit.label), ["6+1生肖·蛇", "6+1尾数·7尾"]);
});

test("特码生肖和数字只在特码揭晓后命中", () => {
  const specialOnlyPrediction: LiveStagePrediction = {
    coverageZodiac: "",
    coverageTail: null,
    specialZodiac: "龙",
    specialNumber: 27,
  };
  const hidden = matchLiveStagePrediction(specialOnlyPrediction, {
    drawAt: "2026-08-28T21:32:32+08:00",
    revealedNumbers: [],
    special: 27,
    specialRevealed: false,
  });
  const revealed = matchLiveStagePrediction(specialOnlyPrediction, {
    drawAt: "2026-08-28T21:32:32+08:00",
    revealedNumbers: [],
    special: 27,
    specialRevealed: true,
  });

  assert.deepEqual(hidden, []);
  assert.deepEqual(revealed.map((hit) => hit.kind), [
    "special_zodiac",
    "special_number",
  ]);
  assert.deepEqual(revealed.map((hit) => hit.label), ["特码生肖·龙", "特码数字·27"]);
});

test("6+1条件在特码揭晓后也包含特码", () => {
  const hits = matchLiveStagePrediction(
    {
      coverageZodiac: "龙",
      coverageTail: 7,
      specialZodiac: "",
      specialNumber: null,
    },
    {
      drawAt: "2026-08-28T21:32:32+08:00",
      revealedNumbers: [2, 34, 22, 26, 28, 36],
      special: 27,
      specialRevealed: true,
    },
  );

  assert.deepEqual(hits.map((hit) => hit.kind), [
    "coverage_zodiac",
    "coverage_tail",
  ]);
});

test("未填写的预想不会误判为命中", () => {
  const hits = matchLiveStagePrediction(
    {
      coverageZodiac: "",
      coverageTail: null,
      specialZodiac: "",
      specialNumber: null,
    },
    {
      drawAt: "2026-08-28T21:32:32+08:00",
      revealedNumbers: [2, 34, 22, 26, 28, 37],
      special: 27,
      specialRevealed: true,
    },
  );

  assert.deepEqual(hits, []);
});
