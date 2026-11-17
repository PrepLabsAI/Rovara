// Guided onboarding PR 14 (DEC 254n item 1): the per-company engine model in the core (core-host/company-engine-model.ts) and its task-start refusal (TaskFlowDeps.startModelCheck).
// Two companies on one store throughout: A sets its own model; B's tasks still resolve the install default and B's start never reads the gateway for A.
import { describe, expect, it, vi } from "vitest";
import { ENGINE_MODEL_NOT_OFFERED, ENGINE_MODEL_UNCHECKED, type OrgId } from "@agentx/contracts";
import {
  COMPANY_ENGINE_MODEL_UNREADABLE, companyEngineModelKey, companyEngineModelRoute, companyEngineModelStartCheck, installEngineModel, readCompanyEngineModel,
} from "../../packages/broker/src/core-host/company-engine-model.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { offeredAnswer } from "../support/offered-models-fake.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId;
const B = COMPANY_B_ID as OrgId;
const INSTALL = { alias: "claude-sonnet-5-5", api: "anthropic-messages" as const, catalog: "claude-sonnet-5-5" };
const install = { route: async () => ({ ...INSTALL }) };
const row = (companyId: string, model: string, extra: Record<string, unknown> = {}) => ({ ...companyEngineModelKey(companyId as OrgId), entityType: "COMPANY_ENGINE_MODEL", orgId: companyId, version: 1, model, updatedAt: "2026-11-17T00:00:00.000Z", updatedBy: "d".repeat(64), ...extra });

describe("the company's engine model setting", () => {
  it("lives under the company's own key, and is absent until the company sets one", async () => {
    const store = new MemoryDocumentStore();
    expect(companyEngineModelKey(A)).toEqual({ pk: `ORG#${A}#SETTINGS`, sk: "ENGINE_MODEL" });
    expect(await readCompanyEngineModel(store, A)).toBeUndefined();
    await store.put({ item: row(A, "zai.glm-5") });
    expect(await readCompanyEngineModel(store, A)).toBe("zai.glm-5");
    expect(await readCompanyEngineModel(store, B)).toBeUndefined();
  });

  it.each([
    ["another company's id in the row", { orgId: B }],
    ["another entity type", { entityType: "MODEL_SELECTION_POLICY" }],
    ["another version", { version: 2 }],
    ["a malformed model", { model: "has space" }],
    ["a Claude name that is not an engine name", { model: "anthropic-claude" }],
    ["a model that is not a string", { model: 7 }],
  ])("refuses a row with %s (fail closed, never the install default)", async (_label, extra) => {
    const store = new MemoryDocumentStore();
    await store.put({ item: row(A, "zai.glm-5", extra) });
    await expect(readCompanyEngineModel(store, A)).rejects.toThrow(COMPANY_ENGINE_MODEL_UNREADABLE);
  });

  it("refuses a read that fails, and a company id that is not one", async () => {
    await expect(readCompanyEngineModel({ get: async () => { throw new Error("db host down"); } }, A)).rejects.toThrow(COMPANY_ENGINE_MODEL_UNREADABLE);
    await expect(readCompanyEngineModel(new MemoryDocumentStore(), "ORG#x" as OrgId)).rejects.toThrow(COMPANY_ENGINE_MODEL_UNREADABLE);
  });

  it("the install default is ROVARA_CORE_AGENT_MODEL with its gateway, else none", () => {
    expect(installEngineModel({ ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(installEngineModel({})).toBeUndefined();
    expect(installEngineModel({ ROVARA_CORE_AGENT_MODEL: "claude-sonnet-5-5" })).toBeUndefined();
  });
});

describe("the company's route (what each step is dispatched on and the task token names)", () => {
  it("GOLDEN: a company without its own model gets the install's route, exactly", async () => {
    const store = new MemoryDocumentStore();
    const route = companyEngineModelRoute({ store, companyId: B, install });
    expect(await route.route()).toStrictEqual(await install.route());
    expect(JSON.stringify(await route.route())).toBe(JSON.stringify(await install.route()));
    const none = companyEngineModelRoute({ store, companyId: B, install: { route: async () => undefined } });
    expect(await none.route()).toBeUndefined();
  });

  it("two companies: A's own model is A's route only; B still resolves the install default", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: row(A, "zai.glm-5") });
    expect(await companyEngineModelRoute({ store, companyId: A, install }).route()).toStrictEqual({ alias: "zai.glm-5", api: "anthropic-messages", catalog: "zai.glm-5" });
    expect(await companyEngineModelRoute({ store, companyId: B, install }).route()).toStrictEqual(INSTALL);
  });

  it("an unreadable setting gives no route (throws), never the install's in its place", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: row(A, "zai.glm-5", { orgId: B }) });
    await expect(companyEngineModelRoute({ store, companyId: A, install }).route()).rejects.toThrow(COMPANY_ENGINE_MODEL_UNREADABLE);
  });
});

