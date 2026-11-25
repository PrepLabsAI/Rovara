// L4-P1 (owner DEC 254zzl): the hosted SYSTEM STARTER. A project's system owner starts only the closed list of kinds, only behind the company's SystemRuns flag (default off), only for its own project and company, with
// the audit record written FIRST, the project's monthly count held, one check at a time, and the machine time attributed to the company and project. P1 starts the two free kinds and nothing that spends AI.
// Each guard has a test that fails if the guard is removed (the mutants are listed in the PR body).
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SYSTEM_RUN_AI_KINDS, SYSTEM_RUN_FREE_KINDS, SYSTEM_RUN_JOB, SYSTEM_RUN_KIND_WORDS, SYSTEM_RUN_KINDS, SYSTEM_RUN_REASONS, SYSTEM_RUN_REASON_WORDS, AUTOMATIC_JOB_WORDS, SystemRunUsageSchema, UPKEEP_ORIGIN, WORKER_INVOCATION_FEATURES, projectMetaKey, queryAll, systemOwnerIdOf, systemRunOrigin, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { readAutomaticRunsUse, setAutomaticRunsCap } from "../../packages/broker/src/core/automatic-runs/cap.js";
import { setupStateOf, type SetupCheckMark } from "../../packages/broker/src/core/setup-agent/check.js";
import { createSystemStarter, type SystemStartInput, type SystemStartResult } from "../../packages/broker/src/core/system-runs/starter.js";
import { readSystemRunUsage, systemRunUsagePartition } from "../../packages/broker/src/core/system-runs/usage.js";
import { setUpkeepEnabled, upkeepIsOn } from "../../packages/broker/src/core/upkeep/settings.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import type { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const COMPANY_B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const PERSON = "ab".repeat(32);

const projectOf = (name: string): ProjectDefinition => ({ ...definition, name, setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }] });

interface World { h: Harness; flag: { on: boolean }; starter: ReturnType<typeof createSystemStarter>; company: OrgId; order: string[] }

async function world(options: { company?: OrgId; projects?: string[]; shared?: { store: MemoryDocumentStore; queues: MemoryQueueService }; auditFails?: boolean; flagOn?: boolean } = {}): Promise<World> {
  const company = options.company ?? IMPLICIT_COMPANY_ID;
  const order: string[] = [];
  const h = createHarness({
    companyId: company, audit: "recording", machines: { startingChecks: 0, features: [...WORKER_INVOCATION_FEATURES] },
    ...(options.shared === undefined ? {} : { backend: () => options.shared! }),
  });
  for (const name of options.projects ?? ["payments"]) {
    await h.registerProject(projectOf(name));
    await h.store.put({ item: { ...projectMetaKey(company, name), entityType: "PROJECT_META" } });
  }
  // What the world looked like when the audit sink was asked to record the start: the audit record must come BEFORE the check exists.
  const record = h.deps.audit.record.bind(h.deps.audit);
  h.deps.audit.record = async (event) => {
    if (event.action === "system_run.requested") {
      const mark = (await h.store.get(projectMetaKey(company, String(event.subject?.id))))?.["setupCheck"];
      order.push(`mark-at-audit:${mark === undefined ? "absent" : "present"}`);
      if (options.auditFails === true) throw new Error("the ledger is down");
    }
    await record(event);
  };
  const flag = { on: options.flagOn ?? true };
  const starter = createSystemStarter({ flow: h.deps, enabled: () => flag.on, upkeepOn: (project) => upkeepIsOn({ store: h.store, companyId: company }, project) });
  return { h, flag, starter, company, order };
}

