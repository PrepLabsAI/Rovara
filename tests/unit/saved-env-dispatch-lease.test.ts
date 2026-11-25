// Saved project images: the lease token hand-off. The registry keeps the job's lease token and the worker refuses a build without it, but nothing between them carried it: the dispatcher never asked for it, so
// no saved image build could finish. Here a real dispatcher delivers a rebuild's preparation to a (fake) machine and the worker's own build entry takes what was delivered: the token must arrive, and the
// push login and the result must be asked for with it and no other.
import { describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, PREPARE_SAVED_ENV_BUILD_FEATURE, type SavedEnvBuildResult, type WorkerInvocation } from "@agentx/contracts";
import { runDispatchOnce } from "../../packages/broker/src/core/task-flow/dispatch.js";
import { savedEnvBuildFields } from "../../packages/broker/src/core/task-flow/saved-env-lease-step.js";
import type { OperationRecord, WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import type { SavedEnvDispatchLease } from "../../packages/broker/src/core/test-env/saved-env-dispatch-lease.js";
import { savedEnvDispatchLeaseFor, savedEnvDispatchLeaseOf } from "../../packages/broker/src/core/test-env/saved-env-dispatch-lease.js";
import { operationKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { SAVED_ENV_JOB_LEASE_MS, authorizeLease, checkRebuild, leaseForDispatch, type RebuildJob } from "../../packages/broker/src/core/test-env/saved-env.js";
import { startMarkerKey } from "../../packages/broker/src/core/test-env/saved-env-markers.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { runSavedEnvRebuild } from "../../packages/worker/src/saved-env/rebuild.js";
import { BASE_IMAGE, COMPANY, PROJECT, approve, environmentBody, savedWorld, textOf, type SavedWorld } from "../support/saved-env-harness.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

const ids = { orgId: COMPANY, projectId: PROJECT };
const FEATURES = ["task.workflowMode", "task.structuredPlans", PREPARE_SAVED_ENV_BUILD_FEATURE];

/** A project with a queued rebuild whose preparation the registry has already started (one workspace, one operation, one message), and the dispatcher's lease seam wired over the same registry. */
async function queuedBuild(options: { features?: string[]; seam?: boolean | ((real: SavedEnvDispatchLease) => SavedEnvDispatchLease) } = {}): Promise<{ w: SavedWorld; job: RebuildJob; workspaceId: string; operationId: string; logs: Array<Record<string, unknown>> }> {
  const logs: Array<Record<string, unknown>> = [];
  const w = savedWorld({ harness: { machines: { features: options.features ?? FEATURES }, audit: "recording", extra: () => ({ log: (entry: Record<string, unknown>) => { logs.push(entry); } }) } });
  await w.h.registerProject();
  await approve(w.test, environmentBody());
  await checkRebuild(w.deps, ids, "push");
  const job = (await w.deps.store.get(COMPANY, PROJECT))!.job!;
  const marker = (await w.h.store.get(startMarkerKey(job.jobId)))!;
  const real = savedEnvDispatchLeaseOf(w.deps, COMPANY);
  if (options.seam !== false) Object.assign(w.h.deps, { savedEnvLease: typeof options.seam === "function" ? options.seam(real) : real });
  return { w, job, workspaceId: textOf(marker, "workspaceId"), operationId: textOf(marker, "operationId"), logs };
}

/** Runs the dispatcher until the operation is handed to a machine (or the tries run out); returns what the machine was given. */
async function dispatched(w: SavedWorld, workspaceId: string, operationId: string): Promise<{ delivered: WorkerInvocation | undefined; status: string; error: string; machineId: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await w.h.flow.relayOnce();
    await runDispatchOnce(w.h.deps, { maxMessages: 10 });
    w.h.clock.advance(61);
  }
  const operation = (await w.h.store.get(operationKey(COMPANY, workspaceId, operationId)))!;
  const machineId = textOf(operation, "machineId");
  return { delivered: machineId === "" ? undefined : w.h.machines.delivered(machineId).find((invocation) => invocation.operationId === operationId), status: textOf(operation, "status"), error: textOf(operation, "error"), machineId };
}

describe("the lease token reaches the worker that builds", () => {
  it("a saved image build is delivered with its job's lease token, and the worker's build entry takes it and reports with it", async () => {
    const { w, job, workspaceId, operationId } = await queuedBuild();
    const { delivered, status } = await dispatched(w, workspaceId, operationId);
    expect(status).toBe("DISPATCHING");
    if (delivered?.kind !== "prepare") throw new Error("a preparation was not delivered");
    expect(delivered.payload.savedEnvBuild?.jobId).toBe(job.jobId);
    expect(delivered.payload.savedEnvBuild?.leaseToken).toBe(job.leaseToken);

    // the worker's own entry, over what was delivered: it does not refuse the build for want of a lease, and it asks the broker's two lease routes with the job and its token
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImplementation = (async (url: string, init: RequestInit) => { posted.push({ url: String(url), body: JSON.parse(init.body as string) as Record<string, unknown> }); return new Response("{}", { status: 200 }); }) as typeof fetch;
    const result: SavedEnvBuildResult = { ok: false, reason: "not_proved" };
    const taken = await runSavedEnvRebuild({
      rootPath: "/mnt/workspace", controlPlaneUrl: "https://cp.example.test", invocation: delivered, docker: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      manifest: { repositories: Object.entries(job.commits).map(([name, resolvedCommit]) => ({ name, path: name, defaultBranch: "main", resolvedCommit, resolvedAt: "x", completedAt: "x" })) },
      otherOperations: async () => [], environment: { PATH: "/usr/bin", AGENTX_SANDBOX_IMAGE: `registry.example.test/worker@${BASE_IMAGE}` }, fetchImplementation, build: async () => result,
    });
    expect(taken).toEqual(result);
    expect(posted.map((call) => call.url.split("/").at(-1))).toEqual(["saved-env-result"]);
    expect(posted[0]!.body).toMatchObject({ jobId: job.jobId, leaseToken: job.leaseToken });
    // and the broker's lease check takes exactly that pair
    expect(await authorizeLease(w.deps, ids, { jobId: job.jobId, leaseToken: String(posted[0]!.body["leaseToken"]) })).toMatchObject({ ok: true });
  });
});

const LEASE_FAILED_WORDS = /lease/u;

describe("the token goes to the one delivery, and nowhere else", () => {
  it("is in the delivered invocation once, and in no stored row, queue message, audit event or log line (the registry row is its one home)", async () => {
    const { w, job, workspaceId, operationId, logs } = await queuedBuild();
    const { delivered } = await dispatched(w, workspaceId, operationId);
    expect(JSON.stringify(delivered).split(job.leaseToken)).toHaveLength(2);
    // every stored row but the registry's own
    let cursor: string | undefined;
    const rows: string[] = [];
    do {
      const page = await (w.h.store as MemoryDocumentStore).scanPage({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      for (const item of page.items) if (!String(item["sk"]).startsWith("SAVED_ENV#")) rows.push(JSON.stringify(item));
      cursor = page.cursor;
    } while (cursor !== undefined);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((row) => row.includes(job.leaseToken))).toEqual([]);
    expect(JSON.stringify(w.h.audit)).not.toContain(job.leaseToken);
    expect(JSON.stringify(logs)).not.toContain(job.leaseToken);
    const left = await w.h.queues.queue("task-dispatch").then((queue) => queue.receive({ maxMessages: 10 }));
    expect(JSON.stringify(left)).not.toContain(job.leaseToken);
    // the registry hands it to this operation, once
    expect((await w.deps.store.get(COMPANY, PROJECT))!.job).toMatchObject({ dispatchedOperationId: operationId });
  });

  it("is never read from the stored payload: a token written there is dropped and the registry's is sent", async () => {
    const { w, job, workspaceId, operationId } = await queuedBuild();
    const forged = `forged-${"f".repeat(30)}`;
    await w.h.store.update({ key: operationKey(COMPANY, workspaceId, operationId), ops: [{ op: "set", path: ["dispatch", "payload", "savedEnvBuild", "leaseToken"], value: forged }] });
    const { delivered } = await dispatched(w, workspaceId, operationId);
    expect(delivered?.kind === "prepare" ? delivered.payload.savedEnvBuild?.leaseToken : undefined).toBe(job.leaseToken);
    expect(JSON.stringify(delivered)).not.toContain(forged);
  });

  it("asks for exactly the job the broker stored with the operation, for this operation and this project, and nothing a request carried", async () => {
    const asked: Array<{ projectId: string; jobId: string; operationId: string }> = [];
    const { w, job, workspaceId, operationId } = await queuedBuild({ seam: (real) => ({ ...real, take: async (input) => { asked.push(input); return real.take(input); } }) });
    await dispatched(w, workspaceId, operationId);
    expect(asked).toEqual([{ projectId: PROJECT, jobId: job.jobId, operationId }]);
  });

  it("a retried delivery of the same operation is given the same token; another operation is given nothing", async () => {
    const { w, job, workspaceId, operationId } = await queuedBuild();
    await dispatched(w, workspaceId, operationId);
    const seam = savedEnvDispatchLeaseOf(w.deps, COMPANY);
    expect(await seam.take({ projectId: PROJECT, jobId: job.jobId, operationId })).toEqual({ ok: true, leaseToken: job.leaseToken });
    expect(await seam.take({ projectId: PROJECT, jobId: job.jobId, operationId: "another-operation" })).toEqual({ ok: false, reason: "nothing_to_dispatch" });
  });

  it("is given to no other kind of job: an ordinary task's preparation and run never ask for it", async () => {
    const asked = vi.fn(async () => ({ ok: false as const, reason: "nothing_to_dispatch" as const }));
    const h = createHarness({ machines: { startingChecks: 0, features: ["task.workflowMode", "task.structuredPlans", PREPARE_SAVED_ENV_BUILD_FEATURE] }, extra: () => ({ savedEnvLease: { check: asked, take: asked } }) });
    await h.registerProject();
    await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
    for (let attempt = 0; attempt < 4; attempt += 1) { await h.flow.dispatchOnce({ maxMessages: 10 }); h.clock.advance(61); }
    expect(asked).not.toHaveBeenCalled();
    const sent = [...JSON.stringify(h.machines).matchAll(/savedEnvBuild/gu)];
    expect(sent).toEqual([]);
  });
});

describe("a build whose lease cannot be handed over is not dispatched", () => {
  /** The operation ended without a machine being given the job, in words that name the lease and hold no token; and (unless said) without any machine having been started for it. */
  async function notDispatched(over: { features?: string[]; seam?: boolean | ((real: SavedEnvDispatchLease) => SavedEnvDispatchLease); machine?: "started"; before?: (w: SavedWorld, ctx: { job: RebuildJob; workspaceId: string; operationId: string }) => Promise<void> }, words: RegExp): Promise<{ w: SavedWorld; job: RebuildJob; logs: Array<Record<string, unknown>> }> {
    const { w, job, workspaceId, operationId, logs } = await queuedBuild({ ...(over.features === undefined ? {} : { features: over.features }), ...(over.seam === undefined ? {} : { seam: over.seam }) });
    await over.before?.(w, { job, workspaceId, operationId });
    const { delivered, status, error, machineId } = await dispatched(w, workspaceId, operationId);
    expect(delivered).toBeUndefined();
    expect(status).toBe("FAILED");
    // the refusal is made before admission: no machine was asked for, none is kept by the workspace
    if (over.machine === undefined) {
      expect(machineId).toBe("");
      expect(await w.h.store.get(workspaceKey(COMPANY, workspaceId))).not.toHaveProperty("machine");
    } else expect(machineId).not.toBe("");
    expect(error).toMatch(words);
    expect(error).not.toContain(job.leaseToken);
    expect(JSON.stringify(logs)).not.toContain(job.leaseToken);
    return { w, job, logs };
  }

  it("when the lease has run out", async () => {
    await notDispatched({ before: async (w) => { w.h.clock.advance(SAVED_ENV_JOB_LEASE_MS / 1000 + 1); } }, LEASE_FAILED_WORDS);
  });

  it("when no lease seam is wired (an install or a laptop that does not hand them out)", async () => {
    const { w, job } = await notDispatched({ seam: false }, /cannot hand a saved image build its lease/u);
    expect((await w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
    expect(job.jobId).toBeDefined();
  });

  it("when the operation names a job that is not the project's current one, and the current job is left untaken", async () => {
    const { w, job } = await notDispatched({ before: async (w2, ctx) => {
      await w2.h.store.update({ key: operationKey(COMPANY, ctx.workspaceId, ctx.operationId), ops: [{ op: "set", path: ["dispatch", "payload", "savedEnvBuild", "jobId"], value: "someone-elses-job" }] });
    } }, LEASE_FAILED_WORDS);
    const row = (await w.deps.store.get(COMPANY, PROJECT))!.job!;
    expect(row.jobId).toBe(job.jobId);
    expect(row.dispatchedAt).toBeUndefined();
    expect(row.dispatchedOperationId).toBeUndefined();
  });

  it("when the stored operation names no job (or not a job at all): the registry is not even asked, and the project's current job is left untaken", async () => {
    for (const stored of [{}, { jobId: 7 }, { jobId: "" }, "not an object"]) {
      const asked: unknown[] = [];
      const { w, job, workspaceId, operationId } = await queuedBuild({ seam: (real) => ({ ...real, take: async (input) => { asked.push(input); return real.take(input); } }) });
      await w.h.store.update({ key: operationKey(COMPANY, workspaceId, operationId), ops: [{ op: "set", path: ["dispatch", "payload", "savedEnvBuild"], value: stored as never }] });
      const { delivered, status, error } = await dispatched(w, workspaceId, operationId);
      expect([delivered, status, asked], JSON.stringify(stored)).toEqual([undefined, "FAILED", []]);
      expect(error).toMatch(LEASE_FAILED_WORDS);
      expect((await w.deps.store.get(COMPANY, PROJECT))!.job).toMatchObject({ jobId: job.jobId });
      expect((await w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
    }
  });

  it("when the registry's job was handed to another operation", async () => {
    await notDispatched({ before: async (w, ctx) => { expect(await leaseForDispatch(w.deps, ids, "another-operation", ctx.job.jobId)).toMatchObject({ ok: true }); } }, LEASE_FAILED_WORDS);
  });

  it("when the install's switch is off (the seam says disabled)", async () => {
    await notDispatched({ seam: () => ({ check: async () => ({ ok: true }), take: async () => ({ ok: false, reason: "disabled" }) }), machine: "started" }, /cannot hand a saved image build its lease/u);
  });

  it("when the worker does not list the build feature, even if the stored job forgot to require it: the token is not taken", async () => {
    const { w } = await notDispatched({ features: ["task.workflowMode", "task.structuredPlans"], machine: "started", before: async (w2, ctx) => {
      await w2.h.store.update({ key: operationKey(COMPANY, ctx.workspaceId, ctx.operationId), ops: [{ op: "set", path: ["dispatch", "requires"], value: [] }] });
    } }, /too old/u);
    expect((await w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
  });

  it("retries a lost write race with a pause, and an exhausted race is not an end: the operation is left to come back, nothing is taken", async () => {
    let calls = 0;
    const flaky = (losses: number) => (real: SavedEnvDispatchLease): SavedEnvDispatchLease => ({ ...real, take: async (input) => { calls += 1; return calls <= losses ? { ok: false, reason: "stale_write" } : real.take(input); } });
    const first = await queuedBuild({ seam: flaky(2) });
    const { delivered } = await dispatched(first.w, first.workspaceId, first.operationId);
    expect(delivered?.kind === "prepare" ? delivered.payload.savedEnvBuild?.leaseToken : undefined).toBe(first.job.leaseToken);
    expect(calls).toBe(3);
    calls = 0;
    const lost = await queuedBuild({ seam: flaky(99) });
    const answer = await dispatched(lost.w, lost.workspaceId, lost.operationId);
    expect(answer.delivered).toBeUndefined();
    expect(answer.status).not.toBe("FAILED");
    // each delivery that comes back tries three times; none ends the operation
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(calls % 3).toBe(0);
    expect((await lost.w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
  });

  it("a registry that cannot be read after the claim is not an end either, and the fault is logged by a fixed word", async () => {
    const { w, job, workspaceId, operationId, logs } = await queuedBuild({ seam: (real) => ({ ...real, take: async () => { throw new Error(`registry down ${"x".repeat(5)}`); } }) });
    const answer = await dispatched(w, workspaceId, operationId);
    expect(answer.delivered).toBeUndefined();
    expect(answer.status).not.toBe("FAILED");
    expect(logs.filter((entry) => entry["event"] === "task_flow.saved_env_lease_unreadable")).not.toEqual([]);
    expect(logs.filter((entry) => entry["event"] === "task_flow.saved_env_lease_unreadable").every((entry) => entry["step"] === "take")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("registry down");
    expect(job.jobId).toBeDefined();
  });

  it("a registry that cannot be read before anything starts is tried again later: the operation stays accepted and no machine is started", async () => {
    let reads = 0;
    const { w, workspaceId, operationId, job } = await queuedBuild({ seam: (real) => ({ ...real, check: async (input) => { reads += 1; if (reads <= 2) throw new Error("registry down"); return real.check(input); } }) });
    const first = await dispatched(w, workspaceId, operationId);
    expect(reads).toBeGreaterThanOrEqual(3);
    // once it can be read the build goes on to its delivery, with the token
    expect(first.status).toBe("DISPATCHING");
    expect(first.delivered?.kind === "prepare" ? first.delivered.payload.savedEnvBuild?.leaseToken : undefined).toBe(job.leaseToken);
  });

  it("a registry that stays unreadable before anything starts is retried only as often as a delivery may be, then the operation ends in plain words, with no machine ever started", async () => {
    const { w, workspaceId, operationId, job } = await queuedBuild({ seam: (real) => ({ ...real, check: async () => { throw new Error("registry down"); } }) });
    for (let attempt = 0; attempt < 30; attempt += 1) { await w.h.flow.relayOnce(); await runDispatchOnce(w.h.deps, { maxMessages: 10 }); w.h.clock.advance(61); }
    const operation = (await w.h.store.get(operationKey(COMPANY, workspaceId, operationId)))!;
    expect(textOf(operation, "status")).toBe("FAILED");
    expect(textOf(operation, "error")).toMatch(/could not be read after several tries/u);
    expect(textOf(operation, "machineId")).toBe("");
    expect(await w.h.store.get(workspaceKey(COMPANY, workspaceId))).not.toHaveProperty("machine");
    expect((await w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
    expect(job.jobId).toBeDefined();
  });

  it("asks before it starts anything: the check runs while the workspace has no machine, and the take only after one", async () => {
    const order: string[] = [];
    const ref: { built?: Awaited<ReturnType<typeof queuedBuild>> } = {};
    const hasMachine = async (): Promise<boolean> => (await ref.built!.w.h.store.get(workspaceKey(COMPANY, ref.built!.workspaceId)))?.["machine"] !== undefined;
    const built = await queuedBuild({ seam: (real) => ({
      check: async (input) => { order.push(`check:${String(await hasMachine())}`); return real.check(input); },
      take: async (input) => { order.push(`take:${String(await hasMachine())}`); return real.take(input); },
    }) });
    ref.built = built;
    await dispatched(built.w, built.workspaceId, built.operationId);
    expect(order[0]).toBe("check:false");
    expect(order.at(-1)).toBe("take:true");
  });

  it("logs only the fixed reason of a refusal", async () => {
    const { logs, job } = await notDispatched({ before: async (w) => { w.h.clock.advance(SAVED_ENV_JOB_LEASE_MS / 1000 + 1); } }, LEASE_FAILED_WORDS);
    expect(logs.filter((entry) => entry["event"] === "task_flow.saved_env_lease_refused")).toEqual([{ component: "task-flow", companyId: COMPANY, event: "task_flow.saved_env_lease_refused", step: "before_start", reason: "nothing_to_dispatch" }]);
    expect(JSON.stringify(logs)).not.toContain(job.jobId);
  });
});

describe("the step after the claim, on its own", () => {
  const operation = (saved: unknown) => ({ id: "op-1", dispatch: { kind: "prepare", payload: { savedEnvBuild: saved } } }) as unknown as OperationRecord;
  const workspace = { projectName: PROJECT } as WorkspaceRecord;
  const deps = (take: (input: unknown) => Promise<unknown>) => ({ companyId: COMPANY, savedEnvLease: { check: async () => ({ ok: true }), take } }) as never;

  it("never asks for a build that names no job, even if the check before the start was passed (the stored record may have changed)", async () => {
    const take = vi.fn(async () => ({ ok: true, leaseToken: "t".repeat(24) }));
    for (const stored of [{}, { jobId: 3 }, { jobId: "" }, "text", null, []]) {
      expect(await savedEnvBuildFields(deps(take), operation(stored), workspace, FEATURES), JSON.stringify(stored)).toMatch(/lease/u);
    }
    expect(take).not.toHaveBeenCalled();
  });

  it("pauses a little longer between each try after a lost race", async () => {
    const pauses = vi.spyOn(globalThis, "setTimeout");
    try {
      const take = vi.fn(async () => ({ ok: false, reason: "stale_write" }));
      await expect(savedEnvBuildFields(deps(take), operation({ jobId: "job-1" }), workspace, FEATURES)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(take).toHaveBeenCalledTimes(3);
      expect(pauses.mock.calls.map((call) => call[1])).toEqual(expect.arrayContaining([50, 100]));
    } finally { pauses.mockRestore(); }
  });
});

describe("the registry's side of the hand-off", () => {
  it("answers a named job only for that job, and a job that is not the current one is not marked as taken", async () => {
    const { w, job, operationId } = await queuedBuild({ seam: false });
    expect(await leaseForDispatch(w.deps, ids, operationId, "another-job")).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect((await w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
    expect(await leaseForDispatch(w.deps, ids, operationId, job.jobId)).toMatchObject({ ok: true, job: { jobId: job.jobId, leaseToken: job.leaseToken } });
  });

  it("the dispatcher's seam gives a token and nothing else, and only for its own company", async () => {
    const { w, job, operationId } = await queuedBuild({ seam: false });
    const given = await savedEnvDispatchLeaseOf(w.deps, COMPANY).take({ projectId: PROJECT, jobId: job.jobId, operationId });
    expect(Object.keys(given).sort()).toEqual(["leaseToken", "ok"]);
    const other = await savedEnvDispatchLeaseOf(w.deps, "org-someone-else").take({ projectId: PROJECT, jobId: job.jobId, operationId });
    expect(other).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect(await savedEnvDispatchLeaseOf(w.deps, COMPANY).take({ projectId: PROJECT, jobId: "", operationId })).toEqual({ ok: false, reason: "nothing_to_dispatch" });
  });

  it("gives nothing for an empty operation id, and marks nothing as taken", async () => {
    const { w, job } = await queuedBuild({ seam: false });
    expect(await savedEnvDispatchLeaseOf(w.deps, COMPANY).take({ projectId: PROJECT, jobId: job.jobId, operationId: "" })).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect((await w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
  });

  it("a job id that is missing or not text never reaches the registry's hand-over: nothing is given and nothing is marked taken", async () => {
    const { w, job, operationId } = await queuedBuild({ seam: false });
    const seam = savedEnvDispatchLeaseOf(w.deps, COMPANY);
    for (const jobId of [undefined, null, 7, ""]) expect(await seam.take({ projectId: PROJECT, jobId: jobId as never, operationId })).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect(await seam.take({ projectId: undefined as never, jobId: job.jobId, operationId })).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    // and the hand-over itself holds the line for a caller that skips the seam
    expect(await leaseForDispatch(w.deps, ids, operationId, undefined as never)).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect(await leaseForDispatch(w.deps, ids, undefined as never, job.jobId)).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect((await w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
  });

  it("the check is read only: it answers as the take would, and marks nothing", async () => {
    const { w, job, operationId } = await queuedBuild({ seam: false });
    const seam = savedEnvDispatchLeaseOf(w.deps, COMPANY);
    const ask = { projectId: PROJECT, jobId: job.jobId, operationId };
    expect(await seam.check(ask)).toEqual({ ok: true });
    expect((await w.deps.store.get(COMPANY, PROJECT))!.job?.dispatchedAt).toBeUndefined();
    const version = (await w.deps.store.get(COMPANY, PROJECT))!.version;
    await seam.check(ask);
    expect((await w.deps.store.get(COMPANY, PROJECT))!.version).toBe(version);
    expect(await seam.check({ ...ask, jobId: "another-job" })).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect(await seam.check({ ...ask, operationId: "" })).toEqual({ ok: false, reason: "nothing_to_dispatch" });
    expect(await seam.take(ask)).toMatchObject({ ok: true });
    // after the take: the same operation is still told yes, another one no
    expect(await seam.check(ask)).toEqual({ ok: true });
    expect(await seam.check({ ...ask, operationId: "another-operation" })).toEqual({ ok: false, reason: "nothing_to_dispatch" });
  });

  it("is off with the install's switch off", () => {
    const w = savedWorld();
    expect(savedEnvDispatchLeaseFor({ companyId: IMPLICIT_COMPANY_ID, store: w.h.store, env: {}, now: () => w.h.clock.now })).toBeUndefined();
    expect(savedEnvDispatchLeaseFor({ companyId: IMPLICIT_COMPANY_ID, store: w.h.store, env: { ROVARA_SAVED_ENVIRONMENTS: "0" }, now: () => w.h.clock.now })).toBeUndefined();
    expect(savedEnvDispatchLeaseFor({ companyId: IMPLICIT_COMPANY_ID, store: w.h.store, env: { ROVARA_SAVED_ENVIRONMENTS: "1" }, now: () => w.h.clock.now })).toBeDefined();
    expect(Object.keys(savedEnvDispatchLeaseFor({ companyId: IMPLICIT_COMPANY_ID, store: w.h.store, env: { ROVARA_SAVED_ENVIRONMENTS: "1" }, now: () => w.h.clock.now }) ?? {}).sort()).toEqual(["check", "take"]);
  });
});
