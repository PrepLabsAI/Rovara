# Mutants for SETUP-L2-RUNNABLE, trimmed (smoke checks only; each must make a named test fail in tests/unit/setup-smoke-check-label.test.ts; no gate or suite run by anyone else meanwhile; revert after each)
1. `readSetupProposalAnswer` does not call `labelSmokeChecks`. Expect: the first three tests fail (no label, a marked tests entry stays a test).
2. `labelSmokeChecks` leaves a marked tests entry in `tests` (the filter keeps it). Expect: "moved to checks, never a test" fails.
3. A moved entry with several commands keeps ONE name (the reader merges them by repository and name). Expect: the "names that differ" assertion fails (one check lost).
4. `smokeName` drops the label (returns the agent's own name). Expect: the name assertions fail.
5. `smokeCitations` does not put the label on the note (only on the name). Expect: the citation-note assertions fail.
6. `labelSmokeChecks` labels every check (not only smoke ones). Expect: "a real test and a real check are left alone" fails.
7. `labelSmokeChecks` changes the answer it is given in place. Expect: the "does not change the answer" test fails.
8. `SETUP_AGENT_SMOKE_LINES` leaves the agent prompt, or loses "never in `tests`", the label, "must not write anything" or `-B`. Expect: the "what the setup agent is told" smoke test fails.
9. The rules put "No `|` or `;`" back. Expect: the "run as shell lines" test fails.
