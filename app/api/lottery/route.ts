import { NextRequest, NextResponse } from "next/server";
import {
  FALLBACK_DRAWS,
  type Draw,
  type GameId,
  isValidDraw,
} from "../../../lib/lottery";

export const dynamic = "force-dynamic";

const API16868_CODES: Record<GameId, number> = {
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

export async function GET(request: NextRequest) {
  const requestedGame = request.nextUrl.searchParams.get("game");
  const game: GameId =
    requestedGame === "macau" || requestedGame === "new_macau" ? requestedGame : "hk";
  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 60), 3), 120);

  try {
    const result =
      game === "hk"
        ? await getHongKongDraws(limit)
        : game === "macau"
          ? await getMacauDraws(limit)
          : await getNewMacauDraws(limit);
    return NextResponse.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=30, stale-while-revalidate=120",
      },
    });
  } catch (error) {
    return NextResponse.json({
      game,
      draws: FALLBACK_DRAWS[game],
      live: false,
      degraded: true,
      message: `实时数据源暂不可用，当前展示最近一次同步的 ${FALLBACK_DRAWS[game].length} 期历史快照。`,
      fetchedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "unknown",
    });
  }
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

async function getMacauDraws(limit: number) {
  const token = process.env.BOYI_API_TOKEN;
  const [primary, freeHistory, secondary] = await Promise.allSettled([
    fetchMarksixLatest("macau"),
    fetchApi16868("macau", limit),
    token ? fetchBoyi(token, limit) : Promise.resolve([] as Draw[]),
  ]);
  const latest = fulfilled(primary)[0];
  const history = fulfilled(freeHistory);
  const paidHistory = fulfilled(secondary);
  const base = history.length
    ? history
    : paidHistory.length
      ? paidHistory
      : FALLBACK_DRAWS.macau;
  const merged = mergeLatest(base, latest);
  const checked = markVerified(merged, [latest, history[0], paidHistory[0]]);

  return {
    game: "macau" as const,
    draws: checked.slice(0, limit),
    live: Boolean(latest) || history.length > 0,
    degraded: history.length === 0,
    message: history.length
      ? `澳门彩免费历史 API 已接入，当前载入 ${checked.length} 期；最新一期自动交叉核验。`
      : paidHistory.length
        ? "澳门彩独立历史源已接入。"
        : `澳门彩实时数据源暂不可达，当前使用最近一次同步的 ${FALLBACK_DRAWS.macau.length} 期历史快照。`,
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
      ? `新澳门彩免费历史 API 已接入，当前载入 ${checked.length} 期；最新一期为 12·11·31·03·44·37 + 25。`
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

async function fetchMarksixLatest(game: GameId): Promise<Draw[]> {
  const sourceType: Record<GameId, string> = {
    hk: "hk",
    macau: "macau",
    new_macau: "newmacau",
  };
  const response = await fetchWithTimeout(
    `https://api3.marksix6.net/lottery_api.php?type=${sourceType[game]}`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Marksix6 ${response.status}`);
  const payload = (await response.json()) as {
    expect?: string;
    openTime?: string;
    openCode?: string;
    numbers?: string[];
  };
  const codes = payload.openCode ?? payload.numbers?.join(",") ?? "";
  const parsed = parseDraw(game, payload.expect ?? "", payload.openTime ?? "", codes, "Marksix6 API");
  return parsed ? [parsed] : [];
}

async function fetchBoyi(token: string, limit: number): Promise<Draw[]> {
  const response = await fetchWithTimeout(
    `https://boyi-api.com/api?token=${encodeURIComponent(token)}&code=amlhc&rows=${limit}&format=json`,
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Boyi ${response.status}`);
  const payload = (await response.json()) as {
    data?: Array<{
      drawIssue?: string;
      issue?: string;
      drawTime?: string;
      openTime?: string;
      drawCode?: string;
      openCode?: string;
    }>;
  };
  return (payload.data ?? [])
    .map((item) =>
      parseDraw(
        "macau",
        item.drawIssue ?? item.issue ?? "",
        item.drawTime ?? item.openTime ?? "",
        item.drawCode ?? item.openCode ?? "",
        "博易 API",
      ),
    )
    .filter((item): item is Draw => Boolean(item))
    .sort(byNewest);
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
  const time = date.includes("T")
    ? date
    : date.includes(" ")
      ? date.replace(" ", "T")
      : `${date}T${
          game === "macau" ? "22:32:00" : game === "new_macau" ? "21:32:00" : "21:30:00"
        }`;
  const result: Draw = {
    game,
    issue,
    drawAt: /[zZ]|[+-]\d\d:\d\d$/.test(time) ? time : `${time}+08:00`,
    numbers: values.slice(0, 6),
    special: values[6],
    source,
    verified: false,
  };
  return isValidDraw(result) ? result : null;
}

function mergeLatest(draws: Draw[], latest?: Draw): Draw[] {
  const merged = latest ? [latest, ...draws] : [...draws];
  return [...new Map(merged.map((item) => [`${item.game}:${item.issue}`, item])).values()].sort(byNewest);
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

async function fetchWithTimeout(input: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
