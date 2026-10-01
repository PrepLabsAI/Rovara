# Phase 14b: Workspace Only When Needed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new Slack thread gets a cheap thread record at once and prepares coding compute only
the first time a tool needs the remote worker, so connector-only threads cost no compute, take no
setup time and never count against the workspace limits.

**Architecture:** The workspace record stays, and keeps its ID from the first message, because
connector routes, the connector ledger, conversations and operations are all keyed by it. What
moves is the expensive half:

- A new status `UNPREPARED` marks a record with no compute. Creating one writes no operation, no
  outbox item and no limit charge.
- A new service route, `POST /v1/threads/workspace/prepare`, moves `UNPREPARED` to `PREPARING`. The
  same transaction writes the prepare operation and outbox item and charges the member and the
  organization. So the limits count only prepared threads.
- The broker returns `UNPREPARED` only to a Slack service that sends `lazyPreparation: true`. An
  older service that reaches an `UNPREPARED` thread gets it prepared at once, as it expects.
- In the Slack service, the processor gives the turn a lazy worker handle when the thread is
  `UNPREPARED`. `agentx_submit_task` and `agentx_follow_up` call it before they run. It prepares
  once per turn, posts "Setting up a new workspace" only then, and waits in the same turn.

Every thread whose status is not `UNPREPARED` takes exactly today's code path.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Zod 4, Vitest 5, AWS SDK v3,
Pi coding agent 0.85.1.

**Spec:** [../spec.md](../spec.md): User Story 1, FR-001 to FR-006, SC-001, SC-002, and the edge
cases "A thread with no workspace receives close this workspace" and "A connector-only thread later
needs the worker while the project's latest revision has changed".

**Branches and pull requests:** see "Delivery and rollout" below. Cross-plan order (see
`.superpowers/sdd/014-decisions.md`): 14a ships first, then this phase's PR A, then 14c part 1
(dormant classifier and gate scaffolding), then this phase's PR B. Each part below is written
against mainline plus every phase that ships before it in that order. Tasks 1 to 6 are PR A on its
own branch, `feat/014b-lazy-workspace-a`, cut from `mainline` once phase 14a has merged and
released. Tasks 7, 8 and 8b are PR B on its own branch, `feat/014b-lazy-workspace-b`, cut from
`mainline` once PR A and phase 14c part 1 have both merged and released. Task 8b (one
acknowledgement unless the request waited) was folded into PR B on 2026-09-25.

## Global Constraints

- **Characterization first.** Task 1 adds tests that pin today's behaviour of `processor.ts`, the
  broker thread workspace routes and the `agentx_*` tools. No production file changes in Task 1,
  and no later task edits those files until Task 1 is committed with its tests passing.
- **No regressions.** Every existing test passes with its assertions unchanged, with two named
  exceptions, both in Task 7: in `tests/contract/thread-workspace-request.test.ts` the expected
  request body gains `lazyPreparation: true`, inserted before `includeActionPolicy: true` (which
  phase 14c part 1 adds before this task runs); and in `tests/contract/thread-api.test.ts` the PR A
  test named "PR A: the ensure body does not opt into lazy preparation, ... (replaced when PR B
  opts in)", added in PR A's review, is replaced by its PR B counterpart. Both stay exact
  `toEqual` assertions on the body.
- **Golden files are append-only.** Nothing under `tests/contract/__snapshots__/` changes. So the
  `agentx_*` tool names, labels, descriptions and parameters, and `orchestratorSystemPrompt`, stay
  byte-identical. The lazy behaviour lives in the tools' `execute` functions only.
- **Prepared threads unchanged (FR-005).** For any workspace status other than `UNPREPARED`, the
  processor builds no worker handle, the turn input has no `worker` key, and no tool calls
  `prepareWorkspace`.
- **Opt-in compatibility.** The broker returns status `UNPREPARED` only to a request that carries
  `lazyPreparation: true`. Older Slack services parse `status` with a strict enum that lacks it.
- **Core flows untouched.** `newWorkspacePreparation`, `retryWorkspacePreparation`,
  `completeThreadWorkspaceClose`, `acceptTask`, `acceptPullRequest` and
  `acceptPullRequestLifecycle` are not edited. New broker behaviour lives in new functions and in
  small branches in `ensureThreadWorkspace`, `startThreadWorkspaceClose` and the service router.
- **Same thread messages.** The setup, still-setting-up, failure and limit messages keep today's
  exact text. They move to `packages/slack-service/src/messages.ts` so the lazy worker reuses them.
- **No vendor names** in any new code (spec 013 FR-001).
- **Node and build.** Node `>=22.19.0 <23`. If `node -v` is not 22, run
  `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`. Run `npm run build`
  before `npx vitest`, because tests import built workspace packages.
- **Full suite per task.** `npm run typecheck && npm run lint && npm run build && npm test`.
- **Commits.** Messages are `type(scope): summary`, ending with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Docs style.** Plain, short sentences. No em-dashes in any document this phase writes.
- **User preference.** Fix cheap review findings and anything that fails silently before the PR,
  instead of deferring them.

## Review Focus

1. **A race between two first messages.** Two messages reach a brand-new thread together
   (redelivery, or two service tasks during a deploy). Expected: one workspace record, one
   conversation owner, zero limit charge; and later exactly one preparation and one charge, with
   the loser told the workspace is already being set up. Parallel tool calls in one turn prepare
   once and post once. Tests: Task 3 (record race), Task 4 (preparation race and last-slot race),
   Task 6 (parallel `ensureReady`).
2. **The limit is reached at preparation time.** Expected: AgentX posts the limit message with the
   member's existing threads, the tool tells the model not to retry, the connector part of the
   request is still answered, and the thread stays usable and uncharged. Tests: Task 4 (broker),
   Task 6 (lazy worker and processor), Task 7 (end to end through the real broker).
3. **Preparation fails mid-turn.** Expected: the thread sees the setup message, then today's failure
   message; the tool returns a refusal and is not retried in that turn; the reply is still posted;
   the charge stays, as it does today; and the next message retries preparation exactly as today.
   Tests: Task 6, Task 4, Task 7.
4. **A connector-only thread is later asked to close.** Expected: "This thread does not have a
   workspace to close.", nothing deleted, nothing charged or released, and the thread keeps
   answering. Tests: Task 3, Task 7.
5. **Old and new component version mixes.** Expected: an older Slack service with the new control
   plane behaves as today, even on a thread left `UNPREPARED`; a new Slack service with an older
   control plane behaves as today; the control plane is never rolled back under `UNPREPARED`
   records. Tests: Task 1 (the broker ignores unknown request fields, which is what an older
   control plane does with `lazyPreparation`), Task 4 (older-service path), Task 6 (eager result
   gives no worker handle). The rollout rules are below.
6. **One acknowledgement per request (Task 8b).** Expected: a request with nothing ahead gets the
   ingress's "I'm on it" and then its answer; a queued request, or one that waited for setup up
   front, also gets "Working on it now"; a message with no count (older ingress) keeps today's
   notice; an older Slack service is not broken by the count. Tests: Task 8b.

## Delivery and rollout

The release script deploys the runtime, then the control plane, then the Slack orchestrator. This
phase changes no runtime code. `packages/contracts` changes, which rebuilds the worker image, but
the worker never sees an `UNPREPARED` workspace because no invocation is sent until preparation.

The phase ships as two pull requests, so that the one change that creates `UNPREPARED` records can
be reverted on its own. Cross-plan order: 14a, then PR A, then 14c part 1, then PR B; each ships to
`mainline` before the next is branched:

| PR | Branch | Ships after | Tasks | What ships | User-visible change |
|---|---|---|---|---|---|
| A | `feat/014b-lazy-workspace-a` | 14a | 1 to 6 | Contracts; broker support for `UNPREPARED` and the prepare route; orchestrator worker handle; Slack service support, dormant | None. No service opts in, so no `UNPREPARED` record is ever created |
| B | `feat/014b-lazy-workspace-b` | 14c part 1 | 7, 8 and 8b | The Slack service sends `lazyPreparation: true`; end-to-end tests; docs; the ingress sends a queue count and the service posts "Working on it now" only after a wait | Lazy workspaces; one acknowledgement per request unless it waited |

Component mixes:

| Slack service | Control plane | Behaviour |
|---|---|---|
| Before A | A | The old request body has no opt-in, so new threads prepare at once as today. If a thread is `UNPREPARED` (only possible after PR B ran and was reverted), the broker prepares it at once, charges the limit and returns `PREPARING` with `created: true`. Task 4 tests this |
| A or B | Before A | The old broker ignores `lazyPreparation` and returns today's result. The processor then builds no worker handle. Tasks 1 and 6 test this |
| B | A | Lazy workspaces |

Task 8b's queue count crosses the same boundary: the ingress is part of the control plane. An
older ingress sends no count, so a PR B Slack service posts "Working on it now" as today. An older
Slack service does not ask for the count's message attribute, so it ignores it and posts as today.
The count is never in the message body, which older services parse strictly.

Rollback rules:

- **Revert PR B freely.** The Slack service stops opting in. Threads left `UNPREPARED` are prepared
  by the PR A broker on their next message.
- **Do not revert PR A after PR B has run in a deployment.** The pre-A broker parses workspace
  records with a strict enum and would fail every request in an `UNPREPARED` thread. Revert PR B
  first, then fix PR A forward.

## File Structure

| File | Responsibility |
|---|---|
| `packages/contracts/src/workspace.ts` | `UNPREPARED` appended to `WorkspaceStatusSchema` |
| `packages/contracts/src/slack.ts` | `SlackThreadPrepareResultSchema` and its type |
| `packages/broker/src/aws/broker.ts` | `lazyPreparation` opt-in; `createUnpreparedThreadWorkspace`, `unpreparedWorkspace`; `prepareThreadWorkspace` route handler and `startThreadPreparation`; older-service branch; close of an `UNPREPARED` thread |
| `packages/orchestrator/src/orchestration-tools.ts` | `WorkerAccess`, `WorkerRefusal`, `WORKER_TOOL_NAMES`, `NO_WORKSPACE_TO_PUBLISH`; the `worker` option |
| `packages/orchestrator/src/orchestrator.ts` | `OrchestratorOptions.worker`, passed to the tools |
| `packages/slack-service/src/messages.ts` (new) | Thread messages shared by the processor and the lazy worker, moved verbatim |
| `packages/slack-service/src/lazy-worker.ts` (new) | `createLazyWorker`: prepare once per turn, post, wait, refuse |
| `packages/slack-service/src/thread-api.ts` (new) | `createThreadApi`, moved from `main.ts`, plus `prepareWorkspace` |
| `packages/slack-service/src/processor.ts` | `UNPREPARED` is runnable; builds the lazy worker; `TurnInput.worker`; optional `ThreadServiceApi.prepareWorkspace` |
| `packages/slack-service/src/runtime.ts` | Passes `input.worker` to the orchestrator |
| `packages/slack-service/src/main.ts` | Uses `createThreadApi` |
| `packages/slack-service/src/thread-workspace-request.ts` | `lazyPreparation: true` (PR B) |
| `packages/contracts/src/slack.ts`, `packages/broker/src/aws/slack-ingress.ts`, `packages/slack-service/src/consumer.ts`, `packages/slack-service/src/main.ts`, `packages/slack-service/src/processor.ts` | Task 8b (PR B): the `queuedBehind` queue message attribute, sent by the ingress and passed to the processor, which posts "Working on it now" only after a wait |
| `tests/integration/slack-start-notice.test.ts` (new) | Task 8b: start notice characterization and new behaviour, consumer and attribute helpers |
| `tests/support/slack-broker.ts` | New helpers: `registerSlackProject`, `serviceCall`, `finishOperation`, `fakeGitHubMcp`, `lazyEnsureWorkspace`, `prepareThread` |
| `tests/contract/slack-thread-characterization.test.ts` (new) | Broker characterization |
| `tests/integration/slack-processor-characterization.test.ts` (new) | Processor characterization |
| `tests/contract/orchestration-tools-characterization.test.ts` (new) | In-house tool characterization, one tool to one API mapping |
| `tests/contract/lazy-workspace-contracts.test.ts` (new) | Contract tests |
| `tests/contract/slack-lazy-workspace.test.ts` (new) | Broker lazy record and preparation |
| `tests/contract/worker-access.test.ts` (new) | Worker rule per in-house tool |
| `tests/contract/thread-api.test.ts` (new) | The Slack service's control-plane client against the broker |
| `tests/integration/slack-lazy-worker.test.ts` (new) | Lazy worker, processor and hosted runtime |
| `tests/integration/hosted-lazy-workspace.test.ts` (new) | End to end: processor, real broker, real tools |

## Pre-decided Rulings

1. **Keep the workspace record; add `UNPREPARED`.** The alternative, no workspace record until
   compute exists, would re-key connector routes (`/workspaces/{id}/connectors/...`), the connector
   ledger (`WORKSPACE#id`), conversations and the Slack service's thread state, and would add a
   second authorization path. Keeping the record changes none of them: connector routes and
   conversation creation already ignore workspace status (Task 1 pins this). Cost if wrong: a later
   migration of `UNPREPARED` records, which have no compute to move.
2. **Which in-house tools prepare compute.**
   - `agentx_submit_task` and `agentx_follow_up` prepare, because they run on the worker.
   - `agentx_create_pull_request` does not prepare. In a thread with no compute it answers
     `NO_WORKSPACE`, because a freshly prepared clone has no changes to publish, and preparing
     would spend a limit slot and minutes on a certain failure. If the same turn prepared compute
     first (through a task), it runs as today. This holds even when the call was confirmed by the
     user: 14c part 2's confirmation gate runs before the tool executes, and confirming a call does
     not by itself create compute, so a confirmed `agentx_create_pull_request` in a thread with no
     compute still answers `NO_WORKSPACE` (spec 014 C9).
   - `agentx_manage_pull_request` is unchanged and never prepares. A thread with no compute owns no
     AgentX pull requests, and the broker already answers `NOT_FOUND` ("pull request is not owned
     by this AgentX workspace") before any readiness check. Preparing would not change that answer.
   - `agentx_task_status` and `agentx_task_result` never prepare. They are shown only when the
     broker reports a recoverable operation, which needs a `BUSY` workspace, so an `UNPREPARED`
     thread never sees them.
   - Connector tools never prepare (FR-002).

   Cost if wrong: one line in `orchestration-tools.ts` per tool.
3. **The member whose request prepares compute is charged.** The prepare transaction sets
   `starterUserId` on the Slack thread record at the moment of the charge. `completeThreadWorkspaceClose`
   already releases the charge of `starterUserId`, so closing stays correct without edits, and the
   limit message ("You already have ...") is addressed to the right person. Threads prepared before
   this phase keep their starter. Cost if wrong: a follow-up by another member in a connector-only
   thread charges that member rather than the person who opened the thread.
4. **Revision rule.** A thread's workspace record pins the latest revision at the thread's first
   message, and preparation builds the disk from that pinned revision, as the spec's edge case says
   and as `retryWorkspacePreparation` already does. The model's settings (instructions, connectors,
   repositories) keep following the latest revision on every message, and "Settings updated to
   revision N" keeps working unchanged. Cost if wrong: a thread that waits a long time before its
   first coding request builds an older revision's disk; the fix is to pass the latest definition
   in `startThreadPreparation`. Superseded by #12 (first slice): `startThreadPreparation` now
   builds an UNPREPARED workspace from the latest revision and writes it onto the record.
5. **A failed preparation keeps today's retry.** `PREPARATION_FAILED` is a charged, prepared status,
   so the next message retries preparation up front exactly as today (FR-005), even when the first
   attempt was lazy. Cost if wrong: one connector-only message after a failure waits for a retry.
6. **Close of an `UNPREPARED` thread answers `NOT_FOUND`.** The processor then posts today's "This
   thread does not have a workspace to close." The record stays and the thread keeps working.
7. **One preparation attempt per turn.** The lazy worker memoizes its first result, including a
   refusal or a thrown error, for the rest of the turn. The next Slack message tries again. This
   stops a model from looping on a limit or an outage.
8. **The prepare route has no idempotency item.** Its outcome is decided by the workspace status
   under a conditional write, which already makes a repeated or racing call safe. Redelivery never
   reaches it twice, because a redelivered event finds the workspace `PREPARING` in the first
   request and waits there, as today.
9. **The worker handle is invisible to the model.** No tool description or system prompt text
   changes, so the golden files stay untouched. The model learns about a limit or failure from the
   tool result, whose `message` says not to retry and to answer the rest of the request.
10. **Shared building blocks, not shared functions.** `startThreadPreparation` builds its operation
    and invocation from the same primitives as `retryWorkspacePreparation` (`operationRecord`,
    `issueCapability`, `issueRepositoryGrant`, `outboxRecord`) instead of refactoring that
    function. About 25 lines repeat; in exchange Pratik's retry path is not edited.

---

### Task 1: Characterization tests for today's thread workspace, processor and tool behaviour

Start PR A's branch from `mainline`, once phase 14a has merged and released:
`git switch -c feat/014b-lazy-workspace-a`.

No production code changes in this task. Every test must pass on the current code (mainline plus
14a).

**Files:**
- Modify: `tests/support/slack-broker.ts` (append helpers only)
- Test: `tests/contract/slack-thread-characterization.test.ts` (new),
  `tests/integration/slack-processor-characterization.test.ts` (new),
  `tests/contract/orchestration-tools-characterization.test.ts` (new)

**Interfaces:**
- Produces, in `tests/support/slack-broker.ts`:
  - `SLACK_TEAM = "T0BSHLLUGBD"`, `SLACK_CHANNEL = "C0123456789"`;
  - `registerSlackProject(handler: Handler, options?: { revision?: number; connectors?: unknown[]; bind?: boolean }): Promise<void>`;
  - `serviceCall(handler: Handler, thread: string, slackUser: string, method: string, path: string, body?: unknown)`;
  - `finishOperation(handler: Handler, db: FakeDynamoDb, workspaceId: string, operationId: string, status: "SUCCEEDED" | "FAILED", result?: unknown): Promise<void>`;
  - `fakeGitHubMcp(): { githubMcp: GitHubMcpDependencies; invoke: Mock }`;
  - `GITHUB_LIST_ISSUES`, a `connectors` array approving the GitHub `list_issues` read tool.
- Consumed by: Tasks 3, 4, 6 and 7.

- [ ] **Step 1: Append the shared helpers**

Append to `tests/support/slack-broker.ts`:

