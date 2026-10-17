# Task 2B: trusted E2E scenario compiler

## Result

Implemented the bounded trusted compiler in `@agentx/verifier`, using the pinned `e2e@0.20.0` public list API. `compileE2EScenarios(bundle, effectiveTargets, group, immutableCompilationContext)` requires the full immutable compilation context; there is no unchecked three-argument materialization path. The compiler revalidates the candidate manifest/source snapshot and bundle, reruns the shared execution planner from supplied selection inputs, verifies the exact selected group and targets, and validates registered operations against source export maps and TypeScript ASTs without importing candidate code.

The compiler records the three identities separately: package export subpath, module specifier/source, and explicit callable selector. Case bindings and generated selection packets bind the operation descriptor, semantic delta, `contained-candidate-process-response/v1`, `supervisor-admitted-json-request/v1`, account profile, requested target, compiler case identity, and distinct Rovara/upstream test/upstream result IDs. Generated test/config/selection packet files receive a hash inventory. Assertions remain ordered and all assertion steps are emitted per case. Public-list matching rejects duplicates, missing/extra/unmatched tuples, wrong target/agent, and unexpected test/session/serial shapes.

The pinned-list observation exercised three target assignments: 3 `run`, 6 expected cross-target `filtered`, and 0 selected skips. The actual public list IDs and generated file/title paths are recorded in the receipt. Package layering remains verifier -> broker -> contracts; broker publishes the planner subpath and does not import verifier.

## Verification

Node `v22.23.2` on Darwin arm64. Pinned archive `e2e@0.20.0`: SHA-256 `d4f14df48af6cb091313dc015587c90b1c875762ba319281f8d9b128ad2d7542`; npm integrity `sha512-MqpN6TSGIvRa3X2Hj1pWtYrBeW+qEsj3EVEelZlUT3NofIr9yHBFtPfdmIh18quA9AIWX8XrFBYPNn0WdZ9OTQ==`.

- Focused compiler suite: 4 passed; final log SHA-256 `b125ab2b8d4f87c70afef3664441350f900643570f9e784ef010a07aa5a53866`.
- Build passed; log SHA-256 `a8e1ec2a2c5476c184dfdc284b19117a5b750bb4780b06649a640e496ab38bba`.
- Strict typecheck passed: 0 errors, baseline 0; log SHA-256 `d4d76d56c77950b7e3a5e86899abc47500e6616c13469131126688906f2441fb`.
- `git diff --check` passed.
- Causal red selector test: `selector-red.log`, SHA-256 `de824f1e367a0a77945dfaef04e068cf313a1196b06988aa796ce2b6cf903e71`.
- Actual pinned public-list evidence: `public-list-receipt.json`, SHA-256 `896899dd1163654f5b373f67a3da8b83c2ac0f1be6315093e1f49ce04f80ee5d`. It records archive, lockfile, runner and ID/config source hashes, generated inventory, config digest projection, packet, environment, and actual list output.

Evidence is in `/Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2b/`.

## Limits and open integration

This is compiler/template and public-list evidence only. It does not run candidate code, prove a named callable body ran, provide the supervisor-owned request/response lifecycle or trusted observation receipts, parse/qualify a runtime report, establish native runtime behavior, or qualify external floors. The generated config digest is a source-derived projection; comparing it with an actual CLI run digest remains for the runtime unit. Source-interface purpose is carried in the compilation identity and source is statically checked, but no source-interface runtime smoke is claimed.

The current planner requires a scenario account profile to equal the target account profile, while discovery uses the `synthetic` scenario profile. Therefore one scenario cannot presently compose distinct account-profile variants through this compiler without an upstream planner change; the compiler preserves the planner result and does not bypass that check. Unit 3/4 still needs to consume and qualify the case bindings and own the adapter/request/response/cleanup and evidence lifecycle. Native Unit 5/6 continues through the normal connect-and-approve path.

## Postflight

```yaml
executed_against: MSDLC-OBJ-001@0.4
alignment: pass
result_status: implemented
evidence_added:
  - pinned public-list receipt and compiler verification logs in sibling task2b evidence directory
decision_proposals: []
assumption_changes: []
scope_delta: none
contradictions: []
objective_change_attempted: false
objective_digest_match: true
```
