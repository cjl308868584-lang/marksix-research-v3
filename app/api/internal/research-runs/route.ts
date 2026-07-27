import { NextRequest, NextResponse } from "next/server";
import { getRuntimeEnv } from "../../../../lib/runtime-env";
import { persistResearchRun } from "../../../../lib/research-v2-store";
import type { ResearchRunEnvelope } from "../../../../lib/research-v2-types";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SIGNATURE_WINDOW_MS = 5 * 60_000;

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "研究结果过大。" }, { status: 413 });
  }
  const secret = getRuntimeEnv("RESEARCH_INGEST_SECRET");
  if (!secret) {
    return NextResponse.json(
      { error: "研究写入服务尚未配置。" },
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
    return NextResponse.json({ error: "研究结果过大。" }, { status: 413 });
  }
  const expected = await hmacHex(secret, `${timestamp}.${raw}`);
  if (!constantTimeEqual(expected, signature.toLowerCase())) {
    return NextResponse.json({ error: "签名无效。" }, { status: 401 });
  }
  let body: ResearchRunEnvelope;
  try {
    body = JSON.parse(raw) as ResearchRunEnvelope;
  } catch {
    return NextResponse.json({ error: "研究结果不是有效 JSON。" }, { status: 400 });
  }
  const result = await persistResearchRun(body);
  if (result === "invalid") {
    return NextResponse.json({ error: "研究结果格式无效。" }, { status: 400 });
  }
  if (result === "unavailable") {
    return NextResponse.json(
      { error: "研究数据库暂不可用。" },
      { status: 503 },
    );
  }
  return NextResponse.json(
    {
      status: result,
      runId: body.snapshot.runId,
      immutable: true,
    },
    {
      status: result === "created" ? 201 : 200,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
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
