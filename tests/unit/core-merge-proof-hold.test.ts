// TE-B5: the tracking pass holds a draft whose change was not proven, says why, and lets the task's owner or a maintainer "mark ready anyway" (recorded once, audited, for that head only). Driven through the real
// tracking pass and the real `markReadyAnyway` over the in-memory store and the fake host.
import { describe, expect, it } from "vitest";
import { type ProofHoldFacts, type ProofHoldMode, type TestProof, type TestProofItem } from "../../packages/contracts/src/index.js";
import { attentionOf } from "../../packages/broker/src/local/app/attention.js";
import {
  OVERRIDE_REASON_MAX, judgeProofHold, markReadyAnyway, plainReason, proofHoldKey, proofOverrideKey, readProofHold, readProofHoldHistory, trackPullRequest, type LiveRoles, type MarkReadyInput, type ProofHoldSource,
} from "../../packages/broker/src/core/merge/index.js";
import { ORG, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";

const DIGEST = "d".repeat(64);
const item = (verdict: TestProofItem["verdict"], reason: TestProofItem["reason"]): TestProofItem => ({ checkId: "unit", label: "unit", granularity: "check", verdict, reason });
const proof = (items: TestProofItem[]): TestProof => ({ schemaVersion: 1, candidateDigest: DIGEST, status: "checked", note: "completed", changedTests: { added: 1, changed: 0, deleted: 0 }, items, durationMs: 1 });
const PROVEN: ProofHoldFacts = { proof: proof([item("proves_change", "assertion_failed_on_old")]) };
const VACUOUS: ProofHoldFacts = { proof: proof([item("does_not_prove", "passed_on_old")]) };

type Roles = Record<string, { orgRole?: string; projectRole?: string }>;
const rolesOf = (table: Roles): LiveRoles & { table: Roles } => ({ table, read: async (_company, _project, personId) => table[personId] });

/** A world whose pull request is a draft with passing checks, so only the change proof can keep it a draft. */
async function heldWorld(facts: ProofHoldFacts | (() => Promise<ProofHoldFacts | undefined>) | undefined, mode: ProofHoldMode = "hold") {
  const world = await mergeWorld();
  const pr = world.prs[0]!;
  pr.model.getChangeRequest(String(pr.number)).draft = true;
  const calls = { facts: 0 };
  const source: ProofHoldSource = {
    mode: () => mode,
    facts: async () => { calls.facts += 1; return typeof facts === "function" ? facts() : facts; },
  };
  const tracking = { ...world.tracking, proofHold: source };
  const draft = () => pr.model.getChangeRequest(String(pr.number)).draft;
  return { world, pr, tracking, calls, draft, source };
}
const roles = rolesOf({
  "owner-1": { orgRole: "member", projectRole: "contributor" },
  maint: { orgRole: "member", projectRole: "maintainer" },
  admin: { orgRole: "admin" },
  other: { orgRole: "member", projectRole: "contributor" },
  viewer: { orgRole: "member", projectRole: "viewer" },
  stranger: {},
});
const press = (world: MergeWorld, over: Partial<MarkReadyInput> & { actorId: string }, table: LiveRoles = roles, nudges: string[] = []) => {
  const pr = world.prs[0]!;
  return markReadyAnyway(
    { store: world.store, audit: world.audit, roles: table, now: () => world.now.value, loadTask: (taskId) => world.host.loadTask(taskId), nudge: async (taskId) => { nudges.push(taskId); } },
    { companyId: ORG, taskId: TASK_ID, repositoryId: pr.repositoryId, number: pr.number, expectedHeadSha: pr.head, ...over },
  );
};

describe("the ready rule: a draft is held for its change proof", () => {
  it("no source: a draft that passes is taken out of draft as before (nothing is read, nothing written)", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    pr.model.getChangeRequest(String(pr.number)).draft = true;
    await trackPullRequest(world.tracking, TASK_ID);
    expect(pr.model.getChangeRequest(String(pr.number)).draft).toBe(false);
    expect(await world.store.get(proofHoldKey(TASK_ID, pr.repositoryId, pr.number))).toBeUndefined();
  });
  it("a proven change is taken out of draft", async () => {
    const { tracking, draft, pr, world } = await heldWorld(PROVEN);
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(false);
    expect(await world.trackingOf(pr)).toMatchObject({ draft: false });
    expect(world.timeline.lines.filter((line) => line.startsWith("Held"))).toEqual([]);
  });
  it("tests that pass on the old code too keep the draft, and the timeline says why, once", async () => {
    const { tracking, draft, pr, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(true);
    expect(world.milestones.written.filter((m) => m.kind === "pr_ready")).toEqual([]);
    expect(world.timeline.lines.filter((line) => line.includes("the new tests pass on the old code too"))).toHaveLength(1);
    const stored = await readProofHold(world.store, { taskId: TASK_ID, orgId: ORG }, { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head });
    expect(stored?.record).toMatchObject({ holds: true, reasons: ["proof_failed"], mode: "hold", headSha: pr.head });
    expect(stored?.override).toBeUndefined();
  });
  it("a judgement that comes back to an earlier state (held, proven, held again) is still recorded, though its timeline line was said", async () => {
    let facts: ProofHoldFacts = VACUOUS;
    const { world, pr } = await heldWorld(undefined);
    const source = { mode: () => "hold" as const, facts: async () => facts };
    const task = { ...(await world.task()), orgId: ORG };
    const judge = () => judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: source }, task, pr, pr.head, world.now.value);
    await judge();
    facts = PROVEN;
    await judge();
    expect((await readProofHold(world.store, { taskId: TASK_ID, orgId: ORG }, { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head }))?.record.holds).toBe(false);
    facts = VACUOUS;
    await judge();
    expect((await readProofHold(world.store, { taskId: TASK_ID, orgId: ORG }, { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head }))?.record.holds).toBe(true);
  });
  it("each reason holds the draft", async () => {
    const cases: ProofHoldFacts[] = [
      { ...PROVEN, absentOnNew: ["a > b"] }, { ...PROVEN, changedLines: { changed: 5, covered: 0 } }, { ...PROVEN, flakyOnChange: ["a > b"] },
      VACUOUS,
    ];
    for (const facts of cases) {
      const { tracking, draft } = await heldWorld(facts);
      await trackPullRequest(tracking, TASK_ID);
      expect(draft(), JSON.stringify(facts)).toBe(true);
    }
  });
  it("scripted replies of every origin release the draft without a hold or warning", async () => {
    for (const origin of ["before_task", "independent_agent", "coding_agent", "failure_pack", "unknown", "made_up"]) {
      const { tracking, draft, world, pr } = await heldWorld({ ...PROVEN, scriptedReplies: { unit: origin } });
      await trackPullRequest(tracking, TASK_ID);
      expect(draft(), origin).toBe(false);
      expect(world.timeline.lines.filter((line) => line.startsWith("Held") || line.startsWith("Not proven:"))).toEqual([]);
      const stored = await readProofHold(world.store, { taskId: TASK_ID, orgId: ORG }, { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head });
      expect(stored?.record).toMatchObject({ holds: false, warns: false, reasons: [], provenCount: 1 });
    }
  });
  it("a vacuous sibling does not hold an agent-reply proving test through tracking", async () => {
    const mixed = proof([item("proves_change", "assertion_failed_on_old"), { ...item("does_not_prove", "passed_on_old"), checkId: "other" }]);
    const { tracking, draft } = await heldWorld({ proof: mixed, scriptedReplies: { unit: "coding_agent" } });
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(false);
  });
  it("the Lightweight preset warns and takes the draft out of draft; off ignores the proof", async () => {
    const warned = await heldWorld(VACUOUS, "warn");
    await trackPullRequest(warned.tracking, TASK_ID);
    expect(warned.draft()).toBe(false);
    expect(warned.world.timeline.lines.some((line) => line.startsWith("Not proven:"))).toBe(true);
    const off = await heldWorld(VACUOUS, "off");
    await trackPullRequest(off.tracking, TASK_ID);
    expect(off.draft()).toBe(false);
    expect(off.calls.facts).toBe(0);
  });
  it("nothing known about the proof never holds (a Rovara fault must not block)", async () => {
    const { tracking, draft } = await heldWorld(undefined);
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(false);
  });
  it("a judgement that cannot be made keeps the draft this pass and is tried again on the next", async () => {
    let broken = true;
    const { tracking, draft } = await heldWorld(async () => { if (broken) throw new Error("boom"); return PROVEN; });
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(true);
    broken = false;
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(false);
  });
  it("a pull request that is not a draft cannot be kept back and is not judged", async () => {
    const world = await mergeWorld();
    const calls = { facts: 0 };
    const tracking = { ...world.tracking, proofHold: { mode: () => "hold" as const, facts: async () => { calls.facts += 1; return VACUOUS; } } };
    await trackPullRequest(tracking, TASK_ID);
    expect(calls.facts).toBe(0);
    expect(await world.trackingOf(world.prs[0]!)).toMatchObject({ draft: false });
  });
  it("a draft that is not otherwise ready (CI failing) is not judged either: nothing is read until it matters", async () => {
    const { tracking, pr, calls, draft } = await heldWorld(PROVEN);
    pr.model.setChecks(pr.head, [{ name: "unit", state: "completed", conclusion: "failure", required: false, url: "", runId: "11" }]);
    await trackPullRequest(tracking, TASK_ID);
    expect(calls.facts).toBe(0);
    expect(draft()).toBe(true);
  });
});

