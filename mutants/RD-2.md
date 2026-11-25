# RD-2 mutants (the four task page read lanes: spec, checks, changes, evidence file; and the share decision)

Moved here from MUTANTS.md (that file stays equal to code/next; append-only rows live in this file).


## RD-2a - the task page's spec read (`GET /v1/dev/tasks/{taskId}/spec`; base RD-2.0 a65c40ce7)

Production guards this lane adds: the task read's own rule in `core-host/task-spec-routes.ts` (`loadReadableTask` before anything is read), and in `core/task-view/spec.ts` the layer states (not written, superseded, unreadable with no older-version fallback, Markdown not served), the approval and gate-decision matching by digest, the comment tally (live, people's, current version only, read tolerantly), the digest waited on only at a gate, the derived decision status (answers of the approval), the design review's open questions, redaction of model text, and the Quick-only "bigger than Quick" reasons. Each mutant was applied singly to a copy of the file and restored; all in `tests/unit/rd2a-spec-read.test.ts`.

| Mutant | Mutation | Killed by (first failing tests) |
|---|---|---|
| M1 handler | the task is read without `loadReadableTask` (no access rule) | the real-task cases and the colleague / other-company refusal test |
| M2 layerOf | an unreadable structured document keeps its derived state | "an unreadable structured document is `unreadable` ..." |
| M3 stateOf | no `superseded` for a coding plan written before the Full path | "a coding plan written before the task went the Full way is history" |
| M4 decisionOn | a send-back counts as a gate decision on the plan | "a plan sent back or rejected says so ..." |
| M5 commentCounts | deleted comments counted | "a Quick plan at its gate ..." (comment counts) |
| M6 commentCounts | AgentX replies counted | same |
| M7 layerOf | comments of any version counted | same |
| M8 specOf | `waitingDocumentDigest` served when the task is not at its gate | "an approved plan ..." |
| M9 specOf | "bigger than Quick" served in any layer state | "a Quick plan that looks bigger than Quick ..." (approved case) |
| M10 decisionsOf | any answer override counts as this decision's | "an approved plan ..." (override of another decision) |
| M11 openQuestionsOf | an answered question stays open | "the design review's open questions ..." |
| M12 openQuestionsOf | question text not redacted | same |
| M13 specOf | a Quick task shows all three layers | "a Quick task with no plan yet ..." |
| M14 decisionOn | any decision of the kind counts, not only the one holding this digest | "a Full task: three layers ..." |
| M15 layerOf | a Markdown document is read as structured | "a document stored as Markdown ..." |

All 15 killed; the restored tree passes (the new file 15 tests). Evidence applies to this lane's commit; the final-head gate and review belong to 9d.

### RD-2a follow-up (Sonnet pre-review: the six surviving mutants, S1, S2, S4) - 13 more, all killed (tests/unit/rd2a-spec-read.test.ts, run singly)

