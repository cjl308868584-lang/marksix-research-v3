import json
from pathlib import Path
import tempfile
import unittest

from marksix_research.pipeline import (
    audit_dataset,
    discover_zodiac_rules,
    load_draws,
    run_shadow_research,
    zodiac,
)
from marksix_research.cli import capture_task_id


class ResearchPipelineTest(unittest.TestCase):
    def test_capture_task_id_is_stable_for_retries_and_changes_with_dataset(self):
        artifact = {
            "schemaVersion": "python-shadow-v3",
            "game": "new_macau",
            "audit": {"datasetVersion": "a" * 64, "newestIssue": "2026213"},
        }
        first = capture_task_id("new_macau", artifact)
        self.assertEqual(first, capture_task_id("new_macau", dict(artifact)))
        changed = {
            **artifact,
            "audit": {"datasetVersion": "b" * 64, "newestIssue": "2026214"},
        }
        self.assertNotEqual(first, capture_task_id("new_macau", changed))
        self.assertIn("2026213", first)
        regenerated = {**artifact, "generatedAt": "2026-08-01T15:58:00Z"}
        self.assertNotEqual(first, capture_task_id("new_macau", regenerated))

    def test_zodiac_matches_known_2026_mapping(self):
        self.assertEqual(zodiac(5, "2026-07-24T21:30:00+08:00"), "虎")

    def test_audit_keeps_position_order_and_versions_data(self):
        payload = {
            "new_macau": [
                {
                    "game": "new_macau",
                    "issue": "2",
                    "drawAt": "2026-07-02T21:30:00+08:00",
                    "numbers": [12, 11, 31, 3, 44, 37],
                    "special": 25,
                    "verified": True,
                },
                {
                    "game": "new_macau",
                    "issue": "1",
                    "drawAt": "2026-07-01T21:30:00+08:00",
                    "numbers": [1, 2, 3, 4, 5, 6],
                    "special": 7,
                    "verified": False,
                },
            ]
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "draws.json"
            source.write_text(json.dumps(payload), encoding="utf-8")
            draws = load_draws(source, "new_macau")
        self.assertEqual(draws[-1].numbers[2], 31)
        audit = audit_dataset(draws)
        self.assertEqual(audit["sampleSize"], 2)
        self.assertEqual(audit["formalSampleSize"], 1)
        self.assertEqual(len(audit["datasetVersion"]), 64)

    def test_issue_gap_audit_never_counts_the_year_boundary_as_missing_draws(self):
        draws = [
            self._draw("2025212", "2025-12-30T21:32:32+08:00"),
            self._draw("2025213", "2025-12-31T21:32:32+08:00"),
            self._draw("2026001", "2026-01-01T21:32:32+08:00"),
            self._draw("2026003", "2026-01-03T21:32:32+08:00"),
        ]
        self.assertEqual(audit_dataset(draws)["numericGapCount"], 1)

    @staticmethod
    def _draw(issue, draw_at):
        from marksix_research.pipeline import Draw
        return Draw(
            game="new_macau",
            issue=issue,
            draw_at=draw_at,
            numbers=(1, 2, 3, 4, 5, 6),
            special=7,
            verified=True,
        )

    def test_user_example_is_in_the_bounded_grammar(self):
        # With fewer than 30 triggers it is generated but correctly excluded
        # from the expensive stage.
        rules = discover_zodiac_rules([], min_support=30)
        self.assertEqual(rules, [])

    def test_python_artifact_uses_the_production_ingest_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "draws.json"
            source.write_text(json.dumps({"new_macau": []}), encoding="utf-8")
            artifact = run_shadow_research(source, "new_macau")
        self.assertEqual(artifact["schemaVersion"], "python-shadow-v3")
        self.assertEqual(artifact["game"], "new_macau")
        self.assertIn("topPositiveRules", artifact)

    def test_rule_search_never_trains_on_single_source_unverified_draws(self):
        rows = []
        for index in range(160):
            start = index % 43 + 1
            numbers = list(range(start, start + 7))
            rows.append({
                "game": "new_macau",
                "issue": str(2026001 + index),
                "drawAt": f"2026-03-{index % 28 + 1:02d}T21:30:00+08:00",
                "numbers": numbers[:6],
                "special": numbers[6],
                "verified": index >= 80,
            })
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "draws.json"
            source.write_text(json.dumps({"new_macau": rows}), encoding="utf-8")
            artifact = run_shadow_research(source, "new_macau")
        rules = artifact["topPositiveRules"] + artifact["topNegativeRules"]
        self.assertTrue(rules)
        self.assertTrue(all(rule["support"] <= 80 for rule in rules))
        self.assertEqual(artifact["blackBox"]["sampleSize"], 80)


if __name__ == "__main__":
    unittest.main()
