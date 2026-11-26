# Mutant evidence, one file per lane

From 2026-11-25, each lane writes its mutant evidence to its own file in this folder: `mutants/<LANE-NAME>.md` (for example `mutants/SIGNATURE-COMPARE-CANONICAL.md`). It uses the same table as before: file and function, the mutant, and the result (killed, survived as equivalent with a reason, or survived).

Why one file per lane: when every lane appended to the shared `MUTANTS.md`, nearly every pull request conflicted there as soon as another one merged, and each re-merge cost a fresh CI run. New files with distinct names never conflict, and the evidence still lands with its pull request.

`MUTANTS.md` at the repository root is kept as the index and the history up to 2026-11-25. Do not append new lanes to it.
