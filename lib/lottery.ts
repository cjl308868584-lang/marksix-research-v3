export type GameId = "hk" | "macau";

export type Draw = {
  game: GameId;
  issue: string;
  drawAt: string;
  numbers: number[];
  special: number;
  source: string;
  verified: boolean;
};

export type NumberScore = {
  number: number;
  frequency: number;
  specialFrequency: number;
  omission: number;
  score: number;
};

export type CandidateSet = {
  id: "balanced" | "momentum" | "contrarian";
  name: string;
  description: string;
  numbers: number[];
  special: number;
  score: number;
};

export type Analysis = {
  sampleSize: number;
  hot: NumberScore[];
  cold: NumberScore[];
  overdue: NumberScore[];
  waves: Record<Wave, number>;
  zodiacs: Array<{ name: string; count: number }>;
  odd: number;
  even: number;
  big: number;
  small: number;
  zones: [number, number, number];
  averageSum: number;
  repeatRate: number;
  consecutiveRate: number;
  candidates: CandidateSet[];
  summary: string[];
};

export const GAME_META: Record<
  GameId,
  { name: string; shortName: string; schedule: string; sourceLabel: string }
> = {
  hk: {
    name: "香港六合彩",
    shortName: "香港",
    schedule: "周二 / 四 / 六 21:30",
    sourceLabel: "HKJC 优先 · 双源核验",
  },
  macau: {
    name: "澳门六合彩",
    shortName: "澳门",
    schedule: "每日 22:32",
    sourceLabel: "澳门彩 API · 多源核验",
  },
};

const RED = new Set([1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46]);
const BLUE = new Set([3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48]);

export type Wave = "red" | "blue" | "green";

export const WAVE_LABEL: Record<Wave, string> = {
  red: "红波",
  blue: "蓝波",
  green: "绿波",
};

export function getWave(number: number): Wave {
  if (RED.has(number)) return "red";
  if (BLUE.has(number)) return "blue";
  return "green";
}

const ZODIAC_ORDER_2026 = ["马", "蛇", "龙", "兔", "虎", "牛", "鼠", "猪", "狗", "鸡", "猴", "羊"];

export function getZodiac(number: number): string {
  return ZODIAC_ORDER_2026[(number - 1) % 12];
}

export function formatBall(number: number): string {
  return String(number).padStart(2, "0");
}

export const FALLBACK_DRAWS: Record<GameId, Draw[]> = {
  hk: [
    draw("hk", "2026078", "2026-07-21T21:32:32+08:00", [6, 47, 45, 1, 41, 37], 8),
    draw("hk", "2026077", "2026-07-16T21:32:32+08:00", [18, 30, 26, 21, 44, 32], 27),
    draw("hk", "2026076", "2026-07-14T21:32:32+08:00", [31, 44, 27, 10, 16, 19], 17),
  ],
  macau: [
    draw("macau", "2026202", "2026-07-21T22:32:32+08:00", [10, 14, 28, 1, 43, 36], 29),
    draw("macau", "2026201", "2026-07-20T22:32:32+08:00", [23, 43, 32, 40, 25, 22], 38),
    draw("macau", "2026200", "2026-07-19T22:32:32+08:00", [30, 9, 44, 19, 31, 39], 45),
    draw("macau", "2026199", "2026-07-18T22:32:32+08:00", [43, 15, 40, 21, 3, 20], 9),
    draw("macau", "2026198", "2026-07-17T22:32:32+08:00", [18, 44, 28, 43, 20, 35], 7),
    draw("macau", "2026197", "2026-07-16T22:32:32+08:00", [22, 36, 39, 42, 37, 14], 49),
    draw("macau", "2026196", "2026-07-15T22:32:32+08:00", [38, 45, 15, 25, 43, 37], 27),
    draw("macau", "2026195", "2026-07-14T22:32:32+08:00", [11, 47, 44, 41, 39, 1], 14),
    draw("macau", "2026194", "2026-07-13T22:32:32+08:00", [47, 4, 33, 46, 8, 12], 5),
    draw("macau", "2026193", "2026-07-12T22:32:32+08:00", [23, 38, 21, 31, 6, 44], 35),
  ],
};