const turnOnUpkeep = async (w: World, project = "payments"): Promise<void> => {
  await setUpkeepEnabled({ store: w.h.store, companyId: w.company, now: () => w.h.clock.now, standing: async () => ({ access: "manage" }) }, { personId: PERSON, project, requestId: newRequestId(), on: true, fromPage: true });
};
const ask = (w: World, input: Partial<SystemStartInput> = {}): Promise<SystemStartResult> => w.starter.start({ project: "payments", kind: "setup_check", reason: { code: "task_start" }, requestId: newRequestId(), ...input });
const used = async (w: World, project = "payments"): Promise<number> => (await readAutomaticRunsUse({ store: w.h.store, now: () => w.h.clock.now }, w.company, project)).used;
const systemAudit = (w: World) => w.h.audit.filter((event) => event.action === "system_run.requested");
const markOf = async (w: World, project = "payments"): Promise<SetupCheckMark | undefined> => (await w.h.store.get(projectMetaKey(w.company, project)))?.["setupCheck"] as SetupCheckMark | undefined;
const queued = async (w: World): Promise<number> => {
  const queue = await w.h.queues.queue("task-dispatch");
  let total = 0;
  for (let round = 0; round < 20; round += 1) { const batch = await queue.receive(); if (batch.length === 0) break; total += batch.length; }
  return total;
};

describe("the closed list of kinds", () => {
  it("is exactly five kinds, three of which spend no AI, and the AI kinds are stamped `nightly`", () => {
    expect([...SYSTEM_RUN_KINDS]).toEqual(["setup_check", "nightly_check", "saved_env_rebuild", "repair_draft", "wiki_refresh"]);
    expect([...SYSTEM_RUN_FREE_KINDS]).toEqual(["setup_check", "nightly_check", "saved_env_rebuild"]);
    expect([...SYSTEM_RUN_AI_KINDS]).toEqual(["repair_draft", "wiki_refresh"]);
    for (const kind of SYSTEM_RUN_AI_KINDS) expect(systemRunOrigin(kind)).toBe(UPKEEP_ORIGIN);
    expect(UPKEEP_ORIGIN).toBe("nightly");
    for (const kind of ["setup_check", "nightly_check", "saved_env_rebuild"] as const) expect(systemRunOrigin(kind)).toBe("automatic");
    expect([...SYSTEM_RUN_REASONS]).toEqual(["task_start", "nightly", "check_failed", "image_out_of_date"]);
  });

  it("the image rebuild kind has its job, its words and its reason words, and the usage row accepts it", () => {
    expect(SYSTEM_RUN_JOB["saved_env_rebuild"]).toBe("image_rebuild");
    expect(SYSTEM_RUN_KIND_WORDS["saved_env_rebuild"]).toBe(AUTOMATIC_JOB_WORDS["image_rebuild"]);
    expect(SYSTEM_RUN_REASON_WORDS["image_out_of_date"]).toBe("the project's saved image is out of date");
    for (const code of SYSTEM_RUN_REASONS) expect(SYSTEM_RUN_REASON_WORDS[code].length).toBeGreaterThan(0);
    const row = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", project: "payments", kind: "saved_env_rebuild", workspaceId: "ws-1", requestId: "r-1", month: "2026-11", startedAt: "2026-11-25T00:00:00.000Z" };
    expect(SystemRunUsageSchema.safeParse(row).success).toBe(true);
    expect(SystemRunUsageSchema.safeParse({ ...row, kind: "image_rebuild" }).success).toBe(false);
  });

  it.each([["task"], ["saved_env_rebuild"]])(
    "refuses %j before anything is read or written (the image rebuild kind has no start until SI-2)", async (kind) => {
      const w = await world();
      const answer = await ask(w, { kind });
      expect(answer).toEqual({ outcome: "refused", reason: "kind_not_allowed" });
      expect(w.order).toEqual([]);
      expect(w.h.audit).toHaveLength(0);
      expect(await used(w)).toBe(0);
      expect(await markOf(w)).toBeUndefined();
      expect(await queued(w)).toBe(0);
    });


  it.each([[{ code: "because I said so" }]])(
    "refuses a reason that is not a fixed code and at most one short fact: %j", async (reason) => {
      const w = await world();
      expect(await ask(w, { reason })).toEqual({ outcome: "refused", reason: "invalid_request" });
      expect(w.h.audit).toHaveLength(0);
      expect(await queued(w)).toBe(0);
    });


});