```ts
export const SLACK_TEAM = "T0BSHLLUGBD";
export const SLACK_CHANNEL = "C0123456789";
const projectAdministrator = { subject: "admin-subject", admin: true };

/** Registers project "payments" at a revision and, unless told not to, binds the test channel to it. */
export async function registerSlackProject(
  handler: Handler,
  options: { revision?: number; connectors?: unknown[]; bind?: boolean } = {},
): Promise<void> {
  const revision = options.revision ?? 1;
  const registered = await call(handler, {
    method: "POST",
    path: "/v1/admin/projects",
    user: projectAdministrator,
    body: {
      definition: {
        name: "payments",
        revision,
        repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [],
        readiness: [],
        orchestratorInstructions: `Delegate work (revision ${revision}).`,
        ...(options.connectors ? { integrations: { connectors: options.connectors } } : {}),
      },
      runtimeBinding: {
        runtimeArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:runtime/agentx_production_worker-YVirjlFgvk`,
        endpointQualifier: "DEFAULT",
        deploymentMode: "instances-ebs",
        capacityProviderArn: `arn:aws:bedrock-agentcore:us-east-1:${account}:capacity-provider/agentx_production_capacity_v3-VwkM93EABZ`,
      },
    },
  });
  if (registered.status !== 201) throw new Error(`project registration failed: ${JSON.stringify(registered.body)}`);
  if (options.bind === false) return;
  const bound = await call(handler, {
    method: "PUT",
    path: `/v1/admin/slack/bindings/${SLACK_TEAM}/${SLACK_CHANNEL}`,
    user: projectAdministrator,
    body: { projectName: "payments" },
  });
  if (bound.status !== 200) throw new Error(`channel binding failed: ${JSON.stringify(bound.body)}`);
}

/** A request from the hosted Slack orchestrator, acting for one thread and one member. */
export function serviceCall(handler: Handler, thread: string, slackUser: string, method: string, path: string, body?: unknown) {
  return call(handler, {
    method,
    path,
    service: { principal: orchestratorPrincipal, thread, slackUser },
    ...(body === undefined ? {} : { body }),
  });
}

/** Completes an operation through the worker's terminal-result callback, as the runtime does. */
export async function finishOperation(
  handler: Handler,
  db: FakeDynamoDb,
  workspaceId: string,
  operationId: string,
  status: "SUCCEEDED" | "FAILED",
  result?: unknown,
): Promise<void> {
  const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
  const capability = (outbox?.invocation as { callbackCapability?: string } | undefined)?.callbackCapability;
  if (!capability) throw new Error("callback capability is missing");
  const response = await call(handler, {
    method: "POST",
    path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/result`,
    headers: { "x-agentx-callback-capability": capability },
    body: {
      operationId,
      status,
      ...(result === undefined ? {} : { result }),
      ...(status === "FAILED" ? { error: "clone failed" } : {}),
    },
  });
  if (response.status !== 200) throw new Error(`terminal callback failed: ${JSON.stringify(response.body)}`);
}

/** A GitHub MCP double offering one read tool, list_issues. */
export function fakeGitHubMcp() {
  const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "2 open issues" }] }));
  const credentials = vi.fn(async () => ({ owner: "example", repo: "demo", token: "installation-secret" }));
  const connect = vi.fn(async () => ({
    tools: [{
      name: "list_issues",
      description: "List issues",
      inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" } }, required: ["owner", "repo"] },
    }],
    call: invoke,
    close: async () => undefined,
  }));
  return { githubMcp: { credentials, connect } as unknown as GitHubMcpDependencies, invoke };
}

export const GITHUB_LIST_ISSUES = [
  { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] },
];
```

- [ ] **Step 2: Write the broker characterization tests**

```ts
// tests/contract/slack-thread-characterization.test.ts
// Pins the thread workspace behaviour that phase 14b must keep for threads that have compute.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import {
  GITHUB_LIST_ISSUES, SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, fakeGitHubMcp, finishOperation,
  loadSlackBroker, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const pratik = "U0123456789";
const bob = "U0456789012";

beforeAll(async () => {
  await loadSlackBroker();
});

describe("thread workspaces before lazy preparation (characterization)", () => {
  it("ignores request fields it does not know and prepares at once", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const response = await serviceCall(handler, thread, pratik, "POST", "/v1/service/threads/workspace", {
      requestId: randomUUID(), includeIntegrations: true, includeSettingsRevision: true, futureFlag: true,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "WORKSPACE", status: "PREPARING", created: true });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1, threads: [thread] });
  });

  it("charges a thread to its starter only, never to a member who follows up", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await ensureWorkspace(handler, thread, pratik);
    await ensureWorkspace(handler, thread, bob);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toBeUndefined();
    expect(db.find((item) => item.entityType === "SLACK_THREAD")[0]).toMatchObject({ starterUserId: pratik });
  });

  it("retries a failed preparation at the next request without charging the limit again", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const first = await ensureWorkspace(handler, thread, pratik);
    const workspaceId = first.body.workspaceId as string;
    await finishOperation(handler, db, workspaceId, first.body.operationId as string, "FAILED");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED", fence: 1 });

    const retried = await ensureWorkspace(handler, thread, pratik);
    expect(retried.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", created: false });
    expect(retried.body.operationId).not.toBe(first.body.operationId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING", fence: 2 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(2);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
  });

  it("refuses to close a workspace that is still being prepared", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    await ensureWorkspace(handler, thread, pratik);
    const close = await serviceCall(handler, thread, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(close.status).toBe(409);
    expect(close.body.error).toMatchObject({ code: "WORKSPACE_BUSY" });
  });

  it("serves connector discovery and calls whatever the workspace status", async () => {
    const { githubMcp, invoke } = fakeGitHubMcp();
    const { db, handler } = createBroker({ githubMcp });
    await registerSlackProject(handler, { connectors: GITHUB_LIST_ISSUES });
    const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING" });
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const discovered = await serviceCall(handler, thread, pratik, "GET", `${path}/tools`);
    expect(discovered.status).toBe(200);
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    const called = await serviceCall(handler, thread, pratik, "POST", `${path}/call`, {
      requestId: randomUUID(), scope: "demo", tool: "list_issues", schemaHash: catalog.tools[0]!.scopes[0]!.schemaHash, arguments: {},
    });
    expect(called.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("creates a conversation at once but refuses a task until the workspace is ready", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    const conversation = await serviceCall(handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    expect(conversation.status).toBe(201);
    const task = await serviceCall(handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
      requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "list the files",
    });
    expect(task.status).toBe(409);
    expect(task.body.error).toEqual({ code: "WORKSPACE_NOT_READY", message: "workspace is PREPARING" });
  });
});
```

- [ ] **Step 3: Write the processor characterization tests**

```ts
// tests/integration/slack-processor-characterization.test.ts
// Pins how processSlackRequest treats each workspace result, before phase 14b adds UNPREPARED.
import { describe, expect, it, vi } from "vitest";
import type { SlackRequestMessage, SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const WORKING = "Working on it now. I'll post the result in this thread when it's done.";

function message(): SlackRequestMessage {
  return { version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text: "fix the navigation bug", receivedAt: "2026-09-25T10:00:00.000Z" };
}

function workspace(overrides: Record<string, unknown> = {}): SlackThreadWorkspaceResult {
  return { outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate work.", ...overrides };
}

function harness(result: SlackThreadWorkspaceResult) {
  const posts: string[] = [];
  const turns: TurnInput[] = [];
  const waitForOperation = vi.fn(async () => ({ status: "SUCCEEDED" }));
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => result,
      startClose: async () => ({ outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation,
      createConversation: async () => conversationId,
    }),
    threads: {
      load: async () => ({}),
      saveConversation: async () => undefined,
      saveSettingsRevision: async () => undefined,
      close: async () => undefined,
      finish: async () => undefined,
    },
    runTurn: async (input) => {
      turns.push(input);
      return "done";
    },
    post: async (_thread, text) => {
      posts.push(text);
    },
  };
  return { dependencies, posts, turns, waitForOperation };
}

describe("processing a thread's workspace result (characterization)", () => {
  it.each(["STOPPED", "BUSY"] as const)("runs the turn for a %s workspace without a setup message", async (status) => {
    const h = harness(workspace({ status }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "done"]);
    expect(h.waitForOperation).not.toHaveBeenCalled();
  });

  it.each(["UNHEALTHY", "RESUMING", "CLOSING", "PREPARATION_FAILED", "PREPARING"] as const)(
    "does not run a turn for a %s workspace with no operation to wait for",
    async (status) => {
      const h = harness(workspace({ status }));
      await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
      expect(h.turns).toHaveLength(0);
      expect(h.posts).toEqual([`This thread's workspace is not available right now (${status}). Mention me again later to retry.`]);
    },
  );

  it("tells a later request that another request is still setting the workspace up", async () => {
    const h = harness(workspace({ status: "PREPARING", operationId, created: false }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual(["This thread's workspace is still being set up. I'll start as soon as it's ready.", WORKING, "done"]);
    expect(h.waitForOperation).toHaveBeenCalledExactlyOnceWith(workspaceId, operationId);
  });

  it("hands the turn exactly the workspace's routing fields", async () => {
    const connectors = [{ name: "github", type: "github", label: "GitHub issues", scopes: ["demo"], connected: true }];
    const h = harness(workspace({ connectors, repositories: ["demo"], recoverableOperations: [operationId] }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    const turn = h.turns[0]!;
    expect(Object.keys(turn).sort()).toEqual([
      "connectors", "conversationId", "message", "orchestratorInstructions", "recoverableOperations", "repositories", "requestId", "subject", "workspaceId",
    ]);
    expect(turn).toMatchObject({ connectors, repositories: ["demo"], recoverableOperations: [operationId], workspaceId, conversationId });
  });

  it("hands the turn no routing field the workspace did not send", async () => {
    const h = harness(workspace());
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(Object.keys(h.turns[0]!).sort()).toEqual(["conversationId", "message", "orchestratorInstructions", "requestId", "subject", "workspaceId"]);
  });
});
```

- [ ] **Step 4: Write the in-house tool characterization tests**

```ts
// tests/contract/orchestration-tools-characterization.test.ts
// Pins each agentx_* tool to the API calls it makes today, one tool to one mapping, before phase
// 14b gives some of them a worker handle.
import { describe, expect, it, vi } from "vitest";
import {
  ORCHESTRATION_TOOL_NAMES, RECOVERY_TOOL_NAMES, createOrchestrationTools,
} from "../../packages/orchestrator/src/orchestration-tools.js";

const OPERATION = "11111111-1111-4111-8111-111111111111";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const context = { workspaceId: "22222222-2222-4222-8222-222222222222", conversationId: "33333333-3333-4333-8333-333333333333" };

function fakeApi() {
  return {
    submitTask: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    taskStatus: vi.fn().mockResolvedValue({ id: OPERATION, status: "RUNNING" }),
    taskResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED", response: "done" }),
    followUp: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    createPullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    managePullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    pullRequestResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED" }),
  };
}

function toolNamed(api: ReturnType<typeof fakeApi>, name: string) {
  const found = createOrchestrationTools(api, context, { requestId: () => REQUEST }).find((entry) => entry.name === name);
  if (!found) throw new Error(`${name} is missing`);
  return found;
}

function run(tool: ReturnType<typeof toolNamed>, parameters: Record<string, unknown>) {
  return tool.execute("call-1", parameters, undefined, undefined, {} as never);
}

function onlyCalled(api: ReturnType<typeof fakeApi>, ...names: Array<keyof ReturnType<typeof fakeApi>>) {
  for (const [name, mock] of Object.entries(api)) {
    if (names.includes(name as keyof ReturnType<typeof fakeApi>)) expect(mock, name).toHaveBeenCalledOnce();
    else expect(mock, name).not.toHaveBeenCalled();
  }
}

describe("in-house tools before lazy preparation (characterization)", () => {
  it("submits a task with the next request ID on the thread's conversation and waits for it", async () => {
    const api = fakeApi();
    const result = await run(toolNamed(api, "agentx_submit_task"), { prompt: "list the files" });
    onlyCalled(api, "submitTask", "taskResult");
    expect(api.submitTask).toHaveBeenCalledWith({ ...context, requestId: REQUEST, prompt: "list the files" });
    expect(api.taskResult.mock.calls[0]?.[0]).toEqual({ workspaceId: context.workspaceId, operationId: OPERATION });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ operationId: OPERATION, status: "SUCCEEDED", response: "done" }) }]);
  });

  it("runs a follow-up as one remote task on the thread's conversation and waits for it", async () => {
    const api = fakeApi();
    await run(toolNamed(api, "agentx_follow_up"), { prompt: "and the tests" });
    onlyCalled(api, "followUp", "taskResult");
    expect(api.followUp).toHaveBeenCalledWith({ ...context, requestId: REQUEST, prompt: "and the tests" });
  });

  it("reads a recoverable operation's status without starting work", async () => {
    const api = fakeApi();
    const result = await run(toolNamed(api, "agentx_task_status"), { operationId: OPERATION });
    onlyCalled(api, "taskStatus");
    expect(api.taskStatus).toHaveBeenCalledWith({ workspaceId: context.workspaceId, operationId: OPERATION });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ id: OPERATION, status: "RUNNING" }) }]);
  });

  it("waits for a recoverable operation's result without starting work", async () => {
    const api = fakeApi();
    await run(toolNamed(api, "agentx_task_result"), { operationId: OPERATION });
    onlyCalled(api, "taskResult");
    expect(api.taskResult.mock.calls[0]?.[0]).toEqual({ workspaceId: context.workspaceId, operationId: OPERATION });
  });

  it("publishes a pull request with the next request ID and waits for the publication", async () => {
    const api = fakeApi();
    await run(toolNamed(api, "agentx_create_pull_request"), { repository: "demo", title: "Fix", body: "Why" });
    onlyCalled(api, "createPullRequest", "pullRequestResult");
    expect(api.createPullRequest).toHaveBeenCalledWith({ workspaceId: context.workspaceId, requestId: REQUEST, repository: "demo", title: "Fix", body: "Why" });
  });

  it("sends a title and body only with the pull request actions that carry them", async () => {
    for (const action of ["edit", "replace", "revert"]) {
      const api = fakeApi();
      await run(toolNamed(api, "agentx_manage_pull_request"), { repository: "demo", pullRequestNumber: 7, action, title: "T", body: "B" });
      onlyCalled(api, "managePullRequest", "pullRequestResult");
      expect(api.managePullRequest).toHaveBeenCalledWith({ workspaceId: context.workspaceId, requestId: REQUEST, repository: "demo", pullRequestNumber: 7, action, title: "T", body: "B" });
    }
    for (const action of ["append", "sync", "close", "reopen"]) {
      const api = fakeApi();
      await run(toolNamed(api, "agentx_manage_pull_request"), { repository: "demo", pullRequestNumber: 7, action, title: "T", body: "B" });
      expect(api.managePullRequest).toHaveBeenCalledWith({ workspaceId: context.workspaceId, requestId: REQUEST, repository: "demo", pullRequestNumber: 7, action });
    }
  });

  it("drops only the recovery tools when nothing is recoverable", () => {
    const api = fakeApi();
    const names = (recovery?: boolean) => createOrchestrationTools(api, context, recovery === undefined ? {} : { recovery }).map((tool) => tool.name);
    expect(names()).toEqual([...ORCHESTRATION_TOOL_NAMES]);
    expect(names(true)).toEqual([...ORCHESTRATION_TOOL_NAMES]);
    expect(names(false)).toEqual(ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name)));
  });
});
```

- [ ] **Step 5: Run the new tests and confirm they pass on today's code**

Run: `npm run build && npx vitest run tests/contract/slack-thread-characterization.test.ts tests/integration/slack-processor-characterization.test.ts tests/contract/orchestration-tools-characterization.test.ts`
Expected: PASS. A failure here means the test misdescribes today's behaviour: fix the test, never
the production code, in this task.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add tests/support/slack-broker.ts tests/contract/slack-thread-characterization.test.ts tests/integration/slack-processor-characterization.test.ts tests/contract/orchestration-tools-characterization.test.ts
git commit -m "test(014): characterize thread workspaces, the Slack processor and in-house tools before lazy preparation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Contracts for a workspace with no compute

**Files:**
- Modify: `packages/contracts/src/workspace.ts:4-14`, `packages/contracts/src/slack.ts`
- Test: `tests/contract/lazy-workspace-contracts.test.ts` (new)

**Interfaces:**
- Produces:
  - `WorkspaceStatusSchema` with `"UNPREPARED"` as its last option;
  - `SlackThreadPrepareResultSchema` and `type SlackThreadPrepareResult`, a union on `outcome`:
    `WORKSPACE { workspaceId, status, operationId: string | null, created }`,
    `LIMIT_REACHED { limit, maximum, starterThreads }`, `CLOSED { workspaceId, closedAt }`.
- Consumed by: Tasks 3, 4 and 6.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/lazy-workspace-contracts.test.ts
import { describe, expect, it } from "vitest";
import { SlackThreadPrepareResultSchema, SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import { WorkspaceInstanceSchema, WorkspaceStatusSchema } from "../../packages/contracts/src/workspace.js";

const PRE_LAZY_STATUSES = ["PREPARING", "READY", "PREPARATION_FAILED", "BUSY", "UNHEALTHY", "STOPPED", "RESUMING", "CLOSING", "CLOSED"];
const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };

describe("a workspace with no compute", () => {
  it("appends UNPREPARED after every status older components know", () => {
    expect(WorkspaceStatusSchema.options).toEqual([...PRE_LAZY_STATUSES, "UNPREPARED"]);
  });

  it("stores a thread workspace record before its compute exists", () => {
    const record = WorkspaceInstanceSchema.parse({
      id: workspaceId, ownerKey: "o".repeat(64), projectName: "payments", projectRevision: 1,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx_production_worker-YVirjlFgvk",
      endpointQualifier: "DEFAULT", runtimeSessionId: operationId, deploymentMode: "demo-microvm", rootPath: "/mnt/workspace",
      status: "UNPREPARED", fence: 0, createdAt: "2026-09-25T10:00:00.000Z", updatedAt: "2026-09-25T10:00:00.000Z",
    });
    expect(record).toMatchObject({ status: "UNPREPARED", fence: 0, activeOperationId: null });
  });

  it("lets a thread workspace result say the thread has no compute yet", () => {
    expect(SlackThreadWorkspaceResultSchema.parse({
      outcome: "WORKSPACE", workspaceId, status: "UNPREPARED", operationId: null, created: true, orchestratorInstructions: "Delegate work.",
    })).toMatchObject({ status: "UNPREPARED" });
  });
});

describe("the thread workspace preparation result", () => {
  it("parses a started, a raced, a refused and a closed preparation", () => {
    expect(SlackThreadPrepareResultSchema.parse({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId, created: true }))
      .toEqual({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId, created: true });
    expect(SlackThreadPrepareResultSchema.parse({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false }))
      .toMatchObject({ status: "READY", operationId: null });
    expect(SlackThreadPrepareResultSchema.parse({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [thread] }))
      .toMatchObject({ outcome: "LIMIT_REACHED", starterThreads: [thread] });
    expect(SlackThreadPrepareResultSchema.parse({ outcome: "CLOSED", workspaceId, closedAt: "2026-09-25T10:00:00.000Z" }))
      .toMatchObject({ outcome: "CLOSED" });
  });

  it("refuses fields outside the contract", () => {
    expect(SlackThreadPrepareResultSchema.safeParse({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId, created: true, orchestratorInstructions: "x" }).success).toBe(false);
    expect(SlackThreadPrepareResultSchema.safeParse({ outcome: "WORKSPACE", workspaceId, status: "WARMING", operationId, created: true }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/lazy-workspace-contracts.test.ts`
