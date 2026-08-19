import { FALLBACK_DRAWS, isValidDraw, type Draw, type GameId } from "./lottery.ts";

const API_CODES: Record<GameId, number> = {
  hk: 10091,
  macau: 10093,
  new_macau: 10092,
};

const HKJC_QUERY = `fragment lotteryDrawsFragment on LotteryDraw {
  id year no openDate closeDate drawDate status
  drawResult { drawnNo xDrawnNo }
}
query marksixResult($lastNDraw: Int, $startDate: String, $endDate: String, $drawType: LotteryDrawType) {
  lotteryDraws(lastNDraw: $lastNDraw, startDate: $startDate, endDate: $endDate, drawType: $drawType) {
    ...lotteryDrawsFragment
  }
}`;

export type ServerDraws = {
  draws: Draw[];
  sourceMode: "live" | "snapshot";
  fetchedAt: string;
  warning: string | null;
  rejectedFutureCount: number;
  conflictCount: number;
  missingIssueCount: number;
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
    const crossCheckConsensus = [...crossCheckByIssue.values()].map((rawCandidates) => {
      const candidates = uniqueBySourceAndResult(rawCandidates);
      const signatures = new Set(candidates.map(drawSignature));
      const sources = new Set(candidates.map((candidate) => candidate.source));
      if (signatures.size !== 1) {
        return { ...candidates[0], verified: false };
      }
      if (sources.size < 2) {
        return candidates.find((candidate) => candidate.verified) ?? {
          ...candidates[0],
          verified: false,
        };
      }
      return {
        ...candidates[0],
        verified: true,
        source: `${[...sources].join("＋")} 交叉一致`,
      };
    });
    let verifiedMatches = 0;
    let verificationConflicts = 0;
    const verifiedHistory = uniqueNewest(liveDraws).map((draw) => {
      const candidates = uniqueBySourceAndResult(
        crossCheckByIssue.get(draw.issue) ?? [],
      );
      if (!candidates.length) return draw;
      const signature = drawSignature(draw);
      const conflicting = candidates.some(
        (candidate) => drawSignature(candidate) !== signature,
      );
      const agreeing = candidates.filter(
        (candidate) => drawSignature(candidate) === signature,
      );
      if (conflicting || !agreeing.length) {
        verificationConflicts += 1;
        return draw;
      }
      verifiedMatches += 1;
      return {
        ...draw,
        verified: true,
        source: `${draw.source} · ${agreeing.map((candidate) => candidate.source).join("＋")} 交叉一致`,
      };
    });
    const historyIssues = new Set(verifiedHistory.map((draw) => draw.issue));
    const uniqueLiveDraws = uniqueNewest([
      ...verifiedHistory,
      ...crossCheckConsensus.filter((draw) => !historyIssues.has(draw.issue)),
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
        ? `最新记录已有 ${verifiedMatches} 期达到多源一致；这表示来源相互吻合，不等同于官方认证。`
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
      conflictCount: verificationConflicts,
      missingIssueCount: countIssueGaps(draws),
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
      conflictCount: 0,
      missingIssueCount: countIssueGaps(fallback),
    };
  }
}

