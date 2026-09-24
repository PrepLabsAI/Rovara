# Implementation Plan: Continue a Conversation Through the Task Path

## Summary

Wire the two pieces that already exist — the workspace conversation manifest and
`openRegisteredWorkspacePiSession` — into `runTaskInvocation`, and give the control plane the one
attribute that says a conversation owns a session, so a workspace that cannot produce a transcript
fails closed instead of starting the thread over.

## Technical Context

- Two stores, deliberately: the DynamoDB `CONVERSATION` item is the durable record of existence,
  ownership and now lifecycle; `.agentx/conversations.json` is the workspace-local pointer from
  conversation ID to session file. A session path means nothing off the volume holding it, so it
  stays in the workspace and never becomes a DynamoDB attribute.
- `WorkerInvocationSchema`'s task payload is `.strict()`, so adding a field is a deploy-order
  constraint. The release already deploys the runtime before the control plane, which is the order
  this needs.
- `SessionManager.create` writes a header into the session file; `SessionManager.open` on a
  zero-byte file is unverified. So "always pre-create the file and always open it" is not available
  as a simplification, and create and open stay two paths.

## Constitution Check (v2.0.0)

- **I, II:** Unchanged. No new client, no new tool surface, no change to project preparation.
- **III:** Strengthened. Histories stay isolated by workspace, the conversation ID selects a
  server-owned path and never supplies one, and containment is rechecked after symlink resolution.
- **IV:** This is the principle the change implements: conversation state now persists across worker
  processes, reconnects resolve it, and a turn that cannot be restored is reported explicitly rather
  than reset.
- **V:** Spec, plan and tasks recorded here. The gap was invisible because the existing resumption
  test used the helpers directly, so the new tests drive the real task entry point.

## Design

### 1. Contracts

`AgentXErrorCode` gains `CONVERSATION_STATE_LOST` (409). The task payload gains an optional
`conversationStarted: boolean`, the control plane's answer to "does this conversation already own a
session?".

### 2. Worker conversation store

The manifest moves to `schemaVersion: 2`, entries gaining `model: { provider, modelId }`. Reads
accept 1 and 2 and writes always emit 2, so an existing manifest upgrades on its next turn.
`tryResolve` returns the record or `undefined` where `resolve` throws, `recordTurn` stamps a reopened
conversation with the model it ran on, and a corrupt or unknown-version manifest raises
`CONVERSATION_STATE_LOST` rather than reading as empty. The session directory is resolved through
symlinks before any containment check, so the store and the Pi session agree on the same directory.

### 3. Task path

`runTaskInvocation` resolves the conversation, then either opens the registered session or creates
one and registers it **before** the prompt: a crash then orphans an empty session file instead of
losing a turn. A manifest miss plus `conversationStarted` is `CONVERSATION_STATE_LOST` before any
adapter runs. Nothing falls back to create. The public conversation ID, not `session.conversationId`,
is what the lifecycle event, the result event, the manifest key and the return value carry, and the
absolute session path is no longer returned to the control plane.

### 4. Control plane

`acceptTask` reads the conversation record it already fetches and passes
`conversationStarted: typeof conversation.startedAt === "string"`. The event callback, on a lifecycle
event carrying `conversation.started`, sets `startedAt` under `attribute_not_exists(startedAt)`, so
redelivery cannot move it. Only a conditional failure is swallowed; anything else reaches the worker,
which retries the batch, so the record cannot quietly fall behind the workspace.

## Testing

`tests/integration/conversation-continuity.test.ts` drives the real `runTaskInvocation`: two turns on
one conversation with an adapter that records every create and open, a second conversation, both
lost-state cases, relative-path and symlink escapes, a cancelled turn followed by a successful one, a
model change, and a schema-1 manifest. `tests/contract/slack-control-plane.test.ts` covers the
control-plane half end to end: first task says not started, the lifecycle callback marks it, a
redelivered batch does not move the mark, and the second task says started.
`tests/contract/release-command.test.ts` asserts the deploy order both release scripts already use,
since it is now load-bearing rather than incidental. The `usage` event added by worker telemetry is
what makes the model-change report measurable: a turn that continues on another model reads no
prompt cache, which shows up as a collapsed `cacheReadRatio`.
