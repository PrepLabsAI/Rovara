# SETUP-INSTALL-ROW mutants (Code)

Each mutant is applied to the file named, `tests/unit/setup-mismatch-warning.test.ts` and `tests/unit/core-host-setup-approval.test.ts` are run, and the file is restored. KILLED = the test file failed.

| Mutant | File | Result |
| --- | --- | --- |
| M1 unmatched command never recorded | packages/broker/src/core/setup-agent/proposal-verify.ts | KILLED |
| M2 useAnyway also lifts a verified item | packages/broker/src/core/setup-agent/use-anyway.ts | NOT APPLIED (text not found) |
| M3 useAnyway lifts an item that was not also ticked | packages/broker/src/core/setup-agent/use-anyway.ts | KILLED |
| M4 useAnyway lifts an item of any kind | packages/broker/src/core/setup-agent/use-anyway.ts | KILLED |
| M5 the confirm path ignores useAnyway | packages/broker/src/core/setup-agent/apply.ts | KILLED |
| M14 a wrong citation (no command named) can be lifted | packages/broker/src/core/setup-agent/use-anyway.ts | KILLED |
| M6 a ticked-anyway row is counted as verified, not unchecked | packages/broker/src/core/setup-agent/use-anyway.ts | KILLED |
| M7 the refused-command rule is skipped | packages/broker/src/core/setup-agent/apply.ts | KILLED |
| M10 used-without-match lines are not stored on the candidate | packages/broker/src/core/setup-agent/apply.ts | KILLED |
| M11 the approval view drops usedWithoutMatch | packages/broker/src/core-host/setup-run-routes.ts | KILLED |
| M12 a verified row's commands are also counted as used without match | packages/broker/src/core/setup-agent/apply.ts | KILLED |
| M13 the audit ids are cut mid-list without bound | packages/broker/src/core-host/setup-run-routes.ts | KILLED |
| M8 the confirm audit row drops useAnyway | packages/broker/src/core-host/setup-run-routes.ts | KILLED |
| M9 the audit row cap is removed | packages/broker/src/core-host/setup-run-routes.ts | NOT APPLIED (text not found) |
