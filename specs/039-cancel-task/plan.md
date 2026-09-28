# Implementation Plan: Cancel a Running Task from Slack or as an Administrator

**Branch**: `feat/126-cancel-task` | **Date**: 2026-09-28 | **Spec**: [spec.md](spec.md)

- `packages/contracts/src/slack.ts`: `isStopCommand`, the whole-message matcher.
- `packages/broker/src/aws/slack-ingress.ts`: a `stopTask` dependency, checked after the existing member and turn
  checks and before the queue. In production it synchronously invokes the broker with
  `{ source: "agentx.slack-ingress", action: "stop-task", thread, userId }`.
- `packages/broker/src/aws/broker.ts`:
  - `acceptCancellation` is split into an owner check and a shared `requestCancellation`.
  - `cancelRunningTask` finds the active task.
  - The handler recognizes the internal event only when it has no `requestContext`, which API Gateway always
    sets, and runs `stopSlackThreadTask`: the channel binding, then the thread's workspace, then its task.
  - The admin route calls `cancelWorkspaceTask`.
- `infra/lib/control-plane.ts`: the ingress gets `BROKER_FUNCTION_NAME` and permission to invoke the broker.
- `packages/cli`: `admin workspace cancel`.
- The worker needs nothing new. A cancel invocation aborts the task's pi session, and since #136 the task ends
  CANCELLED.

## Constitution Check

PASS. The public-facing ingress Lambda gains only permission to invoke the broker; it gets no state-table writes
and no callback key.