describe("O43: above 10% held the hold becomes a warning", () => {
  it("3 of the last 20 judged pull requests held: the next one is a warning and the draft goes ready", async () => {
    const { tracking, draft, world } = await heldWorld(VACUOUS);
    const store = world.store;
    for (const key of ["x#1", "x#2", "x#3"]) {
      await judgeProofHold({ store, timeline: world.timeline, proofHold: { mode: () => "hold", facts: async () => VACUOUS } }, { ...(await world.task()), orgId: ORG }, { repositoryId: key.split("#")[0]!, number: Number(key.split("#")[1]) }, "a".repeat(40), world.now.value);
    }
    expect(await readProofHoldHistory(store, ORG, "web")).toEqual({ held: 3, total: 3 });
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(false);
    expect(world.timeline.lines.some((line) => line.includes("so this is a warning, not a hold"))).toBe(true);
  });
  it("2 of 20 is exactly 10%: the hold stays", async () => {
    const { tracking, draft, world } = await heldWorld(VACUOUS);
    for (const number of [101, 102]) {
      await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: { mode: () => "hold", facts: async () => VACUOUS } }, { ...(await world.task()), orgId: ORG }, { repositoryId: "x", number }, "a".repeat(40), world.now.value);
    }
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(true);
  });
  it("a pull request is counted once however many passes judge it, and the window keeps the last 20", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    await trackPullRequest(tracking, TASK_ID);
    await trackPullRequest(tracking, TASK_ID);
    expect(await readProofHoldHistory(world.store, ORG, "web")).toEqual({ held: 1, total: 1 });
    for (let n = 1; n <= 25; n += 1) {
      await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: { mode: () => "hold", facts: async () => PROVEN } }, { ...(await world.task()), orgId: ORG }, { repositoryId: "y", number: n }, "a".repeat(40), world.now.value);
    }
    expect((await readProofHoldHistory(world.store, ORG, "web")).total).toBe(20);
  });
  it("the history is the rule's own verdict, so a relaxed hold still counts as one the rule made", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    for (const number of [201, 202, 203]) {
      await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: { mode: () => "hold", facts: async () => VACUOUS } }, { ...(await world.task()), orgId: ORG }, { repositoryId: "x", number }, "a".repeat(40), world.now.value);
    }
    await trackPullRequest(tracking, TASK_ID);
    expect((await readProofHoldHistory(world.store, ORG, "web")).held).toBe(4);
  });
});

