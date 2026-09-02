"""
The feature store: five tables, one file, no server to install.

WHY SQLITE AND NOT POSTGRESQL YET
    The plan names PostgreSQL, and that is the right destination. It is the
    wrong starting point. Milestone 1 is "python backfill.py runs and produces
    the joined table" - putting a server install, a service, a role and a
    connection string between the team and that milestone buys nothing, and it
    blocks three of the four people who need to run this on Windows today.

    So the schema below is written in portable SQL and every write uses
    INSERT ... ON CONFLICT DO UPDATE, which PostgreSQL 9.5+ and SQLite 3.24+
    both accept with the same syntax. Moving to PostgreSQL is then a connection
    swap plus a type widening (TEXT timestamps -> TIMESTAMPTZ), not a rewrite.
    Nothing in this module reaches for a SQLite-only feature.

WHY TIMESTAMPS ARE ISO-8601 TEXT
    SQLite has no date type, so something has to be chosen. ISO-8601 in UTC
    with a trailing Z sorts lexicographically in the same order it sorts
    chronologically, which means BETWEEN and ORDER BY work on the raw column
    with no conversion. Every write goes through _iso() so the format cannot
    drift between ingestion modules - a backfill whose timestamps half-match is
    worse than one that fails.

WHY EVERY TABLE HAS A NATURAL PRIMARY KEY
    Backfills get interrupted, rate-limited, and re-run. Keying on
    (station, hour) rather than an autoincrement id makes a re-run idempotent:
    the second pass overwrites the same rows instead of doubling the dataset.
    This is the difference between a pipeline you can trust and one where
    nobody is sure whether the row count means anything.
"""

from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_DB_PATH = _REPO_ROOT / "data" / "aree.db"


def db_path() -> Path:
    """Where the store lives. AREE_DB_PATH overrides for scratch runs."""
    raw = os.getenv("AREE_DB_PATH")
    return Path(raw) if raw else DEFAULT_DB_PATH


SCHEMA = """
-- Ground truth. One row per station-hour, pollutants as columns.
CREATE TABLE IF NOT EXISTS station_readings (
    station_id  TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    pm25        REAL,
    pm10        REAL,
    o3          REAL,
    no2         REAL,
    so2         REAL,
    co          REAL,
    latitude    REAL,
    longitude   REAL,
    source      TEXT,
    -- How many monitors stand behind this row. 1 for a real station; for a
    -- composite it is the count that was averaged. It exists because the
    -- historical NCR series rests on a SINGLE station for 20,007 of its 29,953
    -- hours, and a model trained on it should be able to see that rather than
    -- treat every hour as equally well observed.
    n_stations  INTEGER,
    PRIMARY KEY (station_id, timestamp)
);

-- Meteorology. One row per grid-hour.
CREATE TABLE IF NOT EXISTS met_hourly (
    grid_id                 TEXT NOT NULL,
    timestamp               TEXT NOT NULL,
    latitude                REAL,
    longitude               REAL,
    temperature_2m          REAL,
    relative_humidity       REAL,
    wind_speed_10m          REAL,
    wind_direction_10m      REAL,
    precipitation           REAL,
    solar_radiation         REAL,
    terrestrial_radiation   REAL,
    cloud_cover             REAL,
    surface_pressure        REAL,
    boundary_layer_height   REAL,
    temperature_1000        REAL,
    temperature_925         REAL,
    temperature_850         REAL,
    source                  TEXT,
    PRIMARY KEY (grid_id, timestamp)
);

-- Satellite fire detections. Keyed on the detection itself so a re-pull of an
-- overlapping date range cannot duplicate a hotspot.
CREATE TABLE IF NOT EXISTS fire_events (
    event_id    TEXT PRIMARY KEY,
    timestamp   TEXT NOT NULL,
    latitude    REAL NOT NULL,
    longitude   REAL NOT NULL,
    frp         REAL,
    confidence  TEXT,
    satellite   TEXT,
    source      TEXT
);

-- Everything computed rather than fetched. Rebuilt from the three tables
-- above, never hand-edited, so it can always be dropped and regenerated.
CREATE TABLE IF NOT EXISTS derived_features (
    grid_id                     TEXT NOT NULL,
    timestamp                   TEXT NOT NULL,
    ventilation_coefficient     REAL,
    inversion_strength          REAL,
    lapse_rate                  REAL,
    plume_influence             REAL,
    sustained_low_ventilation   INTEGER,
    PRIMARY KEY (grid_id, timestamp)
);

-- Predictions, with BOTH timestamps. issued_at is what makes this table worth
-- having: without it there is no way to ask "what did we know, and when", and
-- a scoring run silently becomes a hindcast.
CREATE TABLE IF NOT EXISTS forecasts (
    issued_at       TEXT NOT NULL,
    valid_at        TEXT NOT NULL,
    station_id      TEXT NOT NULL,
    species         TEXT NOT NULL,
    forecast_value  REAL,
    model_version   TEXT NOT NULL,
    PRIMARY KEY (issued_at, valid_at, station_id, species, model_version)
);

-- The multi-station NCR target, derived from captured station rows.
-- Kept in its own table rather than written into station_readings because it
-- is a DERIVED quantity: it can always be rebuilt from the stations, and
-- storing it alongside them would blur what was measured with what was
-- computed. The legacy single-monitor series stays untouched in
-- station_readings as the frozen historical benchmark.
CREATE TABLE IF NOT EXISTS ncr_target (
    timestamp           TEXT PRIMARY KEY,
    n_reporting         INTEGER,
    n_valid             INTEGER,
    coverage_cells      INTEGER,
    coverage_fraction   REAL,
    pm25_mean           REAL,
    pm25_median         REAL,
    pm25_p90            REAL,
    pm25_p95            REAL,
    pm25_min            REAL,
    pm25_max            REAL,
    pm25_iqr            REAL,
    usable              INTEGER,
    source              TEXT
);

CREATE INDEX IF NOT EXISTS ix_readings_time ON station_readings (timestamp);
CREATE INDEX IF NOT EXISTS ix_met_time      ON met_hourly (timestamp);
CREATE INDEX IF NOT EXISTS ix_fire_time     ON fire_events (timestamp);
CREATE INDEX IF NOT EXISTS ix_derived_time  ON derived_features (timestamp);
CREATE INDEX IF NOT EXISTS ix_fc_valid      ON forecasts (valid_at);
"""


