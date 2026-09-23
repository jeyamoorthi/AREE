"""
RUNTIME GATE - can a clean environment run AREE using only backend/requirements.txt?

This is the check that `pip install` succeeding cannot give you. It installs
nothing itself; it assumes an environment built from the runtime file alone and
then asks whether the APPLICATION works in it: engine startup, a forecast, the
outlook, a case decision, a PDF, and real HTTP requests over a socket.

To reproduce from scratch:

    python -m venv .tmp/freshenv
    .tmp/freshenv/Scripts/python -m pip install -r backend/requirements.txt
    .tmp/freshenv/Scripts/python -m backend.tests_runtime_gate

Notes on why particular steps are shaped the way they are:

  * It runs against a COPY of the store (VACUUM INTO + AREE_DB_PATH). The case
    step writes a decision, and a gate must never mutate the real evidence base.

  * Step 2 deliberately UNSETS AREE_ENGINE_MODE. The default path tries to import
    Pathway first; in a runtime-only environment that raises ImportError, and the
    loader must fall back to direct mode rather than leave the API dead. That
    fallback is what makes the runtime set sufficient, so it is asserted.

  * Step 7 asserts the optional extras DEGRADE rather than crash - Gemini reports
    ready:false, policy RAG reports unavailable - so their absence is a stated
    condition, not an outage.

  * Step 8 makes real HTTP requests. Every other step calls Python functions, and
    a defect once survived exactly that gap: a decorator attached to the wrong
    function left /api/aree/outlook answering 422 to every real request while the
    handler itself worked perfectly when called directly. See backend/tests/test_route_table.py.
"""
import os
import sys
import shutil
import sqlite3
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

# --- isolate the store -----------------------------------------------------
#
# Prefer the full development store; fall back to the committed 1 MB test
# fixture, which is what CI has. Without this fallback sqlite3.connect() would
# happily CREATE an empty data/aree.db, VACUUM INTO would copy nothing, and the
# gate would fail at "forecast" with a misleading reason instead of saying the
# store is missing.
src = ROOT / "data" / "aree.db"
if not src.exists():
    src = ROOT / "backend" / "tests" / "fixtures" / "aree_test.db"
    if not src.exists():
        raise SystemExit(
            "no store available. Expected data/aree.db or the committed fixture "
            "backend/tests/fixtures/aree_test.db (build it with "
            "`python -m backend.tests.build_fixture_db`).")
    print(f"  (using the committed test fixture: {src.name})")

dst = ROOT / ".tmp" / "gate.db"
dst.parent.mkdir(parents=True, exist_ok=True)
if dst.exists():
    dst.unlink()
c = sqlite3.connect(str(src))
c.execute("VACUUM INTO ?", (str(dst),))   # a consistent copy, WAL included
c.close()
os.environ["AREE_DB_PATH"] = str(dst)
os.environ["AREE_CAPTURE"] = "off"        # no background network fetching
os.environ["AREE_JWT_SECRET"] = "runtime-gate-key-not-a-production-secret"

# A KNOWN operator register, rather than the randomly generated demo pair.
# The gate has to be able to sign in to exercise the case workflow, and reading a
# generated password back out of the log would be a worse dependency than simply
# configuring one here.
from backend.api import auth as _auth                                  # noqa: E402
GATE_USER, GATE_PASSWORD = "gate.officer", "gate-password"
os.environ["AREE_OPERATORS"] = (
    f"{GATE_USER}:authority:{_auth.hash_password(GATE_PASSWORD)}")

PORT = 8139
_server = None
_server_thread = None


def _start_server():
    """One server for every step that needs HTTP, started on demand."""
    global _server, _server_thread
    if _server is not None:
        return _server
    import threading
    import time
    import uvicorn
    from backend.api.main import api

    cfg = uvicorn.Config(api, host="127.0.0.1", port=PORT, log_level="warning")
    _server = uvicorn.Server(cfg)
    _server_thread = threading.Thread(target=_server.run, daemon=True)
    _server_thread.start()
    for _ in range(600):
        if _server.started:
            return _server
        time.sleep(0.05)
    raise RuntimeError("uvicorn did not start")


