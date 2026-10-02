# Agent Verification Implementation Plan (spec 051)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guide the coding agent to prove its work, have AgentX rerun the checks itself when the agent tries to finish (with one extra try on a regression), and report AgentX's result, not the agent's claim, in the task result, the PR, Slack and eval `result.json`.

**Architecture:**
- **Pure core in contracts:** the preamble text, its version and hash, the check-report schema, the test-command matcher, the regression classifier and the claim parser. All are pure and unit-tested.
- **Worker:** one inline Pi extension, added in `createWorkerResources` so it reaches coding tasks and eval runs alike. It records the agent's bash commands with their exit codes and order relative to edits. On `agent_before_settle` it reruns the checks, then gives one extra turn or records the final report.
- **Downstream:** the report travels in the task result. The broker keeps the latest report per workspace, publish turns a remaining regression into a draft PR with a deterministic checks section, the Slack service prefixes the reply deterministically, and the eval runner writes the report and the claim/disagreement fields into `result.json`.

**Tech Stack:** TypeScript, zod, vitest, Pi 1.0.0 (`@earendil-works/pi-coding-agent` extension API: `agent_before_settle`, `tool_result`), the faux model (`tests/support/faux-model.ts`).

**Spec:** `specs/051-agent-verification/spec.md`

## Prerequisite

Build on mainline **after #252 (Pi 1.0.0) merges**. Create the build branch `feat/051-agent-verification` from that mainline. The spec says "Pi 0.99"; the hook exists from Pi 0.87.0, and 1.0.0 is what ships.

## Rulings made while planning (each recorded in the spec's Decisions by Task 1)

The codebase differs from the spec's assumptions in five places. These rulings settle each one; the user reviews them with this plan.

- **P-1, the "before" for project checks.** Readiness runs once, at workspace preparation, and a workspace becomes READY only if every check passes. The before result for project checks is therefore always "passed at preparation". The task payload does not carry the readiness commands today, so the broker adds `readiness` (optional, `ProjectCommand[]`) to the task invocation payload, and the worker reruns those commands.
- **P-2, draft PR on a remaining regression.** AgentX never publishes automatically: the orchestrator's create-PR tool or the developer API asks for it. Today publish **refuses** when a readiness check fails (`packages/worker/src/publish.ts:110-115`). Spec D-2 wants a draft PR rather than no PR. So:
  - publish no longer refuses on a failing readiness check: it opens the PR as a **draft**, and the failing checks are listed in a deterministic checks section;
  - publish also reads the workspace's latest task check report, for agent-command checks;
  - CodeBuild gates are unchanged.

  **This relaxes an existing gate and needs the user's approval.**
- **P-3, time limits.** Production coding tasks have no task time limit, only the 200-tool-call guard. Each check therefore keeps its own timeout (the command's `timeoutSeconds`, or 10 minutes for agent commands), and one verification round has a total budget of 30 minutes. Checks the budget leaves unrun are recorded as `not_run`. Eval runs count verification against their agent timer, using the time remaining.
- **P-4, stopped runs.** Pi does not fire `agent_before_settle` after an abort: a cancel, the loop guard, or an eval time or cost limit. Such a task's report is `not_verified` with reason `stopped`, and no checks run.
- **P-5, the agent's claim.** "Claimed success" needs a deterministic reading. The preamble asks the agent to end its final message with exactly one line, `AgentX result: done` or `AgentX result: not done`. The claim is `success`, `failure`, or `none` when the line is missing.
- **P-6, which agent commands are replayed.** Only a simple test command is replayed:
  - an optional leading `cd <path> &&`;
  - then `NAME=value` assignments, an optional `timeout <n>`;
  - then a listed test command (spec FR-003) with its arguments.

  Anything with `|`, `;`, `||`, `&`, redirection, backticks or `$(` is not a check. It is never replayed, because replaying an arbitrary command can change the workspace.

## Global Constraints

- The preamble is the same for coding tasks and eval runs (FR-001, FR-010), and its version and SHA-256 appear in every report.
- At most one extra try, and never a third round (FR-006, D-3).
- Check output is stored trimmed and redacted, as readiness output is today (`redactedTail`, `MAX_COMMAND_OUTPUT_BYTES`).
- No paid runs during development (D-5). All tests use the faux/scripted model.
- `typecheck:all` must stay at its baseline: run it before Task 1 and record the number. Lint must be clean.
- Pi behaviour that spec 050 pinned changes on purpose in two places, and those characterization pins may be edited with a one-line reason each:
  - the system prompt gains an `<addendum>` section;
  - the worker now loads one inline extension.

  No other pin changes.
- Node 22 (the scratchpad PATH). Run `npm run build` before tests.

## Review Focus

1. **A cancel or stop during a check run.** Cancellation and the eval limits must stop a long check promptly, rather than waiting up to 10 minutes. Test: start a check whose command sleeps; cancelling ends it within 10 s, and the report is `not_verified`/`stopped`.
2. **Agent commands written in many ways.** For example `cd pkg && npm test -- -t foo`, `FOO=1 python -m pytest -k x`, `pytest | tail -5` and `npm test; echo done`. Each one is either replayed exactly or excluded, never mangled. The matcher has a table test.
3. **A model error on the last turn** (`outcome: "error"`). There is no extra try and no rerun; the report is `not_verified`/`error`.
4. **The extra turn's own summary.** After the extra try, the "agent's account" is the extra turn's final message, and the claim is parsed from it. Test it through `lastAssistantResponse`.
5. **Old workers and old brokers during rollout.**
   - A broker that sends no `readiness` field: the worker falls back to agent commands.
   - A worker that sends no `checks` field: publish and Slack behave exactly as today.

   Test both.

---
### Task 1: The pure core (contracts)

**Files:**
- Create: `packages/contracts/src/checks.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./checks.js";`)
- Modify: `specs/051-agent-verification/spec.md` (Status: "Building on Pi 1.0.0"; add Decisions D-6 to D-11 from rulings P-1 to P-6, worded as in this plan)
- Test: `tests/contract/agent-checks.test.ts`

