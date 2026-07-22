import { NextRequest, NextResponse } from "next/server";
import {
  GAME_META,
  buildAnalysis,
  isValidDraw,
  type Draw,
  type GameId,
} from "../../../lib/lottery";

export const dynamic = "force-dynamic";

type AiNarrative = {
  headline: string;
  overview: string;
  observations: string[];
  counterpoint: string;
};

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as {
    game?: GameId;
    draws?: Draw[];
    focus?: string;
  };
  const game: GameId = body.game === "macau" ? "macau" : "hk";
  const draws = Array.isArray(body.draws) ? body.draws.slice(0, 120).filter(isValidDraw) : [];
  if (draws.length < 2) {
    return NextResponse.json({ error: "至少需要两期有效数据才能分析。" }, { status: 400 });
  }

  const analysis = buildAnalysis(draws);
  const local = localNarrative(game, analysis.summary, body.focus);
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = (process.env.AI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.AI_MODEL;

  if (!apiKey || !model) {
    return NextResponse.json({ mode: "statistical", narrative: local, analysis });
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        messages: [
          {
            role: "system",
            content:
              "你是严谨的彩票历史数据研究员。只解释提供的统计，不得声称可以预测随机开奖结果，不得编造期号、概率或命中率。输出严格 JSON：headline、overview、observations(3项数组)、counterpoint。中文简洁，每项必须引用样本窗口或明确指标。",
          },
          {
            role: "user",
            content: JSON.stringify({
              game: GAME_META[game].name,
              focus: body.focus ?? "综合",
              analysis,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(14_000),
    });
    if (!response.ok) throw new Error(`AI ${response.status}`);
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const narrative = parseNarrative(content) ?? local;
    return NextResponse.json({ mode: narrative === local ? "statistical" : "ai", narrative, analysis });
  } catch {
    return NextResponse.json({ mode: "statistical", narrative: local, analysis });
  }
}

function localNarrative(game: GameId, summary: string[], focus = "综合"): AiNarrative {
  return {
    headline: `${GAME_META[game].shortName} · ${focus}维度研判`,
    overview: summary[0],
    observations: summary,
    counterpoint:
      "历史热度、遗漏与结构只用于描述样本。每次开奖仍是独立随机事件，候选组合不提高理论中奖概率。",
  };
}

function parseNarrative(content: string): AiNarrative | null {
  try {
    const clean = content.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(clean) as Partial<AiNarrative>;
    if (
      typeof parsed.headline !== "string" ||
      typeof parsed.overview !== "string" ||
      !Array.isArray(parsed.observations) ||
      typeof parsed.counterpoint !== "string"
    ) {
      return null;
    }
    return {
      headline: parsed.headline.slice(0, 80),
      overview: parsed.overview.slice(0, 260),
      observations: parsed.observations.slice(0, 4).map((item) => String(item).slice(0, 180)),
      counterpoint: parsed.counterpoint.slice(0, 220),
    };
  } catch {
    return null;
  }
}
