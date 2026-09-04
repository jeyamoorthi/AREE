# AREE backend — FastAPI over the direct engine.
#
# WHAT CHANGED AND WHY
#   This image used to install PyTorch explicitly and pull poppler/OCR system
#   libraries, because requirements.txt declared the Pathway + sentence-
#   transformers + unstructured stack. None of that is on the served path: the
#   direct engine is the production engine (see backend/api/engine.py), and the
#   runtime dependency set was reduced to the ten packages it actually imports.
#
#   Installing torch here now costs roughly 800 MB for code nothing imports.
#   It is gone. So are build-essential, git and poppler-utils, which existed for
#   the OCR/document stack.
#
#   To run the Pathway engine instead, build with
#   --build-arg INSTALL_STREAMING=1 and set AREE_ENGINE_MODE=streaming. Those
#   pins are UNVERIFIED (backend/requirements-streaming.txt says so); expect
#   dependency-resolution work.

FROM python:3.13-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# curl is kept only because the container healthcheck uses it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY backend/requirements.txt backend/requirements-streaming.txt ./backend/
ARG INSTALL_STREAMING=0
RUN pip install --upgrade pip \
    && pip install -r backend/requirements.txt \
    && if [ "$INSTALL_STREAMING" = "1" ]; then \
         echo "installing the UNVERIFIED streaming stack" && \
         pip install -r backend/requirements-streaming.txt ; \
       fi

COPY . .

# THE STORE.
#
# data/aree.db is 148 MB and gitignored, so it is neither in the repository nor
# in this image. The container mounts a volume at /app/data and the entrypoint
# seeds it, on first run only, from the committed 1 MB test fixture — which
# carries exactly the three replay moments the demo uses.
#
# That means a fresh deployment can replay 02 Nov 2024 immediately, and the live
# view fills in as the hourly capture accumulates observations. Baking 148 MB
# into the image would make it slow to ship and stale the moment it was built.
RUN mkdir -p /app/data

# Run as a non-root user. The image writes to /app/data (the store) and
# /app/backend/policies (uploads), so those are the only paths it needs.
RUN useradd --create-home --uid 10001 aree \
    && chown -R aree:aree /app/data /app/backend/policies
USER aree

ENV AREE_ENGINE_MODE=direct \
    AREE_DB_PATH=/app/data/aree.db \
    PORT=8000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["sh", "-c", "uvicorn backend.api.main:api --host 0.0.0.0 --port ${PORT}"]