describe("the start check", () => {
  const reader = (lists: Record<string, string[]>) => vi.fn(async (companyId: OrgId) => {
    const list = lists[companyId];
    if (list === undefined) throw new Error("https://gateway.internal refused");
    return offeredAnswer(list);
  });

  it("GOLDEN: a company without its own model is let through and the gateway is never asked", async () => {
    const offered = reader({});
    expect(await companyEngineModelStartCheck({ store: new MemoryDocumentStore(), companyId: B, offered })()).toBeUndefined();
    expect(offered).not.toHaveBeenCalled();
  });

  it("a company model the gateway offers THAT company now: let through (asked for that company only)", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: row(A, "zai.glm-5") });
    const offered = reader({ [A]: ["claude-sonnet-5-5", "zai.glm-5"], [B]: ["claude-sonnet-5-5"] });
    expect(await companyEngineModelStartCheck({ store, companyId: A, offered })()).toBeUndefined();
    expect(offered.mock.calls).toEqual([[A]]);
  });

  it("a company model the gateway does not offer: refused with 'pick another model', naming no model", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: row(A, "zai.glm-5") });
    // Offered to B, not to A: A's own list is what counts.
    const refusal = await companyEngineModelStartCheck({ store, companyId: A, offered: reader({ [A]: ["claude-sonnet-5-5"], [B]: ["zai.glm-5"] }) })();
    expect(refusal).toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(ENGINE_MODEL_NOT_OFFERED) as string });
    expect(refusal!.message.toLowerCase()).toContain("pick another model");
    expect(refusal!.message).not.toContain("glm");
  });

  it.each([
    ["the read fails", (async () => { throw new Error("https://gateway.internal 500"); }) as never],
    ["the answer is not the contract", (async () => ({ version: 2, models: [] })) as never],
    ["no reader is wired", undefined],
  ])("refused (fixed words, never a guess) when %s", async (_label, offered) => {
    const store = new MemoryDocumentStore();
    await store.put({ item: row(A, "zai.glm-5") });
    const refusal = await companyEngineModelStartCheck({ store, companyId: A, offered })();
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(ENGINE_MODEL_UNCHECKED) as string });
    expect(refusal!.message).not.toMatch(/gateway\.internal|500|glm/u);
  });

  it("an unreadable setting refuses too", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: row(A, "zai.glm-5", { orgId: B }) });
    const offered = reader({ [A]: ["zai.glm-5"] });
    expect(await companyEngineModelStartCheck({ store, companyId: A, offered })()).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(offered).not.toHaveBeenCalled();
  });
});

