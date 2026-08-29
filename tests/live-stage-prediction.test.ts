import assert from "node:assert/strict";
import test from "node:test";

import {
  getLiveStageWinningNumbers,
  matchLiveStagePrediction,
  parseLiveStagePrediction,
  type LiveStagePrediction,
} from "../lib/live-stage-prediction.ts";

const prediction: LiveStagePrediction = {
  coverageZodiacs: "蛇，龙, 蛇",
  coverageTails: "7尾, 2，7",
  specialZodiacs: "龙,虎",
  specialNumbers: "05,27，49",
};

test("批量输入支持中英文逗号、空格、尾字和自动去重", () => {
  const parsed = parseLiveStagePrediction(prediction);

  assert.deepEqual(parsed.values, {
    coverageZodiacs: ["蛇", "龙"],
    coverageTails: [7, 2],
    specialZodiacs: ["龙", "虎"],
    specialNumbers: [5, 27, 49],
  });
  assert.deepEqual(parsed.invalid, {
    coverageZodiacs: [],
    coverageTails: [],
    specialZodiacs: [],
    specialNumbers: [],
  });
});

test("批量输入支持英文句点和中文句号分隔", () => {
  const parsed = parseLiveStagePrediction({
    coverageZodiacs: "蛇.龙。虎",
    coverageTails: "1尾.7尾。9尾",
    specialZodiacs: "兔.猴。马",
    specialNumbers: "05.17。27",
  });

  assert.deepEqual(parsed.values, {
    coverageZodiacs: ["蛇", "龙", "虎"],
    coverageTails: [1, 7, 9],
    specialZodiacs: ["兔", "猴", "马"],
    specialNumbers: [5, 17, 27],
  });
  assert.deepEqual(parsed.invalid, {
    coverageZodiacs: [],
    coverageTails: [],
    specialZodiacs: [],
    specialNumbers: [],
  });
});

test("无效批量内容会单独返回且不阻止有效项参与匹配", () => {
  const parsed = parseLiveStagePrediction({
    coverageZodiacs: "蛇,猫",
    coverageTails: "7尾,10尾",
    specialZodiacs: "龙,凤",
    specialNumbers: "27,00,50",
  });

  assert.deepEqual(parsed.values, {
    coverageZodiacs: ["蛇"],
    coverageTails: [7],
    specialZodiacs: ["龙"],
    specialNumbers: [27],
  });
  assert.deepEqual(parsed.invalid, {
    coverageZodiacs: ["猫"],
    coverageTails: ["10尾"],
    specialZodiacs: ["凤"],
    specialNumbers: ["00", "50"],
  });
});

test("多个6+1生肖和尾数可在正码揭晓过程中同时命中", () => {
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
  assert.deepEqual(hits.map((hit) => hit.label), ["6+1生肖·蛇", "6+1尾数·2尾、7尾"]);
  assert.deepEqual(hits.map((hit) => hit.numbers), [[2, 26], [2, 22, 37]]);
});

test("特码批量预测只在特码刮开后参与命中", () => {
  const specialOnlyPrediction: LiveStagePrediction = {
    coverageZodiacs: "",
    coverageTails: "",
    specialZodiacs: "龙,虎",
    specialNumbers: "05,27",
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
  assert.deepEqual(revealed.map((hit) => hit.numbers), [[27], [27]]);
});

test("命中的正码和已刮开的特码会返回唯一号码用于持续高亮", () => {
  const hiddenSpecial = getLiveStageWinningNumbers(prediction, {
    drawAt: "2026-08-28T21:32:32+08:00",
    revealedNumbers: [2, 34, 22, 26, 28, 37],
    special: 27,
    specialRevealed: false,
  });
  const revealedSpecial = getLiveStageWinningNumbers(prediction, {
    drawAt: "2026-08-28T21:32:32+08:00",
    revealedNumbers: [2, 34, 22, 26, 28, 37],
    special: 27,
    specialRevealed: true,
  });

  assert.deepEqual(hiddenSpecial, [2, 22, 26, 37]);
  assert.deepEqual(revealedSpecial, [2, 22, 26, 37, 27]);
});

test("空白预想不会误判为命中或高亮", () => {
  const empty: LiveStagePrediction = {
    coverageZodiacs: "",
    coverageTails: "",
    specialZodiacs: "",
    specialNumbers: "",
  };
  const result = {
    drawAt: "2026-08-28T21:32:32+08:00",
    revealedNumbers: [2, 34, 22, 26, 28, 37],
    special: 27,
    specialRevealed: true,
  } as const;

  assert.deepEqual(matchLiveStagePrediction(empty, result), []);
  assert.deepEqual(getLiveStageWinningNumbers(empty, result), []);
});