**Interfaces:**
- Produces:
  - Preamble: `AGENTX_PREAMBLE_VERSION: string`, `AGENTX_PREAMBLE: string`, `agentxPreambleSha256(): string`.
  - Schemas and types: `CheckOutcomeSchema`, `CheckClassSchema`, `CheckEntrySchema`, `CheckReportSchema`, and the types `CheckOutcome`, `CheckClass`, `CheckEntry`, `CheckReport`.
  - Functions:
    - `matchTestCommand(command: string): string | undefined`
    - `classifyCheck(before: CheckOutcome, after: CheckOutcome): CheckClass`
    - `parseAgentClaim(text: string | undefined): "success" | "failure" | "none"`
    - `reportStatus(checks: CheckEntry[]): "verified" | "regression"`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/contract/agent-checks.test.ts
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE, AGENTX_PREAMBLE_VERSION, agentxPreambleSha256, CheckReportSchema,
  classifyCheck, matchTestCommand, parseAgentClaim, reportStatus,
} from "@agentx/contracts";

describe("the AgentX preamble (spec 051 FR-001)", () => {
  it("is versioned and hashed", () => {
    expect(AGENTX_PREAMBLE_VERSION).toBe("1");
    expect(agentxPreambleSha256()).toBe(createHash("sha256").update(AGENTX_PREAMBLE).digest("hex"));
  });
  it("tells the agent each rule, and the final line (P-5)", () => {
    for (const phrase of ["Reproduce the problem", "before and after", "your own regression", "never claim", "AgentX result: done", "AgentX result: not done"]) {
      expect(AGENTX_PREAMBLE).toContain(phrase);
    }
  });
});

describe("matchTestCommand (FR-003, P-6)", () => {
  it.each([
    ["npm test", "npm test"],
    ["npm run test -- -t foo", "npm run test -- -t foo"],
    ["pnpm test", "pnpm test"], ["yarn test", "yarn test"],
    ["pytest tests/test_a.py -k x", "pytest tests/test_a.py -k x"],
    ["python -m pytest -q", "python -m pytest -q"],
    ["go test ./...", "go test ./..."], ["cargo test", "cargo test"], ["make test", "make test"],
    ["mvn test", "mvn test"], ["gradle test", "gradle test"], ["./gradlew test", "./gradlew test"],
    ["bundle exec rspec spec/a_spec.rb", "bundle exec rspec spec/a_spec.rb"],
    ["phpunit", "phpunit"], ["tox -e py311", "tox -e py311"],
    ["cd pkg && npm test", "cd pkg && npm test"],
    ["FOO=1 BAR=2 pytest -k x", "FOO=1 BAR=2 pytest -k x"],
    ["timeout 600 pytest", "timeout 600 pytest"],
    ["  pytest  ", "pytest"],
  ])("replays %j", (command, replay) => {
    expect(matchTestCommand(command)).toBe(replay);
  });
  it.each([
    "pytest | tail -5", "npm test; echo done", "npm test || true", "npm test > out.txt", "npm test &",
    "echo $(pytest)", "`pytest`", "git stash && pytest", "npm install", "npm run build", "python setup.py test",
    "cd a && cd b && pytest", "pytest-xdist", "", "   ",
  ])("does not treat %j as a check", (command) => {
    expect(matchTestCommand(command)).toBeUndefined();
  });
});

