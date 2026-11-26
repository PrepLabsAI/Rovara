# MEMBERSHIP-READ-FAILS-SAFE mutant evidence

Moved out of MUTANTS.md (lead 4's rule: MUTANTS.md stays byte-equal to origin/code/next).

## MEMBERSHIP-READ-FAILS-SAFE, a failed membership read serves nothing, ends nothing, and is a retryable 503

One rule (`developer/membership-read.ts`): a read that says "no membership / revoked" ends access as before; a read that FAILED is a 503 RUNTIME_UNAVAILABLE, never a 401, "no such task", "no such session", or a revoked session. Each mutant applied singly; run against `tests/journeys/removed-member-answer.test.ts`, `tests/unit/removed-member-refresh.test.ts`, `tests/contract/core-app-routes.test.ts`, `tests/unit/core-host-deployed-decisions.test.ts`, `tests/contract/company-check.test.ts` (and `tests/contract/company-signin-auth.test.ts` for the sign-in check's oidc branch).

| Mutant / production location | Mutation | Result |
|---|---|---|
| core-app-routes.ts coreAppEntryFrom | The failed caller mapping answers 401 UNAUTHENTICATED again (the 503 turned back into a 401) | killed, 3 failed |
| session-mint.ts companyMayMint (hotfix-head: server.ts companyMayMint) | The catch returns false again (a failed read at the refresh revokes the session, `company_changed`) | killed, 3 failed |
| engine-boundary.ts route | The unreadable mapping answered 401 again (the core task reads then read it as "no such task") | killed, 1 failed |
| deployed-decisions.ts liveMemberRole | A failed membership read returns undefined again ("no such session") | killed, 2 failed |
| dev-routes.ts route | A failed membership read no longer answers 503 (falls to the sign-in refusal) | killed, 2 failed |
| developer-routes.ts authenticateClientToken | The oidc catch turns a failed read into the 401 refusal again (the rethrow removed) | killed, 1 failed (company-signin-auth) |
| company-check.ts membershipReader | The failed read mapped to AUTH_REQUIRED again, outside readingMembership | killed, 3 failed |
| server.ts retryable | A membership read failure is not answered 503 (propagates) | killed, 3 failed |

Own-task and grant reads (code/next after the project-grant hotfix landed; MEMBERSHIP-READ-FAILS-SAFE), run against `tests/journeys/removed-member-answer.test.ts`, whose failing read is a plain error (not a throttle the broker already answers 503) so every unwrapped read shows:

| Mutant / production location | Mutation | Result |
|---|---|---|
| task-readers.ts ownTaskHold | The catch returns false again (a failed read is "not your task": 404 TASK_NOT_FOUND) | killed, 1 failed |
| developer-routes.ts taskReaderPerson | The live-company catch returns `projectMember: false` again | killed, 1 failed |
| admin-actions.ts projectGrant | The grant read not wrapped in `readingMembership` (a raw throw is swallowed by ownTaskHold) | killed, 1 failed |
| core-engine-root.ts projectGrantRoleFromDynamo | The grant read not wrapped (a raw throw answers 400 CONFIG_INVALID) | killed, 1 failed |
| developer-routes.ts taskReaderPerson (old-engine channel check) | The nested catch around `checkProjectAccess` returns `mayStart: false` again | SURVIVED: no journey drives an old-engine task's own person through the bound-channel test; the one-line rethrow is the same as the other catches |

Old-engine own-task bound-channel check (follow-up to the SURVIVED row above), `tests/contract/own-task-channel-read-failure.test.ts`: an old-engine task's own person, held by the bound channel with no grant, with ONE failed membership read at each read of the path in turn (held, or the retryable 503, never `mayStart: false`).

| Mutant / production location | Mutation | Result |
|---|---|---|
| developer-routes.ts taskReaderPerson (old-engine channel check) | The nested catch around `checkProjectAccess` returns `mayStart: false` again | killed, 1 failed (the earlier SURVIVED row) |
| developer-routes.ts taskReaderPerson | The live-company catch returns `projectMember: false` again | killed, 1 failed |

## MEMBERSHIP-READ-FAILS-SAFE, the pre-review round: every guard, run on head aa138f0b5 (the same tree, before the rebase onto code/next b05b02740, which changed none of these files; the rebased head has the same content)

Run against: the two journeys (removed-member-answer, membership-read-families), core-task-people-identity, membership-read-signin-paths, company-signin-auth, own-task-channel-read-failure, task-access, removed-member-refresh, core-app-routes, company-check, access-recheck-merged-signin, web-proof-read-failure, task-view-read-failure, company-member-routes, company-reads-mount, core-host-lessons-api, company-shared-signin, recheck2-independent. A plain error (not a throttle) is the injected failure.

| Mutant / production location | Mutation | Result |
|---|---|---|
| core-app-routes.ts | A failed caller mapping answers 401 UNAUTHENTICATED again | killed, 5 failed |
| session-mint.ts companyMayMint | The catch returns false again (a failed read at the refresh revokes) | killed, 5 failed |
| engine-boundary.ts route | The unreadable mapping answered 401 again | killed, 3 failed |
| deployed-decisions.ts liveMemberRole | A failed read returns undefined again | killed, 2 failed |
| dev-routes.ts route | A failed membership read no longer answers 503 | killed, 4 failed |
| developer-routes.ts authenticateClientToken | The oidc catch turns a failed read into the 401 again | killed, 5 failed |
| company-check.ts membershipReader | The failed read mapped to AUTH_REQUIRED again | killed, 3 failed |
| server.ts retryable | A membership read failure is not answered 503 | killed, 4 failed |
| task-readers.ts ownTaskHold | The catch returns false again | killed, 3 failed |
| developer-routes.ts taskReaderPerson (live company) | The catch returns projectMember false again | killed, 4 failed |
| developer-routes.ts taskReaderPerson (old-engine channel check) | The nested catch returns mayStart false again | killed, 1 failed |
| admin-actions.ts projectGrant | The grant read not wrapped | killed, 3 failed |
| core-engine-root.ts projectGrantRoleFromDynamo | The grant read not wrapped | killed, 3 failed |
| server.ts refresh, company sign-in settings (previously SURVIVED) | The catch returns ended again | killed, 1 failed |
| server.ts stillSeated (previously SURVIVED) | The rethrow removed (a failed hop revokes) | killed, 1 failed |
| developer-routes.ts companylessSession (previously SURVIVED) | The rethrow removed | killed, 1 failed |
| developer-routes.ts companyOidcSession | The catch returns the 401 again | killed, 9 failed |
| developer-routes.ts requireSessionSurvivor | The catch returns the refusal again | killed, 9 failed |
| company-invites.ts companylessEligible | The reads unwrapped, a failure is false | killed, 1 failed |
| session-mint.ts memberOf | A failed join is "not a member" again | killed, 1 failed |
| server.ts authorizationCodeGrant | The checks no longer run before the code is burned | killed, 1 failed |
| task-people.ts checked | The catch returns denied again | killed, 3 failed |
| task-person-identity.ts qualifyWeb (membership, grant) and the identity record reads | Each rethrow removed | killed, 1 to 2 failed each |
| task-access.ts taskAccessOfRecord | The catch returns not found again | killed, 1 failed |
| read-rule.ts liveGrantOf, storedShare | Each rethrow removed | killed, 1 failed each |
| lessons-slack-switch-api.ts, knowledge-switch-api.ts projectRole, person-erase-route.ts, lessons-api.ts | Each rethrow removed | killed, 1 failed each |
| company-member-routes.ts, company-member-forwarding.ts | The membership read's rethrow, and the forwarding helper's "unavailable" mapping, removed | killed, 1 failed each |
| company-reads.ts membershipOf | The rethrow removed | killed, 1 failed |
| hosted-merge-routes.ts, developer-tasks.ts taskView money | Each rethrow removed | killed, 1 failed each |
| developer-routes.ts markedReads, developer record read, company membership read | Each wrapper removed | killed, 1 failed each |
| session-mint.ts isUnreadableMembershipRow | A malformed row is a retryable failure again | killed, 1 failed |

Not mutated (no test; internal rethrows listed in REMOVED-MEMBER-ANSWER-FINDINGS.md rows 22 to 26): the script-token creator's grant check, the task action registry's owner read, the session list's owner-left words, the sign-in links admin check, the broker's task-company administrator check.


## MEMBERSHIP-READ-FAILS-SAFE re-check round (head 59b5b8d8f)

Each mutant was applied to the committed file, the named test files run alone, then the file restored with git checkout.

| Mutant / production location | Mutation | Test file that kills it | Result |
|---|---|---|---|
| company-membership.ts line 137 (legacy-seat write) | `throw error` back to `return refused()` | membership-read-signin-paths | killed, 1 failed |
| dev-routes.ts 1029 (test-environment approve) | `.catch(orIfNotMembershipFailure(false))` back to `.catch(() => false)` | core-host-test-environment-approval | killed, 1 failed |
| dev-routes.ts 1053 (saved-env image) | same | core-host-saved-env-image-route | killed, 1 failed |
| dev-routes.ts 1080 (script-token create) | same | core-host-dev-routes | killed, 1 failed |
| sign-in-links.ts adminOver (row 25) | the rethrow removed | sign-in-links | killed, 1 failed |
| broker.ts administratorOfTaskCompany (row 26) | the rethrow removed | admin-name-route-guard | killed, 1 failed |
