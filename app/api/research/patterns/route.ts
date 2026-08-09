import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { selectRollingPatternView } from "../../../../lib/rolling-pattern-summary";
import { readRollingPatternRun } from "../../../../lib/rolling-pattern-store";
import type {
  RollingPatternFamily,
  RollingPatternScope,
} from "../../../../lib/rolling-pattern-types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const FAMILIES: readonly RollingPatternFamily[] = [
  "zodiac",
  "tail",
  "wave",
  "head",
];
const SCOPES: readonly RollingPatternScope[] = ["coverage_6_plus_1", "special"];

export async function GET(request: NextRequest) {
  const validation = validateQuery(request);
  if ("error" in validation) return validation.error;
  const { game, issue, scope, family, result, page } = validation;
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
  const view = selectRollingPatternView(envelope.signals, {
    scope,
    family,
    resultEventId: result,
  });
  if (result && !view.summary.resultGroups.some((group) => group.eventId === result)) {
    return NextResponse.json(
      { error: "所选结果不属于当前结果域或分类。" },
      { status: 400, headers: noStore() },
    );
  }
  const pages = Math.ceil(view.signals.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  return NextResponse.json(
    {
      game,
      status: "completed",
      run: { ...envelope.run, signals: [] },
      summary: view.summary,
      signals: view.signals.slice(start, start + PAGE_SIZE),
      scores: envelope.scores,
      pagination: {
        page,
        pageSize: PAGE_SIZE,
        total: view.signals.length,
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
      scope: RollingPatternScope;
      family: RollingPatternFamily | null;
      result: string | null;
      page: number;
    }
  | { error: NextResponse } {
  const allowed = new Set(["game", "issue", "scope", "family", "result", "page"]);
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
  const requestedScope = request.nextUrl.searchParams.get("scope") ?? "coverage_6_plus_1";
  const scope = SCOPES.includes(requestedScope as RollingPatternScope)
    ? requestedScope as RollingPatternScope
    : null;
  const requestedFamily = request.nextUrl.searchParams.get("family");
  const family = FAMILIES.includes(requestedFamily as RollingPatternFamily)
    ? requestedFamily as RollingPatternFamily
    : null;
  const result = request.nextUrl.searchParams.get("result");
  const rawPage = request.nextUrl.searchParams.get("page") ?? "1";
  const page = Number(rawPage);
  if (
    !game ||
    !scope ||
    (issue !== null && !/^\d{4,16}$/.test(issue)) ||
    (requestedFamily !== null && !family) ||
    (scope === "coverage_6_plus_1" && (family === "wave" || family === "head")) ||
    (result !== null && !/^[^\s]{1,160}$/.test(result)) ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100
  ) {
    return {
      error: NextResponse.json(
        { error: "彩种、期号、结果域、分类、结果或页码无效。" },
        { status: 400, headers: noStore() },
      ),
    };
  }
  return { game, issue, scope, family, result, page };
}

function noStore() {
  return { "Cache-Control": "private, no-store" };
}
