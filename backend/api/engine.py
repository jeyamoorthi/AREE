"""Bridge between the FastAPI layer and whichever AREE engine is running.

TWO ENGINES, ONE OF WHICH IS THE PRODUCTION PATH
    direct     fallback_engine.py. Interval sampling of the live CPCB/DPCC
               network, the same GRAP state machine, the same reporting. THIS IS
               THE DEFAULT AND THE PRODUCTION PATH: it is what the test suites,
               the runtime gate and every benchmark in this project measure.

    streaming  app.py. The Pathway event-time pipeline, plus the capabilities
               wired only into it - policy RAG retrieval, the FIRMS poller and
               causal attribution. Opt in with AREE_ENGINE_MODE=streaming.
               Requires the packages in backend/requirements-streaming.txt, which
               are Linux/macOS-only and have not been verified in any working
               environment.

Whichever loads, the API reads the very same in-memory state dicts it publishes
(``latest_state``, ``carbon_state``, ``escalation_log``) — no duplicated logic
and no mock data. The mode is reported in every status payload so nothing
downstream can mistake one for the other.

If the selected engine cannot start at all, data routes answer 503 with a
structured error rather than inventing values.
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

    THE DIRECT ENGINE IS THE PRODUCTION PATH, AND THAT IS NOW THE DEFAULT.
        This used to attempt `import app` - the Pathway pipeline - first, and reach
        direct mode only by catching the failure. Two things were wrong with that.

        Practically, the attempt never succeeded: Pathway publishes Linux/macOS
        wheels only and is not installed in any verified environment, so every
        start paid for a heavyweight import that was always going to raise, and
        the engine actually serving traffic was chosen by an exception handler.

        Structurally, it made the repository lie about its own architecture. A
        reader of this function would conclude that streaming is the system and
        direct is the safety net, when the reverse is what runs, what is tested,
        and what every gate in this project has been measured against.

        So the default is now DIRECT, and streaming is opt-in via
        AREE_ENGINE_MODE=streaming. Nothing about the Pathway path is removed: ask
        for it and it loads, and if it fails it still falls back to direct with
        the reason reported, exactly as before. What changed is which one the
        system claims to be.

    AREE_ENGINE_MODE:
        unset | "direct"        the direct engine  (default, production)
        "streaming" | "pathway" the Pathway pipeline, falling back to direct
    """
    global _engine, _config

    with _lock:
        if _status["loaded"]:
            return True
        _status["loading"] = True

    mode = os.getenv("AREE_ENGINE_MODE", "").strip().lower()
    if mode not in ("streaming", "pathway"):
        try:
            import config as _cfg
            from fallback_engine import start as _fb_start
            import fallback_engine as _fb
            ok = _fb_start()
        except BaseException as exc:                         # noqa: BLE001
            with _lock:
                _status.update(loaded=False, loading=False,
                               error=f"{exc}", error_type=type(exc).__name__)
            return False
        with _lock:
            _engine = _fb
            _config = _cfg
            _status.update(
                loaded=bool(ok), loading=False, mode="direct",
                # `degraded` stays True and is NOT being quietly flipped. Direct
                # mode really does provide less than the streaming design: no
                # event-time windowing, no policy retrieval, no FIRMS poll. Those
                # gaps are reported field by field elsewhere, and turning this off
                # because direct is now the default would be increasing a claim
                # without gaining a capability - the exact move Phase 4 removed.
                degraded=True,
                error=None if ok else "direct engine started with no data",
                error_type=None,
                # Not an error any more. Nothing was attempted and nothing failed:
                # this is the configured production engine.
                pathway_error=None,
                engine_selection="direct engine (default; production path)")
        return bool(ok)

    try:
        import config as _cfg
        import app as _app  # noqa: F401  (import starts the Pathway pipeline)
    except BaseException as exc:  # noqa: BLE001 - report any startup failure
        # Pathway ships Linux/macOS wheels only. Rather than leaving three of
        # the four views dead on Windows, fall back to the direct-mode engine:
        # same GRAP state machine, same causal attribution, same reporting,
        # driven by sampling the live CPCB network instead of an event-time
        # streaming DAG. The mode is reported everywhere so nothing passes it
        # off as the streaming engine.
        try:
            import config as _cfg2
            from fallback_engine import start as _fb_start
            import fallback_engine as _fb
        except BaseException as fb_exc:                     # noqa: BLE001
            with _lock:
                _status.update(loaded=False, loading=False,
                               error=f"{exc}", error_type=type(exc).__name__)
            log = __import__("logging").getLogger("aree.engine")
            log.error("direct-mode fallback also failed: %s", fb_exc)
            return False

        ok = _fb_start()
        with _lock:
            _engine = _fb
            _config = _cfg2
            _status.update(
                loaded=bool(ok),
                loading=False,
                mode="direct",
                degraded=True,
                error=None if ok else "direct engine started with no data",
                error_type=None,
                pathway_error=f"{exc}",
            )
        return bool(ok)

    with _lock:
        _engine = _app
        _config = _cfg
        _status.update(loaded=True, loading=False, mode="streaming",
                       degraded=False, error=None, error_type=None)
    return True


def is_loaded() -> bool:
    return bool(_status["loaded"])


def status() -> Dict[str, Any]:
    return dict(_status)


