import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { readForwardLearningPerformance } from "../../../../lib/forward-learning-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if ([...request.nextUrl.searchParams.keys()].some((key) => key !== "game")) {
    return NextResponse.json({ error: "请求包含不受支持的参数。" }, { status: 400, headers: noStore() });
  }
  const requested = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requested as GameId) ? requested as GameId : null;
  if (!game) return NextResponse.json({ error: "彩种无效。" }, { status: 400, headers: noStore() });
  let performance;
  try {
    performance = await readForwardLearningPerformance(game);
  } catch {
    return NextResponse.json(
      { error: "resolved-v2正式表现不完整。" },
      { status: 503, headers: noStore() },
    );
  }
  return NextResponse.json(
    { game, ...performance },
    { headers: noStore() },
  );
}

function noStore() {
  return { "Cache-Control": "private, no-store" };
}
