import unittest

from llm_proxy import join_target_path


class JoinTargetPathTests(unittest.TestCase):
    """验证上游 base path 和客户端 path 的拼接规则。"""

    def test_prepends_target_base_path(self) -> None:
        self.assertEqual(join_target_path("/v1", "/chat/completions"), "/v1/chat/completions")

    def test_does_not_duplicate_existing_base_path(self) -> None:
        self.assertEqual(join_target_path("/v1", "/v1/chat/completions"), "/v1/chat/completions")

    def test_does_not_duplicate_existing_base_path_with_query(self) -> None:
        self.assertEqual(join_target_path("/v1", "/v1/models?limit=10"), "/v1/models?limit=10")

    def test_base_path_match_requires_path_boundary(self) -> None:
        self.assertEqual(join_target_path("/v1", "/v10/models"), "/v1/v10/models")

    def test_accepts_request_path_without_leading_slash(self) -> None:
        self.assertEqual(join_target_path("/api/v1", "models"), "/api/v1/models")
