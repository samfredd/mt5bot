SYMBOL_FILLING_FOK = 1
SYMBOL_FILLING_IOC = 2


def select_filling_mode(mt5, symbol_info) -> int:
    """Choose an order filling policy supported by the broker symbol."""
    flags = int(symbol_info.filling_mode)
    if flags & SYMBOL_FILLING_IOC:
        return mt5.ORDER_FILLING_IOC
    if flags & SYMBOL_FILLING_FOK:
        return mt5.ORDER_FILLING_FOK
    if symbol_info.trade_exemode == mt5.SYMBOL_TRADE_EXECUTION_MARKET:
        return mt5.ORDER_FILLING_FOK
    return mt5.ORDER_FILLING_RETURN
