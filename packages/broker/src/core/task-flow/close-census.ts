// The census of everything that can close a task or delete what a task's workspace holds. The contract test `tests/contract/close-census.test.ts` scans the non-test source for these calls and compares the hits with this
// table: a NEW closer or deleter fails CI until it is classified here, with a mode and what it does. Counts are the code lines that hold the call (comment lines are not counted; a definition counts like a call).
//
// Modes: `person` (a person's close: refused with the guard's words), `system` (a sweep or an end hook: closes on proof, or is SKIPPED and said so, never deletes unproven work), `exempt-by-type` (decided inside
// the guard from the task record, with proof), `not-a-closer` (the call destroys no task workspace), `definition` (the function itself), `out-of-scope` (deletes work today; a separate fix).
export type CloserMode = "person" | "system" | "exempt-by-type" | "not-a-closer" | "definition" | "out-of-scope";

export interface CloserEntry {
  /** Path from the repository root. */
  file: string;
  /** The call text that is counted. */
  call: string;
  count: number;
  mode: CloserMode;
  /** What it does, in a line. */
  note: string;
}

export const CLOSER_CENSUS_CALLS = ["closeLoadedTask(", "closeParts(", "finishClose(", "machines.terminate(", ".deleteSession(", "machines.stop(", "closeTask(", "dependencies.terminate("] as const;
/** Not scanned: this table (it names the calls), tests, build output, vendored code and the test-support package. */
export const CLOSER_CENSUS_SKIP = ["packages/broker/src/core/task-flow/close-census.ts"] as const;

const core = (file: string) => `packages/broker/src/core/${file}`;
export const CLOSER_CENSUS: readonly CloserEntry[] = [
  // The close itself.
  { file: core("task-flow/close.ts"), call: "closeLoadedTask(", count: 4, mode: "definition", note: "the unbound close: two overload signatures, the implementation, and closeTask's call (a person's close, guarded)" },
  { file: core("task-flow/close.ts"), call: "closeParts(", count: 2, mode: "definition", note: "builds what a close writes (the definition, and the close's own call with the guard's proof)" },
  { file: core("task-flow/close.ts"), call: "finishClose(", count: 2, mode: "definition", note: "after a committed close: the machines and allowances go back (the definition, and the close's own call)" },
  { file: core("task-flow/close.ts"), call: "machines.terminate(", count: 1, mode: "definition", note: "stopMachines: the only terminate after a close commits; reached only through the guard (legacy) or destroyRetained (bound)" },
  { file: core("task-flow/close.ts"), call: "closeTask(", count: 1, mode: "definition", note: "closeTask: a digest-bearing body is the bound close, anything else is closeLoadedTask" },
  { file: core("task-flow/flow.ts"), call: "closeTask(", count: 1, mode: "person", note: "flow.close: the parity POST /v1/dev/tasks/<id>/close and the session close both come through here" },
  { file: core("sessions/control.ts"), call: "closeTask(", count: 1, mode: "person", note: "app-session close: host.closeTask, the same function, so the guard lives below the route" },
  { file: "packages/broker/src/local/app/host.ts", call: "closeTask(", count: 2, mode: "person", note: "laptop app close: unguarded on the laptop in this train (no laptop retention provider); a P2 lane gates it, and its Close dialog carries the loss warning meanwhile" },
  { file: "packages/mcp/src/tools.ts", call: "closeTask(", count: 1, mode: "person", note: "the MCP/CLI close, always unbound: on a guarded install it gets the guard's exact sentence in the tool result; there is no bound path yet" },
  { file: "packages/mcp/src/client.ts", call: "closeTask(", count: 1, mode: "person", note: "the MCP client's close declaration" },
  // Closers that call the close.
  { file: core("build-step/scope-question.ts"), call: "closeLoadedTask(", count: 1, mode: "person", note: "the owner's Stop on a scope question: gated; a refusal is written on the session timeline and returned in the answer" },
  { file: core("setup-agent/end.ts"), call: "closeLoadedTask(", count: 1, mode: "exempt-by-type", note: "a setup run ended: closes by type once its end is recorded, else is skipped and logged" },
  { file: core("wiki-build/end.ts"), call: "closeLoadedTask(", count: 1, mode: "exempt-by-type", note: "a wiki build run ended: closes by type once its end word is written, else is skipped and logged" },
  { file: core("design-review/wait.ts"), call: "closeParts(", count: 1, mode: "system", note: "the 30-day close of an abandoned parked review: on proof, or through the bound path on a clean retained preview, else skipped and rescheduled" },
  { file: core("design-review/wait.ts"), call: "finishClose(", count: 1, mode: "system", note: "the finish of that close, only after its guarded commit" },
  // Direct terminates and deletes.
  { file: core("setup-agent/check.ts"), call: "machines.terminate(", count: 1, mode: "exempt-by-type", note: "a setup CHECK's scratch workspace (no task): closes and terminates, the guard is not involved" },
  { file: core("task-flow/dispatch.ts"), call: "machines.terminate(", count: 2, mode: "not-a-closer", note: "a machine this call just started for a refused admission, and one a late dispatch started for an already closed workspace: new and empty" },
  { file: core("test-env/saved-env-sweep.ts"), call: "machines.terminate(", count: 1, mode: "not-a-closer", note: "a saved-environment BUILD workspace of a build job (no task)" },
  // Stops (on a hosted install the broker-only adapter's stop is `requestStop`: the reaper ends the instance and the volume is KEPT).
  { file: core("task-flow/cancel-active.ts"), call: "machines.stop(", count: 1, mode: "not-a-closer", note: "a person's Stop: the broker-only adapter asks the reaper to end the instance (requestStop) and keeps the volume; a retained session is never claimed" },
  { file: core("task-flow/run-watch.ts"), call: "machines.stop(", count: 1, mode: "not-a-closer", note: "the spend stop: the same instance-only stop" },
  { file: core("pr-feedback/quiesce.ts"), call: "machines.stop(", count: 2, mode: "not-a-closer", note: "PR-feedback quiesce: the same instance-only stop" },
  // The adapters and the reaper.
  { file: "packages/broker/src/aws/worker-machines/session-worker-machines.ts", call: ".deleteSession(", count: 1, mode: "definition", note: "terminate = deleteSession: instance AND volume; reached through the rows above" },
  { file: "packages/broker/src/aws/worker-machines/broker-core.ts", call: ".deleteSession(", count: 1, mode: "definition", note: "the broker-only wrapper of the same delete" },
  { file: "packages/broker/src/aws/broker.ts", call: ".deleteSession(", count: 1, mode: "not-a-closer", note: "the retired workflow engine's own close (spec 056/008, its own preflight): not a core task" },
  { file: "packages/broker/src/aws/session-reaper.ts", call: "dependencies.terminate(", count: 1, mode: "not-a-closer", note: "the idle reaper ends the INSTANCE; the volume stays" },
  { file: "packages/broker/src/aws/session-reconciler.ts", call: "dependencies.terminate(", count: 5, mode: "not-a-closer", note: "the reconciler repairs drift; it ends instances, and deletes a volume only when it ties to a CLOSED workspace after its window" },
];
