import datetime as dt
import unittest

from llm_proxy.time_utils import format_local_timestamp, local_datetime_from_timestamp, local_now_iso


class TimeUtilsTests(unittest.TestCase):
    def test_local_now_iso_includes_local_timezone(self) -> None:
        before = dt.datetime.now().astimezone()
        parsed = dt.datetime.fromisoformat(local_now_iso())
        after = dt.datetime.now().astimezone()

        self.assertIsNotNone(parsed.tzinfo)
        self.assertLessEqual(before.timestamp() - 0.01, parsed.timestamp())
        self.assertLessEqual(parsed.timestamp(), after.timestamp() + 0.01)
        self.assertEqual(parsed.utcoffset(), parsed.astimezone().utcoffset())

    def test_format_local_timestamp_uses_system_local_timezone(self) -> None:
        timestamp = "2026-07-06T00:00:00+00:00"
        expected = dt.datetime.fromisoformat(timestamp).astimezone().strftime("%Y-%m-%d %H:%M:%S")

        self.assertEqual(local_datetime_from_timestamp(timestamp), dt.datetime.fromisoformat(timestamp).astimezone())
        self.assertEqual(format_local_timestamp(timestamp, "%Y-%m-%d %H:%M:%S"), expected)
