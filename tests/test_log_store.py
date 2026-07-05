import datetime as dt
import unittest

from llm_proxy.log_store import LogStore


class LogStoreTests(unittest.TestCase):
    def test_display_timestamp_formats_local_time(self) -> None:
        timestamp = dt.datetime.now().astimezone().isoformat(timespec="milliseconds")
        expected = dt.datetime.fromisoformat(timestamp).astimezone().strftime("%Y-%m-%d %H:%M:%S")

        store = LogStore.__new__(LogStore)

        self.assertEqual(store._display_timestamp(timestamp), expected)