Expected: FAIL. The enum lacks `UNPREPARED`, and `SlackThreadPrepareResultSchema` is not exported.

- [ ] **Step 3: Implement**

In `packages/contracts/src/workspace.ts`, append the new status as the last entry:

```ts
export const WorkspaceStatusSchema = z.enum([
  "PREPARING",
  "READY",
  "PREPARATION_FAILED",
  "BUSY",
  "UNHEALTHY",
  "STOPPED",
  "RESUMING",
  "CLOSING",
  "CLOSED",
  // Spec 014: a thread's workspace record whose compute has not been prepared. Only Slack services
  // that send lazyPreparation: true are ever shown it.
  "UNPREPARED",
]);
```

In `packages/contracts/src/slack.ts`, after `SlackThreadWorkspaceResultSchema`, add:

```ts
// The answer to POST /v1/threads/workspace/prepare (spec 014). Only a service that sends
// lazyPreparation: true calls that route, so this schema never reaches an older service.
export const SlackThreadPrepareResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("WORKSPACE"),
      workspaceId: z.string().uuid(),
      status: WorkspaceStatusSchema,
      operationId: z.string().uuid().nullable(),
      // True only for the request whose write started this preparation.
      created: z.boolean(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("LIMIT_REACHED"),
      limit: SlackWorkspaceLimitSchema,
      maximum: z.number().int().positive(),
      starterThreads: z.array(SlackThreadSchema),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("CLOSED"),
      workspaceId: z.string().uuid(),
      closedAt: z.string().datetime(),
    })
    .strict(),
]);
```

and, with the other type exports at the end of the file:

```ts
export type SlackThreadPrepareResult = z.infer<typeof SlackThreadPrepareResultSchema>;
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm run build && npx vitest run tests/contract/lazy-workspace-contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add packages/contracts/src/workspace.ts packages/contracts/src/slack.ts tests/contract/lazy-workspace-contracts.test.ts
git commit -m "feat(contracts): UNPREPARED workspace status and the thread preparation result

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Broker creates a thread record without compute, on opt-in

**Files:**
- Modify: `packages/broker/src/aws/broker.ts`: `ensureThreadWorkspace` (about lines 1067-1169),
  `startThreadWorkspaceClose` (about line 882), and new functions after `ensureThreadWorkspace`
- Modify: `tests/support/slack-broker.ts` (append `lazyEnsureWorkspace`)
- Test: `tests/contract/slack-lazy-workspace.test.ts` (new)

**Interfaces:**
- Consumes: `WorkspaceStatusSchema` with `UNPREPARED` (Task 2); `registerSlackProject`,
  `serviceCall`, `fakeGitHubMcp`, `GITHUB_LIST_ISSUES` (Task 1).
- Produces:
  - request field `lazyPreparation: true` on `POST /v1/service/threads/workspace`;
  - broker functions `createUnpreparedThreadWorkspace(dependencies, identity, requestId, project, include, includeSettingsRevision): Promise<SlackThreadWorkspaceResult>`
    and `unpreparedWorkspace(project: RegisteredProjectRecord, ownerKey: string): WorkspaceInstance`;
  - `startThreadWorkspaceClose` answers `{ outcome: "NOT_FOUND" }` for an `UNPREPARED` workspace;
  - test helper `lazyEnsureWorkspace(handler: Handler, thread: string, slackUser: string, requestId?: string)`.

- [ ] **Step 1: Add the test helper**

Append to `tests/support/slack-broker.ts`:

```ts
/** The thread workspace request of a Slack service that opts in to lazy preparation (spec 014). */
export function lazyEnsureWorkspace(handler: Handler, thread: string, slackUser: string, requestId = randomUUID()) {
  return call(handler, {
    method: "POST",
    path: "/v1/service/threads/workspace",
    service: { principal: orchestratorPrincipal, thread, slackUser },
    body: {
      requestId, includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
      includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true,
    },
  });
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/contract/slack-lazy-workspace.test.ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import {
  GITHUB_LIST_ISSUES, SLACK_CHANNEL, SLACK_TEAM, createBroker, fakeGitHubMcp, lazyEnsureWorkspace, loadSlackBroker,
  registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const threadOne = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const threadTwo = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const pratik = "U0123456789";
const bob = "U0456789012";
const carol = "U0789012345";

beforeAll(async () => {
  await loadSlackBroker();
});

describe("lazy thread workspace records", () => {
  it("creates a thread record with no compute and no limit charge", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const created = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(created.status).toBe(200);
    delete created.body.requestId;
    const workspaceId = created.body.workspaceId as string;
    expect(SlackThreadWorkspaceResultSchema.parse(created.body)).toEqual({
      outcome: "WORKSPACE", workspaceId, status: "UNPREPARED", operationId: null, created: true,
      orchestratorInstructions: "Delegate work (revision 1).", connectors: [], repositories: ["demo"],
      recoverableOperations: [], settingsRevision: 1,
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED", fence: 0, projectRevision: 1, activeOperationId: null });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "OUTBOX")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    const threadRecord = db.find((item) => item.entityType === "SLACK_THREAD")[0];
    expect(threadRecord).toMatchObject({ thread: threadOne, workspaceId });
    expect(threadRecord).not.toHaveProperty("starterUserId");

    const followUp = await lazyEnsureWorkspace(handler, threadOne, bob);
    expect(followUp.body).toMatchObject({ workspaceId, status: "UNPREPARED", operationId: null, created: false });
  });

  it("gives a member any number of connector-only threads, past both limits", async () => {
    const { db, handler } = createBroker({ memberLimit: 1, organizationLimit: 2 });
    await registerSlackProject(handler);
    for (const ts of ["000001", "000002", "000003", "000004"]) {
      const created = await lazyEnsureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.${ts}`, pratik);
      expect(created.body).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED", created: true });
    }
    expect((await lazyEnsureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000005`, carol)).body).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(5);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });

  it("answers connector discovery and calls, and keeps the ledger, for a thread with no compute", async () => {
    const { githubMcp, invoke } = fakeGitHubMcp();
    const { db, handler } = createBroker({ githubMcp });
    await registerSlackProject(handler, { connectors: GITHUB_LIST_ISSUES });
    const created = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(created.body.connectors).toEqual([{ name: "github", type: "github", label: expect.any(String) as string, scopes: ["demo"], connected: true }]);
    const workspaceId = created.body.workspaceId as string;
    expect((await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`)).status).toBe(201);
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const catalog = ConnectorCatalogSchema.parse((await serviceCall(handler, threadOne, pratik, "GET", `${path}/tools`)).body.catalog);
    const requestId = randomUUID();
    const called = await serviceCall(handler, threadOne, pratik, "POST", `${path}/call`, {
      requestId, scope: "demo", tool: "list_issues", schemaHash: catalog.tools[0]!.scopes[0]!.schemaHash, arguments: {},
    });
    expect(called.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && String(item.sk).includes(requestId))).toHaveLength(1);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
  });

  it("refuses coding operations on a thread with no compute", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const conversation = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    const task = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
      requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "list the files",
    });
    expect(task.status).toBe(409);
    expect(task.body.error).toEqual({ code: "WORKSPACE_NOT_READY", message: "workspace is UNPREPARED" });
    const pullRequest = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, {
      requestId: randomUUID(), repository: "demo", title: "Fix",
    });
    expect(pullRequest.status).toBe(409);
    expect(pullRequest.body.error).toEqual({ code: "WORKSPACE_NOT_READY", message: "workspace is UNPREPARED" });
  });

  it("tells a connector-only thread there is nothing to close, and leaves it usable", async () => {
    const { db, handler, deleteWorkspaceSession } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const close = await serviceCall(handler, threadOne, bob, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(close.body).toMatchObject({ outcome: "NOT_FOUND" });
    expect(deleteWorkspaceSession).not.toHaveBeenCalled();
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    expect((await lazyEnsureWorkspace(handler, threadOne, pratik)).body).toMatchObject({ workspaceId, status: "UNPREPARED", created: false });
  });

  it("creates one record when two first messages race", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const results = await Promise.all([lazyEnsureWorkspace(handler, threadOne, pratik), lazyEnsureWorkspace(handler, threadOne, bob)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(new Set(results.map((result) => result.body.workspaceId)).size).toBe(1);
    expect(results.map((result) => result.body.created).sort()).toEqual([false, true]);
    expect(db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/slack-lazy-workspace.test.ts`
Expected: FAIL. The broker ignores `lazyPreparation` and returns `PREPARING` with a charge, and
close answers `WORKSPACE_BUSY`.

- [ ] **Step 4: Implement**

In `ensureThreadWorkspace`, after the `includeRecoverableOperations` line, add:

```ts
  // Spec 014, a separate opt-in: a service that sends lazyPreparation: true parses status
  // UNPREPARED and prepares compute through POST /v1/threads/workspace/prepare when a tool first
  // needs the worker. Every other service keeps getting a workspace whose compute is prepared now.
  const lazyPreparation = input.lazyPreparation === true;
```

Then, immediately after `const project = await requireLatestProject(dependencies, slack.binding.projectName);`
and before `const preparation = await newWorkspacePreparation(...)`, add:

```ts
  if (lazyPreparation) {
    return createUnpreparedThreadWorkspace(dependencies, identity, requestId, project, include, includeSettingsRevision);
  }
```

Add after `ensureThreadWorkspace`:

```ts
/**
 * Spec 014: a new thread's record with no compute and no limit charge. The workspace ID exists
 * from the first message because connector routes, the connector ledger and conversations are keyed
 * by it. startThreadPreparation prepares compute the first time the thread needs the worker.
 */
async function createUnpreparedThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  project: RegisteredProjectRecord,
  include: IntegrationInclude,
  includeSettingsRevision: boolean,
): Promise<SlackThreadWorkspaceResult> {
  const projectName = project.definition.name;
  const workspace = unpreparedWorkspace(project, identity.ownerKey);
  const existingMembership = await getMembership(dependencies, identity.ownerKey, projectName);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: dependencies.tableName, Item: workspaceItem(workspace), ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `OWNER#${identity.ownerKey}`, sk: `PROJECT#${projectName}`, entityType: "DEFAULT_WORKSPACE", workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
      { Put: { TableName: dependencies.tableName, Item: membershipRecord(identity.ownerKey, projectName, existingMembership?.role ?? "developer") } },
      { Put: {
        TableName: dependencies.tableName,
        Item: { pk: `IDEMPOTENCY#${identity.ownerKey}#THREAD`, sk: `REQUEST#${requestId}`, entityType: "IDEMPOTENCY", workspaceId: workspace.id },
        ConditionExpression: "attribute_not_exists(pk)",
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    // Another first message in this thread created the record.
    const concurrent = await getDefaultWorkspace(dependencies, identity.ownerKey, projectName);
    if (concurrent) return existingThreadWorkspace(dependencies, identity, requestId, concurrent, include, includeSettingsRevision);
    throw agentXError("WORKSPACE_BUSY", "thread workspace creation conflicted with another request; retry");
  }
  // The starter is recorded when compute is prepared, because that member is the one charged.
  await recordThreadRequester(dependencies, identity, workspace.id, false);
  return {
    outcome: "WORKSPACE",
    workspaceId: workspace.id,
    status: "UNPREPARED",
    operationId: null,
    created: true,
    orchestratorInstructions: project.definition.orchestratorInstructions,
    ...await threadIntegrations(project.definition, include, dependencies),
    ...(include.recoverableOperations ? { recoverableOperations: [] } : {}),
    ...(includeSettingsRevision ? { settingsRevision: project.definition.revision } : {}),
  };
}

/** A workspace record pinned to the thread's starting revision and runtime, with fence 0 and no operation. */
function unpreparedWorkspace(project: RegisteredProjectRecord, ownerKey: string): WorkspaceInstance {
  const now = new Date().toISOString();
  return WorkspaceInstanceSchema.parse({
    id: randomUUID(),
    ownerKey,
    projectName: project.definition.name,
    projectRevision: project.definition.revision,
    runtimeArn: project.runtimeBinding.runtimeArn,
    endpointQualifier: project.runtimeBinding.endpointQualifier,
    runtimeSessionId: randomUUID(),
    deploymentMode: project.runtimeBinding.deploymentMode,
    capacityProviderArn: project.runtimeBinding.capacityProviderArn,
    rootPath: "/mnt/workspace",
    status: "UNPREPARED",
    fence: 0,
    createdAt: now,
    updatedAt: now,
  });
}
```

In `startThreadWorkspaceClose`, directly after `if (!workspace) return { outcome: "NOT_FOUND" };`:

```ts
  // Spec 014: a thread that never needed the worker has no compute, so there is nothing to close.
  if (workspace.status === "UNPREPARED") return { outcome: "NOT_FOUND" };
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm run build && npx vitest run tests/contract/slack-lazy-workspace.test.ts tests/contract/slack-thread-characterization.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass, with
`tests/contract/slack-control-plane.test.ts` unchanged.

```bash
git add packages/broker/src/aws/broker.ts tests/support/slack-broker.ts tests/contract/slack-lazy-workspace.test.ts
git commit -m "feat(broker): create a Slack thread's workspace record without compute on opt-in

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Broker prepares compute on first use, charging the limit then

**Files:**
- Modify: `packages/broker/src/aws/broker.ts`: service router (about line 291), `ensureThreadWorkspace`
  existing-workspace branch, new functions `prepareThreadWorkspace` and `startThreadPreparation`
- Modify: `tests/support/slack-broker.ts` (append `prepareThread`)
- Test: `tests/contract/slack-lazy-workspace.test.ts` (append)

**Interfaces:**
- Consumes: `SlackThreadPrepareResult` (Task 2); `createUnpreparedThreadWorkspace` (Task 3);
  `finishOperation`, `ensureWorkspace`, `markReady` (Task 1 and existing).
- Produces:
  - route `POST /v1/service/threads/workspace/prepare` with body `{ requestId: uuid }`, answering
    `SlackThreadPrepareResult` with HTTP 200;
  - broker functions `prepareThreadWorkspace(dependencies, identity, value): Promise<SlackThreadPrepareResult>`
    and `startThreadPreparation(dependencies, identity, requestId, workspace): Promise<SlackThreadPrepareResult>`;
  - test helper `prepareThread(handler: Handler, thread: string, slackUser: string, requestId?: string)`.

- [ ] **Step 1: Add the test helper**

Append to `tests/support/slack-broker.ts`:

```ts
/** Asks the broker to prepare this thread's compute, as the lazy worker does (spec 014). */
export function prepareThread(handler: Handler, thread: string, slackUser: string, requestId = randomUUID()) {
  return call(handler, {
    method: "POST",
    path: "/v1/service/threads/workspace/prepare",
    service: { principal: orchestratorPrincipal, thread, slackUser },
    body: { requestId },
  });
}
```

- [ ] **Step 2: Write the failing tests**

Update the imports at the top of `tests/contract/slack-lazy-workspace.test.ts`:

```ts
import { SlackThreadPrepareResultSchema, SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import {
  GITHUB_LIST_ISSUES, SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, fakeGitHubMcp, finishOperation, lazyEnsureWorkspace,
  loadSlackBroker, markReady, prepareThread, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";
```

Append:

```ts
const PRE_LAZY_STATUSES = ["PREPARING", "READY", "PREPARATION_FAILED", "BUSY", "UNHEALTHY", "STOPPED", "RESUMING", "CLOSING", "CLOSED"];

function members(db: ReturnType<typeof createBroker>["db"]) {
  return db.find((item) => item.entityType === "SLACK_LIMIT" && String(item.sk).startsWith("MEMBER#"));
}

describe("preparing a thread's compute on first use", () => {
  it("prepares once, charges the member who asked, and pins the revision the thread started with", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    await registerSlackProject(handler, { revision: 2, bind: false });

    const prepared = await prepareThread(handler, threadOne, bob);
    expect(prepared.status).toBe(200);
    delete prepared.body.requestId;
    const result = SlackThreadPrepareResultSchema.parse(prepared.body);
    expect(result).toEqual({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId: expect.any(String) as string, created: true });
    const operationId = (result as { operationId: string }).operationId;
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING", activeOperationId: operationId, fence: 1, projectRevision: 1 });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({
      kind: "prepare", status: "ACCEPTED", fence: 1, requestedBy: { teamId: SLACK_TEAM, userId: bob },
    });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
    expect((outbox?.invocation as { payload: { project: { revision: number } } }).payload.project.revision).toBe(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toBeUndefined();
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "SLACK_THREAD")[0]).toMatchObject({ starterUserId: bob });

    // The model's settings follow the latest revision, as they do for every thread.
    expect((await lazyEnsureWorkspace(handler, threadOne, pratik)).body).toMatchObject({
      workspaceId, status: "PREPARING", operationId, created: false, settingsRevision: 2, orchestratorInstructions: "Delegate work (revision 2).",
    });
  });

  it("releases the preparing member's charge when the thread is closed", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const prepared = await prepareThread(handler, threadOne, bob);
    await finishOperation(handler, db, workspaceId, prepared.body.operationId as string, "SUCCEEDED");
    const started = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(started.body).toMatchObject({ outcome: "PREFLIGHT", workspaceId });
    await finishOperation(handler, db, workspaceId, started.body.operationId as string, "SUCCEEDED", { safeToClose: true, repositories: [] });
    const completed = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close/complete", {
      requestId: randomUUID(), operationId: started.body.operationId,
    });
    expect(completed.body).toMatchObject({ outcome: "CLOSED", workspaceId });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toMatchObject({ count: 0, threads: [] });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
  });

  it("refuses at the member limit, lists the member's prepared threads, and leaves the thread usable and uncharged", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    await prepareThread(handler, threadOne, pratik);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadTwo, pratik)).body.workspaceId as string;

    const refused = await prepareThread(handler, threadTwo, pratik);
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({
      outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1,
      starterThreads: [{ teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" }],
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED", fence: 0 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId)).toHaveLength(0);
    expect(db.find((item) => item.entityType === "SLACK_THREAD" && item.thread === threadTwo)[0]).not.toHaveProperty("starterUserId");
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
    expect((await lazyEnsureWorkspace(handler, threadTwo, pratik)).body).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED" });
  });

  it("refuses at the organization limit", async () => {
    const { handler } = createBroker({ organizationLimit: 1 });
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    await prepareThread(handler, threadOne, pratik);
    await lazyEnsureWorkspace(handler, threadTwo, bob);
    expect((await prepareThread(handler, threadTwo, bob)).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "ORGANIZATION", maximum: 1, starterThreads: [] });
  });

  it("prepares once when two requests race, and tells the second it is already being set up", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    const results = await Promise.all([prepareThread(handler, threadOne, pratik), prepareThread(handler, threadOne, bob)]);
    expect(results.map((result) => result.body.created).sort()).toEqual([false, true]);
    expect(results.every((result) => result.body.status === "PREPARING")).toBe(true);
    expect(new Set(results.map((result) => result.body.operationId)).size).toBe(1);
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "OUTBOX")).toHaveLength(1);
    expect(members(db).map((item) => item.count)).toEqual([1]);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
  });

  it("never exceeds the member limit when two threads race for the last slot", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    await lazyEnsureWorkspace(handler, threadOne, pratik);
    await lazyEnsureWorkspace(handler, threadTwo, pratik);
    const results = await Promise.all([prepareThread(handler, threadOne, pratik), prepareThread(handler, threadTwo, pratik)]);
    expect(results.map((result) => result.body.outcome).sort()).toEqual(["LIMIT_REACHED", "WORKSPACE"]);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
  });

  it("keeps today's retry for a preparation that failed, without a second charge", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const prepared = await prepareThread(handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, prepared.body.operationId as string, "FAILED");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });

    const next = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(next.body).toMatchObject({ workspaceId, status: "PREPARING", created: false });
    expect(next.body.operationId).not.toBe(prepared.body.operationId);
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(2);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
  });

  it("answers the current state, without preparing again, for a thread that already has compute", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    markReady(db, workspaceId);
    const answered = await prepareThread(handler, threadOne, bob);
    delete answered.body.requestId;
    expect(answered.body).toEqual({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toBeUndefined();
  });

  it("answers CLOSED for a closed thread", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await ensureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const record = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    record.status = "CLOSED";
    record.closedAt = "2026-09-25T10:00:00.000Z";
    delete record.activeOperationId;
    expect((await prepareThread(handler, threadOne, pratik)).body).toMatchObject({ outcome: "CLOSED", workspaceId, closedAt: "2026-09-25T10:00:00.000Z" });
  });

  it("refuses a thread that has no workspace record", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const refused = await prepareThread(handler, threadOne, pratik);
    expect(refused.status).toBe(404);
    expect(refused.body.error).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("an older Slack service and a thread with no compute", () => {
  it("prepares at once, and charges the limit, when an older service reaches the thread", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    // ensureWorkspace sends the request body of a Slack service from before lazy preparation.
    const older = await ensureWorkspace(handler, threadOne, bob);
    expect(older.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", created: true });
    expect(PRE_LAZY_STATUSES).toContain(older.body.status);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect((await ensureWorkspace(handler, threadOne, pratik)).body).toMatchObject({ status: "PREPARING", created: false });
  });

  it("gives an older service the limit refusal it already understands", async () => {
    const { handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    await ensureWorkspace(handler, threadOne, pratik);
    await lazyEnsureWorkspace(handler, threadTwo, pratik);
    expect((await ensureWorkspace(handler, threadTwo, pratik)).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1 });
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/slack-lazy-workspace.test.ts`
Expected: FAIL. The prepare route answers 404 "route not found", and the older-service test gets
status `UNPREPARED`.

- [ ] **Step 4: Implement**

Add `type SlackThreadPrepareResult` to the existing `@agentx/contracts` import list in `broker.ts`.

In the service router, after the `/v1/threads/workspace` branch:

```ts
        if (request.method === "POST" && serviceUrl.pathname === "/v1/threads/workspace/prepare") {
          return json(await prepareThreadWorkspace(dependencies, identity, parseBody(request.body)), request.requestId);
        }
```

In `ensureThreadWorkspace`, inside `if (existing) { ... }`, after the `CLOSED` return and before
`return existingThreadWorkspace(...)`:

```ts
    if (existing.status === "UNPREPARED" && !lazyPreparation) {
      // An older Slack service cannot parse UNPREPARED and expects compute now: prepare it at once.
      const prepared = await startThreadPreparation(dependencies, identity, requestId, existing);
      if (prepared.outcome !== "WORKSPACE") return prepared;
      const current = await requireWorkspace(dependencies, existing.id);
      const result = await existingThreadWorkspace(dependencies, identity, requestId, current, include, includeSettingsRevision);
      return result.outcome === "WORKSPACE" ? { ...result, created: prepared.created } : result;
    }
```

Add after `unpreparedWorkspace`:

```ts
/** POST /v1/threads/workspace/prepare (spec 014): prepares compute for this thread's workspace. */
async function prepareThreadWorkspace(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  value: unknown,
): Promise<SlackThreadPrepareResult> {
  const slack = identity.slack;
  if (!slack || !dependencies.slack) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  const input = object(value, "thread workspace preparation");
  const requestId = uuid(input.requestId, "requestId");
  const workspace = await getThreadWorkspace(dependencies, identity.ownerKey)
    ?? await getDefaultWorkspace(dependencies, identity.ownerKey, slack.binding.projectName);
  if (!workspace) throw agentXError("NOT_FOUND", "thread workspace not found");
  if (workspace.status === "CLOSED" && workspace.closedAt) {
    return { outcome: "CLOSED", workspaceId: workspace.id, closedAt: workspace.closedAt };
  }
  if (workspace.projectName !== slack.binding.projectName) {
    throw agentXError("FORBIDDEN", "this thread's workspace belongs to the channel's previous project binding");
  }
  return startThreadPreparation(dependencies, identity, requestId, workspace);
}

/**
 * Moves an UNPREPARED thread workspace to PREPARING. The same transaction writes the prepare
 * operation and outbox item, charges the requesting member and the organization, and records that
 * member as the thread's starter, whose charge closing releases. So a limit counts only prepared
 * threads. The disk is built from the revision the thread started with, as
 * retryWorkspacePreparation does. Any other status is answered as it stands: a racing request
 * prepared it already.
 */
async function startThreadPreparation(
  dependencies: AwsBrokerDependencies,
  identity: AuthenticatedIdentity,
  requestId: string,
  workspace: WorkspaceInstance,
): Promise<SlackThreadPrepareResult> {
  const slack = identity.slack;
  const limits = dependencies.slack;
  if (!slack || !limits) throw agentXError("FORBIDDEN", "a Slack thread identity is required");
  if (workspace.status !== "UNPREPARED") {
    return { outcome: "WORKSPACE", workspaceId: workspace.id, status: workspace.status, operationId: workspace.activeOperationId, created: false };
  }
  const pinned = await requireProject(dependencies, workspace.projectName, workspace.projectRevision);
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const fence = workspace.fence + 1;
  const operation = operationRecord({
    id: operationId,
    workspaceId: workspace.id,
    kind: "prepare",
    requestId,
    payloadHash: hashJson({ projectName: workspace.projectName, projectRevision: workspace.projectRevision, targetOwnerKey: identity.ownerKey }),
    status: "ACCEPTED",
    fence,
    createdAt: now,
    updatedAt: now,
    ...requesterOf(identity),
  });
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "prepare",
    operationId,
    workspaceId: workspace.id,
    fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspace.id, operationId, fence),
    payload: {
      project: pinned.definition,
      repositoryGrant: issueRepositoryGrant(dependencies, pinned, identity.ownerKey, workspace.id, operationId),
    },
  };
  const updated = WorkspaceInstanceSchema.parse({ ...workspace, status: "PREPARING", activeOperationId: operationId, fence, updatedAt: now });
  const outbox = outboxRecord(pinned.runtimeBinding, updated, invocation);
  const { teamId, userId } = slack.requester;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: workspaceKey(workspace.id),
        UpdateExpression: "SET #status = :preparing, activeOperationId = :operation, fence = :nextFence, updatedAt = :now",
        ConditionExpression: "ownerKey = :owner AND #status = :unprepared AND fence = :currentFence",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":owner": identity.ownerKey,
          ":preparing": "PREPARING",
          ":unprepared": "UNPREPARED",
          ":operation": operationId,
          ":nextFence": fence,
          ":currentFence": workspace.fence,
          ":now": now,
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: dependencies.tableName, Item: outbox, ConditionExpression: "attribute_not_exists(pk)" } },
      { Update: {
        TableName: dependencies.tableName,
        Key: slackOrganizationLimitKey(teamId),
        UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, entityType = :entity",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count" },
        ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": limits.organizationWorkspaceLimit, ":entity": "SLACK_LIMIT" },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: slackMemberLimitKey(teamId, userId),
        UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #threads = list_append(if_not_exists(#threads, :none), :thread), entityType = :entity",
        ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
        ExpressionAttributeNames: { "#count": "count", "#threads": "threads" },
        ExpressionAttributeValues: {
          ":zero": 0,
          ":one": 1,
          ":limit": limits.memberWorkspaceLimit,
          ":none": [],
          ":thread": [identity.subject],
          ":entity": "SLACK_LIMIT",
        },
      } },
      { Update: {
        TableName: dependencies.tableName,
        Key: slackThreadKey(identity.ownerKey),
        UpdateExpression: "SET starterUserId = :user",
        ConditionExpression: "attribute_not_exists(starterUserId)",
        ExpressionAttributeValues: { ":user": userId },
      } },
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    const current = await requireWorkspace(dependencies, workspace.id);
    if (current.status !== "UNPREPARED") {
      return { outcome: "WORKSPACE", workspaceId: current.id, status: current.status, operationId: current.activeOperationId, created: false };
    }
    const refusal = await threadWorkspaceLimitRefusal(dependencies, teamId, userId, limits);
    if (refusal.outcome !== "LIMIT_REACHED") {
      throw agentXError("WORKSPACE_BUSY", "thread workspace preparation conflicted with another request; retry");
    }
    return refusal;
  }
  return { outcome: "WORKSPACE", workspaceId: workspace.id, status: "PREPARING", operationId, created: true };
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm run build && npx vitest run tests/contract/slack-lazy-workspace.test.ts tests/contract/slack-thread-characterization.test.ts tests/contract/slack-control-plane.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add packages/broker/src/aws/broker.ts tests/support/slack-broker.ts tests/contract/slack-lazy-workspace.test.ts
git commit -m "feat(broker): prepare a thread's compute on first use and charge the limit only then

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: In-house tools prepare the worker only when they need it

