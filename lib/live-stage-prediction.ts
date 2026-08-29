import { getZodiac } from "./zodiac.ts";

export type LiveStagePrediction = {
  coverageZodiac: string;
  coverageTail: number | null;
  specialZodiac: string;
  specialNumber: number | null;
};

export type LiveStagePredictionHit = {
  kind:
    | "coverage_zodiac"
    | "coverage_tail"
    | "special_zodiac"
    | "special_number";
  label: string;
};

export type LiveStagePredictionResult = {
  drawAt: string;
  revealedNumbers: readonly number[];
  special: number | null;
  specialRevealed: boolean;
};

export function matchLiveStagePrediction(
  prediction: LiveStagePrediction,
  result: LiveStagePredictionResult,
): LiveStagePredictionHit[] {
  const hits: LiveStagePredictionHit[] = [];
  const coverageNumbers = [
    ...result.revealedNumbers,
    ...(result.specialRevealed && result.special !== null ? [result.special] : []),
  ];

  if (
    prediction.coverageZodiac &&
    coverageNumbers.some(
      (number) => getZodiac(number, result.drawAt) === prediction.coverageZodiac,
    )
  ) {
    hits.push({
      kind: "coverage_zodiac",
      label: `6+1生肖·${prediction.coverageZodiac}`,
    });
  }

  if (
    prediction.coverageTail !== null &&
    coverageNumbers.some((number) => number % 10 === prediction.coverageTail)
  ) {
    hits.push({
      kind: "coverage_tail",
      label: `6+1尾数·${prediction.coverageTail}尾`,
    });
  }

  if (result.specialRevealed && result.special !== null) {
    if (
      prediction.specialZodiac &&
      getZodiac(result.special, result.drawAt) === prediction.specialZodiac
    ) {
      hits.push({
        kind: "special_zodiac",
        label: `特码生肖·${prediction.specialZodiac}`,
      });
    }

    if (prediction.specialNumber === result.special) {
      hits.push({
        kind: "special_number",
        label: `特码数字·${String(result.special).padStart(2, "0")}`,
      });
    }
  }

  return hits;
}
