# SKILLS-TO-WORKERS mutants (step 2)

Each mutant is a small edit to `packages/broker/src/aws/worker-machines/dispatcher-lessons.ts`, its skills read (`dispatcher-skills.ts`) or the selector it calls (`packages/broker/src/lessons/skills.ts`), applied to a copy and run against `tests/contract/hosted-skills-reach-worker.test.ts` (one file, `--maxWorkers=1`), then restored. All six are KILLED (the file exits 1; the tests that failed are listed). Run 2026-11-25.

| # | Mutant | Result | Tests that failed |
|---|--------|--------|-------------------|
| 1 | Skills cross a project: the reader asks `readHostedLiveSkills({ ..., project: "billing" })` instead of the task's own project | KILLED | "a skill never crosses a project" (it gets the other project's skill), the proof test, the company, published, cap, no-lesson-set and read_skill tests (the task's own skill is missing) |
| 2 | Drafts delivered: `liveSkillsForStep` no longer checks the head's live version / retired flag nor the two approvals | KILLED | "only PUBLISHED versions" (draft in the set, one approval, retired, unapproved new version) |
| 3 | Cap removed: the 8-skill and 96 KB cut dropped | KILLED | "the caps" |
| 4 | A skills-only project gets none: the no-lesson-set return gives `{}` | KILLED | "a project with skills and NO lesson set still gets its skills" |
| 5 | Skills cross a company: the get-only view's company-prefix check removed (dispatcher-skills.ts) and the read aimed at company B | KILLED | "a skill never crosses a company" and the tests that expect the task's own skill |
| 6 | Every step kind gets skills: `wantsSkills` no longer limited to PLAN and IMPLEMENT | KILLED | "plan and build steps only" |