**Files:**
- Modify: `packages/orchestrator/src/orchestration-tools.ts`, `packages/orchestrator/src/orchestrator.ts`
  (the `./orchestration-tools.js` import, `OrchestratorOptions`, the `createOrchestrationTools` call
  in `createOrchestratorRuntime`)
- Test: `tests/contract/worker-access.test.ts` (new)

**Interfaces:**
- Produces, from `orchestration-tools.ts`:
  - `interface WorkerRefusal { status: "WORKSPACE_LIMIT_REACHED" | "WORKSPACE_UNAVAILABLE"; message: string }`;
  - `interface WorkerAccess { prepared(): boolean; ensureReady(): Promise<WorkerRefusal | undefined> }`.
    `prepared()` is a plain, externally readable fact of whether this thread has compute this turn;
    it does not itself prepare anything. Phase 14c part 2's confirmation gate reads it, unprompted,
    to decide whether a call to `agentx_submit_task` counts as a write: a thread with no compute
    treats it as one (spec 014 D5), because it would create a workspace, not just run in one;
  - `WORKER_TOOL_NAMES = ["agentx_submit_task", "agentx_follow_up"] as const`;
  - `NO_WORKSPACE_TO_PUBLISH = { status: "NO_WORKSPACE", message: string }`;
  - `createOrchestrationTools(api, context, options)` accepts `options.worker?: WorkerAccess`.
- Produces, from `orchestrator.ts`: `OrchestratorOptions.worker?: WorkerAccess`, right after
  `replySurface` (the final field order across phases is `onConnectorUnavailable`, `replySurface`,
  `worker`, `actionGate`, `turnRecorder`, `modelRuntime`, where the last two came with spec 013
  phase 4; do not anchor this insertion on `replySurface` being the last member, because 14c adds
  `actionGate` after it).
- Consumed by: Task 6 (`createLazyWorker` returns a `WorkerAccess`; `TurnInput.worker`); 14c part 2
  (the confirmation gate reads `WorkerAccess.prepared()`, spec 014 D5).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/worker-access.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  NO_WORKSPACE_TO_PUBLISH, ORCHESTRATION_TOOL_NAMES, WORKER_TOOL_NAMES, createOrchestrationTools, type WorkerAccess,
} from "../../packages/orchestrator/src/orchestration-tools.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import { createFixtureDirectory } from "../fixtures/index.js";

type ToolName = (typeof ORCHESTRATION_TOOL_NAMES)[number];
const OPERATION = "11111111-1111-4111-8111-111111111111";
const context = { workspaceId: "22222222-2222-4222-8222-222222222222", conversationId: "33333333-3333-4333-8333-333333333333" };
const refusal = { status: "WORKSPACE_LIMIT_REACHED" as const, message: "No coding work can run in this thread." };

// One rule per in-house tool. Adding a tool without a rule fails the first test.
const WORKER_RULE = {
  agentx_submit_task: "prepares",
  agentx_follow_up: "prepares",
  agentx_create_pull_request: "needs-prepared",
  agentx_task_status: "never",
  agentx_task_result: "never",
  agentx_manage_pull_request: "never",
} satisfies Record<ToolName, "prepares" | "needs-prepared" | "never">;

const PARAMETERS: Record<ToolName, Record<string, unknown>> = {
  agentx_submit_task: { prompt: "list the files" },
  agentx_follow_up: { prompt: "and the tests" },
  agentx_create_pull_request: { repository: "demo", title: "Fix" },
  agentx_task_status: { operationId: OPERATION },
  agentx_task_result: { operationId: OPERATION },
  agentx_manage_pull_request: { repository: "demo", pullRequestNumber: 7, action: "close" },
};

function fakeApi() {
  return {
    submitTask: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    taskStatus: vi.fn().mockResolvedValue({ id: OPERATION, status: "RUNNING" }),
    taskResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED" }),
    followUp: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    createPullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    managePullRequest: vi.fn().mockResolvedValue({ operation: { id: OPERATION } }),
    pullRequestResult: vi.fn().mockResolvedValue({ operationId: OPERATION, status: "SUCCEEDED" }),
    callConnectorTool: vi.fn().mockResolvedValue({ requestId: OPERATION, status: "SUCCEEDED", text: "2 open", replayed: false, truncated: false }),
  };
}

// Plain properties, not methods, so a test can read the ensureReady mock on its own.
function worker(prepared: boolean, answer?: typeof refusal) {
  return { prepared: () => prepared, ensureReady: vi.fn(async (): Promise<typeof refusal | undefined> => answer) } satisfies WorkerAccess;
}

function run(tools: ReturnType<typeof createOrchestrationTools>, name: string, parameters: Record<string, unknown>) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`${name} is missing`);
  return tool.execute("call-1", parameters, undefined, undefined, {} as never);
}

describe("which in-house tools need the worker", () => {
  it("has exactly one worker rule per in-house tool", () => {
    expect(Object.keys(WORKER_RULE).sort()).toEqual([...ORCHESTRATION_TOOL_NAMES].sort());
    expect([...WORKER_TOOL_NAMES].sort()).toEqual(Object.entries(WORKER_RULE).filter(([, rule]) => rule === "prepares").map(([name]) => name).sort());
  });

  it.each(ORCHESTRATION_TOOL_NAMES)("%s follows its worker rule in a thread with no compute", async (name) => {
    const api = fakeApi();
    const access = worker(false);
    const result = await run(createOrchestrationTools(api, context, { worker: access }), name, PARAMETERS[name]);
    expect(access.ensureReady).toHaveBeenCalledTimes(WORKER_RULE[name] === "prepares" ? 1 : 0);
    if (WORKER_RULE[name] === "needs-prepared") {
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(NO_WORKSPACE_TO_PUBLISH) }]);
      expect(api.createPullRequest).not.toHaveBeenCalled();
    }
  });

  it("publishes as today once the thread has compute", async () => {
    const api = fakeApi();
    await run(createOrchestrationTools(api, context, { worker: worker(true) }), "agentx_create_pull_request", PARAMETERS.agentx_create_pull_request);
    expect(api.createPullRequest).toHaveBeenCalledOnce();
  });

  it("exposes prepared() as a plain fact a caller can read directly, without going through a tool (spec 014 D5: 14c's confirmation gate reads it)", () => {
    expect(worker(false).prepared()).toBe(false);
    expect(worker(true).prepared()).toBe(true);
  });

  it("hands a refusal to the model, starts no work and uses no request ID", async () => {
    const api = fakeApi();
    const requestId = vi.fn(() => OPERATION);
    for (const name of WORKER_TOOL_NAMES) {
      const result = await run(createOrchestrationTools(api, context, { worker: worker(false, refusal), requestId }), name, PARAMETERS[name]);
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(refusal) }]);
    }
    expect(api.submitTask).not.toHaveBeenCalled();
    expect(api.followUp).not.toHaveBeenCalled();
    expect(requestId).not.toHaveBeenCalled();
  });

  it("never prepares for a connector tool", async () => {
    const api = fakeApi();
    const access = worker(false);
    const catalog = {
      connector: "github", skipped: [],
      tools: [{ name: "github__list_issues", upstreamName: "list_issues", description: "List issues", access: "read" as const,
        scopes: [{ alias: "demo", schemaHash: "a".repeat(64) }], inputSchema: { type: "object", properties: {} } }],
    };
    await run(createOrchestrationTools(api, context, { worker: access, connectorCatalogs: [catalog] }), "github__list_issues", {});
    expect(api.callConnectorTool).toHaveBeenCalledOnce();
    expect(access.ensureReady).not.toHaveBeenCalled();
  });

  it("hands the worker handle from the orchestrator runtime to the task tools", async () => {
    const api = fakeApi();
    const access = worker(false, refusal);
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-worker-access-"), projectInstructions: "Delegate.", api, context,
      model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" }, worker: access,
    });
    try {
      const result = await runtime.session.getToolDefinition("agentx_submit_task")!.execute("call-1", { prompt: "list" }, undefined, undefined, {} as never);
      expect(access.ensureReady).toHaveBeenCalledOnce();
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(refusal) }]);
      expect(api.submitTask).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/worker-access.test.ts`
Expected: FAIL. `WORKER_TOOL_NAMES` and `NO_WORKSPACE_TO_PUBLISH` are not exported, and the tools
ignore `worker`.

- [ ] **Step 3: Implement**

In `packages/orchestrator/src/orchestration-tools.ts`, after `RECOVERY_TOOL_NAMES`:

```ts
/** In-house tools that run on the remote worker, so a thread without compute prepares it first (spec 014). */
export const WORKER_TOOL_NAMES = ["agentx_submit_task", "agentx_follow_up"] as const;

