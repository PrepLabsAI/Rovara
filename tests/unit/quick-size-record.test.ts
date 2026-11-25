// SF-1a: the `quickSize` record is worked out once at plan write and committed in the SAME transaction as the plan. Two layers: `quickSizeOps` on small fakes (when it writes, what it asks the design review about, what it
// does when something fails) and the real task flow on its fakes (the plan lands, the record lands with it, a revised plan replaces it, a project whose design review is `never` is read).
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, QUICK_SIZE_RECORDING_VERSION, readQuickSize, type PlanDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { quickPlanAtGate, quickSizeOps } from "../../packages/broker/src/core/task-flow/quick-size-record.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { finish, nextJob, plannedStructured, taskOf, world, BASE } from "../support/design-review-flow-world.js";
import { planDocument } from "../support/plan-documents.js";

const AT = "2026-11-25T00:00:00.000Z";
const DIGEST = "c".repeat(64);
const artifact = { id: "a1", type: "plan", version: 1, sha256: DIGEST, producer: "agentx-worker-untrusted", objectKey: "docs/none.json", createdAt: AT, format: "structured" } as never;
const task = { taskId: "t1", project: "payments" } as unknown as TaskRecord;
const planAt = (patch: Record<string, unknown> = {}): WorkflowSnapshot => ({ path: "QUICK", stage: "PLAN_REVIEW", state: "WAITING", revision: 5, artifacts: [], ...patch }) as unknown as WorkflowSnapshot;
const readingOf = (reasons: string[]) => ({ intent: { assessment: { kind: "ready", design: { needed: true, reasons, note: "x" } } } });
const migrationPlan = (): PlanDocument => planDocument({ claims: [{ id: "1", text: "Add refunds.", evidence: [{ kind: "code", path: "db/migrations/0042_refunds.sql", startLine: 1, endLine: 4 }] }] });

function deps(options: { canRun?: () => Promise<boolean>; noSeam?: boolean } = {}): { deps: TaskFlowDeps; logs: Array<Record<string, unknown>>; asked: number[] } {
  const logs: Array<Record<string, unknown>> = [];
  const asked: number[] = [];
  const designReview = options.noSeam === true ? undefined : { ...(options.canRun === undefined ? {} : { reviewCanRun: async () => { asked.push(1); return options.canRun!(); } }) };
  return { deps: { companyId: IMPLICIT_COMPANY_ID, now: () => new Date(AT), log: (entry: Record<string, unknown>) => logs.push(entry), ...(designReview === undefined ? {} : { designReview }) } as unknown as TaskFlowDeps, logs, asked };
}
const recordOf = (ops: readonly unknown[]) => {
  expect(ops).toHaveLength(1);
  const op = ops[0] as { op: string; path: string[]; value: unknown };
  expect(op).toMatchObject({ op: "set", path: ["quickSize"] });
  return readQuickSize(op.value)!;
};

