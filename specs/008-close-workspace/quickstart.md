# Quickstart: Validate Slack Workspace Closure

## Prerequisites

- Node.js 22 and dependencies installed with `npm ci`.
- No live AWS account is required for the automated checks.

## Automated validation

```sh
npm run typecheck
npm run lint
npm test
npm run infra:synth
```

The focused suites cover:

- close-command recognition before workspace creation;
- clean and dirty worker preflight results;
- broker fencing, thread isolation, callbacks, deletion, retries, quota release, and tombstones;
- Slack progress, blocked, failed, successful, repeated, and later-message responses;
- synthesized delete-session IAM permission.

## End-to-end local scenario

1. Create a thread workspace through the existing hosted Slack test harness and mark preparation complete.
2. Send `close this workspace` from the owning thread.
3. Observe a close preflight operation and no orchestrator model turn.
4. Complete the worker callback with `safeToClose: true`.
5. Verify one capacity-provider session deletion, `CLOSED` workspace state, decremented quotas, removed Slack conversation state, and a completion post in the same thread.
6. Send an ordinary follow-up in the same thread and verify no new workspace or worker operation is created.

Repeat with an untracked file and a local-only commit. The expected result is a Slack block message and retained workspace storage.

## Live verification boundary

Automated tests prove local behavior with fakes. After an authorized deployment, verify in a disposable Slack thread and confirm in AgentCore that the capacity-provider session and EBS volume no longer exist. Record the deployed commit and redacted session identifiers before claiming live AWS verification.

## Local validation evidence

Validated on 2026-09-24 from `feature/024-close-workspace`:

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm test` — 44 files and 253 tests passed.
- `npm run infra:synth` — passed; synthesized the close-session IAM permission. The existing CloudFormation warning about the GitHub private-key secret ARN parameter remains unchanged.
- Focused close validation — 5 files and 68 tests passed, including contracts, worker Git inspection, Slack processing, broker lifecycle, retry behavior, and infrastructure.

No live Slack or AWS resource deletion was performed. Live verification remains a post-deployment step.
