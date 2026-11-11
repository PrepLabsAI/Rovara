// A project whose meta repository is separate from its code: the head is pinned when the task starts (through the code host), the preparation carries exactly that commit, a worker that cannot
// materialize it is refused, and the task keeps the commit only when the worker reports the one that was pinned.
import { describe, expect, it } from "vitest";
import { WORKER_INVOCATION_FEATURES, WorkerInvocationSchema, agentXError, type ProjectDefinition, type WorkerInvocation } from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { codeHostMetaHeadReader } from "../../packages/broker/src/core/meta-repo/head-reader.js";
import { META_PREPARE_FEATURE, META_UNREADABLE } from "../../packages/broker/src/core/meta-repo/prepare-meta.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const META_URL = "https://examplehost.test/acme/meta";
const project = (extra: Partial<ProjectDefinition["repositories"][number]> = {}): ProjectDefinition => ({
  ...definition,
  repositories: [
    { ...definition.repositories[0]!, role: "code", host: { kind: "fake" } } as never,
    { name: "meta", url: META_URL, path: "repo/meta", defaultBranch: "main", credentialRef: "host-app", host: { kind: "fake" }, role: "meta", ...extra } as never,
  ],
});

async function setup(options: { features?: string[]; hosts?: boolean } = {}) {
  const h = createHarness({ understandFirst: true, machines: { features: options.features ?? [...WORKER_INVOCATION_FEATURES] } });
  const model = new FakeHostModel({ url: META_URL, id: "9", fullName: "acme/meta", initialFiles: { "README.md": "x", ".rovara/rules/style.md": "Use tabs." } });
  const registry = createAdapterRegistry();
  registry.register("code-host", "fake", new FakeCodeHost(model));
  if (options.hosts !== false) h.deps.codeHosts = registry;
  await h.registerProject(project());
  return { h, model };
}

async function drain(h: Harness, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    const report = await h.flow.dispatchOnce({ maxMessages: 10 });
    if (report.received === 0) return;
    h.clock.advance(70);
  }
}
const prepareOf = async (h: Harness, workspaceId: string): Promise<{ invocation: WorkerInvocation | undefined; machineId: string }> => {
  await drain(h);
  const workspace = (await h.store.get(workspaceKey(workspaceId))) as unknown as WorkspaceRecord;
  const machineId = workspace.machine!.machineId;
  return { invocation: h.machines.delivered(machineId)[0], machineId };
};
const metaOf = (invocation: WorkerInvocation | undefined) => (invocation as { payload?: { meta?: { commit: string; paths: string[]; repository: { name: string } } } } | undefined)?.payload?.meta;
const start = (h: Harness) => h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint", workflow: true });

describe("pinning the meta repository when a task starts", () => {
  it("sends the preparation the meta repository and the commit that was its default branch's head, in a payload the worker accepts", async () => {
    const { h, model } = await setup();
    const head = model.headOf("main");
    const started = await start(h);
    const { invocation } = await prepareOf(h, started.task.workspaceId);
    expect(WorkerInvocationSchema.safeParse(invocation).success).toBe(true);
    expect(metaOf(invocation)).toMatchObject({ commit: head, repository: { name: "meta" } });
    expect(metaOf(invocation)?.paths).toEqual(expect.arrayContaining([".rovara", "AGENTS.md", ".kiro/steering"]));
    // The worker is sent the project without a meta repository that is not also code.
    expect((invocation as { payload: { project: { repositories: Array<{ name: string }> } } }).payload.project.repositories.map((repository) => repository.name)).toEqual(["demo"]);
  });

  it("a project with no separate meta repository carries no meta request, and needs no host for it", async () => {
    const h = createHarness({ understandFirst: true });
    await h.registerProject();
    const started = await start(h);
    const { invocation } = await prepareOf(h, started.task.workspaceId);
    expect(metaOf(invocation)).toBeUndefined();
  });

  it("refuses a worker that cannot materialize it, rather than sending the task without the team's rules", async () => {
    const { h } = await setup({ features: WORKER_INVOCATION_FEATURES.filter((feature) => feature !== META_PREPARE_FEATURE) });
    const started = await start(h);
    await drain(h);
    const view = await h.flow.get(h.owner, started.task.taskId);
    expect(JSON.stringify(view)).toContain("this worker is too old to run this step; upgrade it");
    expect(JSON.stringify(view.operations.map((operation) => operation.status))).toContain("FAILED");
  });

  it("refuses the start when the head cannot be read: no code host, a failing host, or an answer that is not a commit", async () => {
    const none = await setup({ hosts: false });
    await expect(start(none.h)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(META_UNREADABLE) as string });
    const failing = await setup();
    failing.h.deps.codeHosts!.get("code-host", "fake")!.baseBranchHead = () => Promise.reject(agentXError("RUNTIME_UNAVAILABLE", "https://secret.example/boom"));
    const refused = await start(failing.h).catch((error: unknown) => error as { code: string; message: string });
    expect(refused).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(META_UNREADABLE) as string });
    expect(JSON.stringify(refused)).not.toContain("secret.example");
    const odd = await setup();
    odd.h.deps.codeHosts!.get("code-host", "fake")!.baseBranchHead = () => Promise.resolve("main");
    await expect(start(odd.h)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("the commit the task keeps", () => {
  const finishPrepare = async (h: Harness, started: Awaited<ReturnType<typeof start>>, report: Record<string, unknown>) => {
    const { invocation, machineId } = await prepareOf(h, started.task.workspaceId);
    h.machines.finish(machineId, invocation!.operationId);
    await h.flow.recordResult({
      workspaceId: started.task.workspaceId, operationId: invocation!.operationId, fence: 1, status: "SUCCEEDED", outcome: { kind: "prepared", ...report },
    });
    return (await h.store.get(taskKey(started.task.taskId)))!;
  };

  it("keeps the pinned commit when the worker reports exactly it", async () => {
    const { h, model } = await setup();
    const started = await start(h);
    const task = await finishPrepare(h, started, { knowledgeCommit: model.headOf("main") });
    expect(task["knowledgeCommit"]).toBe(model.headOf("main"));
  });

  it("keeps nothing when the worker reports another commit, none, or when the head moved on: the worker never decides it", async () => {
    const { h, model } = await setup();
    const pinned = model.headOf("main");
    const started = await start(h);
    model.commit("main", { "README.md": "changed after the start" });
    expect((await finishPrepare(h, started, { knowledgeCommit: model.headOf("main") }))["knowledgeCommit"]).toBeUndefined();
    const second = await setup();
    const startedTwo = await start(second.h);
    expect((await finishPrepare(second.h, startedTwo, {}))["knowledgeCommit"]).toBeUndefined();
    expect(pinned).not.toBe(model.headOf("main"));
  });

  it("is the code host's head, read through the port: nothing for a project with no meta repository or no host", async () => {
    const { h } = await setup();
    expect(codeHostMetaHeadReader(undefined, project())).toBeUndefined();
    expect(codeHostMetaHeadReader(h.deps.codeHosts, { repositories: [definition.repositories[0]!] })).toBeUndefined();
    expect(codeHostMetaHeadReader(h.deps.codeHosts, project())).toBeDefined();
  });
});