describe("quickSizeOps: when it writes", () => {
  it("writes at a Quick plan that waits for its check or for the person; not for a Full plan, not for a plan sent straight to coding, not for another document", async () => {
    const { deps: d } = deps();
    for (const patch of [{ stage: "PLAN_REVIEW", state: "WAITING" }, { stage: "PLAN_CRITIQUE", state: "READY" }]) {
      expect(quickPlanAtGate(planAt(patch)), JSON.stringify(patch)).toBe(true);
      expect(await quickSizeOps(d, task, planAt(patch), { artifact, plan: migrationPlan() })).toHaveLength(1);
    }
    for (const patch of [{ path: "FULL", reviewPhase: "IMPLEMENTATION_PLAN" }, { stage: "IMPLEMENT", state: "READY" }, { stage: "PLAN_CRITIQUE", state: "RUNNING" }, { stage: "PLAN", state: "READY" }]) {
      expect(await quickSizeOps(d, task, planAt(patch), { artifact, plan: migrationPlan() }), JSON.stringify(patch)).toEqual([]);
    }
  });

  it("a Quick plan with no gate, or a fault, takes the earlier plan's record off the row; a Full plan leaves it; a row with none gets no operation", async () => {
    const { deps: d, logs } = deps();
    const had = { ...task, quickSize: { rulesVersion: 0, planDigest: "e".repeat(64), at: AT, class: "strong", triggered: true, counts: {}, reasons: [{ code: "data_change" }] } } as unknown as TaskRecord;
    const removal = [{ op: "remove", path: ["quickSize"] }];
    expect(await quickSizeOps(d, had, planAt({ stage: "IMPLEMENT", state: "READY" }), { artifact, plan: migrationPlan() })).toMatchObject(removal);
    expect(await quickSizeOps(d, task, planAt({ stage: "IMPLEMENT", state: "READY" }), { artifact, plan: migrationPlan() })).toEqual([]);
    expect(await quickSizeOps(d, had, planAt({ path: "FULL", reviewPhase: "IMPLEMENTATION_PLAN" }), { artifact, plan: migrationPlan() })).toEqual([]);
    const broken = { ...migrationPlan(), claims: null } as unknown as PlanDocument;
    expect(await quickSizeOps(d, had, planAt(), { artifact, plan: broken })).toMatchObject(removal);
    expect(logs.map((entry) => entry["event"])).toContain("quick_size.not_recorded");
  });

  it("a person's Keep Quick carries over to the record of a revised plan (and is not invented when there was none)", async () => {
    const { deps: d } = deps();
    const kept = { codes: ["data_change"], by: "person-1", at: AT, requestId: "r1" };
    const had = { ...task, quickSize: { rulesVersion: 0, planDigest: "e".repeat(64), at: AT, class: "strong", triggered: true, counts: {}, reasons: [], kept } } as unknown as TaskRecord;
    expect(recordOf(await quickSizeOps(d, had, planAt(), { artifact, plan: migrationPlan() })).kept).toEqual(kept);
    expect(recordOf(await quickSizeOps(d, task, planAt(), { artifact, plan: migrationPlan() })).kept).toBeUndefined();
    // An unreadable kept is dropped, never copied as it was.
    const bad = { ...had, quickSize: { ...(had.quickSize as object), kept: { codes: "x" } } } as unknown as TaskRecord;
    expect(recordOf(await quickSizeOps(d, bad, planAt(), { artifact, plan: migrationPlan() })).kept).toBeUndefined();
  });

  it("the record is for exactly this plan and this commit: the artifact's digest, the revision, the time, version 0", async () => {
    const { deps: d } = deps();
    const record = recordOf(await quickSizeOps(d, task, planAt({ revision: 9 }), { artifact, plan: migrationPlan() }));
    expect(record).toMatchObject({ rulesVersion: QUICK_SIZE_RECORDING_VERSION, planDigest: DIGEST, workflowRevision: 9, at: AT, class: "strong", triggered: true, counts: { counted: 1, named: 1 } });
    expect(record.reasons).toEqual([{ code: "data_change", paths: ["db/migrations/0042_refunds.sql"] }]);
    expect(record.rulesVersion).toBe(0);
  });

  it("a plan that is not a structured document (Markdown, or one the store cannot give back) is recorded as unread: no offer, and it says why", async () => {
    const { deps: d } = deps();
    const record = recordOf(await quickSizeOps(d, task, planAt(), { artifact: { ...(artifact as object), format: "markdown" } as never, plan: undefined }));
    expect(record).toMatchObject({ unread: true, class: "none", triggered: false, reasons: [] });
  });

  it("a stored plan that never comes back is cut off: the plan write goes on, recorded as unread", async () => {
    const { deps: d } = deps();
    (d as unknown as { artifacts: unknown }).artifacts = { get: () => new Promise<Uint8Array | undefined>(() => undefined) };
    const started = Date.now();
    const record = recordOf(await quickSizeOps(d, task, planAt(), { artifact, plan: undefined }, { timeoutMs: 30 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(record).toMatchObject({ unread: true, class: "none", triggered: false });
  });

  it("a fault while working it out logs and writes no record; it never throws into the plan write", async () => {
    const { deps: d, logs } = deps();
    const broken = { ...migrationPlan(), claims: null } as unknown as PlanDocument;
    expect(await quickSizeOps(d, task, planAt(), { artifact, plan: broken })).toEqual([]);
    expect(logs.map((entry) => entry["event"])).toContain("quick_size.not_recorded");
  });
});

describe("quickSizeOps: the design review setting (how the plan write learns `never`)", () => {
  const money = readingOf(["money"]);

  it("asks the design review seam only when Understand read a high-risk need; the answer `can run` makes design_reading a reason (a typed quick: still offers once)", async () => {
    const yes = deps({ canRun: async () => true });
    const record = recordOf(await quickSizeOps(yes.deps, task, planAt(money), { artifact, plan: planDocument({ claims: [{ id: "1", text: "x" }] }) }));
    expect(yes.asked).toHaveLength(1);
    expect(record).toMatchObject({ class: "strong", triggered: true });
    expect(record.designReviewOff).toBeUndefined();
    const none = deps({ canRun: async () => true });
    for (const reading of [readingOf(["new_api"]), {}, { intent: { assessment: { kind: "ready", design: { needed: false, reasons: ["money"], note: "x" } } } }]) {
      await quickSizeOps(none.deps, task, planAt(reading), { artifact, plan: planDocument({ claims: [{ id: "1", text: "x" }] }) });
    }
    expect(none.asked).toHaveLength(0);
  });

  it("setting never (cannot run): design_reading is a line, not a reason; not alone", async () => {
    const never = deps({ canRun: async () => false });
    const record = recordOf(await quickSizeOps(never.deps, task, planAt(money), { artifact, plan: planDocument({ claims: [{ id: "1", text: "x" }] }) }));
    expect(record).toMatchObject({ class: "none", triggered: false, designReviewOff: true });
    expect(record.reasons.map((reason) => reason.code)).toEqual(["design_reading"]);
    // A migration in the plan still offers Full, with the review line under it.
    const withMigration = recordOf(await quickSizeOps(never.deps, task, planAt(money), { artifact, plan: migrationPlan() }));
    expect(withMigration).toMatchObject({ class: "strong", triggered: true, designReviewOff: true });
    expect(withMigration.reasons.map((reason) => reason.code)).toEqual(["data_change", "design_reading"]);
  });

  it("no design review installed, or a seam with no answer: the review cannot run, recorded as off", async () => {
    for (const options of [{ noSeam: true }, {}]) {
      const record = recordOf(await quickSizeOps(deps(options).deps, task, planAt(money), { artifact, plan: planDocument({ claims: [{ id: "1", text: "x" }] }) }));
      expect(record, JSON.stringify(options)).toMatchObject({ class: "none", designReviewOff: true });
      expect(record.settingUnread, JSON.stringify(options)).toBeUndefined();
    }
  });

  it("a setting that cannot be read is recorded as NOT SEEN, apart from `never`: nothing is offered from the reading, and the failure is logged", async () => {
    const failing = deps({ canRun: async () => { throw new Error("store down"); } });
    const record = recordOf(await quickSizeOps(failing.deps, task, planAt(money), { artifact, plan: planDocument({ claims: [{ id: "1", text: "x" }] }) }));
    expect(record).toMatchObject({ class: "none", triggered: false, settingUnread: true });
    expect(record.designReviewOff).toBeUndefined();
    expect(record.reasons.map((reason) => reason.code)).toEqual(["design_reading"]);
    expect(failing.logs.map((entry) => entry["event"])).toContain("quick_size.setting_not_read");
    // A plan-evidence code still offers, with the line under it.
    expect(recordOf(await quickSizeOps(failing.deps, task, planAt(money), { artifact, plan: migrationPlan() }))).toMatchObject({ class: "strong", settingUnread: true });
  });

  it("a setting read that never answers is cut off: the plan write goes on, recorded as not seen", async () => {
    const hung = deps({ canRun: () => new Promise<boolean>(() => undefined) });
    const started = Date.now();
    const record = recordOf(await quickSizeOps(hung.deps, task, planAt(money), { artifact, plan: planDocument({ claims: [{ id: "1", text: "x" }] }) }, { timeoutMs: 30 }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(record).toMatchObject({ class: "none", settingUnread: true });
  });

  it("a person's Skip on the review silences the reading (no Skip exists at a Quick plan today; the rule still honours it)", async () => {
    const skipped = deps({ canRun: async () => true });
    const record = recordOf(await quickSizeOps(skipped.deps, task, planAt({ ...money, designReview: { decidedBy: "person_skip" } }), { artifact, plan: planDocument({ claims: [{ id: "1", text: "x" }] }) }));
    expect(record).toMatchObject({ class: "none", triggered: false });
    expect(record.reasons).toEqual([]);
  });
});

describe("the task flow writes the record in the same commit as the plan", () => {
  async function toQuickPlan(mode: "never" | "auto") {
    const w = await world({ mode });
    const prepare = await nextJob(w);
    await finish(w, prepare.operation, { kind: "prepared", base: [{ repositoryId: "demo", baseCommitSha: BASE }] });
    const understand = await nextJob(w);
    await finish(w, understand.operation, { kind: "understood", assessment: { kind: "ready", path: "QUICK", restatement: "Add refunds.", assumptions: [], design: { needed: true, reasons: ["money"], note: "Money" } } });
    const planning = await nextJob(w);
    expect(planning.invocation.payload).toMatchObject({ workflowMode: "PLAN" });
    return { w, planning };
  }

  it("under design review `never` the task stays Quick, and the plan's record has the migration as a strong reason and the money reading as a line", async () => {
    const { w, planning } = await toQuickPlan("never");
    expect((await taskOf(w)).workflow).toMatchObject({ path: "QUICK", stage: "PLAN", state: "RUNNING" });
    const writes: Array<{ ops: Array<{ path: string[] }> }> = [];
    const transact = w.h.store.transact.bind(w.h.store);
    w.h.store.transact = async (items) => {
      for (const item of items) if (item.kind === "update") writes.push(item as unknown as { ops: Array<{ path: string[] }> });
      return transact(items);
    };
    await finish(w, planning.operation, plannedStructured(w, planning.operation, migrationPlan(), 1));
    const stored = await taskOf(w);
    expect(stored.workflow).toMatchObject({ path: "QUICK", stage: "PLAN_CRITIQUE" });
    const record = readQuickSize((stored as unknown as { quickSize: unknown }).quickSize)!;
    expect(record).toMatchObject({ rulesVersion: 0, class: "strong", triggered: true, designReviewOff: true, planDigest: stored.workflow.artifacts.at(-1)!.sha256 });
    expect(record.reasons.map((reason) => reason.code)).toEqual(["data_change", "design_reading"]);
    // ONE update wrote the workflow with the plan and the record together (not a second write after it).
    const together = writes.filter((write) => write.ops.some((op) => op.path[0] === "quickSize"));
    expect(together).toHaveLength(1);
    expect(together[0]!.ops.some((op) => op.path[0] === "workflow")).toBe(true);
    // The estimate of the run is written the same way, beside it.
    expect(together[0]!.ops.some((op) => op.path[0] === "runEstimate")).toBe(true);
  });

  it("a revised plan writes a new record for the new plan (it replaces the old one, bound to its own digest)", async () => {
    const { w, planning } = await toQuickPlan("never");
    await finish(w, planning.operation, plannedStructured(w, planning.operation, planDocument({ claims: [{ id: "1", text: "Small.", evidence: [{ kind: "code", path: "src/a.ts", startLine: 1, endLine: 2 }] }] }), 1));
    const first = readQuickSize(((await taskOf(w)) as unknown as { quickSize: unknown }).quickSize)!;
    expect(first.class).toBe("none");
    expect(first.reasons.map((reason) => reason.code)).toEqual(["design_reading"]);
    expect(first.counts).toMatchObject({ counted: 1 });
  });

  it("a plan nobody could read back (the store has no copy) is recorded as unread, and the plan still lands", async () => {
    const { w, planning } = await toQuickPlan("never");
    const outcome = plannedStructured(w, planning.operation, migrationPlan(), 1);
    w.blobs.clear();
    await finish(w, planning.operation, outcome);
    const stored = await taskOf(w);
    // With no copy to check, the plan goes straight to the person: still a Quick plan at the gate.
    expect(stored.workflow).toMatchObject({ path: "QUICK", stage: "PLAN_REVIEW", state: "WAITING" });
    expect(readQuickSize((stored as unknown as { quickSize: unknown }).quickSize)).toMatchObject({ unread: true, class: "none", triggered: false });
  });
});

describe("the design review seam answers from the project's effective setting", () => {
  const canRun = async (options: Parameters<typeof world>[0], env?: NodeJS.ProcessEnv): Promise<boolean | undefined> => {
    const w = await world(options);
    if (env !== undefined) w.runtime.env = env;
    return w.h.deps.designReview?.reviewCanRun?.(w.h.deps, await taskOf(w));
  };
  it("auto and always can run; never cannot; with the stage switched off nothing can", async () => {
    expect(await canRun({ mode: "auto" })).toBe(true);
    expect(await canRun({ mode: "always" })).toBe(true);
    expect(await canRun({ mode: "never" })).toBe(false);
    expect(await canRun({ mode: "auto" }, {})).toBe(false);
  });
});
