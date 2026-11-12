// a message to a running step reaches the worker through the machines port, with a capability that opens nothing, only to a worker that is up and lists the feature; anything else is a note.
 
import { describe, expect, it } from "vitest";
import { LIVE_STEER_FEATURE, LIVE_STEER_REAPPROVAL_REASON, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, WorkerInvocationSchema, liveSteerOperationId } from "@agentx/contracts";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { LIVE_STEER_ATTEMPTS, livePersonLabel, sendLiveSteer, type LiveSteerDeps } from "../../packages/broker/src/core/sessions/live-steer.js";
import { isReapprovalStop, reapprovalMessageIds } from "../../packages/broker/src/core/sessions/live-steer-reapproval.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { clearLiveDeliveredSince } from "../../packages/broker/src/core/sessions/steer.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const WORKSPACE = "6f0d1c1e-1b9e-4c64-8f4a-0d7f6a9c3b11";
const OPERATION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const KEY = "k".repeat(40);
const msg = (n: number): string => `msg_${String(n).padStart(20, "0")}`;

async function world(options: { features?: readonly string[]; answers?: Array<Record<string, unknown>>; mode?: string; opStatus?: string; busy?: boolean; workspaceStatus?: string; operationMachine?: string; pointerTask?: string | null; programStep?: string } = {}) {
  const answers = [...(options.answers ?? [])];
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: options.features ?? [LIVE_STEER_FEATURE], answer: () => answers.shift() ?? { accepted: true, outcome: "steered" } });
  const handle = await machines.start({ machineKey: WORKSPACE, companyId: "org_x" });
  await machines.health(handle.machineId);
  if (options.busy !== false) await machines.deliver(handle.machineId, { kind: "task", operationId: OPERATION, workspaceId: WORKSPACE } as never);
  const store = new MemoryDocumentStore();
  await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, workspaceId: WORKSPACE } });
  await store.put({ item: { pk: `WORKSPACE#${WORKSPACE}`, sk: "META", id: WORKSPACE, status: options.workspaceStatus ?? "BUSY", activeOperationId: OPERATION, fence: 2, projectRevision: 1, machine: { machineId: handle.machineId, machineKey: WORKSPACE } } });
  await store.put({ item: { pk: `WORKSPACE#${WORKSPACE}`, sk: `OPERATION#${OPERATION}`, id: OPERATION, kind: "task", status: options.opStatus ?? "RUNNING", fence: 2, workflowMode: options.mode ?? "PLAN", machineId: options.operationMachine ?? handle.machineId, ...(options.programStep === undefined ? {} : { programStepId: options.programStep }) } });
  // The workspace's task pointer: which task the workspace is working for now.
  if (options.pointerTask !== null) await store.put({ item: { pk: `WORKSPACE#${WORKSPACE}`, sk: "DEVELOPER_TASK", taskId: options.pointerTask ?? TASK } });
  const sleeps: number[] = [];
  const deps: LiveSteerDeps = { store, machines, callbackSigningKey: KEY, sleep: async (ms) => { sleeps.push(ms); } };
  return { deps, machines, handle, sleeps, store };
}
const send = (deps: LiveSteerDeps, n = 1, text = "also log the request id", owner = true) => sendLiveSteer(deps, { taskId: TASK, messageId: msg(n), text, owner, developerId: "dev_owner" });

