"""
MT5 Bridge — the ONLY process that talks to MetaTrader 5.

Two modes:
  * MT5_MOCK=true  (default): a self-contained mock broker with random-walk
    prices and a paper position book. Runs on any OS — use this for all
    development and demo testing.
  * MT5_MOCK=false: wraps the official MetaTrader5 Python package
    (Windows / Wine only). Credentials come from environment variables set
    by the operator, never from API calls.

Every request requires the X-API-Key header. Every order/modify/close is
logged to stdout (the backend additionally writes its own audit trail).
"""

import logging
import os
import random
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from filling import select_filling_mode

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mt5-bridge")

MOCK = os.environ.get("MT5_MOCK", "true").lower() in ("1", "true", "yes")
API_KEY = os.environ.get("BRIDGE_API_KEY", "change-me-bridge-key")

app = FastAPI(title="MT5 Bridge", version="0.1.0")


def require_key(x_api_key: str = Header(default="")) -> None:
    if x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")


class OrderRequest(BaseModel):
    symbol: str
    direction: str = Field(pattern="^(buy|sell)$")
    volume: float = Field(gt=0, le=100)
    sl: float | None = None
    tp: float | None = None
    comment: str = "mt5bot"


class ModifyRequest(BaseModel):
    sl: float | None = None
    tp: float | None = None


class ConnectRequest(BaseModel):
    login: int
    password: str
    server: str


# ---------------------------------------------------------------------------
# Mock broker
# ---------------------------------------------------------------------------

MOCK_SYMBOLS = {
    "EURUSD": 1.0850, "GBPUSD": 1.2700, "USDJPY": 151.50, "AUDUSD": 0.6550,
    "USDCAD": 1.3600, "XAUUSD": 2350.0, "BTCUSD": 68000.0, "US30": 39000.0,
    "NAS100": 18200.0, "GBPJPY": 192.40,
}

TIMEFRAME_MINUTES = {"M1": 1, "M5": 5, "M15": 15, "M30": 30, "H1": 60, "H4": 240, "D1": 1440}


