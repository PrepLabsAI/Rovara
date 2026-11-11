// The session's binding to its ticket, on the document store: one surface follows one session and a session follows one ticket; a repeat is the same; an ended session refuses; another company's session is not found.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, agentSessionKey, change, type SessionBinding, type SessionId } from "@agentx/contracts";
import { bindSessionSurface, sessionBindingsOf, sessionForSurface, unbindSessionSurface } from "../../../packages/broker/src/core/sessions/bindings.js";
import { createTaskSessionItems, taskSessionId } from "../../../packages/broker/src/core/sessions/create.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { RecordingStore } from "../../support/intake-world.js";

const ORG = IMPLICIT_COMPANY_ID;
const NOW = "2026-11-10T10:00:00.000Z";
const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";
const TICKET: SessionBinding = { kind: "tracker_item", system: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/refunds" };
const deps = (store: RecordingStore) => ({ store, now: () => Date.parse(NOW) });

async function session(store: RecordingStore, taskId: string): Promise<SessionId> {
  const sessionId = taskSessionId(taskId);
  const result = await store.transact(createTaskSessionItems({ orgId: ORG, sessionId, taskId, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: "draft" }, title: "A task", owner: localOwnerPrincipal(), origin: "app", payer: { kind: "member", developerId: "a".repeat(64) }, now: NOW }));
  expect(result.applied).toBe(true);
  return sessionId;
}

describe("binding a session to its ticket", () => {
  it("binds once, answers a repeat as the same, and the session is found from the ticket", async () => {
    const store = new RecordingStore();
    const sessionId = await session(store, TASK_A);
    expect(await bindSessionSurface(deps(store), { orgId: ORG, sessionId, binding: TICKET })).toBe("bound");
    expect(await bindSessionSurface(deps(store), { orgId: ORG, sessionId, binding: TICKET })).toBe("already_bound");
    expect((await sessionForSurface(store, ORG, TICKET))?.sessionId).toBe(sessionId);
    expect(await sessionBindingsOf(store, ORG, sessionId)).toEqual([TICKET]);
  });

  it("refuses a ticket that follows another session, and a second ticket on one session", async () => {
    const store = new RecordingStore();
    const first = await session(store, TASK_A);
    const second = await session(store, TASK_B);
    await bindSessionSurface(deps(store), { orgId: ORG, sessionId: first, binding: TICKET });
    await expect(bindSessionSurface(deps(store), { orgId: ORG, sessionId: second, binding: TICKET })).rejects.toThrow(/already follows another session/u);
    await expect(bindSessionSurface(deps(store), { orgId: ORG, sessionId: first, binding: { ...TICKET, id: "ENG-2", url: "https://linear.app/acme/issue/ENG-2/x" } })).rejects.toThrow(/already follows another/u);
  });

  it("is one surface whichever way a Linear issue is named (the tracker item and the Linear issue share one item)", async () => {
    const store = new RecordingStore();
    const first = await session(store, TASK_A);
    const second = await session(store, TASK_B);
    await bindSessionSurface(deps(store), { orgId: ORG, sessionId: first, binding: TICKET });
    await expect(bindSessionSurface(deps(store), { orgId: ORG, sessionId: second, binding: { kind: "linear_issue", issueId: "ENG-1", url: TICKET.kind === "tracker_item" ? TICKET.url : "" } })).rejects.toThrow(/already follows another session/u);
  });

  it("refuses a missing session, another company's session and an ended one", async () => {
    const store = new RecordingStore();
    const sessionId = await session(store, TASK_A);
    await expect(bindSessionSurface(deps(store), { orgId: ORG, sessionId: taskSessionId(TASK_B), binding: TICKET })).rejects.toThrow(/not found/u);
    await expect(bindSessionSurface(deps(store), { orgId: "org_zzzzzzzzzzzzzzzzzzzz", sessionId, binding: TICKET })).rejects.toThrow(/not found/u);
    await store.update({ key: agentSessionKey(ORG, sessionId, "META"), ops: [change.set("endedAt", NOW)] });
    await expect(bindSessionSurface(deps(store), { orgId: ORG, sessionId, binding: TICKET })).rejects.toThrow(/has ended/u);
  });

  it("lets a session go of its ticket, and the ticket follows no session then; a tampered surface item reads as unbound", async () => {
    const store = new RecordingStore();
    const sessionId = await session(store, TASK_A);
    await bindSessionSurface(deps(store), { orgId: ORG, sessionId, binding: TICKET });
    expect(await unbindSessionSurface(store, { orgId: ORG, sessionId, kind: "tracker_item" })).toMatchObject({ result: "unbound" });
    expect(await sessionForSurface(store, ORG, TICKET)).toBeUndefined();
    expect(await unbindSessionSurface(store, { orgId: ORG, sessionId, kind: "tracker_item" })).toEqual({ result: "not_bound" });
    expect(await sessionBindingsOf(store, ORG, sessionId)).toEqual([]);
  });
});
