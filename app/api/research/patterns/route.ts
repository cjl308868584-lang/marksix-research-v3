import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import {
  buildSpecialNumberConsensus,
  selectRollingPatternView,
  signalSupportsSpecialNumber,
} from "../../../../lib/rolling-pattern-summary";
import {
  readRollingPatternRun,
  readRollingPatternValueHistory,
  readRollingPatternValueLedger,
} from "../../../../lib/rolling-pattern-store";
import { buildRollingPatternProducts } from "../../../../lib/rolling-pattern-value";
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
  const { game, issue, scope, family, result, number, page } = validation;
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
        specialNumberConsensus: [],
        valueAnalysis: [],
        settlementHistory: [],
        pagination: { page, pageSize: PAGE_SIZE, total: 0, pages: 0 },
      },
      { status: 404, headers: noStore() },
    );
  }
  const view = selectRollingPatternView(envelope.signals, {
    scope,
    family,
    resultEventId: null,
  });
  const [valueLedger, settlementHistory] = await Promise.all([
    readRollingPatternValueLedger(game, envelope.run.targetIssue),
    readRollingPatternValueHistory(game, scope, 8),
  ]);
  if (result && !view.summary.resultGroups.some((group) => group.eventId === result)) {
    return NextResponse.json(
      { error: "所选结果不属于当前结果域或分类。" },
      { status: 400, headers: noStore() },
    );
  }
  const filteredSignals = result
    ? view.signals.filter((signal) => signal.rule.event.eventId === result)
    : number
      ? view.signals.filter((signal) =>
          signalSupportsSpecialNumber(signal, number, envelope.run.expectedDrawAt)
        )
      : view.signals;
  const specialNumberConsensus = scope === "special"
    ? buildSpecialNumberConsensus(view.signals, envelope.run.expectedDrawAt, 15)
    : [];
  const frozenProducts = valueLedger?.products.length
    ? valueLedger.products
    : buildRollingPatternProducts({ ...envelope.run, signals: envelope.signals });
  const valueAnalysis = selectValueProducts(frozenProducts.filter((item) => item.scope === scope));
  const pages = Math.ceil(filteredSignals.length / PAGE_SIZE);
  const start = (page - 1) * PAGE_SIZE;
  return NextResponse.json(
    {
      game,
      status: "completed",
      run: { ...envelope.run, signals: [] },
      summary: view.summary,
      specialNumberConsensus,
      valueAnalysis,
      settlementHistory,
      signals: filteredSignals.slice(start, start + PAGE_SIZE),
      scores: envelope.scores,
      pagination: {
        page,
        pageSize: PAGE_SIZE,
        total: filteredSignals.length,
        pages,
      },
    },
    { headers: noStore() },
  );
}

function selectValueProducts<T extends { kind: string; expectedValue: number }>(products: T[]) {
  const limits = new Map([
    ["coverage_zodiac", 5],
    ["coverage_tail", 5],
    ["coverage_zodiac_pair", 8],
    ["coverage_zodiac_triple", 8],
    ["special_number", 15],
  ]);
  const counts = new Map<string, number>();
  return [...products]
    .sort((left, right) => right.expectedValue - left.expectedValue)
    .filter((product) => {
      const count = counts.get(product.kind) ?? 0;
      const limit = limits.get(product.kind) ?? 0;
      if (count >= limit) return false;
      counts.set(product.kind, count + 1);
      return true;
    });
}

function validateQuery(request: NextRequest):
  | {
      game: GameId;
      issue: string | null;
      scope: RollingPatternScope;
      family: RollingPatternFamily | null;
      result: string | null;
      number: number | null;
      page: number;
    }
  | { error: NextResponse } {
  const allowed = new Set(["game", "issue", "scope", "family", "result", "number", "page"]);
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
  const rawNumber = request.nextUrl.searchParams.get("number");
  const number = rawNumber === null ? null : Number(rawNumber);
  const rawPage = request.nextUrl.searchParams.get("page") ?? "1";
  const page = Number(rawPage);
  if (
    !game ||
    !scope ||
    (issue !== null && !/^\d{4,16}$/.test(issue)) ||
    (requestedFamily !== null && !family) ||
    (scope === "coverage_6_plus_1" && (family === "wave" || family === "head")) ||
    (result !== null && !/^[^\s]{1,160}$/.test(result)) ||
    (number !== null && (!Number.isInteger(number) || number < 1 || number > 49)) ||
    (number !== null && scope !== "special") ||
    (number !== null && result !== null) ||
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
  return { game, issue, scope, family, result, number, page };
}

function noStore() {
  return { "Cache-Control": "private, no-store" };
}
