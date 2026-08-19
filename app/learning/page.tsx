import type { Metadata } from "next";
import { ForwardLearningWorkspace } from "./ForwardLearningWorkspace";

export const metadata: Metadata = {
  title: "逐期学习中心",
  description: "独立保存五项开奖前冻结方向，逐期结算并按相对随机基线表现更新模型。",
};

export default function ForwardLearningPage() {
  return <ForwardLearningWorkspace />;
}
