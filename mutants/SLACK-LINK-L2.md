# SLACK-LINK-L2: connecting Slack adopts an unused company-less record (2026-11-25)

Every mutant is a change to `adoptableCompanyLessRecord` or `adoptWrite` in packages/broker/src/developer/sign-in-links.ts, run against tests/contract/sign-in-links.test.ts (47 tests, all green on the real tree). The source was restored after each run (clean tree).

| Mutant | Change | Result |
|---|---|---|
| M1 | adopt a record WITH a membership: the membership-row read is dropped from the check | killed (3: the used/member table, the companyless=true-with-live-membership case, the exported-check test; the transaction's own membership ConditionCheck would still refuse it as `changed_meanwhile`, and the tests assert the reason `identity_taken`) |
| M2 | adopt a MERGED, linked or unlinked record: the never-connected check is dropped | killed (5: the used/member table, the exported-check test, and three re-link tests: a kept unlinked record would be adopted by the wrong person/company) |
| M3 | adopt a record signed in more than once (or whose name was chosen) | killed (2) |
| M4 | adopt a record that is not flagged company-less | killed (2) |
| M5 | adopt a record an admin turned off | killed (2) |
| M6 | adopt a row that is not the identity's own (key, issuer and subject not tied) | killed (2) |
| M7 | adopt the other method's record (method check dropped) | killed (2) |
| M8 | the transaction no longer re-checks the single sign-in (`lastSignInAt = :first`) | killed (1: signed in again between the read and the write) |
| M9 | the transaction no longer re-checks `attribute_not_exists(mergedInto)` | killed (1) |
| M10 | the transaction no longer re-checks `companyless = :true` | killed (2) |
| M11 | the transaction no longer re-checks `revoked = :false` | killed (2) |
| M12 | the adopted record's own session is not ended (`sessionsEndedAt` not set) | killed (1: its refresh token is refused after the adoption) |

Red-first: with the production change stashed, 3 of the 5 tests of the new group fail (the owner's case with `identity_taken`, the transaction re-check, the exported check); the other two pass because the refusals they pin already hold.
