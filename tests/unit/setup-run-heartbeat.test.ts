// L4-T5: a live setup worker talks to the broker every few seconds (its `poll`). The broker notes the time on the run's own task, at most once a minute, so a dead worker reads as stopped after 10 silent
// minutes and not after 26 hours (`readState`, tested against the checklist in project-setup-status-routes.test.ts). The note is best effort, company-scoped, and written only for a run that is going.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { SETUP_RUN_SEEN_EVERY_MS, handleSetupAgentCallback } from "../../packages/broker/src/core/setup-agent/callback.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { taskKey } from "../../packages/broker/src/developer/task-records.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId;
const B = COMPANY_B.orgId;
const START = Date.parse("2026-11-18T08:00:00.000Z");

async function run(companyId: string, store = new MemoryDocumentStore()) {
  const workspaceId = randomUUID(); const taskId = randomUUID();
  await store.put({ item: { ...workspaceKey(companyId, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId } });
  await store.put({ item: { ...(await workspaceKeys({ store, companyId }, workspaceId)).taskPointerKey(), taskId } });
  await store.put({ item: { ...taskKey(taskId), taskId, workspaceId, project: "demo", companyId, purpose: "setup_agent" } });
  const operation = { kind: "task", workflowMode: "SETUP_AGENT", status: "RUNNING", workspaceId, companyId };
  const clock = { now: START };
  const poll = (as = companyId, op: object = operation) => handleSetupAgentCallback({ store, companyId: as, now: () => clock.now }, op as never, { kind: "poll" });
  const seen = async () => (await store.get(taskKey(taskId)))?.["setupAgentSeenAt"];
  return { store, clock, poll, seen, taskId, operation, workspaceId };
}

describe("the worker's poll is noted on the run's task (L4-T5)", () => {

  it("every kind of word from a live worker is noted (journal, host, command_done, eval_discovery refused or not), and a bare 'alive' only notes and answers nothing", async () => {
    const r = await run(A);
    const send = (body: unknown) => handleSetupAgentCallback({ store: r.store, companyId: A, now: () => r.clock.now }, r.operation, body);
    await expect(send({ kind: "alive" })).resolves.toEqual({});
    expect(await r.seen()).toBe(new Date(START).toISOString());
    r.clock.now = START + SETUP_RUN_SEEN_EVERY_MS;
    await send({ kind: "command_done", seq: 1 });
    expect(await r.seen()).toBe(new Date(START + SETUP_RUN_SEEN_EVERY_MS).toISOString());
    r.clock.now = START + 2 * SETUP_RUN_SEEN_EVERY_MS;
    await expect(send({ kind: "eval_discovery", report: { nonsense: true } })).rejects.toThrow();
    expect(await r.seen()).toBe(new Date(START + 2 * SETUP_RUN_SEEN_EVERY_MS).toISOString());
    // Anything that is not one of the shapes is refused before it can note anything.
    r.clock.now = START + 3 * SETUP_RUN_SEEN_EVERY_MS;
    await expect(send({ kind: "alive", extra: true })).rejects.toThrow(/not one of its shapes/u);
    expect(await r.seen()).toBe(new Date(START + 2 * SETUP_RUN_SEEN_EVERY_MS).toISOString());
  });

  it("a store that cannot write the note does not fail the poll", async () => {
    const r = await run(A);
    const update = r.store.update.bind(r.store);
    r.store.update = async () => { throw new Error("the table is busy"); };
    await expect(r.poll()).resolves.toMatchObject({ hosts: [] });
    r.store.update = update;
  });

  it("company isolation: another company's poll never notes, or reads, this company's task, and each company's task is noted on its own", async () => {
    const store = new MemoryDocumentStore();
    const a = await run(A, store);
    const b = await run(B, store);
    // B's operation is read as B's; the same operation under A's callback is refused and writes nothing.
    await expect(a.poll(B, a.operation)).rejects.toThrow(/limited to a running setup run/u);
    expect(await a.seen()).toBeUndefined();
    b.clock.now = START + 5 * SETUP_RUN_SEEN_EVERY_MS;
    await b.poll();
    expect(await b.seen()).toBe(new Date(START + 5 * SETUP_RUN_SEEN_EVERY_MS).toISOString());
    expect(await a.seen()).toBeUndefined();
    await a.poll();
    expect(await a.seen()).toBe(new Date(START).toISOString());
  });

  it("a task that is gone is not made again by a late poll", async () => {
    const r = await run(A);
    await r.store.delete({ key: taskKey(r.taskId) });
    // The run is no longer a setup run of this company (its task is gone): refused, and no row appears.
    await expect(r.poll()).rejects.toThrow(/limited to a running setup run/u);
    expect(await r.store.get(taskKey(r.taskId))).toBeUndefined();
  });
});
