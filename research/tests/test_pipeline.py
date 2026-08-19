import json
from io import BytesIO
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
                if verified and int(latest_issue) < int(target_issue):
                    responses.append(self._forward_forecast_payload(target_issue))
                    responses.append(self._pattern_payload(target_issue))
                    responses.append(
                        self._http_error(
                            404,
                            f"/api/learning/forecast?issue={latest_issue}",
                        )
                    )
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

    def test_capture_preserves_the_retryable_http_status_when_no_wait_was_requested(self):
        artifact = {
            "schemaVersion": "python-shadow-v3",
            "game": "new_macau",
            "audit": {"datasetVersion": "a" * 64, "newestIssue": "2026216"},
        }
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "artifact.json"
            source.write_text(json.dumps(artifact), encoding="utf-8")
            with patch.object(
                cli,
                "urlopen",
                side_effect=self._http_error(
                    503,
                    "/api/internal/research/settle-and-learn",
                ),
            ):
                with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                    cli.capture(
                        "https://example.test",
                        "secret",
                        "new_macau",
                        str(source),
                        max_wait_seconds=0,
                    )

    def test_each_cycle_resynchronizes_history_before_capture(self):
        draws = [self._draw_payload("2026216", True)]
        captured_issues = []

        def capture_artifact(_site, _secret, _game, artifact_path, **_kwargs):
            artifact = json.loads(Path(artifact_path).read_text(encoding="utf-8"))
            captured_issues.append(artifact["audit"]["newestIssue"])
            return {"status": "completed", "targetIssue": "2026217"}

        def capture_learning(_site, _secret, game, target_issue, **_kwargs):
            self.assertEqual(game, "new_macau")
            self.assertEqual(target_issue, "2026217")
            return {"status": "created", "forecastCount": 5}

        with (
            patch.object(cli, "sync_game_history", return_value=draws) as sync,
            patch.object(cli, "capture", side_effect=capture_artifact) as capture,
            patch.object(
                cli,
                "capture_forward_learning",
                side_effect=capture_learning,
            ) as learning,
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
        self.assertEqual(learning.call_count, 2)
        self.assertEqual(captured_issues, ["2026216", "2026216"])
        self.assertEqual(first["forwardLearning"]["forecastCount"], 5)

    def test_cycle_does_not_start_forward_learning_until_primary_capture_succeeds(self):
        draws = [self._draw_payload("2026216", True)]
        with (
            patch.object(cli, "sync_game_history", return_value=draws),
            patch.object(cli, "capture", side_effect=RuntimeError("primary failed")),
            patch.object(cli, "capture_forward_learning") as learning,
        ):
            with tempfile.TemporaryDirectory() as directory:
                with self.assertRaisesRegex(RuntimeError, "primary failed"):
                    cli.run_cycle(
                        "https://example.test",
                        "secret",
                        "new_macau",
                        directory,
                    )
        learning.assert_not_called()

    def test_cycle_abstains_from_forward_learning_without_a_30_draw_pattern_window(self):
        draws = [self._draw_payload("2026090", True)]
        primary = {
            "status": "existing",
            "targetIssue": "2026091",
            "rollingPatterns": {
                "status": "insufficient_data",
                "missing": 20,
                "qualified": 0,
            },
        }
        with (
            patch.object(cli, "sync_game_history", return_value=draws),
            patch.object(cli, "capture", return_value=primary),
            patch.object(cli, "capture_forward_learning") as learning,
        ):
            with tempfile.TemporaryDirectory() as directory:
                result = cli.run_cycle(
                    "https://example.test",
                    "secret",
                    "hk",
                    directory,
                )
        learning.assert_not_called()
        self.assertEqual(result["forwardLearning"], {
            "status": "insufficient_data",
            "missing": 20,
            "forecastCount": 0,
        })

    def test_forward_capture_accepts_only_a_complete_five_slot_freeze(self):
        payload = {
            **self._raw_forward_payload("2026217"),
            "status": "created",
            "game": "new_macau",
            "targetIssue": "2026217",
            "revision": 2,
        }
        with patch.object(cli, "urlopen", return_value=_FakeResponse(payload)):
            result = cli.capture_forward_learning(
                "https://example.test",
                "secret",
                "new_macau",
                "2026217",
            )
        self.assertEqual(result["status"], "created")
        self.assertEqual(result["targetIssue"], "2026217")
        self.assertEqual(result["forecastCount"], 5)
        self.assertNotIn("forecasts", result)

    def test_forward_capture_accepts_a_resolved_v2_revision_one(self):
        payload = {
            **self._raw_forward_payload("2026217", revision=1),
            "status": "created",
            "game": "new_macau",
            "targetIssue": "2026217",
            "revision": 1,
        }
        with patch.object(cli, "urlopen", return_value=_FakeResponse(payload)):
            result = cli.capture_forward_learning(
                "https://example.test",
                "secret",
                "new_macau",
                "2026217",
            )
        self.assertEqual(result["revision"], 1)
        self.assertEqual(result["forecastCount"], 5)

    def test_forward_capture_rejects_a_2xx_response_without_a_complete_freeze(self):
        invalid_payloads = (
            {
                "status": "awaiting_pattern_window",
                "game": "new_macau",
                "targetIssue": "2026231",
                "forecastCount": 0,
            },
            {
                "status": "created",
                "game": "new_macau",
                "targetIssue": "2026231",
                "forecasts": [{"slot": "coverage_zodiac", "official": True}],
            },
            {
                "status": "created",
                "game": "new_macau",
                "targetIssue": "2026232",
                "forecasts": [
                    {"slot": slot, "official": True}
                    for slot in (
                        "coverage_zodiac",
                        "coverage_tail",
                        "coverage_zodiac_pair",
                        "coverage_zodiac_triple",
                        "special_number",
                    )
                ],
            },
            {
                "status": "created",
                "game": "new_macau",
                "targetIssue": "2026231",
                "forecasts": [
                    {
                        "slot": slot,
                        "official": True,
                        "targetIssue": "2026232" if index == 0 else "2026231",
                    }
                    for index, slot in enumerate((
                        "coverage_zodiac",
                        "coverage_tail",
                        "coverage_zodiac_pair",
                        "coverage_zodiac_triple",
                        "special_number",
                    ))
                ],
            },
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                with patch.object(cli, "urlopen", return_value=_FakeResponse(payload)):
                    with self.assertRaisesRegex(RuntimeError, "complete five-slot freeze"):
                        cli.capture_forward_learning(
                            "https://example.test",
                            "secret",
                            "new_macau",
                            "2026231",
                        )

    def test_forward_capture_rejects_a_mixed_resolved_v2_policy(self):
        payload = {
            **self._raw_forward_payload("2026217"),
            "status": "created",
            "targetIssue": "2026217",
            "revision": 2,
        }
        payload["forecasts"][0]["selectionPolicy"] = "forward-learning-v1"
        with patch.object(cli, "urlopen", return_value=_FakeResponse(payload)):
            with self.assertRaisesRegex(RuntimeError, "resolved-v2"):
                cli.capture_forward_learning(
                    "https://example.test",
                    "secret",
                    "new_macau",
                    "2026217",
                )

    def test_forward_capture_rejects_a_mismatched_response_revision(self):
        payload = {
            **self._raw_forward_payload("2026217"),
            "status": "created",
            "targetIssue": "2026217",
            "revision": 1,
        }
        with patch.object(cli, "urlopen", return_value=_FakeResponse(payload)):
            with self.assertRaisesRegex(RuntimeError, "resolved-v2"):
                cli.capture_forward_learning(
                    "https://example.test",
                    "secret",
                    "new_macau",
                    "2026217",
                )

    def test_forward_capture_reports_a_missing_prerequisite_without_calling_it_a_timeout(self):
        error = self._http_error(425, "/api/internal/learning/settle-and-freeze")
        with patch.object(cli, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "prerequisite unavailable"):
                cli.capture_forward_learning(
                    "https://example.test",
                    "secret",
                    "hk",
                    "2026091",
                )

    def test_forward_capture_preserves_the_retryable_http_status_when_no_wait_was_requested(self):
        error = self._http_error(503, "/api/internal/learning/settle-and-freeze")
        with patch.object(cli, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                cli.capture_forward_learning(
                    "https://example.test",
                    "secret",
                    "hk",
                    "2026091",
                )

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

    def test_health_accepts_a_clean_primary_bootstrap_without_a_fabricated_review(self):
        responses = [
            {"draws": [self._draw_payload("2026216", True)]},
            {
                "targetIssue": "2026217",
                "events": [
                    {"slot": slot, "family": "zodiac" if index == 0 else "parity"}
                    for index, slot in enumerate((
                        "zodiac_6_plus_1",
                        "tail_6_plus_1",
                        "position_parity",
                        "position_size",
                    ))
                ],
            },
            {"reviews": []},
            {"learningRuns": []},
            self._http_error(404, "/api/research/forecast?issue=2026216"),
            self._forward_forecast_payload("2026217"),
            self._pattern_payload("2026217"),
            self._http_error(404, "/api/learning/forecast?issue=2026216"),
        ]
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.verify_production_health(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result["status"], "frozen")
        self.assertEqual(result["targetIssue"], "2026217")
        self.assertIsNone(result["settledIssue"])

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
            "forwardLearningTargetIssue": "2026217",
            "revision": 2,
        })

    def test_health_rejects_a_missing_or_incomplete_five_slot_freeze(self):
        responses = self._health_responses(
            forward_payload={
                "game": "new_macau",
                "status": "ready",
                "forecasts": [
                    {"slot": "coverage_zodiac", "targetIssue": "2026217", "official": True},
                ],
            },
        )
        with patch.object(cli, "fetch_json", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "five-slot"):
                cli.verify_production_health(
                    "https://example.test",
                    "new_macau",
                )

    def test_health_rejects_patterns_learning_recommendation_drift(self):
        responses = self._v2_health_responses()
        responses.patterns["recommendations"][0]["resultKey"] = "猴"
        responses.learning["forecasts"][0]["resultKey"] = "马"
        with patch.object(cli, "fetch_json", side_effect=responses.sequence):
            with self.assertRaisesRegex(RuntimeError, "recommendation mismatch"):
                cli.verify_production_health(
                    "https://example.test",
                    "new_macau",
                )

    def test_health_accepts_a_complete_revision_without_expert_model_states(self):
        responses = self._v2_health_responses(models=[])
        with patch.object(cli, "fetch_json", side_effect=responses.sequence):
            result = cli.verify_production_health(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result["revision"], 2)

    def test_health_accepts_a_complete_resolved_v2_revision_one(self):
        responses = _V2HealthResponses(self, revision=1, models=[])
        with patch.object(cli, "fetch_json", side_effect=responses.sequence):
            result = cli.verify_production_health(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result["revision"], 1)

    def test_health_rejects_prior_scores_from_a_lower_revision(self):
        responses = self._v2_health_responses(models=[])
        responses.learning_reviews["reviews"][0]["scores"][0]["revision"] = 1
        with patch.object(cli, "fetch_json", side_effect=responses.sequence):
            with self.assertRaisesRegex(RuntimeError, "learning run.*resolved-v2"):
                cli.verify_production_health(
                    "https://example.test",
                    "new_macau",
                )

    def test_health_rejects_prior_scores_for_another_target(self):
        responses = self._v2_health_responses(models=[])
        responses.learning_reviews["reviews"][0]["scores"][0]["targetIssue"] = "2026215"
        with patch.object(cli, "fetch_json", side_effect=responses.sequence):
            with self.assertRaisesRegex(RuntimeError, "learning run.*resolved-v2"):
                cli.verify_production_health(
                    "https://example.test",
                    "new_macau",
                )

    def test_health_reports_degraded_when_the_30_draw_window_is_unavailable(self):
        responses = self._health_responses()
        responses[4] = self._http_error(404, "/api/learning/forecast")
        responses[5] = self._http_error(404, "/api/research/patterns")
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.verify_production_health(
                "https://example.test",
                "hk",
            )
        self.assertEqual(result["status"], "degraded")
        self.assertEqual(result["reason"], "forward_learning_pattern_window_unavailable")

    def test_health_does_not_hide_a_missing_freeze_when_30_verified_draws_exist(self):
        responses = self._health_responses()
        responses[0] = {
            "draws": [
                self._draw_payload(str(2026216 - index), True)
                for index in range(30)
            ],
        }
        responses[4] = self._http_error(404, "/api/learning/forecast")
        responses[5] = self._http_error(404, "/api/research/patterns")
        with patch.object(cli, "fetch_json", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "missing the five-slot"):
                cli.verify_production_health(
                    "https://example.test",
                    "new_macau",
                )

    def test_health_does_not_hide_a_missing_freeze_when_a_pattern_run_exists(self):
        responses = self._health_responses()
        responses[4] = self._http_error(404, "/api/learning/forecast")
        responses[5] = {"game": "hk", "run": {"targetIssue": "2026217"}}
        with patch.object(cli, "fetch_json", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "missing the five-slot"):
                cli.verify_production_health(
                    "https://example.test",
                    "hk",
                )

    def test_health_requires_a_complete_review_after_a_frozen_learning_issue_draws(self):
        responses = self._health_responses()
        responses[6] = self._forward_forecast_payload("2026216")
        responses.append(self._forward_review_payload("2026216"))
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.verify_production_health(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result["status"], "frozen")

        incomplete = self._forward_review_payload("2026216")
        incomplete["reviews"][0]["scores"] = incomplete["reviews"][0]["scores"][:-1]
        responses = self._health_responses()
        responses[6] = self._forward_forecast_payload("2026216")
        responses.append(incomplete)
        with patch.object(cli, "fetch_json", side_effect=responses):
            with self.assertRaisesRegex(RuntimeError, "complete five-slot learning run"):
                cli.verify_production_health(
                    "https://example.test",
                    "new_macau",
                )

    def test_update_gate_repairs_a_missing_five_slot_freeze_when_30_verified_draws_exist(self):
        responses = [
            {
                "draws": [
                    self._draw_payload(str(2026216 - index), True)
                    for index in range(30)
                ],
            },
            {"targetIssue": "2026217"},
            self._http_error(404, "/api/learning/forecast"),
            self._http_error(404, "/api/research/patterns"),
        ]
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.check_update_required(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result["shouldRun"], True)
        self.assertEqual(result["reason"], "forward_learning_repair_required")

    def test_update_gate_waits_when_fewer_than_30_verified_draws_exist(self):
        responses = [
            {"draws": [self._draw_payload("2026090", True)]},
            {"targetIssue": "2026091"},
            self._http_error(404, "/api/learning/forecast"),
            self._http_error(404, "/api/research/patterns"),
        ]
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.check_update_required(
                "https://example.test",
                "hk",
            )
        self.assertEqual(result["shouldRun"], False)
        self.assertEqual(result["reason"], "forward_learning_waiting_for_pattern_window")

    def test_update_gate_repairs_a_missing_freeze_when_a_pattern_run_exists(self):
        responses = [
            {"draws": [self._draw_payload("2026090", True)]},
            {"targetIssue": "2026091"},
            self._http_error(404, "/api/learning/forecast"),
            {"game": "hk", "run": {"targetIssue": "2026091"}},
        ]
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.check_update_required(
                "https://example.test",
                "hk",
            )
        self.assertEqual(result["shouldRun"], True)
        self.assertEqual(result["reason"], "unified_revision_repair_required")

    def test_update_gate_repairs_when_patterns_lack_a_committed_resolved_revision(self):
        responses = [
            {"draws": [self._draw_payload("2026090", True)]},
            {"targetIssue": "2026091"},
            self._http_error(404, "/api/learning/forecast"),
            self._http_json_error(
                503,
                "/api/research/patterns",
                {"error": "权威五项与冻结规律运行不一致。"},
            ),
        ]
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.check_update_required(
                "https://example.test",
                "hk",
            )
        self.assertTrue(result["shouldRun"])
        self.assertEqual(result["reason"], "unified_revision_repair_required")

    def test_update_gate_keeps_other_patterns_503_failures_visible(self):
        messages = (
            "权威五项来源不完整或混合，暂不展示部分结果。",
            "database unavailable",
        )
        for message in messages:
            with self.subTest(message=message):
                responses = [
                    {"draws": [self._draw_payload("2026090", True)]},
                    {"targetIssue": "2026091"},
                    self._http_error(404, "/api/learning/forecast"),
                    self._http_json_error(
                        503,
                        "/api/research/patterns",
                        {"error": message},
                    ),
                ]
                with patch.object(cli, "fetch_json", side_effect=responses):
                    with self.assertRaises(HTTPError) as raised:
                        cli.check_update_required(
                            "https://example.test",
                            "hk",
                        )
                self.assertEqual(raised.exception.code, 503)
                self.assertEqual(
                    json.loads(raised.exception.read().decode("utf-8"))["error"],
                    message,
                )

    def test_update_gate_repairs_an_incomplete_forward_learning_review(self):
        incomplete = self._forward_review_payload("2026216")
        incomplete["reviews"][0]["scores"] = incomplete["reviews"][0]["scores"][:-1]
        responses = [
            {"draws": [self._draw_payload("2026216", True)]},
            {"targetIssue": "2026217"},
            self._forward_forecast_payload("2026217"),
            self._pattern_payload("2026217"),
            self._forward_forecast_payload("2026216"),
            incomplete,
        ]
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.check_update_required(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result["shouldRun"], True)
        self.assertEqual(
            result["reason"],
            "forward_learning_review_repair_required",
        )

    def test_update_gate_repairs_a_v1_only_target(self):
        responses = self._v1_only_target_responses()
        with patch.object(cli, "fetch_json", side_effect=responses.sequence):
            result = cli.check_update_required(
                "https://example.test",
                "new_macau",
            )
        self.assertTrue(result["shouldRun"])
        self.assertEqual(result["reason"], "unified_revision_repair_required")

    def test_update_gate_accepts_a_complete_resolved_v2_revision_one(self):
        responses = _V2HealthResponses(self, revision=1)
        with patch.object(cli, "fetch_json", side_effect=responses.sequence):
            result = cli.check_update_required(
                "https://example.test",
                "new_macau",
            )
        self.assertFalse(result["shouldRun"])
        self.assertEqual(result["reason"], "forecast_ahead")

    def test_update_gate_repairs_a_target_with_no_committed_revision(self):
        responses = self._v2_health_responses()
        for forecast in responses.learning["forecasts"]:
            forecast.pop("revision")
        with patch.object(cli, "fetch_json", side_effect=responses.sequence):
            result = cli.check_update_required(
                "https://example.test",
                "new_macau",
            )
        self.assertTrue(result["shouldRun"])
        self.assertEqual(result["reason"], "unified_revision_repair_required")

    def test_update_gate_requests_bootstrap_when_the_main_forecast_is_not_initialized(self):
        responses = [
            {"draws": [self._draw_payload("2026216", True)]},
            self._http_error(404, "/api/research/forecast"),
        ]
        with patch.object(cli, "fetch_json", side_effect=responses):
            result = cli.check_update_required(
                "https://example.test",
                "new_macau",
            )
        self.assertEqual(result["shouldRun"], True)
        self.assertEqual(result["reason"], "bootstrap_required")

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
        forward_payload=None,
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
        if forward_payload is None:
            forward_payload = cls._forward_forecast_payload(target_issue)
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
            forward_payload,
            cls._pattern_payload(target_issue),
            cls._http_error(404, "/api/learning/forecast?issue=2026216"),
        ]

    @staticmethod
    def _forward_forecast_payload(target_issue, revision=2):
        return _resolved_recommendation_payloads(target_issue, revision)[1]

    @classmethod
    def _raw_forward_payload(cls, target_issue, revision=2):
        payload = cls._forward_forecast_payload(target_issue, revision)
        for forecast in payload["forecasts"]:
            forecast["selectionPolicy"] = "rolling-product-ev-v2"
        return payload

    @staticmethod
    def _pattern_payload(target_issue):
        return _resolved_recommendation_payloads(target_issue)[0]

    @classmethod
    def _forward_review_payload(cls, settled_issue):
        slots = (
            "coverage_zodiac",
            "coverage_tail",
            "coverage_zodiac_pair",
            "coverage_zodiac_triple",
            "special_number",
        )
        return {
            "game": "new_macau",
            "reviews": [{
                "run": {
                    "settledIssue": settled_issue,
                    "status": "completed",
                    "revision": 2,
                    "revisionSource": "resolved-v2",
                },
                "scores": [
                    {
                        "slot": slot,
                        "official": True,
                        "revision": 2,
                        "targetIssue": settled_issue,
                    }
                    for slot in slots
                ],
                "modelAfter": [
                    {"slot": slot, "learnedThroughIssue": settled_issue}
                    for slot in slots
                ],
            }],
        }

    @classmethod
    def _v2_health_responses(cls, *, models=None):
        return _V2HealthResponses(cls, models=models)

    @classmethod
    def _v1_only_target_responses(cls):
        responses = _V2HealthResponses(cls)
        responses.learning["forecasts"] = [
            {
                "slot": slot,
                "official": True,
                "targetIssue": "2026217",
                "resultKey": result_key,
                "values": values,
            }
            for slot, result_key, values in _V2HealthResponses.slots
        ]
        return responses

    @staticmethod
    def _http_error(code, path):
        return HTTPError(
            f"https://example.test{path}",
            code,
            "error",
            {},
            None,
        )

    @staticmethod
    def _http_json_error(code, path, payload):
        return HTTPError(
            f"https://example.test{path}",
            code,
            "error",
            {"content-type": "application/json"},
            BytesIO(json.dumps(payload, ensure_ascii=False).encode("utf-8")),
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


def _resolved_recommendation_payloads(target_issue, revision=2):
    slots = _V2HealthResponses.slots
    source_run_id = f"pattern:{target_issue}"
    data_version = "data-v2"
    recommendations = []
    for index, (kind, result_key, values) in enumerate(slots):
        net_odds = 47 if kind == "special_number" else 1
        learned_probability = 0.01 if kind == "special_number" else 0.55 + index * 0.01
        recommendations.append({
            "kind": kind,
            "resultKey": result_key,
            "values": values,
            "sourceRunId": source_run_id,
            "dataVersion": data_version,
            "revision": revision,
            "p30": 0.5,
            "legacySeedProbability": 0.52,
            "learnedProbability": learned_probability,
            "netOdds": net_odds,
            "breakEvenProbability": 1 / (net_odds + 1),
            "expectedValue": learned_probability * net_odds - (1 - learned_probability),
            "product": {
                "targetIssue": target_issue,
            },
        })
    patterns = {
        "game": "new_macau",
        "status": "completed",
        "run": {"runId": source_run_id, "targetIssue": target_issue},
        "recommendations": recommendations,
    }
    forecasts = json.loads(json.dumps(recommendations))
    for forecast, (slot, _result_key, _values) in zip(forecasts, slots):
        forecast.update({
            "slot": slot,
            "official": True,
            "targetIssue": target_issue,
            "revision": revision,
        })
        forecast.pop("product", None)
    learning = {
        "game": "new_macau",
        "status": "ready",
        "forecasts": forecasts,
    }
    return patterns, learning


class _V2HealthResponses:
    slots = (
        ("coverage_zodiac", "猴", ["猴"]),
        ("coverage_tail", "8尾", ["8尾"]),
        ("coverage_zodiac_pair", "蛇+猴", ["蛇", "猴"]),
        ("coverage_zodiac_triple", "蛇+马+猴", ["蛇", "马", "猴"]),
        ("special_number", "01", ["01"]),
    )

    def __init__(self, testcase, *, revision=2, models=None):
        target_issue = "2026217"
        self.patterns, self.learning = _resolved_recommendation_payloads(
            target_issue,
            revision,
        )
        prior = json.loads(json.dumps(self.learning))
        for forecast in prior["forecasts"]:
            forecast["targetIssue"] = "2026216"
            forecast["sourceRunId"] = "pattern:2026216"
        self.prior_learning = prior
        self.learning_reviews = {
            "game": "new_macau",
            "reviews": [{
                "run": {
                    "settledIssue": "2026216",
                    "status": "completed",
                    "revision": revision,
                    "revisionSource": "resolved-v2",
                },
                "scores": [
                    {
                        "slot": slot,
                        "official": True,
                        "revision": revision,
                        "targetIssue": "2026216",
                    }
                    for slot, _result_key, _values in self.slots
                ],
                "modelAfter": (
                    [
                        {"slot": slot, "learnedThroughIssue": "2026216"}
                        for slot, _result_key, _values in self.slots
                    ]
                    if models is None else models
                ),
            }],
        }
        primary_slots = (
            "zodiac_6_plus_1",
            "tail_6_plus_1",
            "position_parity",
            "position_size",
        )
        self.lottery = {"draws": [testcase._draw_payload("2026216", True)]}
        self.primary = {
            "targetIssue": target_issue,
            "events": [
                {"slot": slot, "family": "zodiac" if index == 0 else "parity"}
                for index, slot in enumerate(primary_slots)
            ],
        }
        self.primary_reviews = {"reviews": [{"targetIssue": "2026216"}]}
        self.primary_learning = {
            "learningRuns": [{"settledIssue": "2026216", "status": "completed"}],
        }

    def sequence(self, url, _referer):
        if "/api/lottery?" in url:
            return self.lottery
        if "/api/research/forecast?" in url:
            if "&issue=" in url:
                raise HTTPError(url, 404, "error", {}, None)
            return self.primary
        if "/api/research/reviews?" in url:
            return self.primary_reviews
        if "/api/research/learning-runs?" in url:
            return self.primary_learning
        if "/api/research/patterns?" in url:
            return self.patterns
        if "/api/learning/forecast?" in url:
            return self.prior_learning if "&issue=2026216" in url else self.learning
        if "/api/learning/reviews?" in url:
            return self.learning_reviews
        raise AssertionError(f"unexpected health URL: {url}")


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
