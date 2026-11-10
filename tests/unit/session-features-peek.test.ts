// a peek at a running task's working tree, for an Ask. One `peek` invocation through the machines port, to a worker that is up and lists the feature, with a filler where a capability goes (it opens
// nothing); any failure is no diff, and nothing is ever woken for it.
import { describe, expect, it } from "vitest";
import { PEEK_FEATURE, PEEK_NO_CALLBACK_CAPABILITY, PEEK_PATCH_MAX_BYTES, WorkerInvocationSchema, type PeekAnswer } from "@agentx/contracts";
import { createAskDiffReader, createPeekClient, diffFromPeek, splitPatchByFile } from "../../packages/broker/src/core/sessions/peek.js";
import { FakeWorkerMachines } from "../../packages/broker/src/ports/fake-worker-machines.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const WORKSPACE = "6f0d1c1e-1b9e-4c64-8f4a-0d7f6a9c3b11";
const PEEKED: PeekAnswer = {
  accepted: true, outcome: "peeked", files: [{ repository: "demo", path: "src/a.ts", additions: 3, deletions: 1 }], untracked: [{ repository: "demo", path: "src/new.ts" }],
  patch: "## repository demo\ndiff --git a/src/a.ts b/src/a.ts\n+one\n-two\ndiff --git a/src/b.ts b/src/b.ts\n+three", patchTruncated: false, filesTruncated: false,
};

async function world(options: { features?: readonly string[]; answer?: unknown; busy?: boolean; status?: string } = {}) {
  const machines = new FakeWorkerMachines({ startingChecks: 0, features: options.features ?? [PEEK_FEATURE], answer: () => (options.answer ?? PEEKED) as Record<string, unknown> });
  const handle = await machines.start({ machineKey: WORKSPACE, companyId: "org_x" });
  await machines.health(handle.machineId);
  if (options.busy === true) await machines.deliver(handle.machineId, { kind: "task", operationId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", workspaceId: WORKSPACE } as never);
  const store = new MemoryDocumentStore();
  await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", taskId: TASK, workspaceId: WORKSPACE } });
  await store.put({ item: { pk: `WORKSPACE#${WORKSPACE}`, sk: "META", id: WORKSPACE, status: options.status ?? "READY", activeOperationId: null, fence: 3, projectRevision: 1, machine: { machineId: handle.machineId, machineKey: WORKSPACE } } });
  return { machines, handle, store, peek: createPeekClient({ store, machines, newOperationId: () => "11111111-2222-4333-8444-555555555555", timeoutMs: 50 }) };
}

describe("a peek at the working tree", () => {
  it("is one peek invocation whose capability is a filler no route accepts, with the size the worker may return and no command or path", async () => {
    const w = await world();
    expect(await w.peek(TASK)).toEqual(PEEKED);
    expect(w.machines.answered).toHaveLength(1);
    const sent = WorkerInvocationSchema.parse(w.machines.answered[0]);
    expect(sent).toMatchObject({ kind: "peek", workspaceId: WORKSPACE, fence: 3, callbackCapability: PEEK_NO_CALLBACK_CAPABILITY, payload: { maxPatchBytes: PEEK_PATCH_MAX_BYTES } });
    expect(Object.keys((sent as { payload: object }).payload)).toEqual(["maxPatchBytes"]);
    // A busy worker is looked at too.
    expect(await (await world({ busy: true, status: "BUSY" })).peek(TASK)).toEqual(PEEKED);
  });

  it("gives nothing, and wakes nothing, for a machine that is not up, a worker that does not list the feature, or a workspace that is not this task's to look at", async () => {
    const stopped = await world();
    await stopped.machines.stop(stopped.handle.machineId);
    expect(await stopped.peek(TASK)).toBeUndefined();
    expect(stopped.machines.answered).toHaveLength(0);
    expect((await stopped.machines.health(stopped.handle.machineId)).state).toBe("stopped");
    const old = await world({ features: [] });
    expect(await old.peek(TASK)).toBeUndefined();
    expect(old.machines.answered).toHaveLength(0);
    expect(await (await world({ status: "CLOSED" })).peek(TASK)).toBeUndefined();
    expect(await (await world()).peek("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("gives nothing for a worker that could not read the tree, an answer that does not parse, a refusal and a worker that never answers", async () => {
    expect(await (await world({ answer: { ...PEEKED, outcome: "unavailable" } })).peek(TASK)).toBeUndefined();
    expect(await (await world({ answer: { accepted: true, outcome: "peeked", files: "nope" } })).peek(TASK)).toBeUndefined();
    const refusing = await world();
    refusing.machines.deliver = async () => { throw new Error("worker said: secret"); };
    expect(await refusing.peek(TASK)).toBeUndefined();
    const silent = await world();
    silent.machines.deliver = () => new Promise(() => undefined);
    expect(await silent.peek(TASK)).toBeUndefined();
  });
});

describe("the diff an Ask is given from a peek", () => {
  it("names the files as the task's page does, strips the banner of a single repository and marks files git does not track yet", () => {
    const diff = diffFromPeek(PEEKED);
    expect(diff.source).toBe("working_tree");
    expect(diff.files).toEqual([{ path: "src/a.ts", additions: 3, deletions: 1 }, { path: "src/new.ts (new, not yet tracked)", additions: 0, deletions: 0 }]);
    expect(diff.patches?.map((patch) => patch.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("puts the repository's name before a path only when there are several", () => {
    const several: PeekAnswer = { ...PEEKED, files: [...PEEKED.files, { repository: "api", path: "x.ts", additions: 1, deletions: 0 }], patch: "## repository api\ndiff --git a/x.ts b/x.ts\n+x\n## repository demo\ndiff --git a/src/a.ts b/src/a.ts\n+y" };
    const diff = diffFromPeek(several);
    expect(diff.files.map((file) => file.path)).toEqual(["demo/src/a.ts", "api/x.ts", "demo/src/new.ts (new, not yet tracked)"]);
    expect(diff.patches?.map((patch) => patch.path)).toEqual(["api/x.ts", "demo/src/a.ts"]);
    expect(splitPatchByFile("no header at all")).toEqual([]);
  });

  it("is the reader of an Ask: the peek's diff, or nothing when there is no peek or it fails", async () => {
    const w = await world();
    const task = { taskId: TASK } as never;
    expect((await createAskDiffReader({ peek: w.peek })(task, "patches"))?.files).toHaveLength(2);
    expect(await createAskDiffReader({})(task, "patches")).toBeUndefined();
    expect(await createAskDiffReader({ peek: async () => { throw new Error("no"); } })(task, "patches")).toBeUndefined();
  });
});
