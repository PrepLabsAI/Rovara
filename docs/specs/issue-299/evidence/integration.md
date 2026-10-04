# Integration tests (T2): issue-299

Faux model and local bash only. No Docker, AWS or model provider. Both rows pass: 42 of 42.

## Scenarios

`the-loop scenarios --root . --glob tests/integration/agent-shell-pipefail.test.ts --glob tests/integration/worker-verification.test.ts --format markdown`

| # | Feature | Scenario | Requirement | Location |
|---|---|---|---|---|
| 1 | AgentX checks the agent's test commands (spec 051, #299) | the agent shell runs cd <dir>; <test> \| tail with pipefail | docs/specs/issue-299/requirements.md#requirement-1-cd-dir-test-reads-as-cd-dir--test (1.3) | tests/integration/agent-shell-pipefail.test.ts:34 |
| 2 | AgentX checks the agent's test commands (spec 051, #299) | a test run inside a chain is rerun, with its before measured on the original code | docs/specs/issue-299/requirements.md#requirement-2-tests-inside-chains (2.1, 2.3; 5.2) | tests/integration/worker-verification.test.ts:745 |

## `npx vitest run tests/integration/agent-shell-pipefail.test.ts tests/integration/worker-verification.test.ts --reporter=verbose`

```text
 RUN  v5.0.1 <repo>
 Test Files  2 passed (2)
      Tests  42 passed (42)
   Duration  2.98s (tests 65%, import 26%, transform 8%)
```

```text
✓ tests/integration/agent-shell-pipefail.test.ts > the agent's shell and a test command piped into tail > reports the failing test's exit code, not tail's 19ms
✓ tests/integration/agent-shell-pipefail.test.ts > the agent's shell and a test command piped into tail > reports the failing test's exit code for cd <dir>; <test> | tail, as for cd <dir> && (#299) 20ms
✓ tests/integration/agent-shell-pipefail.test.ts > the agent's shell and a test command piped into tail > leaves any other pipe to the shell's default, where tail's status is the pipeline's 5ms
✓ tests/integration/agent-shell-pipefail.test.ts > the agent's shell and a test command piped into tail > adds pipefail only to a piped test command, and the AgentX git identity to every command 0ms
✓ tests/integration/worker-verification.test.ts > AgentX measures the before result on the original code (spec 051 D-16, #290) > reruns a test the agent ran inside a chain, with its before measured on the original code (#299) 7ms
```
