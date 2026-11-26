# SKILLS-TO-WORKERS mutants (step 2)

Each mutant is a small edit to `packages/broker/src/aws/worker-machines/dispatcher-lessons.ts`, its skills read (`dispatcher-skills.ts`) or the selector it calls (`packages/broker/src/lessons/skills.ts`), applied to a copy and run against `tests/contract/hosted-skills-reach-worker.test.ts` (one file, `--maxWorkers=1`), then restored. All six are KILLED (the file exits 1; the tests that failed are listed). Run 2026-11-25.

| # | Mutant | Result | Tests that failed |
|---|--------|--------|-------------------|
| 1 | Skills cross a project: the reader asks `readHostedLiveSkills({ ..., project: "billing" })` instead of the task's own project | KILLED | "a skill never crosses a project" (it gets the other project's skill), the proof test, the company, published, cap, no-lesson-set and read_skill tests (the task's own skill is missing) |
| 2 | Drafts delivered: `liveSkillsForStep` no longer checks the head's live version / retired flag nor the two approvals | KILLED | "only PUBLISHED versions" (draft in the set, one approval, retired, unapproved new version) |
| 3 | Cap removed: the 8-skill and 96 KB cut dropped | KILLED | "the caps" |
| 4 | A skills-only project gets none: the no-lesson-set return gives `{}` instead of `finish({})` (re-run on the final code: also killed by the S2 skills-only test) | KILLED | "a project with skills and NO lesson set still gets its skills", "S2: a skills-only answer ..." |
| 5 | Skills cross a company: the get-only view's company-prefix check removed (dispatcher-skills.ts) and the read aimed at company B | KILLED | "a skill never crosses a company" and the tests that expect the task's own skill |
| 6 | Every step kind gets skills: `wantsSkills` no longer limited to PLAN and IMPLEMENT | KILLED | "plan and build steps only" |

## Round 2 (2026-11-25 night): DEC 254zzz577 option (a), pre-review S2 and S3

Same method: one edit at a time (script in the lane's scratchpad), `tests/contract/hosted-skills-reach-worker.test.ts` (28 tests, `--maxWorkers=1`), then `git checkout --` of the three source files. All KILLED.

| # | Mutant | Result | Tests that failed |
|---|--------|--------|-------------------|
| 7a | Skills gated by the install's CoreLessons switch again: `partsOfStep` gives skills only when `lessonsOn` | KILLED | "the install's CoreLessons switch off ... still get the skill", "with the switch off, a worker that lists only the lessons feature costs the store nothing" |
| 7b | Skills gated by the project's learning mode again: the not-allowed branch (Off, Collect, company lock Off) returns `{}` instead of `finish({})` | KILLED | "project learning mode Off", "... Collect", "lessons stay gated by the mode", "the company's lock on the mode (Off)" |
| 7c | The dispatcher's company runtime has a reader only while the lessons switch covers the company (`hostedDispatcherFlow`) | KILLED | the two CoreLessons-off tests above |
| 8 | The skills read uses the lessons' clock: awaited BEFORE the lessons start (sequential, inside the 2.5 s run clock) | KILLED | "S2: a skills read that runs out its whole clock leaves the lessons their own time" (lessons need about 2 s, skills take 0.7 s: refused) |
| 9 | Reads cap 129 -> 128 | KILLED | "S3 (reads) ... costs exactly 129 skills reads", "S3 (lessons counters)" |
| 10 | Byte cap removed | KILLED | "S3 (bytes) ... end the read" |
| 11 | Time budget 700 ms -> 60 s | KILLED | "S2: a skills read that runs out its whole clock", "S2: a skills-only answer", "S3 (time)" |
| 12 | Time budget 700 ms -> 100 ms (too tight) | KILLED | "S2: a skills-only answer", "S3 (time)" |
| 13 | A throwing skills store is no longer swallowed (the `() => undefined` and the `catch` removed) | KILLED | "S3 (fault)", "S3 (bytes)" |

## Round 3: the skills' result is independent of the lessons' result (coordinator, same night)

Same method; 34 tests in the contract file. All KILLED.

| # | Mutant | Result | Tests that failed |
|---|--------|--------|-------------------|
| 14 | Any failure of the lessons part refuses the whole answer again (the catch returns `refuse()`, skills dropped) | KILLED | the lessons' set read throws; learning settings unreadable; a stored mode that is not a mode; the 2.5 s clock; the lessons fail while the skills read is under way |
| 15 | The skills read is stopped by the lessons' `stopped`/`failed` flags again (`alive: () => !stopped && !failed`) | KILLED | "the lessons fail at once while the skills read is still under way", "learning settings are unreadable" |

## Round 4: the laptop and broker road (`lessons/host-glue.ts` `skillsFor`) follows the same rule

`tests/unit/knowledge/skills.test.ts` (50 tests, `--maxWorkers=1`, includes the hosted-vs-laptop parity test). All KILLED.

| # | Mutant | Result | Tests that failed |
|---|--------|--------|-------------------|
| 17 | `skillsFor` gated by the install's lessons switch again (`!enabled()` back) | KILLED | "PARITY with the hosted dispatcher's reader", "sends the live skills whatever the install's lessons switch and the project's learning mode say" |
| 18 | `skillsFor` gated by the project's learning mode again (`resolveLearning` + `modeAllows` back) | KILLED | the same two |
