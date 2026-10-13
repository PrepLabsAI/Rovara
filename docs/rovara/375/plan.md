# Plan: list the Full loop's documents (#375)

## Summary

Add `docs/rovara-e2e/375.md` so a reader can see the Full loop's three documents, as the approved requirements ask.

## Changes

- `docs/rovara-e2e/375.md` (new, added with `git add -f`): the heading `# Full loop documents`, then one line each for requirements, design and plan.

## Testing

Check that the file exists with that heading and exactly three lines, one per document, and that `git diff --stat mainline` shows no other new or changed files outside `docs/rovara/375/`.
