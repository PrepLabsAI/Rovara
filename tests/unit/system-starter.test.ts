// L4-P1 (owner DEC 254zzl): the hosted SYSTEM STARTER. A project's system owner starts only the closed list of kinds, only behind the company's SystemRuns flag (default off), only for its own project and company, with
// the audit record written FIRST, the project's monthly count held, one check at a time, and the machine time attributed to the company and project. P1 starts the two free kinds and nothing that spends AI.
// Each guard has a test that fails if the guard is removed (the mutants are listed in the PR body).
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, SYSTEM_RUN_AI_KINDS, change, SYSTEM_RUN_KINDS, SYSTEM_RUN_REASONS, UPKEEP_ORIGIN, WORKER_INVOCATION_FEATURES, projectMetaKey, queryAll, systemOwnerIdOf, systemRunOrigin,
  type OrgId, type ProjectDefinition,
} from "@agentx/contracts";
import { readAutomaticRunsUse, setAutomaticRunsCap } from "../../packages/broker/src/core/automatic-runs/cap.js";
import { setupStateOf, startProjectSetupCheck, type SetupCheckMark } from "../../packages/broker/src/core/setup-agent/check.js";
import { createSystemStarter, systemRunRequestId, type SystemStartInput, type SystemStartResult } from "../../packages/broker/src/core/system-runs/starter.js";
import { readSystemRunUsage, recordSystemRunUsage, systemRunUsagePartition } from "../../packages/broker/src/core/system-runs/usage.js";
import { setUpkeepEnabled, upkeepIsOn } from "../../packages/broker/src/core/upkeep/settings.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createHarness, definition, newRequestId, type Harness } from "../support/task-flow-harness.js";

const COMPANY_B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PERSON = "ab".repeat(32);

const projectOf = (name: string): ProjectDefinition => ({ ...definition, name, setup: [{ cwd: "repo/demo", executable: "npm", args: ["ci"], timeoutSeconds: 60 }], readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 60 }] } as ProjectDefinition);

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
  it("is exactly four kinds, two of which spend no AI, and the AI kinds are stamped `nightly`", () => {
    expect([...SYSTEM_RUN_KINDS]).toEqual(["setup_check", "nightly_check", "repair_draft", "wiki_refresh"]);
    expect([...SYSTEM_RUN_AI_KINDS]).toEqual(["repair_draft", "wiki_refresh"]);
    for (const kind of SYSTEM_RUN_AI_KINDS) expect(systemRunOrigin(kind)).toBe(UPKEEP_ORIGIN);
    expect(UPKEEP_ORIGIN).toBe("nightly");
    for (const kind of ["setup_check", "nightly_check"] as const) expect(systemRunOrigin(kind)).toBe("automatic");
    expect([...SYSTEM_RUN_REASONS]).toEqual(["task_start", "nightly", "check_failed"]);
  });

  it.each([["task"], ["quick_task"], ["ask"], ["free text: delete everything"], [""], ["setup_check "], ["SETUP_CHECK"], [5], [null], [undefined], [{ kind: "setup_check" }], [["setup_check"]]])(
    "refuses %j before anything is read or written", async (kind) => {
      const w = await world();
      const answer = await ask(w, { kind });
      expect(answer).toEqual({ outcome: "refused", reason: "kind_not_allowed" });
      expect(w.order).toEqual([]);
      expect(w.h.audit).toHaveLength(0);
      expect(await used(w)).toBe(0);
      expect(await markOf(w)).toBeUndefined();
      expect(await queued(w)).toBe(0);
    });

  it.each([["repair_draft"], ["wiki_refresh"]])("refuses the AI kind %s in P1, flag on or not, and writes nothing", async (kind) => {
    const w = await world();
    await turnOnUpkeep(w);
    expect(await ask(w, { kind })).toEqual({ outcome: "refused", reason: "kind_not_allowed" });
    expect(w.h.audit).toHaveLength(0);
    expect(await queued(w)).toBe(0);
  });

  it.each([[{ code: "because I said so" }], [{ code: "task_start", extra: "x" }], [{ code: "task_start", fact: "a b; rm -rf /" }], ["nightly"], [undefined], [{ fact: "package-lock.json" }]])(
    "refuses a reason that is not a fixed code and at most one short fact: %j", async (reason) => {
      const w = await world();
      expect(await ask(w, { reason })).toEqual({ outcome: "refused", reason: "invalid_request" });
      expect(w.h.audit).toHaveLength(0);
      expect(await queued(w)).toBe(0);
    });

  it.each([["not-a-uuid"], [""], ["00000000-0000-0000-0000-00000000000g"]])("refuses a request id that is not a UUID: %j", async (requestId) => {
    const w = await world();
    expect(await ask(w, { requestId })).toEqual({ outcome: "refused", reason: "invalid_request" });
    expect(await queued(w)).toBe(0);
  });

  it.each([["../payments"], ["a b"], [""], ["x".repeat(200)]])("refuses a project that is not a project name: %j", async (project) => {
    const w = await world();
    expect(await ask(w, { project })).toEqual({ outcome: "refused", reason: "invalid_request" });
  });
});