/** Why a tool that needs the worker cannot run; handed to the model as the tool result. */
export interface WorkerRefusal {
  status: "WORKSPACE_LIMIT_REACHED" | "WORKSPACE_UNAVAILABLE";
  message: string;
}

/** A thread's worker, prepared on first use. Absent for a thread that already has compute. */
export interface WorkerAccess {
  /**
   * True once this thread has prepared compute in this turn. A plain, externally readable fact,
   * not just an internal detail of these tools: 14c part 2's confirmation gate reads it to decide
   * whether agentx_submit_task counts as a write (spec 014 D5).
   */
  prepared(): boolean;
  /** Prepares compute once per turn. Undefined when the worker can take work; otherwise a refusal. */
  ensureReady(): Promise<WorkerRefusal | undefined>;
}

/** A thread with no compute has no changes to publish; preparing a fresh clone would not change that. */
export const NO_WORKSPACE_TO_PUBLISH = {
  status: "NO_WORKSPACE",
  message: "This thread has no workspace yet, so it has no changes to publish. Run the coding work with agentx_submit_task first.",
} as const;
```

Add `worker` to the options type of `createOrchestrationTools`. Spec 013 phase 4 split that type
over several lines and added `onConnectorError`, so replace

```ts
    onConnectorError?: (toolCallId: string, code: string) => void;
  } = {},
```

with

```ts
    onConnectorError?: (toolCallId: string, code: string) => void;
    /** Spec 014: present only for a thread whose compute is not prepared yet. */
    worker?: WorkerAccess;
  } = {},
```

At the start of the `execute` of `agentx_submit_task`, and again at the start of the `execute` of
`agentx_follow_up`, before `api.submitTask` or `api.followUp` and before `nextRequestId()`:

```ts
        const refusal = await options.worker?.ensureReady();
        if (refusal) return toolResult(refusal);
```

At the start of the `execute` of `agentx_create_pull_request`:

```ts
        if (options.worker && !options.worker.prepared()) return toolResult(NO_WORKSPACE_TO_PUBLISH);
```

`agentx_task_status`, `agentx_task_result`, `agentx_manage_pull_request` and the connector tools
are not edited.

In `packages/orchestrator/src/orchestrator.ts`, import the type:

```ts
import {
  RETIRED_PULL_REQUEST_TOOLS,
  assertOrchestrationOnly,
  createOrchestrationTools,
  type OrchestrationApi,
  type OrchestrationContext,
  type WorkerAccess,
} from "./orchestration-tools.js";
```

Add `worker` to `OrchestratorOptions` right after `replySurface` (which phase 14a already added
after `onConnectorUnavailable`): the final field order across phases is `onConnectorUnavailable`,
`replySurface`, `worker`, `actionGate`, `turnRecorder`, `modelRuntime`, so this insertion point must
not depend on `replySurface` still being the last member (14c adds `actionGate` after it). Replace

```ts
  replySurface?: ReplySurface;
```

with

```ts
  replySurface?: ReplySurface;
  /** Spec 014: present only for a thread whose compute is not prepared yet. */
  worker?: WorkerAccess;
```

and pass it to the tools, keeping spec 013 phase 4's `onConnectorError` line. Replace

```ts
    ...(recorder === undefined ? {} : { onConnectorError: (toolCallId: string, code: string) => recorder.connectorFailed(toolCallId, code) }),
  });
```

with

```ts
    ...(recorder === undefined ? {} : { onConnectorError: (toolCallId: string, code: string) => recorder.connectorFailed(toolCallId, code) }),
    ...(options.worker === undefined ? {} : { worker: options.worker }),
  });
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npm run build && npx vitest run tests/contract/worker-access.test.ts tests/contract/orchestration-tools-characterization.test.ts tests/contract/orchestrator-boundary.test.ts tests/contract/tool-presentation.test.ts`
Expected: PASS, with no snapshot written or updated.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass, and
`git status` shows no change under `tests/contract/__snapshots__/`.

```bash
git add packages/orchestrator/src/orchestration-tools.ts packages/orchestrator/src/orchestrator.ts tests/contract/worker-access.test.ts
git commit -m "feat(orchestrator): task tools prepare the thread's worker on first use

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Slack service prepares lazily, dormant until it opts in

**Files:**
- Create: `packages/slack-service/src/messages.ts`, `packages/slack-service/src/lazy-worker.ts`,
  `packages/slack-service/src/thread-api.ts`
- Modify: `packages/slack-service/src/processor.ts`, `packages/slack-service/src/runtime.ts`,
  `packages/slack-service/src/main.ts:95-153`
- Test: `tests/integration/slack-lazy-worker.test.ts` (new), `tests/contract/thread-api.test.ts` (new)

**Interfaces:**
- Consumes: `WorkerAccess`, `WorkerRefusal` (Task 5); `SlackThreadPrepareResult`,
  `SlackThreadPrepareResultSchema` (Task 2); the prepare route (Task 4).
- Produces:
  - `messages.ts`: `NEW_WORKSPACE_MESSAGE`, `STILL_PREPARING_MESSAGE`,
    `preparationFailedMessage(status: string): string`,
    `limitMessage(result: { limit: SlackWorkspaceLimit; maximum: number; starterThreads: readonly SlackThread[] }): string`;
  - `lazy-worker.ts`: `createLazyWorker(input: { api: Pick<ThreadServiceApi, "prepareWorkspace" | "waitForOperation">; post: (text: string) => Promise<void>; log: ServiceLog; eventId: string }): WorkerAccess`,
    `LIMIT_REFUSAL: WorkerRefusal`, `unavailableRefusal(reason: string): WorkerRefusal`;
  - `thread-api.ts`: `createThreadApi(options: { controlPlaneUrl: string; signedFetch: typeof fetch; pollIntervalMilliseconds?: number }): ThreadServiceApi`;
  - `processor.ts`: `ThreadServiceApi.prepareWorkspace?(requestId: string): Promise<SlackThreadPrepareResult>`,
    `TurnInput.worker?: WorkerAccess`.
- Consumed by: Task 7.
- **Note on 14a's `processor.ts` change.** Phase 14a already changed the reply-posting lines
  (`draft.responseText = slackReplyText(response);` and
  `for (const chunk of splitSlackMessage(slackReplyText(response))) await post(chunk);`, near the
  end of `processSlackRequest`) and added an `import { slackReplyText } from "./slack-format.js";`
  next to the `./ids.js` import. This task's edits below (the `@agentx/contracts` and new-file imports, the
  preparation block, the code directly before `await post("Working on it now. ...")`, the
  `runTurn` call's arguments, and deleting the private `limitMessage` function) are all at other
  points in the file and do not touch those lines or that import, so no anchor here needs to change.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/slack-lazy-worker.test.ts
import { describe, expect, it, vi } from "vitest";
import type { SlackRequestMessage, SlackThreadPrepareResult, SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { deterministicUuid } from "../../packages/slack-service/src/ids.js";
import { LIMIT_REFUSAL, createLazyWorker, unavailableRefusal } from "../../packages/slack-service/src/lazy-worker.js";
import { processSlackRequest, type ProcessorDependencies, type TurnInput } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const otherThread = { ...thread, threadTs: "1695500000.000002" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const conversationId = "33333333-3333-4333-8333-333333333333";
const WORKING = "Working on it now. I'll post the result in this thread when it's done.";
const SETTING_UP = "Setting up a new workspace for this thread. The first request takes a few minutes.";
const STILL = "This thread's workspace is still being set up. I'll start as soon as it's ready.";
const MEMBER_LIMIT = [
  "You already have 3 AgentX workspaces, the most one person can have, so I can't start a new one. Continue in one of your existing threads instead:",
  "• <https://slack.com/archives/C0123456789/p1695500000000001|Thread 1>",
  "• <https://slack.com/archives/C0123456789/p1695500000000002|Thread 2>",
].join("\n");
const started: SlackThreadPrepareResult = { outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId, created: true };

function lazyHarness(prepare: SlackThreadPrepareResult | Error, waited = "SUCCEEDED") {
  const posts: string[] = [];
  const logs: string[] = [];
  const prepareWorkspace = vi.fn(async () => {
    if (prepare instanceof Error) throw prepare;
    return prepare;
  });
  const waitForOperation = vi.fn(async () => ({ status: waited }));
  const worker = createLazyWorker({
    api: { prepareWorkspace, waitForOperation },
    post: async (text) => {
      posts.push(text);
    },
    log: (event) => {
      logs.push(event);
    },
    eventId: "Ev0000000001",
  });
  return { worker, posts, logs, prepareWorkspace, waitForOperation };
}

describe("the lazy worker", () => {
  it("prepares once for parallel tool calls and says so once", async () => {
    const h = lazyHarness(started);
    expect(h.worker.prepared()).toBe(false);
    expect(await Promise.all([h.worker.ensureReady(), h.worker.ensureReady()])).toEqual([undefined, undefined]);
    expect(h.prepareWorkspace).toHaveBeenCalledExactlyOnceWith(deterministicUuid("Ev0000000001:prepare"));
    expect(h.waitForOperation).toHaveBeenCalledExactlyOnceWith(workspaceId, operationId);
    expect(h.posts).toEqual([SETTING_UP]);
    expect(h.worker.prepared()).toBe(true);
    expect(await h.worker.ensureReady()).toBeUndefined();
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
  });

  it("tells the thread another request is already setting it up", async () => {
    const h = lazyHarness({ ...started, created: false });
    expect(await h.worker.ensureReady()).toBeUndefined();
    expect(h.posts).toEqual([STILL]);
  });

  it("continues at once when another request already finished preparing", async () => {
    const h = lazyHarness({ outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false });
    expect(await h.worker.ensureReady()).toBeUndefined();
    expect(h.posts).toEqual([]);
    expect(h.waitForOperation).not.toHaveBeenCalled();
    expect(h.worker.prepared()).toBe(true);
  });

  it("posts the limit with the member's threads and refuses, without retrying in the turn", async () => {
    const h = lazyHarness({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [thread, otherThread] });
    expect(await h.worker.ensureReady()).toEqual(LIMIT_REFUSAL);
    expect(LIMIT_REFUSAL.message).toMatch(/Do not retry/);
    expect(LIMIT_REFUSAL.message).toMatch(/answer any part of the request that does not need the worker/);
    expect(h.posts).toEqual([MEMBER_LIMIT]);
    expect(await h.worker.ensureReady()).toEqual(LIMIT_REFUSAL);
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
    expect(h.worker.prepared()).toBe(false);
    expect(h.logs).toEqual(["request.limit_reached"]);
  });

  it("reports a failed setup in the thread and refuses the worker for the rest of the turn", async () => {
    const h = lazyHarness(started, "FAILED");
    expect(await h.worker.ensureReady()).toEqual(unavailableRefusal("workspace setup failed"));
    expect(h.posts).toEqual([SETTING_UP, "AgentX could not set up this thread's workspace (FAILED). Mention me again in this thread to retry."]);
    expect(await h.worker.ensureReady()).toEqual(unavailableRefusal("workspace setup failed"));
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
    expect(h.logs).toEqual(["workspace.preparation_failed"]);
  });

  it("refuses without posting when the thread's workspace is closed", async () => {
    const h = lazyHarness({ outcome: "CLOSED", workspaceId, closedAt: "2026-09-25T10:00:00.000Z" });
    expect(await h.worker.ensureReady()).toEqual(unavailableRefusal("this thread's workspace is closed; start a new Slack thread for coding work"));
    expect(h.posts).toEqual([]);
  });

  it("fails the tool call, once per turn, when the control plane cannot be reached", async () => {
    const h = lazyHarness(new Error("thread workspace preparation failed: 503"));
    await expect(h.worker.ensureReady()).rejects.toThrow(/503/);
    await expect(h.worker.ensureReady()).rejects.toThrow(/503/);
    expect(h.prepareWorkspace).toHaveBeenCalledOnce();
  });
});

function message(): SlackRequestMessage {
  return { version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text: "what's open in Linear?", receivedAt: "2026-09-25T10:00:00.000Z" };
}

function workspaceResult(overrides: Record<string, unknown>): SlackThreadWorkspaceResult {
  return { outcome: "WORKSPACE", workspaceId, operationId: null, created: false, orchestratorInstructions: "Delegate work.", ...overrides } as SlackThreadWorkspaceResult;
}

function processorHarness(result: SlackThreadWorkspaceResult, turn: (input: TurnInput) => Promise<string>, prepare: SlackThreadPrepareResult = started) {
  const posts: string[] = [];
  const turns: TurnInput[] = [];
  const saved: Array<{ workspaceId: string; conversationId: string }> = [];
  const prepareWorkspace = vi.fn(async () => prepare);
  const waitForOperation = vi.fn(async () => ({ status: "SUCCEEDED" }));
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => result,
      prepareWorkspace,
      startClose: async () => ({ outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation,
      createConversation: async () => conversationId,
    }),
    threads: {
      load: async () => ({}),
      saveConversation: async (_subject, state) => {
        saved.push(state);
      },
      saveSettingsRevision: async () => undefined,
      close: async () => undefined,
      finish: async () => undefined,
    },
    runTurn: async (input) => {
      turns.push(input);
      return turn(input);
    },
    post: async (_thread, text) => {
      posts.push(text);
    },
  };
  return { dependencies, posts, turns, saved, prepareWorkspace, waitForOperation };
}

describe("processing a thread with no compute", () => {
  it("answers without setting up a workspace when the turn never needs the worker", async () => {
    const h = processorHarness(workspaceResult({ status: "UNPREPARED", created: true }), async () => "3 issues are open.");
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "3 issues are open."]);
    expect(h.prepareWorkspace).not.toHaveBeenCalled();
    expect(h.waitForOperation).not.toHaveBeenCalled();
    expect(h.turns[0]?.worker?.prepared()).toBe(false);
    expect(h.saved).toEqual([{ workspaceId, conversationId }]);
  });

  it("sets up the workspace mid-turn, once, when the turn first needs the worker", async () => {
    const h = processorHarness(workspaceResult({ status: "UNPREPARED" }), async (input) => {
      expect(await input.worker!.ensureReady()).toBeUndefined();
      return "Listed the files.";
    });
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, SETTING_UP, "Listed the files."]);
    expect(h.prepareWorkspace).toHaveBeenCalledExactlyOnceWith(deterministicUuid("Ev0000000001:prepare"));
  });

  it("still answers when the limit stops the worker part", async () => {
    const h = processorHarness(
      workspaceResult({ status: "UNPREPARED" }),
      async (input) => {
        expect(await input.worker!.ensureReady()).toEqual(LIMIT_REFUSAL);
        return "3 issues are open. The coding part did not run.";
      },
      { outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 3, starterThreads: [thread, otherThread] },
    );
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, MEMBER_LIMIT, "3 issues are open. The coding part did not run."]);
  });

  it("gives a thread that already has compute no worker handle, as with an older control plane", async () => {
    const h = processorHarness(workspaceResult({ status: "PREPARING", operationId, created: true }), async () => "done");
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([SETTING_UP, WORKING, "done"]);
    expect(h.turns[0]).not.toHaveProperty("worker");
    expect(h.prepareWorkspace).not.toHaveBeenCalled();
  });
});

describe("the hosted runtime and the lazy worker", () => {
  it("hands the worker handle to the task tools", async () => {
    const access = { prepared: () => false, ensureReady: vi.fn(async () => unavailableRefusal("no workspace")) };
    const api = { submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() };
    const runtime = await createHostedSlackRuntime(
      { message: message(), subject: "T0BSHLLUGBD/C0123456789/1695500000.000001", workspaceId, conversationId, orchestratorInstructions: "Delegate.", requestId: () => operationId, worker: access },
      { stateDirectory: await createFixtureDirectory("agentx-lazy-runtime-"), api, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" } },
    );
    try {
      const result = await runtime.session.getToolDefinition("agentx_submit_task")!.execute("call-1", { prompt: "list" }, undefined, undefined, {} as never);
      expect(access.ensureReady).toHaveBeenCalledOnce();
      expect(api.submitTask).not.toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(unavailableRefusal("no workspace")) }]);
    } finally {
      await runtime.dispose();
    }
  });
});
```

```ts
// tests/contract/thread-api.test.ts
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { parseSlackThreadSubject } from "../../packages/contracts/src/slack.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { brokerFetch } from "../support/broker-fetch.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, createBroker, lazyEnsureWorkspace, loadSlackBroker, registerSlackProject, type Handler,
} from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const pratik = "U0123456789";

beforeAll(async () => {
  await loadSlackBroker();
});

function threadApi(handler: Handler) {
  const signedFetch = createSignedServiceFetch({
    region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    thread: parseSlackThreadSubject(thread), userId: pratik, baseFetch: brokerFetch(handler),
  });
  return createThreadApi({ controlPlaneUrl: "https://agentx.example.test", signedFetch });
}

describe("the Slack service's thread client", () => {
  it("prepares a thread with no compute through the prepare route", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    expect(await threadApi(handler).prepareWorkspace!(randomUUID())).toEqual({
      outcome: "WORKSPACE", workspaceId, status: "PREPARING", operationId: expect.any(String) as string, created: true,
    });
  });

  it("answers a close request in an empty thread as before the move", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    expect(await threadApi(handler).startClose(randomUUID())).toEqual({ outcome: "NOT_FOUND" });
  });

  it("reports a refused request with the broker's code, as before the move", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler, { bind: false });
    await expect(threadApi(handler).ensureWorkspace(randomUUID())).rejects.toThrow(/^thread workspace request failed: FORBIDDEN /);
    await expect(threadApi(handler).prepareWorkspace!(randomUUID())).rejects.toThrow(/^thread workspace preparation failed: FORBIDDEN /);
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/integration/slack-lazy-worker.test.ts tests/contract/thread-api.test.ts`
Expected: FAIL. `lazy-worker.js` and `thread-api.js` do not exist.

- [ ] **Step 3: Move the thread messages**

Create `packages/slack-service/src/messages.ts`. `limitMessage` moves verbatim from
`processor.ts`; only its parameter type widens to the fields it reads:

```ts
import { slackThreadUrl, type SlackThread, type SlackWorkspaceLimit } from "@agentx/contracts";

export const NEW_WORKSPACE_MESSAGE = "Setting up a new workspace for this thread. The first request takes a few minutes.";
export const STILL_PREPARING_MESSAGE = "This thread's workspace is still being set up. I'll start as soon as it's ready.";

export function preparationFailedMessage(status: string): string {
  return `AgentX could not set up this thread's workspace (${status}). Mention me again in this thread to retry.`;
}

