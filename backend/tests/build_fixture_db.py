"""
Build the committed test fixture database.

WHY THIS EXISTS
    `data/aree.db` is 148 MB and gitignored, so CI has no store at all. Without
    one, every test that touches a forecast, the outlook, a case or the golden
    baseline can only be skipped — and a pipeline that skips the things it exists
    to protect is decoration.

    This extracts the *minimum* slice the replay cases need into
    `backend/tests/fixtures/aree_test.db`, which IS committed. It is built from
    the same store the golden baseline was captured from, so a test running
    against it computes the same numbers.

WHAT "MINIMUM" MEANS, DERIVED RATHER THAN GUESSED
    For each replay moment the forecast reads:

      observations   [as_of - OBSERVATION_WINDOW_HOURS, as_of]
                     (31 h: anchor backoff 6 h + the 24 h lag + 1)
      meteorology    [as_of - MAX_ANCHOR_BACKOFF_HOURS, as_of + horizon + 1]
      derived        the single row at as_of
      fire events    the 24 h before as_of

    The windows are computed from the same constants the forecast uses, so this
    cannot drift out of step with what the code reads.

Run:  python -m backend.tests.build_fixture_db
"""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from backend.backfill import db, model_lgbm            # noqa: E402
from backend.forecast import pm25_forecast as fc       # noqa: E402
from backend.api.routes.outlook import FIRE_LOOKBACK_HOURS  # noqa: E402

# The moments the golden baseline covers.
CASES = [
    datetime(2024, 11, 2, 6, tzinfo=timezone.utc),
    datetime(2024, 11, 14, 0, tzinfo=timezone.utc),
    datetime(2024, 11, 16, 0, tzinfo=timezone.utc),
]

OUT = Path(__file__).resolve().parent / "fixtures" / "aree_test.db"


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    src = db.connect()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    if OUT.exists():
        OUT.unlink()

    # Create the schema by pointing db.connect() at the new file, so the fixture
    # is built by the same DDL the application uses rather than a copy of it.
    import os
    os.environ["AREE_DB_PATH"] = str(OUT)
    db.connect.cache_clear() if hasattr(db.connect, "cache_clear") else None
    dst = sqlite3.connect(str(OUT))
    dst.row_factory = sqlite3.Row
    schema = [r["sql"] for r in src.execute(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")]
    for stmt in schema:
        try:
            dst.execute(stmt)
        except sqlite3.OperationalError as exc:
            print(f"  (skipped: {exc})")

    counts: dict[str, int] = {}

    def copy(table: str, sql: str, params: tuple) -> None:
        rows = src.execute(sql, params).fetchall()
        if not rows:
            return
        cols = rows[0].keys()
        placeholders = ",".join("?" * len(cols))
        dst.executemany(
            f"INSERT OR IGNORE INTO {table} ({','.join(cols)}) VALUES ({placeholders})",
            [tuple(r[c] for c in cols) for r in rows])
        counts[table] = counts.get(table, 0) + len(rows)

    for as_of in CASES:
        obs_from = iso(as_of - timedelta(hours=fc.OBSERVATION_WINDOW_HOURS))
        obs_to = iso(as_of)
        met_from = iso(as_of - timedelta(hours=fc.MAX_ANCHOR_BACKOFF_HOURS))
        met_to = iso(as_of + timedelta(hours=fc.HORIZON + 1))
        fire_from = iso(as_of - timedelta(hours=FIRE_LOOKBACK_HOURS))

        copy("station_readings",
             "SELECT * FROM station_readings WHERE timestamp >= ? AND timestamp <= ?",
             (obs_from, obs_to))
        copy("met_hourly",
             "SELECT * FROM met_hourly WHERE timestamp >= ? AND timestamp <= ?",
             (met_from, met_to))
        copy("derived_features",
             "SELECT * FROM derived_features WHERE timestamp >= ? AND timestamp <= ?",
             (met_from, met_to))
        copy("fire_events",
             "SELECT * FROM fire_events WHERE timestamp > ? AND timestamp <= ?",
             (fire_from, obs_to))
        copy("ncr_target",
             "SELECT * FROM ncr_target WHERE timestamp >= ? AND timestamp <= ?",
             (obs_from, obs_to))

    dst.commit()
    dst.execute("VACUUM")
    dst.close()

    size = OUT.stat().st_size
    print(f"\n  {OUT.relative_to(ROOT)}")
    for table, n in sorted(counts.items()):
        print(f"    {table:20s} {n:6,d} rows")
    print(f"    {'SIZE':20s} {size:6,d} bytes ({size/1024/1024:.2f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
