import { FALLBACK_DRAWS, isValidDraw, type Draw, type GameId } from "./lottery";

const API_CODES: Record<GameId, number> = {
  hk: 10091,
  macau: 10093,
  new_macau: 10092,
};

export type ServerDraws = {
  draws: Draw[];
  sourceMode: "live" | "snapshot";
  fetchedAt: string;
  warning: string | null;
};

export async function loadServerDraws(game: GameId, limit: number): Promise<ServerDraws> {
  const safeLimit = Math.min(Math.max(limit, 10), 100);
  try {
    const pageCount = Math.min(Math.max(Math.ceil(safeLimit / 50), 1), 2);
    const dayStep = game === "hk" ? 120 : 50;
    const anchors = Array.from({ length: pageCount }, (_, index) =>
      formatDateParam(new Date(Date.now() - index * dayStep * 86_400_000)),
    );
    const pages = await Promise.allSettled(
      anchors.map((date) => fetchHistoryPage(game, date)),
    );
    const liveDraws = pages.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    if (!liveDraws.length) throw new Error("history unavailable");
    const draws = uniqueNewest(liveDraws).slice(0, safeLimit);
    return {
      draws,
      sourceMode: "live",
      fetchedAt: new Date().toISOString(),
      warning: draws.length < safeLimit ? `实时历史源仅返回 ${draws.length} 期。` : null,
    };
  } catch {
    return {
      draws: FALLBACK_DRAWS[game].slice(0, safeLimit),
      sourceMode: "snapshot",
      fetchedAt: new Date().toISOString(),
      warning: "实时历史源暂不可用，本次分析使用最近同步快照。",
    };
  }
}

async function fetchHistoryPage(game: GameId, date: string): Promise<Draw[]> {
  const response = await fetchWithTimeout(
    `https://api.api16868.com/6hc/getHistoryLotteryInfo.do?lotCode=${API_CODES[game]}&date=${date}`,
  );
  if (!response.ok) throw new Error(`history ${response.status}`);
  const payload = (await response.json()) as {
    errorCode?: number;
    result?: {
      data?: Array<{
        preDrawIssue?: number | string;
        preDrawTime?: string;
        preDrawCode?: string;
      }>;
    };
  };
  if (payload.errorCode !== 0) throw new Error("history response invalid");
  return (payload.result?.data ?? [])
    .map((item) =>
      parseDraw(
        game,
        String(item.preDrawIssue ?? ""),
        item.preDrawTime ?? "",
        item.preDrawCode ?? "",
      ),
    )
    .filter((item): item is Draw => Boolean(item));
}

function parseDraw(game: GameId, issue: string, drawAt: string, code: string): Draw | null {
  const values = code
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
  if (!issue || values.length < 7) return null;
  const localTime = drawAt.includes("T") ? drawAt : drawAt.replace(" ", "T");
  const normalizedTime = /[zZ]|[+-]\d\d:\d\d$/.test(localTime)
    ? localTime
    : `${localTime}+08:00`;
  const result: Draw = {
    game,
    issue,
    drawAt: normalizedTime,
    numbers: values.slice(0, 6),
    special: values[6],
    source: "168开奖 API",
    verified: false,
  };
  return isValidDraw(result) ? result : null;
}

function uniqueNewest(draws: Draw[]): Draw[] {
  return [...new Map(draws.map((draw) => [`${draw.game}:${draw.issue}`, draw])).values()]
    .sort((a, b) => b.issue.localeCompare(a.issue, "en", { numeric: true }));
}

function formatDateParam(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function fetchWithTimeout(input: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(input, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
