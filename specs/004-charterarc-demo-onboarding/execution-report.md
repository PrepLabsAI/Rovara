# Credential routing execution report — 2026-09-20

## Outcome and authority

Implemented and locally verified on `codex/charterarc-demo-setup`, based on
`925ad3859d502047c87df84cc2306523a65aed43`. The owner approved inline execution.
No mainline merge, secret upload, cloud deployment, project registration or live
GitHub operation is claimed. This is credential routing, not the complete demo.

## Delivered code

1. Strict shared binding schema and canonical repository identity (`65217ea`).
2. Shared grants/PR router and isolated retryable private-key caches (`8f59530`).
3. Production factory, broker/CDK integration, exact broker-only secret grants,
   default compatibility and operator runbook (`256157d`).
4. Review fix: CloudFormation rules reject collisions against the actual retained
   legacy credential parameter before deployment, preserving runtime validation.

The complete implementation identity is the commit containing this report and
its accompanying infrastructure fix; use that commit's tree, not a branch name,
when building. Git history preserves the implementation recipe and this report.

## Verification

| Check | Observed result |
|---|---|
| Baseline suite | 101 tests / 28 files passed |
| New behavior tests | Observed RED before implementation, then GREEN |
| Fresh whole-branch reviewer | 67 focused tests passed; one Important finding, no Critical or Minor findings |
| Review regression | Missing deployment rule failed; rule implemented; 12 infrastructure tests passed |
| Final full suite, run alone | 152 tests / 31 files passed |
| TypeScript build and ESLint | Passed |
| Demo CDK synthesis | Passed; no deployment |
| Additive CDK entrypoint | Synthesized with synthetic secret metadata, not a live secret |
| Objective digest | Rechecked unchanged |

One full-suite attempt while build/synthesis also ran exceeded the infrastructure
test's existing 10-second timeout (13.7 seconds). No timeout was weakened. The
isolated rerun passed all 152 tests in 16.46 seconds. This is a local resource
contention observation, not evidence of deployed reliability.

## Review disposition and rulings

The fresh reviewer assessed `925ad385..256157d`. Important I1 was accepted:
checking only the default legacy reference allowed a custom retained reference
to collide and make the broker fail at startup. The fix adds deployment-time
rules against the actual parameter. RED→GREEN regression and the complete suite
verify the fix; no second reviewer pass was used.

Rulings, in order:

1. Use strict raw URL grammar rather than URL-first normalization to reject
   hidden aliases. Cost: unusual URL spellings require correction.
2. Extract a small production composition factory for behavior tests. Cost: one
   additional module boundary; there is no alternative test-only routing path.
3. Preserve unrelated non-GitHub public fallback, but fail malformed GitHub URLs
   closed with extra bindings active. Cost: noncanonical GitHub configs fail.
4. Remove only literal lowercase `.git`, matching the existing API adapter.
   Uppercase `.GIT` remains a repository-name suffix. Cost: unusual names need
   explicit canonical clone URLs; credentials are never widened.
5. Reviewer set aside live activation. Keep it a separate mandatory gate:
   existing/new-app smoke tests and an inspected change set are still required.
   Cost if omitted: working local code could be mistaken for a working deployment.
6. Reviewer set aside Team Tasks runtime/image/project admission. Preserve it as
   follow-on work, not completed routing scope. Cost: the demo still cannot run
   until that environment is prepared and registered.
7. Reviewer set aside candidate freeze/publication and conversation restoration.
   Keep issues #2 and #1 separate. Cost: neither immutable handoff nor remembered
   follow-ups are established by this branch.
8. Reviewer set aside the existing adapter's case-sensitive returned-PR-URL
   validation. Preserve it here: this change routes credentials, not provider
   response semantics. Cost: some differently cased URLs may still be rejected.

Deferred minors: none.

## Required next live gates

Follow `credential-rollout.md`: establish scoped MFA session, create only the new
secret if absent, inspect a parameter-preserving CDK change set, obtain scoped
deployment authority, deploy the reviewed version, and smoke-test both apps.
Prepare the separate compatible Team Tasks runtime and project binding. Retain
the old app, key, state resources and runtime. Capture source→artifact→deployment
receipts rather than assume current mainline equals deployed source.

## Postflight

```yaml
executed_against: MSDLC-OBJ-001@0.3
objective_digest: sha256:bc902e9dcecec61f32d748ae290dcab417311db1382e5dbcac59bb1887845843
alignment: pass
result_status: verified
evidence_added: [contract-tests, production-composition-tests, synthesis-tests, fresh-review, review-regression]
decision_proposals: []
assumption_changes: []
scope_delta: none
contradictions: []
objective_change_attempted: false
objective_digest_match: true
```

`verified` above means local code verification only, not live activation or
customer validation.