function draw(
  game: GameId,
  issue: string,
  drawAt: string,
  numbers: number[],
  special: number,
): Draw {
  return { game, issue, drawAt, numbers, special, source: "本地校验样本", verified: false };
}

export function buildAnalysis(draws: Draw[]): Analysis {
  const safeDraws = draws.filter(isValidDraw);
  const frequency = Array(50).fill(0) as number[];
  const specialFrequency = Array(50).fill(0) as number[];
  const omission = Array(50).fill(safeDraws.length) as number[];
  const waves: Record<Wave, number> = { red: 0, blue: 0, green: 0 };
  const zodiacMap = new Map<string, number>();
  let odd = 0;
  let even = 0;
  let big = 0;
  let small = 0;
  const zones: [number, number, number] = [0, 0, 0];
  let sum = 0;
  let repeatCount = 0;
  let consecutiveCount = 0;

  const seenOmission = new Set<number>();
  safeDraws.forEach((item, drawIndex) => {
    const all = [...item.numbers, item.special];
    const current = new Set(all);
    all.forEach((number) => {
      frequency[number] += 1;
      waves[getWave(number)] += 1;
      zodiacMap.set(getZodiac(number), (zodiacMap.get(getZodiac(number)) ?? 0) + 1);
      if (number % 2) odd += 1;
      else even += 1;
      if (number >= 25) big += 1;
      else small += 1;
      zones[number <= 16 ? 0 : number <= 33 ? 1 : 2] += 1;
      sum += number;
      if (!seenOmission.has(number)) {
        omission[number] = drawIndex;
        seenOmission.add(number);
      }
    });
    specialFrequency[item.special] += 1;
    const sorted = [...item.numbers].sort((a, b) => a - b);
    if (sorted.some((number, index) => index > 0 && number - sorted[index - 1] === 1)) {
      consecutiveCount += 1;
    }
    if (drawIndex < safeDraws.length - 1) {
      const previous = new Set([
        ...safeDraws[drawIndex + 1].numbers,
        safeDraws[drawIndex + 1].special,
      ]);
      if ([...current].some((number) => previous.has(number))) repeatCount += 1;
    }
  });

  const scores: NumberScore[] = Array.from({ length: 49 }, (_, index) => {
    const number = index + 1;
    const frequencyWeight = frequency[number] / Math.max(safeDraws.length * 7, 1);
    const omissionWeight = omission[number] / Math.max(safeDraws.length, 1);
    const specialWeight = specialFrequency[number] / Math.max(safeDraws.length, 1);
    return {
      number,
      frequency: frequency[number],
      specialFrequency: specialFrequency[number],
      omission: omission[number],
      score: round(frequencyWeight * 55 + omissionWeight * 25 + specialWeight * 20),
    };
  });

  const hot = [...scores]
    .sort((a, b) => b.frequency - a.frequency || b.score - a.score || a.number - b.number)
    .slice(0, 8);
  const cold = [...scores]
    .sort((a, b) => a.frequency - b.frequency || b.omission - a.omission || a.number - b.number)
    .slice(0, 8);
  const overdue = [...scores]
    .sort((a, b) => b.omission - a.omission || b.frequency - a.frequency || a.number - b.number)
    .slice(0, 8);

  const candidates = buildCandidateSets(scores);
  const totalBalls = safeDraws.length * 7;
  const dominantWave = (Object.entries(waves) as Array<[Wave, number]>).sort((a, b) => b[1] - a[1])[0];
  const dominantZodiac = [...zodiacMap.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["—", 0];
  const summary = [
    `近 ${safeDraws.length} 期中，${WAVE_LABEL[dominantWave[0]]}占比 ${percent(dominantWave[1], totalBalls)}，为当前样本最高波色。`,
    `${dominantZodiac[0]}肖出现 ${dominantZodiac[1]} 次；热度只描述历史频率，不代表下一期必然延续。`,
    `奇偶比 ${odd}:${even}，大小比 ${big}:${small}，平均单球值 ${round(sum / Math.max(totalBalls, 1))}。`,
  ];

  return {
    sampleSize: safeDraws.length,
    hot,
    cold,
    overdue,
    waves,
    zodiacs: [...zodiacMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    odd,
    even,
    big,
    small,
    zones,
    averageSum: round(sum / Math.max(safeDraws.length, 1)),
    repeatRate: round((repeatCount / Math.max(safeDraws.length - 1, 1)) * 100),
    consecutiveRate: round((consecutiveCount / Math.max(safeDraws.length, 1)) * 100),
    candidates,
    summary,
  };
}

function buildCandidateSets(scores: NumberScore[]): CandidateSet[] {
  const byScore = [...scores].sort((a, b) => b.score - a.score || a.number - b.number);
  const byHot = [...scores].sort(
    (a, b) => b.frequency + b.specialFrequency * 1.5 - (a.frequency + a.specialFrequency * 1.5) || a.number - b.number,
  );
  const byOverdue = [...scores].sort((a, b) => b.omission - a.omission || a.number - b.number);

  const balanced = balancedPick(byScore);
  const momentum = balancedPick(byHot);
  const contrarian = balancedPick(byOverdue);

  return [
    candidate("balanced", "冷热平衡", "频率、遗漏与区间共同加权", balanced),
    candidate("momentum", "趋势延续", "提高近期热码与特码表现权重", momentum),
    candidate("contrarian", "逆向遗漏", "优先观察长遗漏号码并控制结构", contrarian),
  ];
}

function balancedPick(source: NumberScore[]): NumberScore[] {
  const picked: NumberScore[] = [];
  for (const item of source) {
    const zone = item.number <= 16 ? 0 : item.number <= 33 ? 1 : 2;
    const zoneCount = picked.filter((entry) =>
      zone === 0 ? entry.number <= 16 : zone === 1 ? entry.number >= 17 && entry.number <= 33 : entry.number >= 34,
    ).length;
    const parityCount = picked.filter((entry) => entry.number % 2 === item.number % 2).length;
    if (zoneCount >= 3 || parityCount >= 4) continue;
    picked.push(item);
    if (picked.length === 7) break;
  }
  for (const item of source) {
    if (picked.length >= 7) break;
    if (!picked.some((entry) => entry.number === item.number)) picked.push(item);
  }
  return picked;
}

function candidate(
  id: CandidateSet["id"],
  name: string,
  description: string,
  picked: NumberScore[],
): CandidateSet {
  const main = picked.slice(0, 6).map((entry) => entry.number).sort((a, b) => a - b);
  const special = picked[6]?.number ?? picked[0]?.number ?? 1;
  return {
    id,
    name,
    description,
    numbers: main,
    special,
    score: round(picked.reduce((total, entry) => total + entry.score, 0) / Math.max(picked.length, 1)),
  };
}

export function isValidDraw(draw: Draw): boolean {
  const all = [...draw.numbers, draw.special];
  return (
    draw.numbers.length === 6 &&
    all.every((number) => Number.isInteger(number) && number >= 1 && number <= 49) &&
    new Set(all).size === 7
  );
}

export function nextScheduledDraw(game: GameId, from = new Date()): Date {
  const beijing = partsInBeijing(from);
  if (game === "macau") {
    const today = beijingDate(beijing.year, beijing.month, beijing.day, 22, 32);
    return today.getTime() > from.getTime() ? today : addBeijingDays(today, 1, 22, 32);
  }

  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = addBeijingDays(
      beijingDate(beijing.year, beijing.month, beijing.day, 21, 30),
      offset,
      21,
      30,
    );
    const weekday = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" })
        .format(candidate)
        .replace(/Sun|Mon|Tue|Wed|Thu|Fri|Sat/, (value) => String(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value))),
    );
    if ([2, 4, 6].includes(weekday) && candidate.getTime() > from.getTime()) return candidate;
  }
  return addBeijingDays(from, 1, 21, 30);
}

function partsInBeijing(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function beijingDate(year: number, month: number, day: number, hour: number, minute: number) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}

function addBeijingDays(date: Date, amount: number, hour: number, minute: number) {
  const shifted = new Date(date.getTime() + amount * 86_400_000);
  const parts = partsInBeijing(shifted);
  return beijingDate(parts.year, parts.month, parts.day, hour, minute);
}

function percent(value: number, total: number): string {
  return `${round((value / Math.max(total, 1)) * 100)}%`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