describe("a message to a running step", () => {
  it("is handed to the worker as one steer invocation for the message's own id, naming the person by a fixed label and with a capability that allows nothing", async () => {
    const w = await world();
    expect(await send(w.deps, 1, "also log the request id")).toBe("steered");
    expect(w.machines.answered).toHaveLength(1);
    const invocation = WorkerInvocationSchema.parse(w.machines.answered[0]);
    expect(invocation).toMatchObject({
      kind: "steer", operationId: liveSteerOperationId(msg(1)), workspaceId: WORKSPACE, fence: 2,
      payload: { targetOperationId: OPERATION, messageId: msg(1), step: "PLAN", authority: "owner_instruction", sender: livePersonLabel("dev_owner"), text: "also log the request id" },
    });
    // The capability is the callback model's own (HMAC, this workspace, this operation id, this fence) but lists no action: the worker has nothing it could call.
    const capabilities = new CallbackCapabilities(Buffer.from(KEY));
    for (const action of ["events", "artifacts", "result", "model-access", "heartbeat", "pull-request"] as const) expect(() => capabilities.verify(invocation.callbackCapability, action)).toThrow();
    expect(invocation.callbackCapability.length).toBeGreaterThanOrEqual(32);
  });

  it("gives a message from anyone but the owner no authority, and redacts and cuts the text", async () => {
    const w = await world();
    const key = ["sk", "ant", "api03", "Z".repeat(40)].join("-");
    expect(await send(w.deps, 2, `use this ${key} ${"x".repeat(3_000)}`, false)).toBe("steered");
    const sent = w.machines.answered[0] as { payload: { authority: string; text: string } };
    expect(sent.payload.authority).toBe("information");
    expect(sent.payload.text).not.toContain(key);
    expect(sent.payload.text.length).toBeLessThanOrEqual(2_000);
  });

  it("also reaches a step a local worker runs, whose operation stays DISPATCHING while it runs", async () => {
    const w = await world({ opStatus: "DISPATCHING" });
    expect(await send(w.deps)).toBe("steered");
  });

  it("reaches the steps that read a person's notes (understanding, planning, coding) and no other", async () => {
    for (const [mode, step] of [["UNDERSTAND", "UNDERSTAND"], ["PLAN", "PLAN"], ["IMPLEMENT", "IMPLEMENT"], ["SETUP_AGENT", "SETUP"]] as const) {
      const w = await world({ mode });
      expect(await send(w.deps)).toBe("steered");
      expect((w.machines.answered[0] as { payload: { step: string } }).payload.step).toBe(step);
    }
    for (const mode of ["REVIEW", "CHECKS", "PLAN_CRITIQUE", "FEEDBACK_REVIEW"]) {
      const w = await world({ mode });
      expect(await send(w.deps)).toBe("no_step");
      expect(w.machines.answered).toHaveLength(0);
    }
  });

  it("is a note when nothing runs, the operation is not running, the workspace is not busy or the machine is not up (a machine is never woken for a message)", async () => {
    for (const options of [{ opStatus: "SUCCEEDED" }, { opStatus: "ACCEPTED" }, { opStatus: "CANCEL_REQUESTED" }, { workspaceStatus: "READY" }, { busy: false }, { operationMachine: "m-other" }] as const) {
      const w = await world(options);
      expect(await send(w.deps)).toBe("no_step");
      expect(w.machines.answered).toHaveLength(0);
    }
    const stopped = await world();
    await stopped.machines.stop(stopped.handle.machineId);
    expect(await send(stopped.deps)).toBe("no_step");
    expect(stopped.machines.answered).toHaveLength(0);
    expect((await stopped.machines.health(stopped.handle.machineId)).state).toBe("stopped");
  });

  it("never reaches another task's run: a workspace the task once had that now works for another task, or has no task, takes no message; nor does a chain program's step", async () => {
    for (const options of [{ pointerTask: "11111111-2222-4333-8444-555555555555" }, { pointerTask: null }, { programStep: "step-1" }] as const) {
      const w = await world(options);
      expect(await send(w.deps)).toBe("no_step");
      expect(w.machines.answered).toHaveLength(0);
    }
  });

  it("is a note for a worker that does not list the feature, with the switch off and with no signing key", async () => {
    const old = await world({ features: [] });
    expect(await send(old.deps)).toBe("old_worker");
    expect(old.machines.answered).toHaveLength(0);
    const off = await world();
    expect(await send({ ...off.deps, enabled: false })).toBe("no_step");
    expect(await send({ ...off.deps, callbackSigningKey: "short" })).toBe("no_step");
    expect(await send(off.deps, 1, "   ")).toBe("no_step");
    expect(off.machines.answered).toHaveLength(0);
  });

  it("asks again, a few times, a step that has not opened its session yet, then leaves it as a note", async () => {
    const ready = await world({ answers: [{ accepted: true, outcome: "not_ready" }, { accepted: true, outcome: "steered" }] });
    expect(await send(ready.deps)).toBe("steered");
    expect(ready.machines.answered).toHaveLength(2);
    expect(ready.sleeps).toHaveLength(1);
    const never = await world({ answers: Array.from({ length: LIVE_STEER_ATTEMPTS }, () => ({ accepted: true, outcome: "not_ready" })) });
    expect(await send(never.deps)).toBe("not_ready");
    expect(never.machines.answered).toHaveLength(LIVE_STEER_ATTEMPTS);
    const gone = await world({ answers: [{ accepted: true, outcome: "not_running" }] });
    expect(await send(gone.deps)).toBe("no_step");
    expect(gone.machines.answered).toHaveLength(1);
  });

  it("treats an answer that does not parse, and a machine that refuses, as a note and never repeats what the worker said", async () => {
    const odd = await world({ answers: [{ accepted: false, secret: "do not repeat" }] });
    expect(await send(odd.deps)).toBe("failed");
    const logged: Array<Record<string, unknown>> = [];
    const refusing = await world();
    refusing.machines.deliver = async () => { throw new Error("worker said: secret-text-of-the-message"); };
    expect(await send({ ...refusing.deps, log: (entry) => logged.push(entry) }, 3, "secret-text-of-the-message")).toBe("failed");
    expect(JSON.stringify(logged)).not.toContain("secret-text-of-the-message");
  });
});

