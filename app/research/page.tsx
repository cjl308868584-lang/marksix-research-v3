import type { Metadata } from "next";
import { ResearchWorkspace } from "./ResearchWorkspace";

export const metadata: Metadata = {
  title: "规律研究中心",
  description:
    "逐条查看香港与新澳门六合彩候选规律的触发条件、历史命中率、随机基线、提升幅度、统计显著性与滚动回测结果。",
};

export default function ResearchPage() {
  return <ResearchWorkspace />;
}
