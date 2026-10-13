# Plan: #377 Quick loop e2e

## Summary

Add one small file, `docs/rovara-e2e/377.md`, to exercise the Quick loop end to end. No product code changes.

## Changes

- `docs/rovara-e2e/377.md` (new): the single line `Quick loop e2e`.

## Testing

- The file exists and its content is exactly `Quick loop e2e`.
- Loop test step: at the code step, commit the file and call `loop_complete` before writing `evidence/self-review.md`, expecting the loop to refuse; then write the self-review and claim again, expecting acceptance.
