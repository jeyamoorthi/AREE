"""
Shared fixtures.

THE ONE RULE THESE FIXTURES ENFORCE
    Environment is configured BEFORE any AREE module is imported. `db.db_path()`
    reads AREE_DB_PATH, `auth.operators()` reads AREE_OPERATORS, and
    `api/engine.py` reads AREE_ENGINE_MODE — all at first use, and several of them
    cache. Importing first and setting variables afterwards produces tests that
    pass alone and fail in a suite, which is the worst failure mode a test file
    can have.

    So this module sets the environment at import time, and every AREE import
    below that point is deliberate rather than accidental.

WHY THE STORE IS A COMMITTED FIXTURE
    `data/aree.db` is 148 MB and gitignored, so CI has no store. Skipping every
    data-dependent test there would leave a pipeline that protects nothing.
    `fixtures/aree_test.db` is 1 MB, committed, and carries exactly the slice the
    three replay moments need — verified to reproduce all 3,274 golden fields.
    Rebuild it with `python -m backend.tests.build_fixture_db`.

WHY THE SERVER IS REAL
    `live_server` starts uvicorn on a socket and the HTTP tests use urllib. No
    TestClient, no ASGI shortcut. A decorator once landed on the wrong function
    and left `/api/aree/outlook` answering 422 to every request while the handler
    worked perfectly when called directly; only a real request found it.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURE_DB = Path(__file__).resolve().parent / "fixtures" / "aree_test.db"
GOLDEN_DIR = Path(__file__).resolve().parent / "golden"

# --- environment, set before ANY AREE import --------------------------------
# A store is chosen here rather than in a fixture because db.db_path() is read on
# first connect and several call sites hold the result.
os.environ.setdefault("AREE_DB_PATH", str(FIXTURE_DB))
os.environ.setdefault("AREE_CAPTURE", "off")          # no background polling
os.environ.setdefault("AREE_ENGINE_MODE", "direct")   # the production path
os.environ.setdefault("AREE_JWT_SECRET", "pytest-signing-key-not-a-production-secret")

sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from backend.api import auth  # noqa: E402

# A known operator register, so authority tests do not have to scrape generated
# demo passwords out of a log.
AUTHORITY_USER, AUTHORITY_PASSWORD = "test.officer", "authority-password"
ADMIN_USER, ADMIN_PASSWORD = "test.admin", "admin-password"
os.environ.setdefault("AREE_OPERATORS", ";".join([
    f"{AUTHORITY_USER}:authority:{auth.hash_password(AUTHORITY_PASSWORD)}",
    f"{ADMIN_USER}:admin:{auth.hash_password(ADMIN_PASSWORD)}",
]))

REPLAY_CASES = {
    "nov02": "2024-11-02T06:00:00Z",
    "nov14": "2024-11-14T00:00:00Z",
    "nov16": "2024-11-16T00:00:00Z",
}

# Recorded when the answer was computed, not what it says. Excluded from every
# comparison — see the golden baseline, which does not store them at all.
WALLCLOCK_FIELDS = {"assessed_at", "opened_at", "generated_at"}


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "markers", "network: needs live upstream feeds (CPCB/CAQM/Open-Meteo)")


# --- helpers ---------------------------------------------------------------

def strip_wallclock(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: strip_wallclock(v) for k, v in obj.items()
                if k not in WALLCLOCK_FIELDS}
    if isinstance(obj, list):
        return [strip_wallclock(v) for v in obj]
    return obj


def flatten(obj: Any, path: str = "") -> Any:
    """Every leaf as path -> value, so a diff names the field that moved."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield from flatten(value, f"{path}.{key}")
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            yield from flatten(value, f"{path}[{i}]")
    else:
        yield path, obj


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# --- fixtures --------------------------------------------------------------

@pytest.fixture(scope="session")
def fixture_db() -> Path:
    if not FIXTURE_DB.exists():
        pytest.fail(
            f"missing test store {FIXTURE_DB}. "
            f"Build it with: python -m backend.tests.build_fixture_db")
    return FIXTURE_DB


@pytest.fixture(scope="session")
def api(fixture_db):
    """The FastAPI application, imported once."""
    from backend.api.main import api as application
    return application


@pytest.fixture(scope="session")
def writable_db(tmp_path_factory, fixture_db) -> str:
    """
    A private copy for tests that WRITE (deciding a case).

    The committed fixture must stay pristine: a test that approves a case in it
    would leave a regulatory record in version control and make the next run's
    golden comparison depend on the previous run.
    """
    import sqlite3
    target = tmp_path_factory.mktemp("store") / "aree_rw.db"
    src = sqlite3.connect(str(fixture_db))
    src.execute("VACUUM INTO ?", (str(target),))
    src.close()
    return str(target)


@pytest.fixture(scope="session")
def live_server(api, writable_db):
    """
    A real uvicorn server on a real port. Yields the base URL.

    Session-scoped because starting the app is the expensive part and every HTTP
    test wants the same one. It runs against `writable_db`, so the case tests can
    decide without touching the committed fixture.
    """
    import uvicorn

    os.environ["AREE_DB_PATH"] = writable_db
    port = _free_port()
    config = uvicorn.Config(api, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.time() + 60
    while not server.started and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        pytest.fail("uvicorn did not start within 60s")

    yield f"http://127.0.0.1:{port}"

    server.should_exit = True
    thread.join(timeout=15)


@pytest.fixture(scope="session")
def http(live_server):
    """A tiny real-HTTP client. Returns (status, parsed_json)."""

    def request(method: str, path: str, *, token: str | None = None,
                body: dict | None = None, raw: bytes | None = None,
                content_type: str | None = None,
                headers: dict | None = None) -> tuple[int, dict]:
        data = raw
        hdrs = {"Accept": "application/json", **(headers or {})}
        if body is not None:
            data = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        if content_type:
            hdrs["Content-Type"] = content_type
        if token:
            hdrs["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(f"{live_server}{path}", data=data,
                                     headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=180) as response:
                payload = response.read()
                return response.status, (json.loads(payload) if payload else {})
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            try:
                return exc.code, json.loads(payload)
            except ValueError:
                return exc.code, {"raw": payload[:300].decode(errors="replace")}

    return request


@pytest.fixture(scope="session")
def authority_token(http) -> str:
    status, body = http("POST", "/api/auth/token",
                        body={"username": AUTHORITY_USER,
                              "password": AUTHORITY_PASSWORD})
    assert status == 200, f"could not obtain an authority token: {status} {body}"
    return body["access_token"]


@pytest.fixture(scope="session")
def admin_token(http) -> str:
    status, body = http("POST", "/api/auth/token",
                        body={"username": ADMIN_USER, "password": ADMIN_PASSWORD})
    assert status == 200, f"could not obtain an admin token: {status} {body}"
    return body["access_token"]


@pytest.fixture(scope="session")
def golden() -> dict[str, dict]:
    """The protected baseline, flattened and ready to diff."""
    out = {}
    for name in REPLAY_CASES:
        path = GOLDEN_DIR / f"{name}.json"
        if not path.exists():
            pytest.fail(f"missing golden baseline {path}")
        out[name] = dict(flatten(json.loads(path.read_text(encoding="utf-8"))))
    return out
