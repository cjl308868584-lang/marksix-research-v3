import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../lib/lottery";
import { loadResearchV3Envelope } from "../../../../lib/research-v3-service";
import type { ResearchEventSlot } from "../../../../lib/research-v3-types";

export const dynamic = "force-dynamic";

const SLOTS = new Set<ResearchEventSlot>([
  "zodiac_6_plus_1",
  "tail_6_plus_1",
  "position_parity",
  "position_size",
]);

export async function GET(request: NextRequest) {
  const allowed = new Set(["game", "slot", "page", "limit"]);
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
  const requestedSlot = request.nextUrl.searchParams.get("slot");
  const slot =
    requestedSlot && SLOTS.has(requestedSlot as ResearchEventSlot)
      ? requestedSlot as ResearchEventSlot
      : null;
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? 20);
  if (
    !game ||
    (requestedSlot && !slot) ||
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  ) {
    return NextResponse.json(
      { error: "彩种、策略槽位或分页参数无效。" },
      { status: 400 },
    );
  }
  try {
    const envelope = await loadResearchV3Envelope({ game });
    const rules = envelope.snapshot.events
      .filter((event) => !slot || event.slot === slot)
      .flatMap((event) =>
        event.ruleContributions.map((rule) => ({
          ...rule,
          eventId: event.eventId,
          slot: event.slot,
          slotLabel: event.slotLabel,
          scopeLabel: event.scopeLabel,
          predictedValue: event.predictedValue,
        }))
      );
    const start = (page - 1) * limit;
    return NextResponse.json(
      {
        game,
        runId: envelope.snapshot.runId,
        total: rules.length,
        page,
        limit,
        rules: rules.slice(start, start + limit),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "高概率策略证据暂不可用。" },
      { status: 503 },
    );
  }
}