describe("the time a send may take", () => {
  it("is bounded: a worker that never answers leaves the message a note after the budget, and a later attempt is not started", async () => {
    const w = await world();
    let calls = 0;
    w.machines.deliver = () => { calls += 1; return new Promise(() => undefined); };
    const started = Date.now();
    expect(await send({ ...w.deps, budgetMs: 40 })).toBe("not_ready");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls).toBe(1);
  });
});

describe("a step that stopped for re-approval", () => {
  it("names the owner's messages in its error, and only an error with the fixed words counts", () => {
    const error = `${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE}: ${msg(1)}, ${msg(2)}, ${msg(1)}`;
    expect(isReapprovalStop(error)).toBe(true);
    expect(reapprovalMessageIds(error)).toEqual([msg(1), msg(2)]);
    expect(reapprovalMessageIds(`something else ${msg(3)}`)).toEqual([]);
    expect(isReapprovalStop(undefined)).toBe(false);
    expect(LIVE_STEER_REAPPROVAL_REASON).toBe("needs re-approval");
  });
});

describe("a message given live to a step that did not succeed", () => {
  it("reads as new to the re-run: only notes marked live at or after the attempt began lose the mark", async () => {
    const store = new MemoryDocumentStore();
    const note = (n: number, liveAt: string | undefined) => store.put({ item: { pk: `DEVTASK#${TASK}`, sk: `NOTE#${msg(n)}`, entityType: "WORKFLOW_THREAD_NOTE", ...(liveAt === undefined ? {} : { liveDeliveredAt: liveAt }) } });
    await note(1, "2026-11-10T09:00:00.000Z");
    await note(2, "2026-11-10T10:30:00.000Z");
    await note(3, undefined);
    const cleared = await clearLiveDeliveredSince({ store }, TASK, "2026-11-10T10:00:00.000Z");
    expect(cleared).toBe(1);
    expect((await store.get({ pk: `DEVTASK#${TASK}`, sk: `NOTE#${msg(1)}` }))?.["liveDeliveredAt"]).toBe("2026-11-10T09:00:00.000Z");
    expect((await store.get({ pk: `DEVTASK#${TASK}`, sk: `NOTE#${msg(2)}` }))?.["liveDeliveredAt"]).toBeUndefined();
    expect(await clearLiveDeliveredSince({ store }, TASK, "2026-11-10T10:00:00.000Z")).toBe(0);
  });
});
