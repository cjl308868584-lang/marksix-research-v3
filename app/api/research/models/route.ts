import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { loadResearchEnvelope } from "../../../../lib/research-v2-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (
    [...request.nextUrl.searchParams.keys()].some((key) => key !== "game")
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
  if (!game) {
    return NextResponse.json({ error: "彩种无效。" }, { status: 400 });
  }
  try {
    const envelope = await loadResearchEnvelope({ game });
    return NextResponse.json(
      {
        game,
        runId: envelope.snapshot.runId,
        dataVersion: envelope.snapshot.dataQuality.datasetVersion,
        modelVersion: envelope.snapshot.modelVersion,
        models: envelope.snapshot.modelComparison,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "模型对比暂不可用。" },
      { status: 503 },
    );
  }
}
