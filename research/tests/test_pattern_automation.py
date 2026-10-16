import hashlib
import hmac
import json
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from io import BytesIO
from marksix_research import cli
from test_pipeline import _FakeResponse, _resolved_recommendation_payloads

class PatternAutomationTest(unittest.TestCase):
    def test_waiting_response_is_not_cached_and_same_task_retries(self):
        waiting = dict(status='awaiting_verification')
        ready = dict(status='created',targetIssue='2026289')
        requests = []
        def respond(request, timeout):
            requests.append(request)
            timestamp = request.get_header('X-research-timestamp')
            signature = hmac.new(b'secret', timestamp.encode()+b'.'+request.data,hashlib.sha256).hexdigest()
            self.assertEqual(request.get_header('X-research-signature'), signature)
            self.assertTrue(request.full_url.endswith('/api/internal/patterns/settle-and-freeze'))
            if len(requests)==1:
                raise HTTPError(request.full_url,425,'waiting',{},BytesIO(json.dumps(waiting).encode()))
            return _FakeResponse(ready)
        with patch.object(cli,'urlopen',side_effect=respond):
            self.assertEqual(cli.capture_patterns('https://test','secret','new_macau')['status'],'awaiting_verification')
            self.assertEqual(cli.capture_patterns('https://test','secret','new_macau')['targetIssue'],'2026289')
        self.assertEqual(requests[0].data,requests[1].data)

    def test_gate_and_health_do_not_read_retired_strategy_endpoints(self):
        patterns, learning = _resolved_recommendation_payloads('2026289',revision=1)
        seen = []
        def respond(url, referer):
            seen.append(url)
            if '/api/lottery?' in url: return {'draws':[{'issue':'2026288','verified':True}]}
            if '/api/research/patterns/reviews?' in url: return {'review':{'score':{'targetIssue':'2026288'}}}
            if '/api/research/patterns?' in url: return patterns
            if '/api/learning/forecast?' in url:
                if '&issue=' in url: raise HTTPError(url,404,'missing',{},None)
                return learning
            raise AssertionError(url)
        with patch.object(cli,'fetch_json',side_effect=respond):
            self.assertFalse(cli.check_update_required('https://test','new_macau')['shouldRun'])
            self.assertEqual(cli.verify_production_health('https://test','new_macau')['targetIssue'],'2026289')
        self.assertFalse(any('/api/research/forecast' in x for x in seen))

    def test_stale_pattern_target_requires_update_even_if_learning_looks_current(self):
        with patch.object(cli,'fetch_json',return_value={'draws':[{'issue':'2026288','verified':True}]}), patch.object(cli,'_patterns',return_value={'run':{'targetIssue':'2026288'}}):
            self.assertTrue(cli.check_update_required('https://test','new_macau')['shouldRun'])
            with self.assertRaisesRegex(RuntimeError,'did not advance pattern target'):
                cli.verify_production_health('https://test','new_macau')

    def test_unsettled_pattern_archive_fails_health(self):
        patterns, learning = _resolved_recommendation_payloads('2026289',revision=1)
        with patch.object(cli,'_latest',return_value=({'issue':'2026288','verified':True},30)), patch.object(cli,'_patterns',return_value=patterns), patch.object(cli,'_prior_review',return_value=True), patch.object(cli,'fetch_optional_json',side_effect=[learning,{'review':{'score':None}}]):
            with self.assertRaisesRegex(RuntimeError,'pattern review missing'):
                cli.verify_production_health('https://test','new_macau')

    def test_cycle_does_not_freeze_learning_while_pattern_waits(self):
        with patch.object(cli,'capture_patterns',return_value={'status':'awaiting_verification'}), patch.object(cli,'capture_forward_learning') as forward:
            self.assertEqual(cli.run_cycle('https://test','secret','new_macau','/tmp/unused')['status'],'awaiting_verification')
            forward.assert_not_called()
