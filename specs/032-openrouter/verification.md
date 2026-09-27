# Verification

Implementation: `feat/122-openrouter`, based on `bdd1b19` in the separate `Pi-Bedrock-122-openrouter` worktree.

## Local evidence

- TypeScript project build and ESLint pass.
- Full suite: 195 test files passed, 4 skipped; 2,761 tests passed, 8 skipped.
- After the final automatic-router restriction, 65 targeted tests pass, including the new Qwen3-Coder case, real Pi session/tool-result persistence and resumption, classifier transport, prerequisites, environment adoption, and packaged CLI execution.
- CDK synthesis passes. Legacy snapshots reviewed and updated for optional parameters, conditional scoped secret-read policies, worker SSM settings, Slack environment references, and the release trigger.
- Two release builds produce identical release manifests; release verification passes.
- No live inference or deployment performed. Public OpenRouter model/endpoint metadata was read without credentials to validate the proposed Qwen model's availability, advertised limits, tools, and endpoint name.

## Convergence

FR-001 through FR-006 have implementation and local verification. Shared runtime uses pinned Pi metadata/transport, keeps credentials in memory, sanitizes provider errors, disables transport retries/model fallback, and records estimated/unknown cost plus returned identifiers. Init/deploy/export and saved/adopted environment settings preserve independent role providers. Existing Slack approval and selection paths distinguish provider/model pairs.

Convergence found automatic-router aliases in Pi's catalog; T007 now rejects those aliases and tests non-reasoning Qwen3-Coder. No further local implementation gap remains. T008 remains open: deployed Slack end-to-end compatibility needs a credential source and AWS target. The user supplied a $5 inference budget and requested open weights; qwen/qwen3-coder via deepinfra/turbo is proposed for the first test. The live checklist is in docs/openrouter.md. Scripted transport tests are not live compatibility evidence.

## Missing-secret fallback verification

User clarification implemented: missing ARN, nonexistent secret, or empty value resolves the
role's default Bedrock model before opening a session. A worker with a configured Bedrock default
keeps that model. Permission failures and inference errors do not trigger fallback. Effective
model identities drive session/usage records; a safe structured event records fallback. Init
permits a missing ARN and checks all effective role defaults, even if their requested OpenRouter
model IDs are identical. Worker task resolution no longer forces reasoning on non-reasoning
OpenRouter models. Targeted tests, type checking, and lint pass; the full regression suite passes.
Secrets remain cloud-managed; no local-key input is required to complete implementation, and no
live secret or deployment was changed.

## PR #129 independent-review fixes

- Worker and Slack secret-read attachments now live together in the control-plane stack, using the worker role ARN already exported by the foundation. Both legacy root-path and named-environment role-name expressions are covered by synthesized-template tests. The production foundation snapshot exactly equals the pre-PR mainline baseline at bdd1b19; the foundation code has no diff against that baseline.
- Secret values are trimmed before validation. LF, CRLF, and surrounding spaces successfully authenticate through the real Pi transport in scripted tests; embedded newlines remain invalid.
- Manual deployment still has three secret-reference parameters. Docs describe alignment checks and the AccessDenied failure mode. Single-source configuration remains a future improvement.
- Docs explicitly describe workspace/IMDS access to the secret, require a dedicated capped key, and explain why an external inference proxy would be a stronger boundary. No proxy or workspace credential isolation is claimed.
- Validation: full suite 2,774 passed, 8 skipped; type checking, lint, and CDK synthesis pass. No AWS deployment or paid inference was performed.
