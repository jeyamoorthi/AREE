"""
The three scientific suites, run under pytest.

WHY THESE ARE WRAPPED RATHER THAN REWRITTEN
    `tests_grap`, `tests_contract` and `tests_temporal` are self-contained
    modules with a `main()` that prints detailed diagnostics and returns an exit
    code. They encode a lot of domain judgement — GRAP band boundaries, the shape
    contract between two engines, the temporal-integrity rules and their
    exclusions.

    Converting them into granular pytest tests would mean rewriting that
    judgement, and a rewrite that drops one assertion loses exactly the thing the
    suite existed to protect. The GRAP suite in particular exists because the two
    stage tables once disagreed and 71 stations advertised a stage CAQM had not
    invoked; nothing about that is worth re-deriving for tidier output.

    So they run as-is. Each becomes one pytest test, and their own output is what
    a failure shows — which is more informative than a rewritten assertion would
    be, because they were written to explain themselves.

    They remain runnable standalone (`python -m backend.tests_grap`), so this
    wrapper adds a runner without taking one away.

WHAT IS LOST BY WRAPPING
    Granularity. A failure says "the temporal suite failed" and then prints which
    check inside it broke, rather than pytest naming the check directly. That is
    an acceptable trade for not touching working domain logic during a test-
    infrastructure phase.
"""

from __future__ import annotations

import io
import contextlib

import pytest


def _run(module_name: str, argv=None) -> tuple[int, str]:
    """Run a suite's main() and capture what it printed."""
    import importlib

    module = importlib.import_module(module_name)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = module.main(argv) if argv is not None else module.main()
    return code, buffer.getvalue()


def test_grap_tables_agree():
    """
    The observed path (config.GRAP_STAGES) and the predictive path
    (predictive_engine.GRAP_BY_AQI) must map every AQI to the same stage.

    A regulatory stage that depends on which function you asked is worse than
    either answer alone.
    """
    code, output = _run("backend.tests_grap")
    assert code == 0, "GRAP tables disagree:\n" + output


def test_engine_shape_contract():
    """
    Direct mode must publish the same keys app.py declares.

    Several routes pass engine state to the client unvalidated, so a key the
    fallback spells differently does not fail a schema and return a clean 400 —
    it reaches the browser and crashes the component reading it.
    """
    code, output = _run("backend.tests_contract")
    assert code == 0, "the two engines' shapes have diverged:\n" + output


def test_temporal_integrity(live_server):
    """
    Nothing observed may postdate `as_of`; replay must be deterministic; live and
    replay must have the same shape; all four states must be presentable.

    Needs a running server because it checks the API's payloads, not the
    functions behind them. Live-mode checks inside it degrade on their own when
    upstream observations are stale.
    """
    code, output = _run("backend.tests_temporal", argv=["--url", live_server])
    assert code == 0, "temporal integrity broken:\n" + output
