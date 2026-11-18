// L4-T2b: the one proposal row per project is overwritten by every new candidate, so the setup a person approved earlier is carried on the new row (`earlierApproval`), through a rejection and into the next candidate.
// Tasks keep using the approved revision meanwhile: a rejection deletes the candidate revision and the catalog still names the approved one. Company by company; nothing is carried from a row that was never approved.
import { describe, expect, it } from "vitest";
import { change, orgProjectCatalogKey, projectRevisionKey, when, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { earlierApprovalOf, setupApplyKey, storeSetupCandidate, type SetupApplyDeps, type SetupApplyRow } from "../../packages/broker/src/core/setup-agent/apply.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const OTHER_COMPANY = "org_other00000000000000a";
const base: ProjectDefinition = {
  ...definition,
  setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }],
};
const candidateOf = (revision: number): ProjectDefinition => ({ ...base, revision });

const depsOf = (h: Harness): SetupApplyDeps => ({ flow: h.deps, store: h.store, companyId: h.deps.companyId, now: () => h.clock.now, starter: undefined, latest: async () => undefined } as unknown as SetupApplyDeps);
const rowOf = async (h: Harness): Promise<Record<string, unknown> | undefined> => h.store.get(setupApplyKey(h.deps.companyId, "payments"));
const propose = (h: Harness, baseRevision: number) => storeSetupCandidate(depsOf(h), { project: "payments", by: "local-owner", requestId: newRequestId(), taskId: "", baseRevision, candidate: candidateOf(baseRevision + 1), replyExtra: {}, alsoTransact: [] });

/** What the approval does to the stores (apply.ts): the row is approved and the catalog names the candidate; a rejection deletes the candidate revision. */
async function approve(h: Harness, revision: number, at: string): Promise<void> {
  const key = setupApplyKey(h.deps.companyId, "payments");
  expect((await h.store.transact([
    { kind: "update", key, ops: [change.set("state", "approved"), change.set("decidedAt", at), change.set("decidedBy", "local-owner")], condition: when.eq("state", "checking") },
    { kind: "update", key: orgProjectCatalogKey(h.deps.companyId, "payments"), ops: [change.set("latestRevision", revision)], condition: when.eq("latestRevision", revision - 1) },
  ])).applied).toBe(true);
}
async function reject(h: Harness, revision: number, state: "rejected" | "discarded" = "rejected"): Promise<void> {
  const key = setupApplyKey(h.deps.companyId, "payments");
  expect((await h.store.transact([
    { kind: "update", key, ops: [change.set("state", state), change.set("decidedAt", "2026-11-09T12:00:00.000Z"), change.set("decidedBy", "local-owner")], condition: when.eq("state", "checking") },
    { kind: "delete", key: projectRevisionKey(h.deps.companyId, "payments", revision) },
  ])).applied).toBe(true);
}

async function harnessWithProject(): Promise<Harness> {
  const h = createHarness();
  await h.registerProject(base);
  return h;
}

