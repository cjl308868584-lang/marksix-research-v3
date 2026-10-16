import json
from io import BytesIO
from pathlib import Path
import subprocess
import unittest
from urllib.error import HTTPError
from unittest.mock import patch
from marksix_research import cli

class AutomationContractTest(unittest.TestCase):
    def test_signed_internal_route_payload_satisfies_the_python_capture_contract(self):
        root = Path(__file__).resolve().parents[2]
        rendered = subprocess.run(
            ["node", "tests/support/render-internal-forward-learning-response.ts"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(rendered.stdout)

        with patch.object(cli, "urlopen", return_value=_FakeResponse(payload)):
            result = cli.capture_forward_learning(
                "https://example.test",
                "secret",
                "hk",
                "2099001",
            )

        self.assertEqual(result["revision"], 1)
        self.assertEqual(result["forecastCount"], 5)

    def test_unscored_v1_transition_route_returns_a_resolved_v2_contract(self):
        root = Path(__file__).resolve().parents[2]
        rendered = subprocess.run(
            [
                "node",
                "tests/support/render-internal-forward-learning-response.ts",
                "transition",
            ],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(rendered.stdout)

        with patch.object(cli, "urlopen", return_value=_FakeResponse(payload)):
            result = cli.capture_forward_learning(
                "https://example.test",
                "secret",
                "new_macau",
                "2099001",
            )

        self.assertEqual(result["status"], "created")
        self.assertEqual(result["revision"], 2)
        self.assertEqual(result["forecastCount"], 5)

    def test_backdated_as_of_cannot_reopen_a_closed_v1_transition_window(self):
        root = Path(__file__).resolve().parents[2]
        rendered = subprocess.run(
            [
                "node",
                "tests/support/render-internal-forward-learning-response.ts",
                "transition-blocked",
            ],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(rendered.stdout)

        self.assertEqual(payload["_httpStatus"], 425)
        self.assertEqual(payload["status"], "awaiting_unified_target")
        self.assertEqual(payload["forecastCount"], 0)

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
    def _raw_forward_payload(cls, target_issue, revision=2):
        payload = cls._forward_forecast_payload(target_issue, revision)
        for forecast in payload["forecasts"]:
            forecast["selectionPolicy"] = "rolling-product-ev-v2"
        return payload

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
    def _forward_forecast_payload(target_issue, revision=2):
        return _resolved_recommendation_payloads(target_issue, revision)[1]

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
            "learningSettledCount": 2,
            "learningHitCount": 1,
            "product": {
                "runId": source_run_id,
                "targetIssue": target_issue,
                "kind": kind,
                "values": values,
            },
        })
    forecasts = json.loads(json.dumps(recommendations))
    for forecast, (slot, _result_key, _values) in zip(forecasts, slots):
        forecast.update({
            "slot": slot,
            "official": True,
            "targetIssue": target_issue,
            "revision": revision,
        })
        forecast.pop("product", None)
    for recommendation in recommendations:
        recommendation["revision"] = 0
    patterns = {
        "game": "new_macau",
        "status": "completed",
        "run": {"runId": source_run_id, "targetIssue": target_issue},
        "recommendations": recommendations,
    }
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
