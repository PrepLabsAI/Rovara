# Golden fixtures — conformance suite inputs

Each fixture directory is a self-contained miniature project plus a `task.json`
manifest. The conformance harness (PLAN.md Phase 1) copies the project files into
a fresh git repo (initial commit on `main`), runs the task through `agentx-runner`
with a pinned model, and applies the oracle to the branch the engine produced.

## `task.json` manifest

```json
{
  "name": "fixture-failing-test",
  "mode": "quick",                    // "quick" | "spec"
  "instructions": "<the task, as a user would phrase it in Slack>",
  "oracle": { ... }                   // one of the oracle types below
}
```

## Oracle types

| type | Meaning |
|---|---|
| `pytest` | Run `command` in the produced branch; exit 0 = pass. |
| `pytest_hidden` | Copy `tests_dir` (excluded from the workspace the agent sees) into the branch, then run `command`; exit 0 = pass. Guards against the agent gaming visible tests. |
| `spec_review` | Spec-mode fixture: the emitted spec is checked against `expect` (human review in Phase 1; heuristics/LLM-judge later). |

## Rules

- The `oracle/` directory of a fixture is **never** copied into the agent's
  workspace — it's the hidden grading key.
- Fixtures are test *data*: intentionally buggy code is expected, so they're
  excluded from repo-wide lint/type-check (`fixtures` in ruff's exclude) and
  from pytest collection (`testpaths` doesn't include them).
- Keep fixtures tiny. They're graded on behavior, not realism; every extra file
  slows down each conformance run.
