// TE-B5: the tracking pass holds a draft whose change was not proven, says why, and lets the task's owner or a maintainer "mark ready anyway" (recorded once, audited, for that head only). Driven through the real
// tracking pass and the real `markReadyAnyway` over the in-memory store and the fake host.
import { describe, expect, it, vi } from "vitest";
import { type ProofHoldFacts, type ProofHoldMode, type TestProof, type TestProofItem } from "../../packages/contracts/src/index.js";
import { attentionOf } from "../../packages/broker/src/core-host/app/attention.js";
import {
  OVERRIDE_REASON_MAX, judgeProofHold, markReadyAnyway, plainReason, proofHoldKey, proofOverrideKey, readProofHold, readProofHoldHistory, trackPullRequest, type LiveRoles, type MarkReadyInput, type ProofHoldSource,
} from "../../packages/broker/src/core/merge/index.js";
import { ORG, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";
import { expectLinearScaling } from "../support/scaling.js";

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
  it.each([true, false])("a proof override cannot bypass the tier hold (%s)", async (tierHeld) => {
    const { tracking, draft, world, pr } = await heldWorld(VACUOUS);
    await trackPullRequest(tracking, TASK_ID);
    expect((await press(world, { actorId: "owner-1" })).overridden).toBe(true);
    const tierHeads: string[] = [];
    await trackPullRequest({ ...tracking, readyHold: async (_task, current) => { tierHeads.push(current.headSha); return tierHeld; } }, TASK_ID);
    expect(tierHeads).toEqual([pr.head]);
    expect(draft()).toBe(tierHeld);
    expect(world.milestones.written.filter((entry) => entry.kind === "pr_ready")).toHaveLength(tierHeld ? 0 : 1);
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
    expect(plainReason("ab ".repeat(350_000))!.length).toBeLessThanOrEqual(OVERRIDE_REASON_MAX);
    // The cost must not grow faster than the input (10,000 -> 80,000 repeats; the 8N input stays at or under 256 KiB so it stays in CPU cache). The full 350,000 repeats are checked once above.
    expectLinearScaling((repeats) => { const reason = "ab ".repeat(repeats); return () => { plainReason(reason); }; }, { n: 10_000, unitBytes: 3, label: "plainReason on a long reason" });
  });
});

describe("old data keeps working", () => {
  it("a garbled hold record is read as nothing, never as a hold or an override", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    await world.store.put({ item: { ...proofHoldKey(TASK_ID, pr.repositoryId, pr.number), orgId: ORG, taskId: TASK_ID, holds: "yes" } });
    expect(await readProofHold(world.store, { taskId: TASK_ID, orgId: ORG }, { repositoryId: pr.repositoryId, number: pr.number, headSha: pr.head })).toBeUndefined();
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
});

describe("Round 2: fail-closed broker regressions", () => {
  it.each(["future_verdict", "proves_change"])("an unsupported assertion row never makes tracking ready (%s)", async (verdict) => {
    const bad = { ...item("proves_change", "load_failure_on_old"), verdict } as TestProofItem;
    const { tracking, draft } = await heldWorld({ proof: proof([item("does_not_prove", "passed_on_old"), bad]) });
    await trackPullRequest(tracking, TASK_ID);
    expect(draft()).toBe(true);
  });
  it.each([290, 1_190, 262_134])("never leaves a secret prefix at cut %s", (offset) => {
    const secret = ["ghp", "B".repeat(36)].join("_");
    expect(plainReason(`${"x ".repeat(Math.floor(offset / 2))}${secret}${" tail".repeat(100)}`)).not.toContain(secret.slice(0, 8));
  });
});

describe("Round 2: read cancellation boundaries", () => {
  it("sweep abort ends an in-flight facts read immediately", async () => {
    vi.useFakeTimers();
    try {
      const { world, tracking, draft, pr } = await heldWorld(undefined);
      const parent = new AbortController();
      let signal: AbortSignal | undefined;
      let settled = false;
      const source: ProofHoldSource = { mode: () => "hold", facts: async (input) => {
        signal = input.signal;
        return new Promise(() => {});
      } };
      const pending = trackPullRequest({ ...tracking, proofHold: source, budget: { signal: parent.signal, beforeRequest: () => {} } }, TASK_ID).then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      parent.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(signal?.aborted).toBe(true);
      await pending;
      expect(draft()).toBe(true);
      expect(await world.store.get(proofHoldKey(TASK_ID, pr.repositoryId, pr.number))).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});

describe("Round 2: unreadable proof words", () => {
  it.each(["mode", "facts"] as const)("never echoes the %s failure or an error name", async (stage) => {
    const { world, pr } = await heldWorld(PROVEN);
    const secret = ["ghp", "D".repeat(36)].join("_");
    const error = new Error(secret);
    error.name = secret;
    const logs: unknown[] = [];
    const gate = await judgeProofHold({ store: world.store, timeline: world.timeline, log: (event, fields) => { logs.push({ event, fields }); }, proofHold: { mode: () => { if (stage === "mode") throw error; return "hold"; }, facts: async () => { throw error; } } }, { ...(await world.task()), orgId: ORG }, pr, pr.head, world.now.value);
    expect(gate).toEqual({ kind: "unreadable" });
    expect(JSON.stringify(logs)).not.toContain(secret);
    expect(await world.store.get(proofHoldKey(TASK_ID, pr.repositoryId, pr.number))).toBeUndefined();
  });
});

describe("Round 2: bounded judgment inputs", () => {
  it("an unsupported mode refuses without reading facts", async () => {
    const { world, pr } = await heldWorld(PROVEN);
    let reads = 0;
    const source = { mode: () => "future_mode" as ProofHoldMode, facts: async () => { reads += 1; return PROVEN; } };
    expect(await judgeProofHold({ store: world.store, timeline: world.timeline, proofHold: source }, { ...(await world.task()), orgId: ORG }, pr, pr.head, world.now.value)).toEqual({ kind: "unreadable" });
    expect(reads).toBe(0);
  });
});
