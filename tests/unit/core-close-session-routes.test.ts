import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { agentSessionKey, change, when, type StoredDocument, type TransactItem } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { taskKey, workspaceKey, operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { createTaskSessionItems, developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { createSessionRoutes } from "../../packages/broker/src/local/app/session-routes.js";
import { createLocalSessionControl } from "../../packages/broker/src/local/app/host.js";
import { handleTaskRoute } from "../../packages/broker/src/core/task-flow/routes.js";

async function fixture(discard = true) {
  const h = createHarness({ audit: "recording" }); await h.registerProject();
  // This fixture isolates acceptance; recovery is exercised in core-close-recovery.test.ts.
  h.deps.resumeAcceptedClose = async () => {};
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "close session" });
  const tk = taskKey(task.taskId), wk = workspaceKey(h.deps.companyId, task.workspaceId);
  const ws = (await h.store.get(wk))!;
  if (typeof ws.activeOperationId !== "string") throw new Error("missing holder");
  const op = operationKey(h.deps.companyId, task.workspaceId, ws.activeOperationId);
  await h.store.update({ key: op, ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
  const sessionId = taskSessionId(task.taskId), sk = agentSessionKey(h.deps.companyId, sessionId, "META");
  await h.store.transact(createTaskSessionItems({ orgId: h.deps.companyId, sessionId, taskId: task.taskId, project: "payments", agent: { agentId: "rovara-code", name: "Code", version: 1 }, title: "close session", owner: h.owner.principal, origin: "app", payer: { kind: "member", developerId: developerIdOf(h.owner.principal) }, now: task.createdAt }));
  await h.store.update({ key: tk, ops: [change.set("sessionId", sessionId)] });
  const inspect = vi.fn(async () => ({ inspection: { safeToClose: !discard, repositories: discard ? [{ name: "demo", reasons: ["untracked_files"] }] : [], contentDigest: "a".repeat(64) }, retentionId: "retained" }));
  h.deps.closeInspection = { async raiseFence() {}, inspectWorkspaceForClose: inspect, async retained() { return true; } };
  expect(await prepareCloseInspection(h.deps, task.workspaceId, ws.activeOperationId)).toBe(true);
  const preview = await h.flow.previewClose(h.owner, task.taskId, discard ? "discard" : "close");
  if (preview.preview === null) throw new Error("missing preview");
  const input = { requestId: randomUUID(), expectedPreviewDigest: preview.preview.digest, discard_unpublished: discard };
  const refresh = vi.fn(async () => undefined), terminate = vi.spyOn(h.machines, "terminate");
  const holds = vi.fn(async () => undefined); h.deps.moneyStop = { flushWaitMs: 0 };
  // These routes never read a blob for this fixture's task, which has no model output.
  const route = createSessionRoutes({ flow: h.flow, companyId: h.deps.companyId, blobs: {} as never, origin: () => "http://local", refresh });
  const sessionPath = `/v1/app/sessions/${sessionId}/close`, devPath = `/v1/dev/tasks/${task.taskId}/close`;
  const session = async (body: unknown = input, method = "POST", query = "", caller = h.owner) => {
    const result = await route({ method, path: sessionPath + query, headers: {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, caller);
    return { status: result?.statusCode, body: result === undefined ? undefined : JSON.parse(result.body) as unknown };
  };
  const dev = (body: unknown = input, method = "POST", query = "") => handleTaskRoute(h.flow, { method, path: devPath + query, caller: h.owner, body: JSON.stringify(body) });
  const snapshot = async () => (await (h.store as MemoryDocumentStore).scanPage({ limit: 1000 })).items.sort((a, b) => `${a.pk}/${a.sk}`.localeCompare(`${b.pk}/${b.sk}`));
  const transact = h.store.transact.bind(h.store); let writes = 0;
  h.store.transact = async (items) => { const result = await transact(items); if (result.applied) writes += items.filter((i) => i.kind !== "check").length; return result; };
  return { h, task, tk, wk, sk, op, input, preview, sessionId, session, dev, snapshot, inspect, refresh, terminate, holds, writes: () => writes };
}
type World = Awaited<ReturnType<typeof fixture>>;
function assertNoEffects(w: World) { expect(w.terminate).not.toHaveBeenCalled(); expect(w.holds).not.toHaveBeenCalled(); expect(w.refresh).not.toHaveBeenCalled(); }

// Removing transport forwarding, a preview predicate or the atomic session receipt must make these fail.
describe("P3 session and developer close transport", () => {
  for (const surface of ["session", "dev"] as const) {
    for (const discard of [false, true]) {
      it(`${surface}: stale ${discard ? "discard" : "close"} writes nothing`, async () => {
        const w = await fixture(discard), before = await w.snapshot();
        expect(await w[surface]({ ...w.input, expectedPreviewDigest: "0".repeat(64) })).toMatchObject({ status: 409, body: { error: { code: "CHANGE_STALE" } } });
        expect(await w.snapshot()).toEqual(before); expect(w.writes()).toBe(0); assertNoEffects(w);
      });
      it(`${surface}: matching ${discard ? "discard" : "close"} accepts once, replay checks immutable intent`, async () => {
        const w = await fixture(discard);
        const result = await w[surface](); expect(result?.status).toBe(200);
        if (surface === "session") expect(result?.body).toMatchObject({ closed: false });
        const before = await w.snapshot(), writes = w.writes();
        expect(before.filter((r) => r.entityType === "AGENT_SESSION_REQUEST")).toHaveLength(1);
        expect(before.filter((r) => r.entityType === "AGENT_SESSION_EVENT" && r.text === "Local owner requested close.")).toHaveLength(1);
        expect(before.filter((r) => r.entityType === "AUDIT" && r.action === "session.close_requested")).toHaveLength(1);
        expect(before.filter((r) => r.entityType === "AUDIT" && r.action === "session.closed")).toHaveLength(0);
        expect((await w[surface]())?.status).toBe(200); expect(await w.snapshot()).toEqual(before); expect(w.writes()).toBe(writes);
        for (const changed of [{ expectedPreviewDigest: "b".repeat(64) }, { discard_unpublished: !discard }]) {
          expect(await w[surface]({ ...w.input, ...changed })).toMatchObject({ status: 409, body: { error: { code: "IDEMPOTENCY_CONFLICT" } } });
        }
        expect(await w.snapshot()).toEqual(before); expect(w.terminate).not.toHaveBeenCalled(); expect(w.holds).not.toHaveBeenCalled();
      });
    }
    it(`${surface}: preview GET is read only and requires an action`, async () => {
      const w = await fixture(), before = await w.snapshot(), inspections = w.inspect.mock.calls.length;
      expect(await w[surface](undefined, "GET", "?action=discard")).toMatchObject({ status: 200, body: w.preview });
      expect(await w[surface](undefined, "GET", "?action=invalid")).toMatchObject({ status: 400 });
      expect(await w[surface](undefined, "GET")).toMatchObject({ status: 400 });
      expect(await w.snapshot()).toEqual(before); expect(w.inspect).toHaveBeenCalledTimes(inspections); assertNoEffects(w);
    });
    for (const pin of [null, "", "A".repeat(64)]) it(`${surface}: malformed digest ${String(pin).slice(0, 4)} never falls back`, async () => {
      const w = await fixture(), before = await w.snapshot();
      expect(await w[surface]({ ...w.input, expectedPreviewDigest: pin })).toMatchObject({ status: 400 });
      expect(await w.snapshot()).toEqual(before); assertNoEffects(w);
    });
  }
  for (const [label, key, ops] of [
    ["lifecycle", "wk", [change.set("status", "STOPPED")]],
    ["inspection content", "op", [change.set("result.closeInspection.contentDigest", "b".repeat(64))]],
    ["session owner", "sk", [change.set("owner.name", "Changed")]],
  ] as const) it(`session: ${label} drift at commit refuses with no receipt or effects`, async () => {
    const w = await fixture(), transact = w.h.store.transact.bind(w.h.store); let after: StoredDocument[] = [], injected = false;
    w.h.store.transact = async (items: readonly TransactItem[]) => {
      if (!injected && items.some((i) => i.kind === "update" && i.key.pk === w.tk.pk)) { injected = true; await w.h.store.update({ key: w[key], ops }); after = await w.snapshot(); }
      return transact(items);
    };
    expect(await w.session()).toMatchObject({ status: 409, body: { error: { code: "CHANGE_STALE" } } });
    expect(injected).toBe(true); expect(await w.snapshot()).toEqual(after); expect(w.writes()).toBe(0); assertNoEffects(w);
  });
  it("session: camel-case bridge flag maps identically, conflicting spellings are refused", async () => {
    const w = await fixture();
    expect(await w.session({ ...w.input, discardUnpublished: false })).toMatchObject({ status: 400 });
    const { discard_unpublished: _discard, ...input } = w.input; void _discard;
    expect((await w.session({ ...input, discardUnpublished: true })).status).toBe(200);
    expect(await w.h.store.get(w.tk)).toHaveProperty("closeOperationId");
  });
  it("session: exact concurrent requests share one acceptance; no-pin replay cannot bypass intent", async () => {
    const w = await fixture();
    expect((await Promise.all([w.session(), w.session()])).map((r) => r.status)).toEqual([200, 200]);
    const before = await w.snapshot();
    expect(await w.session({ requestId: w.input.requestId })).toMatchObject({ status: 409 });
    expect(await w.snapshot()).toEqual(before);
    expect(before.filter((r) => r.closeAcceptance !== undefined)).toHaveLength(1);
  });
  it("session: company/role refusals precede guarded and preview operations", async () => {
    const w = await fixture(), before = await w.snapshot();
    for (const principal of [{ ...w.h.owner.principal, companyId: "org_11111111111111111111" }, { ...w.h.owner.principal, roles: ["collaborator" as const] }]) {
      const caller = { ...w.h.owner, principal };
      for (const method of ["POST", "GET"]) expect((await w.session(w.input, method, method === "GET" ? "?action=discard" : "", caller)).status).toBe(404);
    }
    expect(await w.snapshot()).toEqual(before); assertNoEffects(w);
  });
  it("control commits acceptance and receipt before host resume, including replay", async () => {
    const w = await fixture(), control = createLocalSessionControl(w.h.deps);
    const resumed = vi.fn(async () => {
      const rows = await w.snapshot();
      expect(rows.some((r) => r.closeAcceptance !== undefined)).toBe(true);
      expect(rows.some((r) => r.entityType === "AGENT_SESSION_REQUEST" && r.requestId === w.input.requestId)).toBe(true);
      expect(rows.some((r) => r.entityType === "OUTBOX" && (r.body as { resumeClose?: unknown }).resumeClose === true)).toBe(true);
    });
    Object.assign(w.h.deps, { resumeAcceptedClose: resumed });
    expect(await control.close(w.h.owner.principal, w.h.deps.companyId, w.sessionId, w.input)).toMatchObject({ status: "done", repeated: false });
    expect(await control.close(w.h.owner.principal, w.h.deps.companyId, w.sessionId, w.input)).toMatchObject({ status: "done", repeated: true });
    expect(resumed).toHaveBeenCalledTimes(2);
  });
  for (const surface of ["session", "dev"] as const) it(`${surface}: absent digest keeps legacy close without an acceptance record`, async () => {
    const w = await fixture();
    expect((await w[surface]({ requestId: randomUUID() }))?.status).toBe(200);
    expect(await w.h.store.get(w.tk)).toHaveProperty("closedAt");
    expect((await w.snapshot()).some((r) => r.closeAcceptance !== undefined)).toBe(false);
  });
  for (const surface of ["session", "dev"] as const) it(`${surface}: resume failure returns durable acceptance and an exact retry succeeds`, async () => {
    const w = await fixture();
    Object.assign(w.h.deps, { resumeAcceptedClose: async () => { throw new Error("resume unavailable"); } });
    expect(await w[surface]()).toMatchObject({ status: 200, body: surface === "session" ? { closed: false } : { task: { closing: true } } });
    const before = await w.snapshot();
    expect(before.some((r) => r.closeAcceptance !== undefined)).toBe(true);
    expect(await w[surface]()).toMatchObject({ status: 200, body: surface === "session" ? { closed: false } : { task: { closing: true } } });
    expect(await w.snapshot()).toEqual(before); assertNoEffects(w);
    expect(await w[surface]({ ...w.input, requestId: randomUUID() })).toMatchObject({ status: 409, body: { error: { code: "CHANGE_STALE" } } });
  });
  it("session: mismatched task session refuses a valid fresh preview with zero writes", async () => {
    const w = await fixture();
    // Obtain fresh consent AFTER drift, so only the session-to-task check can reject it.
    const otherSession = taskSessionId(randomUUID());
    await w.h.store.transact(createTaskSessionItems({ orgId: w.h.deps.companyId, sessionId: otherSession, taskId: w.task.taskId, project: "payments", agent: { agentId: "rovara-code", name: "Code", version: 1 }, title: "other valid session", owner: w.h.owner.principal, origin: "app", payer: { kind: "member", developerId: developerIdOf(w.h.owner.principal) }, now: w.task.createdAt }));
    await w.h.store.update({ key: w.tk, ops: [change.set("sessionId", otherSession)] });
    const preview = await w.h.flow.previewClose(w.h.owner, w.task.taskId, "discard");
    if (preview.preview === null) throw new Error("missing fresh preview");
    const before = await w.snapshot(), writes = w.writes();
    expect(await w.session({ ...w.input, expectedPreviewDigest: preview.preview.digest })).toMatchObject({ status: 409, body: { error: { code: "CHANGE_STALE" } } });
    expect(await w.snapshot()).toEqual(before); expect(w.writes()).toBe(writes); assertNoEffects(w);
  });
  it("concurrent replay resumes the persisted winner's original deadline", async () => {
    const w = await fixture(), transact = w.h.store.transact.bind(w.h.store); let injected = false;
    const resumed: unknown[] = [];
    Object.assign(w.h.deps, { resumeAcceptedClose: async (operation: unknown) => { resumed.push(operation); } });
    w.h.store.transact = async (items) => {
      if (!injected && items.some((i) => i.kind === "update" && i.key.pk === w.tk.pk)) {
        injected = true; w.h.clock.advance(1); expect((await w.session()).status).toBe(200);
      }
      return transact(items);
    };
    expect((await w.session()).status).toBe(200); expect(resumed).toHaveLength(2);
    expect(resumed[0]).toEqual(resumed[1]);
  });
  it("session: denied live host authority at acceptance leaves zero committed writes", async () => {
    const w = await fixture(), key = { pk: "MEMBER#live", sk: "META" };
    await w.h.store.put({ item: { ...key, role: "member" } });
    w.h.deps.access.ownerActing = async () => ({ actorId: w.h.owner.principal.personId, items: [{ kind: "check", key, condition: when.eq("role", "owner") }] });
    const before = await w.snapshot(); expect(await w.session()).toMatchObject({ status: 409 });
    expect(await w.snapshot()).toEqual(before); expect(w.writes()).toBe(0); assertNoEffects(w);
  });
});