describe("the SystemRuns flag (default off)", () => {
  it("off: nothing is read, written or started, for either free kind", async () => {
    const w = await world({ flagOn: false });
    await turnOnUpkeep(w);
    for (const kind of ["setup_check", "nightly_check"] as const) expect(await ask(w, { kind })).toEqual({ outcome: "refused", reason: "system_runs_off" });
    expect(w.h.audit).toHaveLength(0);
    expect(w.order).toEqual([]);
    expect(await used(w)).toBe(0);
    expect(await markOf(w)).toBeUndefined();
    expect(await queued(w)).toBe(0);
    expect((await readSystemRunUsage(w.h.deps, {})).runs).toBe(0);
  });

  it("is read on every start: turned on it starts, turned off again it stops", async () => {
    const w = await world({ flagOn: false });
    expect((await ask(w)).outcome).toBe("refused");
    w.flag.on = true;
    expect((await ask(w)).outcome).toBe("started");
    w.flag.on = false;
    expect(await ask(w, { requestId: newRequestId() })).toEqual({ outcome: "refused", reason: "system_runs_off" });
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

  it("writes the audit record FIRST, as the system owner, with the fixed reason and its fact", async () => {
    const w = await world();
    await ask(w, { reason: { code: "task_start", fact: "package-lock.json" } });
    expect(w.order).toEqual(["mark-at-audit:absent"]);
    expect(await markOf(w)).toBeDefined();
    const [event] = systemAudit(w);
    expect(systemAudit(w)).toHaveLength(1);
    expect(event).toMatchObject({ actor: { type: "system", id: systemOwnerIdOf(w.company, "payments") }, action: "system_run.requested", subject: { type: "project", id: "payments" }, details: { kind: "setup_check", reason: "task_start", fact: "package-lock.json" } });
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

  it("two projects: one project's switch never starts another's night", async () => {
    const w = await world({ projects: ["payments", "billing"] });
    await turnOnUpkeep(w, "billing");
    expect(await ask(w, { project: "payments", kind: "nightly_check", reason: { code: "nightly" } })).toEqual({ outcome: "refused", reason: "upkeep_off" });
    expect(await ask(w, { project: "billing", kind: "nightly_check", reason: { code: "nightly" } })).toMatchObject({ outcome: "started" });
    expect((await markOf(w, "billing"))!.startedBy).toBe(systemOwnerIdOf(w.company, "billing"));
    expect(await markOf(w, "payments")).toBeUndefined();
    expect(systemOwnerIdOf(w.company, "billing")).not.toBe(systemOwnerIdOf(w.company, "payments"));
  });

  it("the free setup check does not need the upkeep switch (the re-check has no off switch for customers)", async () => {
    const w = await world();
    expect(await ask(w, { kind: "setup_check" })).toMatchObject({ outcome: "started" });
  });
});

describe("two companies on one store", () => {
  it("never meet: the same project name, two system owners, two counts, two usage reports", async () => {
    const shared = { store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES }), queues: new MemoryQueueService({ now: () => Date.now() }) };
    const a = await world({ company: IMPLICIT_COMPANY_ID, shared });
    const b = await world({ company: COMPANY_B, shared });
    expect((await ask(a)).outcome).toBe("started");
    expect(await used(a)).toBe(1);
    expect(await used(b)).toBe(0);
    expect((await readSystemRunUsage(a.h.deps, {})).runs).toBe(1);
    expect((await readSystemRunUsage(b.h.deps, {})).runs).toBe(0);
    expect(systemOwnerIdOf(IMPLICIT_COMPANY_ID, "payments")).not.toBe(systemOwnerIdOf(COMPANY_B, "payments"));
    expect((await markOf(b))?.startedBy).toBeUndefined();
    expect((await ask(b)).outcome).toBe("started");
    expect((await markOf(b))!.startedBy).toBe(systemOwnerIdOf(COMPANY_B, "payments"));
    expect((await markOf(a))!.startedBy).toBe(systemOwnerIdOf(IMPLICIT_COMPANY_ID, "payments"));
    // A's flag off does not stop B, and B's project is not A's.
    a.flag.on = false;
    expect((await ask(a, { requestId: newRequestId() })).outcome).toBe("refused");
  });

  it("a project of another company is not this company's project", async () => {
    const shared = { store: new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES }), queues: new MemoryQueueService({ now: () => Date.now() }) };
    const a = await world({ company: IMPLICIT_COMPANY_ID, shared, projects: ["payments"] });
    await world({ company: COMPANY_B, shared, projects: ["only-in-b"] });
    expect(await ask(a, { project: "only-in-b" })).toEqual({ outcome: "refused", reason: "project_unavailable" });
  });
});

