import { NextRequest, NextResponse } from "next/server";
import { FALLBACK_DRAWS, type GameId } from "../../../lib/lottery";
import { getLotteryDraws, getCachedLiveDraws } from "../../../lib/lottery-feed";
export const dynamic = "force-dynamic";

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
        : await getLotteryDraws(game, limit);
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
