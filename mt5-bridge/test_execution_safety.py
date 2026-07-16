import os
import unittest

os.environ.setdefault("MT5_MOCK", "true")

from main import MockBroker, OrderRequest  # noqa: E402


class ExecutionSafetyTests(unittest.TestCase):
    def setUp(self):
        self.broker = MockBroker()

    def request(self, client_order_id="mt5b-test-order-001", expected_login="mock-12345678"):
        return OrderRequest(
            symbol="EURUSD",
            direction="buy",
            volume=0.1,
            client_order_id=client_order_id,
            expected_login=expected_login,
            expected_server="MockBroker-Demo",
            comment=f"mt5bot:{client_order_id}",
        )

    def test_client_order_id_is_idempotent(self):
        first = self.broker.place(self.request())
        second = self.broker.place(self.request())
        self.assertEqual(first, second)
        self.assertEqual(len(self.broker.positions), 1)

    def test_account_fence_rejects_wrong_login(self):
        result = self.broker.place(self.request(expected_login="different-account"))
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "REJECTED")
        self.assertEqual(len(self.broker.positions), 0)


if __name__ == "__main__":
    unittest.main()
