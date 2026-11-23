// A task flow on the W0 fakes, set up as a deployed install sees a task: a task with a workspace, optionally a recorded machine and the session item the session manager keeps. "Fake port, not machine proof":
// nothing here starts a real machine or reads a real volume; the session item is a record the test writes.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { change, workspaceSessionKey, type StoredDocument } from "@agentx/contracts";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import type { CloseCheckPort } from "../../packages/broker/src/core/task-flow/close-guard.js";
import { createHarness, type Harness, type HarnessOptions } from "./task-flow-harness.js";

export type SessionSpec = "absent" | { state: string; generation?: number; extra?: Record<string, unknown> };
export interface GuardWorldOptions extends HarnessOptions {
  /** Default true. */
  guard?: boolean;
  /** `backed`: a machine recorded (generation 1). `forgotten`: the machine removed, its count kept. `none`: never a machine. */
  machine?: "none" | "backed" | "forgotten";
  /** Default `absent` for `none`, READY for the others. */
  session?: SessionSpec;
  check?: CloseCheckPort;
  /** Default true for a machine-backed task: no operation holds the workspace (a step that finished). */
  idle?: boolean;
}

export const sessionItem = (workspaceId: string, spec: Exclude<SessionSpec, "absent">): StoredDocument => ({
  ...workspaceSessionKey(workspaceId), entityType: "WORKSPACE_SESSION", workspaceId, state: spec.state, generation: spec.generation ?? 1,
  ...(spec.state === "READY" ? { readyAt: "2026-11-09T09:00:00.000Z", lastActivityAt: "2026-11-09T09:30:00.000Z", workerFeatures: ["task.workflowMode"] } : {}),
  ...spec.extra,
});

export async function guardWorld(options: GuardWorldOptions = {}) {
  const h = createHarness(options);
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "close me" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId);
  const machine = options.machine ?? "none";
  const machineId = `machine-${task.workspaceId}`;
  if (options.guard !== false) h.deps.closeGuard = { enforce: true };
  if (options.check !== undefined) h.deps.closeCheck = options.check;
  if (machine !== "none") {
    await h.store.update({ key: wk, ops: [...(options.idle === false ? [] : [change.set("activeOperationId", null), change.set("status", "READY")]), change.set("machineGeneration", 1), ...(machine === "backed" ? [change.set("machine", { machineId, machineKey: task.workspaceId })] : [])] });
  }
  const session: SessionSpec = options.session ?? (machine === "none" ? "absent" : { state: "READY" });
  if (session !== "absent") await h.store.put({ item: sessionItem(task.workspaceId, session) });
  const terminate = vi.spyOn(h.machines, "terminate");
  const stop = vi.spyOn(h.machines, "stop");
  const start = vi.spyOn(h.machines, "start");
  const logs: Array<Record<string, unknown>> = [];
  h.deps.log = (entry) => { logs.push(entry); };
  const rows = async (): Promise<StoredDocument[]> => (await (h.store as MemoryDocumentStore).scanPage({ limit: 1000 })).items;
  const close = (input?: unknown) => h.flow.close(h.owner, task.taskId, input);
  const workspace = () => readWorkspace(h.deps, task.workspaceId);
  /** Runs `mutate` once, right before the first transaction after this call: a write that lands between the guard's read and the close's commit. */
  const raceOnce = (mutate: () => Promise<void>): void => {
    const original = h.store.transact.bind(h.store);
    let fired = false;
    h.store.transact = async (items) => { if (!fired) { fired = true; await mutate(); } return original(items); };
  };
  const writes = () => [vi.spyOn(h.store, "put"), vi.spyOn(h.store, "update"), vi.spyOn(h.store, "delete"), vi.spyOn(h.store, "transact")];
  return { h, task, wk, machineId, terminate, stop, start, logs, rows, close, workspace, raceOnce, writes };
}
export type GuardWorld = Awaited<ReturnType<typeof guardWorld>>;

/** The words of a refusal, as a route answers them (the code prefix taken off). */
export function refusalWords(error: unknown): string {
  const e = error as { code?: string; message?: string; statusCode?: number };
  if (e.code !== "WORKSPACE_BUSY" || e.statusCode !== 409 || typeof e.message !== "string") throw new Error(`not a WORKSPACE_BUSY refusal: ${String(e.message)}`);
  return e.message.slice(e.code.length + 2);
}
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return refusalWords(error); }
  throw new Error("the close was not refused");
}

export type { Harness };
