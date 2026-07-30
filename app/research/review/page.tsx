import type { Metadata } from "next";
import { ResearchReviewWorkspace } from "./ResearchReviewWorkspace";

export const metadata: Metadata = {
  title: "逐期学习复盘",
  description:
    "按期结算四项冻结高概率策略，展示命中、随机预期、Brier、log-loss、误差归因与模型权重变化。",
};

export default function ResearchReviewPage() {
  return <ResearchReviewWorkspace />;
}
