#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
NODE=${PLUHUB_NODE_LINUX:-node}
if [ -f "$ROOT/output/go-echo-linux" ]; then export PLUHUB_GO_ECHO="$ROOT/output/go-echo-linux"; fi
export PATH="$(dirname -- "$NODE"):$PATH"
"$NODE" --version
if [ -n "${PLUHUB_PNPM_CLI:-}" ]; then "$NODE" "$PLUHUB_PNPM_CLI" test; else "$NODE" node_modules/vitest/vitest.mjs run; fi
"$NODE" scripts/bench.mjs
cd ../PluHub-Plugins
if [ -n "${PLUHUB_PNPM_CLI:-}" ]; then "$NODE" "$PLUHUB_PNPM_CLI" test; else "$NODE" node_modules/vitest/vitest.mjs run; fi
cd "$ROOT"
cd ../PluHub-Spec
"$NODE" --test tests/schema.test.mjs
"$NODE" scripts/check-compat.mjs
cd ../PluHub-SDK-Go
if [ -f "$ROOT/output/go-sdk-linux.test" ]; then "$ROOT/output/go-sdk-linux.test" -test.v; else go test ./...; fi
