#!/bin/sh
set -eu
umask 077
config=${PLUHUB_CONFIG:-/data/pluhub.json}
mkdir -p "$(dirname -- "$config")"
exec flock --exclusive --nonblock --conflict-exit-code 75 --no-fork "$config.lock" bun /opt/pluhub/deploy/docker/entrypoint.mjs "$@"
