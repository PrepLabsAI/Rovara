#!/bin/sh
# The CI-like command: unit tests, then the team's eval gate, both offline against the in-repo fake Vertex.
set -eu
cd "$(dirname "$0")/.."
export PYTHONDONTWRITEBYTECODE=1 DESKBOT_FAKE_VERTEX=1
python3 -m unittest discover -s tests -t . -v
python3 evals/run.py --gate