describe("classifyCheck (FR-004)", () => {
  it.each([
    ["passed", "passed", "passing"],
    ["passed", "failed", "regression"],
    ["passed", "timed_out", "regression"],
    ["failed", "failed", "already_failing"],
    ["failed", "passed", "fixed"],
    ["unknown", "failed", "failing_no_before"],
    ["unknown", "passed", "passing"],
    ["passed", "not_run", "not_rerun"],
  ] as const)("before %s, after %s → %s", (before, after, expected) => {
    expect(classifyCheck(before, after)).toBe(expected);
  });
});

describe("parseAgentClaim (P-5)", () => {
  it("reads the final line", () => {
    expect(parseAgentClaim("Fixed it.\nAgentX result: done")).toBe("success");
    expect(parseAgentClaim("Could not.\nAgentX result: not done\n")).toBe("failure");
    expect(parseAgentClaim("All tests pass")).toBe("none");
    expect(parseAgentClaim(undefined)).toBe("none");
    expect(parseAgentClaim("AgentX result: done\nmore text after")).toBe("none");
  });
});

describe("the check report", () => {
  it("is a regression when any entry is", () => {
    const entry = { id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "failed", class: "regression", output: "1 failed", durationMs: 10 } as const;
    expect(reportStatus([entry])).toBe("regression");
    expect(reportStatus([{ ...entry, after: "passed", class: "passing" }])).toBe("verified");
    expect(CheckReportSchema.parse({
      status: "regression", source: "project", preambleVersion: "1", preambleSha256: "a".repeat(64),
      checks: [entry], extraTry: "given", agentClaim: "success",
    }).checks).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm run build && npx vitest run tests/contract/agent-checks.test.ts`
Expected: FAIL, because the exports are not found.

- [ ] **Step 3: Implement `packages/contracts/src/checks.ts`**

```typescript
// Spec 051: the coding agent proves its work, and AgentX checks it. The pure parts, shared by the
// worker (which runs checks), the broker (which keeps the report and shapes the PR) and Slack.
import { createHash } from "node:crypto";
import { z } from "zod";

export const AGENTX_PREAMBLE_VERSION = "1";

/** Appended to Pi's system prompt for every coding task and eval run (FR-001). Changing it means a new version. */
export const AGENTX_PREAMBLE = [
  "AgentX checks your work after you finish. Work this way:",
  "1. Reproduce the problem before changing code, and say how you reproduced it.",
  "2. Run the relevant tests before and after your change.",
  "3. A test that passed before your change and fails after it is your own regression. Fix it; never call it unrelated.",
  "4. Report the commands you ran and their results.",
  "5. Never claim a test passed unless you saw it pass.",
  "End your final message with exactly one line: \"AgentX result: done\" if the work is complete and every test you ran passes, otherwise \"AgentX result: not done\".",
].join("\n");

export function agentxPreambleSha256(): string {
  return createHash("sha256").update(AGENTX_PREAMBLE).digest("hex");
}

export const CheckOutcomeSchema = z.enum(["passed", "failed", "timed_out", "unknown", "not_run"]);
export type CheckOutcome = z.infer<typeof CheckOutcomeSchema>;

export const CheckClassSchema = z.enum(["passing", "regression", "already_failing", "fixed", "failing_no_before", "not_rerun"]);
export type CheckClass = z.infer<typeof CheckClassSchema>;

export const CheckEntrySchema = z.object({
  /** `readiness:<index>` for a project check, `agent:<n>` for the agent's own command. */
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(8_192),
  source: z.enum(["project", "agent_commands"]),
  before: CheckOutcomeSchema,
  after: CheckOutcomeSchema,
  class: CheckClassSchema,
  /** Trimmed, redacted tail of the after run. */
  output: z.string().max(65_536),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type CheckEntry = z.infer<typeof CheckEntrySchema>;

export const CheckReportSchema = z.object({
  status: z.enum(["verified", "regression", "not_verified"]),
  notVerifiedReason: z.enum(["no_checks", "stopped", "error"]).optional(),
  source: z.enum(["project", "agent_commands", "none"]),
  preambleVersion: z.string().min(1).max(16),
  preambleSha256: z.string().regex(/^[0-9a-f]{64}$/),
  checks: z.array(CheckEntrySchema).max(64),
  /** `given` when the first rerun found a regression and the agent had its one extra turn (FR-006). */
  extraTry: z.enum(["not_needed", "given"]),
  agentClaim: z.enum(["success", "failure", "none"]),
}).strict();
export type CheckReport = z.infer<typeof CheckReportSchema>;

const TEST_HEADS: readonly (readonly string[])[] = [
  ["npm", "test"], ["npm", "run", "test"], ["pnpm", "test"], ["yarn", "test"], ["pytest"],
  ["python", "-m", "pytest"], ["go", "test"], ["cargo", "test"], ["make", "test"], ["mvn", "test"],
  ["gradle", "test"], ["./gradlew", "test"], ["bundle", "exec", "rspec"], ["phpunit"], ["tox"],
];
const UNSAFE = /[|;&<>`]|\$\(/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=\S*$/;

/** The command to replay if `command` is a simple test command (P-6), else undefined. */
export function matchTestCommand(command: string): string | undefined {
  const trimmed = command.trim();
  const cd = /^cd\s+(\S+)\s+&&\s+(.+)$/.exec(trimmed);
  const rest = cd === null ? trimmed : cd[2]!;
  if (rest.length === 0 || UNSAFE.test(rest) || (cd !== null && UNSAFE.test(cd[1]!))) return undefined;
  const words = rest.split(/\s+/);
  let index = 0;
  while (index < words.length && ASSIGNMENT.test(words[index]!)) index += 1;
  if (words[index] === "timeout" && /^\d+[smh]?$/.test(words[index + 1] ?? "")) index += 2;
  const tail = words.slice(index);
  const matches = TEST_HEADS.some((head) => head.every((word, position) => tail[position] === word));
  return matches ? (cd === null ? rest : `cd ${cd[1]} && ${rest}`) : undefined;
}

export function classifyCheck(before: CheckOutcome, after: CheckOutcome): CheckClass {
  if (after === "not_run" || after === "unknown") return "not_rerun";
  const afterPassed = after === "passed";
  if (before === "passed") return afterPassed ? "passing" : "regression";
  if (before === "failed" || before === "timed_out") return afterPassed ? "fixed" : "already_failing";
  return afterPassed ? "passing" : "failing_no_before";
}

export function parseAgentClaim(text: string | undefined): "success" | "failure" | "none" {
  const last = (text ?? "").trimEnd().split("\n").at(-1)?.trim();
  if (last === "AgentX result: done") return "success";
  if (last === "AgentX result: not done") return "failure";
  return "none";
}

export function reportStatus(checks: readonly CheckEntry[]): "verified" | "regression" {
  return checks.some((check) => check.class === "regression") ? "regression" : "verified";
}
```

- [ ] **Step 4: Run the tests and see them pass**

Run: `npm run build && npx vitest run tests/contract/agent-checks.test.ts`
Expected: PASS. If one case in the matcher table fails, fix the matcher, not the table: the table is the spec.

- [ ] **Step 5: Update the spec.** Set the Status, and add Decisions D-6 to D-11 for rulings P-1 to P-6.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/checks.ts packages/contracts/src/index.ts tests/contract/agent-checks.test.ts specs/051-agent-verification/spec.md
git commit -m "feat(contracts): the AgentX preamble, check report, test-command matcher and regression rule (spec 051)"
```

### Task 2: The preamble in every session, and the command recorder (worker)

**Files:**
- Modify: `packages/worker/src/pi-session.ts`
  - In `createWorkerResources`, add `appendSystemPrompt: [AGENTX_PREAMBLE]`.
  - Accept `extensionFactories` from a new optional `PiSessionInput.verification`.
  - In `createDefaultSession`, call `session.bindExtensions({ onError })` and log extension errors as diagnostics, as `packages/orchestrator/src/orchestrator.ts:270-284` does.
- Create: `packages/worker/src/verification/recorder.ts`
- Test: `tests/unit/worker-command-recorder.test.ts`, plus the characterization pins in `tests/integration/pi-worker-characterization.test.ts`

**Interfaces:**
- Consumes: `AGENTX_PREAMBLE` and `matchTestCommand` (Task 1).
- Produces:
  ```typescript
  export interface RecordedCommand { order: number; command: string; replay: string; exitCode: number | undefined; afterFirstEdit: boolean; output: string }
  export class CommandRecorder {
    /** Feed every Pi extension `tool_result` event, in order. */
    observe(event: { toolName: string; input: Record<string, unknown>; structuredContent?: unknown; isError: boolean; content: { type: string; text?: string }[] }): void;
    /** The first run of each distinct replay string, in first-run order. */
    firstRuns(): RecordedCommand[];
    /** True once an edit or write tool result succeeded. */
    get edited(): boolean;
  }
  ```

- [ ] **Step 1: Write the failing recorder tests.**
  1. A bash `tool_result` with `input.command` set to `"pytest -k x"` and `structuredContent.exit_code` 1 is recorded as `{replay:"pytest -k x", exitCode:1, afterFirstEdit:false}`.
  2. A successful `edit` result, then `pytest -k x` again: `firstRuns()` still returns the first run only.
  3. `npm test` run only after an edit is recorded with `afterFirstEdit:true`.
  4. `pytest | tail` and `npm install` are never recorded.
  5. A failed edit (`isError:true`) does not count as an edit.
  6. The exit code is missing when `structuredContent` is absent and the text carries no `Command exited with code N`. A zero exit with no marker is read as 0.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement `CommandRecorder`.**
  - Edits are `toolName` `edit` or `write` with `isError === false`.
  - The exit code is read from `structuredContent.exit_code` when present. Otherwise use `/Command exited with code (\d+)/` on the text; with no marker and `isError === false`, it is 0.
  - `output` is the text, kept as is; trimming happens in Task 3.
- [ ] **Step 4: Inject the preamble.**
  - Add `appendSystemPrompt: [AGENTX_PREAMBLE]` to the `DefaultResourceLoader` options.
  - Update the characterization pin of system-prompt sections (`pi-worker-characterization.test.ts:~237-244`). It now expects an `<addendum>` section between `<docs>` and `<project_context>`, plus an added assertion that the prompt contains `AGENTX_PREAMBLE` verbatim. One-line reason: "spec 051 FR-001 appends the AgentX preamble".
  - Update the "loads no extensions" pin (`:~403-404`) to "loads exactly one inline extension, AgentX verification, when verification is set". Reason: "spec 051".
  - Add a test that the eval path's session (`createWorkspacePiSession` through the default adapter) carries the same preamble.
- [ ] **Step 5: Run the tests and see them pass.** Run the recorder test, the worker characterization, the Pi gate files and `worker-pi-trust`.
- [ ] **Step 6: Commit:** `feat(worker): the AgentX preamble in every Pi session, and a recorder of the agent's test commands (spec 051)`.

### Task 3: Running checks (worker)

**Files:**
- Create: `packages/worker/src/verification/checks.ts`
- Modify: `packages/contracts/src/protocol.ts`. The task payload gains `readiness: z.array(ProjectCommandSchema).max(32).optional()`. It is optional, so an old broker still validates (Review Focus 5).
- Modify: the broker's task payload builder (`packages/broker/src/aws/broker.ts:~2513-2528`). It adds the project's current readiness commands, using the same merge `publicationProject` uses (`:~4201-4213`).
- Test: `tests/unit/worker-checks.test.ts`, and the broker payload in `tests/contract/` beside the existing task-invocation tests.

**Interfaces:**
- Consumes: `CommandRecorder.firstRuns()` (Task 2), `classifyCheck` and `CheckEntry` (Task 1), the readiness `ProjectCommand[]`, the manifest's `readinessResults`, the redaction helper `redactedTail`, and `MAX_COMMAND_OUTPUT_BYTES` (`packages/worker/src/command-failure.ts`).
- Produces:
  ```typescript
  export interface CheckRunners {
    /** A readiness command, as preparation ran it (devcontainer or host). */
    runProjectCommand(command: ProjectCommand, signal: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }>;
    /** A replayed agent command, through the agent's own bash operations and cwd. */
    runAgentCommand(replay: string, timeoutMs: number, signal: AbortSignal): Promise<{ exitCode: number | null; timedOut: boolean; output: string }>;
  }
  export interface CheckPlan { source: "project" | "agent_commands" | "none"; readiness?: ProjectCommand[]; agentRuns?: RecordedCommand[] }
  export function planChecks(readiness: ProjectCommand[] | undefined, recorder: CommandRecorder): CheckPlan;
  export async function runChecks(plan: CheckPlan, runners: CheckRunners, options: { budgetMs: number; signal: AbortSignal; now?: () => number }): Promise<CheckEntry[]>;
  ```
- Rules:
  - **Project checks** (`readiness` present and non-empty): before is `passed` (P-1); `id` is `readiness:<index>`; the timeout is each command's `timeoutSeconds`.
  - **Agent commands** otherwise:
    - before is `passed` or `failed` by the first run's exit code, or `unknown` when that run came after the first edit (FR-003);
    - `id` is `agent:<n>`; the timeout is 10 minutes.
  - **No agent commands:** the source is `none`, with no entries.
  - **Budget:** the total budget is 30 minutes in production, and the eval time remaining for evals (P-3). A check the budget can't start is `after: "not_run"`.
  - **Abort:** the signal kills the running check (Review Focus 1). The rest are `not_run`.
  - **Output:** each output goes through `redactedTail`, then is cut to 64 KiB.

- [ ] **Step 1: Write the failing tests**, using fake `CheckRunners`.
  1. Project source, with one check failing: the entry is `regression`, and the output is trimmed and redacted. Use a fake secret in the output that `redactCredentials` masks.
  2. Agent source, with the first run before an edit failing and the rerun passing: the entry is `fixed`.
  3. Agent source, with the first run after an edit and the rerun failing: the entry is `failing_no_before`.
  4. No readiness and no commands: the source is `none`.
  5. A 30-minute budget against two 20-minute checks, using a fake `now`: the second is `not_run`.
  6. An abort during the first check: it rejects within 100 ms, and the remaining checks are `not_run`.
  7. Broker: the task payload carries the project's readiness commands, and a payload without `readiness` still parses.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement `planChecks` and `runChecks`.** In run-task (wired in Task 4), build the real runners:
  - `runProjectCommand` uses the same runner preparation uses: `runDevcontainerCommand` with a devcontainer target, else `runProjectCommand` (`packages/worker/src/prepare.ts:~118-121, :~347-375`). Export them if they are module-private.
  - `runAgentCommand` executes `replay` through the session's `BashOperations` (devcontainer) or a host `bash -c` in the workspace root, with the AgentX git identity environment, as the agent's own shell does (`agentShellTool`, `pi-session.ts`).
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit:** `feat(worker): rerun the project's checks or the agent's test commands, within a budget (spec 051)`.

### Task 4: One extra try, and the report in the task result (worker)

**Files:**
- Create: `packages/worker/src/verification/extension.ts`
- Modify: `packages/worker/src/pi-session.ts`. `PiSessionInput.verification?: VerificationOptions` adds `verificationExtension(...)` to `extensionFactories`.
- Modify: `packages/worker/src/run-task.ts`, so that:
  - it builds the `VerificationOptions` from the payload's `readiness`, the manifest and the runners (Task 3);
  - it passes the options to both session constructors;
  - after `prompt()`, it reads the report.
  - The report goes in:
    - the `result` event payload, as `checks`;
    - `TaskInvocationResult`, as `checks`;
    - a new artifact, `checks.json`.
- Modify: `packages/contracts/src/developer-tasks.ts` (or wherever the task result is read), so that readers accept an optional `checks: CheckReport`.
- Test: `tests/integration/worker-verification.test.ts`. It runs a real Pi session on the faux model through `createDefaultPiSessionAdapter`, so the real extension and hook run, with fake `CheckRunners`.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  ```typescript
  export interface VerificationOptions {
    plan: () => CheckPlan;            // read at settle time, after the agent's commands are recorded
    runners: CheckRunners;
    budgetMs: () => number;           // production: 30 min; eval: time remaining
    signal: AbortSignal;              // fires on cancel, loop-guard stop or eval limit
    recorder: CommandRecorder;
    onReport: (report: CheckReport) => void;
  }
  export function verificationExtension(options: VerificationOptions): ExtensionFactory;
  ```
- Behaviour, which follows from Pi's own semantics (`agent-session.js` `_runBeforeSettleBoundary`):
  - **Recording:** `pi.on("tool_result", e => recorder.observe(e))`.
  - **On `agent_before_settle`:**
    - If `outcome !== "completed"`, it reports `not_verified`/`error` and returns `{}` (Review Focus 3).
    - On the first settle, it runs the checks.
      - If a regression exists, it returns `{ entries: [...event.entries, { type: "custom_message", customType: "agentx_checks", content: <failing checks: label, before → after, trimmed output>, display: false }], continue: true }` and marks `extraTry = "given"`.
      - Otherwise it reports, and returns `{}`.
    - On the second settle, which follows the extra turn, it runs the checks again, reports the final result and returns `{}`. A third settle is impossible, because the handler never continues twice (FR-006).
  - **Abort:** if the signal fired before the hook, no checks run, and run-task reports `not_verified`/`stopped`. Pi skips the hook on abort (P-4), so run-task builds that report itself when `onReport` never fired.
  - **The agent's claim** is `parseAgentClaim(lastAssistantText)` on the final assistant message. After an extra try, that is the extra turn's message (Review Focus 4).

- [ ] **Step 1: Write the failing integration tests** (SC-001). Use the faux model with scripted turns.
  1. **Pass:** the agent runs `pytest`, edits, and the fake rerun passes. The report is `verified`, `extraTry:"not_needed"`, with exactly one model request after the edit.
  2. **Regression fixed:** the first rerun fails, the extra turn edits again, and the second rerun passes. The report is `verified`, `extraTry:"given"`. The model received a user-role message containing the failing check's output. There were exactly two settle rounds.
  3. **Regression remains:** both reruns fail. The report is `regression`, `extraTry:"given"`. No third model request happened.
  4. **Claim:** the final text ends with `AgentX result: done` while a regression remains. The report has `agentClaim:"success"` and `status:"regression"`.
  5. **Model error on the last turn:** `not_verified`/`error`, and no checks ran.
  6. **Cancel during a check:** the check stops within 10 s, and the report is `not_verified`/`stopped` (Review Focus 1).
  7. **No checks:** `not_verified`/`no_checks`, source `none`.
  8. **Old broker:** no `readiness` in the payload, so the agent-command source is used (Review Focus 5).
  9. **Hash:** the `result` event and `checks.json` carry the report, with `preambleSha256 === agentxPreambleSha256()`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the extension and the run-task wiring.**
  - Wire the signal to the cancellation controller and to the loop-guard stop.
  - Keep `withoutStructuredContent` for events. The extension reads `structuredContent` through `tool_result`, which Pi gives extensions before the handle strips it.
- [ ] **Step 4: Run them and see them pass.** Also run the worker characterization and gate suites: no other pin may change.
- [ ] **Step 5: Commit:** `feat(worker): AgentX reruns the checks when the agent finishes, with one extra try on a regression (spec 051)`.

### Task 5: The PR (broker and publish)

**Files:**
- Modify: the broker's operation-completion path (`packages/broker/src/aws/broker.ts:~3904-3955`). When a task operation succeeds with `result.checks`, it stores the report on the workspace record as `latestChecks` (report, operationId, completedAt). The write is conditional, so an older operation never overwrites a newer one.
- Modify: `packages/worker/src/publish.ts:~110-115`. A failing readiness check no longer throws (P-2). Publish returns the checks, as it already computes them, with the PR result.
- Modify: the broker's publish path (`:~2623, :~2675, :~3410-3417`, `attributedBody` at `:~2242-2260`).
  - The PR is a **draft** when either holds:
    - a publish-time readiness check failed;
    - the workspace's `latestChecks` has `status: "regression"`.
  - It then appends a deterministic `## Checks` section to the body, built by a new pure `checksSection(publishChecks, latestChecks): string`:
    - one line per check: label, before → after, class;
    - for each failing check, a fenced tail of its output, at most 40 lines;
    - an "already failing" check is noted but does not make the PR a draft (FR-008).
  - With no report and all checks passing, the PR body is exactly as it is today (Review Focus 5).
- Test: `tests/contract/` broker publish tests, and `tests/unit/checks-section.test.ts` (exact text).

- [ ] **Step 1: Write the failing tests.**
  1. `checksSection` produces exact markdown for passing, regression, already-failing and mixed checks.
  2. Publish with a failing readiness check: the PR is created as a draft, and its body contains the section. Today this throws; the test asserts the new behaviour, with a reason line naming P-2.
  3. Publish after a task whose report is `regression`: the PR is a draft.
  4. Publish after a `verified` report: a normal PR, with the section.
  5. No report and passing checks: the body equals today's body byte for byte.
  6. An already-failing check alone: a normal PR, with the note.
  7. Two task completions arrive out of order: `latestChecks` keeps the newer one.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Keep the developer API's `draft` default (true) unchanged. The Slack tool's PR becomes a draft only under the rule above.
- [ ] **Step 4: Run them and see them pass,** together with the existing publish and readiness tests. Any existing test that asserts the refusal is changed, with a one-line reason (P-2).
- [ ] **Step 5: Commit:** `feat(publish): a remaining regression opens a draft PR with a checks section (spec 051)`.

### Task 6: The Slack reply (orchestrator and Slack service)

**Files:**
- Modify: `packages/orchestrator/src/control-plane-api.ts:~262-273`. `completedTaskResult` returns `checks` when the operation result has them.
- Modify: `packages/orchestrator/src/turn-recorder.ts`. Each worker operation recorded in the turn keeps its `checks` report.
- Modify: `packages/slack-service/src/processor.ts:~697-734` and `packages/slack-service/src/interrupted-turn.ts:~108-115`. The reply text is `checksReplyPrefix(reports) + labelled(modelText)` whenever the turn carries at least one report. Without a report, it is exactly today's text (Review Focus 5).
- Create: `packages/contracts/src/checks-reply.ts`, a pure function `checksReplyPrefix(reports: CheckReport[]): string`. Export it from the index.
- Test: `tests/unit/checks-reply.test.ts` (exact text), and the processor tests in `tests/integration/` that already cover the final reply.

**Exact wording (FR-009).** For each report, in order:
- **regression:** `Not done: <label> passed before and fails now.` One sentence per regression, then `The draft PR lists the failures.` only when a PR exists. The processor knows this from the turn's publish operation.
- **verified:**
  - project source: `Checks passed (<n> project checks).`
  - agent-commands source: `Checks passed (<n> of the agent's own test commands, rerun by AgentX).`
- **`not_verified`/`no_checks`:** `Not verified: no checks ran. Add readiness checks to the project so AgentX can check the agent's work.`
- **`not_verified`/`stopped` or `error`:** `Not verified: the task stopped before AgentX could check it.`
- **An already-failing check:** add `Already failing before this change: <label>.`
- **After the prefix:** a blank line, then `*Agent's account:*`, then the model's reply.

- [ ] **Step 1: Write the failing tests.**
  1. `checksReplyPrefix` gives the exact text for each class above, and for two reports in one turn.
  2. A turn whose task ended with a regression: the reply starts with `Not done:`, and `*Agent's account:*` precedes the model's text.
  3. A turn with no worker task: the reply is unchanged.
  4. A resumed turn (`resumedResultText`) gets the same prefix.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.** Keep Slack's message splitting unchanged: the prefix goes in before `splitSlackMessage`.
- [ ] **Step 4: Run them and see them pass,** along with the existing Slack processor suites.
- [ ] **Step 5: Commit:** `feat(slack): AgentX's check result leads the reply, and the agent's account follows (spec 051)`.

### Task 7: Evals (runner, contracts, batch measures)

Depends on spec 052 (#253) being merged.

**Files:**
- Modify: `packages/worker/src/swebench/agent.ts`.
  - It passes `VerificationOptions` to `createWorkspacePiSession`, where:
    - the plan is agent commands only, since evals have no readiness;
    - `runAgentCommand` goes through the container's bash operations;
    - `budgetMs` is the agent time remaining (P-3);
    - the signal is the eval-limit abort.
  - It captures the last assistant text from the existing subscriber (`:~71-84`) into `AgentRun.finalText`.
- Modify: `packages/worker/src/swebench/run.ts:~153-212`. `result.json` and the result callback gain:
  - `checks` (CheckReport);
  - `agentClaim`;
  - `disagreement: { claimedSuccess, checkRegression, graderBrokenPassToPass, disagrees }`, where:
    - `graderBrokenPassToPass` = PASS_TO_PASS passed < total, for the `swebench` and `pro` families; null for `secbench`;
    - `disagrees` = `claimedSuccess && (checkRegression || graderBrokenPassToPass === true)` (FR-011).
  - The checks must finish before `removeContainer` (`:~127`). The hook runs inside `prompt()`, so this holds; a test pins it.
- Modify: `packages/contracts/src/swebench.ts`. The result gains the optional fields above. They are optional so that old runners keep working.
- Modify: `packages/broker/src/aws/eval-batch.ts` (`measureOf`) and the batch CSV and summary.
  - The measure row gains `checkStatus`, `agentClaim` and `disagrees`, empty when absent.
  - `summary.json` gains a per-model `disagreementRate` = disagrees / graded runs with a claim (spec 046 SC-003).
- Modify: `docs/swebench-eval.md`. Add a release-order line: the control plane first, then the runner image, because a strict older broker answers 400 to the new fields.
- Test: the `swebench-runner.test.ts` and `secbench.test.ts` patterns (`fakeAdapter`, `fakeDocker`, `recordingReporter`), plus the eval-batch measure and summary tests.

- [ ] **Step 1: Write the failing tests.**
  1. An eval run whose agent ran `pytest` before and after an edit: `result.json` has `checks`, `agentClaim`, `disagreement`, and `preambleSha256` beside `promptTemplateSha256`.
  2. The claim is success, but the grader's PASS_TO_PASS shows 9/10: `disagrees: true`.
  3. SEC-bench: `graderBrokenPassToPass: null`.
  4. The check rerun happens before the container is removed (order assertion on `fakeDocker`).
  5. A batch row and CSV carry the new columns. `summary.json` has `disagreementRate`. An old result without the fields leaves them empty.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit:** `feat(eval): the eval runner records AgentX's checks, the agent's claim and their disagreement (spec 051)`.

### Task 8: Verify, docs and PR

- [ ] Docs:
  - In the user docs on coding tasks (find them with `git ls-files docs`), add what the checks section, the draft PR and the Slack prefix mean.
  - Add the preamble's text and version.
  - Explain how to add readiness checks.
- [ ] Spec 051 status: "Implemented; awaiting release".
- [ ] Run `npm run build && npm run typecheck:all && npm run lint && npm test`. All must be green, typecheck at its baseline.
- [ ] Push `feat/051-agent-verification` and open a PR against `mainline`.
  - List rulings P-1 to P-6, with P-2 marked as relaxing the publish gate.
  - Give the release order: control plane via the pipeline, then the runner image.
  - Name the shakedown check (SC-002): `astropy__astropy-13398` in spec 046's shakedown.
