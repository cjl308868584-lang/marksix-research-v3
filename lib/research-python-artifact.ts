import type {
  ResearchPythonArtifact,
  ResearchPythonRule,
} from "./research-v3-types";

const POSITIONS = new Set([
  "main.1",
  "main.2",
  "main.3",
  "main.4",
  "main.5",
  "main.6",
  "special",
]);
const ZODIACS = new Set(["鼠", "牛", "虎", "兔", "龙", "蛇", "马", "羊", "猴", "鸡", "狗", "猪"]);

export function isResearchPythonArtifact(
  value: unknown,
): value is ResearchPythonArtifact {
  if (!value || typeof value !== "object") return false;
  const artifact = value as Partial<ResearchPythonArtifact>;
  return (
    artifact.schemaVersion === "python-shadow-v3" &&
    (artifact.game === "hk" || artifact.game === "new_macau") &&
    typeof artifact.generatedAt === "string" &&
    Boolean(artifact.audit) &&
    typeof artifact.audit?.datasetVersion === "string" &&
    Number.isInteger(artifact.audit?.sampleSize) &&
    Array.isArray(artifact.topPositiveRules) &&
    artifact.topPositiveRules.length <= 100 &&
    artifact.topPositiveRules.every(isResearchPythonRule) &&
    Array.isArray(artifact.topNegativeRules) &&
    artifact.topNegativeRules.length <= 100 &&
    artifact.topNegativeRules.every(isResearchPythonRule)
  );
}

function isResearchPythonRule(value: unknown): value is ResearchPythonRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<ResearchPythonRule>;
  const spec = rule.spec;
  const conditionValid = spec?.condition === null || (
    Array.isArray(spec?.condition) &&
    spec.condition.length === 2 &&
    POSITIONS.has(spec.condition[0]) &&
    ZODIACS.has(spec.condition[1])
  );
  return (
    typeof rule.ruleId === "string" &&
    rule.ruleId.length >= 8 &&
    rule.ruleId.length <= 128 &&
    Boolean(spec) &&
    (spec?.family === "position_transfer" ||
      spec?.family === "conditional_transfer") &&
    Number.isInteger(spec?.lag) &&
    Number(spec?.lag) >= 1 &&
    Number(spec?.lag) <= 5 &&
    POSITIONS.has(spec?.source ?? "") &&
    POSITIONS.has(spec?.target ?? "") &&
    spec?.familyTarget === "zodiac" &&
    conditionValid &&
    Number.isFinite(rule.support) &&
    Number(rule.support) >= 30 &&
    Number.isFinite(rule.baselineRate) &&
    Number(rule.baselineRate) > 0 &&
    Number(rule.baselineRate) < 1 &&
    Number.isFinite(rule.shrunkenRate) &&
    Number(rule.shrunkenRate) >= 0 &&
    Number(rule.shrunkenRate) <= 1 &&
    Number.isFinite(rule.qValue) &&
    Number(rule.qValue) >= 0 &&
    Number(rule.qValue) <= 1 &&
    (rule.direction === "positive" || rule.direction === "negative")
  );
}
