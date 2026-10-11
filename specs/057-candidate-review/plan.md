# Implementation Plan: Candidate-Bound Verification and Review

## Architecture

Derive a canonical candidate manifest from registered repository identities and exact Git heads.
Extend check/review result contracts to carry the digest and provenance. Reuse existing readiness
checks. Add bounded read-only reviewer dispatches and persist attributed reports as claims; workflow
rules, not model output, determine whether a review stage is complete.

## Implementation sequence

1. Add candidate-manifest and review-result contracts with RED tests.
2. Bind existing check reports and PR descriptions to exact candidate heads.
3. Add read-only critic/security reviewer adapters and persist versioned reports.
4. Invalidate results on candidate or test-plan revision; expose stale/unknown states.
5. Verify interruption, timeout, redaction, and old-candidate refusal with scripted workers.

## Verification

Run focused contract, worker, publish, persistence, and end-to-end fake-worker tests, then typecheck
and the repository suite. No paid evaluation or live service test is included.
