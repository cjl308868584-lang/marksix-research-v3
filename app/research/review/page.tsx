import type { Metadata } from "next";
import { ResearchReviewWorkspace } from "./ResearchReviewWorkspace";

export const metadata: Metadata = {
  title: "规律复盘中心",
  description:
    "按期开奖前冻结六合彩可用规律，并在核验开奖后逐条结算正向命中、负向避开、随机期望及历史门槛表现。",
};

export default function ResearchReviewPage() {
  return <ResearchReviewWorkspace />;
}
