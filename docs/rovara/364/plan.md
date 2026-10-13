# Plan for #364

## Summary

This is a smoke test of the Quick loop. It adds one file, `docs/rovara-quick-smoke.md`, which contains a single line. No other code changes.

## Changes

- `docs/rovara-quick-smoke.md` (new): one line, `Hello from the Quick loop.`

## Testing

- Read the new file back and confirm it holds exactly that one line.
- Use `git show --stat` to confirm the commit touches only that file. `docs/` is gitignored, so the file is added with `git add -f`.