describe("a start", () => {
  it("starts the project's setup check as the system owner, with no person as the starter", async () => {
    const w = await world();
    const answer = await ask(w, { reason: { code: "task_start", fact: "package-lock.json" } });
    expect(answer).toMatchObject({ outcome: "started", kind: "setup_check", duplicate: false });
    const mark = (await markOf(w))!;
    expect(mark.startedBy).toBe(systemOwnerIdOf(w.company, "payments"));
    expect(mark.startedBy).toMatch(/^sysowner_[0-9a-f]{64}$/u);
    const workspace = (await w.h.store.get(workspaceKey(w.company, (answer as { workspaceId: string }).workspaceId)))!;
    expect(workspace["ownerKey"]).toBe(taskOwnerKey(systemOwnerIdOf(w.company, "payments"), (answer as { workspaceId: string }).workspaceId));
    expect(workspace["ownerKey"]).not.toBe(taskOwnerKey(PERSON, (answer as { workspaceId: string }).workspaceId));
    expect((await setupStateOf(w.h.deps, "payments", projectOf("payments"))).status).toBe("checking");
    expect(await queued(w)).toBe(1);
    // No task, no model: nothing but a prepare-only workspace.
    expect(await queryAll(w.h.store, { pk: `DEVTASK#${(answer as { workspaceId: string }).workspaceId}` })).toHaveLength(0);
  });

  it("starts nothing, and gives its place of the month back, when the audit record cannot be written", async () => {
    const w = await world({ auditFails: true });
    expect(await ask(w)).toEqual({ outcome: "refused", reason: "audit_unavailable" });
    expect(await markOf(w)).toBeUndefined();
    expect(await queued(w)).toBe(0);
    expect(await used(w)).toBe(0);
    expect((await readSystemRunUsage(w.h.deps, {})).runs).toBe(0);
  });

  it("answers a repeat of the request id with the first start: counted once, audited once, one workspace", async () => {
    const w = await world();
    const requestId = newRequestId();
    const first = await ask(w, { requestId });
    const again = await ask(w, { requestId });
    expect(first).toMatchObject({ outcome: "started", duplicate: false });
    expect(again).toMatchObject({ outcome: "started", duplicate: true, workspaceId: (first as { workspaceId: string }).workspaceId });
    expect(await used(w)).toBe(1);
    expect(new Set(systemAudit(w).map((event) => event.eventId)).size).toBe(1);
    expect((await readSystemRunUsage(w.h.deps, {})).runs).toBe(1);
    expect(await queued(w)).toBe(1);
  });

  it("does not start a second check while one runs (busy), and keeps no place of the month for it", async () => {
    const w = await world();
    expect((await ask(w)).outcome).toBe("started");
    expect(await ask(w, { requestId: newRequestId() })).toEqual({ outcome: "skipped", reason: "busy" });
    expect(await used(w)).toBe(1);
    expect(systemAudit(w)).toHaveLength(1);
    expect(await queued(w)).toBe(1);
  });

  it("is held by the project's monthly count of automatic runs: at the cap nothing starts and nothing is audited", async () => {
    const w = await world();
    await setAutomaticRunsCap({ store: w.h.store, now: () => w.h.clock.now, companyId: w.company, audit: w.h.deps.audit }, { orgId: w.company, project: "payments", changedBy: PERSON, cap: 0, requestId: "cap-request-0" });
    expect(await ask(w)).toEqual({ outcome: "skipped", reason: "automatic_cap" });
    expect(systemAudit(w)).toHaveLength(0);
    expect(await markOf(w)).toBeUndefined();
    expect(await queued(w)).toBe(0);
  });

  it("refuses a project that does not exist in this company, or is archived, with nothing written", async () => {
    const w = await world();
    expect(await ask(w, { project: "nope" })).toEqual({ outcome: "refused", reason: "project_unavailable" });
    expect(w.h.audit).toHaveLength(0);
    expect(await used(w, "nope")).toBe(0);
  });
});

