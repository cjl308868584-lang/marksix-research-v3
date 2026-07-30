import { NextRequest, NextResponse } from "next/server";
import {
  FALLBACK_DRAWS,
  type Draw,
  type GameId,
  type LiveDrawProgress,
  isValidDraw,
  nextScheduledDraw,
} from "../../../lib/lottery";
import { settleResearchForecasts } from "../../../lib/research-v2-store";
import { settleResearchV3Forecasts } from "../../../lib/research-v3-store";

export const dynamic = "force-dynamic";

const API16868_CODES: Record<GameId, number> = {
  hk: 10091,
  macau: 10093,
  new_macau: 10092,
};

const LIVE_MICRO_CACHE_MS = 2_000;

type LotteryResponse = {
  game: GameId;
  draws: Draw[];
  progress: LiveDrawProgress | null;
  live: boolean;
  degraded: boolean;
  message: string;
  fetchedAt: string;
};

type LiveCacheEntry = {
  expiresAt: number;
  promise: Promise<LotteryResponse>;
};

type LiveSourceResult =
  | { kind: "history"; draws: Draw[] }
  | { kind: "progress"; progress: LiveDrawProgress | null };

const liveResponseCache = new Map<string, LiveCacheEntry>();
const settledResearchIssues = new Set<string>();

const HKJC_QUERY = `fragment lotteryDrawsFragment on LotteryDraw {
  id year no openDate closeDate drawDate status
  drawResult { drawnNo xDrawnNo }
}
query marksixResult($lastNDraw: Int, $startDate: String, $endDate: String, $drawType: LotteryDrawType) {
  lotteryDraws(lastNDraw: $lastNDraw, startDate: $startDate, endDate: $endDate, drawType: $drawType) {
    ...lotteryDrawsFragment
  }
}`;

export async function GET(request: NextRequest) {
  const requestedGame = request.nextUrl.searchParams.get("game");
  if (requestedGame && requestedGame !== "hk" && requestedGame !== "new_macau") {
    return NextResponse.json(
      { error: "当前仅支持香港与新澳门彩种。" },
      {
        status: 400,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  }
  const game: GameId = requestedGame === "hk" ? "hk" : "new_macau";
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 60), 3), 120);
  const liveRequest = request.nextUrl.searchParams.get("live") === "1";

  try {
    const result =
      liveRequest
        ? await getCachedLiveDraws(game, limit)
        : game === "hk"
          ? await getHongKongDraws(limit)
          : await getNewMacauDraws(limit);
    await settleLatestResearch(game, result.draws);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": liveRequest
          ? "private, no-store, max-age=0"
          : "public, s-maxage=30, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        game,
        draws: FALLBACK_DRAWS[game],
        live: false,
        degraded: true,
        message: `实时数据源暂不可用，当前展示最近一次同步的 ${FALLBACK_DRAWS[game].length} 期历史快照。`,
        fetchedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "unknown",
      },
      {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  }
}

async function settleLatestResearch(game: GameId, draws: Draw[]) {
  const latestVerified = draws.find((draw) => draw.verified);
  if (!latestVerified) return;
  const key = `${game}:${latestVerified.issue}`;
  if (settledResearchIssues.has(key)) return;
  settledResearchIssues.add(key);
  const settledAt = new Date().toISOString();
  const [legacyStatus, v3Status] = await Promise.all([
    settleResearchForecasts(game, draws, settledAt),
    settleResearchV3Forecasts(game, draws, settledAt),
  ]);
  if (legacyStatus !== "ok" || v3Status !== "ok") {
    settledResearchIssues.delete(key);
  }
  if (settledResearchIssues.size > 12) {
    const oldest = settledResearchIssues.values().next().value;
    if (typeof oldest === "string") settledResearchIssues.delete(oldest);
  }
}

