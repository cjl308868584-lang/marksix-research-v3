import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { readForwardLearningReviews } from "../../../../lib/forward-learning-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const allowed = new Set(["game", "limit", "before"]);
  if ([...request.nextUrl.searchParams.keys()].some((key) => !allowed.has(key))) {
    return NextResponse.json({ error: "请求包含不受支持的参数。" }, { status: 400, headers: noStore() });
  }
  const requested = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requested as GameId) ? requested as GameId : null;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 30);
  const before = request.nextUrl.searchParams.get("before");
  if (!game || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
    (before !== null && !/^\d{4,16}$/.test(before))) {
    return NextResponse.json({ error: "彩种、数量或游标无效。" }, { status: 400, headers: noStore() });
  }
  let page;
  try {
    page = await readForwardLearningReviews(game, limit, before);
  } catch {
    return NextResponse.json(
      { error: "resolved-v2正式复盘不完整。" },
      { status: 503, headers: noStore() },
    );
  }
  return NextResponse.json(
    { game, reviews: page.reviews, nextCursor: page.nextCursor },
    { headers: noStore() },
  );
}

function noStore() {
  return { "Cache-Control": "private, no-store" };
}
