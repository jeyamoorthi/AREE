"""API route modules. Each router is mounted under /api by api.main."""

from . import (  # noqa: F401
    advisory,
    ai,
    aqi,
    carbon,
    cases,
    dashboard,
    escalations,
    forecast,
    grap,
    outlook,
    policy,
    reports,
    risk,
    stations,
    system,
    ventilation,
)

ROUTERS = [
    system.router,
    dashboard.router,
    stations.router,
    aqi.router,
    risk.router,
    grap.router,
    forecast.router,
    advisory.router,
    ai.router,
    carbon.router,
    escalations.router,
    # Human authority: the approve/reject half of the decision chain.
    cases.router,
    policy.router,
    reports.router,
    # PS 26082 forecast layer. Mounted last, and deliberately free of the
    # Pathway engine dependency so it stays available on Windows.
    ventilation.router,
    # The AREE outlook: one endpoint composing forecast, cause, risk and
    # decision. Engine-independent for the same reason - a demonstration must
    # not be one import away from being dead.
    outlook.router,
]