describe("mark ready anyway", () => {
  it("lets the task's owner release the hold: one override row, one audit row, and the draft goes ready on the next pass", async () => {
    const { tracking, draft, pr, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(true);
    const nudges: string[] = [];
    const done = await press(world, { actorId: "owner-1", reason: "checked by hand" }, roles, nudges);
    expect(done).toMatchObject({ overridden: true, already: false, override: { actorId: "owner-1", reason: "checked by hand", headSha: pr.head } });
    expect(nudges).toEqual([TASK_ID]);
    const audit = (await world.auditRows()) as Array<{ action: string; actor: string }>;
    expect(audit.filter((row) => row.action === "pull_request.proof_overridden")).toEqual([expect.objectContaining({ actor: "owner-1" })]);
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(false);
    const ready = world.milestones.written.find((m) => m.kind === "pr_ready");
    expect(ready?.text).toContain("marked it ready anyway");
    const view = await readProofHold(world.store, { taskId: TASK_ID, orgId: ORG }, { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head });
    expect(view?.override).toMatchObject({ actorId: "owner-1", reason: "checked by hand" });
  });
  it("the reason is optional (O59)", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    const done = await press(world, { actorId: "maint" });
    expect(done.override.reason).toBeUndefined();
    expect("reason" in ((await world.store.get(proofOverrideKey(TASK_ID, world.prs[0]!.repositoryId, world.prs[0]!.number))) ?? {})).toBe(false);
  });
  it("a second press is idempotent: one override and one audit row", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    const first = await press(world, { actorId: "owner-1" });
    const second = await press(world, { actorId: "maint", reason: "me too" });
    expect(second).toMatchObject({ already: true, override: { actorId: "owner-1" } });
    expect(first.already).toBe(false);
    expect((await world.auditRows()).filter((row) => (row as { action: string }).action === "pull_request.proof_overridden")).toHaveLength(1);
    // two presses at the same time record one too
    const fresh = await heldWorld(VACUOUS);
    await trackPullRequest(fresh.tracking, TASK_ID);
    const both = await Promise.allSettled([press(fresh.world, { actorId: "owner-1" }), press(fresh.world, { actorId: "owner-1" })]);
    expect(both.every((entry) => entry.status === "fulfilled")).toBe(true);
    expect((await fresh.world.auditRows()).filter((row) => (row as { action: string }).action === "pull_request.proof_overridden")).toHaveLength(1);
  });
  it("a maintainer and an admin may; a member who is neither, a viewer, a stranger and a non-member may not", async () => {
    for (const [actorId, allowed] of [["maint", true], ["admin", true], ["owner-1", true], ["other", false], ["viewer", false], ["stranger", false], ["nobody-at-all", false]] as const) {
      const { tracking, world } = await heldWorld(VACUOUS);
      await trackPullRequest(tracking, TASK_ID);
      const outcome = await press(world, { actorId }).then(() => true, (error: { code?: string }) => error.code);
      expect(outcome === true, actorId).toBe(allowed);
      if (!allowed) {
        expect(outcome).toBe("TASK_ACCESS_DENIED");
        expect(await world.store.get(proofOverrideKey(TASK_ID, world.prs[0]!.repositoryId, world.prs[0]!.number))).toBeUndefined();
        expect((await world.auditRows()).filter((row) => (row as { action: string }).action === "pull_request.proof_overridden")).toEqual([]);
      }
    }
  });
  it("another company's person is refused for this company's task (tenant isolation)", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    const foreign = rolesOf({ "owner-1": { orgRole: "owner" }, maint: { orgRole: "owner" } });
    const outcome = await press(world, { actorId: "owner-1", companyId: "org-other" }, foreign).then(() => true, (error: { code?: string }) => error.code);
    expect(outcome).toBe("TASK_ACCESS_DENIED");
    expect(await world.store.get(proofOverrideKey(TASK_ID, world.prs[0]!.repositoryId, world.prs[0]!.number))).toBeUndefined();
  });
  it("roles are read at the press: a demoted owner is refused at once, and a role that cannot be read refuses", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    const live = rolesOf({ "owner-1": { orgRole: "member", projectRole: "viewer" } });
    expect(await press(world, { actorId: "owner-1" }, live).then(() => true, () => false)).toBe(false);
    live.table["owner-1"] = { orgRole: "member", projectRole: "contributor" };
    expect(await press(world, { actorId: "owner-1" }, live).then(() => true, () => false)).toBe(true);
    const broken = { read: async () => { throw new Error("people store down"); } };
    const second = await heldWorld(VACUOUS);
    await trackPullRequest(second.tracking, TASK_ID);
    expect(await press(second.world, { actorId: "owner-1" }, broken).then(() => true, () => false)).toBe(false);
  });
  it("is refused when nothing is held: a proven change, a pull request not a draft, no judgement yet", async () => {
    const proven = await heldWorld(PROVEN);
    await trackPullRequest(proven.tracking, TASK_ID);
    expect(await press(proven.world, { actorId: "owner-1" }).then(() => true, (error: { code?: string }) => error.code)).toBe("MERGE_NOT_READY");
    const none = await heldWorld(VACUOUS);
    expect(await press(none.world, { actorId: "owner-1" }).then(() => true, (error: { code?: string }) => error.code)).toBe("MERGE_NOT_READY");
  });
  it("is refused for a draft that is not held: judged proven, or judged for another head", async () => {
    const { world, pr } = await heldWorld(PROVEN);
    const task = { ...(await world.task()), orgId: ORG };
    await world.seedTracking({ draft: true });
    await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: { mode: () => "hold", facts: async () => PROVEN } }, task, pr, pr.head, world.now.value);
    expect(await press(world, { actorId: "owner-1" }).then(() => true, (error: { code?: string }) => error.code)).toBe("MERGE_NOT_READY");
    const stale = await heldWorld(VACUOUS);
    await stale.world.seedTracking({ draft: true });
    await judgeProofHold({ store: stale.world.store, timeline: stale.world.timeline, proofHold: { mode: () => "hold", facts: async () => VACUOUS } }, { ...(await stale.world.task()), orgId: ORG }, stale.pr, "c".repeat(40), stale.world.now.value);
    expect(await press(stale.world, { actorId: "owner-1" }).then(() => true, (error: { code?: string }) => error.code)).toBe("MERGE_NOT_READY");
    expect(await stale.world.store.get(proofOverrideKey(TASK_ID, stale.pr.repositoryId, stale.pr.number))).toBeUndefined();
  });
  it("is refused for a pull request that is not on the task and for a closed task", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    expect(await press(world, { actorId: "owner-1", number: 999 }).then(() => true, (error: { code?: string }) => error.code)).toBe("TASK_ACCESS_DENIED");
    const closed = { ...(await world.task()), closedAt: "2026-11-09T10:00:00.000Z" };
    const outcome = await markReadyAnyway(
      { store: world.store, audit: world.audit, roles, now: () => world.now.value, loadTask: async () => closed },
      { companyId: ORG, taskId: TASK_ID, repositoryId: world.prs[0]!.repositoryId, number: world.prs[0]!.number, expectedHeadSha: world.prs[0]!.head, actorId: "owner-1" },
    ).then(() => true, (error: { code?: string }) => error.code);
    expect(outcome).toBe("TASK_ACCESS_DENIED");
  });
  it("is for one head: a new push is judged again and the old override does not apply", async () => {
    const { world, pr } = await heldWorld(VACUOUS);
    const source = { mode: () => "hold" as const, facts: async () => VACUOUS };
    const task = { ...(await world.task()), orgId: ORG };
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: source }, task, pr, first, world.now.value);
    await world.seedTracking({ draft: true, headSha: first });
    await press(world, { actorId: "owner-1", expectedHeadSha: first });
    expect((await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: source }, task, pr, first, world.now.value)).kind).toBe("proceed");
    expect((await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: source }, task, pr, second, world.now.value)).kind).toBe("held");
    // and a fresh press for the new head replaces the old row
    await world.seedTracking({ draft: true, headSha: second });
    const again = await press(world, { actorId: "maint", expectedHeadSha: second });
    expect(again).toMatchObject({ already: false, override: { actorId: "maint", headSha: second } });
    expect((await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: source }, task, pr, second, world.now.value)).kind).toBe("proceed");
  });
  it("another company's record of the same task id is never read as ours", async () => {
    const { world, pr } = await heldWorld(VACUOUS);
    await world.store.put({ item: { ...proofOverrideKey(TASK_ID, pr.repositoryId, pr.number), orgId: "org-other", taskId: TASK_ID, repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head, actorId: "x", at: "2026-11-09T10:00:00.000Z" } });
    const gate = await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: { mode: () => "hold", facts: async () => VACUOUS } }, { ...(await world.task()), orgId: ORG }, pr, pr.head, world.now.value);
    expect(gate.kind).toBe("held");
  });
});

