import { NextRequest, NextResponse } from "next/server";
import { GAME_IDS, type GameId } from "../../../../../lib/lottery";
import { runResearchV3Cycle } from "../../../../../lib/research-v3-service";
import {
  claimResearchTask,
  completeResearchTask,
  failResearchTask,
} from "../../../../../lib/research-v3-store";
import { getRuntimeEnv } from "../../../../../lib/runtime-env";
import { isResearchPythonArtifact } from "../../../../../lib/research-python-artifact";
import type { ResearchPythonArtifact } from "../../../../../lib/research-v3-types";
import { requireRollingPatternTaskSuccess } from "../../../../../lib/rolling-pattern-service";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;
const SIGNATURE_WINDOW_MS = 5 * 60_000;

type SettleAndLearnRequest = {
  taskId: string;
  game: GameId;
  asOf?: string;
  researchArtifact?: ResearchPythonArtifact;
};

export async function POST(request: NextRequest) {
  const secret = getRuntimeEnv("RESEARCH_INGEST_SECRET");
  if (!secret) {
    return NextResponse.json(
      { error: "研究学习服务尚未配置。" },
      { status: 503 },
    );
  }
  const timestamp = request.headers.get("x-research-timestamp");
  const signature = request.headers.get("x-research-signature");
  const timestampMs = timestamp ? Number(timestamp) : Number.NaN;
  if (
    !timestamp ||
    !signature ||
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > SIGNATURE_WINDOW_MS
  ) {
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
  let body: SettleAndLearnRequest;
  try {
    body = JSON.parse(raw) as SettleAndLearnRequest;
  } catch {
    return NextResponse.json({ error: "任务不是有效 JSON。" }, { status: 400 });
  }
  if (
    !/^[a-zA-Z0-9:_-]{8,160}$/.test(body.taskId ?? "") ||
    !GAME_IDS.includes(body.game) ||
    (body.asOf && !Number.isFinite(Date.parse(body.asOf))) ||
    (body.researchArtifact !== undefined &&
      (!isResearchPythonArtifact(body.researchArtifact) ||
        body.researchArtifact.game !== body.game))
  ) {
    return NextResponse.json({ error: "任务参数无效。" }, { status: 400 });
  }
  const startedAt = new Date().toISOString();
  const requestHash = await sha256Hex(raw);
  const claim = await claimResearchTask({
    taskId: body.taskId,
    game: body.game,
    requestHash,
    startedAt,
  });
  if (claim.status === "existing") {
    return NextResponse.json(claim.response, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  if (claim.status === "conflict") {
    return NextResponse.json(
      { error: "任务编号已被不同请求占用。" },
      { status: 409 },
    );
  }
  if (claim.status === "processing") {
    return NextResponse.json(
      { error: "同一任务正在处理中。" },
      { status: 409, headers: { "Retry-After": "15" } },
    );
  }
  if (claim.status === "unavailable") {
    return NextResponse.json(
      { error: "研究任务账本暂不可用。" },
      { status: 503 },
    );
  }
  try {
    const envelope = await runResearchV3Cycle({
      game: body.game,
      asOf: body.asOf ? new Date(body.asOf) : new Date(),
      forceCompute: false,
      researchArtifact: body.researchArtifact,
    });
    // The four-slot production forecast is already immutable at this point.
    // Keep the signed task retryable when its auxiliary 30-draw scan fails,
    // instead of permanently recording a successful task with missing rules.
    requireRollingPatternTaskSuccess(envelope.rollingPatterns);
    if (envelope.cycleStatus === "awaiting_verification") {
      const response = {
        status: "awaiting_verification",
        taskId: body.taskId,
        runId: envelope.snapshot.runId,
        targetIssue: envelope.snapshot.targetIssue,
        rollingPatterns: envelope.rollingPatterns,
        forwardLearning: { status: "awaiting_verification" },
        immutable: true,
      };
      const completed = await completeResearchTask(
        body.taskId,
        response,
        new Date().toISOString(),
      );
      if (!completed) throw new Error("research task completion was not persisted");
      return NextResponse.json(response, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    const response = {
      status: envelope.cycleStatus ??
        (envelope.source === "stored" ? "existing" : "completed"),
      taskId: body.taskId,
      runId: envelope.snapshot.runId,
      targetIssue: envelope.snapshot.targetIssue,
      rollingPatterns: envelope.rollingPatterns,
      forwardLearning: {
        status: "separate_signed_task",
        targetIssue: envelope.snapshot.targetIssue,
      },
      immutable: true,
    };
    const completed = await completeResearchTask(
      body.taskId,
      response,
      new Date().toISOString(),
    );
    if (!completed) throw new Error("research task completion was not persisted");
    return NextResponse.json(
      response,
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    await failResearchTask(
      body.taskId,
      error instanceof Error ? error.message : "unknown",
      new Date().toISOString(),
    );
    return NextResponse.json(
      { error: "结算与学习任务暂时失败，上一冠军和冻结预测未被覆盖。" },
      { status: 503 },
    );
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
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
