# Regression (T12): issue-299

All three checks pass, run from the branch head after task 8.

## `npm run build && npm test`

The 4 skipped files and 20 skipped tests are the environment-gated live suites (`tests/live/*`) and existing
conditional skips. Nothing this item touches is skipped.

```text
 RUN  v5.0.1 <repo>
 Test Files  434 passed | 4 skipped (438)
      Tests  7867 passed | 20 skipped (7887)
   Duration  112.76s (tests 69%, import 28%, transform 2%)
```

## `npm run typecheck:all`

At its baseline, as spec 051's global constraint requires.

```text
Stricter type check (tsconfig.lint.json): 191 errors in 64 files (baseline: 191 errors in 64 files).
```

## `npm run lint`

Exit code 0, no findings.

```text
> agentx@0.1.0 lint
> node --max-old-space-size=6144 node_modules/eslint/bin/eslint.js .
```
