import { randomUUID } from "node:crypto";
import { createHarness, definition } from "../support/task-flow-harness.js";
import { describe, expect, it } from "vitest";
import { change, when, developerTaskPolicy, sharedTaskKey } from "@agentx/contracts";
import { shareTask } from "../../packages/broker/src/core/task-flow/share.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { decideShare } from "../../packages/broker/src/developer/share.js";
import { taskShare } from "../../packages/broker/src/developer/task-records.js";
import { seed, TASK_ID, REQUEST_A, REQUEST_B, taskOf } from "../support/task-actions-world.js";

const wanted = { requestId: REQUEST_A, shareMode: "continue" };
const share = { teamId: "T0123456789", channelId: "C0123456789", channelName: "payments", mode: "continue", sharedReason: "requested", sharedAt: "2026-11-10T10:00:00.000Z" } as const;
async function world() {
  const w = await seed();
  w.h.deps.taskSharing = { prepare: async () => share };
  const project = w.h.deps.projects;
  w.h.deps.projects = { ...project, latest: async (name) => { const found = await project.latest(name); return found === undefined ? undefined : { ...found, definition: { ...found.definition, developerTasks: { ...developerTaskPolicy(found.definition), shareMode: { default: "view", allowContinue: true } } } }; } };
  return w;
}

describe("task-start share options", () => {
  it("shares a channel-only start to the named channel when the project requires sharing among several channels", async () => {
    const h = createHarness();
    const policy = { ...developerTaskPolicy(definition), share: "required" as const };
    await h.registerProject({ ...definition, developerTasks: policy });
    h.deps.taskSharing = { prepare: async (_caller, project, wanted) => {
      const decision = decideShare({ project, policy, shareToChannel: wanted.shareToChannel, ...(wanted.channel === undefined ? {} : { channel: wanted.channel }), bound: [
        { channelId: "C0123456789", name: "payments", isPrivate: false },
        { channelId: "C1123456789", name: "payments-dev", isPrivate: false },
        { channelId: "C2123456789", name: "payments-ops", isPrivate: false },
      ] });
      return decision === undefined ? undefined : taskShare(decision, "T0123456789", new Date(h.clock.now).toISOString());
    } };
    const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Add retry", channel: "payments-dev" });
    expect(await h.store.get(taskKey(started.task.taskId))).toMatchObject({
      shared: true, share: { channelId: "C1123456789", channelName: "payments-dev", sharedReason: "required" },
    });
  });

  it.each([
    { shareMode: "view" },
    { channel: "C0123456789" },
    { shareToChannel: false, shareMode: "continue", channel: "C0123456789" },
  ])("refuses options without sharing: %j", async options => {
    const h = createHarness();
    await h.registerProject();
    // Match the host seam: an unshared request returns no share.
    h.deps.taskSharing = { prepare: async () => undefined };
    const start = h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Add retry", ...options });
    await expect(start).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(start).rejects.toThrow("shareToChannel");
    expect((await h.flow.list(h.owner)).tasks).toHaveLength(0);
    expect(h.grants).toHaveLength(0);
  });
});

describe("core share mode", () => {
  it("keeps the same share map, index, request and audit records; a repeat writes nothing and changed payload conflicts", async () => {
    const { h, caller } = await world();
    await shareTask(h.deps, caller, TASK_ID, wanted);
    expect(await taskOf(h)).toMatchObject({ shared: true, shareVersion: 1, share });
    await shareTask(h.deps, caller, TASK_ID, wanted);
    expect((await taskOf(h)).shareVersion).toBe(1);
    expect(h.audit).toHaveLength(1);
    await expect(shareTask(h.deps, caller, TASK_ID, { ...wanted, shareMode: "view" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("cannot move a shared channel, and latest policy can lower continue to view", async () => {
    const { h, caller } = await world();
    await shareTask(h.deps, caller, TASK_ID, wanted);
    await expect(shareTask(h.deps, caller, TASK_ID, { requestId: REQUEST_B, channel: "COTHER1234" })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const project = h.deps.projects;
    h.deps.projects = { ...project, latest: async (name) => { const found = await project.latest(name); return found === undefined ? undefined : { ...found, definition: { ...found.definition, developerTasks: { ...developerTaskPolicy(found.definition), shareMode: { default: "view", allowContinue: false } } } }; } };
    await shareTask(h.deps, caller, TASK_ID, { requestId: REQUEST_B, shareMode: "continue" });
    expect((await taskOf(h)).share).toMatchObject({ mode: "view", modeReason: "continue_not_allowed" });
  });
  it("preserves the notifier's thread across a version race and updates the thread mode", async () => {
    const { h, caller } = await world();
    await shareTask(h.deps, caller, TASK_ID, wanted);
    const original = h.store.transact.bind(h.store);
    let raced = false;
    h.store.transact = async items => {
      if (!raced) {
        raced = true;
        await h.store.update({ key: taskKey(TASK_ID), ops: [change.set("share", { ...share, threadTs: "1695500000.000100" }), change.set("shareVersion", 2)] });
        await h.store.put({ item: { ...sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs: "1695500000.000100" }), entityType: "SHARED_TASK", mode: "continue" } });
      }
      return original(items);
    };
    await shareTask(h.deps, caller, TASK_ID, { requestId: REQUEST_B, shareMode: "view" });
    expect((await taskOf(h)).share).toMatchObject({ threadTs: "1695500000.000100", mode: "view" });
    expect(await h.store.get(sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs: "1695500000.000100" }))).toMatchObject({ mode: "view" });
  });
  it("checks company, owner and script authority and fences a revoked owner", async () => {
    const { h, caller } = await world();
    await expect(shareTask(h.deps, { principal: { ...caller.principal, companyId: "org_other00000000000000" } }, TASK_ID, wanted)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await expect(shareTask(h.deps, { principal: { ...caller.principal, personId: "other", roles: [] } }, TASK_ID, wanted)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    h.deps.access = { ...createOwnerTaskAccess(), ownerActing: async (_p, t) => ({ actorId: t.ownerKey, items: [{ kind: "check", key: { pk: "PROOF", sk: "META" }, condition: when.present() }] }) };
    await expect(shareTask(h.deps, caller, TASK_ID, wanted)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect((await taskOf(h)).shared).toBe(false);
  });
});

it("starts shared tasks with the host's proven share and fails closed if required sharing is unavailable", async () => {
  const h = createHarness();
  await h.registerProject();
  h.deps.taskSharing = { prepare: async (_caller, _project, wanted) => wanted.shareToChannel ? share : undefined };
  const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Add retry", shareToChannel: true, shareMode: "continue", channel: "C0123456789" });
  expect(await h.store.get(taskKey(started.task.taskId))).toMatchObject({ shared: true, share });
  const privateTask = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Add private retry" });
  expect(await h.store.get(taskKey(privateTask.task.taskId))).toMatchObject({ shared: false });
  const required = createHarness();
  await required.registerProject({ ...definition, developerTasks: { ...developerTaskPolicy(definition), share: "required" } });
  await expect(required.flow.start(required.owner, { requestId: randomUUID(), project: "payments", instructions: "Add retry" })).rejects.toMatchObject({ code: "CHANNEL_REQUIRED" });
});
