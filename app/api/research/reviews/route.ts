import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { loadResearchV3Envelope } from "../../../../lib/research-v3-service";
import { readResearchV3Reviews } from "../../../../lib/research-v3-store";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const validation = validateQuery(request);
  if ("error" in validation) return validation.error;
  const { game, issue, limit } = validation;

  try {
    await loadResearchV3Envelope({ game });
  } catch {
    // Historical reviews remain readable if the live source is temporarily late.
  }
  const all = await readResearchV3Reviews(game, Math.max(limit, 50));
  const reviews = issue
    ? all.filter((review) => review.targetIssue === issue).slice(0, 1)
    : all.slice(0, limit);
  return NextResponse.json(
    { game, reviews },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

function validateQuery(request: NextRequest):
  | { game: GameId; issue: string | null; limit: number }
  | { error: NextResponse } {
  const allowed = new Set(["game", "issue", "limit"]);
  if (
    [...request.nextUrl.searchParams.keys()].some((key) => !allowed.has(key))
  ) {
    return {
      error: NextResponse.json(
        { error: "请求包含不受支持的参数。" },
        { status: 400 },
      ),
    };
  }
  const requestedGame = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requestedGame as GameId)
    ? requestedGame as GameId
    : null;
  const issue = request.nextUrl.searchParams.get("issue");
  const requestedLimit = Number(request.nextUrl.searchParams.get("limit") ?? 12);
  if (
    !game ||
    (issue !== null && !/^\d{4,16}$/.test(issue)) ||
    !Number.isInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 24
  ) {
    return {
      error: NextResponse.json(
        { error: "彩种、期号或数量无效。" },
        { status: 400 },
      ),
    };
  }
  return { game, issue, limit: requestedLimit };
}
