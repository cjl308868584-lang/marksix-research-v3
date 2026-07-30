import type { Metadata } from "next";
import { ResearchWorkspace } from "./ResearchWorkspace";

export const metadata: Metadata = {
  title: "高概率策略中心",
  description:
    "每期固定研究6+1生肖、6+1尾数、指定位置单双和大小，并在开奖后自动复盘、更新模型和冻结下一期策略。",
};

export default function ResearchPage() {
  return <ResearchWorkspace />;
}