export function limitMessage(result: { limit: SlackWorkspaceLimit; maximum: number; starterThreads: readonly SlackThread[] }): string {
  if (result.limit === "ORGANIZATION") {
    return `This organization already has ${result.maximum} AgentX workspaces, the most allowed, so I can't start a new one. ` +
      "Continue in an existing thread, or ask an administrator to raise the limit.";
  }
  const links = result.starterThreads.map((thread, index) => `• <${slackThreadUrl(thread)}|Thread ${index + 1}>`);
  return [
    `You already have ${result.maximum} AgentX workspaces, the most one person can have, so I can't start a new one. ` +
      "Continue in one of your existing threads instead:",
    ...links,
  ].join("\n");
}
```

- [ ] **Step 4: Create the lazy worker**

```ts
// packages/slack-service/src/lazy-worker.ts
import type { WorkerAccess, WorkerRefusal } from "@agentx/orchestrator";
import { deterministicUuid } from "./ids.js";
import { NEW_WORKSPACE_MESSAGE, STILL_PREPARING_MESSAGE, limitMessage, preparationFailedMessage } from "./messages.js";
import type { ServiceLog, ThreadServiceApi } from "./processor.js";

const READY_STATUSES = new Set(["READY", "STOPPED", "BUSY"]);
const CONTINUE = "Do not retry this tool in this turn; answer any part of the request that does not need the worker, and say the coding part did not run.";

export const LIMIT_REFUSAL: WorkerRefusal = {
  status: "WORKSPACE_LIMIT_REACHED",
  message: `No coding work can run in this thread because the workspace limit is reached. AgentX has told the member in the thread and linked their existing threads. ${CONTINUE}`,
};

export function unavailableRefusal(reason: string): WorkerRefusal {
  return { status: "WORKSPACE_UNAVAILABLE", message: `No coding work can run in this thread right now: ${reason}. ${CONTINUE}` };
}

/**
 * Spec 014: a turn's handle on a thread whose compute is not prepared. The first tool that needs
 * the worker prepares it; parallel calls share that one attempt, and its outcome, including a
 * refusal or an error, holds for the rest of the turn. The next Slack message tries again.
 */
export function createLazyWorker(input: {
  api: Pick<ThreadServiceApi, "prepareWorkspace" | "waitForOperation">;
  post: (text: string) => Promise<void>;
  log: ServiceLog;
  eventId: string;
}): WorkerAccess {
  let ready = false;
  let attempt: Promise<WorkerRefusal | undefined> | undefined;

  async function prepare(): Promise<WorkerRefusal | undefined> {
    if (!input.api.prepareWorkspace) return unavailableRefusal("this Slack service cannot prepare workspaces");
    const result = await input.api.prepareWorkspace(deterministicUuid(`${input.eventId}:prepare`));
    if (result.outcome === "LIMIT_REACHED") {
      input.log("request.limit_reached", { eventId: input.eventId, limit: result.limit, maximum: result.maximum });
      await input.post(limitMessage(result));
      return LIMIT_REFUSAL;
    }
    if (result.outcome === "CLOSED") return unavailableRefusal("this thread's workspace is closed; start a new Slack thread for coding work");
    if (result.status === "PREPARING" && result.operationId) {
      await input.post(result.created ? NEW_WORKSPACE_MESSAGE : STILL_PREPARING_MESSAGE);
      const prepared = await input.api.waitForOperation(result.workspaceId, result.operationId);
      if (prepared.status !== "SUCCEEDED") {
        input.log("workspace.preparation_failed", { eventId: input.eventId, status: prepared.status });
        await input.post(preparationFailedMessage(prepared.status));
        return unavailableRefusal(`workspace setup ${prepared.status.toLowerCase()}`);
      }
      return undefined;
    }
    if (READY_STATUSES.has(result.status)) return undefined;
    input.log("workspace.unavailable", { eventId: input.eventId, status: result.status });
    return unavailableRefusal(`this thread's workspace is ${result.status}`);
  }

  return {
    prepared: () => ready,
    ensureReady() {
      if (ready) return Promise.resolve(undefined);
      attempt ??= prepare().then((refusal) => {
        if (refusal === undefined) ready = true;
        return refusal;
      });
      return attempt;
    },
  };
}
```

- [ ] **Step 5: Change the processor and the hosted runtime**

In `packages/slack-service/src/processor.ts`:

1. Imports. Remove `slackThreadUrl` from the `@agentx/contracts` import list (the separate
   `export { slackThreadUrl } from "@agentx/contracts";` line stays), add
   `type SlackThreadPrepareResult` to it, and add:

```ts
import type { WorkerAccess } from "@agentx/orchestrator";
import { createLazyWorker } from "./lazy-worker.js";
import { NEW_WORKSPACE_MESSAGE, STILL_PREPARING_MESSAGE, limitMessage, preparationFailedMessage } from "./messages.js";
```

2. In `ThreadServiceApi`, after `ensureWorkspace`:

```ts
  /** Spec 014: prepares compute for a thread whose workspace is UNPREPARED. */
  prepareWorkspace?(requestId: string): Promise<SlackThreadPrepareResult>;
```

3. In `TurnInput`, after `recoverableOperations?`:

```ts
  /** Spec 014: present only when the thread's compute is not prepared yet. */
  worker?: WorkerAccess;
