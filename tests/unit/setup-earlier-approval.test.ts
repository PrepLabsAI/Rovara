// L4-T2b: the one proposal row per project is overwritten by every new candidate, so the setup a person approved earlier is carried on the new row (`earlierApproval`), through a rejection and into the next candidate.
// Tasks keep using the approved revision meanwhile: a rejection deletes the candidate revision and the catalog still names the approved one. Company by company; nothing is carried from a row that was never approved.
import { describe, expect, it } from "vitest";
import { change, orgProjectCatalogKey, when, type ProjectDefinition } from "@agentx/contracts";
import { earlierApprovalOf, readSetupApply, setupApplyKey, storeSetupCandidate, type SetupApplyDeps, type SetupApplyRow } from "../../packages/broker/src/core/setup-agent/apply.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const base: ProjectDefinition = {
  ...definition,
  setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }],
};
const candidateOf = (revision: number): ProjectDefinition => ({ ...base, revision });

const depsOf = (h: Harness): SetupApplyDeps => (({ flow: h.deps, store: h.store, companyId: h.deps.companyId, now: () => h.clock.now, starter: undefined, latest: async () => undefined }));
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

async function harnessWithProject(): Promise<Harness> {
  const h = createHarness();
  await h.registerProject(base);
  return h;
}

describe("a new candidate keeps the setup a person approved earlier", () => {

  it("a proposal still waiting is refused and its row keeps what it carried", async () => {
    const h = await harnessWithProject();
    await propose(h, 1);
    await approve(h, 2, "2026-11-09T10:30:00.000Z");
    await propose(h, 2);
    await expect(propose(h, 2)).rejects.toThrow(/still being checked on a fresh machine/u);
    expect(((await rowOf(h)) as unknown as SetupApplyRow).earlierApproval).toEqual({ revision: 2, at: "2026-11-09T10:30:00.000Z" });
  });

});

describe("earlierApprovalOf reads only a well-formed approval", () => {
  const row = (extra: Record<string, unknown>) => ({ entityType: "SETUP_APPLY", candidateRevision: 4, ...extra });
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

describe("the candidate keeps which commands were used with no file evidence (the approval card tags them)", () => {
  it("stores them on the row, reads them back, and keeps nothing when there are none", async () => {
    const h = await harnessWithProject();
    await storeSetupCandidate(depsOf(h), { project: "payments", by: "local-owner", requestId: newRequestId(), taskId: "", baseRevision: 1, candidate: candidateOf(2), replyExtra: {}, alsoTransact: [], usedWithoutMatch: ["npm ci"] });
    expect(((await rowOf(h)) as unknown as SetupApplyRow).usedWithoutMatch).toEqual(["npm ci"]);
    expect((await readSetupApply(depsOf(h), "payments"))!.usedWithoutMatch).toEqual(["npm ci"]);
    const other = await harnessWithProject();
    await propose(other, 1);
    expect(await rowOf(other)).not.toHaveProperty("usedWithoutMatch");
    const empty = await harnessWithProject();
    await storeSetupCandidate(depsOf(empty), { project: "payments", by: "local-owner", requestId: newRequestId(), taskId: "", baseRevision: 1, candidate: candidateOf(2), replyExtra: {}, alsoTransact: [], usedWithoutMatch: [] });
    expect(await rowOf(empty)).not.toHaveProperty("usedWithoutMatch");
  });
});
