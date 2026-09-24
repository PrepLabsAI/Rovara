# Contract: Presentation Snapshot and Replay Evaluation

## Tier 1: presentation snapshot (CI)

`tests/contract/tool-presentation.test.ts` builds the orchestrator tool set and system prompt for
fixture projects from recorded vendor catalogs and snapshots, per project: names in order,
assembled descriptions, schemas, manifest text and tool count. It fails on budget violations and
on descriptions over 2,048 characters. A presentation change is reviewed as a snapshot diff.

## Tier 2: model replay (on demand)

`npm run eval -- [--model <id>] [--repeat 3]` requires Bedrock credentials. Cases live in
`tests/eval/cases/*.jsonl`, one per line:

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

The runner constructs the real orchestrator with a recording API that returns canned results and
executes nothing. For each case it records the first tool call, or none. Scores:

- **Tool accuracy**: first tool matches `expect.tool` (`null` means no tool).
- **Argument match**: `argsSubset` is a subset of the arguments.
- **Refusal accuracy**: for `tool: null` cases, the response contains the `refusal` phrase.

Each case runs `--repeat` times; a case passes when every run passes. Results are written to
`tests/eval/results/<model>.json` and compared with `tests/eval/baseline/<model>.json`; the command
exits non-zero on a regression of more than one case.

## Seed cases

The six prompts from the bound test channel's threads (2026-09-22 to 2026-09-24) that exposed wrong
or empty answers, plus at least 20 synthetic cases covering: files versus issues versus pull
requests; each pull-request action; each connector's read and write; a not-connected connector;
"close this issue" versus workspace closure; and an out-of-scope request. New cases come from
`agentx admin turns export`.

## Before-and-after measurement

The pre-change presentation is kept as a fixture mode (`--presentation legacy`) until SC-004 is
recorded in `quickstart.md`, then removed.
