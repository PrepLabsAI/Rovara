// Engine host (lane E2): a step's fence that trips is retried, never dropped silently. The store wrapper (core-host/step-fence.ts) throws a retryable error for a transaction that failed on a
// marked fence item. Ported from the monolith's step-fence unit cases; the flow-level cases there run over its people adapter and move with lane T.
import { describe, expect, it } from "vitest";
import { when, type TransactItem } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { STEP_FENCE_TRIPPED_WORDS, createCoreHostApp, isStepFence, markStepFence, retryOnFenceTrip } from "../../packages/broker/src/core-host/index.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";

const failing = (key: { pk: string; sk: string }): Extract<TransactItem, { kind: "check" }> => ({ kind: "check", key, condition: when.eq("revision", 99) });

describe("retryOnFenceTrip", () => {
  it("a transaction that failed on a marked fence item is thrown as retryable; one that failed on anything else is returned as it was; an applied one is untouched", async () => {
    const store = retryOnFenceTrip(new MemoryDocumentStore());
    await store.put({ item: { pk: "A", sk: "1", revision: 1 } });
    const fence = markStepFence([failing({ pk: "A", sk: "1" })]);
    expect(isStepFence(fence[0]!)).toBe(true);
    await expect(store.transact([{ kind: "put", item: { pk: "B", sk: "1" } }, ...fence])).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: expect.stringContaining(STEP_FENCE_TRIPPED_WORDS) as string });
    // Nothing was written by the failed transaction.
    expect(await store.get({ pk: "B", sk: "1" })).toBeUndefined();
    // The same condition, unmarked, is the store's own answer (a lost race the flow reads for itself).
    expect(await store.transact([failing({ pk: "A", sk: "1" })])).toMatchObject({ applied: false });
    expect(await store.transact(markStepFence([{ kind: "check", key: { pk: "A", sk: "1" }, condition: when.eq("revision", 1) }]))).toMatchObject({ applied: true });
  });

  it("is one wrapper per store, and every other call is the store's own", async () => {
    const base = new MemoryDocumentStore();
    expect(retryOnFenceTrip(base)).toBe(retryOnFenceTrip(base));
    await retryOnFenceTrip(base).put({ item: { pk: "C", sk: "1" } });
    expect(await base.get({ pk: "C", sk: "1" })).toBeDefined();
  });

  it("the core runtime's flow stores through the wrapper", async () => {
    const world = createFakeWorld();
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(),
      runtime: () => ({
        callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }),
        now: () => new Date(world.clock.now), log: () => undefined,
        services: () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } }),
        ciReporting: { honest: true, ciMode: () => "their_ci_fix" },
      }),
    });
    const { flow } = await app.runtimeFor(FAKE_COMPANY);
    await world.store.put({ item: { pk: "A", sk: "1", revision: 1 } });
    await expect(flow.deps.store.transact(markStepFence([failing({ pk: "A", sk: "1" })]))).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });
});
