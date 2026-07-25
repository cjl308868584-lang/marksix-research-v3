import type { GameId } from "./lottery";

export type QualityGate = {
  eligible: boolean;
  targetConfirmed: boolean;
  reasons: string[];
};

type QualityDraw = {
  game: GameId;
  drawAt: string;
  verified: boolean;
};

type QualityHistory = {
  sourceMode: "live" | "snapshot";
  rejectedFutureCount: number;
};

export function assessQualityGate({
  game,
  history,
  draws,
  windowSize,
  analysisCutoff,
  targetConfirmed,
}: {
  game: GameId;
  history: QualityHistory;
  draws: QualityDraw[];
  windowSize: number;
  analysisCutoff: Date;
  targetConfirmed: boolean;
}): QualityGate {
  const reasons: string[] = [];
  const latestDrawTime = Date.parse(draws[0]?.drawAt ?? "");
  if (!targetConfirmed) {
    reasons.push("历史源尚未更新到目标期开奖之前的最近一期");
  }
  if (history.sourceMode !== "live") {
    reasons.push("当前使用离线快照，不能形成前瞻推荐");
  }
  if (draws.length < windowSize) {
    reasons.push(`所选窗口不完整，仅取得 ${draws.length}/${windowSize} 期`);
  }
  if (!draws[0]?.verified) {
    reasons.push("最近一期尚未完成跨源一致核验，不能形成优势推荐");
  }
  if (history.rejectedFutureCount > 0) {
    reasons.push("数据源含晚于分析截止时点的记录，虽已排除但本次不作推荐");
  }
  if (
    !Number.isFinite(latestDrawTime) ||
    latestDrawTime > analysisCutoff.getTime()
  ) {
    reasons.push("最近期开奖时点无法通过截止时间校验");
  }
  if (draws.some((draw) => draw.game !== game)) {
    reasons.push("历史数据彩种标识不一致");
  }
  return {
    eligible: reasons.length === 0,
    targetConfirmed,
    reasons,
  };
}
