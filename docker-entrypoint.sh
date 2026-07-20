#!/bin/sh
# Runs as root at container start (see Dockerfile: no USER directive at the
# runtime stage's end anymore). Railway mounts attached volumes owned by
# root regardless of what the image's USER is — a real, live-caught bug:
# the worker's /data volume rejected writes from appuser with EACCES on
# every job, since the image-build-time `chown` only affects the baked-in
# /app/data path, not a volume mounted fresh at container start.
#
# Fix: chown the actual runtime DATA_DIR here (root can always chown),
# then drop privileges to appuser via setpriv before exec'ing the real
# start command, preserving argv exactly (no string re-quoting) and
# forwarding signals correctly (the `exec` replaces this shell process,
# so SIGTERM still reaches node directly for the app's graceful-shutdown
# handlers in src/api/index.ts / src/worker/index.ts).
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"
chown -R appuser:nodejs "$DATA_DIR"

exec setpriv --reuid=appuser --regid=nodejs --init-groups "$@"
