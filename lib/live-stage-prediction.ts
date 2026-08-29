import { ZODIAC_NAMES, getZodiac } from "./zodiac.ts";

export type LiveStagePrediction = {
  coverageZodiacs: string;
  coverageTails: string;
  specialZodiacs: string;
  specialNumbers: string;
};

export type ParsedLiveStagePrediction = {
  values: {
    coverageZodiacs: string[];
    coverageTails: number[];
    specialZodiacs: string[];
    specialNumbers: number[];
  };
  invalid: {
    coverageZodiacs: string[];
    coverageTails: string[];
    specialZodiacs: string[];
    specialNumbers: string[];
  };
};

export type LiveStagePredictionHit = {
  kind:
    | "coverage_zodiac"
    | "coverage_tail"
    | "special_zodiac"
    | "special_number";
  label: string;
  numbers: number[];
};

export type LiveStagePredictionResult = {
  drawAt: string;
  revealedNumbers: readonly number[];
  special: number | null;
  specialRevealed: boolean;
};

const zodiacNames = new Set<string>(ZODIAC_NAMES);

function tokens(value: string): string[] {
  return [...new Set(value.trim().split(/[,，、\s]+/u).filter(Boolean))];
}

function partition<T>(
  source: readonly string[],
  parse: (token: string) => T | null,
): { values: T[]; invalid: string[] } {
  const values: T[] = [];
  const invalid: string[] = [];
  for (const token of source) {
    const parsed = parse(token);
    if (parsed === null) invalid.push(token);
    else if (!values.includes(parsed)) values.push(parsed);
  }
  return { values, invalid };
}

export function parseLiveStagePrediction(
  prediction: LiveStagePrediction,
): ParsedLiveStagePrediction {
  const coverageZodiacs = partition(tokens(prediction.coverageZodiacs), (token) =>
    zodiacNames.has(token) ? token : null,
  );
  const coverageTails = partition(tokens(prediction.coverageTails), (token) => {
    const normalized = token.endsWith("尾") ? token.slice(0, -1) : token;
    if (!/^\d$/u.test(normalized)) return null;
    return Number(normalized);
  });
  const specialZodiacs = partition(tokens(prediction.specialZodiacs), (token) =>
    zodiacNames.has(token) ? token : null,
  );
  const specialNumbers = partition(tokens(prediction.specialNumbers), (token) => {
    if (!/^\d{1,2}$/u.test(token)) return null;
    const number = Number(token);
    return number >= 1 && number <= 49 ? number : null;
  });

  return {
    values: {
      coverageZodiacs: coverageZodiacs.values,
      coverageTails: coverageTails.values,
      specialZodiacs: specialZodiacs.values,
      specialNumbers: specialNumbers.values,
    },
    invalid: {
      coverageZodiacs: coverageZodiacs.invalid,
      coverageTails: coverageTails.invalid,
      specialZodiacs: specialZodiacs.invalid,
      specialNumbers: specialNumbers.invalid,
    },
  };
}

export function matchLiveStagePrediction(
  prediction: LiveStagePrediction,
  result: LiveStagePredictionResult,
): LiveStagePredictionHit[] {
  const hits: LiveStagePredictionHit[] = [];
  const parsed = parseLiveStagePrediction(prediction).values;
  const coverageNumbers = [
    ...result.revealedNumbers,
    ...(result.specialRevealed && result.special !== null ? [result.special] : []),
  ];
  const zodiacNumbers = coverageNumbers.filter((number) =>
    parsed.coverageZodiacs.includes(getZodiac(number, result.drawAt)),
  );
  const matchedZodiacs = parsed.coverageZodiacs.filter((zodiac) =>
    zodiacNumbers.some((number) => getZodiac(number, result.drawAt) === zodiac),
  );

  if (matchedZodiacs.length) {
    hits.push({
      kind: "coverage_zodiac",
      label: `6+1生肖·${matchedZodiacs.join("、")}`,
      numbers: zodiacNumbers,
    });
  }

  const tailNumbers = coverageNumbers.filter((number) =>
    parsed.coverageTails.includes(number % 10),
  );
  const matchedTails = [...new Set(tailNumbers.map((number) => number % 10))]
    .sort((left, right) => left - right);
  if (matchedTails.length) {
    hits.push({
      kind: "coverage_tail",
      label: `6+1尾数·${matchedTails.map((tail) => `${tail}尾`).join("、")}`,
      numbers: tailNumbers,
    });
  }

  if (result.specialRevealed && result.special !== null) {
    const specialZodiac = getZodiac(result.special, result.drawAt);
    if (parsed.specialZodiacs.includes(specialZodiac)) {
      hits.push({
        kind: "special_zodiac",
        label: `特码生肖·${specialZodiac}`,
        numbers: [result.special],
      });
    }

    if (parsed.specialNumbers.includes(result.special)) {
      hits.push({
        kind: "special_number",
        label: `特码数字·${String(result.special).padStart(2, "0")}`,
        numbers: [result.special],
      });
    }
  }

  return hits;
}

export function getLiveStageWinningNumbers(
  prediction: LiveStagePrediction,
  result: LiveStagePredictionResult,
): number[] {
  const matched = new Set(
    matchLiveStagePrediction(prediction, result).flatMap((hit) => hit.numbers),
  );
  const ordered = [
    ...result.revealedNumbers,
    ...(result.specialRevealed && result.special !== null ? [result.special] : []),
  ];
  return ordered.filter((number, index) =>
    matched.has(number) && ordered.indexOf(number) === index,
  );
}
