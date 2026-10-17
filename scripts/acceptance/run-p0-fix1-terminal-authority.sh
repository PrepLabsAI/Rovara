#!/bin/sh
set -eu

if [ -z "${TMPDIR:-}" ] || [ -z "${CONTAINED_FOUNDATION_EVIDENCE_DIR:-}" ]; then
  echo "UNAVAILABLE: TMPDIR and CONTAINED_FOUNDATION_EVIDENCE_DIR are required before Vitest starts" >&2
  exit 2
fi
if [ ! -d "$TMPDIR" ] || [ -L "$TMPDIR" ] || [ -n "$(find "$TMPDIR" -mindepth 1 -print -quit)" ]; then
  echo "UNAVAILABLE: TMPDIR must be an existing, empty, owned directory" >&2
  exit 2
fi
TMP_OWNER=$(stat -f '%u' "$TMPDIR" 2>/dev/null || stat -c '%u' "$TMPDIR")
if [ "$TMP_OWNER" != "$(id -u)" ]; then
  echo "UNAVAILABLE: TMPDIR is not owned by the current user" >&2
  exit 2
fi
if [ ! -d "$CONTAINED_FOUNDATION_EVIDENCE_DIR" ] || [ -L "$CONTAINED_FOUNDATION_EVIDENCE_DIR" ]; then
  echo "UNAVAILABLE: contained evidence directory must be pre-created outside TMPDIR" >&2
  exit 2
fi
TMPDIR_REAL=$(cd "$TMPDIR" && pwd -P)
EVIDENCE_REAL=$(cd "$CONTAINED_FOUNDATION_EVIDENCE_DIR" && pwd -P)
case "$EVIDENCE_REAL/" in "$TMPDIR_REAL/"*) echo "UNAVAILABLE: evidence must be outside TMPDIR" >&2; exit 2 ;; esac
NODE=/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin/node
if [ ! -x "$NODE" ] || [ "$("$NODE" --version)" != "v22.23.2" ] || [ "$("$NODE" -p 'process.execPath')" != "$NODE" ]; then
  echo "UNAVAILABLE: exact pinned Node v22.23.2 is unavailable" >&2
  exit 2
fi
command -v docker >/dev/null 2>&1 || { echo "UNAVAILABLE: Docker CLI is unavailable" >&2; exit 2; }
IMAGE='node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9'
IMAGE_INFO=$(docker image inspect "$IMAGE" --format '{{.RepoDigests}} {{.Os}} {{.Architecture}}' 2>/dev/null) || {
  echo "UNAVAILABLE: pinned Docker image is unavailable locally; this command never pulls images" >&2
  exit 2
}
case "$IMAGE_INFO" in *"$IMAGE"*' linux arm64'*) ;; *) echo "UNAVAILABLE: local pinned Docker image identity or platform does not match" >&2; exit 2 ;; esac
exec "$NODE" node_modules/vitest/vitest.mjs run tests/e2e/project-setup-terminal-authority-fix1.test.ts --reporter=verbose
