import importlib.util
import pathlib
import sys
import types


ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / "cloudflare-python" / "worker.py"


def load_worker():
    workers = types.ModuleType("workers")

    class Response:
        def __init__(self, body="", **kwargs):
            self.body = body
            self.kwargs = kwargs

    class WorkerEntrypoint:
        pass

    workers.Response = Response
    workers.WorkerEntrypoint = WorkerEntrypoint

    js = types.ModuleType("js")

    class Object:
        @staticmethod
        def fromEntries(value):
            return dict(value)

    async def fetch(*_args, **_kwargs):
        raise RuntimeError("network fetch is not available in unit tests")

    js.Object = Object
    js.fetch = fetch

    pyodide = types.ModuleType("pyodide")
    ffi = types.ModuleType("pyodide.ffi")
    ffi.to_js = lambda obj, **_kwargs: obj

    sys.modules["workers"] = workers
    sys.modules["js"] = js
    sys.modules["pyodide"] = pyodide
    sys.modules["pyodide.ffi"] = ffi

    spec = importlib.util.spec_from_file_location("worker", WORKER_PATH)
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    return worker


worker = load_worker()


def sample_risk():
    return {
        "risk_pct": 1,
        "stop_pct": 2,
        "take_profit_pct": 4,
        "min_confidence": 70,
        "atr_stop_multiplier": 1.5,
        "take_profit_r": 2,
        "min_rr": 1.5,
        "max_position_value_pct": 20,
        "crypto_leverage": 2,
        "crypto_leverage_mode": "paper",
    }


def make_bars(count=80):
    bars = []
    price = 100.0
    for idx in range(count):
        price += 0.25
        bars.append({
            "o": price - 0.2,
            "h": price + 0.4,
            "l": price - 0.5,
            "c": price,
            "v": 1000 + idx * 10,
        })
    return bars


def test_symbol_normalization():
    assert worker.normalize_symbol("btc") == "BTC/USD"
    assert worker.normalize_symbol("btcusd") == "BTC/USD"
    assert worker.normalize_symbol("BTC-USD") == "BTC/USD"
    assert worker.normalize_symbol("aapl") == "AAPL"


def test_tradingview_urls():
    assert "COINBASE:BTCUSD" in worker.tradingview_url("BTC/USD")
    assert "AMEX:SPY" in worker.tradingview_url("SPY")
    assert "NASDAQ:AAPL" in worker.tradingview_url("AAPL")


def test_position_sizing_respects_risk_and_leverage():
    risk = sample_risk()
    stock_qty = worker.position_size(10_000, 100, risk, 90, 5_000, "AAPL")
    crypto_qty = worker.position_size(10_000, 100, risk, 90, 5_000, "BTC/USD")
    assert stock_qty == 10
    assert crypto_qty == 5


def test_analyze_bars_warmup_and_signal_shape():
    warmup = worker.analyze_bars(make_bars(30), sample_risk())
    analysis = worker.analyze_bars(make_bars(90), sample_risk())
    assert warmup["action"] == "WARMUP"
    assert analysis["price"] > 0
    assert analysis["stop"] < analysis["price"] < analysis["target"]
    assert analysis["rr"] > 0
    assert isinstance(analysis["reasons"], list)


def test_committed_symbols_from_positions_and_orders():
    committed = worker.committed_symbols_from(
        [{"symbol": "AAPL"}, {"symbol": "BTC/USD"}],
        [{"symbol": "MSFT"}],
    )
    assert committed == {"AAPL", "BTC/USD", "MSFT"}


def test_event_label_and_activity_graph():
    events = [
        {
            "created_at": "2026-05-18T10:00:00Z",
            "type": "python_paper_order",
            "symbol": "AAPL",
            "payload": {
                "qty": 2,
                "analysis": {"confidence": 81, "rr": 2.1, "stop": 95, "target": 110},
            },
        },
        {
            "created_at": "2026-05-18T10:05:00Z",
            "type": "crypto_managed_close",
            "symbol": "BTC/USD",
            "payload": {"qty": 0.01, "reason": "crypto target hit", "levered_pnl_pct": 4.2},
        },
    ]
    assert "AUTO BUY | AAPL" in worker.event_label(events[0])
    assert "paper P&L 4.20%" in worker.event_label(events[1])
    graph = worker.render_activity_graph(events)
    assert "Exposure graph" in graph
    assert "#" in graph


def test_plain_command_aliases():
    assert worker.normalize_command_text("auto on") == "/auto_on"
    assert worker.normalize_command_text("history 20") == "/history 20"
    assert worker.normalize_command_text("buy BTC/USD") == "/buy BTC/USD"


if __name__ == "__main__":
    tests = [
        test_symbol_normalization,
        test_tradingview_urls,
        test_position_sizing_respects_risk_and_leverage,
        test_analyze_bars_warmup_and_signal_shape,
        test_committed_symbols_from_positions_and_orders,
        test_event_label_and_activity_graph,
        test_plain_command_aliases,
    ]
    for test in tests:
        test()
        print(f"ok {test.__name__}")
