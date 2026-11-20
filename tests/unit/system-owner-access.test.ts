// L4-P1 (owner DEC 254zzl 1): the hosted access rule for a project's SYSTEM OWNER, at the start and at every step. The system owner is accepted ONLY for a listed system purpose, ONLY for its own project and company, and
// ONLY while the company's SystemRuns flag is on; members' rules are unchanged. P1 accepts the free purpose (the model-free nightly run); the AI purposes (a repair draft is a `setup_agent` task, a wiki refresh a
// `wiki_build` task) are named and refused until P2. Each guard has a test that fails if it is removed (mutants in the PR body).
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SYSTEM_OWNER_PROVIDER, systemOwnerIdOf, type OrgId, type OrgRole, type Principal } from "@agentx/contracts";
import { NO_PROJECT_GRANT, NOT_A_MEMBER_HERE, hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { SYSTEM_OWNER_NOT_ALLOWED, SYSTEM_RUN_KINDS_LIVE, SYSTEM_TASK_PURPOSES, liveSystemKindOf, systemPrincipalOf } from "../../packages/broker/src/core/system-runs/access.js";
import { developerIdOf } from "../../packages/broker/src/core/sessions/create.js";
import { setupAgentKey } from "../../packages/broker/src/core/setup-agent/keys.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const A: OrgId = IMPLICIT_COMPANY_ID;
const B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const MEMBER = "11".repeat(32);
const OUTSIDER = "22".repeat(32);

interface World { access: ReturnType<typeof hostedTaskAccess>; store: MemoryDocumentStore; flag: { on: boolean }; membershipCalls: string[] }

function world(company: OrgId = A): World {
  const store = new MemoryDocumentStore();
  const flag = { on: true };
  const membershipCalls: string[] = [];
  const access = hostedTaskAccess({
    companyId: company, storage: async () => store, systemRunsOn: () => flag.on,
    membershipOf: async (personId) => { membershipCalls.push(personId); return personId === MEMBER ? { companyId: company, role: "member" as OrgRole } : undefined; },
    projectGrant: async (personId, project) => personId === MEMBER && project === "payments",
  });
  return { access, store, flag, membershipCalls };
}

const principalOf = (company: OrgId, project: string): Principal => systemPrincipalOf(company, project, `Rovara (project: ${project})`);
async function putTask(w: World, taskId: string, fields: Record<string, unknown>): Promise<void> {
  await w.store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", ...fields } });
}
const systemTask = (company: OrgId, project: string, purpose: string) => ({ companyId: company, developerId: systemOwnerIdOf(company, project), project, purpose });

describe("the closed table", () => {
  it("names three purposes; the free one and the two AI ones (the wiki refresh, the repair draft) are live, each AI one behind its marks", () => {
    expect(Object.keys(SYSTEM_TASK_PURPOSES).sort()).toEqual(["nightly_run", "setup_agent", "wiki_build"]);
    expect([...SYSTEM_RUN_KINDS_LIVE]).toEqual(["setup_check", "nightly_check", "wiki_refresh", "repair_draft"]);
    expect(liveSystemKindOf("nightly_run")).toBe("nightly_check");
    expect(liveSystemKindOf("wiki_build")).toBe("wiki_refresh");
    expect(liveSystemKindOf("setup_agent")).toBe("repair_draft");
    for (const purpose of ["task", "", "__proto__", "constructor", "toString", 5, null, undefined, {}]) expect(liveSystemKindOf(purpose), JSON.stringify(purpose) ?? "undefined").toBeUndefined();
  });
});

describe("a system owner's start", () => {


  it("is refused without a flag reader at all (never accepted by default)", async () => {
    const access = hostedTaskAccess({ companyId: A, membershipOf: async () => undefined, projectGrant: async () => false });
    expect((await access.checkStart(principalOf(A, "payments"), "payments", "nightly_run")).allowed).toBe(false);
  });

  it("is refused for another company, whichever way it is claimed", async () => {
    const w = world(A);
    expect((await w.access.checkStart(principalOf(B, "payments"), "payments", "nightly_run")).allowed).toBe(false);
    // B's system owner id with A's company on the principal, and A's id with B's company on it.
    expect((await w.access.checkStart({ ...principalOf(B, "payments"), companyId: A }, "payments", "nightly_run")).allowed).toBe(false);
    expect((await w.access.checkStart({ ...principalOf(A, "payments"), companyId: B }, "payments", "nightly_run")).allowed).toBe(false);
    const other = world(B);
    expect((await other.access.checkStart(principalOf(B, "payments"), "payments", "nightly_run")).allowed).toBe(true);
    expect((await other.access.checkStart(principalOf(A, "payments"), "payments", "nightly_run")).allowed).toBe(false);
  });

});

describe("members' rules are unchanged", () => {
  const member = (company: OrgId): Principal => ({ companyId: company, personId: MEMBER, displayName: "M", roles: ["member"], provider: "hosted" });
  it("a member with the project grant starts, a member without it does not, and a stranger does not; the purpose argument changes nothing for them", async () => {
    const w = world();
    expect(await w.access.checkStart(member(A), "payments")).toEqual({ allowed: true });
    expect(await w.access.checkStart(member(A), "payments", "wiki_build")).toEqual({ allowed: true });
    expect(await w.access.checkStart(member(A), "billing")).toEqual({ allowed: false, code: "FORBIDDEN", message: NO_PROJECT_GRANT });
    expect(await w.access.checkStart({ ...member(A), personId: OUTSIDER }, "payments")).toEqual({ allowed: false, code: "FORBIDDEN", message: NOT_A_MEMBER_HERE });
    expect(await w.access.checkStart(member(B), "payments")).toEqual({ allowed: false, code: "FORBIDDEN", message: NOT_A_MEMBER_HERE });
  });

  it("a person's step still needs a live member with the grant", async () => {
    const w = world();
    expect(await w.access.checkStep({ taskId: "t1", developerId: MEMBER, project: "payments" })).toEqual({ allowed: true });
    expect(await w.access.checkStep({ taskId: "t1", developerId: MEMBER, project: "billing" })).toEqual({ allowed: false, message: NO_PROJECT_GRANT });
    expect(await w.access.checkStep({ taskId: "t1", developerId: OUTSIDER, project: "payments" })).toEqual({ allowed: false, message: NOT_A_MEMBER_HERE });
  });

  it("nobody can act on a system owner's task as its owner", async () => {
    const w = world();
    const task = { developerId: systemOwnerIdOf(A, "payments"), project: "payments", taskId: "t1", ownerKey: "k" };
    expect(await w.access.canAct({ companyId: A, personId: MEMBER, displayName: "M", roles: ["member"], provider: "hosted" }, task)).toBe(false);
    expect(await w.access.ownerActing!({ companyId: A, personId: MEMBER, displayName: "M", roles: ["member"], provider: "hosted" }, task)).toBeUndefined();
    expect(await w.access.canAct(principalOf(A, "payments"), task)).toBe(false);
  });
});

describe("a system owner's step", () => {

  it("reads the nightly run's purpose from its automatic mark too", async () => {
    const w = world();
    await putTask(w, "t1", { companyId: A, developerId: systemOwnerIdOf(A, "payments"), project: "payments", automatic: { job: "nightly", purpose: "nightly_run" } });
    expect((await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).allowed).toBe(true);
  });

  it.each([[undefined]])("stops for the purpose %j with no marks (the repair draft needs its pointer and the upkeep switch)", async (purpose) => {
    const w = world();
    const base: Record<string, unknown> = { ...systemTask(A, "payments", "x") };
    delete base["purpose"];
    await putTask(w, "t1", purpose === undefined ? base : { ...base, purpose });
    expect(await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).toEqual({ allowed: false, message: SYSTEM_OWNER_NOT_ALLOWED });
  });

  it("stops when the step names another project than the system owner's, or the row disagrees with the step on project, developer or company", async () => {
    const w = world();
    await putTask(w, "t1", systemTask(A, "payments", "nightly_run"));
    // The owner of billing asked to step on payments' task; and payments' owner asked to step in project billing.
    expect((await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "billing"), project: "payments" })).allowed).toBe(false);
    expect((await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "payments"), project: "billing" })).allowed).toBe(false);
    await putTask(w, "t2", { ...systemTask(A, "payments", "nightly_run"), developerId: systemOwnerIdOf(A, "billing") });
    expect((await w.access.checkStep({ taskId: "t2", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).allowed).toBe(false);
    await putTask(w, "t3", { ...systemTask(A, "payments", "nightly_run"), companyId: B });
    expect((await w.access.checkStep({ taskId: "t3", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).allowed).toBe(false);
  });

  it("stops when the row and the step agree with each other but the developer is another project's system owner (a step is for ITS project's owner only)", async () => {
    const w = world();
    await putTask(w, "t1", { ...systemTask(A, "billing", "nightly_run"), project: "payments" });
    expect((await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "billing"), project: "payments" })).allowed).toBe(false);
    await putTask(w, "t2", { ...systemTask(B, "payments", "nightly_run"), companyId: A });
    expect((await w.access.checkStep({ taskId: "t2", developerId: systemOwnerIdOf(B, "payments"), project: "payments" })).allowed).toBe(false);
  });

});

