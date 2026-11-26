# READ-RULE-SHARE-B mutants (owner DEC 254zzz577)

Each mutant was applied to ONE source line on top of the lane head (9cd9e005a + the two survivor tests), run against these 8 files with `--maxWorkers=1`, and reverted with `git checkout -- <file>` (tree clean after each):
`tests/unit/task-read-rule.test.ts`, `tests/contract/rd-2-0-read-rule-golden.test.ts`, `tests/contract/core-plan-comments.test.ts`, `tests/contract/task-reader-person.test.ts`, `tests/contract/read-rule-share-b-slack.test.ts`, `tests/contract/task-access.test.ts`, `tests/contract/core-task-rule-routes.test.ts`, `tests/unit/rd2a-spec-read.test.ts`.

Result: 28 of 28 killed (the last 3, S-a to S-c, after the sync with code/next 20c8e955f) (19 first; 6 added after the Sonnet pre-review, run on a717be03d against the same 8 files plus tests/contract/read-rule-share-b-prereview.test.ts) (two survived the first run and each drove a new test, noted below).

| id | what the mutant does | result | evidence |
|---|---|---|---|
| R1-a | rule 1: the stored share asks a project grant again | KILLED | 10 failed, 184 passed (194) |
| R1-b | rule 1: the stored share asks no company at all (any registered person) | KILLED | 2 failed, 192 passed (194) |
| R1-c | rule 1: the host says every registered person is a company member (other company's person counts) | KILLED | 1 failed, 193 passed (194) |
| R1-d | rule 1: the writer asks a project grant again | KILLED | 1 failed, 193 passed (194) |
| R1-e | rule 1: the writer shares with anyone registered (no company check) | KILLED | 1 failed, 193 passed (194) |
| R1-f | rule 1: the read rule does not check the company first | KILLED | 1 failed, 193 passed (194) |
| R1-g | rule 1 (Slack): a Slack Connect or foreign user is accepted (the install's team is not compared) | KILLED | 1 failed, 195 passed (196) (first run SURVIVED: the directory's own eligibility rule refuses a foreign-team profile before the teamId comparison, so no profile reached it; fixed by a test whose proof says ok for a user of another team) |
| R1-h | rule 1 (Slack): a task shared into a foreign workspace is accepted (the share's team is not compared) | KILLED | 1 failed, 193 passed (194) |
| R2-a | rule 2: the stored share ignores the People list's deny | KILLED | 7 failed, 187 passed (194) |
| R2-b | rule 2: the People rule lets a denied entry through to the implicit role (the channel share beats a removal) | KILLED | 3 failed, 191 passed (194) |
| R3-a | rule 3 cell comment-write: a People viewer may not comment | KILLED | 2 failed, 192 passed (194) |
| R3-b | rule 3 cell plan: a People commenter/viewer is not admitted to the plan | KILLED | 7 failed, 187 passed (194) |
| R3-c | rule 3 cell evidence: a People commenter/viewer is not admitted to the proof | KILLED | 7 failed, 187 passed (194) |
| R3-d | rule 3 cell diff: a stored share is not shown the diff | KILLED | 13 failed, 181 passed (194) |
| R3-e | rule 3: the stored share's comment is not tied to its row (S5: the check is not pushed) | KILLED | 1 failed, 193 passed (194) |
| R3-f | rule 3: the stored share's row key names the wrong person (S5) | KILLED | 2 failed, 192 passed (194) |
| R3-g | rule 3: a stored share cannot comment (the comment access never asks the rule) | KILLED | 3 failed, 191 passed (194) |
| R3-h | rule 3: the comment access lets a non-share decision through (Opus M1 mutant: mode shared -> any) | KILLED | 1 failed, 195 passed (196) (first run SURVIVED (equivalent for every reachable person once a People viewer can comment: every mode the People rule refuses is also refused by the rule); fixed by a test that hands the comment route decisions of mode page, reader and owner for a person the People rule refuses) |
| S4-a | Opus S4: work-item text keeps its paths for a reader without source code | KILLED | 1 failed, 193 passed (194) |
| R3-i | S5 (pre-review NIT-2): the cancellation index of the share check is off by one | KILLED | 1 failed, 197 passed (198) |
| R3-j | S5 (pre-review NIT-2): the share check asks only that the row exists, not its role | KILLED | 1 failed, 197 passed (198) (the test changes the row's role between the decision and the write) |
| R2-c | pre-review S1: the share's write does not refuse a person the People list denies | KILLED | 1 failed, 197 passed (198) (the test denies inside `authorize`) |
| R3-k | pre-review S2: the plan comment write goes back to the Slack `comment` cell (a viewer cannot write) | KILLED | 1 failed, 197 passed (198) |
| R3-l | pre-review S2: the Slack continue cell admits a viewer again | KILLED | 2 failed, 196 passed (198) |
| R1-i | pre-review S3: with no company layer a registered person is a company member (fail open) | KILLED | 3 failed, 195 passed (198) |
| S-a | sync: taskReaderPerson drops the rethrow of a failed membership read (it would read as not a member) | KILLED | 2 failed, 202 passed (204) |
| S-b | Opus NIT 1: the ownTask returns hard-code companyMember true | KILLED | 1 failed, 203 passed (204) |
| S-c | sync: the read rule's stored-share lookup drops the rethrow of a failed membership read | KILLED | 1 failed, 203 passed (204) |

Rule / cell coverage:
- Rule 1 (same company, no project access): R1-a..R1-f (stored share, host read, writer, company-first), R1-g and R1-h (Slack Connect or foreign workspace).
- Rule 2 (removal wins): R2-a (stored share), R2-b (the People rule, which the channel share goes through).
- Rule 3 and the cells that moved: R3-a (viewer comment-write cell), R3-b (plan), R3-c (evidence), R3-d (diff, shared), R3-e and R3-f (S5 row check), R3-g and R3-h (the stored share comment path).
- Opus S4: S4-a.
- The 10 `left the project` cells (task, answers, events, diff, plan, evidence, comments, spec, checks, changes) all follow from R1-a/R1-b and are pinned one by one by the golden `CHANGED` list.