The document read is now narrower (the bytes and digest only, `loadWorkflowDocument` plus the plan's redaction; no check summary or self-check read), `waitingDocumentDigest` is withheld when the waited-on layer is unreadable, and design-question ids are redacted too.

| Mutant | Mutation | Killed by |
|---|---|---|
| N1 specOf | digest offered although the waited-on layer is unreadable | "unreadable ... " (tampered) and "an approved plan whose stored bytes no longer verify ..." |
| N2 layerOf | a read beyond the document (self-check style key) | "reads only the document itself ..." |
| N3 specOf | bigger-than-Quick on any path | "bigger-than-Quick is for a Quick task only ..." |
| N4 atGate | closed task still counts as at its gate | "a closed task waits on nothing ..." |
| N5 commentCounts | a row of another task under this key counted | "only this task's own, well-formed comments ..." |
| N6 commentCounts | untyped document or version counted | same |
| N7 commentCounts | no paging (first page only) | "comments are read page by page ..." |
| N8 commentCounts | no read limit | same (the endless store throws) |
| N9 stateOf | superseded loses to a rejection or change request | "a coding plan written before the task went the Full way is history ..." |
| N10 layerOf | an unreadable layer still claims `approved` | "an approved plan whose stored bytes no longer verify ..." |
| N11 commentCounts | thread replies not counted | "a person's reply in a thread is a comment and counts ..." |
| N12 layerOf | the task's own object folder check removed | "a document whose object is not in this task's own folder is unreadable ..." |
| N13 core/task-flow/reads.ts (not this lane's file; mutated and restored) | `TASK_ACCESS_DENIED` from `canRead` not mapped to not-found | "the People list's own read rule ..." |

Not mutation-tested: `redactText` on the design question's `id`, `recommended` and option ids (the stored schema caps them at 16 characters, so no secret pattern fits; the redaction is for the literal rule only).

### RD-2a Opus leftovers (S1, N1, N2) - 2 more, both killed (tests/unit/rd2a-spec-read.test.ts)

| Mutant | Mutation | Killed by |
|---|---|---|
| P1 layerOf | the catch rethrows (a reader that throws fails the whole read) | "a document reader that THROWS ... makes the layer unreadable" |
| P2 specOf | `waitingDocumentDigest` offered for any waited-on layer, not only one whose bytes were read and verified | the Markdown test and the tampered / approved-but-unreadable tests |

N2 (`answer` of a changed decision passed through `redactText`) has no test: the stored option id is capped short by its schema, so no secret pattern fits (the redaction is for the literal rule).

## RD-2a on the read rule (rebased onto 49080fbea, 2026-11-25)

The spec handler no longer reads the task or asks any access rule: the mount asks `decideTaskRead` once and hands `context.decision` (core-host/task-screen-routes.ts); `readTaskSpec` reads `context.decision.task`. The earlier mutant "handler without the read rule" is now a mount mutant (RD-2.0-READ-RULE M-series: `routeTaskScreen` that skips `context.decide`), killed by `tests/unit/task-read-rule.test.ts` (the 18 x 14 table on the real routes, spec cells) and the golden (`tests/contract/rd-2-0-read-rule-golden.test.ts`, the four admitted persons' spec cells are listed in `CHANGED`). A share's spec answer is the table's 403 TASK_PART_NOT_SHOWN (ship B), pinned by the same table.

## RD-2b2 - the task page's Changes read (`core/task-view/changes.ts`, `core-host/task-changes-routes.ts`; branch base RD-2.0 a65c40ce7, working tree before the commit)

Production guards this lane adds: the read rule (`readableTask` is `loadReadableTask` alone: after the coordinator's ruling this file has no shared-reader rule of its own); secret redaction and unsafe-character removal in `plainLine` and the patch; the patch limits (per file, whole answer); the file and page caps; the labels (`worker_report` is never `checkedAgainstCodeHost`); the https-only pull request address; the diff route's "too long" words and non-200 answers; the why join (latest review round only, a finding only for its own repository, the per-file cap, code evidence only); the one mount line that hands the deployment's old task rules to the handler. Each mutant was applied singly to the working tree, `tests/unit/rd2b2-changes-read.test.ts` run, the file restored byte for byte.

| Mutant | Mutation | Killed by (rd2b2-changes-read.test.ts) |
|---|---|---|
| M1, M2 | (the shared-reader fallback mutants; the fallback was removed per the ruling, and "has no shared-reader rule of its own" now pins that a person the old rule would admit reads no such task and `readsAsReader` is never asked) | n/a |
| M3 | `loadReadableTask` replaced by a bare read | "another company's caller, a colleague, a company admin ..." and the empty-read test |
| M4 | patch not redacted | "removes control and direction characters ..." |
| M5 | unsafe (control, direction) characters kept in a path | same |
| M6 | path and why text not redacted | same |
| M7 | whole-answer patch budget off | "keeps a patch under the per-file limit ..." |
| M8 | per-file patch limit off | same |
| M9 | file cap off | "lists at most CHANGES_FILES_MAX files ..." |
| M10 | page cap off | same |
| M11 | worker report labelled `checkedAgainstCodeHost: true` | "serves the worker's report labelled unchecked ..." and two more |
| M12 | any pull request address served (not only https) | "a count that is not a whole non-negative number ..." |
| M13 | the diff route's "too long" words served as a patch | "pages the pull request's files through the deployment's diff route ..." |
| M14 | a finding shown for a file of another repository | "joins by path ..." |
| M15 | the first review round read instead of the latest | same |
| M16 | evidence of any kind with a path counts | SURVIVED: equivalent (only `code` evidence has a `path` in the plan schema) |
| M17 | per-file why cap off | "shows at most CHANGES_WHY_PER_FILE_MAX entries ..." |
| M18 | the mount no longer hands `taskRules` to the handler | "pages the pull request's files ..." and the reader test |
| M19 | the code host's kept list ignored | "falls back to the code host's kept list ..." and two more |
| M20 | a non-200 diff answer accepted | SURVIVED the first test set (a failing answer has no page-shaped body); killed by the added "a diff answer that is not a 200 is not used ..." |

19 of 20 killed by tests; M16 is an equivalent mutant (no plan evidence kind but `code` has a path).

### RD-2b2 round 2 (Sonnet pre-review: 2 must-fix, 6 should-fix), same method, `tests/unit/rd2b2-changes-read.test.ts`

| Mutant | Mutation | Killed by |
|---|---|---|
| N1 | a pull request whose first page cannot be read is not counted (MF1) | "a pull request whose first page cannot be read is counted ..." |
| N2 | a patch body not made safe (control, C1, direction characters; MF2) | "makes a patch body safe too ..." |
| N3 | pages still read once the 200-file cap is full | the cap tests (7 pages asked; no second pull request read) |
| N4 | the source-code gate ignored (the diff is fetched although the gate says no) | "the source-code gate: when it says no the code host is never asked ..." |
| N5 | plan steps and checks attached in a multi-repository task | "attaches a plan step and its checks only when the repository is unambiguous ..." |
| N6 | a plan or review of an unexpected shape throws instead of giving no why | "a plan or review of an unexpected shape gives no why ..." |
| N7 | pages not cached / not shared | "asks the code host once for the same pages ..." |
| N8 | the pull request's head left out of the cache key | same |
| N9 | the time budget ignored | "stops reading pages when the time budget is spent ..." |
| N10 | a file with no usable name not counted | "counts a file whose name is empty after cleaning ..." |
| N11 | the cache remembers a failed page | "keeps a page for its time ..." and the fallback test |

11 of 11 killed.

### RD-2b2 round 3 (Opus permissions pass leftovers S1-S4), `tests/unit/rd2b2-changes-read.test.ts`

| Mutant | Mutation | Killed by |
|---|---|---|
| P1 | pull requests past the 10 read not counted in filesNotListed | "counts pull requests past the most read ..." |
| P2 | a pull request with an unusable repository id not counted | same |
| P3 | a pull request address with control or direction characters served | "serves a pull request address only when ..." |
| P4 | the company left out of the cache key (two companies could share a page) | "a pull request with no recorded head is never cached ... and the key names the company" |
| P5 | a pull request with no recorded head cached | same |

5 of 5 killed.

## RD-2b2 on the read rule (rebased onto 49080fbea, 2026-11-25)

The changes handler reads `context.decision` (the mount asked `decideTaskRead`); `readableTask`, its own `mayReadSourceCode` and every copy of the shared-reader rule are gone. Source code (patches AND file paths, from every source) follows `decision.sourceCode`, decided per request before the page cache. The old mutants of the shared-reader fallback and of the injected gate are replaced by these (each applied alone to `core-host/task-changes-routes.ts`):

| Mutant | Mutation | Killed by |
|---|---|---|
| R1 | `decision.sourceCode` ignored (sources always built) | rd2b2-changes-read "the source-code part of the decision" (no code host call, no path or patch from any source when the part is false, and a cache filled by an earlier reader is not handed over) |
| R2 | the kept list and the worker's report read when the part is false (the old gate only closed the pull request's pages) | the same test (`checked.ts` must not appear) |
| R3 | the mount does not forward `authorize` (the diff route cannot ask the rule) | "pages the pull request's files through the deployment's diff route": the route mock asks `authorize("diff")` and its answer is the task; without it no page is read |

A share's answer on the changes read is the table's 403 TASK_PART_NOT_SHOWN (rd2b2 "has no shared-reader rule of its own", and the 18 x 14 table). An earlier mutant of this lane that built the pull request page reader while the part was false survived because the sources object was replaced by `{}` anyway; the sources are now built in one function (`sourcesOf`) so there is nothing redundant to mutate.

## RD-2b1 - the task page's checks read (on RD-2.0 a65c40ce7)

Production guards this lane adds: the task read's own rule first (`loadReadableTask`) and the retention check on each linked file in `core-host/task-checks-routes.ts`; the plan version choice (the approved one); and, in `core/task-view/checks.ts`, the current-code rules (a result or a pack for other code is Out of date or ignored), the state derivation (known failing, couldn't verify, flaky, running), the claim mapping, the review rows (blocking findings only, accepted flag, failure marker), the failure budget, the links check and the plain-words rule. Each mutation applied singly to the working tree and restored; all in tests/unit/rd2b1-checks-read.test.ts.

| Mutant / location | Mutation | Failing test |
|---|---|---|
| M1 routes: access rule | `loadReadableTask` replaced by a bare task read | "the task read's own rule" (another company, colleague and admin read the task) and "two companies' packs stay apart" |
| M2 checks.ts `verifiedOf` | a result for other code read as current | "a result for other code ... is Out of date" |
| M3 checks.ts pack gate | a pack for other code accepted | same test (a foreign pack's before/after shows) |
| M4 routes: retention | a file gone from the store still "available" | "the kept pack: ... 'expired'" |
| M5 routes: size check | other bytes under the name still "available" | same test ("withheld") |
| M6 checks.ts `rowStateOf` | `already_failing` no longer Known failing | "passed, failed, flaky, known failing, couldn't verify ..." |
| M7 checks.ts `rowStateOf` | a missing program no longer Couldn't verify | same test |
| M8 checks.ts reviews | non-blocking remarks listed as findings | "the Code and Security review rows" |
| M9 checks.ts reviews | `accepted` always false | same test |
| M10 checks.ts failures | the ten-failure budget never spent | "lists the failing tests with their likely cause, ten across all rows" |
| M11 checks.ts links | links built for another pack used | "the output tail is a link ... 'withheld'" (other pack case) |
| M12 checks.ts acceptance | every check listed for every claim | "each plan claim lists the checks that prove it", "a check the plan proves ...", the scenario test and the owner read |
| M13 routes: plan version | the approved version ignored (latest read) | "the claims come from the plan version the owner approved" |
| M14 checks.ts scenarios | the end-to-end aggregate shown beside its scenarios | "the aggregate end-to-end result is shown as its scenarios" |
| M15 checks.ts words | text not made plain | "every text from a repository, a worker or a model is made plain" |
| M16 checks.ts `rowStateOf` | Running read as Not run yet | states test and the Out-of-date/Running case |
| M17 checks.ts flaky | flaky never read | states test |
| M18 checks.ts `verifiedOf` | an Out of date row shows the current commit | "a result for other code ... is Out of date" (ranOn is only the time) |
| M19 routes: plan | an unreadable plan answered silently | "a plan that cannot be read says so" |
| M20 checks.ts reviews | a review's failure marker ignored | "the Code and Security review rows" |

All 20 killed; the restored tree passes. Evidence applies to this lane's commit (parent a65c40ce7); the final-head gate and review belong to 9d.

## RD-2b1 round 2 - Sonnet pre-review fixes (same lane, one new commit on 1d7edd14f)

Guards added: customer text stripped of control, direction and invisible characters before redaction (`plainText`); no claim from an unapproved plan (a fixed sentence instead); approved Markdown plan and unreadable pack said in fixed words; the held file compared by size AND digest; no address on a file link until RD-2d serves files (`EVIDENCE_FILES_SERVED`); a file with no links view reads "withheld"; the failed end-to-end run keeps its own row and no scenario is called failed from one aggregate result; states that never read better than the facts (Faked, Partial, Findings accepted, disagreeing facts read Couldn't verify); no commit with several repositories; own-key lookups by id; ONE code-details gate (`mayReadCodeDetails`) hiding test names, causes, finding files and text, scan items and links; bounded parallel retention checks; `cache-control: no-store`; a join that cannot be made answers a fixed sentence. All mutants in tests/unit/rd2b1-checks-read.test.ts. M1 to M20 (above) were re-run on the restructured code: all killed again.

| Mutant / location | Mutation | Failing test |
|---|---|---|
| M21 checks.ts `plainText` | control and format characters kept | "plainText removes NUL, ESC ..." and "test names, causes, labels ... carry none of them" |
| M22 routes `planOf` | the latest draft read when none is approved | "the claims come from the plan version the owner approved ... no claim, no mapping" |
| M23 checks.ts `linkOf` | an address served while files are not | link tests (route and join) |
| M24 routes `statesOf` | the digest not compared | "the kept pack ... another digest is withheld" |
| M25 checks.ts `linksOfRow` | no links view reads silent | link test (withheld) |
| M26 checks.ts `rowsOf` | a failed aggregate run's row dropped | "a failed aggregate run keeps its own row" |
| M27 checks.ts `rowsOf` | every scenario called failed | same test |
| M28 checks.ts `passedResult` | a Rovara-made fake read as Passed | "a result answered by a Rovara-made fake is Faked" |
| M29 checks.ts `reviewStateOf` | a partial review read as Passed | "a review that saw part of the diff reads Partial" |
| M30 checks.ts `reviewStateOf` | all-accepted findings read as Findings | same test |
| M31 checks.ts `passedResult` | a pass with a failed kept check read as Passed | "rowStateOf: ... disagree" and the Faked test |
| M32 checks.ts `verifiedOf` | the first commit of several named | "with more than one repository no commit is named" |
| M33 routes `packIsUnreadable` | an unreadable pack read as none kept | "an approved plan with no structured form says so; a pack ... cannot be read" |
| M34 routes `planOf` | a Markdown plan silent | same test |
| M35 checks.ts `ownList` | id looked up on the prototype (`toString`, `constructor`) | "a check or scenario id that is a word of the language" and the state tests |
| M36 routes `mayReadCodeDetails` | the gate says no | route tests (links, details) |
| M37 routes `STAT_AT_ONCE` | every file checked at once | "the files are checked against the store a few at a time" |
| M38 routes `answer` | no `cache-control: no-store` | "an approved plan with no structured form ... never cached" |
| M39 routes catch | a join failure rethrown | "a join that cannot be made answers one fixed sentence" |
| M40 checks.ts reviews | finding file and text shown without the gate | "a reader who may not read code ..." |
| M41 checks.ts `scanOf` | scan items shown without the gate | same test |
| M42 checks.ts `linksOfRow` | links shown without the gate | same test and the link test |
| M43 checks.ts `rowOf` | failing test names shown without the gate | same test |
| M44 checks.ts words | the not-approved sentence empty | "no approved plan, an approved plan with no structured form ..." and the route test |

All 44 killed; the restored tree passes. Evidence applies to the round-2 commit (parent 1d7edd14f); the final-head gate and review belong to 9d.

## RD-2b1 on the read rule (rebased onto 49080fbea, 2026-11-25)

The checks handler reads `context.decision.task` and `decision.codeDetails` (the mount asked `decideTaskRead`); the local `mayReadCodeDetails` and `loadReadableTask` are gone. The old mutants "handler without the read rule" and "code details always true" are now covered by the rule's own table (tests/unit/task-read-rule.test.ts: 18 x 14 on the real routes, the checks cells; the golden) and by the laptop test in tests/unit/rd2b1-checks-read.test.ts (no live grant proved: links withheld). Two new mutants for the TO-DOs, each applied alone, both killed:

| Mutant | Mutation | Killed by |
|---|---|---|
| N1 | the notices are also put into `notTested` (the old behaviour) | rd2b1-checks-read "the security scan, what was not tested, and the review-only words" (the review-only sentence must be a note and `notTested` empty) |
| N2 | the after-pull-request wording is never chosen (`pullRequests` ignored) | task-words "says only that the checks follow once the pull request is open (a fix round)" |

## RD-2d - the evidence file route (GET /v1/app/tasks/{taskId}/evidence/{sha}), on RD-2.0 head a65c40ce7

Production guards this lane adds: the task read's own rule as the first call, the separate code-details decision, pack membership (`evidenceViewOf` + `servableEvidenceArtifact`, served kinds text and JPEG only), the retention check, the bytes re-check (`readEvidenceArtifact`: size, SHA-256, kind), the fixed headers and types, the audit line before the bytes, the base64 flag, and (`core-host/dev-routes.ts`) the `owns()` clause and the script-token refusal. All in `core-host/task-evidence-file-routes.ts` unless noted; every mutant run against `tests/unit/rd2d-evidence-file-route.test.ts` alone.

| Mutant | Mutation | Failing tests |
|---|---|---|
| M1 access rule | `loadReadableTask` replaced by a raw `readTask` | other company / colleague / admin answer, another task's file, two companies |
| M2 code-details decision | the `mayReadCodeDetails` line removed | "the code-details decision is its own" |
| M3 pack membership | any sha taken as an available link | non-reader answers, unlisted sha, no kept pack (4 tests) |
| M4 retention | the "gone from the store" branch removed | "stays two objects", "past its retention" |
| M5 text type | `text/html` for command output | headers test, HTML-looking output test |
| M6 nosniff | header removed | headers, screenshot, HTML tests |
| M7 audit | the audit write removed | audit line, non-reader audit list, retention test |
| M8 audit failure | swallowed (file served) | "an audit that cannot be written serves no file" |
| M9 kind allow-list | `api_sample_json` added | "another task's file, an object the pack does not name ... a kind this route does not serve" |
| M10 base64 | `isBase64Encoded` dropped | screenshot decodes to the stored bytes |
| M11 dev-routes `owns()` | the new clause removed | 12 tests (no answer) |
| M12 dev-routes script token | path not refused for a script token | "a script token never reaches a file" |
| M13 method | any method owned | "owns GET on exactly this path" |
| M14 no-store | header removed | headers, screenshot |
| M15 content policy | header removed | headers, HTML-looking output |
| M16 store fault | a failing `stat` reads as "expired" | "a store that cannot answer says so" |
| M17 kind re-check (`read.kind !== link.kind`) | removed | SURVIVED: equivalent (`readEvidenceArtifact` derives its kind from the same link); the dead comparison was deleted instead |
| M18 company bound | store bound to another company | 11 tests |
| M19 audit details | digest left out of the line | audit line test |
| M20 disposition | `inline` without the fixed name | headers, screenshot, HTML tests |

19 killed, 1 equivalent (removed as dead code). Restored tree: `tests/unit/rd2d-evidence-file-route.test.ts` 17 tests pass.

## RD-2d on the read rule (rebased onto RD-2b1 on 49080fbea, 2026-11-25)

The file route asks the one read rule, read "evidenceFile" (ADMITTED_BY like the checks, a share is withheld: TASK_PART_NOT_SHOWN), asked once by the mount in dev-routes.ts and handed to `readTaskEvidenceFile` as `decision`; its code-details rule is `decision.codeDetails`. The earlier mutants "task read's own rule dropped" and "mayReadCodeDetails always true" are replaced by these (each applied alone), all killed:

| Mutant | Mutation | Killed by |
|---|---|---|
| E1 | `decision.codeDetails` not asked | rd2d "the code-details decision is its own" (a laptop: the missing-task answer and nothing of the store touched) |
| E2 | the mount asks read "task" instead of "evidenceFile" (a share would read the file) | task-read-rule "the evidence file route asks it" (a share is told 403, the checks are not shown) |
| E3 | `EVIDENCE_FILES_SERVED` false | rd2d "the links the checks read serves lead here" |

Also in tests/unit/task-read-rule.test.ts: for every kind of person, in both configurations, the "evidenceFile" decision equals the "checks" decision (the table is the one place that says who may read what).

## RD-2 reads stack - S2, S3, the share decision (DEC 254zzz558, option A) and the stored share's comment (base: the stack on code/next 5c44e8fca)

Production guards these commits add: the spec's path gate (`specOf(..., { paths })`), the changes read's own "diff" check before the cache (`mayReadDiff`), the share cells (`SHARED_PARTS`, `CHANNEL_SHARE_PARTS`, `ADMITTED_BY`, the `channel` way in), and the stored share's comment access (`commentAccessOf`, `sharedCommenterAccess`).

| Mutant | Mutation | Killed by (first failing tests) |
|---|---|---|
| S2-1 paths served without sourceCode | `const served = plan` (the plan is served whole whatever `paths` says) | tests/unit/rd2a-spec-read.test.ts: "a reader whose decision carries source code is served the cited places; a reader without it ...", "the spec of a share-admitted reader can never carry the places ..." |
| S3-1 diff guard removed | `if (!(await mayReadDiff())) return undefined;` taken out of `pageReader` (a cache hit skips the diff read's own rule) | tests/unit/rd2b2-changes-read.test.ts: "the diff read's own rule is asked before the cache (S3 ...)" |
| SH-1 channel cell reverted | `CHANNEL_SHARE_PARTS.plan` set to "withheld" | tests/unit/task-read-rule.test.ts: the "channel share member" row (function and real routes, both configs), "THE SLACK SHARE ...", "each Slack share cell is its own" |
| SH-2 stored cell reverted | `SHARED_PARTS.viewer.spec` set to "withheld" | tests/contract/rd-2-0-read-rule-golden.test.ts "matches the recorded answers"; tests/unit/task-read-rule.test.ts: the "shared reader" and "admin and shared" rows (function and real routes) |
| CM-1 stored share cannot comment | `commentAccessOf` never asks `sharedWith` (the People rule's refusal always stands) | tests/contract/core-plan-comments.test.ts: "a person the task is shared with (the stored share ...) comments ..."; tests/contract/core-task-rule-routes.test.ts: "the authenticated core POST creates a criterion thread ..." |
