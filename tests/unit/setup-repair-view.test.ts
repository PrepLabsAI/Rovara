// L4-U5: the "Setup needs repair" card as the web reads it, and what the admins' notice reads at delivery. A checked fix waiting for approval turns the one action into "Approve new setup"; a person who may not act gets
// the same words and no action. `readSetupApply` is replaced here (building a real checked candidate needs the whole setup flow, which its own tests cover); the card's own rows are real.
import { describe, expect, it, vi } from "vitest";
import type { OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const apply = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../packages/broker/src/core/setup-agent/apply.js", () => ({ readSetupApply: apply.read }));

const { readSetupBrokenNotice, setupRepairViewOf } = await import("../../packages/broker/src/core/setup-agent/repair-view.js");
const { recheckRowKey, repairNoticeKey } = await import("../../packages/broker/src/core/setup-agent/recheck-rows.js");
const { projectMetaKey } = await import("@agentx/contracts");

const COMPANY = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const OTHER = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const KEY = "a".repeat(48);
const STEP = "setup: npm ci - setup step 0 (npm ci) failed: exit 1";
const check = { workspaceId: "ws-1", revision: 1, startedAt: "2026-11-17T09:00:00.000Z", startedBy: "system" };

async function world(options: { revision?: number; org?: OrgId } = {}) {
  const store = new MemoryDocumentStore();
  const orgId = options.org ?? COMPANY;
  await store.put({ item: { ...projectMetaKey(orgId, "payments"), entityType: "PROJECT_META", setupCheck: check } });
  await store.put({ item: { ...recheckRowKey(orgId, "payments", KEY), entityType: "SETUP_RECHECK", orgId, project: "payments", key: KEY, setupRevision: 1, commits: {}, classes: ["lockfile", "compose"], state: "broken", attempt: 2, check, startedAt: check.startedAt, failedStep: STEP } });
  await store.put({ item: { ...repairNoticeKey(orgId, "payments"), entityType: "SETUP_REPAIR_NOTICE", orgId, project: "payments", key: KEY, failedStep: STEP, classes: ["lockfile", "compose"], at: "2026-11-17T09:05:00.000Z" } });
  const flow = { store, companyId: COMPANY, projects: { latest: async () => ({ definition: { revision: options.revision ?? 1 } }) } };
  return { store, deps: { flow: flow as never, store, companyId: COMPANY, now: () => 0 } };
}
const ready = (over: Record<string, unknown> = {}) => ({ state: "checking", baseRevision: 1, candidateRevision: 2, checkState: { status: "ready" }, ...over });

describe("the card the web reads", () => {
  it("is 'Fix setup' while no fix waits, with what changed in fixed words", async () => {
    apply.read.mockResolvedValue(undefined);
    const w = await world();
    expect(await setupRepairViewOf(w.deps, "payments", { canManage: true })).toEqual({
      title: "Setup needs repair", body: `The project's setup stopped working after recent code changes (${STEP}). Rovara cannot build on this project until it is fixed.`, changed: "dependency files and a compose file",
      at: "2026-11-17T09:05:00.000Z", fixReady: false, actions: [{ id: "fix_setup", label: "Fix setup" }],
    });
  });

  it("is 'Approve new setup' only while a checked fix of the CURRENT setup waits", async () => {
    const w = await world();
    apply.read.mockResolvedValue(ready());
    expect(await setupRepairViewOf(w.deps, "payments", { canManage: true })).toMatchObject({ fixReady: true, actions: [{ id: "approve_new_setup", label: "Approve new setup" }] });
    // Each way a candidate is not this card's checked fix leaves "Fix setup": still checking, failed, decided already, drafted from an older setup, unreadable.
    for (const row of [ready({ checkState: { status: "checking" } }), ready({ checkState: { status: "failed" } }), ready({ state: "approved" }), ready({ baseRevision: 0 })]) {
      apply.read.mockResolvedValue(row);
      expect(await setupRepairViewOf(w.deps, "payments", { canManage: true }), JSON.stringify(row)).toMatchObject({ fixReady: false, actions: [{ id: "fix_setup" }] });
    }
    apply.read.mockRejectedValue(new Error("down"));
    expect(await setupRepairViewOf(w.deps, "payments", { canManage: true })).toMatchObject({ fixReady: false, actions: [{ id: "fix_setup" }] });
  });

  it("gives a person who may not act the same words and no action, even while a fix waits", async () => {
    const w = await world();
    apply.read.mockResolvedValue(ready());
    const reader = await setupRepairViewOf(w.deps, "payments", { canManage: false });
    const manager = await setupRepairViewOf(w.deps, "payments", { canManage: true });
    expect(reader).toMatchObject({ fixReady: true, actions: [] });
    expect({ ...reader, actions: undefined }).toEqual({ ...manager, actions: undefined });
  });

  it("is no card once a newer setup was approved, and never another company's", async () => {
    apply.read.mockResolvedValue(undefined);
    expect(await setupRepairViewOf((await world({ revision: 2 })).deps, "payments", { canManage: true })).toBeUndefined();
    const theirs = await world({ org: OTHER });
    expect(await setupRepairViewOf(theirs.deps, "payments", { canManage: true })).toBeUndefined();
  });
});

describe("what the admins' notice reads at delivery", () => {
  it("answers the re-check's key, the failing step and whether a fix waits; nothing once the setup is not broken", async () => {
    const w = await world();
    apply.read.mockResolvedValue(ready());
    expect(await readSetupBrokenNotice(w.deps, "payments")).toEqual({ key: KEY, failedStep: STEP, fixReady: true });
    apply.read.mockResolvedValue(undefined);
    expect(await readSetupBrokenNotice(w.deps, "payments")).toEqual({ key: KEY, failedStep: STEP, fixReady: false });
    expect(await readSetupBrokenNotice((await world({ revision: 2 })).deps, "payments")).toBeUndefined();
    expect(await readSetupBrokenNotice((await world({ org: OTHER })).deps, "payments")).toBeUndefined();
  });
});
