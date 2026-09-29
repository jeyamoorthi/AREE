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
import io
import json
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
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

# The history the live forecast reads: pm25_forecast.OBSERVATION_WINDOW_HOURS.
# Restated rather than imported because that module pulls LightGBM and numpy,
# which the capture runner does not install; test_capture_csv pins the two.
ARCHIVE_WINDOW_HOURS = 49

# capture_scheduler.PUBLICATION_DELAY_HOURS: the newest hours are absent because
# CPCB has not published them yet, not because they were lost.
PUBLICATION_DELAY_HOURS = 2

# Where a starting container reads the archive as it is NOW, rather than as it
# was when the image was built. The same repository the met mirror uses
# (weather_stream.MIRROR_URL). "off" disables it.
REMOTE_BASE = os.getenv(
    "AREE_OBS_MIRROR_URL",
    "https://raw.githubusercontent.com/jeyamoorthi/AREE/main/observations")
REMOTE_DAYS = 3          # covers ARCHIVE_WINDOW_HOURS from any hour of the day
REMOTE_TIMEOUT_SECONDS = 8


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


def _append(rows: list[dict]) -> list[dict]:
    """Append rows to the day file their own timestamp names. Returns what was new.

    Drops station-hours the file already carries. CPCB republishes the same hour
    for as long as it is the newest one, so without this an hourly cron appends
    the same ~80 rows repeatedly and every run produces a commit that adds no
    information. Skipping them makes "the file changed" mean "an hour we did not
    have arrived", which is what the schedule is actually for.
    """
    by_file: dict[Path, list[dict]] = {}
    for row in rows:
        stamp = _parse_hour(row["timestamp"])
        if stamp is None:
            continue
        by_file.setdefault(_day_file(stamp), []).append(row)

    OBS_DIR.mkdir(parents=True, exist_ok=True)
    out: list[dict] = []
    for target, batch in sorted(by_file.items()):
        have = _existing_keys(target)
        batch = [r for r in batch if (r["station_id"], r["timestamp"]) not in have]
        if not batch:
            continue
        new = not target.exists()
        with target.open("a", encoding="utf-8", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=FIELDS, lineterminator="\n")
            if new:
                writer.writeheader()
            writer.writerows(batch)
        print(f"wrote {len(batch)} rows to observations/{target.name}")
        out.extend(batch)
    return out


def _parse_hour(stamp: str) -> datetime | None:
    try:
        return datetime.strptime(stamp, "%Y-%m-%dT%H:00:00Z").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def archive_holes(now: datetime | None = None) -> list[datetime]:
    """Hours inside the forecast's window that no committed CSV carries.

    WHY THE ARCHIVE HAS HOLES AT ALL
        GitHub runs scheduled workflows on a best-effort basis. Measured on
        2026-09-28: the `10 * * * *` capture fired seven times, not twenty-four,
        and each run records only the hour CPCB is currently publishing. So the
        archive a cold container imports was missing most hours of the lag
        window, and every boot had to rebuild them from OpenAQ - the minutes-long
        "Restoring observation history" screen.
    """
    now = (now or datetime.now(timezone.utc)).replace(minute=0, second=0, microsecond=0)
    since = now - timedelta(hours=ARCHIVE_WINDOW_HOURS)
    until = now - timedelta(hours=PUBLICATION_DELAY_HOURS)

    days = {since.date() + timedelta(days=d)
            for d in range((until.date() - since.date()).days + 1)}
    have: set[datetime] = set()
    for day in days:
        path = OBS_DIR / f"{day:%Y-%m-%d}.csv"
        for _, stamp in _existing_keys(path):
            hour = _parse_hour(stamp)
            if hour is not None:
                have.add(hour)

    out, cursor = [], since
    while cursor <= until:
        if cursor not in have:
            out.append(cursor)
        cursor += timedelta(hours=1)
    return out


