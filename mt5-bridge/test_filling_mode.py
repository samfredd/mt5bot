import unittest
from types import SimpleNamespace

from filling import select_filling_mode


class FakeMt5:
    SYMBOL_TRADE_EXECUTION_MARKET = 2
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2


class FillingModeTests(unittest.TestCase):
    def test_uses_fok_when_symbol_only_supports_fok(self) -> None:
        info = SimpleNamespace(filling_mode=1, trade_exemode=2)

        self.assertEqual(select_filling_mode(FakeMt5, info), FakeMt5.ORDER_FILLING_FOK)

    def test_keeps_ioc_when_symbol_supports_ioc(self) -> None:
        info = SimpleNamespace(filling_mode=2, trade_exemode=2)

        self.assertEqual(select_filling_mode(FakeMt5, info), FakeMt5.ORDER_FILLING_IOC)


if __name__ == "__main__":
    unittest.main()
