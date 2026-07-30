import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { readResearchV3Performance } from "../../../../lib/research-v3-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if ([...request.nextUrl.searchParams.keys()].some((key) => key !== "game")) {
    return NextResponse.json(
      { error: "请求包含不受支持的参数。" },
      { status: 400 },
    );
  }
  const requested = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requested as GameId)
    ? requested as GameId
    : null;
  if (!game) {
    return NextResponse.json({ error: "彩种无效。" }, { status: 400 });
  }
  const performance = await readResearchV3Performance(game);
  return NextResponse.json(performance, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
