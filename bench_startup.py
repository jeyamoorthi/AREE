#!/usr/bin/env python
"""
Phase 8 — what a cold start actually costs, measured rather than asserted.

    python bench_startup.py local              spawn a backend here and measure it
    python bench_startup.py local --broken     ... against a COPY of the store,
                                               so a known-bad store can be reused
    python bench_startup.py url --url https://aree-backend.onrender.com

WHY THIS IS A COMMITTED TOOL AND NOT A SCRATCH SCRIPT
    Phases 1-4 were justified by numbers, and every one of those numbers came
    from a throwaway script that no longer exists. That is how a repository ends
    up with a performance claim nobody can reproduce and nobody dares change.
    The comparison that matters next - this machine against Render - is only
    meaningful if both sides are measured the same way, so the measurement is
    part of the repository.

WHAT IT MEASURES, AND WHY EACH ONE IS SEPARATE
    health          the process answers. Liveness only; it says nothing about data.
    ready           the engine has published a station table. This is the number
                    a viewer experiences as "the dashboard loaded".
    stations        the first request that actually returns rows, as a check that
                    `ready` is not lying.
    continuity      whether the observation store can serve the forecast's lag
                    set, read from /api/system/capture. A store one hour behind
                    can still be missing an hour from yesterday.
    repair          if the store had holes at boot: how long until it had none.
    forecast        the 424 -> 200 transition, which is the user-visible fault.
    responsiveness  latency of a probe running CONTINUOUSLY throughout. This is
                    the row that decides whether the repair is genuinely off the
                    critical path or merely appears to be when nothing else is
                    happening.

WHAT IT CANNOT MEASURE REMOTELY
    CPU and RSS. Against a URL there is no process to sample, so those come from
    the host's own metrics panel. Locally they are sampled if `psutil` is
    installed and reported as "not sampled" if it is not - an absent measurement
    is reported as absent rather than filled in with something plausible.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent

# How often the background probe fires. Fast enough to catch a stall that a user
# would notice, slow enough not to become load in its own right.
PROBE_INTERVAL_S = 0.5

# Give up rather than hang forever. A cold start that takes this long has failed
# in a way no percentile will usefully describe.
DEFAULT_TIMEOUT_S = 420.0


# ── the continuous probe ────────────────────────────────────────────────────

class Probe(threading.Thread):
    """Hits one cheap endpoint on a fixed cadence for the whole run.

    Its purpose is not to measure that endpoint. It is to answer "was the API
    answering while the slow thing happened", which a sequence of one-shot
    timings cannot: they only sample the moments the harness happened to look.
    """

    def __init__(self, base: str, path: str = "/api/health"):
        super().__init__(daemon=True, name="bench-probe")
        self.base, self.path = base, path
        self.samples: list[tuple[float, float, int | None]] = []
        self._stop = threading.Event()
        self._t0 = time.monotonic()

    def run(self) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                r = requests.get(self.base + self.path, timeout=30)
                status: int | None = r.status_code
            except Exception:                                  # noqa: BLE001
                status = None
            self.samples.append((started - self._t0,
                                 time.monotonic() - started, status))
            self._stop.wait(PROBE_INTERVAL_S)

    def stop(self) -> None:
        self._stop.set()

    def report(self, since: float = 0.0, until: float | None = None) -> dict:
        window = [s for s in self.samples
                  if s[0] >= since and (until is None or s[0] <= until)]
        oks = [d for _, d, st in window if st == 200]
        return {
            "requests": len(window),
            "failed": sum(1 for _, _, st in window if st != 200),
            "p50_ms": round(statistics.median(oks) * 1000, 1) if oks else None,
            # A p95 over a handful of samples is noise wearing a statistic's
            # name. Below 20 it is reported as absent rather than computed.
            "p95_ms": (round(sorted(oks)[int(len(oks) * 0.95)] * 1000, 1)
                       if len(oks) >= 20 else None),
            "max_ms": round(max(oks) * 1000, 1) if oks else None,
        }


class ContinuitySampler(threading.Thread):
    """Polls /api/system/capture from t=0 for the whole run.

    WHY THIS CANNOT BE A ONE-SHOT READ AFTER `ready`
        The first version read continuity once, immediately after /api/ready went
        green, and reported "holes: 0" against a store that provably had ten. The
        repair had simply already finished - it now takes about seven seconds and
        `ready` arrives at about ten, so the interesting state was over before the
        harness looked.

        A measurement that races the thing it measures is not a measurement. The
        boot state and the repair transition are both read from a continuous
        series, so neither depends on when the harness happened to ask.
    """

    def __init__(self, base: str):
        super().__init__(daemon=True, name="bench-continuity")
        self.base = base
        self.samples: list[tuple[float, dict]] = []
        self._stop = threading.Event()
        self._t0 = time.monotonic()

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                r = requests.get(self.base + "/api/system/capture", timeout=20)
                if r.status_code == 200:
                    self.samples.append((time.monotonic() - self._t0, r.json()))
            except Exception:                                  # noqa: BLE001
                pass
            self._stop.wait(PROBE_INTERVAL_S)

    def stop(self) -> None:
        self._stop.set()

    def first(self) -> tuple[float, dict] | None:
        return self.samples[0] if self.samples else None

    def first_continuous(self) -> float | None:
        for at, body in self.samples:
            if body.get("continuous"):
                return at
        return None

    def worst(self) -> dict | None:
        """The sample with the most holes - the true boot state of the store."""
        if not self.samples:
            return None
        return max(self.samples, key=lambda s: s[1].get("holes") or 0)[1]


# ── milestones ──────────────────────────────────────────────────────────────

class Run:
    def __init__(self, base: str, timeout: float):
        self.base, self.timeout = base.rstrip("/"), timeout
        self.t0 = time.monotonic()
        self.marks: dict[str, float | None] = {}
        self.notes: dict[str, object] = {}

    def el(self) -> float:
        return time.monotonic() - self.t0

    def get(self, path: str, timeout: float = 30):
        try:
            return requests.get(self.base + path, timeout=timeout)
        except Exception:                                      # noqa: BLE001
            return None

    def await_(self, path: str, ok, label: str) -> object:
        """Poll until `ok(response)`; record when it first held."""
        while self.el() < self.timeout:
            r = self.get(path)
            if r is not None:
                try:
                    if ok(r):
                        self.marks[label] = self.el()
                        return r
                except Exception:                              # noqa: BLE001
                    pass
            time.sleep(0.25)
        self.marks[label] = None
        return None


def _has_rows(r) -> bool:
    if r.status_code != 200:
        return False
    body = r.json()
    return bool(body.get("stations") or body.get("count"))


def measure(base: str, timeout: float, proc=None) -> Run:
    run = Run(base, timeout)
    probe = Probe(run.base)
    probe.start()

    continuity = ContinuitySampler(run.base)
    continuity.start()

    sampler = _ResourceSampler(proc)
    sampler.start()

    try:
        run.await_("/api/health", lambda r: r.status_code == 200, "health")

        first = run.get("/api/ready")
        if first is not None:
            try:
                run.notes["ready_first_state"] = first.json().get("state")
                run.notes["ready_first_status"] = first.status_code
            except Exception:                                  # noqa: BLE001
                pass

        r = run.await_("/api/ready", lambda r: r.status_code == 200, "ready")
        if r is not None:
            run.notes["stations_reported"] = r.json().get("stations")
            run.notes["mode"] = r.json().get("mode")

        run.await_("/api/stations", _has_rows, "stations")

        # Continuity comes from the sampler that has been running since t=0, so
        # the boot state is what the store actually looked like rather than
        # whatever survived until the harness got round to asking.
        worst = continuity.worst()
        if worst is not None:
            run.notes["holes_at_boot"] = worst.get("holes")
            run.notes["oldest_hole"] = worst.get("oldest_hole")
            run.notes["gap_at_boot"] = worst.get("trailing_gap_hours")
            run.notes["continuous_at_boot"] = (worst.get("holes") or 0) == 0
            first = continuity.first()
            run.notes["continuity_first_seen_at"] = round(first[0], 1) if first else None
        else:
            run.notes["capture_endpoint"] = "unavailable (old build?)"

        run.marks["continuous"] = continuity.first_continuous()
        if run.marks["continuous"] is None and worst is not None and not worst.get("holes"):
            run.marks["continuous"] = run.marks.get("ready")

        # The user-visible fault: outlook 424 while the lag set is incomplete.
        out = run.get("/api/aree/outlook", timeout=180)
        if out is not None:
            run.notes["outlook_first_status"] = out.status_code
            if out.status_code != 200:
                try:
                    run.notes["outlook_first_detail"] = out.json().get("detail")
                except Exception:                              # noqa: BLE001
                    pass
        run.await_("/api/aree/outlook", lambda r: r.status_code == 200, "outlook")
    finally:
        probe.stop()
        continuity.stop()
        sampler.stop()
        probe.join(timeout=5)
        continuity.join(timeout=5)
        sampler.join(timeout=5)

    # Measured from the first successful health check, not from process spawn:
    # before that the socket is not listening, and a connection refusal is not a
    # slow response. Including it would report a stall that never happened.
    health_at = run.marks.get("health") or 0.0
    run.notes["probe_overall"] = probe.report(since=health_at)

    cont_at = run.marks.get("continuous")
    if cont_at is not None and cont_at > health_at:
        # The window the repair occupies. If the API stalls anywhere, here.
        run.notes["probe_during_repair"] = probe.report(health_at, cont_at)
    run.notes["resources"] = sampler.report()
    return run


class _ResourceSampler(threading.Thread):
    """CPU and RSS of the backend process, when that is observable."""

    def __init__(self, proc):
        super().__init__(daemon=True, name="bench-resources")
        self.proc = proc
        self._stop = threading.Event()
        self.cpu: list[float] = []
        self.rss: list[float] = []
        self.reason: str | None = None
        try:
            import psutil                                      # noqa: PLC0415
            self._ps = psutil.Process(proc.pid) if proc else None
            if self._ps is None:
                self.reason = "remote target - sample the host's metrics panel"
        except ImportError:
            self._ps = None
            self.reason = "psutil not installed"

    def run(self) -> None:
        if self._ps is None:
            return
        while not self._stop.is_set():
            try:
                # Children included: uvicorn's worker does the work.
                procs = [self._ps, *self._ps.children(recursive=True)]
                self.cpu.append(sum(p.cpu_percent(interval=None) for p in procs))
                self.rss.append(sum(p.memory_info().rss for p in procs) / 1e6)
            except Exception:                                  # noqa: BLE001
                pass
            self._stop.wait(1.0)

    def stop(self) -> None:
        self._stop.set()

    def report(self) -> dict:
        if self._ps is None:
            return {"sampled": False, "reason": self.reason}
        return {
            "sampled": True,
            "cpu_peak_pct": round(max(self.cpu), 1) if self.cpu else None,
            "rss_peak_mb": round(max(self.rss), 1) if self.rss else None,
            "rss_final_mb": round(self.rss[-1], 1) if self.rss else None,
        }


# ── output ──────────────────────────────────────────────────────────────────

def _fmt(v: float | None) -> str:
    return f"{v:.1f} s" if v is not None else "not reached"


def render(run: Run, target: str) -> None:
    n = run.notes
    print()
    print("=" * 78)
    print(f"  AREE cold start — {target}")
    print(f"  {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC")
    print("=" * 78)
    print()
    print("  MILESTONE                                          ELAPSED")
    print("  " + "-" * 74)
    rows = [
        ("/api/health answers (process alive)", "health"),
        ("/api/ready 200 (engine has data)", "ready"),
        ("/api/stations returns rows", "stations"),
        ("observation store continuous", "continuous"),
        ("/api/aree/outlook 200", "outlook"),
    ]
    for label, key in rows:
        print(f"  {label:<48} {_fmt(run.marks.get(key)):>12}")

    print()
    print("  STORE AT BOOT")
    print("  " + "-" * 74)
    print(f"    trailing gap        : {n.get('gap_at_boot')} h")
    print(f"    holes in lag window : {n.get('holes_at_boot')}"
          + (f"   (oldest {n.get('oldest_hole')})" if n.get("oldest_hole") else ""))
    print(f"    continuous at boot  : {n.get('continuous_at_boot')}")
    if n.get("continuity_first_seen_at") is not None:
        print(f"    first observed at   : t+{n['continuity_first_seen_at']} s")
    health_at, cont_at = run.marks.get("health"), run.marks.get("continuous")
    ready_at = run.marks.get("ready")
    if n.get("holes_at_boot") and cont_at is not None and health_at is not None:
        print(f"    repaired by         : t+{cont_at:.1f} s "
              f"({cont_at - health_at:.1f} s after the API started answering)")
        if ready_at is not None:
            when = ("before" if cont_at <= ready_at else "after")
            print(f"    ... which is {when} /api/ready went green at "
                  f"t+{ready_at:.1f} s")

    print()
    print("  FIRST RESPONSES")
    print("  " + "-" * 74)
    print(f"    /api/ready first    : HTTP {n.get('ready_first_status')} "
          f"({n.get('ready_first_state')})")
    print(f"    /api/aree/outlook   : HTTP {n.get('outlook_first_status')}")
    if n.get("outlook_first_detail"):
        print(f"       {str(n['outlook_first_detail'])[:70]}")
    print(f"    engine              : {n.get('mode')}, "
          f"{n.get('stations_reported')} stations")

    print()
    print("  RESPONSIVENESS  (/api/health probed every 0.5 s throughout)")
    print("  " + "-" * 74)
    for label, key in (("whole run", "probe_overall"),
                       ("during repair", "probe_during_repair")):
        p = n.get(key)
        if not p:
            continue
        p95 = f"{p['p95_ms']} ms" if p["p95_ms"] is not None else "n/a (<20 samples)"
        print(f"    {label:<18} {p['requests']:>4} req  {p['failed']} failed   "
              f"p50 {p['p50_ms']} ms   p95 {p95}   max {p['max_ms']} ms")

    res = n.get("resources") or {}
    print()
    print("  RESOURCES")
    print("  " + "-" * 74)
    if res.get("sampled"):
        print(f"    CPU peak  {res.get('cpu_peak_pct')} %")
        print(f"    RSS peak  {res.get('rss_peak_mb')} MB   "
              f"final {res.get('rss_final_mb')} MB")
    else:
        print(f"    not sampled — {res.get('reason')}")
    print()


# ── commands ────────────────────────────────────────────────────────────────

def _load_env() -> dict:
    env = dict(os.environ)
    dotenv = ROOT / ".env"
    if dotenv.exists():
        for line in dotenv.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), v.strip())
    return env


def cmd_local(args) -> int:
    """Spawn a backend on this machine and measure it from the outside."""
    env = _load_env()
    env["PYTHONUNBUFFERED"] = "1"

    scratch = None
    if args.broken:
        # Measure against a COPY, so a known-bad store stays known-bad and the
        # whole scenario can be re-run. Repairing the real store would spend the
        # fixture to get one measurement.
        from backend.backfill import db                        # noqa: PLC0415
        source = db.db_path()
        scratch = ROOT / ".tmp" / "bench_store.db"
        scratch.parent.mkdir(parents=True, exist_ok=True)
        for side in ("", "-wal", "-shm"):
            p = scratch.with_name(scratch.name + side)
            if p.exists():
                p.unlink()
        print(f"  copying {source.name} -> {scratch} (the original is not touched)")
        conn = sqlite3.connect(str(source))
        conn.execute("VACUUM INTO ?", (str(scratch),))
        conn.close()
        env["AREE_DB_PATH"] = str(scratch)

    log_path = ROOT / ".tmp" / "bench_uvicorn.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log = log_path.open("w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.api.main:api",
         "--port", str(args.port), "--log-level", "info"],
        cwd=str(ROOT), env=env, stdout=log, stderr=subprocess.STDOUT)

    try:
        run = measure(f"http://127.0.0.1:{args.port}", args.timeout, proc=proc)
        render(run, f"local, port {args.port}"
                    + (" (copy of a known-bad store)" if args.broken else ""))
        if args.json:
            Path(args.json).write_text(
                json.dumps({"marks": run.marks, "notes": run.notes}, indent=2,
                           default=str), encoding="utf-8")
            print(f"  written: {args.json}\n")
        print(f"  server log: {log_path}\n")
    finally:
        proc.terminate()
        try:
            proc.wait(10)
        except Exception:                                      # noqa: BLE001
            proc.kill()
        log.close()
        if scratch and not args.keep:
            _remove_scratch(scratch)
    return 0


def _remove_scratch(scratch: Path) -> None:
    """Delete the scratch store, tolerating Windows' lingering file handle.

    The child process has exited by the time this runs, but Windows can hold the
    handle open a moment longer and `unlink` raises WinError 32. Retrying briefly
    is the fix; leaving a 155 MB file behind on the last attempt is not worth an
    exception, so it degrades to a warning.
    """
    for attempt in range(10):
        try:
            for side in ("", "-wal", "-shm"):
                q = scratch.with_name(scratch.name + side)
                if q.exists():
                    q.unlink()
            return
        except PermissionError:
            time.sleep(0.3 * (attempt + 1))
    print(f"  note: could not remove {scratch} (still locked); "
          f"it will be overwritten on the next run")


def cmd_url(args) -> int:
    """Measure an already-running backend, local or deployed.

    For a deployed target the clock starts when this tool does, not when the
    container did, so the milestone column is "time from first contact" rather
    than "time from boot" unless the restart is triggered alongside it.
    """
    if not args.url:
        print("  --url is required for this command\n", file=sys.stderr)
        return 2
    run = measure(args.url, args.timeout)
    render(run, args.url)
    if args.json:
        Path(args.json).write_text(
            json.dumps({"marks": run.marks, "notes": run.notes}, indent=2,
                       default=str), encoding="utf-8")
        print(f"  written: {args.json}\n")
    return 0


COMMANDS = {"local": cmd_local, "url": cmd_url}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Measure an AREE cold start end to end.")
    p.add_argument("command", choices=sorted(COMMANDS))
    p.add_argument("--url", help="base URL for `url`")
    p.add_argument("--port", type=int, default=8130, help="port for `local`")
    p.add_argument("--broken", action="store_true",
                   help="`local`: run against a copy of the store, so a "
                        "known-bad one survives the measurement")
    p.add_argument("--keep", action="store_true",
                   help="`local --broken`: keep the copy afterwards")
    p.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    p.add_argument("--json", help="also write the raw result here")
    args = p.parse_args(argv)

    sys.path.insert(0, str(ROOT))
    return COMMANDS[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
