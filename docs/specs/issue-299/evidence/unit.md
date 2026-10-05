# Unit tests (T1, T8 abuse case 7): issue-299

Both rows pass: 51 of 51.

## `npx vitest run tests/unit/worker-command-recorder.test.ts tests/unit/devcontainer-cd-target.test.ts --reporter=verbose`

```text
 RUN  v5.0.1 <repo>
 Test Files  2 passed (2)
      Tests  51 passed (51)
   Duration  842ms (import 72%, transform 27%, tests 1%)
```

```text
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > records a bash test command with its exit code, before any edit 1ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > keeps only the first run of each replay string 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > marks a command first run after an edit or write 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > records a test command piped into tail -N as its bare command, with the run's exit code (pipefail) 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > never records a refused pipe, a non-test command, or another tool's result 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > does not count a failed edit as an edit 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > reads the exit code from the last text marker without structuredContent, else 0 on success, else unknown 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > replaces a first run with an unknown exit code by a later known run made before any edit 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder > keeps the output as is, and replays a cd-prefixed command exactly 1ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: tests inside chains and filters (#299) > records each test in a chain, without the chain's exit code, which is not the test's 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: tests inside chains and filters (#299) > records a test piped into another filter, or chained with || true, without its exit code 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: tests inside chains and filters (#299) > keeps the run's exit code for cd <dir>; <test>, the same command as cd <dir> && <test> 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: tests inside chains and filters (#299) > lets a later simple run, made before any edit, supply the before a chained run could not 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: tests inside chains and filters (#299) > marks a chained test run after a bash command that changed the workspace as after an edit (Ruling E) 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: tests inside chains and filters (#299) > maps every cd target and keeps the agent's own text as the command 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: an edit made through bash (Ruling E) > marks a test run after a bash command that changed the workspace as after an edit 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: an edit made through bash (Ruling E) > keeps a test run's before valid after a bash command that changed nothing 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: an edit made through bash (Ruling E) > takes the baseline at the first tool call, before it runs, whatever the tool 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: an edit made through bash (Ruling E) > does not fingerprint once an edit tool has succeeded 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: an edit made through bash (Ruling E) > treats a run as after an edit when the fingerprint fails, and reports it 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: an edit made through bash (Ruling E) > treats a result whose tool_call it never saw as after an edit 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: a parallel batch (Ruling G) > voids the before of a test run batched with a bash command that is not a test, either order 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: a parallel batch (Ruling G) > voids the before of a test run batched with an edit or write that finishes after it 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: a parallel batch (Ruling G) > voids the before of a test run batched with a chained test that also changes files, either order (#299, abuse case 7) 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: a parallel batch (Ruling G) > keeps the before valid in a batch of tests whose chains hold only tests, cd and filters 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: a parallel batch (Ruling G) > keeps the before valid in a batch of test commands and reads 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: a parallel batch (Ruling G) > does not let a finished batch void a later call 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: fingerprint cost (M-9, M-11) > stops reading the fingerprint once it has differed 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: fingerprint cost (M-9, M-11) > reports a failing fingerprint once per session 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: fingerprint cost (M-9, M-11) > passes the tool call's abort signal to the fingerprint 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: a call that never gets a tool_result (M-12) > drops a blocked call from the calls in flight at its tool_execution_end 0ms
✓ tests/unit/worker-command-recorder.test.ts > CommandRecorder: a call that never gets a tool_result (M-12) > clears the calls in flight at turn_end 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > maps "/workspaces/repo" to "repo" 1ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > maps "/workspaces/repo/" to "repo/" 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > maps "/workspaces/repo/pkg/a" to "repo/pkg/a" 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > maps "/work/root/repo" to "repo" 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > maps "/work/root/repo/pkg" to "repo/pkg" 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > leaves "/workspaces/repoX" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > leaves "/workspaces" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > leaves "/etc" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > leaves "repo" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > leaves "pkg" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > leaves "/work/root" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > leaves "~" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > maps the folder to the root as an empty path when the repository is the root 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > workspaceRelativeCdTarget > maps nothing when the host folder is outside the root 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > testbedRelativeCdTarget > maps "/testbed" to "testbed" 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > testbedRelativeCdTarget > maps "/testbed/astropy/io" to "testbed/astropy/io" 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > testbedRelativeCdTarget > leaves "/testbedX" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > testbedRelativeCdTarget > leaves "/app" unmapped 0ms
✓ tests/unit/devcontainer-cd-target.test.ts > testbedRelativeCdTarget > leaves "testbed" unmapped 0ms
```