def fill_holes(now: datetime | None = None) -> list[dict]:
    """Recover the archive's missing hours from OpenAQ history. Returns rows written.

    The same rows, same source tag (openaq:hourly) and same fetch the deployed
    store's own repair uses - capture.openaq_rows - so a hole filled here is a
    hole the container no longer has to fill at boot. OpenAQ is itself hours
    behind for some NCR sensors, so the newest holes may stay open until a later
    run; that is the reason this runs every time rather than once.
    """
    now = now or datetime.now(timezone.utc)
    holes = archive_holes(now)
    if not holes:
        print(f"archive continuous across the last {ARCHIVE_WINDOW_HOURS} h")
        return []

    import capture                                           # noqa: PLC0415

    wanted = {f"{h:%Y-%m-%dT%H:00:00Z}" for h in holes}
    # +1 h so the oldest hole sits inside the window rather than on its edge.
    window = int((now - min(holes)).total_seconds() // 3600) + 1
    print(f"{len(holes)} hole(s) in the archive, oldest {min(holes):%Y-%m-%d %H:00}Z "
          f"- filling from OpenAQ ({window} h)")
    rows = [r for r in capture.openaq_rows(window) if r["timestamp"] in wanted]
    written = _append(rows)
    left = len(archive_holes(now))
    print(f"filled {len({r['timestamp'] for r in written})} hour(s); {left} still open")
    return written


def cmd_export(args) -> int:
    # The live read and the hole fill are independent. A CAQM outage must not
    # also stop the archive repairing itself, and an OpenAQ outage must not cost
    # the hour CAQM just published.
    live_error: Exception | None = None
    try:
        written = _append(collect())
    except Exception as exc:                                 # noqa: BLE001
        live_error, written = exc, []
        print(f"live capture failed: {type(exc).__name__}: {exc}", file=sys.stderr)

    if not getattr(args, "no_fill", False):
        try:
            written += fill_holes()
        except Exception as exc:                             # noqa: BLE001
            print(f"hole fill skipped: {type(exc).__name__}: {exc}", file=sys.stderr)

    if not written:
        print("nothing new - the archive already has every hour available")
        _emit("captured", "false")
        _emit("hour", "")
    else:
        hours = sorted({r["timestamp"] for r in written})
        _emit("captured", "true")
        # The newest hour actually written, which is what the commit should name.
        _emit("hour", hours[-1])
        _emit("rows", str(len(written)))
        print(f"  hours covered : {hours[0]} .. {hours[-1]} ({len(hours)} distinct)")

    if live_error is not None:
        # Still loud: a green job that silently lost the live hour is the failure
        # mode this file exists to avoid. Anything filled above is kept.
        raise live_error
    return 0


def _fetch_remote(days: int = REMOTE_DAYS) -> list[tuple[str, str]]:
    """The newest day files as the repository holds them now: (name, text) pairs.

    WHY A STARTING CONTAINER NEEDS THIS
        observations/ is copied into the image at build time, so a container
        imports the archive as it stood at its last deploy. Every capture since
        then - up to days of it, on an instance that only restarts when it wakes
        - is in the repository and not in the container, and the boot repair had
        to rebuild those hours from OpenAQ instead.

    Best effort by design. A missing day (404), a timeout or no network at all
    returns fewer files, never an error: the baked-in copy is still imported and
    the in-process repair still runs after this.
    """
    if REMOTE_BASE.lower() in ("", "off"):
        return []
    import requests                                          # noqa: PLC0415

    today = datetime.now(timezone.utc).date()
    names = [f"{today - timedelta(days=d):%Y-%m-%d}.csv" for d in range(days)]

    def _get(name: str) -> tuple[str, str] | None:
        try:
            r = requests.get(f"{REMOTE_BASE}/{name}", timeout=REMOTE_TIMEOUT_SECONDS)
        except requests.RequestException as exc:
            print(f"  remote {name}: {type(exc).__name__}")
            return None
        if r.status_code != 200:
            print(f"  remote {name}: HTTP {r.status_code}")
            return None
        return name, r.text

    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        return [got for got in pool.map(_get, names) if got]


def _read_csvs(paths: list[Path],
               remote: list[tuple[str, str]] | None = None) -> list[dict]:
    """Every row from the given files, de-duplicated on (station_id, timestamp).

    Later files win, which makes a re-export of a corrected hour authoritative
    over the original without anyone having to edit history. Remote copies are
    read after every local file, so the repository's current version wins over
    the one baked into the image.
    """
    sources = [path.read_text(encoding="utf-8") for path in sorted(paths)]
    sources += [text for _, text in sorted(remote or [])]

    merged: dict[tuple[str, str], dict] = {}
    for text in sources:
        for raw in csv.DictReader(io.StringIO(text)):
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
    remote = _fetch_remote() if args.remote else []
    if args.remote:
        print(f"fetched {len(remote)} day file(s) from {REMOTE_BASE}")
    if not paths and not remote:
        print(f"no CSVs under {OBS_DIR.relative_to(_ROOT)} - nothing to import")
        return 0

    rows = _read_csvs(paths, remote)
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
    print(f"imported {written} of {len(rows)} rows from {len(paths)} local and "
          f"{len(remote)} remote file(s)")
    print(f"  span: {stamps[0]} .. {stamps[-1]}")
    return 0


def cmd_met(args) -> int:
    """Mirror the live Open-Meteo forecast for the NCR point into the repository.

    The deployed backend falls back to this when Open-Meteo rate-limits its own
    IP - see weather_stream.MIRROR_URL. A failed fetch leaves the previous mirror
    in place rather than replacing it with nothing.
    """
    from backend.ingestion import weather_stream as ws      # noqa: PLC0415

    doc = ws.fetch_mirror_document()
    if doc is None:
        print("open-meteo unavailable - keeping the previous mirror")
        return 0
    OBS_DIR.mkdir(parents=True, exist_ok=True)
    ws.MIRROR_FILE.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
    hours = len(doc["payload"]["hourly"]["time"])
    print(f"mirrored {hours} forecast hours to {ws.MIRROR_FILE.relative_to(_ROOT)}")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    sub = p.add_subparsers(dest="cmd", required=True)
    exp = sub.add_parser("export", help="one live capture, plus any archive holes "
                                        "OpenAQ can fill, appended to the day CSVs")
    exp.add_argument("--no-fill", action="store_true",
                     help="skip the OpenAQ hole fill; live capture only")
    imp = sub.add_parser("import", help="load the committed CSVs into the store")
    imp.add_argument("--db", default=None, help="store path (default: AREE_DB_PATH)")
    imp.add_argument("--remote", action="store_true",
                     help=f"also read the newest {REMOTE_DAYS} day files from the "
                          "repository (AREE_OBS_MIRROR_URL), which win over local copies")
    sub.add_parser("met", help="mirror the live NCR meteorology forecast")

    args = p.parse_args(argv)
    try:
        return {"export": cmd_export, "import": cmd_import,
                "met": cmd_met}[args.cmd](args)
    except Exception as exc:                                 # noqa: BLE001
        # A capture that fails must say why and fail loudly: a green job that
        # committed nothing is the failure mode this whole file exists to avoid.
        print(f"ERROR {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
