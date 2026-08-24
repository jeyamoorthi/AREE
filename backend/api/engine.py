"""Bridge between the FastAPI layer and the existing AREE engine.

Importing ``app`` starts the Pathway pipeline, the FIRMS poller, the carbon
tracker and the RAG DocumentStore in this process. The API then reads the very
same in-memory state dicts the engine publishes (``latest_state``,
``carbon_state``, ``escalation_log``, ``_rag_state``) — no duplicated logic and
no mock data.

Pathway ships Linux/macOS wheels only, so on a host where the engine cannot be
imported we record the failure and every data route answers 503 with a
structured error instead of inventing values.
"""

import os
import sys
import threading
from typing import Any, Dict, List, Optional

# The engine modules use flat imports (``from config import ...``). Put the
# backend directory on sys.path so they resolve regardless of the working
# directory uvicorn was started from.
_BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

PROJECT_ROOT = os.path.dirname(_BACKEND_DIR)

_lock = threading.Lock()

_status: Dict[str, Any] = {
    "loaded": False,
    "loading": False,
    "error": None,
    "error_type": None,
}

_engine = None       # the imported `app` module
_config = None       # the imported `config` module


class EngineUnavailable(RuntimeError):
    """Raised when engine state is requested but the engine did not start."""

    def __init__(self, detail: str, error_type: Optional[str] = None):
        super().__init__(detail)
        self.detail = detail
        self.error_type = error_type


def load_engine() -> bool:
    """Import the engine once. Returns True when the engine is live.

    Safe to call repeatedly; the heavy import happens at most once.
    """
    global _engine, _config

    with _lock:
        if _status["loaded"]:
            return True
        _status["loading"] = True

    try:
        import config as _cfg
        import app as _app  # noqa: F401  (import starts the Pathway pipeline)
    except BaseException as exc:  # noqa: BLE001 - report any startup failure
        with _lock:
            _status.update(
                loaded=False,
                loading=False,
                error=f"{exc}",
                error_type=type(exc).__name__,
            )
        return False

    with _lock:
        _engine = _app
        _config = _cfg
        _status.update(loaded=True, loading=False, error=None, error_type=None)
    return True


def is_loaded() -> bool:
    return bool(_status["loaded"])


def status() -> Dict[str, Any]:
    return dict(_status)


def _require():
    if not _status["loaded"]:
        raise EngineUnavailable(
            _status["error"]
            or "AREE engine is not running. Start the API in an environment "
               "where the Pathway pipeline can be imported (Linux/macOS/Docker/WSL).",
            _status["error_type"],
        )
    return _engine


# --- Live engine state accessors -------------------------------------------
# These return the live objects so every request sees the current stream state.


def latest_state() -> Dict[str, Any]:
    return _require().latest_state


def carbon_state() -> Dict[str, Any]:
    return _require().carbon_state


def escalation_log() -> List[Dict[str, Any]]:
    return list(_require().escalation_log)


def aqi_history(station: Optional[str] = None):
    hist = _require().aqi_history
    if station is None:
        return hist
    return list(hist.get(station, []))


def multi_window_cache() -> Dict[str, Any]:
    return getattr(_require(), "_multi_window_cache", {})


def rag_state() -> Dict[str, Any]:
    _require()
    from rag.advisory_engine import _rag_state
    return _rag_state


def llm_status() -> Dict[str, Any]:
    """Gemini availability, so a retired model id or bad key is visible."""
    _require()
    from rag.llm_engine import get_llm_status
    return get_llm_status()


def feed_diagnostics(station: Optional[str] = None):
    """Per-station ingestion state from the AQI poller.

    Carries the reason a station has no data — a dormant feed publishing no
    aggregate AQI reads very differently from one that is merely warming up.
    """
    _require()
    from ingestion.aqi_stream import _debug_data
    if station is None:
        return dict(_debug_data)
    return _debug_data.get(station, {})


def scan_policy_files():
    _require()
    from rag.advisory_engine import _scan_policy_files
    return _scan_policy_files()


def config():
    """The engine config module (thresholds, stations, bands, GRAP stages)."""
    if _config is None:
        _require()
    return _config


def stations() -> Dict[str, Any]:
    """Hardcoded + dynamically discovered WAQI stations (1h cached upstream)."""
    _require()
    from station_loader import get_all_stations
    from config import STATIONS
    try:
        return get_all_stations(STATIONS, limit=30)
    except Exception:
        # station_loader already degrades to {} on failure; fall back to the
        # verified hardcoded set rather than failing the request.
        return dict(STATIONS)


def station_meta(station: str) -> Dict[str, Any]:
    from config import STATIONS
    allst = stations()
    return allst.get(station) or STATIONS.get(station) or {}


def active_states() -> Dict[str, Dict[str, Any]]:
    """Stations that have produced at least one valid window."""
    return {
        k: v
        for k, v in latest_state().items()
        if isinstance(v, dict)
        and v.get("aqi") is not None
        and v.get("status") != "DATA_INVALID"
    }


def station_state(station: str) -> Dict[str, Any]:
    return latest_state().get(station)


def generate_report(station: str, state: Dict[str, Any]) -> bytes:
    _require()
    from report_generator import generate_escalation_report
    return generate_escalation_report(station, state, carbon_state())
