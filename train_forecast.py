#!/usr/bin/env python
"""
Fit and persist the forecast service's models.

    python train_forecast.py --train-end 2024-11-01     # the replay model
    python train_forecast.py                            # up to today (live)
    python train_forecast.py --list                     # what is on disk

WHY MODELS ARE NAMED BY THE DATE THEY WERE ALLOWED TO SEE
    forecast(as_of) loads the newest model whose train_end is at or before
    as_of. So a replay of 16 Nov 2024 can only ever load a model trained before
    November 2024 - not because anyone remembered to pick the right file, but
    because a later one is never a candidate. Leakage is prevented by the
    naming scheme rather than by discipline.

    That means the demo needs at least two: one for the replay anchor and one
    trained up to now for live operation. Both are written here.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env")

_TMP = _PROJECT_ROOT / ".tmp"
_TMP.mkdir(exist_ok=True)
tempfile.tempdir = str(_TMP)
os.environ["TMP"] = os.environ["TEMP"] = os.environ["TMPDIR"] = str(_TMP)

from backend.backfill import db  # noqa: E402
from backend.forecast import pm25_forecast as fc  # noqa: E402

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Train and persist forecast models")
    p.add_argument("--train-end", default="",
                   help="YYYY-MM-DD; models see nothing at or after this date")
    p.add_argument("--list", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if args.list:
        print("\nPersisted forecast models")
        print("  " + "-" * 66)
        for name in fc.OUTPUTS:
            entries = fc.available_models(name)
            if not entries:
                print(f"  {name:<10} none")
            for train_end, path in entries:
                size = path.stat().st_size / 1024
                print(f"  {name:<10} sees data before {train_end:%Y-%m-%d}"
                      f"   {path.name:<28} {size:>7.0f} KB")
        print()
        return 0

    conn = db.connect()
    train_end = (datetime.strptime(args.train_end, "%Y-%m-%d").replace(
        tzinfo=timezone.utc) if args.train_end
        else datetime.now(timezone.utc).replace(hour=0, minute=0, second=0,
                                                microsecond=0))

    print(f"\nTraining forecast models — data strictly before "
          f"{train_end:%Y-%m-%d}")
    print("  " + "-" * 66)
    result = fc.train_and_persist(conn, train_end)
    print(f"  station   {result['station']}")
    print(f"  grid      {result['grid']}")
    for name, info in result["models"].items():
        label = fc.OUTPUTS[name][1]
        print(f"  {name:<10}{info['samples']:>9,} samples   {label}")
        print(f"  {'':<10}{Path(info['path']).name}")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
