import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { readForwardLearningForecast } from "../../../../lib/forward-learning-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const allowed = new Set(["game", "issue"]);
  if ([...request.nextUrl.searchParams.keys()].some((key) => !allowed.has(key))) {
    return NextResponse.json({ error: "请求包含不受支持的参数。" }, { status: 400 });
  }
  const requested = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requested as GameId) ? requested as GameId : null;
  const issue = request.nextUrl.searchParams.get("issue");
  if (!game || (issue !== null && !/^\d{4,16}$/.test(issue))) {
    return NextResponse.json({ error: "彩种或期号无效。" }, { status: 400 });
  }
  const forecasts = await readForwardLearningForecast(game, issue);
  return NextResponse.json(
    { game, status: forecasts.length ? "ready" : "unavailable", forecasts },
    { status: forecasts.length ? 200 : 404, headers: { "Cache-Control": "private, no-store" } },
  );
}