```

4. Replace the preparation block, from `if (workspace.status === "PREPARING" && workspace.operationId) {`
   through `} else if (!RUNNABLE_STATUSES.has(workspace.status)) {`, with the same logic and strings,
   now from `messages.ts`, and let `UNPREPARED` run. Spec 013 phase 4's
   `draft.disposition = "workspace_unavailable";` lines stay, so the turn record still says why the
   turn did not run:

```ts
    if (workspace.status === "PREPARING" && workspace.operationId) {
      await post(workspace.created ? NEW_WORKSPACE_MESSAGE : STILL_PREPARING_MESSAGE);
      const prepared = await api.waitForOperation(workspace.workspaceId, workspace.operationId);
      if (prepared.status !== "SUCCEEDED") {
        draft.disposition = "workspace_unavailable";
        log("workspace.preparation_failed", { eventId: message.eventId, status: prepared.status });
        await post(preparationFailedMessage(prepared.status));
        finished = true;
        return;
      }
    } else if (workspace.status !== "UNPREPARED" && !RUNNABLE_STATUSES.has(workspace.status)) {
```

   The body of the `else if`, including its `draft.disposition` line, is unchanged. A lazy
   preparation that fails or meets the limit during a turn does not change the disposition: the
   turn still ran and is `answered`, and the turn record shows the refusing tool call with outcome
   `FAILED` (its result status `WORKSPACE_LIMIT_REACHED` or `WORKSPACE_UNAVAILABLE` is not a known
   operation status).

5. Directly before `await post("Working on it now. ...")`:

```ts
    // Spec 014: a thread without compute prepares it only when a tool first needs the worker.
    const worker = workspace.status === "UNPREPARED"
      ? createLazyWorker({ api, post, log, eventId: message.eventId })
      : undefined;
```

6. In the `runTurn` input, after the `recoverableOperations` spread:

```ts
        ...(worker === undefined ? {} : { worker }),
```

7. Delete the private `limitMessage` function at the end of the file (it now lives in
   `messages.ts`).

In `packages/slack-service/src/runtime.ts`, add after the `recoverableOperations` spread:

```ts
    ...(input.worker === undefined ? {} : { worker: input.worker }),
```

- [ ] **Step 6: Move the thread client out of `main.ts`**

Create `packages/slack-service/src/thread-api.ts`. The four existing methods move from `main.ts`
with the same URLs, bodies, error texts and parsing; `prepareWorkspace` is new:

```ts
import {
  SlackThreadPrepareResultSchema,
  SlackThreadWorkspaceResultSchema,
  SlackWorkspaceCloseCompleteResultSchema,
  SlackWorkspaceCloseStartResultSchema,
} from "@agentx/contracts";
import { ControlPlaneApi } from "@agentx/orchestrator/control-plane-api";
import { pollOperation } from "@agentx/orchestrator/event-client";
import type { ThreadServiceApi } from "./processor.js";
import { threadWorkspaceRequest } from "./thread-workspace-request.js";

/** The Slack service's thread-level control-plane client, moved out of main.ts so tests can drive it. */
export function createThreadApi(options: { controlPlaneUrl: string; signedFetch: typeof fetch; pollIntervalMilliseconds?: number }): ThreadServiceApi {
  const { controlPlaneUrl, signedFetch } = options;
  const client = (workspaceId: string) => new ControlPlaneApi(controlPlaneUrl, "slack-service", workspaceId, signedFetch);

  async function servicePost(path: string, body: unknown, failure: string): Promise<Record<string, unknown>> {
    const response = await signedFetch(`${controlPlaneUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parsed = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const error = parsed.error as { code?: string; message?: string } | undefined;
      throw new Error(`${failure}: ${error?.code ?? response.status} ${error?.message ?? ""}`.trim());
    }
    delete parsed.requestId;
    return parsed;
  }

  return {
    async ensureWorkspace(requestId) {
      return SlackThreadWorkspaceResultSchema.parse(await servicePost("/v1/threads/workspace", threadWorkspaceRequest(requestId), "thread workspace request failed"));
    },
    async prepareWorkspace(requestId) {
      return SlackThreadPrepareResultSchema.parse(await servicePost("/v1/threads/workspace/prepare", { requestId }, "thread workspace preparation failed"));
    },
    async startClose(requestId) {
      return SlackWorkspaceCloseStartResultSchema.parse(await servicePost("/v1/threads/workspace/close", { requestId }, "workspace close request failed"));
    },
    async completeClose(requestId, operationId) {
      return SlackWorkspaceCloseCompleteResultSchema.parse(
        await servicePost("/v1/threads/workspace/close/complete", { requestId, operationId }, "workspace close completion failed"),
      );
    },
    async waitForOperation(workspaceId, operationId) {
      const { operation } = await pollOperation(operationId, client(workspaceId), { intervalMilliseconds: options.pollIntervalMilliseconds ?? 5_000 });
      return {
        status: operation.status,
        ...(operation.error === undefined ? {} : { error: operation.error }),
        ...(operation.result === undefined ? {} : { result: operation.result }),
      };
    },
    async createConversation(workspaceId) {
      return (await client(workspaceId).createConversation()).id;
    },
  };
}
```

In `packages/slack-service/src/main.ts`, replace the body of `threadApi` with:

```ts
function threadApi(message: SlackRequestMessage): ThreadServiceApi {
  const signedFetch = createSignedServiceFetch({ region, credentials, thread: message.thread, userId: message.userId });
  return createThreadApi({ controlPlaneUrl, signedFetch });
}
```

Add `import { createThreadApi } from "./thread-api.js";`, and remove the imports this leaves
unused: `SlackThreadWorkspaceResultSchema`, `SlackWorkspaceCloseCompleteResultSchema`,
`SlackWorkspaceCloseStartResultSchema`, `pollOperation` and `threadWorkspaceRequest`. Keep
`type SlackRequestMessage` and `ControlPlaneApi`, which `runTurn` still uses.

Do not change `thread-workspace-request.ts` in this task. PR A must not opt in.

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npm run build && npx vitest run tests/integration/slack-lazy-worker.test.ts tests/contract/thread-api.test.ts tests/integration/slack-service.test.ts tests/integration/slack-processor-characterization.test.ts tests/integration/hosted-slack-mcp.test.ts tests/integration/hosted-slack-linear.test.ts tests/contract/thread-workspace-request.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add packages/slack-service/src tests/integration/slack-lazy-worker.test.ts tests/contract/thread-api.test.ts
git commit -m "feat(slack-service): prepare a thread's workspace mid-turn when a tool first needs the worker

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Open PR A**

Push `feat/014b-lazy-workspace-a` and open PR A for Tasks 1 to 6, against `mainline`, once phase
14a has merged and released. Its description states that it changes no user-visible behaviour
because nothing opts in, lists the rollout table from this plan, and ends with
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

### Task 7: The Slack service opts in, proven end to end (PR B)

Start PR B's branch from `mainline`, once PR A and phase 14c part 1 have both merged and released
(not from PR A's branch head; both are already in `mainline` by then):
`git switch -c feat/014b-lazy-workspace-b`.

**Files:**
- Modify: `packages/slack-service/src/thread-workspace-request.ts`
- Modify: `tests/contract/thread-workspace-request.test.ts` and `tests/contract/thread-api.test.ts`
  (the two allowed assertion changes)
- Test: `tests/integration/hosted-lazy-workspace.test.ts` (new)

**Interfaces:**
- Consumes: everything from Tasks 1 to 6; `LIMIT_REFUSAL` and `unavailableRefusal` (Task 6); phase
  14c part 1's `includeActionPolicy: true` on `threadWorkspaceRequest`'s body, already present by
  this point.
- Produces: the request body now carries `lazyPreparation: true`, inserted before
  `includeActionPolicy: true`.

- [ ] **Step 1: Update the request body test**

By this point phase 14c part 1 has already added `includeActionPolicy: true` to the request body,
so the expected final line gains `lazyPreparation: true` inserted before it, not appended after it.
In `tests/contract/thread-workspace-request.test.ts`, the expected object becomes:

```ts
    expect(threadWorkspaceRequest("request-1")).toEqual({
      requestId: "request-1", includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
      includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true,
    });
```

PR A's review added a dormancy pin to `tests/contract/thread-api.test.ts` that names its own
replacement. Replace

```ts
  it("PR A: the ensure body does not opt into lazy preparation, so compute is prepared as before (replaced when PR B opts in)", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const sent: unknown[] = [];
    const requestId = randomUUID();
    const result = await threadApi(handler, sent).ensureWorkspace(requestId);
    expect(sent).toEqual([{
      requestId, includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
      includeAllConnectorTypes: true, includeRecoverableOperations: true,
      includeActionPolicy: true,
    }]);
    expect(result).toMatchObject({ outcome: "WORKSPACE", status: "PREPARING", created: true });
  });
```

with

```ts
  it("opts into lazy preparation, so a new thread gets a record without compute", async () => {
    const { handler, db } = createBroker();
    await registerSlackProject(handler);
    const sent: unknown[] = [];
    const requestId = randomUUID();
    const result = await threadApi(handler, sent).ensureWorkspace(requestId);
    expect(sent).toEqual([{
      requestId, includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true,
      includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true,
      includeActionPolicy: true,
    }]);
    expect(result).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED", operationId: null, created: true });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
  });
```

- [ ] **Step 2: Write the failing end-to-end tests**

```ts
// tests/integration/hosted-lazy-workspace.test.ts
// The Slack processor, its real control-plane client and real tools against the real broker.
import { beforeAll, describe, expect, it } from "vitest";
import type { SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { ControlPlaneApi } from "../../packages/orchestrator/src/control-plane-api.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { LIMIT_REFUSAL, unavailableRefusal } from "../../packages/slack-service/src/lazy-worker.js";
import { processSlackRequest, type ThreadState, type ThreadStore } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { brokerFetch } from "../support/broker-fetch.js";
import {
  GITHUB_LIST_ISSUES, SLACK_CHANNEL, SLACK_TEAM, createBroker, fakeGitHubMcp, finishOperation, loadSlackBroker, registerSlackProject,
} from "../support/slack-broker.js";

const CONTROL_PLANE = "https://agentx.example.test";
const pratik = "U0123456789";
const WORKING = "Working on it now. I'll post the result in this thread when it's done.";
const SETTING_UP = "Setting up a new workspace for this thread. The first request takes a few minutes.";
const STILL = "This thread's workspace is still being set up. I'll start as soon as it's ready.";
const CONNECTOR_ANSWER = "2 issues are open.";
const CODING_ANSWER = "2 issues are open, and the coding request is handled above.";
let events = 0;

beforeAll(async () => {
  await loadSlackBroker();
});

const threadTs = (n: number) => `1695500000.${String(n).padStart(6, "0")}`;
const subject = (n: number) => `${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs(n)}`;

function memoryThreads(): ThreadStore {
  const states = new Map<string, ThreadState>();
  return {
    load: async (key) => ({ ...(states.get(key) ?? {}) }),
    saveConversation: async (key, state) => {
      states.set(key, { ...states.get(key), ...state });
    },
    saveSettingsRevision: async (key, revision) => {
      states.set(key, { ...states.get(key), settingsRevision: revision });
    },
    close: async (key, state) => {
      states.set(key, { workspaceId: state.workspaceId, closedAt: state.closedAt });
    },
    finish: async () => undefined,
  };
}

function scenario(options: { memberLimit?: number } = {}) {
  const { githubMcp, invoke } = fakeGitHubMcp();
  const broker = createBroker({ githubMcp, ...(options.memberLimit === undefined ? {} : { memberLimit: options.memberLimit }) });
  return {
    ...broker, invoke, threads: memoryThreads(), prepareOutcome: "SUCCEEDED" as "SUCCEEDED" | "FAILED",
    posts: [] as Array<{ threadTs: string; text: string }>, toolResults: [] as string[],
  };
}
type Scenario = ReturnType<typeof scenario>;

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

function postsIn(s: Scenario, n: number): string[] {
  return s.posts.filter((entry) => entry.threadTs === threadTs(n)).map((entry) => entry.text);
}

async function turnIn(s: Scenario, n: number, text: string, work: { coding: boolean }): Promise<void> {
  events += 1;
  const message: SlackRequestMessage = {
    version: 1, eventId: `EvLAZY${String(events).padStart(6, "0")}`, receivedAt: new Date().toISOString(), userId: pratik,
    thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: threadTs(n) }, text,
  };
  const signedFetch = createSignedServiceFetch({
    region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
    thread: message.thread, userId: message.userId, baseFetch: brokerFetch(s.handler),
  });
  await processSlackRequest(message, {
    api: () => ({
      ...createThreadApi({ controlPlaneUrl: CONTROL_PLANE, signedFetch }),
      // The fake table has no BETWEEN key condition for event pages, so wait by reading the operation alone.
      waitForOperation: async (workspaceId: string, operationId: string) => {
        const operation = await new ControlPlaneApi(CONTROL_PLANE, "slack-service", workspaceId, signedFetch).getOperation(operationId);
        return { status: operation.status, ...(operation.error === undefined ? {} : { error: operation.error }) };
      },
    }),
    threads: s.threads,
    runTurn: async (input) => {
      const base = new ControlPlaneApi(CONTROL_PLANE, "slack-service", input.workspaceId, signedFetch);
      const api: OrchestrationApi = {
        discoverConnectorTools: (request) => base.discoverConnectorTools(request),
        callConnectorTool: (request) => base.callConnectorTool(request),
        submitTask: (request) => base.submitTask(request),
        taskStatus: (request) => base.taskStatus(request),
        // No worker runs in this test: report the accepted task instead of waiting for it.
        taskResult: async (request) => ({ operationId: request.operationId, status: "ACCEPTED" }),
        followUp: (request) => base.followUp(request),
        createPullRequest: (request) => base.createPullRequest(request),
        managePullRequest: (request) => base.managePullRequest(request),
        pullRequestResult: (request, options) => base.pullRequestResult(request, options),
      };
      const runtime = await createHostedSlackRuntime(input, {
        stateDirectory: await createFixtureDirectory("agentx-hosted-lazy-"), api, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
      });
      try {
        const listed = await runtime.session.getToolDefinition("github__list_issues")!.execute(`list-${message.eventId}`, {}, undefined, undefined, {} as never);
        s.toolResults.push(textOf(listed));
        if (!work.coding) return CONNECTOR_ANSWER;
        const submitted = await runtime.session.getToolDefinition("agentx_submit_task")!
          .execute(`submit-${message.eventId}`, { prompt: "List the files in the repository." }, undefined, undefined, {} as never);
        s.toolResults.push(textOf(submitted));
        return CODING_ANSWER;
      } finally {
        await runtime.dispose();
      }
    },
    post: async (_thread, posted) => {
      s.posts.push({ threadTs: message.thread.threadTs, text: posted });
      // Plays the worker: a preparation the thread was just told about finishes now.
      if (posted === SETTING_UP || posted === STILL) {
        const pending = s.db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare" && item.status === "ACCEPTED");
        for (const operation of pending) await finishOperation(s.handler, s.db, operation.workspaceId as string, operation.id as string, s.prepareOutcome);
      }
    },
  }, { finalAttempt: false });
}

describe("workspace only when needed, end to end", () => {
  it("answers connector questions in four new threads without a workspace, then prepares only the thread that needs the worker", async () => {
    const s = scenario();
    await registerSlackProject(s.handler, { connectors: GITHUB_LIST_ISSUES });
    for (const n of [1, 2, 3, 4]) await turnIn(s, n, "what's open in GitHub issues?", { coding: false });
    for (const n of [1, 2, 3, 4]) expect(postsIn(s, n)).toEqual([WORKING, CONNECTOR_ANSWER]);
    expect(s.invoke).toHaveBeenCalledTimes(4);
    expect(s.db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    expect(s.db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);

    await turnIn(s, 1, "list the files in the repository", { coding: true });
    expect(postsIn(s, 1).slice(-3)).toEqual([WORKING, SETTING_UP, CODING_ANSWER]);
    expect(s.db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect(s.db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(1);
    expect(s.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1, threads: [subject(1)] });
    expect(s.toolResults.at(-1)).toContain("\"status\":\"ACCEPTED\"");
  });

  it("still answers the connector part when the member's limit stops preparation", async () => {
    const s = scenario({ memberLimit: 1 });
    await registerSlackProject(s.handler, { connectors: GITHUB_LIST_ISSUES });
    await turnIn(s, 1, "list the files in the repository", { coding: true });
    await turnIn(s, 2, "what's open, and list the files", { coding: true });
    expect(postsIn(s, 2)).toEqual([
      WORKING,
      [
        "You already have 1 AgentX workspaces, the most one person can have, so I can't start a new one. Continue in one of your existing threads instead:",
        `• <https://slack.com/archives/${SLACK_CHANNEL}/p${threadTs(1).replace(".", "")}|Thread 1>`,
      ].join("\n"),
      CODING_ANSWER,
    ]);
    expect(s.toolResults.at(-2)).toContain("SUCCEEDED");
    expect(s.toolResults.at(-1)).toBe(JSON.stringify(LIMIT_REFUSAL));
    expect(s.db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(1);
    expect(s.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
    const threadTwo = s.db.find((item) => item.entityType === "SLACK_THREAD" && item.thread === subject(2))[0];
    expect(s.db.get(`WORKSPACE#${String(threadTwo?.workspaceId)}`, "META")).toMatchObject({ status: "UNPREPARED" });
  });

  it("fails only the worker part when preparation fails mid-turn, and retries it as today on the next message", async () => {
    const s = scenario();
    await registerSlackProject(s.handler, { connectors: GITHUB_LIST_ISSUES });
    s.prepareOutcome = "FAILED";
    await turnIn(s, 1, "list the files in the repository", { coding: true });
    expect(postsIn(s, 1)).toEqual([
      WORKING, SETTING_UP, "AgentX could not set up this thread's workspace (FAILED). Mention me again in this thread to retry.", CODING_ANSWER,
    ]);
    expect(s.toolResults.at(-1)).toBe(JSON.stringify(unavailableRefusal("workspace setup failed")));
    expect(s.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });

    s.prepareOutcome = "SUCCEEDED";
    await turnIn(s, 1, "what's open?", { coding: false });
    expect(postsIn(s, 1).slice(-3)).toEqual([STILL, WORKING, CONNECTOR_ANSWER]);
    expect(s.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
  });

  it("tells a connector-only thread there is nothing to close, and keeps answering in it", async () => {
    const s = scenario();
    await registerSlackProject(s.handler, { connectors: GITHUB_LIST_ISSUES });
    await turnIn(s, 1, "what's open?", { coding: false });
    await turnIn(s, 1, "<@U0AGENTX01> close this workspace", { coding: false });
    expect(postsIn(s, 1).at(-1)).toBe("This thread does not have a workspace to close.");
    expect(s.deleteWorkspaceSession).not.toHaveBeenCalled();
    await turnIn(s, 1, "what's open now?", { coding: false });
    expect(postsIn(s, 1).at(-1)).toBe(CONNECTOR_ANSWER);
    expect(s.db.find((item) => item.entityType === "WORKSPACE")[0]).toMatchObject({ status: "UNPREPARED" });
    expect(s.db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/contract/thread-workspace-request.test.ts tests/integration/hosted-lazy-workspace.test.ts`
Expected: FAIL. The body lacks `lazyPreparation`, and every first message posts the setup message
and charges the limit. Also run `npx vitest run tests/contract/thread-api.test.ts`: the replaced
test fails the same way (no `lazyPreparation`, status `PREPARING`).

- [ ] **Step 4: Opt in**

In `packages/slack-service/src/thread-workspace-request.ts`, `threadWorkspaceRequest` already ends
with `includeActionPolicy: true` (added by phase 14c part 1). Insert `lazyPreparation: true`
immediately before it, not after it: the final line becomes `includeAllConnectorTypes: true,
includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true,`. Replace

```ts
    includeAllConnectorTypes: true, includeRecoverableOperations: true, includeActionPolicy: true,
```

with

```ts
    includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true,
```

If the function's doc comment does not yet say what `lazyPreparation` opts in to, add a clause:
"`lazyPreparation` opts in to status `UNPREPARED` and the prepare route (spec 014)."

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npm run build && npx vitest run tests/contract/thread-workspace-request.test.ts tests/integration/hosted-lazy-workspace.test.ts tests/contract/thread-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm run typecheck && npm run lint && npm run build && npm test`. Expected: all pass.

```bash
git add packages/slack-service/src/thread-workspace-request.ts tests/contract/thread-workspace-request.test.ts tests/contract/thread-api.test.ts tests/integration/hosted-lazy-workspace.test.ts
git commit -m "feat(slack-service): opt in to workspaces prepared only when needed

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Documentation and verification (PR B)

**Files:**
- Modify: `README.md` ("Working in a thread", the limits paragraph, the close section)
- Modify: `specs/014-slack-experience/spec.md` (Key Entities, Decisions)

- [ ] **Step 1: Update the README**

Each replacement below quotes the README as it stands after phase 14a (its app-posted,
turn-limit and reply-formatting text) and spec 013 phase 4. The paragraphs are wrapped, so each
old text spans whole lines.

In "Working in a thread", replace

```markdown
how many are ahead. The first request in a new thread also prepares the workspace, which takes a
few minutes. Messages without a mention, edits, bot messages, AgentX's own messages, direct
```

with

```markdown
how many are ahead. A new thread gets a coding workspace only when a request first needs the
remote worker, for example to read or change repository files or to run commands. Questions that
connectors answer, such as issue tracker questions, need no workspace. The first request that needs
the worker prepares the workspace in the same turn, which takes a few minutes, and AgentX says so in
the thread. Messages without a mention, edits, bot messages, AgentX's own messages, direct
```

Replace the limits paragraph

```markdown
Workspaces are limited to protect cost. The member who starts a thread may be the starter of at
most 3 thread workspaces, and the organization may have at most 20. A new thread over either limit
creates nothing, and AgentX replies with the limit that was reached; for the member limit, it also
links to that member's existing threads. An administrator can change the limits with the `AgentXControlPlane`
parameters `SlackMemberWorkspaceLimit` and `SlackOrganizationWorkspaceLimit`.
```

with

```markdown
Workspaces are limited to protect cost. Only threads whose workspace has been prepared count. The
member whose request first prepares a thread's workspace is charged for it. Each member may hold
at most 3 prepared thread workspaces, and the organization at most 20. When a request needs a
workspace over either limit, AgentX prepares nothing and says which limit was reached; for the
member limit, it also links that member's existing threads. It still answers any part of the
request that connectors can answer. An administrator can change the limits with the
`AgentXControlPlane` parameters `SlackMemberWorkspaceLimit` and `SlackOrganizationWorkspaceLimit`.
```

After the `@AgentX close this workspace` code block, add a paragraph. Replace

````markdown
```text
@AgentX close this workspace
```
````

with

````markdown
```text
@AgentX close this workspace
```

A thread that never needed the worker has no workspace. A close request there says so and changes
nothing.
````

In the paragraph that begins "For a clean production workspace", replace

```markdown
removes the hosted orchestrator conversation session and releases the organization and original
starter's workspace quota. Later mentions in the closed thread do not create another workspace;
```

with

```markdown
removes the hosted orchestrator conversation session and releases the organization's quota and
that of the member who prepared the workspace. Later mentions in the closed thread do not create
another workspace;
```

- [ ] **Step 2: Update the spec's records**

In `specs/014-slack-experience/spec.md`, replace the "Thread record" key entity

```markdown
- **Thread record**: exists from the first message. Holds the project, revision, connectors,
  conversation and, once prepared, the workspace.
```

with:

```markdown
- **Thread record**: exists from the first message. Holds the project, the revision the thread
  started with, connectors, conversation and a workspace record. The workspace record's status is
  UNPREPARED until a tool first needs the worker; only then is compute prepared and the limit
  charged. Connector routes, the connector ledger and conversations use the workspace ID from the
  first message.
```

Add to "Decisions", after the bullet on the cheap thread record, which ends

```markdown
  keeps the thread and conversation model intact, instead of inventing a second path for
  connector-only threads.
```

this bullet:

```markdown
- **Lazy workspaces are an opt-in on the thread workspace request** (`lazyPreparation: true`), so a
  Slack service that cannot parse `UNPREPARED` never sees it. The member whose request prepares
  compute is charged. `agentx_submit_task` and `agentx_follow_up` prepare compute;
  `agentx_create_pull_request` answers that there is nothing to publish; the other in-house tools
  and all connector tools never prepare it. The plan is
  [plans/phase-14b-lazy-workspace.md](plans/phase-14b-lazy-workspace.md).
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
Expected: all pass.

Confirm the only removed test line is the request body assertion, and that no golden file changed:

```bash
git diff mainline..HEAD -- tests | grep '^-' | grep -v '^---'
git diff --stat mainline..HEAD -- tests/contract/__snapshots__
```

Expected: the first command prints only the removed lines of Task 7's two named assertion changes:
the old `includeAllConnectorTypes: true, includeRecoverableOperations: true, includeActionPolicy:
true,` line of `thread-workspace-request.test.ts` (the line as phase 14c part 1 left it), and the
replaced PR A test's name, `const { handler } = createBroker();`, body line and result line in
`thread-api.test.ts`. The second prints nothing. Task 8b repeats this check with its own lines.

Search the new documents for em-dashes: `grep -n "—" README.md specs/014-slack-experience/spec.md specs/014-slack-experience/plans/phase-14b-lazy-workspace.md`
Expected: no line added by this phase.

- [ ] **Step 4: Commit**

```bash
git add README.md specs/014-slack-experience/spec.md
git commit -m "docs(014): workspaces prepared only when needed, limits and closing

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

PR B opens after Task 8b.

---

### Task 8b: One acknowledgement unless the request waited (PR B)

Owner decision, 2026-09-25, from the phase 14a live check (`quickstart.md`, "Finding"): today every
request gets "Got it. I'm on it and will reply in this thread." from the ingress and, less than a
second later, "Working on it now. I'll post the result in this thread when it's done." from the
Slack service (`processor.ts`, directly after the lazy `worker`). The service now posts its notice
only when the member was told to wait: the ingress said "queued behind N", or the turn waited for
workspace setup up front (after "Setting up a new workspace" or "still being set up").

**The signal.** The ingress already knows the count: `ahead = pending - 1` is what it puts in
"queued behind N". It now also sends that count with the queue message, as the SQS message
attribute `queuedBehind`, and the service reads it. FIFO order makes it exact: a request the
ingress queued behind N others starts only after they finish. Other signals were rejected: the
thread's `pendingRequests` at dequeue counts requests behind this one, not ahead of it; comparing
`receivedAt` with the start time is a guess that depends on clocks and queue latency. The count is
an attribute, not a body field, because `SlackRequestMessageSchema` is `.strict()` and an older
Slack service's consumer discards and deletes a message with an unknown field
(`message.discarded`, `invalid_message`). An older service does not ask for the attribute, so it
ignores it. A message with no attribute (an older ingress) keeps today's notice.

The lazy worker is unchanged: mid-turn setup posts "Setting up a new workspace" as before, and the
turn's reply follows it; no start notice is added after mid-turn setup.

**Files:**
- Modify: `packages/contracts/src/slack.ts` (after `SlackRequestMessageSchema`)
- Modify: `packages/broker/src/aws/slack-ingress.ts` (`enqueue` dependency, the enqueue call, the
  AWS `enqueue`)
- Modify: `packages/slack-service/src/consumer.ts`, `packages/slack-service/src/main.ts` (the
  queue's `receive`), `packages/slack-service/src/processor.ts`
- Modify: `tests/contract/slack-ingress.test.ts` (the harness records the count; one new test)
- Test: `tests/integration/slack-start-notice.test.ts` (new)
- Modify: `README.md` ("Working in a thread"), `specs/014-slack-experience/spec.md` (FR-026,
  Decisions), `specs/014-slack-experience/quickstart.md` (the finding)

**Interfaces:**
- Consumes: Task 8's README text for "Working in a thread"; Task 8's spec Decisions bullet on lazy
  workspaces; Task 6's processor (`waitForOperation` preparation block, lazy `worker`).
- Produces:
  - `@agentx/contracts`: `SLACK_QUEUED_BEHIND_ATTRIBUTE = "queuedBehind"`,
    `queuedBehindAttributes(queuedBehind: number): Record<string, { DataType: "Number"; StringValue: string }>`,
    `queuedBehindOf(attributes: Readonly<Record<string, { StringValue?: string | undefined }>> | undefined): number | undefined`;
  - `SlackIngressDependencies.enqueue(message, messageGroupId, queuedBehind: number)`;
  - `QueueMessage.queuedBehind?: number`; `RequestHandler`'s context
    `{ finalAttempt: boolean; queuedBehind?: number }`;
  - `processSlackRequest(message, dependencies, options: { finalAttempt: boolean; queuedBehind?: number })`.
- No existing assertion changes. Existing callers pass no `queuedBehind` and keep today's notice,
  so Task 7's end-to-end expectations (`[WORKING, ...]`) hold unchanged.

- [ ] **Step 1: Pin today's start notice (characterization)**

These pass before any production change and keep passing after it.

```ts
// tests/integration/slack-start-notice.test.ts
// Spec 014 FR-026: when the Slack service says it has started, next to the ingress's own acknowledgement.
import { describe, expect, it, vi } from "vitest";
import type { SlackRequestMessage, SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
import { processGroup, type QueueClient, type QueueMessage } from "../../packages/slack-service/src/consumer.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const workspaceId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const WORKING = "Working on it now. I'll post the result in this thread when it's done.";
const SETTING_UP = "Setting up a new workspace for this thread. The first request takes a few minutes.";
const STILL = "This thread's workspace is still being set up. I'll start as soon as it's ready.";

function message(): SlackRequestMessage {
  return { version: 1, eventId: "Ev0000000001", thread, userId: "U0123456789", text: "what's open?", receivedAt: "2026-09-25T10:00:00.000Z" };
}

function workspace(overrides: Record<string, unknown> = {}): SlackThreadWorkspaceResult {
  return { outcome: "WORKSPACE", workspaceId, status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate work.", ...overrides };
}

function harness(result: SlackThreadWorkspaceResult, preparation = "SUCCEEDED") {
  const posts: string[] = [];
  const dependencies: ProcessorDependencies = {
    api: () => ({
      ensureWorkspace: async () => result,
      startClose: async () => ({ outcome: "NOT_FOUND" as const }),
      completeClose: vi.fn(),
      waitForOperation: async () => ({ status: preparation }),
      createConversation: async () => "33333333-3333-4333-8333-333333333333",
    }),
    threads: {
      load: async () => ({}),
      saveConversation: async () => undefined,
      saveSettingsRevision: async () => undefined,
      close: async () => undefined,
      finish: async () => undefined,
    },
    runTurn: async () => "2 issues are open.",
    post: async (_thread, text) => {
      posts.push(text);
    },
  };
  return { dependencies, posts };
}

function queueEntry(extra: Partial<QueueMessage> = {}): QueueMessage {
  return { body: JSON.stringify(message()), receiptHandle: "receipt-1", groupId: "thread-a", receiveCount: 1, ...extra };
}

const queue: QueueClient = { receive: async () => [], delete: async () => undefined, extendVisibility: async () => undefined };
const groupOptions = { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 };

describe("the start notice today (characterization)", () => {
  it.each(["READY", "UNPREPARED"] as const)("posts it before the reply in a %s thread when the request carries no queue count", async (status) => {
    const h = harness(workspace({ status }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([WORKING, "2 issues are open."]);
  });

  it("posts it after an up-front setup wait", async () => {
    const h = harness(workspace({ status: "PREPARING", operationId, created: true }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false });
    expect(h.posts).toEqual([SETTING_UP, WORKING, "2 issues are open."]);
  });

  it("hands a queue message with no count to the processor with the final-attempt flag alone", async () => {
    const contexts: unknown[] = [];
    await processGroup(queue, async (_message, context) => {
      contexts.push(context);
    }, [queueEntry()], groupOptions, () => undefined);
    expect(contexts).toEqual([{ finalAttempt: false }]);
  });
});
```

Run: `npm run build && npx vitest run tests/integration/slack-start-notice.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 2: Write the failing tests for the new behaviour**

In `tests/integration/slack-start-notice.test.ts`, replace the contracts import

```ts
import type { SlackRequestMessage, SlackThreadWorkspaceResult } from "../../packages/contracts/src/index.js";
```

with

```ts
import {
  SLACK_QUEUED_BEHIND_ATTRIBUTE, queuedBehindAttributes, queuedBehindOf, type SlackRequestMessage, type SlackThreadWorkspaceResult,
} from "../../packages/contracts/src/index.js";
```

and append:

```ts
describe("the start notice only when the member was told to wait", () => {
  it.each(["READY", "UNPREPARED"] as const)("is not posted in a %s thread when nothing was queued ahead", async (status) => {
    const h = harness(workspace({ status }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts).toEqual(["2 issues are open."]);
  });

  it("is posted when the request waited behind earlier requests in the thread", async () => {
    const h = harness(workspace());
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 2 });
    expect(h.posts).toEqual([WORKING, "2 issues are open."]);
  });

  it.each([
    [true, SETTING_UP],
    [false, STILL],
  ])("is posted after an up-front setup wait even when nothing was queued ahead (created: %s)", async (created, notice) => {
    const h = harness(workspace({ status: "PREPARING", operationId, created }));
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts).toEqual([notice, WORKING, "2 issues are open."]);
  });

  it("is not posted when setup fails, as today", async () => {
    const h = harness(workspace({ status: "PREPARING", operationId, created: true }), "FAILED");
    await processSlackRequest(message(), h.dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(h.posts).toEqual([SETTING_UP, "AgentX could not set up this thread's workspace (FAILED). Mention me again in this thread to retry."]);
  });

  it("hands the queue count to the processor", async () => {
    const contexts: unknown[] = [];
    await processGroup(queue, async (_message, context) => {
      contexts.push(context);
    }, [queueEntry({ queuedBehind: 0 }), queueEntry({ receiptHandle: "receipt-2", queuedBehind: 3, receiveCount: 5 })], groupOptions, () => undefined);
    expect(contexts).toEqual([{ finalAttempt: false, queuedBehind: 0 }, { finalAttempt: true, queuedBehind: 3 }]);
  });
});

describe("the queue count attribute", () => {
  it("round-trips through the queue attributes the ingress sends", () => {
    expect(queuedBehindAttributes(3)).toEqual({ [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { DataType: "Number", StringValue: "3" } });
    expect(queuedBehindOf(queuedBehindAttributes(0))).toBe(0);
    expect(queuedBehindOf(queuedBehindAttributes(3))).toBe(3);
  });

  it.each([
    ["no attributes", undefined],
    ["another attribute only", { other: { StringValue: "1" } }],
    ["a negative count", { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { StringValue: "-1" } }],
    ["a fraction", { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { StringValue: "1.5" } }],
    ["text", { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { StringValue: "two" } }],
    ["no value", { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: {} }],
  ])("reads %s as no count, so the processor keeps today's notice", (_name, attributes) => {
    expect(queuedBehindOf(attributes)).toBeUndefined();
  });
});
```

In `tests/contract/slack-ingress.test.ts`, let the harness record the count. Replace

```ts
  const queue: Array<{ message: SlackRequestMessage; groupId: string }> = [];
```

with

```ts
  const queue: Array<{ message: SlackRequestMessage; groupId: string; queuedBehind?: number }> = [];
```

replace

```ts
    enqueue: async (message, groupId) => {
```

with

```ts
    enqueue: async (message, groupId, queuedBehind) => {
```

and replace

```ts
      queue.push({ message, groupId });
```

with

```ts
      queue.push({ message, groupId, queuedBehind });
```

Then add this test directly before `it("processes a repeated Slack event only once", ...)`:

```ts
  it("tells the Slack service how many earlier requests each one was queued behind (spec 014 FR-026)", async () => {
    const { handler, queue } = harness();
    await send(handler, signedEvent(mention()));
    await send(handler, signedEvent(mention({
      eventId: "Ev0000000002",
      event: { user: "U0456789012", ts: "1695500100.000002", thread_ts: "1695500000.000001", text: `<@${bot}> also add tests` },
    })));
    expect(queue.map((entry) => entry.queuedBehind)).toEqual([0, 1]);
  });
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npm run build && npx vitest run tests/integration/slack-start-notice.test.ts tests/contract/slack-ingress.test.ts`
Expected: FAIL, 11 tests: the ingress sends no count (`[undefined, undefined]`), the processor
still posts the notice with `queuedBehind: 0`, the consumer drops the count, and
`queuedBehindAttributes` and `queuedBehindOf` do not exist yet. The 4 characterization tests and
every existing ingress test still pass.

- [ ] **Step 4: Add the attribute helpers to the contracts**

In `packages/contracts/src/slack.ts`, directly after `SlackRequestMessageSchema` (the block ending
`receivedAt: z.string().datetime(),` / `})` / `.strict();`), add:

```ts
/**
 * Spec 014 FR-026: the queue message attribute through which the ingress tells the Slack service how
 * many earlier requests in the thread a request was queued behind. It travels outside the body,
 * because an older Slack service parses the body strictly and would discard a message with a new field.
 */
export const SLACK_QUEUED_BEHIND_ATTRIBUTE = "queuedBehind";

export function queuedBehindAttributes(queuedBehind: number): Record<string, { DataType: "Number"; StringValue: string }> {
  return { [SLACK_QUEUED_BEHIND_ATTRIBUTE]: { DataType: "Number", StringValue: String(queuedBehind) } };
}

/** The count a received message carries, or undefined when it carries none (an older ingress) or a malformed one. */
export function queuedBehindOf(attributes: Readonly<Record<string, { StringValue?: string | undefined }>> | undefined): number | undefined {
  const value = attributes?.[SLACK_QUEUED_BEHIND_ATTRIBUTE]?.StringValue;
  return value !== undefined && /^\d{1,6}$/.test(value) ? Number(value) : undefined;
}
```

`packages/contracts/src/index.ts` already re-exports `./slack.js`.

- [ ] **Step 5: The ingress sends the count**

In `packages/broker/src/aws/slack-ingress.ts`, add `queuedBehindAttributes,` to the
`@agentx/contracts` import, between `SlackUserIdSchema,` and `slackRequestText,`.

In `SlackIngressDependencies`, replace

```ts
  enqueue: (message: SlackRequestMessage, messageGroupId: string) => Promise<void>;
```

with

```ts
  /** `queuedBehind` is how many earlier requests in the thread this one waits behind (spec 014 FR-026). */
  enqueue: (message: SlackRequestMessage, messageGroupId: string, queuedBehind: number) => Promise<void>;
```

Compute `ahead` before the enqueue, so the queue message and the thread notice use the same count.
Replace

```ts
    const pending = await dependencies.changePending(subject, 1);
    try {
      await dependencies.enqueue(message, createHash("sha256").update(subject).digest("hex"));
```

with

```ts
    const pending = await dependencies.changePending(subject, 1);
    const ahead = pending - 1;
    try {
      await dependencies.enqueue(message, createHash("sha256").update(subject).digest("hex"), Math.max(ahead, 0));
```

and delete the later `const ahead = pending - 1;`, directly after
`log("mention.accepted", { eventId: mention.eventId, pendingInThread: pending });`. The notice
text and its `ahead > 0` test are unchanged.

In `createAwsSlackIngressHandler`, replace the AWS `enqueue`

```ts
    async enqueue(message, messageGroupId) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: message.eventId,
      }));
```

with

```ts
    async enqueue(message, messageGroupId, queuedBehind) {
      await sqs.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: message.eventId,
        MessageAttributes: queuedBehindAttributes(queuedBehind),
      }));
```

`sqs:SendMessage` covers message attributes, so no IAM or queue change is needed.

- [ ] **Step 6: The consumer passes the count on**

In `packages/slack-service/src/consumer.ts`, replace

```ts
  groupId: string;
  receiveCount: number;
}
```

with

```ts
  groupId: string;
  receiveCount: number;
  /** How many earlier requests the ingress queued this one behind; absent from an older ingress. */
  queuedBehind?: number;
}
```

replace

```ts
export type RequestHandler = (message: SlackRequestMessage, context: { finalAttempt: boolean }) => Promise<void>;
```

with

```ts
export type RequestHandler = (message: SlackRequestMessage, context: { finalAttempt: boolean; queuedBehind?: number }) => Promise<void>;
```

and in `processGroup` replace

```ts
        await handle(parsed.data, { finalAttempt: entry.receiveCount >= options.maxReceiveCount });
```

with

```ts
        await handle(parsed.data, {
          finalAttempt: entry.receiveCount >= options.maxReceiveCount,
          ...(entry.queuedBehind === undefined ? {} : { queuedBehind: entry.queuedBehind }),
        });
```

In `packages/slack-service/src/main.ts`, replace

```ts
import type { SlackRequestMessage } from "@agentx/contracts";
```

with

```ts
import { SLACK_QUEUED_BEHIND_ATTRIBUTE, queuedBehindOf, type SlackRequestMessage } from "@agentx/contracts";
```

and in the queue's `receive` replace

```ts
      MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
    }));
    return (response.Messages ?? []).map((message) => ({
      body: message.Body ?? "",
      receiptHandle: message.ReceiptHandle ?? "",
      groupId: message.Attributes?.MessageGroupId ?? "",
      receiveCount: Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10),
    }));
```

with

```ts
      MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
      MessageAttributeNames: [SLACK_QUEUED_BEHIND_ATTRIBUTE],
    }));
    return (response.Messages ?? []).map((message) => {
      const queuedBehind = queuedBehindOf(message.MessageAttributes);
      return {
        body: message.Body ?? "",
        receiptHandle: message.ReceiptHandle ?? "",
        groupId: message.Attributes?.MessageGroupId ?? "",
        receiveCount: Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10),
        ...(queuedBehind === undefined ? {} : { queuedBehind }),
      };
    });
```

`main.ts` already passes the consumer's `context` straight to `processSlackRequest`, so that call
does not change.

- [ ] **Step 7: The processor posts the notice only after a wait**

In `packages/slack-service/src/processor.ts`, replace the options parameter

```ts
  options: { finalAttempt: boolean },
): Promise<void> {
```

with

```ts
  options: {
    finalAttempt: boolean;
    /** How many earlier requests the ingress told the member this one waits behind; absent from an older ingress. */
    queuedBehind?: number;
  },
): Promise<void> {
```

Directly after `let finished = false;` add

```ts
  // Set when this turn waited for workspace setup up front, which the member was told about.
  let waitedForSetup = false;
```

In the preparation block, after the failed-preparation early return, replace

```ts
        await post(preparationFailedMessage(prepared.status));
        finished = true;
        return;
      }
    } else if (workspace.status !== "UNPREPARED" && !RUNNABLE_STATUSES.has(workspace.status)) {
```

with

```ts
        await post(preparationFailedMessage(prepared.status));
        finished = true;
        return;
      }
      waitedForSetup = true;
    } else if (workspace.status !== "UNPREPARED" && !RUNNABLE_STATUSES.has(workspace.status)) {
```

Then replace

```ts
    await post("Working on it now. I'll post the result in this thread when it's done.");
    log("task.started", { eventId: message.eventId });
```

with

```ts
    // Spec 014 FR-026: the ingress has already said "I'm on it". Say work has started only when the
    // member was told to wait, behind earlier requests or for setup. An older ingress sends no count.
    const announceStart = options.queuedBehind === undefined || options.queuedBehind > 0 || waitedForSetup;
    if (announceStart) await post("Working on it now. I'll post the result in this thread when it's done.");
    log("task.started", { eventId: message.eventId });
```

The notice text is unchanged, and the post stays on one line starting with `await post("Working on
it now.` after `if (announceStart)`. Phase 14c part 2 inserts its confirmation claim "directly
before" that post; it goes before the new comment block, so the claim still runs before the notice.

- [ ] **Step 8: Run the tests and watch them pass**

Run: `npm run build && npx vitest run tests/integration/slack-start-notice.test.ts tests/contract/slack-ingress.test.ts tests/integration/slack-service.test.ts tests/integration/slack-processor-characterization.test.ts tests/integration/slack-lazy-worker.test.ts tests/integration/hosted-lazy-workspace.test.ts tests/integration/turn-records.test.ts`
Expected: PASS.

- [ ] **Step 9: Update the README, spec and live-check record**

In `README.md`, "Working in a thread", replace (the text as Task 8 left it)

```markdown
AgentX replies within a few seconds. If earlier requests in the thread are still running, it says
how many are ahead. A new thread gets a coding workspace only when a request first needs the
```

with

```markdown
AgentX replies within a few seconds. If earlier requests in the thread are still running, it says
how many are ahead, and says "Working on it now" when it starts on the request. A request with
nothing ahead gets only that first reply before its answer. A new thread gets a coding workspace
only when a request first needs the
```

In `specs/014-slack-experience/spec.md`, after FR-025

```markdown
- **FR-025**: The Slack app MUST gain interactivity with a signed request URL; requests failing
  signature verification MUST be refused.
```

add

```markdown
- **FR-026**: A request MUST get one acknowledgement before its answer. The Slack service MUST post
  its "Working on it now" notice only when the request waited: behind earlier requests in the
  thread, or for workspace setup. (Added 2026-09-25, from the phase 14a live check.)
```

and in "Decisions", after the lazy workspaces bullet Task 8 added, which ends

```markdown
  and all connector tools never prepare it. The plan is
  [plans/phase-14b-lazy-workspace.md](plans/phase-14b-lazy-workspace.md).
```

add

```markdown
- **The ingress passes the queue count as a queue message attribute, not a body field**
  (2026-09-25, owner-approved, FR-026). An older Slack service parses the body strictly and would
  discard a message with a new field; it ignores attributes it does not ask for. A message with no
  count, from an older ingress, keeps the "Working on it now" notice.
```

In `specs/014-slack-experience/quickstart.md`, at the end of the "Finding" paragraph, replace

```markdown
Only one is needed when nothing is queued ahead.
```

with

```markdown
Only one is needed when nothing is queued ahead. Resolved by FR-026 in phase 14b PR B.
```

- [ ] **Step 10: Verify PR B**

Run: `npm run typecheck && npm run lint && npm run build && npm test && npm run infra:synth`.
Expected: all pass.

Confirm the only removed test lines are the two named request body assertions (Task 7) and the
three ingress harness lines this task widened, and that no golden file changed:

```bash
git diff mainline..HEAD -- tests | grep '^-' | grep -v '^---'
git diff --stat mainline..HEAD -- tests/contract/__snapshots__
```

Expected: the first command prints exactly these lines, and the second prints nothing:

```text
-  const queue: Array<{ message: SlackRequestMessage; groupId: string }> = [];
-    enqueue: async (message, groupId) => {
-      queue.push({ message, groupId });
-  it("PR A: the ensure body does not opt into lazy preparation, so compute is prepared as before (replaced when PR B opts in)", async () => {
-    const { handler } = createBroker();
-      includeAllConnectorTypes: true, includeRecoverableOperations: true,
-    expect(result).toMatchObject({ outcome: "WORKSPACE", status: "PREPARING", created: true });
-      includeAllConnectorTypes: true, includeRecoverableOperations: true, includeActionPolicy: true,
```

Search the new documents for em-dashes: `grep -n "—" README.md specs/014-slack-experience/spec.md specs/014-slack-experience/quickstart.md specs/014-slack-experience/plans/phase-14b-lazy-workspace.md`
Expected: no line added by this phase.

- [ ] **Step 11: Commit and open PR B**

```bash
git add packages/contracts/src/slack.ts packages/broker/src/aws/slack-ingress.ts packages/slack-service/src/consumer.ts packages/slack-service/src/main.ts packages/slack-service/src/processor.ts tests/integration/slack-start-notice.test.ts tests/contract/slack-ingress.test.ts README.md specs/014-slack-experience/spec.md specs/014-slack-experience/quickstart.md
git commit -m "feat(slack-service): say work has started only when a request waited

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Push `feat/014b-lazy-workspace-b` and open PR B against `mainline`. Its description repeats the
rollback rules, notes that either ingress and Slack service version mix keeps today's start notice,
and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Self-review record

- **Verified.** Every code block and test was applied, task by task, to a scratch copy of mainline
  `af67c2c` (spec 013 phase 4 merged) in the cross-plan order. PR A (Tasks 1 to 6), on 14a:
  `npm run build`, `npm run typecheck`, `npm run lint` and `npm test` pass, 1,317 tests with one
  existing skip. PR B (Tasks 7 and 8), on 14a, PR A and 14c part 1: the same, 1,340 tests with one
  existing skip. Spec 013 phase 4 touched three of this plan's anchors, now quoted as they stand:
  `createOrchestrationTools`' options type (`onConnectorError`), its call in the orchestrator, and
  the processor's preparation block (`draft.disposition`). Four test blocks were made lint-clean
  (`expect.any(String) as string`, no needless assertions, a worker double with plain properties).

- **Re-verified for PR B, 2026-09-25.** Tasks 7, 8 and 8b were applied to a scratch copy of
  mainline `d819d58` (14a, PR A #52, plan amendments #53 and 14c part 1 #56 merged). Every Task 7
  and 8 anchor matched; the one gap was PR A's review-added dormancy pin in `thread-api.test.ts`,
  now replaced in Task 7 Step 1. Task 8b's characterization tests pass on the base, its 11 new
  tests fail there and pass after Steps 4 to 7. `npm run typecheck`, `npm run lint`, `npm run
  build`, `npm test` and `npm run infra:synth` pass: 1,423 tests with one existing skip.

- **Spec coverage.** FR-001: Task 3. FR-002: Tasks 1, 3, 5 and 7. FR-003: Tasks 4, 5, 6 and 7.
  FR-004: Tasks 3 and 4. FR-005: Tasks 1, 4 (retry and prepared threads) and 6 (no worker handle).
  FR-006: Tasks 6 and 7. FR-026: Task 8b. US1 acceptance scenarios 1 to 4: Tasks 3, 6, 7 and 4. SC-002: Task 3.
  Edge cases: close of a thread with no workspace (Tasks 3 and 7); a later revision change (Task 4).
  SC-001's latency target is met by removing preparation from connector-only turns; it has no unit
  test and is checked live after PR B.
- **Placeholders.** None: every code step has its code.
- **Names used across tasks.** `lazyPreparation`, `UNPREPARED`, `SlackThreadPrepareResultSchema`,
  `startThreadPreparation`, `prepareThreadWorkspace`, `WorkerAccess.prepared` and `ensureReady`,
  `WORKER_TOOL_NAMES`, `NO_WORKSPACE_TO_PUBLISH`, `createLazyWorker`, `LIMIT_REFUSAL`,
  `unavailableRefusal`, `createThreadApi`, `lazyEnsureWorkspace`, `prepareThread`,
  `finishOperation`.
- **Review Focus.** Each of the five lines has tests in its owning tasks, listed above.