function countIssueGaps(draws: Draw[]) {
  const byYear = new Map<string, Set<number>>();
  for (const draw of draws) {
    if (!/^\d{7,}$/.test(draw.issue)) continue;
    const year = draw.issue.slice(0, 4);
    const sequence = Number(draw.issue.slice(4));
    if (!Number.isInteger(sequence)) continue;
    const values = byYear.get(year) ?? new Set<number>();
    values.add(sequence);
    byYear.set(year, values);
  }
  let gaps = 0;
  for (const values of byYear.values()) {
    const ordered = [...values].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      gaps += Math.max(0, ordered[index] - ordered[index - 1] - 1);
    }
  }
  return gaps;
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
  if (game === "hk") {
    requests.push(fetchHkjcCrossCheck(500));
    requests.push(fetchKj1868HongKongCrossCheck());
  }
  if (game === "new_macau") {
    requests.push(fetchNewMacauCrossCheck());
    requests.push(fetchNewMacauYearCrossCheck(asOf));
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

async function fetchKj1868HongKongCrossCheck(): Promise<Draw[]> {
  const response = await fetchWithTimeout(
    "https://www.kj1868.cc/openapi/drawLottery/xg6/last.kj?page=1&pageSize=10",
  );
  if (!response.ok) throw new Error(`KJ1868 cross-check ${response.status}`);
  const payload = (await response.json()) as {
    status?: string;
    data?: {
      data?: Array<{ period?: string; lottery_date?: string; numbers?: string }>;
    };
  };
  if (payload.status !== "10") throw new Error("KJ1868 cross-check response invalid");
  return (payload.data?.data ?? [])
    .map((item) =>
      parseDraw(
        "hk",
        item.period ?? "",
        item.lottery_date ? `${item.lottery_date} 21:30:00` : "",
        item.numbers ?? "",
      )
    )
    .filter((draw): draw is Draw => Boolean(draw))
    .map((draw) => ({ ...draw, source: "开奖1868 香港独立接口" }));
}

async function fetchHkjcCrossCheck(limit: number): Promise<Draw[]> {
  const response = await fetchWithTimeout("https://info.cld.hkjc.com/graphql/base/", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      operationName: "marksixResult",
      variables: { lastNDraw: limit },
      query: HKJC_QUERY,
    }),
  });
  if (!response.ok) throw new Error(`HKJC cross-check ${response.status}`);
  const payload = (await response.json()) as {
    data?: {
      lotteryDraws?: Array<{
        year?: string;
        no?: number;
        drawDate?: string;
        drawResult?: { drawnNo?: number[]; xDrawnNo?: number };
      }>;
    };
  };
  return (payload.data?.lotteryDraws ?? [])
    .map((item) => {
      const date = item.drawDate?.slice(0, 10) ?? "";
      return parseDraw(
        "hk",
        item.year && item.no != null
          ? `${item.year}${String(item.no).padStart(3, "0")}`
          : "",
        date ? `${date} 21:30:00` : "",
        [...(item.drawResult?.drawnNo ?? []), item.drawResult?.xDrawnNo ?? 0].join(","),
      );
    })
    .filter((draw): draw is Draw => Boolean(draw))
    .map((draw) => ({ ...draw, verified: true, source: "香港赛马会官方" }));
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
  }> | {
    data?: Array<{
      expect?: string;
      openTime?: string;
      openCode?: string;
    }>;
  };
  const items = Array.isArray(payload) ? payload : payload.data ?? [];
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
    .map((draw) => ({ ...draw, source: "新澳门历史独立接口" }));
}

async function fetchNewMacauYearCrossCheck(asOf: Date): Promise<Draw[]> {
  const year = Number(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).format(asOf));
  const responses = await Promise.allSettled(
    [year, year - 1].map((value) =>
      fetchWithTimeout(
        `https://history.macaumarksix.com/history/macaujc2/y/${value}`,
      )
    ),
  );
  const payloads = await Promise.all(
    responses.map(async (result) => {
      if (result.status !== "fulfilled" || !result.value.ok) return [];
      const payload = (await result.value.json()) as {
        data?: Array<{
          expect?: string;
          openTime?: string;
          openCode?: string;
        }>;
      };
      return payload.data ?? [];
    }),
  );
  const parsed = payloads.flat()
    .map((item) =>
      parseDraw(
        "new_macau",
        item.expect ?? "",
        item.openTime ?? "",
        item.openCode ?? "",
      )
    )
    .filter((draw): draw is Draw => Boolean(draw))
    .map((draw) => ({ ...draw, source: "新澳门年度历史独立接口" }));
  return uniqueBySourceAndResult(parsed);
}

function uniqueBySourceAndResult(draws: Draw[]): Draw[] {
  return [...new Map(draws.map((draw) => [
    `${draw.issue}:${draw.source}:${drawSignature(draw)}`,
    draw,
  ])).values()];
}

function drawSignature(draw: Draw) {
  return [...draw.numbers, draw.special].join(",");
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

async function fetchWithTimeout(input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(input, {
      ...init,
      cache: "no-store",
      headers: { accept: "application/json", ...init.headers },
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
