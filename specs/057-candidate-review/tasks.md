# Tasks: Candidate-Bound Verification and Review

- [x] 1. Add failing tests for canonical candidate manifest/digest and exact repository identity.
- [x] 2. Implement candidate digest contract and bind configured checks to it. Worker snapshots the candidate at the end of its final successful check round; the broker recomputes both canonical manifests and blocks if they differ.
- [x] 3. Add RED tests for candidate-matched check and reviewer states; implement pure stage rules.
- [x] 4. Add read-only critic and security reviewer interfaces with bounded output and explicit
  provider/version attribution; enforce no-write capability.
- [x] 5. Persist broker-validated review reports and invalidate reports when the candidate changes.
- [x] 6. Verify reviewer interruption, timeout, redaction, and old-candidate refusal.
- [ ] 7. TypeScript build and 31 focused suites (555 tests) pass under Node 24.19.0; full repository
  suite and verification on declared Node 22.19.0 remain outstanding.
