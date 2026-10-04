# Red → green: issue-299

Each section shows the new tests run against the code before the task (red), then after it (green). `@agentx/contracts` resolves to its built `dist`, so the red runs build the old source first (`git show HEAD:<file>`, then `npx tsc -b packages/contracts`).

## Tasks 1–4: lexer, scanTestCommands, isPipedTestCommand

Command: `npx vitest run tests/contract/agent-checks.test.ts tests/integration/agent-shell-pipefail.test.ts`

### Red (contracts built from `5ae36536`)

113 failures: every `scanTestCommands` case (the export did not exist), the four new pipefail rows, and the new pipefail scenario. Pipefail failures, verbatim:

```text
     × runs "cd /testbed; python -m pytest a/test_x.py -q 2>&1 | tail -20" with pipefail 3ms
     × runs "cd a;pytest|tail -n 5" with pipefail 0ms
     × reports the failing test's exit code for cd <dir>; <test> | tail, as for cd <dir> && (#299) 18ms
     × adds pipefail only to a piped test command, and the AgentX git identity to every command 1ms
⎯⎯⎯⎯⎯⎯ Failed Tests 113 ⎯⎯⎯⎯⎯⎯
      Tests  113 failed | 161 passed (274)
```

### Green

```text
 Test Files  2 passed (2)
      Tests  274 passed (274)
```
