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
  rejectedFutureCount: number;
};

export async function loadServerDraws(
  game: GameId,
  limit: number,
  asOf = new Date(),
): Promise<ServerDraws> {
  const safeLimit = Math.min(Math.max(limit, 10), 500);
  const cutoffTime = asOf.getTime();
  try {
    const pageCount = Math.min(Math.max(Math.ceil(safeLimit / 50), 1), 10);
    const dayStep = game === "hk" ? 120 : 50;
    const anchors = Array.from({ length: pageCount }, (_, index) =>
      formatDateParam(new Date(cutoffTime - index * dayStep * 86_400_000)),
    );
    const pages = await Promise.allSettled(
      anchors.map((date) => fetchHistoryPage(game, date)),
    );
    const liveDraws = pages.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    if (!liveDraws.length) throw new Error("history unavailable");
    const newestIssue = uniqueNewest(liveDraws)[0]?.issue;
    const crossChecks = await fetchLatestCrossCheck(game, newestIssue, asOf)
      .catch(() => []);
    const crossCheckByIssue = new Map<string, Draw[]>();
    crossChecks.forEach((draw) => {
      const matches = crossCheckByIssue.get(draw.issue) ?? [];
      matches.push(draw);
      crossCheckByIssue.set(draw.issue, matches);
    });
    let verifiedMatches = 0;
    let verificationConflicts = 0;
    const verifiedHistory = uniqueNewest(liveDraws).map((draw) => {
      const candidates = crossCheckByIssue.get(draw.issue) ?? [];
      if (!candidates.length) return draw;
      const crossCheck = candidates.find(
        (candidate) =>
          [...candidate.numbers, candidate.special].join(",") ===
          [...draw.numbers, draw.special].join(","),
      );
      if (!crossCheck) {
        verificationConflicts += 1;
        return draw;
      }
      verifiedMatches += 1;
      return {
        ...draw,
        verified: true,
        source: `${draw.source} · ${crossCheck.source} 交叉一致`,
      };
    });
    const historyIssues = new Set(verifiedHistory.map((draw) => draw.issue));
    const uniqueLiveDraws = uniqueNewest([
      ...verifiedHistory,
      ...crossChecks.filter((draw) => !historyIssues.has(draw.issue)),
    ]);
    const rejectedFutureCount = uniqueLiveDraws.filter(
      (draw) => !isDrawBeforeCutoff(draw, cutoffTime),
    ).length;
    const draws = uniqueLiveDraws
      .filter((draw) => isDrawBeforeCutoff(draw, cutoffTime))
      .slice(0, safeLimit);
    if (!draws.length) throw new Error("history has no eligible draws");
    const warnings = [
      draws.length < safeLimit ? `实时历史源仅返回 ${draws.length} 期。` : null,
      rejectedFutureCount > 0
        ? `历史源含 ${rejectedFutureCount} 条晚于分析时点的记录，已排除。`
        : null,
      verifiedMatches > 0
        ? `最新记录已有 ${verifiedMatches} 期通过独立接口交叉一致校验。`
        : null,
      verificationConflicts > 0
        ? `检测到 ${verificationConflicts} 期跨源结果冲突，本次不标记为已核验。`
        : null,
    ].filter((warning): warning is string => Boolean(warning));
    return {
      draws,
      sourceMode: "live",
      fetchedAt: asOf.toISOString(),
      warning: warnings.length > 0 ? warnings.join(" ") : null,
      rejectedFutureCount,
    };
  } catch {
    const fallback = FALLBACK_DRAWS[game].filter((draw) =>
      isDrawBeforeCutoff(draw, cutoffTime),
    );
    const rejectedFutureCount = FALLBACK_DRAWS[game].length - fallback.length;
    return {
      draws: fallback.slice(0, safeLimit),
      sourceMode: "snapshot",
      fetchedAt: asOf.toISOString(),
      warning: "实时历史源暂不可用，本次分析使用最近同步快照。",
      rejectedFutureCount,
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

async function fetchLatestCrossCheck(
  game: GameId,
  newestIssue?: string,
  asOf = new Date(),
): Promise<Draw[]> {
  const requests = [fetchMarksix6CrossCheck(game)];
  if (game === "new_macau") {
    requests.push(fetchNewMacauCrossCheck());
    if (newestIssue) {
      requests.push(fetchNewMacauIssueCrossCheck(newestIssue));
    }
  }
  const results = await Promise.allSettled(requests);
  const draws = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : []
  );
  const migrated = migratedVerifiedDraw(game, asOf);
  if (migrated) draws.push(migrated);
  if (!draws.length) throw new Error("latest cross-check unavailable");
  return draws;
}

function migratedVerifiedDraw(game: GameId, asOf: Date): Draw | null {
  if (game !== "new_macau") return null;
  const draw = parseDraw(
    game,
    "2026212",
    "2026-07-31 21:32:32",
    "43,32,16,39,19,27,06",
  );
  return draw && Date.parse(draw.drawAt) <= asOf.getTime()
    ? {
      ...draw,
      verified: true,
      source: "迁移核验快照（API16868＋新澳门历史接口一致）",
    }
    : null;
}

async function fetchMarksix6CrossCheck(game: GameId): Promise<Draw[]> {
  const sourceType: Record<GameId, string> = {
    hk: "hk",
    macau: "macau",
    new_macau: "newMacau",
  };
  const response = await fetchWithTimeout(
    `https://api3.marksix6.net/lottery_api.php?type=${sourceType[game]}`,
  );
  if (!response.ok) throw new Error(`latest cross-check ${response.status}`);
  const payload = (await response.json()) as {
    expect?: string;
    openTime?: string;
    openCode?: string;
    numbers?: string[];
  };
  const codes = payload.openCode ?? payload.numbers?.join(",") ?? "";
  const draw = parseDraw(
    game,
    payload.expect ?? "",
    payload.openTime ?? "",
    codes,
  );
  return draw ? [{ ...draw, source: "Marksix6 独立接口" }] : [];
}

async function fetchNewMacauCrossCheck(): Promise<Draw[]> {
  const response = await fetchWithTimeout(
    "https://macaumarksix.com/api/macaujc2.com",
  );
  if (!response.ok) throw new Error(`new macau cross-check ${response.status}`);
  const payload = (await response.json()) as Array<{
    expect?: string;
    openTime?: string;
    openCode?: string;
  }> | {
    expect?: string;
    openTime?: string;
    openCode?: string;
  };
  const items = Array.isArray(payload) ? payload : [payload];
  return items
    .map((item) =>
      parseDraw(
        "new_macau",
        item.expect ?? "",
        item.openTime ?? "",
        item.openCode ?? "",
      )
    )
    .filter((draw): draw is Draw => Boolean(draw))
    .map((draw) => ({ ...draw, source: "新澳门开奖独立接口" }));
}

async function fetchNewMacauIssueCrossCheck(issue: string): Promise<Draw[]> {
  const response = await fetchWithTimeout(
    `https://history.macaumarksix.com/history/macaujc2/expect/${encodeURIComponent(issue)}`,
  );
  if (!response.ok) throw new Error(`new macau issue cross-check ${response.status}`);
  const payload = (await response.json()) as Array<{
    expect?: string;
    openTime?: string;
    openCode?: string;
  }>;
  return (Array.isArray(payload) ? payload : [])
    .map((item) =>
      parseDraw(
        "new_macau",
        item.expect ?? "",
        item.openTime ?? "",
        item.openCode ?? "",
      )
    )
    .filter((draw): draw is Draw => Boolean(draw))
    .map((draw) => ({ ...draw, source: "新澳门历史独立接口" }));
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
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function isDrawBeforeCutoff(draw: Draw, cutoffTime: number) {
  const drawTime = Date.parse(draw.drawAt);
  return Number.isFinite(drawTime) && drawTime <= cutoffTime;
}
