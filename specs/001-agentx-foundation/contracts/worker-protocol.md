# Remote Worker Protocol v1

Container serves `GET /ping` and `POST /invocations` on port 8080. Only the trusted
dispatcher/broker may invoke the runtime; the developer client cannot reach it directly.

Invocation envelope: `protocolVersion: 1`, `operationId`, `workspaceId`, `kind`, `fence`,
`projectRevision`, `callbackCapability`, and a kind-specific payload. Runtime routing/session
ID is selected by the broker outside this payload. Secrets never appear in diagnostic output.

- `prepare`: validated server project definition and scoped repository access grant; initialize
  only after the configured volume is mounted. No pi coding prompt. Persist readiness manifest.
- `task`: conversation ID and bounded prompt; open cwd beneath the prepared repository root,
  persist pi session under `agent-sessions/`, journal acceptance, start background work, acknowledge.
- `cancel`: target operation ID; request pi abort and terminate tracked child process groups.
- `resume`: validate manifest and reopen state; reconcile interrupted work before accepting a task.

Acknowledgment uses HTTP 200 with `accepted`, operation ID and current status, as required by
the AgentCore invocation contract. Duplicate operation IDs return recorded status/result.
Conflicting payloads or fences return a typed application error without starting pi.

After journal persistence, the worker posts a terminal callback for every background invocation.
Preparation success includes the fixed manifest path; task success may include the persisted
conversation identifier. Failures report a bounded, redacted message. The broker conditionally
updates the matching operation/fence and releases the workspace writer; a duplicate terminal
callback returns the already-recorded terminal state without changing it.

`/ping` returns `{"status":"Healthy"}` when idle and `{"status":"HealthyBusy"}` while
background work or cleanup remains active. Keep ping responsive during shell execution.
Busy status does not remove the maximum compute lifetime; persist progress throughout work.

Workspace paths:

```text
/mnt/workspace/
  repo/                 # Administrator-defined repository layout
  agent-sessions/       # Pi conversation files, server-generated paths
  task-state/           # Preparation manifest and operation journal
  artifacts/            # Logs, diffs and test results
  cache/                # Private dependency/build caches
```

Persist files and journal before announcing completed work. Completed conversation entries
survive restart. An in-flight command may have partial effects; report INTERRUPTED and inspect
the working tree before resuming. Never reset a checkout to its starting commit on reconnect.
New conversations must not trigger repository setup. Git commits/pushes require explicit intent.

The trusted workspace binding names its deployment mode. `instances-ebs` requires a capacity
provider binding. `demo-microvm` has no capacity provider and uses the same server-owned runtime
session ID to recover managed session storage. Client payloads may select neither the mode nor
the session ID. Demo storage is disposable under its documented size, idle-expiry and
runtime-version-reset limits.
