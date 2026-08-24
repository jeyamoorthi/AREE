"""API route modules. Each router is mounted under /api by api.main."""

from . import (  # noqa: F401
    advisory,
    ai,
    aqi,
    carbon,
    dashboard,
    escalations,
    forecast,
    grap,
    policy,
    reports,
    risk,
    stations,
    system,
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
    policy.router,
    reports.router,
]
