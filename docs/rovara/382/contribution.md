# Contribution to #382

## Goal

Make the base file say what its number means.

## Success criteria

- [ ] docs/rovara-e2e/base.md says that 3 is the number of retries after the first try.
- [ ] The file still has its first line unchanged.

## Approach

- **Number explained.** Add one line to `docs/rovara-e2e/base.md`, after `retries = 3`, saying that 3 is the number of retries after the first try. Proof: `grep` the file for that line.
- **First line unchanged.** Touch only the lines after line 1. Proof: `head -1` of the file matches `Base file for the rovara loop e2e test.`, and `git diff` shows no change to line 1.
