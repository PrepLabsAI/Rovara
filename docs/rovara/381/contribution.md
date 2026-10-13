# Contribution: #381

## Goal
Add docs/rovara-e2e/381.md that explains, in one sentence, what the base file's number means.

## Success criteria
- [x] docs/rovara-e2e/381.md exists and says 3 is the number of retries after the first try. — Evidence: `git ls-files docs/rovara-e2e/381.md` lists the file (committed in the change commit); `grep -n "3" docs/rovara-e2e/381.md` shows line 3: "The 3 in `retries = 3` in `docs/rovara-e2e/base.md` is the number of retries after the first try, so the work is attempted at most four times in all." It is one sentence, with one terminal period (the other `.` is in the file name `base.md`).

## Approach
The base file is `docs/rovara-e2e/base.md` from PR #382 (now closed, not merged). It holds the line `retries = 3`. The review of that PR noted the file doesn't say whether 3 counts retries or total attempts. This contribution settles it.

**How I'll meet the criterion.** I'll add `docs/rovara-e2e/381.md` with one sentence saying that the `3` in `retries = 3` in `docs/rovara-e2e/base.md` is the number of retries after the first try, so there are at most four attempts in total. `docs/` is gitignored, so I'll add the file with `git add -f`. I won't change any other file, and that includes `base.md`, which isn't on this branch.

**How I'll prove it.**
- `git ls-files docs/rovara-e2e/381.md` lists the file, so it is tracked and committed.
- `grep -n "3" docs/rovara-e2e/381.md` shows the sentence, and it says retries *after the first try*.
- A word count and a read-through confirm the explanation is one sentence.
