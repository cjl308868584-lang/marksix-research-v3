import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../../lib/lottery";
import {
  readRollingPatternReview,
  readRollingPatternReviewIndex,
} from "../../../../../lib/rolling-pattern-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const validation = validateQuery(request);
  if ("error" in validation) return validation.error;
  const { game, issue, before, limit } = validation;
  if (issue) {
    const review = await readRollingPatternReview(game, issue);
    return NextResponse.json(
      { game, review },
      { status: review ? 200 : 404, headers: noStore() },
    );
  }
  const page = await readRollingPatternReviewIndex(game, limit, before);
  return NextResponse.json(
    {
      game,
      items: page.items,
      nextCursor: page.nextCursor,
      slotPerformance: page.slotPerformance,
    },
    { headers: noStore() },
  );
}

function validateQuery(request: NextRequest):
  | {
      game: GameId;
      issue: string | null;
      before: string | null;
      limit: number;
    }
  | { error: NextResponse } {
  const allowed = new Set(["game", "issue", "before", "limit"]);
  if ([...request.nextUrl.searchParams.keys()].some((key) => !allowed.has(key))) {
    return { error: invalid() };
  }
  const requestedGame = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requestedGame as GameId)
    ? requestedGame as GameId
    : null;
  const issue = request.nextUrl.searchParams.get("issue");
  const before = request.nextUrl.searchParams.get("before");
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 20);
  if (!game ||
    (issue !== null && !/^\d{4,16}$/.test(issue)) ||
    (before !== null && !/^\d{4,16}$/.test(before)) ||
    (issue !== null && before !== null) ||
    !Number.isInteger(limit) || limit < 1 || limit > 50) {
    return { error: invalid() };
  }
  return { game, issue, before, limit };
}

function invalid() {
  return NextResponse.json(
    { error: "彩种、期号、游标或数量无效。" },
    { status: 400, headers: noStore() },
  );
}

function noStore() {
  return { "Cache-Control": "private, no-store" };
}
