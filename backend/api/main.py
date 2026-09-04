"""AREE API — FastAPI layer in front of the existing Pathway engine.

Run from the project root:

    uvicorn backend.api.main:api --reload --port 8000

The engine (Pathway pipeline, ingestion, RAG, LLM) is imported once in a
background thread at startup so the HTTP server answers immediately while the
streaming pipeline warms up.
"""

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import capture_scheduler, engine, ws
from .routes import ROUTERS
from .schemas import HealthResponse

API_VERSION = "2.2.0"
API_PREFIX = "/api"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
log = logging.getLogger("aree.api")


def _start_engine_background() -> None:
    def _load():
        log.info("Loading AREE engine (Pathway pipeline, ingestion, RAG)...")
        ok = engine.load_engine()
        if ok:
            # Was an unconditional "Streaming pipeline is running", printed verbatim
            # while the direct engine was doing the work and Pathway had never loaded.
            st = engine.status()
            if st.get("mode") == "streaming":
                log.info("AREE engine loaded. Pathway streaming pipeline is running.")
            else:
                log.info("AREE engine loaded in DIRECT mode (production path): "
                         "interval sampling, no event-time windowing, no policy "
                         "retrieval, no FIRMS poll. Selected: %s",
                         st.get("engine_selection")
                         or ("fell back after streaming failed: "
                             + str(st.get("pathway_error"))))
        else:
            st = engine.status()
            log.error("AREE engine failed to load: %s: %s",
                      st.get("error_type"), st.get("error"))

    threading.Thread(target=_load, name="aree-engine-loader", daemon=True).start()


@asynccontextmanager
async def lifespan(app: FastAPI):
    _start_engine_background()
    # The live forecast needs observed PM2.5 lags out to 24 h. Capturing them was a
    # separate process someone had to remember to run, and when it stopped the hero
    # screen answered 424 while replay carried on working - so it is in here now.
    capture_scheduler.start()
    yield
    capture_scheduler.stop()
    log.info("AREE API shutting down.")


api = FastAPI(
    title="AREE API",
    description=(
        "Autonomous Regulatory Escalation Engine — REST interface over the live "
        "Pathway streaming pipeline, satellite intelligence, GRAP state machine, "
        "policy RAG index and report generator."
    ),
    version=API_VERSION,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# CORS — the Next.js dev server and any configured production origin.
api.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
    ],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


# --- Structured error handling ---------------------------------------------

@api.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        body = {
            "error": detail.get("error", "http_error"),
            "detail": detail.get("detail", ""),
            "status_code": exc.status_code,
        }
        if detail.get("hint"):
            body["hint"] = detail["hint"]
        # Carry everything else the raiser attached. This used to forward only
        # error/detail/hint, so the useful half of a structured error was silently
        # dropped on the way out: `valid` on a rejected enum, `expected`/`received` on
        # a case-id mismatch, `status` on a conflict. A caller was told something was
        # wrong but not what would be right.
        for key, value in detail.items():
            if key not in ("error", "detail", "hint") and key not in body:
                body[key] = value
    else:
        body = {
            "error": "http_error",
            "detail": str(detail),
            "status_code": exc.status_code,
        }
    return JSONResponse(status_code=exc.status_code, content=body,
                        headers=getattr(exc, "headers", None))


@api.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "error": "validation_error",
            "detail": "Request parameters failed validation.",
            "status_code": 422,
            "errors": [
                {"field": ".".join(str(p) for p in e.get("loc", [])),
                 "message": e.get("msg", "")}
                for e in exc.errors()
            ],
        },
    )


@api.exception_handler(engine.EngineUnavailable)
async def engine_unavailable_handler(request: Request, exc: engine.EngineUnavailable):
    return JSONResponse(
        status_code=503,
        content={
            "error": "engine_unavailable",
            "detail": exc.detail,
            "status_code": 503,
            "hint": "The Pathway engine is not running in this process.",
        },
    )


@api.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_error",
            "detail": f"{type(exc).__name__}: {exc}",
            "status_code": 500,
        },
    )


# --- Health ----------------------------------------------------------------

@api.get(f"{API_PREFIX}/health", response_model=HealthResponse, tags=["system"],
         summary="Liveness probe — always answers, even while the engine warms up")
def health() -> HealthResponse:
    st = engine.status()
    return HealthResponse(
        status="ok",
        service="AREE API",
        version=API_VERSION,
        engine_loaded=bool(st["loaded"]),
        engine_error=st.get("error"),
    )


# --- Routes ----------------------------------------------------------------

for router in ROUTERS:
    api.include_router(router, prefix=API_PREFIX)

# Real-time event channel (Phase 17). REST remains the data path; this only
# announces changes so the UI can refresh without waiting for its next poll.
api.include_router(ws.router)


@api.get("/", include_in_schema=False)
def root():
    return {
        "service": "AREE API",
        "version": API_VERSION,
        "docs": "/docs",
        "health": f"{API_PREFIX}/health",
    }


# Alias so `uvicorn backend.api.main:app` also works.
app = api
