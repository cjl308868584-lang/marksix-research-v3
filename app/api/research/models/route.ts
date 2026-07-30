import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { loadResearchV3Envelope } from "../../../../lib/research-v3-service";

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
    const envelope = await loadResearchV3Envelope({ game });
    return NextResponse.json(
      {
        game,
        runId: envelope.snapshot.runId,
        dataVersion: envelope.snapshot.dataQuality.datasetVersion,
        modelVersion: envelope.snapshot.modelVersion,
        champion: envelope.snapshot.learningSummary.champion,
        challenger: envelope.snapshot.learningSummary.challenger,
        settledForecasts: envelope.snapshot.learningSummary.settledForecasts,
        models: envelope.snapshot.events.map((event) => ({
          slot: event.slot,
          slotLabel: event.slotLabel,
          experts: event.experts,
        })),
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
