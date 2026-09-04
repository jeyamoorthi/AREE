"""
A read-through cache for the one expensive thing the API does.

WHAT IS CACHED, AND WHY IT IS SAFE
    `outlook.compute()` - forecast -> ventilation -> assessment -> case proposal.
    It is a pure function of (as_of, lat, lon, grid, hours) and the contents of
    the store. It writes nothing: viewing an outlook must never mint a regulatory
    record, so the case row is created by the decision endpoint, not by a GET.

WHAT IS DELIBERATELY *NOT* CACHED
    The persisted case status. That is read fresh in the route by
    `case_store.status_of()`, after this cache returns. If it were folded in, an
    officer who approved a case would keep seeing "awaiting approval" until the
    entry expired - a cache turning a decided case back into an open one is a
    correctness failure, not a performance detail. The split is the whole reason
    `compute()` was worth caching and the route was not.

HOW STALENESS IS BOUNDED
    A key carries a version of the inputs, so new data invalidates by
    construction rather than by hoping a TTL is short enough:

      data version   MAX(timestamp) over station_readings, plus the size and
                     mtime of the database file and its WAL sidecar. MAX moves
                     when the hourly capture lands; the file marks move on ANY
                     write, including a backfill of purely historical rows that
                     MAX would not notice. Both are O(1) - see data_version().
      model version  the model directory's file count and newest mtime, so
                     retraining invalidates every replay answer that used the
                     old booster.

    A TTL sits behind both as a backstop for anything neither token can see.

    This cache CANNOT serve an answer computed from data that did not exist at
    as_of: bounding is done inside the forecast, and this layer only ever returns
    a value produced by the same `compute()` for the same `as_of`.

CONCURRENCY
    FastAPI runs sync handlers in a threadpool, so entries are guarded by a lock
    and every value crossing the boundary is deep-copied. Handing out the stored
    object would let one request's downstream mutation corrupt what the next
    request sees, which is the classic way a cache starts inventing data.
"""

from __future__ import annotations

import copy
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable

from ..backfill.db import db_path

# Bounded so a long-running server cannot grow without limit. Replay traffic is
# a handful of curated moments; live traffic is one key per hour. 64 is far more
# than either needs and still trivially small in memory.
MAX_ENTRIES = 64

# Backstop only - the version tokens do the real invalidation.
LIVE_TTL_SECONDS = 60.0
REPLAY_TTL_SECONDS = 600.0

_ENABLED = os.environ.get("AREE_OUTLOOK_CACHE", "on").lower() not in {
    "0", "off", "false", "no"}

_lock = threading.Lock()
_entries: "OrderedDict[tuple, tuple[float, Any]]" = OrderedDict()
_hits = 0
_misses = 0


def enabled() -> bool:
    return _ENABLED


def data_version(conn) -> tuple:
    """
    A token that changes whenever the store changes, in O(1).

    WHY NOT COUNT(*)
        The obvious token is (MAX(timestamp), COUNT(*)): MAX catches new data,
        COUNT catches a backfill inserting purely historical rows that MAX cannot
        see. But SQLite has no stored row count, so COUNT(*) scans an index -
        3.2 ms at 37k rows, and linear from there. Putting an O(n) scan on the
        hot path to protect a cache is the same mistake this phase exists to fix;
        it would simply reappear at a larger row count.

        The file's size and modification time answer the same question in two
        stat() calls and are strictly MORE sensitive - they move on any write,
        including one that changes neither MAX nor the count. The WAL sidecar is
        included because under journal_mode=WAL that is where a commit lands
        first, so the main file's mtime alone can lag a write.

        MAX(timestamp) is kept alongside it: it is one index seek, and it ties
        the key to the observation data specifically rather than to any write
        anywhere in the database.

    The cost of this token being too sensitive is a recomputation. The cost of it
    being not sensitive enough is serving an outlook that ignores data that has
    arrived. They are not symmetric, so this errs towards recomputing.
    """
    newest = conn.execute(
        "SELECT MAX(timestamp) AS newest FROM station_readings").fetchone()["newest"]

    marks: list = []
    path = db_path()
    for candidate in (path, path.with_name(path.name + "-wal")):
        try:
            st = candidate.stat()
            marks.append((st.st_size, st.st_mtime_ns))
        except OSError:
            marks.append(None)          # absent is itself a stable observation
    return (newest, tuple(marks))


def model_version(model_dir: Path) -> tuple:
    """File count and newest mtime for the model directory."""
    try:
        stats = [f.stat().st_mtime for f in model_dir.glob("*.txt")]
    except OSError:
        return (-1, -1.0)
    return (len(stats), max(stats) if stats else 0.0)


def get_or_compute(key: tuple, ttl: float, producer: Callable[[], Any]) -> Any:
    """
    Return the cached value for `key`, computing and storing it on a miss.

    The producer runs OUTSIDE the lock: it takes a second or so, and holding the
    lock across it would serialise every concurrent request behind the first one,
    turning a cache into a queue. The cost is that a simultaneous miss on the
    same key may compute twice; both produce the same value, so the duplicate is
    wasted work and never a wrong answer.
    """
    global _hits, _misses

    if not _ENABLED:
        return producer()

    now = time.monotonic()
    with _lock:
        entry = _entries.get(key)
        if entry is not None:
            expires, value = entry
            if expires > now:
                _entries.move_to_end(key)
                _hits += 1
                return copy.deepcopy(value)
            del _entries[key]

    _misses += 1
    value = producer()

    with _lock:
        # Stored as a copy so the caller's later mutation of what it received
        # cannot reach back into the cache.
        _entries[key] = (time.monotonic() + ttl, copy.deepcopy(value))
        _entries.move_to_end(key)
        while len(_entries) > MAX_ENTRIES:
            _entries.popitem(last=False)

    return value


def stats() -> dict[str, Any]:
    with _lock:
        return {"enabled": _ENABLED, "entries": len(_entries),
                "hits": _hits, "misses": _misses}


def clear() -> None:
    """Drop every entry. For tests and for benchmarking a cold path."""
    global _hits, _misses
    with _lock:
        _entries.clear()
        _hits = _misses = 0
