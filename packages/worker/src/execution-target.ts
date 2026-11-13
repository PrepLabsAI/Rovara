// Where commands run (setup-test-health 10.3, task SH35): ONE seam, `ExecutionTarget = sandbox | runner:<id>`. The setup agent's shell, Prove, the project's checks and the nightly run start a command
// only through `executionFor`, and never reach for a sandbox (or, later, a customer-hosted runner) themselves.
//
// Today there is one target: `sandbox`. It is the task sandbox (task-sandbox.ts) exactly as it was: `bashOperations()` and `runCommand()` are the sandbox's own methods, called with the arguments they were
// given and returning what the sandbox returned, so the commands, arguments, environment, timeouts and outputs are unchanged. The seam adds a decision point and nothing else.
//
// `runner:<id>` is the team build runner (R3, contracts/src/runner.ts). It is NOT built: `executionFor` refuses it with "no runner configured". Nothing can select it: no setting, route or payload field
// carries a target, every call site names `SANDBOX_TARGET` in code, and `parseExecutionTarget` has no caller outside tests. A later task that adds a runner adds the selector, the lease client and
// the third arm of the switch below, in one reviewed change.
//
// The seam is GUARDED, not only used: tests/unit/worker-execution-target.test.ts resolves every use of `TaskSandbox.runCommand` and `TaskSandbox.bashOperations` through the type checker and fails on any outside this
// file and task-sandbox.ts (optional chains, destructuring, aliases and string keys included). Two consumers are not wired through it yet and MUST be when they are: Prove's production ports (the setup executor builds
// `ProvePorts.runCommand`, use `proveCommandPort(executionFor(...))`) and the person-command runner (setup-command-runner.ts takes a `BashOperations`; hand it the seam's, as setup-agent-run.ts does). The runner never runs the agent: the agent, its model calls and its edits stay central (the contract forbids those fields).
import { RunnerIdSchema, agentXError, type ProjectCommand } from "@rovara-code/contracts";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { CommandResult } from "./readiness.js";
import type { TaskSandbox } from "./task-sandbox.js";

export type ExecutionTarget = { readonly kind: "sandbox" } | { readonly kind: "runner"; readonly id: string };

/** The only target any call site names today. */
export const SANDBOX_TARGET: ExecutionTarget = Object.freeze({ kind: "sandbox" });

export const NO_RUNNER_CONFIGURED = "no runner configured";

/** `sandbox` or `runner:<id>`; anything else throws. Not read from any setting, route or payload today (see the top of the file). */
export function parseExecutionTarget(text: string): ExecutionTarget {
  if (text === "sandbox") return SANDBOX_TARGET;
  if (text.startsWith("runner:")) {
    const id = RunnerIdSchema.safeParse(text.slice("runner:".length));
    if (id.success) return Object.freeze({ kind: "runner", id: id.data });
  }
  throw new RangeError("an execution target is `sandbox` or `runner:<id>`");
}

export function formatExecutionTarget(target: ExecutionTarget): string {
  return target.kind === "sandbox" ? "sandbox" : `runner:${target.id}`;
}

/** The two ways commands start today: the agent's shell (a command line, as pi's bash tool gives it) and a project command (an executable and its arguments). */
export interface TargetCommands {
  bashOperations(): BashOperations;
  runCommand(command: ProjectCommand, signal?: AbortSignal): Promise<CommandResult>;
}

/** What a target needs to be reached. Only the sandbox exists today. */
export interface ExecutionBindings {
  sandbox?: TaskSandbox | undefined;
}

/**
 * The commands of a target. `sandbox` returns the task sandbox's own methods, unchanged; it needs the sandbox the caller started. `runner:<id>` is refused: there is no runner, and a runner is never reached
 * by falling back from anything else.
 */
export function executionFor(target: ExecutionTarget, bindings: ExecutionBindings): TargetCommands {
  switch (target.kind) {
    case "sandbox": {
      const sandbox = bindings.sandbox;
      if (sandbox === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "AgentX has no task sandbox to run this command in");
      return {
        bashOperations: () => sandbox.bashOperations(),
        runCommand: (...args) => sandbox.runCommand(...args),
      };
    }
    case "runner":
      throw agentXError("RUNTIME_UNAVAILABLE", NO_RUNNER_CONFIGURED);
  }
}

/** What Prove's `runCommand` port returns for a command that ran on a target (the same fields the checks keep). */
export function proveCommandPort(commands: TargetCommands): (command: ProjectCommand, signal: AbortSignal) => Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }> {
  return async (command, signal) => {
    const result = await commands.runCommand(command, signal);
    return { exitCode: result.exitCode, timedOut: result.timedOut === true, stdout: result.stdout, stderr: result.stderr };
  };
}
