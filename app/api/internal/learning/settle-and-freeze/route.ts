import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../../lib/lottery.ts";
import {
  ForwardLearningPrerequisiteError,
  runStoredForwardLearningCycle,
} from "../../../../../lib/forward-learning-service.ts";
import { projectResolvedLearningForecasts } from "../../../../../lib/forward-learning-store.ts";
import { readResolvedProductRecommendations } from "../../../../../lib/forward-learning-v2-store.ts";
import { getRuntimeEnv } from "../../../../../lib/runtime-env.ts";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;
const SIGNATURE_WINDOW_MS = 5 * 60_000;

type RequestBody = {
  taskId: string;
  game: GameId;
  asOf?: string;
};

export async function POST(request: NextRequest) {
  const secret = getRuntimeEnv("RESEARCH_INGEST_SECRET");
  if (!secret) return NextResponse.json({ error: "逐期学习服务尚未配置。" }, { status: 503 });
  const timestamp = request.headers.get("x-research-timestamp");
  const signature = request.headers.get("x-research-signature");
  const timestampMs = timestamp ? Number(timestamp) : Number.NaN;
  if (!timestamp || !signature || !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > SIGNATURE_WINDOW_MS) {
    return NextResponse.json({ error: "签名已失效。" }, { status: 401 });
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "任务内容过大。" }, { status: 413 });
  }
  const expected = await hmacHex(secret, `${timestamp}.${raw}`);
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    return NextResponse.json({ error: "签名无效。" }, { status: 401 });
  }
  let body: RequestBody;
  try {
    body = JSON.parse(raw) as RequestBody;
  } catch {
    return NextResponse.json({ error: "任务不是有效 JSON。" }, { status: 400 });
  }
  if (!/^[a-zA-Z0-9:_-]{8,160}$/.test(body.taskId ?? "") ||
    !GAME_IDS.includes(body.game) ||
    (body.asOf && !Number.isFinite(Date.parse(body.asOf)))) {
    return NextResponse.json({ error: "任务参数无效。" }, { status: 400 });
  }
  try {
    const result = await runStoredForwardLearningCycle({
      game: body.game,
      asOf: body.asOf ? new Date(body.asOf) : new Date(),
    });
    let forecasts: unknown[] = result.forecasts;
    if (result.status === "created" || result.status === "existing") {
      const resolved = await readResolvedProductRecommendations(body.game, result.targetIssue);
      if (!resolved || resolved.revision !== result.revision) {
        throw new Error("内部任务未能读取刚冻结的权威五项");
      }
      forecasts = projectResolvedLearningForecasts(resolved);
    }
    return NextResponse.json({
      taskId: body.taskId,
      ...result,
      forecasts,
      game: body.game,
      immutable: true,
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof ForwardLearningPrerequisiteError) {
      return NextResponse.json({
        taskId: body.taskId,
        game: body.game,
        status: "awaiting_pattern_window",
        forecastCount: 0,
        immutable: true,
      }, {
        status: 425,
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    console.error("forward learning task failed", {
      taskId: body.taskId,
      game: body.game,
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "逐期学习任务暂时失败，既有模型和冻结预测未被覆盖。" },
      { status: 503 },
    );
  }
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
