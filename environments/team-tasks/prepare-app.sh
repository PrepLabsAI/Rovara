#!/bin/sh
set -eu
test "$#" -eq 1
test "$(git rev-parse HEAD)" = "$1" || { echo 'BASE_MISMATCH' >&2; exit 1; }
test -z "$(git status --porcelain)" || { echo 'DIRTY_BASE' >&2; exit 1; }
test "$(node --version)" = v24.19.0
test "$(python3.12 --version)" = 'Python 3.12.14'
test "$(uv --version)" = 'uv 0.12.5 (aarch64-unknown-linux-gnu)'
if test ! -d .venv; then python3.12 -m venv --copies .venv; fi
uv sync --frozen --python 3.12.14
npm --prefix app/web ci --ignore-scripts --include=dev