function getCachedLiveDraws(game: GameId, limit: number) {
  const key = `${game}:${limit}`;
  const cached = liveResponseCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = getLiveDraws(game, limit);
  const entry: LiveCacheEntry = {
    expiresAt: Number.POSITIVE_INFINITY,
    promise,
  };
  liveResponseCache.set(key, entry);
  void promise.then(
    () => {
      if (liveResponseCache.get(key) === entry) {
        entry.expiresAt = Date.now() + LIVE_MICRO_CACHE_MS;
      }
    },
    () => {
      if (liveResponseCache.get(key) === entry) liveResponseCache.delete(key);
    },
  );
  return promise;
}

async function getLiveDraws(game: GameId, limit: number): Promise<LotteryResponse> {
  const liveWindow = getApiLiveWindow(game, new Date());
  if (!liveWindow.visible) {
    const draws = await fetchApi16868(game, limit);
    return makeLiveResponse(game, draws, null, liveWindow, limit);
  }

  const historyRequest: Promise<LiveSourceResult> = fetchApi16868(game, limit)
    .then((draws) => ({ kind: "history" as const, draws }))
    .catch(() => ({ kind: "history" as const, draws: [] }));
  const progressRequest: Promise<LiveSourceResult> = fetchMarksixProgress(game, 2_500)
    .then((progress) => ({ kind: "progress" as const, progress }))
    .catch(() => ({ kind: "progress" as const, progress: null }));

  const first = await Promise.race([historyRequest, progressRequest]);
  let draws = first.kind === "history" ? first.draws : [];
  let progress = first.kind === "progress" ? first.progress : null;

  if (
    progress &&
    isProgressForTarget(progress, liveWindow.target, draws[0])
  ) {
    const completed = progressToDraw(progress);
    if (completed) draws = mergeDrawBatches([draws, [completed]]);
    return makeLiveResponse(game, draws, progress, liveWindow, limit);
  }
  if (draws[0] && isDrawForTarget(draws[0], liveWindow.target)) {
    return makeLiveResponse(game, draws, null, liveWindow, limit);
  }

  const second = await (first.kind === "history" ? progressRequest : historyRequest);
  if (second.kind === "history") draws = second.draws;
  else progress = second.progress;

  if (
    progress &&
    isProgressForTarget(progress, liveWindow.target, draws[0])
  ) {
    const completed = progressToDraw(progress);
    if (completed) draws = mergeDrawBatches([draws, [completed]]);
    return makeLiveResponse(game, draws, progress, liveWindow, limit);
  }

  if (!draws[0] || !isDrawForTarget(draws[0], liveWindow.target)) {
    const alternatives: Array<Promise<Draw[]>> =
      game === "hk"
        ? [fetchHkjc(limit), fetchKj1868("xg6", "hk", limit)]
        : [];
    if (alternatives.length) {
      const alternate = await firstNonEmpty(alternatives).catch(() => []);
      draws = mergeDrawBatches([draws, alternate]);
    }
  }

  return makeLiveResponse(game, draws, null, liveWindow, limit);
}

function makeLiveResponse(
  game: GameId,
  draws: Draw[],
  progress: LiveDrawProgress | null,
  liveWindow: ReturnType<typeof getApiLiveWindow>,
  limit: number,
): LotteryResponse {
  const checked = draws.slice(0, limit);
  if (!checked.length && !progress) throw new Error("live source returned no draws");
  const resultIsCurrent = checked[0]
    ? isDrawForTarget(checked[0], liveWindow.target)
    : false;
  const currentProgress =
    progress && isProgressForTarget(progress, liveWindow.target, checked[0])
      ? progress
      : null;
  const awaitingCurrent =
    liveWindow.visible && !resultIsCurrent && !currentProgress;

  return {
    game,
    draws: checked,
    progress: currentProgress,
    live: true,
    degraded: awaitingCurrent,
    message: currentProgress
      ? currentProgress.special === null
        ? `${currentProgress.source} 已返回本期 ${currentProgress.numbers.length} 个正码，正在逐项更新。`
        : `${currentProgress.source} 已获取本期完整结果。`
      : awaitingCurrent
        ? "高频检测已开启，正在等待本期开奖源发布。"
        : `${checked[0]?.source ?? "实时源"} 已获取本期完整结果。`,
    fetchedAt: new Date().toISOString(),
  };
}

