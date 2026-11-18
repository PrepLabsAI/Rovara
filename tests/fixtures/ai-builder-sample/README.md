# ai-builder-sample (Deskbot)

A small stand-in for a customer's AI agent project: a customer-desk assistant that calls Gemini through a Vertex AI shaped
client, with unit tests, an eval set scored by a script, a CI-like command, and a local fake Vertex endpoint so everything
runs offline and gives the same answers every time. It exists so Rovara's eval path can be proven before a real customer's
repository is connected. Every name, address and order in it is made up.

Python 3.9 or newer. No packages to install.

| What | Where |
|---|---|
| The agent: notes lookup, system prompt, model call | `deskbot/agent.py`, `deskbot/prompts/system.txt`, `deskbot/data/policies.json` |
| The model client (Vertex AI REST, plus the Gemini API shape) | `deskbot/vertex_client.py` |
| The fake Vertex endpoint (both shapes; obeys the system prompt) | `fake_vertex/server.py` |
| Unit tests | `tests/` (`python3 -m unittest discover -s tests -t .`) |
| The eval set: 10 cases (8 ordinary, 1 safety, 1 refusal), one file each | `evals/support/cases/<id>.json` |
| The scoring rule (a script, no model grades) | `evals/support/scoring.py` |
| The eval command and its threshold (90% pass, and no safety or refusal case may fail) | `evals/run.py` |
| The CI-like command: unit tests, then the eval gate | `scripts/ci.sh` |
| Ready-made changes for demos | `changes/*.patch` (`git apply`) |

## The two demo changes

- `changes/01-friendlier-tone.patch`: rewords one prompt line. The answers change a little ("Happy to help! ..."), every
  case still passes. The unit tests and the eval stay green.
- `changes/02-simplify-prompt-regression.patch`: a "tidy-up" that swaps the privacy rule in the prompt for a debugging aid ("quote the order record exactly as given"). The unit tests
  still pass. The `privacy-email` case now leaks an address, so the team's own gate fails and Rovara's before and after
  comparison reads "Worse on eval".

## How Rovara runs the eval

Rovara runs `python3 evals/run.py --out rovara-measures.json` in a fresh check sandbox, once for the base commit and once
for the candidate. It sets `ROVARA_EVAL_SIDE` (old or new), `ROVARA_EVAL_RUNS` and `ROVARA_EVAL_IDS` (case ids, comma
separated), and for the model it sets `GOOGLE_GEMINI_BASE_URL` to its own metered route plus a placeholder key. The command
writes `rovara-measures.json` with every answer's pass or fail (`schemaVersion`, `measures`, `questions[].samples[]`).
A client built only for Vertex AI never sees that route, so for a Gemini API project `evals/run.py` picks the Gemini API shape
when `GOOGLE_GEMINI_BASE_URL` is set: same model name, same prompts, same body. For a project whose eval row is `vertex`, Rovara
sets `GOOGLE_VERTEX_BASE_URL` (what google-genai reads in Vertex mode), a placeholder `GOOGLE_CLOUD_PROJECT` and
`GOOGLE_CLOUD_LOCATION`, and `GCE_METADATA_HOST` and `GCE_METADATA_IP` (a metadata stand-in that hands out a dummy token), and
the same Vertex-shaped client calls Rovara's route with no change to its code.

## Making a private copy for a rehearsal

    cp -R <this folder> /tmp/deskbot && cd /tmp/deskbot && git init -q && git add -A && git commit -qm "Deskbot sample"
    sh scripts/ci.sh                      # expected: unit tests OK, 10 of 10 eval cases pass
    git checkout -qb tone && git apply changes/01-friendlier-tone.patch && git commit -qam "Warmer tone"
    git checkout -q main && git checkout -qb tidy && git apply changes/02-simplify-prompt-regression.patch && git commit -qam "Tidy the prompt"

(Use `master` instead of `main` where git's default branch is `master`.)