describe("the wiki refresh (L4-P2): a system owner's wiki_build task needs marks only the wiki-refresh starter writes", () => {
  const owner = (project = "payments") => systemOwnerIdOf(A, project);
  const worldWithMark = (mark?: { taskId: string; unattended: boolean; requestedBy: string }) => {
    const store = new MemoryDocumentStore();
    const access = hostedTaskAccess({
      companyId: A, storage: async () => store, systemRunsOn: () => true, membershipOf: async () => undefined, projectGrant: async () => false,
    });
    return { store, access, mark };
  };
  const pointer = async (store: MemoryDocumentStore, fields: Record<string, unknown>) => {
    await store.put({ item: { pk: `ORG#${A}#WIKI_BUILD#payments`, sk: "RUN", entityType: "WIKI_BUILD_RUN", orgId: A, project: "payments", taskId: "t1", requestId: "r", requestedBy: owner(), startedAt: "2026-11-17T08:00:00.000Z", limits: {}, pins: [{ repo: "app", commit: "a".repeat(40) }], plan: [], doneIds: [], ...fields } });
  };

  // MUTANT origin check: the start is accepted for a wiki_build purpose without the `nightly` origin (a person's build path).
  it("a start needs the work origin `nightly` (only the wiki-refresh starter sets it); the purpose alone is refused", async () => {
    const w = worldWithMark();
    const principal = principalOf(A, "payments");
    expect(await w.access.checkStart(principal, "payments", "wiki_build", "nightly")).toEqual({ allowed: true });
    for (const origin of [undefined, "app", "event", "schedule", "chain", "automatic", "NIGHTLY", "nightly "]) {
      expect(await w.access.checkStart(principal, "payments", "wiki_build", origin), String(origin)).toEqual({ allowed: false, code: "FORBIDDEN", message: SYSTEM_OWNER_NOT_ALLOWED });
    }
    // The origin never opens another purpose: the repair draft and an ordinary task stay refused with it.
    expect((await w.access.checkStart(principal, "payments", "setup_agent", "nightly")).allowed).toBe(false);
    expect((await w.access.checkStart(principal, "payments", undefined, "nightly")).allowed).toBe(false);
  });

  // MUTANT mark check: a step of a wiki_build task is accepted on the purpose alone.
  it("a step goes on only while the project's build pointer names THIS task as the unattended run of this project's system owner", async () => {
    const w = worldWithMark();
    await putTask({ ...w, flag: { on: true }, membershipCalls: [] }, "t1", systemTask(A, "payments", "wiki_build"));
    const step = { taskId: "t1", developerId: owner(), project: "payments" };
    // No pointer at all: stop.
    expect(await w.access.checkStep(step)).toEqual({ allowed: false, message: SYSTEM_OWNER_NOT_ALLOWED });
    // A person's build (not unattended): stop.
    await pointer(w.store, { unattended: false, requestedBy: MEMBER });
    expect((await w.access.checkStep(step)).allowed).toBe(false);
    // Unattended but run for someone other than the project's system owner, or for another task: stop.
    await pointer(w.store, { unattended: true, requestedBy: MEMBER });
    expect((await w.access.checkStep(step)).allowed).toBe(false);
    await pointer(w.store, { unattended: true, requestedBy: owner("billing") });
    expect((await w.access.checkStep(step)).allowed).toBe(false);
    await pointer(w.store, { unattended: true, taskId: "other-task" });
    expect((await w.access.checkStep(step)).allowed).toBe(false);
    await pointer(w.store, { unattended: "true" });
    expect((await w.access.checkStep(step)).allowed).toBe(false);
    // The mark: allowed. And only while the flag is on.
    await pointer(w.store, { unattended: true });
    expect(await w.access.checkStep(step)).toEqual({ allowed: true });
  });

});