def _require():
    if not _status["loaded"]:
        raise EngineUnavailable(
            _status["error"]
            or "AREE engine is not running. The direct engine is the default and "
               "needs no extra packages; check the startup log for why it failed.",
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
    if _status.get("mode") == "direct":
        # The semantic index is a Pathway DocumentStore and genuinely does not
        # exist in this mode. The documents themselves do, so list them and
        # mark only the retrieval layer as unavailable.
        #
        # store_status is set explicitly rather than left out: PolicyConsole
        # reads `policy.store_status ?? "starting"`, so a missing value leaves
        # the panel claiming to be initialising forever instead of saying the
        # subsystem is not running.
        files = _scan_policy_dir_direct(config().POLICY_DIR)
        return {
            "status": "unavailable",
            "store_status": "unavailable",
            "reason": "Policy RAG requires the Pathway runtime.",
            "error": "Semantic policy retrieval is unavailable in direct mode. "
                     "Documents below are present on disk but not embedded.",
            "index_type": "Not indexed (direct mode)",
            "embed_model": None,
            # docs_indexed counts documents present, matching what the Pathway
            # path puts in this field. Chunks stays 0 - nothing is embedded.
            "docs_indexed": len(files),
            "chunks_indexed": 0,
            "last_reindex": None,
            "policy_files": files,
            "parse_errors": [],
        }
    from rag.advisory_engine import _rag_state
    return _rag_state


def llm_status() -> Dict[str, Any]:
    """Gemini availability, so a retired model id or bad key is visible."""
    _require()
    try:
        from rag.llm_engine import get_llm_status
        return get_llm_status()
    except Exception as exc:                                # noqa: BLE001
        return {"ready": False, "error": f"{exc}",
                "mode": _status.get("mode", "unknown")}


def feed_diagnostics(station: Optional[str] = None):
    """Per-station ingestion state from the AQI poller.

    Carries the reason a station has no data — a dormant feed publishing no
    aggregate AQI reads very differently from one that is merely warming up.
    """
    _require()

    # In direct mode there is no WAQI poller - readings come from the CPCB
    # network - so diagnostics are derived from the state the direct engine
    # actually built. Importing aqi_stream here would hard-fail on a missing
    # WAQI_TOKEN and take the whole stations view down with it.
    if _status.get("mode") == "direct":
        diags = {
            name: {
                "status": st.get("ingestion_status", "ok"),
                "error": st.get("ingestion_error"),
                "stale_seconds": st.get("stale_seconds"),
                "feed_id": st.get("feed_id", ""),
                "station_name_api": st.get("station_name_api", name),
                "waqi_timestamp": st.get("waqi_timestamp"),
                "raw_pm25": st.get("raw_pm25"),
                "source": "CPCB/DPCC via OpenAQ (direct mode)",
            }
            for name, st in latest_state().items()
        }
        return diags if station is None else diags.get(station, {})

    from ingestion.aqi_stream import _debug_data
    if station is None:
        return dict(_debug_data)
    return _debug_data.get(station, {})


# Mirrors rag.advisory_engine.SUPPORTED_EXTENSIONS. Duplicated rather than
# imported because that module builds a Pathway DocumentStore at import time,
# which is exactly what is unavailable in direct mode.
_POLICY_EXTENSIONS = {".txt", ".md", ".text", ".pdf", ".docx"}


def _scan_policy_dir_direct(policy_dir: str) -> List[Dict[str, Any]]:
    """List the policy documents on disk, without the Pathway layer.

    Listing a directory is a filesystem operation, not a retrieval one. The
    earlier version returned [] in direct mode, so the console reported "No
    policy documents found in the policies/ folder" while the folder held the
    GRAP schedule. Saying a regulatory document is absent when it is present is
    a worse failure than saying it is unindexed.
    """
    import os as _os
    from datetime import datetime as _dt, timezone as _tz

    out: List[Dict[str, Any]] = []
    if not _os.path.isdir(policy_dir):
        return out
    for name in sorted(_os.listdir(policy_dir)):
        path = _os.path.join(policy_dir, name)
        if not _os.path.isfile(path):
            continue
        st = _os.stat(path)
        ext = _os.path.splitext(name)[1].lower()
        out.append({
            "name": name,
            "size_kb": round(st.st_size / 1024, 1),
            "modified": _dt.fromtimestamp(st.st_mtime, tz=_tz.utc)
                           .strftime("%Y-%m-%d %H:%M"),
            "type": ext.lstrip(".") or "unknown",
            "supported": ext in _POLICY_EXTENSIONS,
            "parse_error": None,
        })
    return out


def scan_policy_files():
    _require()
    if _status.get("mode") == "direct":
        return _scan_policy_dir_direct(config().POLICY_DIR)
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

    # Direct mode discovers its own stations from the live CPCB network, so
    # the station list IS whatever reported this cycle. Returning the
    # hardcoded WAQI set here would list five nodes that this mode never
    # polls, and show them all as offline.
    if _status.get("mode") == "direct":
        return {
            name: {
                "feed_id": st.get("feed_id", ""),
                "lat": st.get("lat"),
                "lon": st.get("lon"),
                "city": "Delhi NCR",
                "source": "CPCB/DPCC via OpenAQ",
            }
            for name, st in latest_state().items()
        }

    from station_loader import get_all_stations
    from config import STATIONS
    try:
        return get_all_stations(STATIONS, limit=30)
    except Exception:
        # station_loader already degrades to {} on failure; fall back to the
        # verified hardcoded set rather than failing the request.
        return dict(STATIONS)


def station_meta(station: str) -> Dict[str, Any]:
    allst = stations()
    if _status.get("mode") == "direct":
        return allst.get(station) or {}
    from config import STATIONS
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
