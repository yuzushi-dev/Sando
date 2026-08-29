#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("weekly_report.py")
SPEC = importlib.util.spec_from_file_location("weekly_report", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class WeeklyReportTest(unittest.TestCase):
    def test_sando_summary_counts_window_and_known_session_average(self):
        state = {
            "timezone": "Europe/Rome",
            "records": [
                {"at": "2026-08-17T10:00:00+00:00", "estimatedTransformSavingsTokens": 100,
                 "estimatedInputTokens": 200, "estimatedInlineTokens": 100, "sessionId": "a"},
                {"at": "2026-08-17T11:00:00+00:00", "estimatedTransformSavingsTokens": 50,
                 "estimatedInputTokens": 100, "estimatedInlineTokens": 50, "sessionId": "a"},
                {"at": "2026-08-18T10:00:00+00:00", "estimatedTransformSavingsTokens": 30,
                 "estimatedInputTokens": 60, "estimatedInlineTokens": 30, "sessionId": None},
            ],
        }
        result = MODULE.sando_summary(
            state,
            datetime(2026, 8, 17, tzinfo=timezone.utc),
            datetime(2026, 8, 23, 16, tzinfo=timezone.utc),
        )
        self.assertEqual(result["saved_tokens"], 180)
        self.assertEqual(result["events"], 3)
        self.assertEqual(result["known_sessions"], 1)
        self.assertEqual(result["unknown_session_events"], 1)
        self.assertEqual(result["average_per_known_session"], 150)

    def test_render_html_uses_report_skin_and_escapes_values(self):
        html = MODULE.render_html(
            {"start": "2026-08-17", "end": "2026-08-23", "timezone": "Europe/Rome",
             "sando": {"saved_tokens": 7, "saved_pct": 10,
             "events": 1, "average_per_known_session": None, "unknown_session_events": 1},
             "comparison": [{"tool": "Honey <x>", "saved": "N/D", "pct": None, "status": "non disponibile", "evidence": "test"}]},
            "Test <User>",
        )
        self.assertIn("LOCAL MEASUREMENT", html)
        self.assertIn("Test &lt;User&gt;", html)
        self.assertNotIn("Test <User>", html)
        self.assertIn("cyber", html)
        self.assertIn("Mechanical reduction", html)
        self.assertNotIn("RTK", html)

    def test_load_env_does_not_use_n8n(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "debrief.env"
            path.write_text(
                "TASK_RUNNER_SMTP_HOST=smtp.example.test\n"
                "TASK_RUNNER_SMTP_PORT=587\n"
                "TASK_RUNNER_SMTP_USER=user\n"
                "TASK_RUNNER_SMTP_PASSWORD=secret\n"
                "TASK_RUNNER_N8N_WEBHOOK_URL=https://must-not-be-used\n"
            )
            values = MODULE.load_env(path)
        self.assertEqual(values["TASK_RUNNER_SMTP_HOST"], "smtp.example.test")
        self.assertNotIn("TASK_RUNNER_N8N_WEBHOOK_URL", values)

    def test_report_has_no_cross_tool_token_scoreboard(self):
        report = MODULE.build_report(
            {"timezone": "UTC", "records": []},
            datetime(2026, 8, 17, tzinfo=timezone.utc),
        )

        self.assertNotIn("comparison", report)
        self.assertNotIn("RTK", MODULE.render_text(report))


if __name__ == "__main__":
    unittest.main()
