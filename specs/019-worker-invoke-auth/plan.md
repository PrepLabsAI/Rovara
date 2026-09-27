# Implementation Plan: Worker Invoke Authentication

**Branch**: `feat/080-worker-invoke-auth` | **Date**: 2026-09-27 | **Spec**: [spec.md](spec.md)

Add the token wire format next to the claims schema in `packages/contracts/src/session.ts`
(`workerInvokeTokenPayload`, `workerInvokeToken`), so the dispatcher in #84 signs exactly what the worker
verifies. Add `packages/worker/src/invoke-auth.ts` with the environment loader, the P-256 key reader, the
header verifier and the invocation binding check. `handleWorkerRequest` verifies the header before reading
the body and checks the binding after parsing, before journaling. `main.ts` loads the configuration before
opening the port.

Authentication switches on with its variables rather than a mode flag, because the AgentCore runtime's
environment is set by the production stacks and must not change here. The EC2 boot script (#81) must set
all three; the partial-configuration refusal catches a boot that sets only some.

## Constitution Check

PASS. Worker-only change with no infrastructure, no change for AgentCore workers, and requirements, plan,
tasks and verification recorded here.