async function getHongKongDraws(limit: number) {
  const [official, secondary, apiHistory, latestCheck] = await Promise.allSettled([
    fetchHkjc(limit),
    fetchKj1868("xg6", "hk", limit),
    fetchApi16868("hk", limit),
    fetchMarksixLatest("hk"),
  ]);

  const officialDraws = fulfilled(official);
  const secondaryDraws = fulfilled(secondary);
  const historyDraws = fulfilled(apiHistory);
  const latest = fulfilled(latestCheck);
  const base = officialDraws.length
    ? officialDraws
    : historyDraws.length
      ? historyDraws
      : secondaryDraws.length
        ? secondaryDraws
        : FALLBACK_DRAWS.hk;
  const merged = mergeLatest(base, latest[0]);
  const checked = markVerified(merged, [
    officialDraws[0],
    historyDraws[0],
    secondaryDraws[0],
    latest[0],
  ]);

  return {
    game: "hk" as const,
    draws: checked.slice(0, limit),
    live: officialDraws.length > 0 || historyDraws.length > 0 || secondaryDraws.length > 0,
    degraded: officialDraws.length === 0,
    message: officialDraws.length
      ? `香港赛马会数据已接入，并由备用来源交叉核验；当前载入 ${checked.length} 期。`
      : historyDraws.length
        ? `香港赛马会接口当前受访问策略限制，已切换免费历史 API；当前载入 ${checked.length} 期。`
        : secondaryDraws.length
          ? "香港赛马会接口当前受访问策略限制，已切换备用开奖 API。"
        : `实时开奖源暂不可达，当前使用最近一次同步的 ${FALLBACK_DRAWS.hk.length} 期历史快照。`,
    fetchedAt: new Date().toISOString(),
  };
}

async function getNewMacauDraws(limit: number) {
  const [historySource, latestSource] = await Promise.allSettled([
    fetchApi16868("new_macau", limit),
    fetchMarksixLatest("new_macau"),
  ]);
  const history = fulfilled(historySource);
  const latest = fulfilled(latestSource)[0];
  const base = history.length ? history : FALLBACK_DRAWS.new_macau;
  const merged = mergeLatest(base, latest);
  const checked = markVerified(merged, [history[0], latest]);

  return {
    game: "new_macau" as const,
    draws: checked.slice(0, limit),
    live: history.length > 0 || Boolean(latest),
    degraded: history.length === 0,
    message: history.length
      ? `新澳门彩免费历史 API 已接入，当前载入 ${checked.length} 期；最新第 ${checked[0]?.issue ?? "—"} 期。`
      : `新澳门彩实时数据源暂不可达，当前展示最近一次同步的 ${FALLBACK_DRAWS.new_macau.length} 期历史快照。`,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchApi16868(game: GameId, limit: number): Promise<Draw[]> {
  const pageCount = Math.min(Math.max(Math.ceil(limit / 50), 1), 3);
  const dayStep = game === "hk" ? 120 : 50;
  const anchors = Array.from({ length: pageCount }, (_, index) =>
    formatDateParam(new Date(Date.now() - index * dayStep * 86_400_000)),
  );
  const pageResults = await Promise.allSettled(
    anchors.map(async (date) => {
      const response = await fetchWithTimeout(
        `https://api.api16868.com/6hc/getHistoryLotteryInfo.do?lotCode=${API16868_CODES[game]}&date=${date}`,
        { headers: { accept: "application/json" } },
      );
      if (!response.ok) throw new Error(`API16868 ${response.status}`);
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
      if (payload.errorCode !== 0) throw new Error("API16868 response invalid");
      return payload.result?.data ?? [];
    }),
  );
  const pages = pageResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (!pages.length) throw new Error("API16868 unavailable");
  const draws = pages
    .flat()
    .map((item) =>
      parseDraw(
        game,
        String(item.preDrawIssue ?? ""),
        item.preDrawTime ?? "",
        item.preDrawCode ?? "",
        "168开奖 API",
      ),
    )
    .filter((item): item is Draw => Boolean(item));
  return [...new Map(draws.map((item) => [`${item.game}:${item.issue}`, item])).values()]
    .sort(byNewest)
    .slice(0, limit);
}

async function fetchHkjc(limit: number): Promise<Draw[]> {
  const response = await fetchWithTimeout("https://info.cld.hkjc.com/graphql/base/", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      operationName: "marksixResult",
      variables: { lastNDraw: limit },
      query: HKJC_QUERY,
    }),
  });
  if (!response.ok) throw new Error(`HKJC ${response.status}`);
  const payload = (await response.json()) as {
    data?: {
      lotteryDraws?: Array<{
        year: string;
        no: number;
        drawDate: string;
        drawResult?: { drawnNo?: number[]; xDrawnNo?: number };
      }>;
    };
  };
  return (payload.data?.lotteryDraws ?? [])
    .map((item) => ({
      game: "hk" as const,
      issue: `${item.year}${String(item.no).padStart(3, "0")}`,
      drawAt: `${item.drawDate.replace("+08:00", "")}T21:30:00+08:00`,
      numbers: item.drawResult?.drawnNo ?? [],
      special: item.drawResult?.xDrawnNo ?? 0,
      source: "香港赛马会",
      verified: false,
    }))
    .filter(isValidDraw)
    .sort(byNewest);
}

