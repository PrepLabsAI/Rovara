#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
EVIDENCE=${CONTAINED_CLI_LANES_EVIDENCE_DIR:-/Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task6-cli-lanes-luna-20261014/run-logs}
NODE=/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin/node

if [ ! -d "$EVIDENCE" ] || [ -L "$EVIDENCE" ]; then
  echo "UNAVAILABLE: CLI lanes evidence directory must already exist outside TMPDIR" >&2
  exit 2
fi
if [ -z "${TMPDIR:-}" ] || [ ! -d "$TMPDIR" ] || [ -L "$TMPDIR" ] || [ -n "$(find "$TMPDIR" -mindepth 1 -print -quit)" ]; then
  echo "UNAVAILABLE: TMPDIR must be an existing, empty, non-symlink directory before Vitest starts" >&2
  exit 2
fi
TMP_OWNER=$(stat -f '%u' "$TMPDIR" 2>/dev/null || stat -c '%u' "$TMPDIR")
if [ "$TMP_OWNER" != "$(id -u)" ]; then
  echo "UNAVAILABLE: TMPDIR is not owned by the current user" >&2
  exit 2
fi
TMP_REAL=$(CDPATH= cd -- "$TMPDIR" && pwd -P)
EVIDENCE_REAL=$(CDPATH= cd -- "$EVIDENCE" && pwd -P)
case "$EVIDENCE_REAL/" in "$TMP_REAL/"*) echo "UNAVAILABLE: evidence directory must be outside TMPDIR" >&2; exit 2 ;; esac
if [ ! -x "$NODE" ] || [ "$($NODE --version)" != "v22.23.2" ] || [ "$($NODE -p 'process.execPath')" != "$NODE" ]; then
  echo "UNAVAILABLE: exact pinned Node v22.23.2 is unavailable" >&2
  exit 2
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOG="$EVIDENCE/$STAMP-loop-publication-context.log"
cat >"$EVIDENCE/$STAMP-loop-publication-context.meta" <<EOF
node=$NODE
node_version=$($NODE --version)
exec_path=$($NODE -p 'process.execPath')
argv=[$NODE,node_modules/vitest/vitest.mjs,run,tests/contract/loop-cli.test.ts,tests/contract/loop-codex.test.ts,tests/contract/loop-contribute.test.ts,tests/contract/loop-daemon.test.ts,tests/contract/loop-enrollment-cli.test.ts,tests/contract/loop-full.test.ts,tests/contract/loop-publication-context.test.ts,tests/contract/loop-publication.test.ts,tests/contract/loop-pulls.test.ts,tests/contract/loop-quick.test.ts,tests/contract/loop-review.test.ts,tests/contract/loop-reviews.test.ts,tests/contract/loop-runtime.test.ts,--reporter=verbose]
tmpdir=$TMP_REAL
tmpdir_owner=$TMP_OWNER
cwd=$ROOT
EOF
cd "$ROOT"
set +e
"$NODE" node_modules/vitest/vitest.mjs run \
  tests/contract/loop-cli.test.ts tests/contract/loop-codex.test.ts tests/contract/loop-contribute.test.ts \
  tests/contract/loop-daemon.test.ts tests/contract/loop-enrollment-cli.test.ts tests/contract/loop-full.test.ts tests/contract/loop-publication-context.test.ts \
  tests/contract/loop-publication.test.ts tests/contract/loop-pulls.test.ts tests/contract/loop-quick.test.ts \
  tests/contract/loop-review.test.ts tests/contract/loop-reviews.test.ts tests/contract/loop-runtime.test.ts \
  --reporter=verbose >"$LOG" 2>&1
STATUS=$?
set -e
cat "$LOG"
exit "$STATUS"