describe("the reason is untrusted text", () => {
  it("drops control, format and hidden characters, redacts secrets and cuts to the bound", () => {
    expect(plainReason(undefined)).toBeUndefined();
    expect(plainReason("   ​\n\t ")).toBeUndefined();
    expect(plainReason("a‮b‍c\nd️e")).toBe("a b c d e".replace(/ /g, " "));
    expect(plainReason("x".repeat(5_000))).toHaveLength(OVERRIDE_REASON_MAX);
    const key = ["sk", "live", "A".repeat(32)].join("-");
    expect(plainReason(`token ${key} here`)).not.toContain(key);
  });
  it("a 1 MB reason costs about the same as a short one", () => {
    const started = Date.now();
    plainReason("ab ".repeat(350_000));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("old data keeps working", () => {
  it("a task with no hold or override record reads as nothing judged, and a v1 tracking row is untouched by the pass", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    expect(await readProofHold(world.store, { taskId: TASK_ID, orgId: ORG }, { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head })).toBeUndefined();
    await world.seedTracking();
    await trackPullRequest(world.tracking, TASK_ID);
    expect(await world.store.get(proofHoldKey(TASK_ID, pr.repositoryId, pr.number))).toBeUndefined();
  });
  it("a garbled hold record is read as nothing, never as a hold or an override", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    await world.store.put({ item: { ...proofHoldKey(TASK_ID, pr.repositoryId, pr.number), orgId: ORG, taskId: TASK_ID, holds: "yes" } });
    expect(await readProofHold(world.store, { taskId: TASK_ID, orgId: ORG }, { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head })).toBeUndefined();
  });
});

describe("review fixes: a held draft cannot release itself (H1)", () => {
  it("2 other held PRs in the window: the PR stays held on pass 2 and pass 3 (its own verdict is not in its own history)", async () => {
    const { world, pr, tracking, draft } = await heldWorld(VACUOUS);
    for (const number of [101, 102]) {
      await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: { mode: () => "hold", facts: async () => VACUOUS } }, { ...(await world.task()), orgId: ORG }, { repositoryId: "x", number }, "a".repeat(40), world.now.value);
    }
    for (const pass of [1, 2, 3]) {
      await trackPullRequest(tracking, TASK_ID);
      expect(draft(), `pass ${String(pass)}`).toBe(true);
      world.now.value += 10 * 60_000;
    }
    expect(world.milestones.written.filter((m) => m.kind === "pr_ready")).toEqual([]);
    expect((await readProofHoldHistory(world.store, ORG, "web")).held).toBe(3);
    expect(pr.number).toBeGreaterThan(0);
  });
});

