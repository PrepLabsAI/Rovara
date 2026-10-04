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

## Task 5: per-cd path mapping

Command: `npx vitest run tests/unit/devcontainer-cd-target.test.ts`

### Red (`workspaceRelativeCdTarget` and `testbedRelativeCdTarget` not yet defined)

```text
⎯⎯⎯⎯⎯⎯ Failed Tests 19 ⎯⎯⎯⎯⎯⎯⎯
      Tests  19 failed (19)
```

### Green

```text
      Tests  19 passed (19)
```

## Task 6: CommandRecorder on the scan

Command: `npx vitest run tests/unit/worker-command-recorder.test.ts`

### Red

```text
     × records each test in a chain, without the chain's exit code, which is not the test's 3ms
     × records a test piped into another filter, or chained with || true, without its exit code 0ms
     × keeps the run's exit code for cd <dir>; <test>, the same command as cd <dir> && <test> 0ms
     × marks a chained test run after a bash command that changed the workspace as after an edit (Ruling E) 1ms
     × maps every cd target and keeps the agent's own text as the command 0ms
     × voids the before of a test run batched with a chained test that also changes files, either order (#299, abuse case 7) 0ms
     × keeps the before valid in a batch of tests whose chains hold only tests, cd and filters 0ms
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 7 ⎯⎯⎯⎯⎯⎯⎯
      Tests  7 failed | 25 passed (32)
```

### Green (with task 5's file)

Command: `npx vitest run tests/unit/worker-command-recorder.test.ts tests/unit/devcontainer-cd-target.test.ts`

```text
      Tests  51 passed (51)
```
