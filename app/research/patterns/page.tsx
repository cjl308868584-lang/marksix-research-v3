import type { Metadata } from "next";
import { RollingPatternWorkspace } from "./RollingPatternWorkspace";

export const metadata: Metadata = {
  title: "近30期规律",
  description:
    "只使用最新30期，展示当前已触发且历史命中率高于精确随机基准的近期待验证规律。",
};

export default function RollingPatternPage() {
  return <RollingPatternWorkspace />;
}