describe("a new candidate keeps the setup a person approved earlier", () => {
  it("a first candidate carries nothing; after its approval, the next one carries that approval (revision and time)", async () => {
    const h = await harnessWithProject();
    await propose(h, 1);
    expect((await rowOf(h))?.["earlierApproval"]).toBeUndefined();
    await approve(h, 2, "2026-11-09T10:30:00.000Z");
    await propose(h, 2);
    const row = (await rowOf(h)) as unknown as SetupApplyRow;
    expect(row.state).toBe("checking");
    expect(row.candidateRevision).toBe(3);
    expect(row.earlierApproval).toEqual({ revision: 2, at: "2026-11-09T10:30:00.000Z" });
  });

  it("the approval survives a rejection or a discard, and the next candidate after it, however many times", async () => {
    for (const state of ["rejected", "discarded"] as const) {
      const h = await harnessWithProject();
      await propose(h, 1);
      await approve(h, 2, "2026-11-09T10:30:00.000Z");
      await propose(h, 2);
      await reject(h, 3, state);
      expect(((await rowOf(h)) as unknown as SetupApplyRow).earlierApproval, state).toEqual({ revision: 2, at: "2026-11-09T10:30:00.000Z" });
      await propose(h, 2);
      await reject(h, 3, state);
      await propose(h, 2);
      expect(((await rowOf(h)) as unknown as SetupApplyRow).earlierApproval, state).toEqual({ revision: 2, at: "2026-11-09T10:30:00.000Z" });
    }
  });

  it("a later approval replaces the kept one with its own", async () => {
    const h = await harnessWithProject();
    await propose(h, 1);
    await approve(h, 2, "2026-11-09T10:30:00.000Z");
    await propose(h, 2);
    await approve(h, 3, "2026-11-09T11:30:00.000Z");
    await propose(h, 3);
    expect(((await rowOf(h)) as unknown as SetupApplyRow).earlierApproval).toEqual({ revision: 3, at: "2026-11-09T11:30:00.000Z" });
  });

  it("nothing is carried from a project that was never approved, even through a rejection", async () => {
    const h = await harnessWithProject();
    await propose(h, 1);
    await reject(h, 2);
    await propose(h, 1);
    expect((await rowOf(h))?.["earlierApproval"]).toBeUndefined();
  });

  it("what tasks use after the rejection is the approved revision, not the rejected candidate", async () => {
    const h = await harnessWithProject();
    await propose(h, 1);
    await approve(h, 2, "2026-11-09T10:30:00.000Z");
    await h.store.put({ item: { ...projectRevisionKey(h.deps.companyId, "payments", 2), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(candidateOf(2))) as JsonValue } });
    await propose(h, 2);
    expect((await h.deps.projects.latest("payments"))?.definition.revision).toBe(2);
    await reject(h, 3);
    expect((await h.deps.projects.latest("payments"))?.definition.revision).toBe(2);
    expect(((await rowOf(h)) as unknown as SetupApplyRow).earlierApproval?.revision).toBe(2);
  });

  it("a proposal still waiting is refused and its row keeps what it carried", async () => {
    const h = await harnessWithProject();
    await propose(h, 1);
    await approve(h, 2, "2026-11-09T10:30:00.000Z");
    await propose(h, 2);
    await expect(propose(h, 2)).rejects.toThrow(/waiting for your approval/u);
    expect(((await rowOf(h)) as unknown as SetupApplyRow).earlierApproval).toEqual({ revision: 2, at: "2026-11-09T10:30:00.000Z" });
  });

  it("another company's row is never carried: each company's rows are read by its own key", async () => {
    const mine = await harnessWithProject();
    await propose(mine, 1);
    await approve(mine, 2, "2026-11-09T10:30:00.000Z");
    const theirs = createHarness({ companyId: OTHER_COMPANY as never });
    await theirs.registerProject(base);
    await propose(theirs, 1);
    expect((await rowOf(theirs))?.["earlierApproval"]).toBeUndefined();
    expect(setupApplyKey(mine.deps.companyId, "payments")).not.toEqual(setupApplyKey(theirs.deps.companyId, "payments"));
  });
});

describe("earlierApprovalOf reads only a well-formed approval", () => {
  const row = (extra: Record<string, unknown>) => ({ entityType: "SETUP_APPLY", candidateRevision: 4, ...extra });
  it("an approved row's own approval, else the one it carried", () => {
    expect(earlierApprovalOf(row({ state: "approved", decidedAt: "T" }))).toEqual({ revision: 4, at: "T" });
    expect(earlierApprovalOf(row({ state: "rejected", earlierApproval: { revision: 2, at: "T0" } }))).toEqual({ revision: 2, at: "T0" });
    expect(earlierApprovalOf(row({ state: "checking", earlierApproval: { revision: 0, at: "T0" } }))).toEqual({ revision: 0, at: "T0" });
  });
  it("nothing from a missing, foreign or malformed row", () => {
    expect(earlierApprovalOf(undefined)).toBeUndefined();
    expect(earlierApprovalOf({ entityType: "OTHER", state: "approved", candidateRevision: 1, decidedAt: "T" })).toBeUndefined();
    expect(earlierApprovalOf(row({ state: "approved" }))).toBeUndefined();
    expect(earlierApprovalOf(row({ state: "rejected" }))).toBeUndefined();
    for (const bad of [{ revision: "2", at: "T" }, { revision: 2 }, { revision: -1, at: "T" }, { revision: 1.5, at: "T" }, { revision: 2, at: "" }, "x", null, 3]) {
      expect(earlierApprovalOf(row({ state: "rejected", earlierApproval: bad })), JSON.stringify(bad)).toBeUndefined();
    }
  });
});