describe("review fixes: unknown never releases a held draft (M2)", () => {
  it("held on one head, facts unknown on the next head (or unreadable on the same one): still held", async () => {
    const { world, pr } = await heldWorld(undefined);
    let facts: ProofHoldFacts | undefined = VACUOUS;
    const source = { mode: () => "hold" as const, facts: async () => facts };
    const task = { ...(await world.task()), orgId: ORG };
    const judge = (head: string) => judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: source }, task, pr, head, world.now.value);
    expect((await judge("a".repeat(40))).kind).toBe("held");
    facts = undefined;
    expect((await judge("b".repeat(40))).kind).toBe("held");
    expect((await judge("b".repeat(40))).kind).toBe("held");
    facts = { proof: { ...proof([item("does_not_prove", "passed_on_old")]), status: "not_checked" } };
    expect((await judge("c".repeat(40))).kind).toBe("held");
    facts = PROVEN;
    expect((await judge("d".repeat(40))).kind).toBe("proceed");
  });
  it("a PR that was never held is not held by unknown facts", async () => {
    const { world, pr } = await heldWorld(undefined);
    const task = { ...(await world.task()), orgId: ORG };
    expect((await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: { mode: () => "hold", facts: async () => undefined } }, task, pr, "a".repeat(40), world.now.value)).kind).toBe("proceed");
  });
});

