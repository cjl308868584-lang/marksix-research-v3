import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const games = [
  { id: "hk", code: 10091, dayStep: 120 },
  { id: "macau", code: 10093, dayStep: 50 },
  { id: "new_macau", code: 10092, dayStep: 50 },
];

const output = {};

for (const game of games) {
  const rows = [0, game.dayStep].flatMap((daysAgo) => {
    const date = new Date(Date.now() - daysAgo * 86_400_000);
    const dateParam = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    const url =
      `https://api.api16868.com/6hc/getHistoryLotteryInfo.do?lotCode=${game.code}` +
      `&date=${dateParam}`;
    const payload = JSON.parse(
      execFileSync("curl", ["-fsSL", "--max-time", "25", url], {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
    if (payload.errorCode !== 0 || !Array.isArray(payload.result?.data)) {
      throw new Error(`History source returned invalid data for ${game.id}`);
    }
    return payload.result.data;
  });

  output[game.id] = [
    ...new Map(
      rows
        .map((row) => {
          const values = String(row.preDrawCode ?? "")
            .split(",")
            .map((value) => Number(value.trim()));
          if (
            values.length < 7 ||
            values.some((value) => !Number.isInteger(value) || value < 1 || value > 49) ||
            new Set(values.slice(0, 7)).size !== 7
          ) {
            return null;
          }
          return {
            game: game.id,
            issue: String(row.preDrawIssue ?? ""),
            drawAt: `${String(row.preDrawTime ?? "").replace(" ", "T")}+08:00`,
            numbers: values.slice(0, 6),
            special: values[6],
            source: "168开奖 API 本地快照",
            verified: false,
          };
        })
        .filter(Boolean)
        .map((draw) => [`${draw.game}:${draw.issue}`, draw]),
    ).values(),
  ]
    .sort((a, b) => b.issue.localeCompare(a.issue, "en", { numeric: true }))
    .slice(0, 100);
}

const target = resolve("lib/lottery-history.json");
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`);

for (const game of games) {
  const latest = output[game.id][0];
  console.log(`${game.id}: ${output[game.id].length} draws, latest ${latest?.issue ?? "none"}`);
}
