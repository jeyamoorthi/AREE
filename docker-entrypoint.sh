#!/bin/sh
# Seed the store on first run, then hand over to the real command.
#
# WHY A SEED STEP EXISTS
#   data/aree.db is 148 MB and gitignored, so it is in neither the repository nor
#   the image. A fresh container therefore starts with an empty volume, and an
#   empty store means the replay presets — the demo — have nothing to replay.
#
#   backend/tests/fixtures/aree_test.db is 1 MB, committed, and carries exactly
#   the three replay moments (02 / 14 / 16 Nov 2024). Copying it in on first run
#   gives a deployment that can replay immediately, while the live view fills in
#   as the hourly capture accumulates observations.
#
#   It is copied ONLY when the target does not exist. A restart must never
#   overwrite a store that has been accumulating real observations.

DB_PATH="${AREE_DB_PATH:-/app/data/aree.db}"
DB_DIR="$(dirname "$DB_PATH")"
SEED="/app/backend/tests/fixtures/aree_test.db"

echo "entrypoint: user=$(id -u):$(id -g)  store=$DB_PATH  port=${PORT:-8000}"

# NOT `set -e`.
#
# A managed platform mounts its persistent disk over $DB_DIR, and the mount may
# arrive owned by root while this container runs as uid 10001. Under `set -e` the
# first failed mkdir or cp would abort the script, the container would exit
# before uvicorn ever ran, and the platform would report only a numeric exit
# code — which says nothing about a permission problem on a mount.
#
# So every step below is checked and explained instead. A store problem must not
# be able to stop the API from starting and reporting what is wrong.
mkdir -p "$DB_DIR" 2>/dev/null || true

if [ ! -w "$DB_DIR" ]; then
    echo "entrypoint: ERROR $DB_DIR is not writable by uid $(id -u)."
    echo "entrypoint:   ls -ld: $(ls -ld "$DB_DIR" 2>/dev/null)"
    echo "entrypoint:   A persistent disk mounted here is probably owned by root."
    echo "entrypoint:   Fix: mount the disk somewhere this user owns, run the"
    echo "entrypoint:   container as root, or chown the mount to uid 10001."
    echo "entrypoint: continuing so the API can start and report the failure."
elif [ ! -f "$DB_PATH" ]; then
    if [ -f "$SEED" ]; then
        echo "entrypoint: no store at $DB_PATH — seeding from the committed fixture"
        if cp "$SEED" "$DB_PATH" 2>/dev/null; then
            echo "entrypoint: seeded ($(wc -c < "$DB_PATH") bytes). Replay works now;"
            echo "entrypoint: live forecasting needs ~24 h of capture to accumulate."
        else
            echo "entrypoint: ERROR could not copy the seed into $DB_PATH"
        fi
    else
        echo "entrypoint: WARNING no store and no seed fixture found."
        echo "entrypoint: the API will start, but forecasts will be unavailable."
    fi
else
    echo "entrypoint: using the existing store at $DB_PATH ($(wc -c < "$DB_PATH") bytes)"
fi

if [ -z "$AREE_JWT_SECRET" ]; then
    echo "entrypoint: WARNING AREE_JWT_SECRET is unset — tokens will not survive a restart."
fi
if [ -z "$AREE_OPERATORS" ]; then
    echo "entrypoint: WARNING AREE_OPERATORS is unset — demo operators will be"
    echo "entrypoint: generated with random passwords and printed below."
fi

exec "$@"