async function fetchKj1868(code: string, game: GameId, limit: number): Promise<Draw[]> {
  const response = await fetchWithTimeout(
    `https://www.kj1868.cc/openapi/drawLottery/${code}/last.kj?page=1&pageSize=${limit}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`KJ1868 ${response.status}`);
  const payload = (await response.json()) as {
    status?: string;
    data?: { data?: Array<{ period: string; lottery_date: string; numbers: string }> };
  };
  if (payload.status !== "10") throw new Error("KJ1868 response invalid");
  return (payload.data?.data ?? [])
    .map((item) => parseDraw(game, item.period, item.lottery_date, item.numbers, "开奖1868"))
    .filter((item): item is Draw => Boolean(item))
    .sort(byNewest);
}

type MarksixLatestPayload = {
  expect?: string;
  openTime?: string;
  openCode?: string;
  numbers?: string[];
};

async function fetchMarksixPayload(
  game: GameId,
  timeoutMs = 8_000,
): Promise<MarksixLatestPayload> {
  const sourceType: Record<GameId, string> = {
    hk: "hk",
    macau: "macau",
    new_macau: "newMacau",
  };
  const response = await fetchWithTimeout(
    `https://api3.marksix6.net/lottery_api.php?type=${sourceType[game]}`,
    { headers: { accept: "application/json" } },
    timeoutMs,
  );
  if (!response.ok) throw new Error(`Marksix6 ${response.status}`);
  return (await response.json()) as MarksixLatestPayload;
}

async function fetchMarksixLatest(game: GameId): Promise<Draw[]> {
  const payload = await fetchMarksixPayload(game);
  const codes = payload.openCode ?? payload.numbers?.join(",") ?? "";
  const parsed = parseDraw(game, payload.expect ?? "", payload.openTime ?? "", codes, "Marksix6 API");
  return parsed ? [parsed] : [];
}

async function fetchMarksixProgress(
  game: GameId,
  timeoutMs: number,
): Promise<LiveDrawProgress | null> {
  const payload = await fetchMarksixPayload(game, timeoutMs);
  const code = payload.openCode ?? payload.numbers?.join(",") ?? "";
  const values = code
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(
      (value, index, all) =>
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 49 &&
        all.indexOf(value) === index,
    )
    .slice(0, 7);
  if (!payload.expect || !payload.openTime || !values.length) return null;
  return {
    game,
    issue: payload.expect,
    drawAt: normalizeDrawAt(game, payload.openTime ?? ""),
    numbers: values.slice(0, 6),
    special: values.length >= 7 ? values[6] : null,
    source: "Marksix6 实时源",
  };
}

