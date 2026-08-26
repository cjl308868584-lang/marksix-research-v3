import type { Metadata } from "next";
import { ResearchWorkspace } from "./ResearchWorkspace";

export const metadata: Metadata = {
  title: "高概率策略中心",
  description:
    "每期固定冻结6+1生肖、6+1尾数、特码单双、特码大小四个方向，并在开奖后自动复盘、更新模型和冻结下一期策略。",
};

export default function ResearchPage() {
  return <ResearchWorkspace />;
}
