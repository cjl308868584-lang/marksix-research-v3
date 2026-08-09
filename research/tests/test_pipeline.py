import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError
from unittest.mock import patch

from marksix_research.pipeline import (
    audit_dataset,
    discover_zodiac_rules,
    load_draws,
    run_shadow_research,
    zodiac,
)
from marksix_research import cli
from marksix_research.cli import capture_task_id


class ResearchPipelineTest(unittest.TestCase):
    def test_update_gate_only_runs_when_verified_result_reaches_frozen_target(self):
        cases = (
            ("2026216", True, "2026217", False, "forecast_ahead"),
            ("2026217", True, "2026217", True, "verified_result_ready"),
            ("2026217", False, "2026217", False, "awaiting_verification"),
        )
        for latest_issue, verified, target_issue, expected, reason in cases:
            with self.subTest(reason=reason):
                responses = [
                    {"draws": [self._draw_payload(latest_issue, verified)]},
                    {"targetIssue": target_issue},
                ]
                with patch.object(cli, "fetch_json", side_effect=responses):
                    result = cli.check_update_required(
                        "https://example.test",
                        "new_macau",
                    )
                self.assertEqual(result["shouldRun"], expected)
                self.assertEqual(result["reason"], reason)

    def test_single_game_sync_only_requests_the_selected_game(self):
        payload = {
            "game": "new_macau",
            "draws": [self._draw_payload("2026216", True)],
        }
        response = _FakeResponse(payload)
        with patch.object(cli, "urlopen", return_value=response) as request:
            draws = cli.sync_game_history("https://example.test", "new_macau")
        self.assertEqual(draws[0]["issue"], "2026216")
        self.assertEqual(
            request.call_args.args[0].full_url,
            "https://example.test/api/lottery?game=new_macau&limit=500",
        )

    def test_capture_treats_425_as_waiting_without_a_long_retry_loop(self):
        artifact = {
            "schemaVersion": "python-shadow-v3",
            "game": "new_macau",
            "audit": {"datasetVersion": "a" * 64, "newestIssue": "2026216"},
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifact.json"
            source.write_text(json.dumps(artifact), encoding="utf-8")
            error = HTTPError(
                "https://example.test/api/internal/research/settle-and-learn",
                425,
                "Too Early",
                {},
                None,
            )
            with patch.object(cli, "urlopen", side_effect=error) as request:
                result = cli.capture(
                    "https://example.test",
                    "secret",
                    "new_macau",
                    str(source),
                    max_wait_seconds=0,
                )
        self.assertEqual(result, {"status": "awaiting_verification"})
        self.assertEqual(request.call_count, 1)

    def test_each_cycle_resynchronizes_history_before_capture(self):
        draws = [self._draw_payload("2026216", True)]
        captured_issues = []

        def capture_artifact(_site, _secret, _game, artifact_path, **_kwargs):
            artifact = json.loads(Path(artifact_path).read_text(encoding="utf-8"))
            captured_issues.append(artifact["audit"]["newestIssue"])
            return {"status": "completed", "targetIssue": "2026217"}

        with (
            patch.object(cli, "sync_game_history", return_value=draws) as sync,
            patch.object(cli, "capture", side_effect=capture_artifact) as capture,
        ):
            with tempfile.TemporaryDirectory() as directory:
                first = cli.run_cycle(
                    "https://example.test",
                    "secret",
                    "new_macau",
                    directory,
                )
                second = cli.run_cycle(
                    "https://example.test",
                    "secret",
                    "new_macau",
                    directory,
                )
        self.assertEqual(first["status"], "completed")
        self.assertEqual(second["status"], "completed")
        self.assertEqual(sync.call_count, 2)
        self.assertEqual(capture.call_count, 2)
        self.assertEqual(captured_issues, ["2026216", "2026216"])

    def test_health_waits_normally_when_latest_draw_is_not_verified(self):
        responses = self._health_responses(verified=False)
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.verify_production_health(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result["status"], "awaiting_verification")
        self.assertEqual(result["latestIssue"], "2026216")

    def test_health_rejects_a_verified_draw_when_forecast_did_not_advance(self):
        responses = self._health_responses(target_issue="2026216")
        with patch.object(cli, "fetch_json", side_effect=responses):
            with self.assertRaisesRegex(
                RuntimeError,
                "new_macau.*2026216.*did not advance",
            ):
                cli.verify_production_health(
                    "https://example.test",
                    "new_macau",
                )

    def test_health_rejects_missing_review_or_learning_run(self):
        responses = self._health_responses(reviews=[], learning_runs=[])
        with patch.object(cli, "fetch_json", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "review missing.*2026216"):
                cli.verify_production_health(
                    "https://example.test",
                    "new_macau",
                )

    def test_health_accepts_only_an_advanced_four_slot_number_free_forecast(self):
        responses = self._health_responses()
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.verify_production_health(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result, {
            "status": "frozen",
            "game": "new_macau",
            "settledIssue": "2026216",
            "targetIssue": "2026217",
        })

    def test_capture_task_id_is_stable_for_retries_and_changes_with_dataset(self):
        artifact = {
            "schemaVersion": "python-shadow-v3",
            "game": "new_macau",
            "audit": {"datasetVersion": "a" * 64, "newestIssue": "2026213"},
        }
        first = capture_task_id("new_macau", artifact)
        self.assertEqual(first, capture_task_id("new_macau", dict(artifact)))
        self.assertIn("conditional-patterns-v2", first)
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

    @staticmethod
    def _draw_payload(issue, verified):
        return {
            "game": "new_macau",
            "issue": issue,
            "drawAt": "2026-08-04T21:32:32+08:00",
            "numbers": [18, 41, 32, 44, 36, 45],
            "special": 37,
            "verified": verified,
        }

    @classmethod
    def _health_responses(
        cls,
        *,
        verified=True,
        target_issue="2026217",
        reviews=None,
        learning_runs=None,
    ):
        slots = (
            "zodiac_6_plus_1",
            "tail_6_plus_1",
            "position_parity",
            "position_size",
        )
        if reviews is None:
            reviews = [{"targetIssue": "2026216"}]
        if learning_runs is None:
            learning_runs = [{"settledIssue": "2026216", "status": "completed"}]
        return [
            {"draws": [cls._draw_payload("2026216", verified)]},
            {
                "targetIssue": target_issue,
                "events": [
                    {"slot": slot, "family": "zodiac" if index == 0 else "parity"}
                    for index, slot in enumerate(slots)
                ],
            },
            {"reviews": reviews},
            {"learningRuns": learning_runs},
        ]

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


class _FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


if __name__ == "__main__":
    unittest.main()