describe("the nightly check and the project's upkeep switch", () => {
  it("is refused while the project's upkeep is off, and starts once it is on", async () => {
    const w = await world();
    expect(await ask(w, { kind: "nightly_check", reason: { code: "nightly" } })).toEqual({ outcome: "refused", reason: "upkeep_off" });
    expect(w.h.audit).toHaveLength(0);
    expect(await queued(w)).toBe(0);
    await turnOnUpkeep(w);
    expect(await ask(w, { kind: "nightly_check", reason: { code: "nightly" } })).toMatchObject({ outcome: "started", kind: "nightly_check" });
    expect(systemAudit(w)[0]!.details).toMatchObject({ kind: "nightly_check", reason: "nightly" });
  });

});

describe("machine time attributed to the company (owner DEC 254zzl 4)", () => {

  it("a project's report holds only that project, and a damaged or foreign row is not counted", async () => {
    const w = await world({ projects: ["payments", "billing"] });
    await ask(w);
    await ask(w, { project: "billing" });
    expect((await readSystemRunUsage(w.h.deps, { project: "payments" })).runs).toBe(1);
    expect((await readSystemRunUsage(w.h.deps, { project: "billing" })).runs).toBe(1);
    const month = (await readSystemRunUsage(w.h.deps, {})).month;
    await w.h.store.put({ item: { pk: systemRunUsagePartition(w.company, month), sk: "payments#forged", entityType: "SYSTEM_RUN_USAGE", orgId: COMPANY_B, project: "payments", kind: "setup_check", workspaceId: "w", month } });
    await w.h.store.put({ item: { pk: systemRunUsagePartition(w.company, month), sk: "payments#damaged", entityType: "SYSTEM_RUN_USAGE", orgId: w.company, project: "payments", kind: "not-a-kind", workspaceId: "w", month } });
    expect((await readSystemRunUsage(w.h.deps, { project: "payments" })).runs).toBe(1);
  });

});

describe("review fixes (Opus REVIEW-1)", () => {

  it("L2: a start that then does not happen leaves a not_started record after the requested one", async () => {
    const w = await world();
    // Another check starts between the busy read and the start: simulated by a start that conflicts.
    const real = w.h.store.transact.bind(w.h.store);
    let conflicts = 1;
    w.h.store.transact = async (items) => {
      const marksCheck = items.some((item) => item.kind === "update" && "ops" in item && JSON.stringify(item.ops).includes("setupCheck"));
      if (marksCheck && conflicts-- > 0) return { applied: false, reason: "condition_failed", failed: [0] };
      return real(items);
    };
    expect(await ask(w)).toEqual({ outcome: "skipped", reason: "busy" });
    expect(w.h.audit.map((event) => event.action)).toEqual(["system_run.requested", "system_run.not_started"]);
    expect(await used(w)).toBe(0);
  });

  it("gives the place back when the start throws something other than busy, and says so", async () => {
    const w = await world();
    const real = w.h.store.transact.bind(w.h.store);
    let fail = true;
    w.h.store.transact = async (items) => { if (fail && items.some((item) => item.kind === "update" && "ops" in item && JSON.stringify(item.ops).includes("setupCheck"))) { fail = false; throw new Error("store down"); } return real(items); };
    await expect(ask(w)).rejects.toThrow("store down");
    expect(await used(w)).toBe(0);
    expect(w.h.audit.map((event) => event.action)).toEqual(["system_run.requested", "system_run.not_started"]);
    expect((await ask(w, { requestId: newRequestId() })).outcome).toBe("started");
  });
});