describe("machine time attributed to the company (owner DEC 254zzl 4)", () => {
  it("writes one row per run under the company's month and the project, and measures minutes from the run's own workspace", async () => {
    const w = await world({ projects: ["payments", "billing"] });
    const started = (await ask(w)) as { workspaceId: string };
    await ask(w, { project: "billing" });
    const report = await readSystemRunUsage(w.h.deps, {});
    expect(report).toMatchObject({ runs: 2, byProject: { payments: { runs: 1 }, billing: { runs: 1 } }, byKind: { setup_check: { runs: 2 } } });
    const rows = await queryAll(w.h.store, { pk: systemRunUsagePartition(w.company, report.month) });
    expect(rows.map((row) => row["project"]).sort()).toEqual(["billing", "payments"]);
    expect(rows.every((row) => row["orgId"] === w.company && row["workspaceId"] !== undefined)).toBe(true);
    // 125 seconds later the open workspace has run for 3 started minutes; the number is measured, nobody states it.
    w.h.clock.advance(125);
    expect((await readSystemRunUsage(w.h.deps, { project: "payments" })).minutes).toBe(3);
    // Closed: it counts to the close, not to now.
    const key = workspaceKey(w.company, started.workspaceId);
    await w.h.store.update({ key, ops: [change.set("closedAt", new Date(w.h.clock.now - 60_000).toISOString())] });
    expect((await readSystemRunUsage(w.h.deps, { project: "billing" })).minutes).toBe(3);
  });

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

  it("rejects a usage row for a kind outside the closed list", async () => {
    const w = await world();
    await expect(recordSystemRunUsage(w.h.deps, { project: "payments", kind: "free_text" as never, workspaceId: "w", requestId: newRequestId() })).rejects.toThrow();
  });
});

describe("request ids", () => {
  it("are stable per night and project, and differ per company, project, kind and day", () => {
    const base = systemRunRequestId("org_a", "payments", "nightly_check", "2026-11-18");
    expect(base).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(systemRunRequestId("org_a", "payments", "nightly_check", "2026-11-18")).toBe(base);
    for (const other of [["org_b", "payments", "nightly_check", "2026-11-18"], ["org_a", "billing", "nightly_check", "2026-11-18"], ["org_a", "payments", "setup_check", "2026-11-18"], ["org_a", "payments", "nightly_check", "2026-11-19"]] as const) expect(systemRunRequestId(...other)).not.toBe(base);
  });
});

describe("review fixes (Opus REVIEW-1)", () => {
  it("L1: a person's request id never blocks the night: system starts keep their ids in a namespace of their own", async () => {
    const w = await world();
    await turnOnUpkeep(w);
    const night = systemRunRequestId(w.company, "payments", "nightly_check", "2026-11-18");
    // A manager posts tomorrow's (public, deterministic) id first, as a person.
    await startProjectSetupCheck(w.h.deps, { project: "payments", requestId: night, startedBy: PERSON });
    w.h.clock.advance(60 * 60);
    await w.h.store.update({ key: projectMetaKey(w.company, "payments"), ops: [change.remove("setupCheck")] });
    const answer = await ask(w, { kind: "nightly_check", reason: { code: "nightly" }, requestId: night });
    expect(answer).toMatchObject({ outcome: "started" });
    expect((await markOf(w))!.startedBy).toBe(systemOwnerIdOf(w.company, "payments"));
  });

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
