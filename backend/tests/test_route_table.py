"""
Route-table integrity.

Migrated from `backend/tests_routes.py`.

A helper function was once inserted between `@router.get("/aree/outlook")` and
the `def outlook(...)` it was meant to decorate. Python applied the decorator to
the helper, so the primary endpoint was served by a function expecting a database
connection and answered 422 to every request, while `outlook()` became an
ordinary function no URL reached. Every suite stayed green.

Checking that a path *exists* would not have caught it — the path did exist. So
the handler name is part of the assertion.

It reads `api.openapi()` rather than walking `api.routes`, because this FastAPI
version stores included routers as lazy `_IncludedRouter` wrappers: the obvious
implementation sees 2 routes out of 33 and passes by accident, which is the same
failure mode it exists to prevent. The first version of the guard made exactly
that mistake.
"""

from __future__ import annotations

import pytest

# path -> the handler that must serve it.
EXPECTED = {
    ("get", "/api/aree/outlook"): "outlook",
    ("get", "/api/cases"): "list_cases",
    ("get", "/api/cases/{case_id}"): "get_case",
    ("post", "/api/cases/{case_id}/decision"): "decide",
    ("post", "/api/auth/token"): "token",
    ("get", "/api/auth/whoami"): "whoami",
    ("get", "/api/auth/config"): "config",
    ("post", "/api/policy/upload"): "upload_policy",
    ("get", "/api/health"): "health",
    ("get", "/api/system/status"): "system_status",
    ("get", "/api/ventilation/current"): "current",
    ("get", "/api/reports/{station}/pdf"): "report_pdf",
}

# A request parameter can only come from the path, the query string, a body or a
# dependency. These names are internal plumbing; one appearing in the public
# contract means a helper was decorated by accident.
NEVER_A_REQUEST_PARAM = {"conn", "state", "engine"}


@pytest.fixture(scope="module")
def paths(api):
    return api.openapi()["paths"]


@pytest.mark.parametrize("method,path,handler",
                         [(m, p, h) for (m, p), h in sorted(EXPECTED.items())])
def test_endpoint_is_served_by_the_intended_handler(paths, method, path, handler):
    entry = paths.get(path, {}).get(method)
    assert entry is not None, f"{method.upper()} {path} is not served at all"
    # FastAPI's default operationId is "<handler>_<path>_<method>".
    operation = entry.get("operationId", "")
    assert operation.startswith(f"{handler}_"), (
        f"{method.upper()} {path} is served by '{operation}', expected handler "
        f"'{handler}' — a decorator is attached to the wrong function")


def test_no_endpoint_exposes_internal_plumbing(paths):
    leaked = []
    for path, methods in paths.items():
        for method, entry in methods.items():
            for param in entry.get("parameters", []) or []:
                if param.get("name") in NEVER_A_REQUEST_PARAM:
                    leaked.append(f"{method.upper()} {path} -> {param['name']} "
                                  f"(in: {param.get('in')})")
    assert not leaked, "internal parameters reached the public contract: " + str(leaked)


def test_the_route_table_is_not_suspiciously_small(paths):
    """Guards the guard: an empty schema would pass every check above."""
    assert len(paths) >= 25, (
        f"only {len(paths)} paths in the schema — the route table is probably "
        f"not being read correctly")
