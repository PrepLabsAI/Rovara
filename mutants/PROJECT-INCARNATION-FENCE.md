# PROJECT-INCARNATION-FENCE mutants (Code, branch pr/project-incarnation-fence-20261126)

STATUS: RUN 2026-11-26. Each mutant applied singly to the committed tree, then `tests/unit/project-incarnation-fence.test.ts`, `tests/unit/project-incarnation-lifecycle.test.ts`, `tests/contract/project-lifecycle-routes.test.ts`, `tests/contract/admin-read-contracts.test.ts` and `tests/contract/code-api-version.test.ts` (--maxWorkers=1), then reverted with `git checkout`. Contract-file mutants rebuild `packages/contracts` before the run and after the revert. 19 of 19 killed (rerun on the final code after the pre-review fixes: counted refusal row, receipt incarnation, log line).

| # | Location | Mutation | First failing test | Result |
|---|---|---|---|---|
| M1 | packages/broker/src/aws/project-lifecycle-routes.ts fenceIncarnation() (called first thing in change()) | the incarnation guard becomes `false` (never refuse) | contract "accepts the previewed incarnation over the wire..."; unit "a project with no incarnation..." | killed |
| M2 | same, fenceIncarnation | `!==` becomes `===` (refuse a match, accept a mismatch) | contract "accepts the previewed incarnation over the wire..."; unit "a project with no incarnation..." | killed |
| M3 | same | skip the check when the project has no incarnation (`current.incarnationRevision !== undefined &&`) | unit "a project with no incarnation: ... a confirm naming one is refused" | killed |
| M4 | same | drop the `recordRefusal` call (no audit row) | unit "the refusal says why in the audit..." and "restore: a mismatch is refused the same way..." | killed |
| M5 | recordRefusal | the row key also carries the request id (rows unbounded again: S1) | unit "repeating a bad confirm (new request ids, any number named) raises one counter on one row..." and the reviewer's "one authorized person repeating a refused confirm... stays on one row" | killed |
| M6 | recordRefusal | the best-effort catch rethrows (a failed audit write escapes) | unit "the refusal stands when its audit row cannot be written, and the failure leaves one log line" | killed |
| M7 | fenceIncarnation() | the mismatch throws the plain `LIFECYCLE_STALE` sentence | contract "accepts the previewed incarnation over the wire..."; unit "a project with no incarnation..." | killed |
| M8 | recordRefusal | the row records the current number as the previewed one | unit "the refusal says why in the audit..." | killed |
| M9 | recordRefusal | the row's `action` value always says "archive" | unit "restore: a mismatch is refused the same way..." | killed |
| M10 | packages/contracts/src/reviewed-project-archive.ts | the archive body drops the field (strict refuses it) | contract "accepts the previewed incarnation over the wire..."; unit "the confirm bodies > archive takes the optional incarnation..." | killed |
| M11 | packages/contracts/src/reviewed-project-restore.ts | the restore body drops the field | contract "restore: the same over the wire..."; unit "the confirm bodies > restore ..." | killed |
| M12 | reviewed-project-archive.ts | the archive body's incarnation accepts 0 (`nonnegative`) | contract "still refuses a body with an unknown member, and one whose incarnation is not a positive whole number"; unit "the confirm bodies > archive ..." | killed |
| M13 | reviewed-project-restore.ts | the restore body REQUIRES the field (an older Cloud would break) | contract "archiving and restoring > refuses a change made against other revisions..." and 2 more | killed |
| M14 | change() | the incarnation check moved after the receipt replay | unit "a retry of a confirm that already happened answers its receipt only while the project is still the one previewed" | killed |
| M15 | change() | the incarnation check moved before the access check | unit "a person who may not change the project gets the fixed refusal, not the incarnation sentence, and no row" | killed |
| M16 | recordRefusal | the counter adds 2 | unit "the refusal says why in the audit..." (refusals: 1) | killed |
| M17 | receiptAnswers | a receipt answers whatever incarnation it was written under (S3) | unit "the receipt records the incarnation it was written under, and a repeat of its request id is stale..." | killed |
| M18 | change() | the receipt row does not record the incarnation (S3) | same test | killed |
| M19 | recordRefusal | a failed audit write leaves no log line (N1) | unit "the refusal stands when its audit row cannot be written, and the failure leaves one log line" | killed |

The runner was a scratch script (`pif-code-mutants.py` in the scratchpad), not part of the repo.
