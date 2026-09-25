# Contract: Presentation Snapshot and Replay Evaluation

## Tier 1: presentation snapshot (CI)

`tests/contract/tool-presentation.test.ts` builds the orchestrator tool set and system prompt for
fixture projects from recorded vendor catalogs and snapshots, per project: names in order,
assembled descriptions, schemas, manifest text and tool count. It fails on budget violations and
on descriptions over 2,048 characters. A presentation change is reviewed as a snapshot diff.

## Tier 2: model replay (on demand)

`npm run eval` runs offline by default: Pi's faux provider answers each case as expected, so it
checks the cases, fixtures and harness and calls no model. `npm run eval -- --live [--model <id>]
[--provider <id>] [--repeat 3] [--update-baseline]` calls a real model and needs its credentials
(Bedrock for the default). `--model`, `--provider` and `--update-baseline` require `--live`. Run
`npm run build` first. Cases live in `tests/eval/cases/*.jsonl`, one per line:

```json
{ "id": "files-not-pr", "project": "fixtures/payments.yaml",
  "prompt": "list the top-level files in the payments-api repository",
  "expect": { "tool": "agentx_submit_task" } }
{ "id": "jira-not-connected", "project": "fixtures/github-only.yaml",
  "prompt": "what's open in Jira?",
  "expect": { "tool": null, "refusal": "not connected" } }
{ "id": "append-pr", "project": "fixtures/payments.yaml",
  "prompt": "append the new commits to PR 12 in payments-api",
  "expect": { "tool": "agentx_manage_pull_request", "argsSubset": { "action": "append", "pullRequestNumber": 12 } } }
```

Each `project` is a project definition in the registered format under `tests/eval/fixtures/`.
Connectors are resolved by the broker's connector types, and each type's recorded vendor catalog is
`tests/eval/catalogs/<type>.json`. A fixture may add an optional `eval:` key for thread state a
definition cannot express: `notConnected` (connector names whose credential is missing) and
`recoverableOperations` (unfinished operation IDs, which offer the recovery tools).

The runner constructs the real orchestrator with a recording API that returns canned results and
executes nothing. For each case it records the first tool call, or none. Scores:

- **Tool accuracy**: first tool matches `expect.tool` (`null` means no tool).
- **Argument match**: `argsSubset` is a subset of the arguments.
- **Refusal accuracy**: for `tool: null` cases, the response contains the `refusal` phrase.
- **Phrase match**: `refusal` and `contains` are scored separately and both must match; refusal
  accuracy counts only `refusal`. Matching ignores case, and curly apostrophes and quotes count as
  straight ones.

Each case runs `--repeat` times; a case passes when every run passes. Results are written to
`tests/eval/results/<model>.json` and compared with `tests/eval/baseline/<model>.json`; the command
exits non-zero on a regression of more than one case.
A live run also exits non-zero when any case errors. A run that reaches its timeout and then stops is
model behaviour: it fails its case and is counted in `summary.timeouts`, but it is not an error and
does not block a baseline. A run that does not stop within the grace period is an error. `--update-baseline` refuses to write a
baseline from a run with errors, and a malformed baseline, or one for another model, provider or
presentation, is an error.

## Seed cases

The six prompts from the bound test channel's threads (2026-09-22 to 2026-09-24) that exposed wrong
or empty answers, plus at least 20 synthetic cases covering: files versus issues versus pull
requests; each pull-request action; each connector's read and write; a not-connected connector;
"close this issue" versus workspace closure; and an out-of-scope request. New cases come from
`agentx admin turns export`.

## Jira seed cases

```json
{ "id": "jira-list-open", "project": "fixtures/payments-jira.yaml", "prompt": "what bugs are open in Jira?", "expect": { "tool": "jira__searchJiraIssuesUsingJql" } }
{ "id": "jira-read-one", "project": "fixtures/payments-jira.yaml", "prompt": "what's the status of PAY-7?", "expect": { "tool": "jira__getJiraIssue", "argsSubset": { "issueIdOrKey": "PAY-7" } } }
{ "id": "jira-create", "project": "fixtures/payments-jira.yaml", "prompt": "create a Jira bug titled Login test is flaky", "expect": { "tool": "jira__createJiraIssue", "argsSubset": { "summary": "Login test is flaky", "issueType": "Bug" } } }
{ "id": "jira-comment", "project": "fixtures/payments-jira.yaml", "prompt": "comment on PAY-12 that the fix is deployed", "expect": { "tool": "jira__addOrEditJiraIssueComment", "argsSubset": { "issueIdOrKey": "PAY-12" } } }
{ "id": "jira-vs-github", "project": "fixtures/payments-jira.yaml", "prompt": "list the open GitHub issues in payments-api", "expect": { "tool": "github__list_issues" } }
```

These cases run against a fixture project (GitHub plus a Jira connector scoped to project `PAY`,
as [docs/connectors/jira.md](../../../docs/connectors/jira.md) sets up), once
`tests/eval/cases/` exists and the fixture is added at `tests/eval/fixtures/payments-jira.yaml`.

## Before-and-after measurement

The pre-change presentation is kept as a fixture mode (`--presentation legacy`) until SC-004 is
recorded in `quickstart.md`, then removed.

The legacy presentation offers only GitHub, as before feature 013, and cannot receive an unfinished
operation's ID. A case that expects a tool of any other connector type, or whose fixture needs
`recoverableOperations`, is not applicable to it: the legacy report lists it under `notApplicable`
with a count, and never scores it as a failure. Each report carries a hash of every scored case's
definition and of the scored set. `npm run eval -- --sc004 [--model <id>]` reads the two committed
baselines, calls no model, refuses them when a shared case's hash differs, and compares the
presentations only on the cases both can express.
