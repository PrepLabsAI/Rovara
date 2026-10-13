# Plan: #387

## Summary

Two one-line end-to-end test changes, one per repository, to exercise the per-PR loop.

## Changes

- `docs/rovara-e2e/387.md` (PrepLabsAI/Rovara): new file with the line `per-PR loop, Rovara side`.
- `calculator.py` (ps06756/agentx-phase3-e2e): add a docstring to `add()` saying it returns the sum of `a` and `b`.

## Testing

- Rovara: the file exists with exactly that line.
- agentx-phase3-e2e: `python -c "import calculator; print(calculator.add.__doc__)"` prints the docstring, and `add()` still returns the same results.

## Repositories

- PrepLabsAI/Rovara: add docs/rovara-e2e/387.md
- ps06756/agentx-phase3-e2e: add a docstring to add() in calculator.py
- ps06756/Codeforces-Solutions: none (test entry; the loop should refuse it)