describe("the repair draft (L4-SR2): a system owner's setup_agent task needs the origin, the project's setup pointer and the project's upkeep switch, each read now", () => {
  const owner = (project = "payments") => systemOwnerIdOf(A, project);
  const rig = (company: OrgId = A) => {
    const store = new MemoryDocumentStore();
    const state = { gate: true, upkeep: true as unknown, upkeepAsked: [] as string[] };
    const access = hostedTaskAccess({
      companyId: company, storage: async () => store, systemRunsOn: () => state.gate, membershipOf: async () => undefined, projectGrant: async () => false,
      upkeepOn: async (project) => { state.upkeepAsked.push(project); if (state.upkeep === "throw") throw new Error("down"); return state.upkeep as boolean; },
    });
    return { store, state, access };
  };
  // What the task flow's start writes: the digest of the starter's provider and person id (never the plain id).
  const pointerOwner = (personId: string, provider: string = SYSTEM_OWNER_PROVIDER): string => developerIdOf({ provider, personId });
  const setupPointer = async (store: MemoryDocumentStore, fields: Record<string, unknown> = {}, company: OrgId = A, project = "payments") => {
    await store.put({ item: { ...setupAgentKey(company, project), entityType: "SETUP_AGENT", orgId: company, project, taskId: "t1", requestId: "r", requestedBy: pointerOwner(owner()), basedOnRevision: 1, startedAt: "2026-11-17T08:00:00.000Z", limits: {}, ...fields } });
  };
  const task = (store: MemoryDocumentStore, fields: Record<string, unknown> = {}) => store.put({ item: { pk: "DEVTASK#t1", sk: "META", entityType: "DEVELOPER_TASK", ...systemTask(A, "payments", "setup_agent"), ...fields } });
  const step = { taskId: "t1", developerId: owner(), project: "payments" };

  // MUTANT step upkeep: a step is accepted without reading the upkeep switch again.
  it("a step stops the moment the project's upkeep switch goes off (read again at every step), and when the company's gate goes off", async () => {
    const w = rig();
    await task(w.store);
    await setupPointer(w.store);
    expect((await w.access.checkStep(step)).allowed).toBe(true);
    w.state.upkeep = false;
    expect((await w.access.checkStep(step)).allowed).toBe(false);
    w.state.upkeep = "throw";
    expect((await w.access.checkStep(step)).allowed).toBe(false);
    w.state.upkeep = true;
    expect((await w.access.checkStep(step)).allowed).toBe(true);
    w.state.gate = false;
    expect((await w.access.checkStep(step)).allowed).toBe(false);
  });

});
