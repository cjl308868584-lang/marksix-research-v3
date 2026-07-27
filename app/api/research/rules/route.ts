import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { loadResearchEnvelope } from "../../../../lib/research-v2-service";
import type {
  ResearchEvidenceTier,
  ResearchTargetId,
} from "../../../../lib/research-v2-types";

export const dynamic = "force-dynamic";

const TIERS = new Set<ResearchEvidenceTier>([
  "baseline",
  "insufficient",
  "archived",
  "experimental",
  "challenger",
  "verified",
]);

export async function GET(request: NextRequest) {
  const allowed = new Set(["game", "target", "family", "tier", "page", "limit"]);
  if (
    [...request.nextUrl.searchParams.keys()].some((key) => !allowed.has(key))
  ) {
    return NextResponse.json(
      { error: "请求包含不受支持的参数。" },
      { status: 400 },
    );
  }
  const requestedGame = request.nextUrl.searchParams.get("game");
  const game = GAME_IDS.includes(requestedGame as GameId)
    ? requestedGame as GameId
    : null;
  const target = request.nextUrl.searchParams.get("target") as
    | ResearchTargetId
    | null;
  const requestedFamily = request.nextUrl.searchParams.get("family");
  const family =
    requestedFamily === "position_transfer" ||
    requestedFamily === "conditional_transfer" ||
    requestedFamily === "number_transform"
      ? requestedFamily
      : null;
  const requestedTier = request.nextUrl.searchParams.get("tier");
  const tier =
    requestedTier && TIERS.has(requestedTier as ResearchEvidenceTier)
      ? requestedTier as ResearchEvidenceTier
      : null;
  const page = Math.max(
    1,
    Math.min(100, Number(request.nextUrl.searchParams.get("page") ?? 1)),
  );
  const limit = Math.max(
    1,
    Math.min(50, Number(request.nextUrl.searchParams.get("limit") ?? 20)),
  );
  if (
    !game ||
    (requestedTier && !tier) ||
    (requestedFamily && !family) ||
    !Number.isInteger(page) ||
    !Number.isInteger(limit)
  ) {
    return NextResponse.json(
      { error: "彩种、证据等级或分页参数无效。" },
      { status: 400 },
    );
  }
  try {
    const envelope = await loadResearchEnvelope({ game });
    const all = [
      ...envelope.snapshot.verifiedRules,
      ...envelope.snapshot.experimentalRules,
      ...envelope.snapshot.negativeRules,
    ].filter(
      (rule) =>
        (!target || rule.targetId === target) &&
        (!family || rule.family === family) &&
        (!tier || rule.tier === tier),
    );
    const start = (page - 1) * limit;
    return NextResponse.json(
      {
        game,
        runId: envelope.snapshot.runId,
        total: all.length,
        page,
        limit,
        rules: all.slice(start, start + limit),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "规律研究结果暂不可用。" },
      { status: 503 },
    );
  }
}
