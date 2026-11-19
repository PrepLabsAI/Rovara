# The test machine renewal and the core engine

Status: checked 2026-11-15 on `pr/r2-engine-boundary-3` (`4f604a5ee`). This closes deferred row CORE-REQUALIFY-HOLD-CHECK.

## Question

The renewal of the browser and API test machine (AUTOREQUALIFY, `packages/broker/src/e2e/requalify-hold.ts`) places a HOLD row while it drains the old machine and switches to the new one. The workflow's starts check that hold. The core engine does not check it.

Can a core operation start on that machine while the hold stands?

## Answer: no, not on this code

The renewed machine serves two kinds of work. Neither is ever started by the core.

1. **Browser and API application rounds.** A round is a CHECKS operation that carries `workflowE2EAdmission`.
   - Only the spec 056 workflow on AWS sets that field. It is set only by the four starts in `aws/developer-tasks.ts`: `startTaskWorkflowE2EChecksFromSystem`, `...BaselineFromSystem`, `...GroundingFromSystem` and `...ReplayFromSystem`. Each passes it through `acceptTask`, and `aws/broker.ts` puts it on the operation.
   - `aws/ec2-delivery.ts`, `aws/workflow-cancel-reconcile.ts`, `aws/dispatcher.ts`, `aws/outbox-failure.ts` and `e2e/model-budget-endpoint.ts` only read it.
   - Each of the four starts commits only with `requalifyHoldFence` in its own transaction (`developer-tasks.ts` around lines 3447, 3497, 3547 and 3597). The replay start also checks the hold in `aws/broker.ts` (around line 11889).
   - Under `packages/broker/src/core`, `core-host` and `local`, `workflowE2EAdmission` is only read and compared, never written. See `core/e2e/callbacks.ts:57`, `core/e2e/verification.ts:50` and `core/build-step/results.ts`.
   - The core verifies and settles a round's evidence; it does not start one.
2. **Project setup runs** (`PROJECT_SETUP#<id>` executions).
   - These are started only by `aws/broker.ts`, which calls `assertNoRequalifyHold` and fences on the hold (around lines 2398 and 2435).
   - No file under `core`, `core-host` or `local` builds a project setup execution or its key. `local/invoke-signer.ts` signs a `project-setup-smoke` invocation it is given, but nothing in `local` creates one; the only producers are `aws/broker.ts`, `aws/dispatcher.ts` and `aws/ec2-delivery.ts`.
   - The core's own setup work is a separate thing: the setup agent (a task with `purpose: "setup_agent"`, `core/setup-agent/agent.ts`) and its setup checks (`core/setup-agent/check.ts`). Both run on the core's own worker machines (`deps.machines`), never on the registered runtime.

Two more facts back this up:
- The core's round verification is wired only on the laptop: `local/app/app.ts` builds `createLocalE2EAuthority`. The deployed core host (`core-host/core-runtime.ts`) passes no `e2e` dependencies to the task flow, so a core task on AWS has no application-round path at all.
- A core task's worker runs on the core's own worker machines (the `worker-machines` point, still unfilled on AWS; that is lane E2 step 4). It never runs on the registered test runtime that the renewal replaces.

So no core-side hold check is needed today. The drain (#709) still counts any running core operation under a company key, which fails closed. That only costs the renewal some waiting.

## When this must be revisited

A core-side check becomes required as soon as the core can start work on the registered test runtime. Concretely, that happens if any of these changes:
- code under `core`, `core-host` or `local` starts writing `workflowE2EAdmission`, or dispatches onto `E2E_FEATURE_VERIFIER` / registered-runtime endpoints;
- anything calls the core's ready-made, unused round start seams: `core/e2e/baseline.ts`, `grounding.ts` and `replay.ts` export `request...` and `...StartItem` functions;
- a deployment passes `e2e` into the core host's `flowOptions`, which `core-host/core-runtime.ts` passes straight to the task flow;
- the core starts project setup executions.

At that point the core's start must check the hold the way the workflow does, failing closed: a hold that can't be read counts as active. Running operations are left alone. The check has to sit in the start transaction, using the core's `TransactItem` form of `requalifyHoldFence`.
