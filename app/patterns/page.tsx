import type { Metadata } from "next";
import { RollingPatternWorkspace } from "./RollingPatternWorkspace";

export const metadata: Metadata = {
  title: "近30期条件规律",
  description:
    "只使用最新30期，研究条件A出现后下一期结果B是否高于自身精确随机基准。",
};

export default function RollingPatternPage() {
  return <RollingPatternWorkspace />;
}
