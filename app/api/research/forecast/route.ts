import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { readResearchV3Envelope } from "../../../../lib/research-v3-service";
import { readResearchV3Snapshot } from "../../../../lib/research-v3-store";
import { toPublicResearchV3Snapshot } from "../../../../lib/research-v3-engine";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const validation = validateQuery(request);
  if ("error" in validation) return validation.error;
  const { game, issue } = validation;
  if (issue) {
    const stored = await readResearchV3Snapshot(game, issue);
    if (!stored) {
      return NextResponse.json(
        { error: "未找到该期冻结研究预测。" },
        { status: 404, headers: noStore() },
      );
    }
    return NextResponse.json(toPublicResearchV3Snapshot(stored), { headers: noStore() });
  }
  try {
    const envelope = await readResearchV3Envelope({ game });
    return NextResponse.json(
      { ...toPublicResearchV3Snapshot(envelope.snapshot), source: envelope.source },
      { headers: noStore() },
    );
  } catch (error) {
    console.error(
      `research forecast unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return NextResponse.json(
      { error: "研究快照暂不可用。" },
      { status: 503, headers: noStore() },
    );
  }
}

function validateQuery(request: NextRequest):
  | { game: GameId; issue: string | null }
  | { error: NextResponse } {
  const allowed = new Set(["game", "issue"]);
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
  if (!game || (issue !== null && !/^\d{4,16}$/.test(issue))) {
    return {
      error: NextResponse.json(
        { error: "彩种或期号无效。" },
        { status: 400 },
      ),
    };
  }
  return { game, issue };
}

function noStore() {
  return { "Cache-Control": "private, no-store" };
}
