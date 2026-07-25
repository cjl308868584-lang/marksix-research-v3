export const ZODIAC_NAMES = [
  "鼠",
  "牛",
  "虎",
  "兔",
  "龙",
  "蛇",
  "马",
  "羊",
  "猴",
  "鸡",
  "狗",
  "猪",
] as const;

export type Zodiac = (typeof ZODIAC_NAMES)[number];

const LUNAR_NEW_YEAR: Record<number, string> = {
  2020: "2020-01-25",
  2021: "2021-02-12",
  2022: "2022-02-01",
  2023: "2023-01-22",
  2024: "2024-02-10",
  2025: "2025-01-29",
  2026: "2026-02-17",
  2027: "2027-02-06",
  2028: "2028-01-26",
  2029: "2029-02-13",
  2030: "2030-02-03",
};

export function getZodiac(number: number, drawAt?: string): Zodiac {
  const dateKey = drawAt?.slice(0, 10) ?? beijingDateKey(new Date());
  let zodiacYear = Number(dateKey.slice(0, 4)) || 2026;
  const newYear = LUNAR_NEW_YEAR[zodiacYear];
  if (newYear && dateKey < newYear) zodiacYear -= 1;
  const yearAnimalIndex = ((zodiacYear - 2020) % 12 + 12) % 12;
  const offset = (number - 1) % 12;
  return ZODIAC_NAMES[
    (yearAnimalIndex - offset + ZODIAC_NAMES.length) %
      ZODIAC_NAMES.length
  ];
}

function beijingDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const read = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return [
    read("year"),
    String(read("month")).padStart(2, "0"),
    String(read("day")).padStart(2, "0"),
  ].join("-");
}