function parseDraw(
  game: GameId,
  issue: string,
  date: string,
  code: string,
  source: string,
): Draw | null {
  const values = code
    .split(",")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
  if (!issue || values.length < 7) return null;
  const result: Draw = {
    game,
    issue,
    drawAt: normalizeDrawAt(game, date),
    numbers: values.slice(0, 6),
    special: values[6],
    source,
    verified: false,
  };
  return isValidDraw(result) ? result : null;
}

function normalizeDrawAt(game: GameId, date: string) {
  const dateValue = date || formatDateParam(new Date());
  const time = dateValue.includes("T")
    ? dateValue
    : dateValue.includes(" ")
      ? dateValue.replace(" ", "T")
      : `${dateValue}T${
          game === "macau" ? "22:32:00" : game === "new_macau" ? "21:32:00" : "21:30:00"
        }`;
  return /[zZ]|[+-]\d\d:\d\d$/.test(time) ? time : `${time}+08:00`;
}

function progressToDraw(progress: LiveDrawProgress): Draw | null {
  if (progress.numbers.length !== 6 || progress.special === null) return null;
  const draw: Draw = {
    ...progress,
    special: progress.special,
    verified: false,
  };
  return isValidDraw(draw) ? draw : null;
}

function mergeDrawBatches(batches: Draw[][]) {
  return [
    ...new Map(
      batches
        .flat()
        .map((draw) => [`${draw.game}:${draw.issue}`, draw]),
    ).values(),
  ].sort(byNewest);
}

function mergeLatest(draws: Draw[], latest?: Draw): Draw[] {
  const merged = latest ? [latest, ...draws] : [...draws];
  return [...new Map(merged.map((item) => [`${item.game}:${item.issue}`, item])).values()].sort(byNewest);
}

function getApiLiveWindow(game: GameId, now: Date) {
  const reference = new Date(now.getTime() - 30 * 60_000);
  const target = nextScheduledDraw(game, reference);
  const delta = target.getTime() - now.getTime();
  return { target, visible: delta <= 3 * 60_000 && delta >= -30 * 60_000 };
}

function isDrawForTarget(draw: Draw, target: Date) {
  const drawTime = new Date(draw.drawAt).getTime();
  return Number.isFinite(drawTime) && Math.abs(drawTime - target.getTime()) < 4 * 3_600_000;
}

function isProgressForTarget(
  progress: LiveDrawProgress,
  target: Date,
  latest?: Draw,
) {
  const progressTime = new Date(progress.drawAt).getTime();
  if (
    Number.isFinite(progressTime) &&
    Math.abs(progressTime - target.getTime()) < 4 * 3_600_000
  ) {
    return true;
  }
  return latest
    ? progress.issue.localeCompare(latest.issue, "en", { numeric: true }) > 0
    : true;
}

function markVerified(draws: Draw[], observations: Array<Draw | undefined>): Draw[] {
  const valid = observations.filter((item): item is Draw => Boolean(item));
  return draws.map((item) => {
    const matches = valid.filter(
      (candidate) =>
        candidate.issue === item.issue &&
        [...candidate.numbers, candidate.special].join(",") === [...item.numbers, item.special].join(","),
    );
    return { ...item, verified: matches.length >= 2 };
  });
}

function fulfilled(result: PromiseSettledResult<Draw[]>): Draw[] {
  return result.status === "fulfilled" ? result.value : [];
}

async function firstNonEmpty(promises: Array<Promise<Draw[]>>) {
  return Promise.any(
    promises.map(async (promise) => {
      const draws = await promise;
      if (!draws.length) throw new Error("empty draw source");
      return draws;
    }),
  );
}

function byNewest(a: Draw, b: Draw) {
  return b.issue.localeCompare(a.issue, "en", { numeric: true });
}

function formatDateParam(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function fetchWithTimeout(
  input: string,
  init?: RequestInit,
  timeoutMs = 8_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, cache: "no-store", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