class MockBroker:
    """Paper broker: random-walk prices, position book, SL/TP fills."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.prices = {s: p for s, p in MOCK_SYMBOLS.items()}
        self.balance = 10_000.0
        self.positions: dict[str, dict] = {}
        self.deals: list[dict] = []
        self.seeds = {s: random.Random(hash(s) & 0xFFFF) for s in MOCK_SYMBOLS}
        t = threading.Thread(target=self._tick_loop, daemon=True)
        t.start()

    def _vol(self, symbol: str) -> float:
        base = self.prices[symbol]
        return base * 0.00008  # ~0.8 pip-equivalent step

    def _tick_loop(self) -> None:
        while True:
            with self.lock:
                for s in self.prices:
                    drift = self.seeds[s].gauss(0, 1) * self._vol(s)
                    self.prices[s] = max(self.prices[s] + drift, 0.0001)
                self._check_sl_tp()
            time.sleep(1)

    def _spread(self, symbol: str) -> float:
        return self.prices[symbol] * 0.00006

    def tick(self, symbol: str) -> dict:
        if symbol not in self.prices:
            raise HTTPException(404, f"unknown symbol {symbol}")
        mid = self.prices[symbol]
        half = self._spread(symbol) / 2
        digits = 5 if mid < 100 else 2
        return {
            "symbol": symbol,
            "bid": round(mid - half, digits),
            "ask": round(mid + half, digits),
            "spread_points": round((half * 2) / (10 ** -digits)),
            "time": datetime.now(timezone.utc).isoformat(),
        }

    def symbol_info(self, symbol: str) -> dict:
        if symbol not in self.prices:
            raise HTTPException(404, f"unknown symbol {symbol}")
        price = self.prices[symbol]
        is_jpy = symbol.endswith("JPY")
        digits = 3 if is_jpy else (5 if price < 100 else 2)
        point = 10 ** -digits
        contract = 100_000 if len(symbol) >= 6 and symbol[:6].isalpha() else 1
        tick_value = point * contract
        if is_jpy and price > 0:
            tick_value /= price
        return {
            "symbol": symbol,
            "digits": digits,
            "point": point,
            "trade_tick_size": point,
            "trade_tick_value": tick_value,
            "volume_min": 0.01,
            "volume_max": 100.0,
            "volume_step": 0.01,
            "trade_stops_level": 0,
        }

    def candles(self, symbol: str, timeframe: str, count: int) -> list[dict]:
        if symbol not in self.prices:
            raise HTTPException(404, f"unknown symbol {symbol}")
        minutes = TIMEFRAME_MINUTES.get(timeframe, 60)
        rng = random.Random(hash((symbol, timeframe)) & 0xFFFFFFFF)
        out: list[dict] = []
        price = self.prices[symbol] * (1 - 0.001 * rng.random())
        now = datetime.now(timezone.utc)
        start = now - timedelta(minutes=minutes * count)
        vol = price * 0.0006 * (minutes ** 0.5) / 8
        for i in range(count):
            o = price
            h = o + abs(rng.gauss(0, vol))
            l = o - abs(rng.gauss(0, vol))
            c = max(min(rng.gauss(o, vol), h), l)
            price = c
            digits = 5 if price < 100 else 2
            out.append({
                "time": (start + timedelta(minutes=minutes * i)).isoformat(),
                "open": round(o, digits), "high": round(h, digits),
                "low": round(l, digits), "close": round(c, digits),
                "tick_volume": rng.randint(100, 2000),
            })
        return out

    def _pnl(self, pos: dict) -> float:
        mid = self.prices[pos["symbol"]]
        diff = mid - pos["price_open"] if pos["type"] == "buy" else pos["price_open"] - mid
        contract = 100_000 if mid < 1000 else 1  # crude FX vs index/crypto split
        return round(diff * pos["volume"] * contract, 2)

    def account(self) -> dict:
        with self.lock:
            floating = sum(self._pnl(p) for p in self.positions.values())
            equity = self.balance + floating
            margin = sum(p["volume"] * 1000 for p in self.positions.values())
            return {
                "login": "mock-12345678",
                "balance": round(self.balance, 2),
                "equity": round(equity, 2),
                "margin": round(margin, 2),
                "free_margin": round(equity - margin, 2),
                "margin_level": round((equity / margin) * 100, 2) if margin else 100000.0,
                "currency": "USD",
                "is_demo": True,
                "server": "MockBroker-Demo",
            }

    def open_positions(self) -> list[dict]:
        with self.lock:
            return [
                {**p, "profit": self._pnl(p), "price_current": round(self.prices[p["symbol"]], 5 if self.prices[p["symbol"]] < 100 else 2)}
                for p in self.positions.values()
            ]

    def place(self, req: OrderRequest) -> dict:
        with self.lock:
            t = self.tick_unlocked(req.symbol)
            price = t["ask"] if req.direction == "buy" else t["bid"]
            ticket = uuid.uuid4().hex[:10]
            self.positions[ticket] = {
                "ticket": ticket, "symbol": req.symbol, "type": req.direction,
                "volume": req.volume, "price_open": price, "sl": req.sl, "tp": req.tp,
                "time": datetime.now(timezone.utc).isoformat(),
            }
            log.info("MOCK ORDER %s %s %s %.2f lots @ %s sl=%s tp=%s", ticket, req.direction, req.symbol, req.volume, price, req.sl, req.tp)
            # Mock has one ticket per position, so position_id == ticket.
            return {"ok": True, "ticket": ticket, "position_id": ticket, "price": price, "retcode": 10009}

    def tick_unlocked(self, symbol: str) -> dict:
        if symbol not in self.prices:
            raise HTTPException(404, f"unknown symbol {symbol}")
        mid = self.prices[symbol]
        half = self._spread(symbol) / 2
        digits = 5 if mid < 100 else 2
        return {"bid": round(mid - half, digits), "ask": round(mid + half, digits)}

    def modify(self, ticket: str, req: ModifyRequest) -> dict:
        with self.lock:
            pos = self.positions.get(ticket)
            if not pos:
                return {"ok": False, "error": "position not found"}
            if req.sl is not None:
                pos["sl"] = req.sl
            if req.tp is not None:
                pos["tp"] = req.tp
            return {"ok": True, "ticket": ticket}

    def close(self, ticket: str) -> dict:
        with self.lock:
            return self._close_unlocked(ticket, reason="manual")

    def _close_unlocked(self, ticket: str, reason: str) -> dict:
        pos = self.positions.pop(ticket, None)
        if not pos:
            return {"ok": False, "error": "position not found"}
        pnl = self._pnl(pos)
        self.balance += pnl
        deal = {**pos, "position_id": ticket, "profit": pnl, "close_time": datetime.now(timezone.utc).isoformat(), "reason": reason}
        self.deals.append(deal)
        log.info("MOCK CLOSE %s (%s) pnl=%.2f balance=%.2f", ticket, reason, pnl, self.balance)
        return {"ok": True, "ticket": ticket, "price": self.prices[pos["symbol"]], "profit": pnl}

    def _check_sl_tp(self) -> None:
        for ticket, pos in list(self.positions.items()):
            mid = self.prices[pos["symbol"]]
            sl, tp = pos.get("sl"), pos.get("tp")
            if pos["type"] == "buy":
                if sl and mid <= sl:
                    self._close_unlocked(ticket, "sl")
                elif tp and mid >= tp:
                    self._close_unlocked(ticket, "tp")
            else:
                if sl and mid >= sl:
                    self._close_unlocked(ticket, "sl")
                elif tp and mid <= tp:
                    self._close_unlocked(ticket, "tp")

    def history(self, days: int) -> list[dict]:
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        return [d for d in self.deals if datetime.fromisoformat(d["close_time"]) >= cutoff]

    def connected(self) -> bool:
        return True  # the mock broker is always "connected"


# ---------------------------------------------------------------------------
# Real MT5 adapter (Windows / Wine only)
# ---------------------------------------------------------------------------

class RealBroker:
    """Thin adapter over the official MetaTrader5 package."""

    TF_MAP_NAMES = {"M1": "TIMEFRAME_M1", "M5": "TIMEFRAME_M5", "M15": "TIMEFRAME_M15",
                    "M30": "TIMEFRAME_M30", "H1": "TIMEFRAME_H1", "H4": "TIMEFRAME_H4", "D1": "TIMEFRAME_D1"}

    def __init__(self) -> None:
        import MetaTrader5 as mt5  # type: ignore

        self.mt5 = mt5
        kwargs = {}
        if os.environ.get("MT5_LOGIN"):
            kwargs = {
                "login": int(os.environ["MT5_LOGIN"]),
                "password": os.environ.get("MT5_PASSWORD", ""),
                "server": os.environ.get("MT5_SERVER", ""),
            }
        if os.environ.get("MT5_PORTABLE", "").lower() in ("1", "true", "yes"):
            kwargs["portable"] = True
        # Optional explicit terminal path (required in the Wine container).
        path = os.environ.get("MT5_PATH")
        self._init_args = (path,) if path else ()
        self._init_kwargs = kwargs
        self._initialize()
        log.info("connected to MetaTrader 5 terminal")

    def _initialize(self) -> None:
        # Under Wine the terminal can take a while to come up — retry.
        retries = int(os.environ.get("MT5_INIT_RETRIES", "6"))
        for attempt in range(retries):
            if self.mt5.initialize(*self._init_args, **self._init_kwargs):
                return
            log.warning("MT5 initialize attempt %d/%d failed: %s", attempt + 1, retries, self.mt5.last_error())
            time.sleep(10)
        raise RuntimeError(f"MT5 initialize failed after {retries} attempts: {self.mt5.last_error()}")

    def reinitialize(self) -> None:
        """Tear down and re-open the IPC channel to the terminal. Needed after
        an IPC timeout, which can leave the channel in a wedged state."""
        self.mt5.shutdown()
        self._initialize()
        log.info("reinitialized MetaTrader 5 terminal connection")

    def _ensure_symbol(self, symbol: str):
        info = self.mt5.symbol_info(symbol)
        if info is None:
            raise HTTPException(404, f"symbol {symbol} unavailable")
        if not getattr(info, "visible", True):
            if not self.mt5.symbol_select(symbol, True):
                raise HTTPException(404, f"symbol {symbol} unavailable: {self.mt5.last_error()}")
            info = self.mt5.symbol_info(symbol)
            if info is None:
                raise HTTPException(404, f"symbol {symbol} unavailable after select")
        return info

    def account(self) -> dict:
        info = self.mt5.account_info()
        if info is None:
            raise HTTPException(502, "MT5 account_info failed")
        return {
            "login": str(info.login), "balance": info.balance, "equity": info.equity,
            "margin": info.margin, "free_margin": info.margin_free,
            "margin_level": info.margin_level or 0.0, "currency": info.currency,
            "is_demo": info.trade_mode == 0,
            "server": info.server,
        }

    def tick(self, symbol: str) -> dict:
        info = self._ensure_symbol(symbol)
        t = None
        for attempt in range(3):
            t = self.mt5.symbol_info_tick(symbol)
            if t is not None:
                break
            time.sleep(0.2 * (attempt + 1))
        if t is None:
            raise HTTPException(404, f"symbol {symbol} unavailable")
        return {
            "symbol": symbol, "bid": t.bid, "ask": t.ask,
            "spread_points": info.spread,
            "time": datetime.fromtimestamp(t.time, tz=timezone.utc).isoformat(),
        }

    def symbol_info(self, symbol: str) -> dict:
        info = self._ensure_symbol(symbol)
        tick_value = info.trade_tick_value or info.trade_tick_value_profit or info.trade_tick_value_loss
        return {
            "symbol": symbol,
            "digits": int(info.digits),
            "point": float(info.point),
            "trade_tick_size": float(info.trade_tick_size or info.point),
            "trade_tick_value": float(tick_value),
            "volume_min": float(info.volume_min),
            "volume_max": float(info.volume_max),
            "volume_step": float(info.volume_step),
            "trade_stops_level": int(info.trade_stops_level),
        }

    def candles(self, symbol: str, timeframe: str, count: int) -> list[dict]:
        self._ensure_symbol(symbol)
        tf = getattr(self.mt5, self.TF_MAP_NAMES.get(timeframe, "TIMEFRAME_H1"))
        rates = None
        for attempt in range(3):
            rates = self.mt5.copy_rates_from_pos(symbol, tf, 0, count)
            if rates is not None and len(rates) > 0:
                break
            time.sleep(0.5 * (attempt + 1))
        if rates is None or len(rates) == 0:
            raise HTTPException(502, f"copy_rates failed: {self.mt5.last_error()}")
        return [
            {
                "time": datetime.fromtimestamp(int(r["time"]), tz=timezone.utc).isoformat(),
                "open": float(r["open"]), "high": float(r["high"]),
                "low": float(r["low"]), "close": float(r["close"]),
                "tick_volume": int(r["tick_volume"]),
            }
            for r in rates
        ]

    def open_positions(self) -> list[dict]:
        positions = self.mt5.positions_get() or []
        return [
            {
                "ticket": str(p.ticket), "symbol": p.symbol,
                "type": "buy" if p.type == 0 else "sell", "volume": p.volume,
                "price_open": p.price_open, "price_current": p.price_current,
                "sl": p.sl or None, "tp": p.tp or None,
                "profit": p.profit,
                "time": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
            }
            for p in positions
        ]

    def place(self, req: OrderRequest) -> dict:
        mt5 = self.mt5
        info = self._ensure_symbol(req.symbol)
        t = mt5.symbol_info_tick(req.symbol)
        if t is None:
            return {"ok": False, "error": f"no tick for {req.symbol}"}
        order_type = mt5.ORDER_TYPE_BUY if req.direction == "buy" else mt5.ORDER_TYPE_SELL
        price = t.ask if req.direction == "buy" else t.bid
        request = {
            "action": mt5.TRADE_ACTION_DEAL, "symbol": req.symbol, "volume": req.volume,
            "type": order_type, "price": price, "deviation": 20, "magic": 770077,
            "comment": req.comment, "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": select_filling_mode(mt5, info),
        }
        if req.sl:
            request["sl"] = req.sl
        if req.tp:
            request["tp"] = req.tp
        result = mt5.order_send(request)
        if result is None:
            return {"ok": False, "error": str(mt5.last_error())}
        ok = result.retcode == mt5.TRADE_RETCODE_DONE
        # Resolve the POSITION identifier (not just the order ticket). They are
        # equal on a hedging account, but on a netting account a new order
        # merges into the existing position whose id is the first order's
        # ticket — the backend reconciles/closes/modifies by this id.
        position_id = str(result.order) if ok else None
        if ok and getattr(result, "deal", 0):
            try:
                deals = mt5.history_deals_get(ticket=int(result.deal))
                if deals:
                    position_id = str(deals[0].position_id)
            except Exception as exc:  # noqa: BLE001 — fall back to order ticket
                log.warning("could not resolve position_id from deal %s: %s", result.deal, exc)
        return {
            "ok": ok, "ticket": str(result.order) if ok else None,
            "position_id": position_id,
            "price": result.price, "retcode": result.retcode,
            "error": None if ok else f"retcode {result.retcode}: {result.comment}",
        }

    def modify(self, ticket: str, req: ModifyRequest) -> dict:
        mt5 = self.mt5
        positions = mt5.positions_get(ticket=int(ticket))
        if not positions:
            return {"ok": False, "error": "position not found"}
        p = positions[0]
        result = mt5.order_send({
            "action": mt5.TRADE_ACTION_SLTP, "symbol": p.symbol, "position": p.ticket,
            "sl": req.sl if req.sl is not None else p.sl,
            "tp": req.tp if req.tp is not None else p.tp,
        })
        ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
        return {"ok": ok, "ticket": ticket, "error": None if ok else str(mt5.last_error())}

    def close(self, ticket: str) -> dict:
        mt5 = self.mt5
        positions = mt5.positions_get(ticket=int(ticket))
        if not positions:
            return {"ok": False, "error": "position not found"}
        p = positions[0]
        info = self._ensure_symbol(p.symbol)
        t = mt5.symbol_info_tick(p.symbol)
        if t is None:
            return {"ok": False, "error": f"no tick for {p.symbol}"}
        close_type = mt5.ORDER_TYPE_SELL if p.type == 0 else mt5.ORDER_TYPE_BUY
        price = t.bid if p.type == 0 else t.ask
        result = mt5.order_send({
            "action": mt5.TRADE_ACTION_DEAL, "symbol": p.symbol, "volume": p.volume,
            "type": close_type, "position": p.ticket, "price": price,
            "deviation": 20, "magic": 770077, "comment": "mt5bot-close",
            "type_time": mt5.ORDER_TIME_GTC, "type_filling": select_filling_mode(mt5, info),
        })
        ok = result is not None and result.retcode == mt5.TRADE_RETCODE_DONE
        return {"ok": ok, "ticket": ticket, "price": price, "error": None if ok else str(mt5.last_error())}

    def history(self, days: int) -> list[dict]:
        mt5 = self.mt5
        frm = datetime.now(timezone.utc) - timedelta(days=days)
        # Pad the upper bound a day into the future. The broker's trade server
        # runs ahead of UTC (commonly UTC+2/+3), and history_deals_get compares
        # the range against server time — so passing `now (UTC)` as the upper
        # bound silently drops every deal that closed today, which made same-day
        # scalp exits come back unattributable (profit=null on reconciliation).
        # (There is no history_select in the Python MT5 package; history_deals_get
        # selects the range itself.)
        to = datetime.now(timezone.utc) + timedelta(days=1)
        deals = mt5.history_deals_get(frm, to) or []
        log.info("history(%dd): %d deals in %s..%s", days, len(deals), frm.date(), to.date())
        return [
            {"ticket": str(d.ticket), "position_id": str(d.position_id),
             "symbol": d.symbol, "volume": d.volume,
             "price": d.price, "profit": d.profit,
             "time": datetime.fromtimestamp(d.time, tz=timezone.utc).isoformat()}
            for d in deals
        ]

    def connected(self) -> bool:
        """Real connectivity: the terminal AND an account must both be live."""
        try:
            return self.mt5.terminal_info() is not None and self.mt5.account_info() is not None
        except Exception:  # noqa: BLE001 — any IPC error means not connected
            return False


broker = MockBroker() if MOCK else RealBroker()
log.info("bridge started in %s mode", "MOCK" if MOCK else "REAL")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict:
    connected = broker.connected()
    return {"ok": connected, "mock": MOCK, "connected": connected}


@app.get("/account", dependencies=[Depends(require_key)])
def account() -> dict:
    return broker.account()


@app.get("/positions", dependencies=[Depends(require_key)])
def positions() -> dict:
    return {"positions": broker.open_positions()}


@app.get("/history", dependencies=[Depends(require_key)])
def history(days: int = 30) -> dict:
    return {"deals": broker.history(days)}


@app.get("/tick/{symbol}", dependencies=[Depends(require_key)])
def tick(symbol: str) -> dict:
    return broker.tick(symbol)


@app.get("/symbol/{symbol}", dependencies=[Depends(require_key)])
def symbol_info(symbol: str) -> dict:
    return broker.symbol_info(symbol)


@app.get("/candles/{symbol}", dependencies=[Depends(require_key)])
def candles(symbol: str, timeframe: str = "H1", count: int = 200) -> dict:
    # Large counts are for backtesting (MT5 keeps years of H1 history).
    return {"candles": broker.candles(symbol, timeframe, min(count, 50000))}


@app.get("/symbols", dependencies=[Depends(require_key)])
def symbols() -> dict:
    if MOCK:
        return {"symbols": list(MOCK_SYMBOLS.keys())}
    syms = broker.mt5.symbols_get() or []  # type: ignore[union-attr]
    return {"symbols": [s.name for s in syms]}


@app.post("/connect", dependencies=[Depends(require_key)])
def connect(req: ConnectRequest) -> dict:
    """Switch the terminal to another account (demo or real). Credentials are
    used for the login call only and never logged or stored here."""
    if MOCK:
        log.info("MOCK CONNECT login=%s server=%s", req.login, req.server)
        return {"ok": True, "login": str(req.login), "is_demo": True, "balance": broker.balance}
    # Switching to a server the terminal hasn't seen before can take well over
    # the package's 60s default while it fetches the server config.
    timeout_ms = int(os.environ.get("MT5_LOGIN_TIMEOUT_MS", "90000"))
    ok = broker.mt5.login(req.login, password=req.password, server=req.server, timeout=timeout_ms)  # type: ignore[union-attr]
    if not ok:
        err = broker.mt5.last_error()  # type: ignore[union-attr]
        if err and err[0] == -10005:  # IPC timeout leaves the channel wedged — re-open and retry once
            log.warning("login hit IPC timeout for login=%s, reinitializing terminal connection", req.login)
            try:
                broker.reinitialize()  # type: ignore[union-attr]
            except RuntimeError as exc:
                return {"ok": False, "error": str(exc)}
            ok = broker.mt5.login(req.login, password=req.password, server=req.server, timeout=timeout_ms)  # type: ignore[union-attr]
            if not ok:
                err = broker.mt5.last_error()  # type: ignore[union-attr]
    if not ok:
        log.warning("account switch failed for login=%s server=%s: %s", req.login, req.server, err)
        return {"ok": False, "error": str(err)}
    info = broker.account()
    log.info("switched terminal to account %s on %s (demo=%s)", req.login, req.server, info["is_demo"])
    return {"ok": True, "login": info["login"], "is_demo": info["is_demo"], "balance": info["balance"], "currency": info["currency"]}


@app.post("/order", dependencies=[Depends(require_key)])
def order(req: OrderRequest) -> dict:
    log.info("ORDER REQUEST %s", req.model_dump())
    result = broker.place(req)
    log.info("ORDER RESULT %s", result)
    return result


@app.post("/position/{ticket}/modify", dependencies=[Depends(require_key)])
def modify(ticket: str, req: ModifyRequest) -> dict:
    return broker.modify(ticket, req)


@app.post("/position/{ticket}/close", dependencies=[Depends(require_key)])
def close(ticket: str) -> dict:
    return broker.close(ticket)


if __name__ == "__main__":
    import asyncio

    import uvicorn

    if sys.platform == "win32":
        # The default proactor loop's AcceptEx can die with WinError 87 after a
        # system stall/sleep, silently breaking the listener. The selector loop
        # doesn't have that failure mode and handles this traffic level fine.
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "5001")), loop="asyncio")
