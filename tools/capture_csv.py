#!/usr/bin/env python
"""
Capture the NCR station network to CSV, for a runner that keeps no database.

WHY THIS EXISTS ALONGSIDE capture.py
    capture.py writes station_readings into the SQLite store, which is the
    correct thing on a machine that KEEPS that store. A GitHub Actions runner
    keeps nothing: its filesystem is discarded when the job ends, and the store
    is 186 MB and gitignored, so it can be neither carried in nor carried out.

    What a runner can keep is a commit. So this writes the same rows as CSV and
    the repository becomes the durable record. The hourly cron is then the
    process that keeps the series unbroken - the job the in-process capture
    thread can only do while some machine stays awake, which is exactly the
    assumption that has failed repeatedly here.

WHY APPEND-ONLY, AND WHY ONE FILE PER UTC DAY
    A single rolling file rewritten hourly would store a fresh multi-megabyte
    blob in git 24 times a day. Appending to a daily file keeps each commit to
    the ~80 rows that hour actually produced, which is what git is good at.

    Duplicates are tolerated in the file and removed on import. That ordering is
    deliberate: an append can never damage what is already committed, and a
    rewrite can. The import is idempotent regardless, because it upserts on
    (station_id, timestamp) - the same key capture.py uses.

ONE ROW IS ONE INSTRUMENT
    The same shape capture.snapshot() writes. A composite is derivable from the
    stations; the stations are not recoverable from a composite.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

# Keep every byte this tool writes on the project drive, for the same reason
# backfill.py does: a library that spools to disk would otherwise land in the
# user profile without anyone noticing.
_TMP = _ROOT / ".tmp"
try:
    _TMP.mkdir(exist_ok=True)
    tempfile.tempdir = str(_TMP)
except OSError:                                              # noqa: BLE001
    pass

# Secrets reach a runner as real environment variables; a developer keeps them
# in .env. Loading the file only when a key is absent means the runner's value
# always wins and a local run needs no extra step.
try:
    from dotenv import load_dotenv                           # noqa: PLC0415
    load_dotenv(_ROOT / ".env", override=False)
except ImportError:
    pass

# NOT under data/. Every deployment mounts a volume at /app/data - render.yaml
# declares a disk there and docker-compose a named volume - and a mount SHADOWS
# whatever the image had at that path. Committed observations living there would
# be invisible in exactly the deployment they exist to serve, and invisible
# quietly: the store would simply come up empty and answer 424.
OBS_DIR = _ROOT / "observations"

# Same columns capture.snapshot() builds, in a fixed order so a hand-inspected
# file and a parsed one agree.
FIELDS = ("station_id", "timestamp", "pm25", "latitude", "longitude",
          "n_stations", "source")


def _emit(key: str, value: str) -> None:
    """Hand a value to the calling GitHub step, when there is one.

    The commit message used to stamp `date -u`, which is the moment the RUNNER
    woke up - not the hour the data describes. CPCB publishes 40-100 minutes
    late, so those differ by one hour almost every run: a commit labelled 06:00Z
    carrying 05:00Z readings. The label is what anyone reading git log later has
    to trust, so it comes from the rows themselves.
    """
    path = os.getenv("GITHUB_OUTPUT")
    if not path:
        return
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(f"{key}={value}\n")
    except OSError:                                          # noqa: BLE001
        pass


def _day_file(moment: datetime) -> Path:
    return OBS_DIR / f"{moment:%Y-%m-%d}.csv"


def collect() -> list[dict]:
    """One live read of the NCR network, as rows ready for CSV or the store."""
    from backend.ingestion import ncr_observations as obs   # noqa: PLC0415

    payload = obs.composite_pm25(include_stations=True)
    if not payload.get("available"):
        raise RuntimeError(f"composite unavailable: {payload.get('reason')}")

    now = datetime.now(timezone.utc)
    source = payload.get("source", "unknown")
    rows = []
    for st in payload.get("stations") or []:
        # The upstream key is pm25_ugm3, not pm25 - reading the wrong one wrote
        # zero rows while cheerfully reporting 79 stations.
        value, name = st.get("pm25_ugm3"), st.get("station")
        if value is None or not name:
            continue
        observed = st.get("observed_at") or now
        if isinstance(observed, str):
            stamp = observed
        else:
            stamp = f"{observed:%Y-%m-%dT%H:00:00Z}"
        rows.append({
            "station_id": name,
            "timestamp": stamp,
            "pm25": float(value),
            "latitude": st.get("lat"),
            "longitude": st.get("lon"),
            "n_stations": 1,
            "source": f"live:{source}",
        })
    if not rows:
        raise RuntimeError(
            f"{len(payload.get('stations') or [])} stations reported but no row "
            "carried a usable pm25_ugm3 - refusing to commit an empty capture")
    return rows


def _existing_keys(path: Path) -> set[tuple[str, str]]:
    if not path.exists():
        return set()
    with path.open(encoding="utf-8", newline="") as fh:
        return {(r["station_id"], r["timestamp"]) for r in csv.DictReader(fh)
                if r.get("station_id") and r.get("timestamp")}


def cmd_export(args) -> int:
    rows = collect()
    OBS_DIR.mkdir(parents=True, exist_ok=True)
    target = _day_file(datetime.now(timezone.utc))
    new = not target.exists()

    # Drop station-hours the file already carries. CPCB republishes the same
    # hour for as long as it is the newest one, so without this an hourly cron
    # appends the same ~80 rows repeatedly and every run produces a commit that
    # adds no information. Skipping them makes "the file changed" mean "an hour
    # we did not have arrived", which is what the schedule is actually for.
    have = _existing_keys(target)
    rows = [r for r in rows if (r["station_id"], r["timestamp"]) not in have]
    if not rows:
        print(f"nothing new - {target.relative_to(_ROOT)} already has this hour")
        _emit("captured", "false")
        _emit("hour", "")
        return 0

    with target.open("a", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS, lineterminator="\n")
        if new:
            writer.writeheader()
        writer.writerows(rows)

    hours = sorted({r["timestamp"] for r in rows})
    _emit("captured", "true")
    # The newest hour actually written, which is what the commit should name.
    _emit("hour", hours[-1])
    _emit("rows", str(len(rows)))
    print(f"wrote {len(rows)} rows to {target.relative_to(_ROOT)}")
    print(f"  hours covered : {hours[0]} .. {hours[-1]}")
    print(f"  source        : {rows[0]['source']}")
    return 0


def _read_csvs(paths: list[Path]) -> list[dict]:
    """Every row from the given files, de-duplicated on (station_id, timestamp).

    Later files win, which makes a re-export of a corrected hour authoritative
    over the original without anyone having to edit history.
    """
    merged: dict[tuple[str, str], dict] = {}
    for path in sorted(paths):
        with path.open(encoding="utf-8", newline="") as fh:
            for raw in csv.DictReader(fh):
                if not raw.get("station_id") or not raw.get("timestamp"):
                    continue
                row = {
                    "station_id": raw["station_id"],
                    "timestamp": raw["timestamp"],
                    "pm25": float(raw["pm25"]) if raw.get("pm25") else None,
                    "latitude": float(raw["latitude"]) if raw.get("latitude") else None,
                    "longitude": float(raw["longitude"]) if raw.get("longitude") else None,
                    "n_stations": int(raw["n_stations"] or 1),
                    "source": raw.get("source") or "csv",
                }
                merged[(row["station_id"], row["timestamp"])] = row
    return list(merged.values())


def cmd_import(args) -> int:
    from backend.backfill import db                          # noqa: PLC0415

    paths = sorted(OBS_DIR.glob("*.csv"))
    if not paths:
        print(f"no CSVs under {OBS_DIR.relative_to(_ROOT)} - nothing to import")
        return 0

    rows = _read_csvs(paths)
    # db.connect() takes no path: it resolves AREE_DB_PATH itself, so pointing
    # it elsewhere means setting that, not passing an argument.
    if args.db:
        os.environ["AREE_DB_PATH"] = args.db
    conn = db.connect()
    try:
        written = db.upsert(conn, "station_readings",
                            ("station_id", "timestamp"), rows)
        conn.commit()
    finally:
        conn.close()

    stamps = sorted({r["timestamp"] for r in rows})
    print(f"imported {written} of {len(rows)} rows from {len(paths)} file(s)")
    print(f"  span: {stamps[0]} .. {stamps[-1]}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("export", help="one live capture, appended to today's CSV")
    imp = sub.add_parser("import", help="load the committed CSVs into the store")
    imp.add_argument("--db", default=None, help="store path (default: AREE_DB_PATH)")

    args = p.parse_args(argv)
    try:
        return {"export": cmd_export, "import": cmd_import}[args.cmd](args)
    except Exception as exc:                                 # noqa: BLE001
        # A capture that fails must say why and fail loudly: a green job that
        # committed nothing is the failure mode this whole file exists to avoid.
        print(f"ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
