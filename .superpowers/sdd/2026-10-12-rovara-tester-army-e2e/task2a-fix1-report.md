# Task 2A scoped review-fix report

## Postflight

```yaml
executed_against: MSDLC-OBJ-001@0.4
objective_digest: sha256:707543b940253c8e068da55af87b81b4c57dd8d0e82f83436be13f5391cdf0c2
alignment: pass
result_status: implemented
evidence_added:
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix1-red-baseline.log
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix1-red-regressions.log
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix1-red-graphidentity.log
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix1-focused-green.log
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix1-cli-regressions.log
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix1-build.log
  - /Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix1-typecheck.log
decision_proposals: []
assumption_changes: []
scope_delta: none
contradictions: []
objective_change_attempted: false
objective_digest_match: true
```

## Findings addressed

- **F1:** GitHub snapshot ingestion now requires the commit tree response SHA to equal the pinned tree SHA, requires the blob response SHA to equal its selected tree entry, bounds JSON/base64 before decoding, and independently recomputes Git's `blob <length>\0<bytes>` SHA-1 before recording the source SHA-256. The fix test substitutes equal-length bytes and mismatched tree identity.
- **F2:** Planning requires every inherited baseline scenario ID in the approved inventory and rejects duplicate IDs. Missing inventory fails before any criterion set is returned.
- **F3:** Execution cases require a source-derived operation mapped to the exact target, one supported null-input contract invocation, one supported result-state assertion, mock-contract evidence, null model routing, and a qualified default sandbox. Native taps, agent steps, unknown operations, other assertions, and unsupported floors retain unavailable criteria without cases.
- **F4:** Discovery, proposal verification, planner and CLI use a shared candidate-bound immutable snapshot verifier. It recomputes the canonical candidate manifest, checks expected candidate equality, commit/tree consistency, complete bounded membership, source path safety/kind/membership, per-file hashes and aggregate limits. This is structural verification: a native caller must still load the expected candidate from an authenticated record; the unit does not implement that later authority boundary.
- **F5:** Setup proposals must equal a fresh source-derived inspection, including application graph, targets, recipes, source references and input dispositions. The CLI uses that same verifier. Duplicate package names receive path-qualified deterministic application IDs. Fabricated recipe/account metadata and graph edits are rejected.
- **F6:** Caller mock entries are usable only when their component is a source-derived dependency edge for the application and they identify the exact verified OpenAPI JSON source with a nonempty schema path set. Arbitrary module bytes cannot establish an API fixture. Required component floors remain on unavailable criteria.
- **F7:** Repository-root service recipes use the explicit safe cwd `.` representation; parent traversal remains rejected.
- **F8:** Standalone Android/iOS metadata is discovered independently from JavaScript manifests. App IDs come from Android manifest package or iOS bundle metadata. Missing native metadata does not create a guessed platform target. Native desktop metadata retains OS-specific unavailable targets.
- **F9:** Export operation IDs use a deterministic SHA-256 codec over application identity and the complete normalized export key, preserving valid subpaths and avoiding cross-application collisions.
- **F10:** Case/upstream tuple identity includes canonical scenario content, requested/effective target, account profile, evidence floor, required component floor, default agent and repeat. Effective target IDs hash requested IDs that would exceed the contract's 80-character bound; the requested mapping remains explicit.

The source tree inventory is allowed to contain paths that are excluded from candidate source bytes, such as `.env`, because it is membership evidence. Such paths cannot be promoted as runner source. No source discovery imports or executes candidate code.

## Verification and boundaries

Using Node `v22.23.2` from `/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin`:

- Red: all seven initial independent review repro groups failed their expected protections on the original current-head source; raw output is preserved in `task2a-fix1-red-baseline.log` and `task2a-fix1-red-regressions.log`. The additional duplicate-workspace-identity regression was recorded red before its correction in `task2a-fix1-red-graphidentity.log`.
- Green: 5 focused files, **70/70 tests**; 4 existing CLI regression files, **113/113 tests**.
- `npm run build` passed.
- `npm run typecheck:all` passed with strict baseline **0 errors**.
- `git diff --check` passed.

These checks establish the local discovery/planning/typed setup seam only. The portable operation is a source-bound candidate operation plan, not runtime execution evidence. Native mobile/desktop execution, actual sandboxing, compiler/upstream tuple validation, authenticated catalog loading, persisted registrar/workflow composition, and full journey qualification remain later units. This report does not claim complete P0 workflow or production qualification. No full 10,428-test run, live/cloud request, credential retrieval, publication, push or PR was performed.

The exact local source commit/tree and clean-state receipt are in the sibling evidence file `task2a-fix1-commit-receipt.md`.