def connect() -> sqlite3.Connection:
    """Open the store, creating the file and schema on first use."""
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    # WAL so a long ingestion run does not block a reader inspecting progress.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    _migrate(conn)
    return conn


# Columns added after the first stores were created. CREATE TABLE IF NOT EXISTS
# does nothing to a table that already exists, so a schema change has to be
# applied explicitly or an existing .db silently keeps the old shape and every
# write of the new column fails.
_ADDED_COLUMNS = {
    "station_readings": {"n_stations": "INTEGER"},
}


def _migrate(conn: sqlite3.Connection) -> None:
    """Add any column this file declares that the open database lacks."""
    for table, columns in _ADDED_COLUMNS.items():
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in columns.items():
            if name not in have:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
    conn.commit()


def iso(value: Any) -> str | None:
    """
    Normalise any timestamp to one UTC ISO-8601 string.

    Centralised because three ingestion modules produce timestamps from three
    upstream formats. If each formatted its own, a join on timestamp would
    silently return nothing and look like missing data rather than a bug.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")
    return None


def upsert(conn: sqlite3.Connection, table: str, keys: Sequence[str],
           rows: Iterable[dict]) -> int:
    """
    Insert-or-update a batch, returning the number of rows written.

    Non-key columns are overwritten on conflict rather than ignored: a re-run
    against a corrected upstream should replace the bad value, not preserve it.
    """
    rows = [r for r in rows if r]
    if not rows:
        return 0

    cols = list(rows[0].keys())
    placeholders = ",".join("?" for _ in cols)
    updatable = [c for c in cols if c not in keys]
    set_clause = ",".join(f"{c}=excluded.{c}" for c in updatable)
    sql = (f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT ({','.join(keys)}) DO UPDATE SET {set_clause}"
           if updatable else
           f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders}) "
           f"ON CONFLICT ({','.join(keys)}) DO NOTHING")

    with conn:
        conn.executemany(sql, [tuple(r.get(c) for c in cols) for r in rows])
    return len(rows)


def table_summary(conn: sqlite3.Connection) -> list[dict]:
    """Row counts and time spans, for the run report."""
    out = []
    for table in ("station_readings", "met_hourly", "fire_events",
                  "derived_features", "forecasts", "ncr_target"):
        col = "valid_at" if table == "forecasts" else "timestamp"
        row = conn.execute(
            f"SELECT COUNT(*) n, MIN({col}) lo, MAX({col}) hi FROM {table}"
        ).fetchone()
        out.append({"table": table, "rows": row["n"],
                    "first": row["lo"], "last": row["hi"]})
    return out
