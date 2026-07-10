import unittest

from scripts.protocol_benchmark import run_benchmark, start_fixture_server, stop_fixture_server


class ProtocolBenchmarkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.server, self.thread = start_fixture_server()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        stop_fixture_server(self.server, self.thread)

    def test_reports_fixed_chunked_and_sse_timing(self) -> None:
        report = run_benchmark(
            self.base_url,
            {
                "cases": [
                    {"name": "fixed", "mode": "fixed", "size": 128},
                    {"name": "chunked", "mode": "chunked", "size": 257, "chunks": 3},
                    {"name": "sse", "mode": "sse", "chunks": 2, "readBytes": 8},
                ]
            },
        )
        fixed, chunked, sse = report["cases"]
        self.assertEqual(fixed["receivedBytes"], 128)
        self.assertEqual(chunked["receivedBytes"], 257)
        self.assertIsNotNone(sse["firstSseEventMs"])
        self.assertGreater(sse["receivedBytes"], 0)
        self.assertTrue(all(case["firstByteMs"] is not None for case in report["cases"]))

    def test_reports_slow_consumption_and_client_abort(self) -> None:
        report = run_benchmark(
            self.base_url,
            {
                "cases": [
                    {"name": "slow", "mode": "chunked", "size": 4096, "chunks": 4, "slowReadMs": 1},
                    {"name": "abort", "mode": "chunked", "size": 65536, "chunks": 8, "abortAfterBytes": 1024},
                ]
            },
        )
        slow, aborted = report["cases"]
        self.assertEqual(slow["receivedBytes"], 4096)
        self.assertTrue(aborted["abortedByClient"])
        self.assertLess(aborted["receivedBytes"], 65536)

    def test_reports_disconnect_and_malformed_response_without_crashing(self) -> None:
        report = run_benchmark(
            self.base_url,
            {"cases": [{"mode": "disconnect", "size": 1024}, {"mode": "malformed"}]},
        )
        disconnected, malformed = report["cases"]
        self.assertIsNotNone(disconnected["error"])
        self.assertIsNotNone(malformed["error"])


if __name__ == "__main__":
    unittest.main()

