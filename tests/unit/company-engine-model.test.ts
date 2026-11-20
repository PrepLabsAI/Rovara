// Guided onboarding PR 14 (DEC 254n item 1): the per-company engine model in the core (core-host/company-engine-model.ts) and its task-start refusal (TaskFlowDeps.startModelCheck).
// Two companies on one store throughout: A sets its own model; B's tasks still resolve the install default and B's start never reads the gateway for A.
import { describe, expect, it, vi } from "vitest";
import { ENGINE_MODEL_NOT_OFFERED, ENGINE_MODEL_UNCHECKED, type OrgId } from "@agentx/contracts";
import {
  COMPANY_ENGINE_MODEL_UNREADABLE, companyEngineModelKey, companyEngineModelStartCheck, installEngineModel, readCompanyEngineModel,
} from "../../packages/broker/src/core-host/company-engine-model.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { offeredAnswer } from "../support/offered-models-fake.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId;
const B = COMPANY_B_ID as OrgId;
const row = (companyId: string, model: string, extra: Record<string, unknown> = {}) => ({ ...companyEngineModelKey(companyId), entityType: "COMPANY_ENGINE_MODEL", orgId: companyId, version: 1, model, updatedAt: "2026-11-17T00:00:00.000Z", updatedBy: "d".repeat(64), ...extra });

describe("the company's engine model setting", () => {

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
    await expect(readCompanyEngineModel(new MemoryDocumentStore(), "ORG#x")).rejects.toThrow(COMPANY_ENGINE_MODEL_UNREADABLE);
  });

  it("the install default is ROVARA_CORE_AGENT_MODEL with its gateway, else none", () => {
    expect(installEngineModel({ ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example.test", ROVARA_CORE_AGENT_MODEL: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(installEngineModel({})).toBeUndefined();
    expect(installEngineModel({ ROVARA_CORE_AGENT_MODEL: "claude-sonnet-5-5" })).toBeUndefined();
  });
});

describe("the start check", () => {
  const reader = (lists: Record<string, string[]>) => vi.fn(async (companyId: OrgId) => {
    const list = lists[companyId];
    if (list === undefined) throw new Error("https://gateway.internal refused");
    return offeredAnswer(list);
  });

  it("a company model the gateway offers THAT company now: let through (asked for that company only)", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: row(A, "zai.glm-5") });
    const offered = reader({ [A]: ["claude-sonnet-5-5", "zai.glm-5"], [B]: ["claude-sonnet-5-5"] });
    expect(await companyEngineModelStartCheck({ store, companyId: A, offered })()).toBeUndefined();
    expect(offered.mock.calls).toEqual([[A]]);
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
});