describe("review fixes: the press names the head it saw (M1)", () => {
  it("is refused when the head differs from the tracked head, and writes nothing; the matching head records", async () => {
    const { tracking, world, pr } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    const refused = await press(world, { actorId: "owner-1", expectedHeadSha: "e".repeat(40) }).then(() => true, (error: { code?: string }) => error.code);
    expect(refused).toBe("MERGE_NOT_READY");
    expect(await world.store.get(proofOverrideKey(TASK_ID, pr.repositoryId, pr.number))).toBeUndefined();
    expect((await world.auditRows()).filter((row) => (row as { action: string }).action === "pull_request.proof_overridden")).toEqual([]);
    expect(await press(world, { actorId: "owner-1" }).then(() => true, () => false)).toBe(true);
  });
});

describe("review fixes: a held draft is one decision item (M3)", () => {
  it("says held with the reason and Mark ready anyway as a needs-you item; not 'waiting for checks'; gone after the override", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    const task = await world.task();
    const held = await attentionOf({ store: world.store, companyId: ORG }, task as never);
    expect(held.display).toMatchObject({ state: "needs_you" });
    expect(held.step).toContain("Held");
    expect(held.step).toContain("Mark ready anyway");
    expect(held.step).toContain("the new tests pass on the old code too");
    expect(held.view.merge?.lines.join(" ")).toContain("Mark ready anyway");
    await press(world, { actorId: "owner-1" });
    const released = await attentionOf({ store: world.store, companyId: ORG }, task as never);
    expect(released.step ?? "").not.toContain("Held");
  });
  it("a draft that is not held is not a decision item", async () => {
    const { tracking, world } = await heldWorld(PROVEN);
    await trackPullRequest(tracking, TASK_ID);
    const attention = await attentionOf({ store: world.store, companyId: ORG }, (await world.task()) as never);
    expect(attention.step ?? "").not.toContain("Held");
  });
});

describe("review fixes: second press and the early company guard (L6)", () => {
  it("a press after the draft went ready says it was already marked ready", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    await press(world, { actorId: "owner-1" });
    await trackPullRequest(tracking, TASK_ID);
    const error = await press(world, { actorId: "maint" }).then(() => undefined, (caught: { code?: string; message: string }) => caught);
    expect(error?.code).toBe("MERGE_NOT_READY");
    expect(error?.message).toContain("already marked ready");
  });
  it("a task of another company is refused before any role is read", async () => {
    const { tracking, world } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    const asked: string[] = [];
    const spy: LiveRoles = { read: async (company, _project, person) => { asked.push(`${company}:${person}`); return { orgRole: "owner" }; } };
    const outcome = await press(world, { actorId: "owner-1", companyId: "org-other" }, spy).then(() => true, (error: { code?: string }) => error.code);
    expect(outcome).toBe("TASK_ACCESS_DENIED");
    expect(asked).toEqual([]);
  });
});