describe("a task start (the core's startTask with the check wired)", () => {
  /** Two companies' flows on one store, as a deployment has; each with its own check. */
  function world(lists: Record<string, string[] | undefined>) {
    const shared = { store: undefined as MemoryDocumentStore | undefined, queues: undefined as MemoryQueueService | undefined };
    const backend = (clock: { now: number }) => {
      shared.store ??= new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(clock.now / 1_000) });
      shared.queues ??= new MemoryQueueService({ now: () => clock.now });
      return { store: shared.store, queues: shared.queues };
    };
    const offered = vi.fn(async (companyId: OrgId) => {
      const list = lists[companyId];
      if (list === undefined) throw new Error("down");
      return offeredAnswer(list);
    });
    const harness = (companyId: OrgId) => createHarness({ companyId, backend, audit: "recording", extra: () => ({ startModelCheck: companyEngineModelStartCheck({ store: shared.store!, companyId, offered }) }) });
    const a = harness(A);
    const b = harness(B);
    return { a, b, store: shared.store!, offered };
  }
  const start = (h: ReturnType<typeof createHarness>) => h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint" });

  it("refuses BEFORE start when the gateway doesn't offer A's model: no task, no charge, no machine, nothing queued; the refusal is audited; B (no own model) starts as before", async () => {
    const { a, b, store, offered } = world({ [A]: ["claude-sonnet-5-5"], [B]: ["claude-sonnet-5-5"] });
    await a.registerProject();
    await b.registerProject();
    await store.put({ item: row(A, "zai.glm-5") });
    const before = store.size;
    await expect(start(a)).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(ENGINE_MODEL_NOT_OFFERED) as string });
    // Nothing was written (no task, workspace, charge or idempotency record) and nothing was queued for a machine.
    expect(store.size).toBe(before);
    expect(await a.flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ received: 0 });
    expect(a.machines.answered).toHaveLength(0);
    expect(a.audit.map((event) => event.action)).toEqual(["task.start_refused"]);
    // B: no own model, the gateway is not asked for B, and its task starts.
    await expect(start(b)).resolves.toMatchObject({ duplicate: false });
    expect(offered.mock.calls).toEqual([[A]]);
  });

  it("refuses BEFORE start when the offered list cannot be read (fixed reason)", async () => {
    const { a, store } = world({ [A]: undefined });
    await a.registerProject();
    await store.put({ item: row(A, "zai.glm-5") });
    await expect(start(a)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining(ENGINE_MODEL_UNCHECKED) as string });
    expect(await a.flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ received: 0 });
  });

  it("starts when the gateway offers the company's own model", async () => {
    const { a, store } = world({ [A]: ["claude-sonnet-5-5", "zai.glm-5"] });
    await a.registerProject();
    await store.put({ item: row(A, "zai.glm-5") });
    await expect(start(a)).resolves.toMatchObject({ duplicate: false });
  });

  it("GOLDEN: with no company model, the start's writes are the same as a flow with no check at all", async () => {
    const snapshot = async (withCheck: boolean) => {
      const offered = vi.fn(async () => offeredAnswer(["claude-sonnet-5-5"]));
      let ids = 0;
      const storeRef: { store?: MemoryDocumentStore } = {};
      const h = createHarness({ companyId: B, extra: () => ({ newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, ...(withCheck ? { startModelCheck: companyEngineModelStartCheck({ store: storeRef.store!, companyId: B, offered }) } : {}) }),
        backend: (clock) => { storeRef.store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES, nowSeconds: () => Math.floor(clock.now / 1_000) }); return { store: storeRef.store, queues: new MemoryQueueService({ now: () => clock.now }) }; } });
      await h.registerProject();
      const result = await h.flow.start(h.owner, { requestId: "11111111-1111-4111-8111-111111111111", project: "payments", instructions: "Add a /health endpoint" });
      expect(offered).not.toHaveBeenCalled();
      const rows = [];
      for (let cursor: string | undefined, page = 0; page < 50; page += 1) {
        const scanned = await storeRef.store!.scanPage({ limit: 500, ...(cursor === undefined ? {} : { cursor }) });
        rows.push(...scanned.items);
        cursor = scanned.cursor;
        if (cursor === undefined) break;
      }
      return JSON.stringify({ result, rows });
    };
    expect(await snapshot(true)).toBe(await snapshot(false));
  });
});
