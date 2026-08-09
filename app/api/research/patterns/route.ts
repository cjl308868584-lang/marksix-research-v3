import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { summarizeRollingPatterns } from "../../../../lib/rolling-pattern-summary";
import { readRollingPatternRun } from "../../../../lib/rolling-pattern-store";
import type { RollingPatternFamily } from "../../../../lib/rolling-pattern-types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const FAMILIES: readonly RollingPatternFamily[] = [
  "zodiac",
  "tail",
  "wave",
  "head",
];

export async function GET(request: NextRequest) {
  const validation = validateQuery(request);
  if ("error" in validation) return validation.error;
  const { game, issue, family, page } = validation;
  const envelope = await readRollingPatternRun(game, issue);
  if (!envelope) {
    return NextResponse.json(
      {
        game,
        status: "unavailable",
        run: null,
        signals: [],
        scores: [],
        summary: null,
        pagination: { page, pageSize: PAGE_SIZE, total: 0, pages: 0 },
      },
      { status: 404, headers: noStore() },
    );
  }
  const filtered = family
    ? envelope.signals.filter((signal) => signal.rule.event.family === family)
    : envelope.signals;
  const pages = Math.ceil(filtered.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  return NextResponse.json(
    {
      game,
      status: "completed",
      run: { ...envelope.run, signals: [] },
      summary: summarizeRollingPatterns(filtered),
      signals: filtered.slice(start, start + PAGE_SIZE),
      scores: envelope.scores,
      pagination: {
        page,
        pageSize: PAGE_SIZE,
        total: filtered.length,
        pages,
      },
    },
    { headers: noStore() },
  );
}

function validateQuery(request: NextRequest):
  | {
      game: GameId;
      issue: string | null;
      family: RollingPatternFamily | null;
      page: number;
    }
  | { error: NextResponse } {
  const allowed = new Set(["game", "issue", "family", "page"]);
  if ([...request.nextUrl.searchParams.keys()].some((key) => !allowed.has(key))) {
    return {
      error: NextResponse.json(
        { error: "请求包含不受支持的参数。" },
        { status: 400, headers: noStore() },
      ),
    };
  }
  const requestedGame = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requestedGame as GameId)
    ? requestedGame as GameId
    : null;
  const issue = request.nextUrl.searchParams.get("issue");
  const requestedFamily = request.nextUrl.searchParams.get("family");
  const family = FAMILIES.includes(requestedFamily as RollingPatternFamily)
    ? requestedFamily as RollingPatternFamily
    : null;
  const rawPage = request.nextUrl.searchParams.get("page") ?? "1";
  const page = Number(rawPage);
  if (
    !game ||
    (issue !== null && !/^\d{4,16}$/.test(issue)) ||
    (requestedFamily !== null && !family) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100
  ) {
    return {
      error: NextResponse.json(
        { error: "彩种、期号、分类或页码无效。" },
        { status: 400, headers: noStore() },
      ),
    };
  }
  return { game, issue, family, page };
}

function noStore() {
  return { "Cache-Control": "private, no-store" };
}
