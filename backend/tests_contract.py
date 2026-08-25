"""
Contract check: does direct mode expose the same shapes as the Pathway engine?

WHY THIS EXISTS
    Several routes pass engine state to the client UNVALIDATED - the dashboard
    does to_jsonable(engine.carbon_state()) with no schema in between. A key
    the fallback spells differently therefore does not fail a Pydantic model
    and return a clean 400; it reaches the browser and crashes the component
    that reads it.

    That is exactly how the National Overview broke: carbon_state carried
    emissions_kg/energy_kwh where the UI expected total_gco2/decision_count,
    every route returned HTTP 200, and the page threw
    "Cannot read properties of undefined (reading 'toLocaleString')".

    Checking status codes is not checking a contract. This compares the keys
    the fallback publishes against the keys app.py declares, without importing
    Pathway - the declarations are parsed out of the source.

Run:  python -m backend.tests_contract
"""

from __future__ import annotations

import ast
import pathlib
import sys

BACKEND = pathlib.Path(__file__).resolve().parent


def declared_dict_keys(source: pathlib.Path, name: str) -> set[str] | None:
    """
    Keys of a module-level dict literal, read from source.

    Parsed rather than imported because importing app.py pulls in Pathway,
    which is the entire reason the fallback exists.
    """
    tree = ast.parse(source.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == name:
                    if isinstance(node.value, ast.Dict):
                        return {
                            k.value for k in node.value.keys
                            if isinstance(k, ast.Constant)
                        }
        if isinstance(node, ast.AnnAssign):
            if isinstance(node.target, ast.Name) and node.target.id == name:
                if isinstance(node.value, ast.Dict):
                    return {
                        k.value for k in node.value.keys
                        if isinstance(k, ast.Constant)
                    }
    return None


def main() -> int:
    app_py = BACKEND / "app.py"
    fb_py = BACKEND / "fallback_engine.py"

    failures = []

    real = declared_dict_keys(app_py, "carbon_state")
    fake = declared_dict_keys(fb_py, "carbon_state")
    print("carbon_state")
    print(f"  streaming : {sorted(real or [])}")
    print(f"  direct    : {sorted(fake or [])}")
    if real and fake:
        missing = real - fake
        if missing:
            failures.append(f"carbon_state missing keys in direct mode: {sorted(missing)}")
            print(f"  MISSING   : {sorted(missing)}")
        else:
            print("  OK - direct mode publishes every key the streaming engine does")

    # The attributes api/engine.py reads off whichever module is loaded.
    required_attrs = ["latest_state", "carbon_state", "escalation_log",
                      "aqi_history", "_multi_window_cache"]
    import importlib
    sys.path.insert(0, str(BACKEND))
    fb = importlib.import_module("fallback_engine")
    print("\nmodule attributes required by api/engine.py")
    for attr in required_attrs:
        ok = hasattr(fb, attr)
        print(f"  {'OK  ' if ok else 'FAIL'} {attr}")
        if not ok:
            failures.append(f"fallback_engine is missing {attr}")

    print()
    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("ALL CONTRACT CHECKS PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