def _http(method, path, *, token=None, body=None):
    import json as _json
    import urllib.error
    import urllib.request

    data = _json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data,
                                 headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return r.status, (_json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, _json.loads(raw)
        except ValueError:
            return e.code, {}

results = []
def step(name, fn):
    try:
        detail = fn()
        results.append((name, "PASS", detail or ""))
    except Exception as exc:
        results.append((name, "FAIL", f"{type(exc).__name__}: {exc}"))
        traceback.print_exc()

# --- 1. does the API import at all? ---------------------------------------
def _import():
    from backend.api.main import api
    return f"{len(api.routes)} routes registered"
step("backend import", _import)

# --- 2. engine startup, with NO AREE_ENGINE_MODE set ----------------------
# The default path tries to import Pathway first. In a runtime-only environment
# that raises ImportError, and the loader is supposed to fall back to direct
# mode rather than leave the API dead. This asserts that fallback works.
def _engine():
    # AREE_ENGINE_MODE unset: the direct engine is the DEFAULT and production
    # path, not a fallback reached by catching an ImportError. It must therefore
    # load without attempting Pathway at all - which is visible in the status as
    # pathway_error being None rather than an exception string.
    os.environ.pop("AREE_ENGINE_MODE", None)
    from backend.api import engine
    ok = engine.load_engine()
    st = engine._status
    if not ok:
        raise RuntimeError(f"engine did not load: {st.get('error')}")
    if st.get("mode") != "direct":
        raise RuntimeError(f"expected direct mode by default, got {st.get('mode')}")
    if st.get("pathway_error") is not None:
        raise RuntimeError(
            f"direct is the default and should not have attempted Pathway, but "
            f"pathway_error={st.get('pathway_error')!r}")
    return f"mode={st['mode']} by default; {st.get('engine_selection')}"
step("engine startup", _engine)

# --- 3. forecast ----------------------------------------------------------
from datetime import datetime, timezone
def _forecast():
    from backend.backfill import db
    from backend.forecast import pm25_forecast as fc
    conn = db.connect()
    f = fc.forecast(conn, as_of=datetime(2024, 11, 2, 6, tzinfo=timezone.utc))
    if not f.get("available"):
        raise RuntimeError(f"forecast unavailable: {f.get('reason')}")
    return f"{len(f['series'])} points, peak upper {f['summary']['upper_max']} ug/m3"
step("forecast", _forecast)

# --- 4. the outlook route, end to end -------------------------------------
def _outlook():
    from backend.backfill import model_lgbm
    from backend.forecast import pm25_forecast as fc
    from backend.api.routes import outlook as O
    r = O.outlook(at="2024-11-02T06:00:00Z", lat=fc.ws.DEFAULT_LAT,
                  lon=fc.ws.DEFAULT_LON, grid=model_lgbm.DEFAULT_GRID,
                  hours=fc.HORIZON)
    return f"status={r['decision']['case_status']} case={r['decision']['case_id']}"
step("outlook route", _outlook)

# --- 5. the case workflow: authenticate -> decide -> read back -------------
# Over HTTP, not by calling the handler. The decision endpoint now depends on a
# verified principal, so a direct Python call would hand it a `Depends` object -
# which is exactly how this step failed the first time it was run after Phase 3,
# and exactly the gap backend/tests/test_route_table.py exists to close.
def _cases():
    _start_server()
    status, tok = _http("POST", "/api/auth/token",
                        body={"username": GATE_USER, "password": GATE_PASSWORD})
    if status != 200:
        raise RuntimeError(f"token endpoint returned {status}: {tok}")
    token = tok["access_token"]

    status, outlook = _http("GET", "/api/aree/outlook?at=2024-11-02T06:00:00Z")
    case_id = outlook.get("decision", {}).get("case_id")

    status, denied = _http("POST", f"/api/cases/{case_id}/decision",
                           body={"decision": "approve",
                                 "as_of": "2024-11-02T06:00:00Z"})
    if status != 401:
        raise RuntimeError(f"unauthenticated decision returned {status}, not 401")

    status, decided = _http("POST", f"/api/cases/{case_id}/decision", token=token,
                            body={"decision": "approve",
                                  "as_of": "2024-11-02T06:00:00Z",
                                  "actor": "ignored-by-design",
                                  "reason": "runtime gate"})
    if status != 200:
        raise RuntimeError(f"authenticated decision returned {status}: {decided}")

    status, got = _http("GET", f"/api/cases/{case_id}")
    if got.get("status") != "APPROVED":
        raise RuntimeError(f"status did not persist: {got.get('status')}")
    last = (got.get("actions") or [])[-1]
    if last.get("actor") != GATE_USER:
        raise RuntimeError(f"audit actor is {last.get('actor')!r}, not the token subject")
    if last.get("actor_verified") is not True:
        raise RuntimeError("actor_verified was not set by the server")
    return (f"401 without a token; {case_id} -> {got['status']} as "
            f"{last['actor']}, actor_verified={last['actor_verified']}")
step("case workflow", _cases)

# --- 6. PDF report --------------------------------------------------------
def _report():
    from report_generator import generate_escalation_report
    state = {
        "station": "Anand Vihar, Delhi", "aqi": 421, "pm25": 318.0,
        "grap_stage": "Stage IV", "risk_score": 0.91,
        "advisory_text": "Phase 2 gate render.", "timestamp": "2024-11-02T06:00:00Z",
    }
    pdf = generate_escalation_report("Anand Vihar, Delhi", state, None)
    if not pdf or not pdf[:4] == b"%PDF":
        raise RuntimeError("output is not a PDF")
    out = ROOT / ".tmp" / "gate_report.pdf"
    out.write_bytes(pdf)
    return f"{len(pdf):,} bytes, valid %PDF header"
step("PDF report", _report)

# --- 7. the optional extras must DEGRADE, not crash -----------------------
def _optional():
    """
    Missing optional packages must be REPORTED, never fatal.

    This step used to assert that the optional packages were absent, which is
    only true in a clean runtime environment. Run in a development environment
    where google-generativeai IS installed, the gate failed on
    `llm_status should report not-ready` — an assertion about the environment
    dressed up as an assertion about the application.

    What actually matters is conditional: whatever is absent must degrade
    gracefully, and what is present may work. So each check is now tied to the
    package's real state.
    """
    import importlib.util

    optional = ("pathway", "google.generativeai", "sentence_transformers",
                "pyarrow", "pypdf", "docx", "codecarbon", "torch")
    absent = [m for m in optional
              if importlib.util.find_spec(m.split(".")[0]) is None]

    from backend.api import engine

    # Must not raise regardless of what is installed.
    llm = engine.llm_status()
    if not isinstance(llm, dict) or "ready" not in llm:
        raise RuntimeError(f"llm_status returned no usable status: {llm!r}")
    if "google.generativeai" in absent and llm.get("ready") is not False:
        raise RuntimeError(
            f"the Gemini SDK is not installed, so llm_status must report "
            f"ready=False rather than {llm.get('ready')!r}")

    # Mode-based, not package-based: direct mode has no policy retrieval whether
    # or not Pathway happens to be importable.
    rag = engine.rag_state()
    if rag.get("status") != "unavailable":
        raise RuntimeError(f"rag_state should be unavailable in direct mode, "
                           f"got {rag.get('status')}")

    llm_note = ("reports not-ready" if llm.get("ready") is False
                else "available (SDK installed)")
    return (f"{len(absent)}/{len(optional)} optional packages absent; "
            f"llm {llm_note}; rag unavailable — nothing crashed")
step("optional degrade", _optional)

# --- 8. REAL HTTP, because calling the handler is not calling the endpoint --
# Every other step above (bar the case workflow) calls Python functions. A
# decorator once landed on the wrong function and left /api/aree/outlook
# answering 422 to every real request while the handler worked perfectly when
# called directly. This step opens a socket.
def _http_endpoints():
    _start_server()
    checked = []
    for path in ("/api/health", "/api/cases", "/api/auth/config",
                 "/api/aree/outlook?at=2024-11-02T06:00:00Z"):
        status, body = _http("GET", path)
        if status != 200:
            raise RuntimeError(f"{path} -> HTTP {status}: {str(body)[:160]}")
        checked.append(path)
    status, body = _http("GET", "/api/aree/outlook?at=2024-11-02T06:00:00Z")
    return (f"{len(checked)} endpoints answered 200 over TCP; outlook case="
            f"{body.get('decision', {}).get('case_id')}")
step("HTTP endpoints", _http_endpoints)

if _server is not None:
    _server.should_exit = True
    if _server_thread is not None:
        _server_thread.join(timeout=15)

# --- report ---------------------------------------------------------------
print("\n" + "=" * 68)
print("PHASE 2 GATE — fresh environment, runtime dependencies only")
print("=" * 68)
width = max(len(n) for n, _, _ in results)
for name, verdict, detail in results:
    dots = "." * (width + 2 - len(name))
    print(f"  {name} {dots} {verdict}   {detail}")
failed = [n for n, v, _ in results if v == "FAIL"]
print("=" * 68)
print(("ALL STEPS PASS" if not failed else f"FAILED: {', '.join(failed)}"))
# Exit without interpreter finalisation: the engine's daemon poller threads can
# be mid-write when CPython finalises, which aborts the process after every step
# has already passed. The pytest suites avoid this by not owning the
# process lifetime at all.
sys.stdout.flush()
sys.stderr.flush()
os._exit(1 if failed else 0)
