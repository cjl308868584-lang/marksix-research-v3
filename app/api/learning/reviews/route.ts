import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { readForwardLearningReviews } from "../../../../lib/forward-learning-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const allowed = new Set(["game", "limit"]);
  if ([...request.nextUrl.searchParams.keys()].some((key) => !allowed.has(key))) {
    return NextResponse.json({ error: "请求包含不受支持的参数。" }, { status: 400, headers: noStore() });
  }
  const requested = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requested as GameId) ? requested as GameId : null;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 30);
  if (!game || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return NextResponse.json({ error: "彩种或数量无效。" }, { status: 400, headers: noStore() });
  }
  let reviews;
  try {
    reviews = await readForwardLearningReviews(game, limit);
  } catch {
    return NextResponse.json(
      { error: "resolved-v2正式复盘不完整。" },
      { status: 503, headers: noStore() },
    );
  }
  return NextResponse.json(
    { game, reviews },
    { headers: noStore() },
  );
}

function noStore() {
  return { "Cache-Control": "private, no-store" };
}
