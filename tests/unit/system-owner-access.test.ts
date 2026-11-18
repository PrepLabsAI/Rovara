// L4-P1 (owner DEC 254zzl 1): the hosted access rule for a project's SYSTEM OWNER, at the start and at every step. The system owner is accepted ONLY for a listed system purpose, ONLY for its own project and company, and
// ONLY while the company's SystemRuns flag is on; members' rules are unchanged. P1 accepts the free purpose (the model-free nightly run); the AI purposes (a repair draft is a `setup_agent` task, a wiki refresh a
// `wiki_build` task) are named and refused until P2. Each guard has a test that fails if it is removed (mutants in the PR body).
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SYSTEM_OWNER_PROVIDER, systemOwnerIdOf, type OrgId, type OrgRole, type Principal } from "@agentx/contracts";
import { NO_PROJECT_GRANT, NOT_A_MEMBER_HERE, hostedTaskAccess } from "../../packages/broker/src/aws/core-engine-root.js";
import { SYSTEM_OWNER_NOT_ALLOWED, SYSTEM_RUN_KINDS_LIVE, SYSTEM_TASK_PURPOSES, liveSystemKindOf, systemPrincipalOf } from "../../packages/broker/src/core/system-runs/access.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";

const A: OrgId = IMPLICIT_COMPANY_ID;
const B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
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
  it("names three purposes, and this phase accepts only the free one", () => {
    expect(Object.keys(SYSTEM_TASK_PURPOSES).sort()).toEqual(["nightly_run", "setup_agent", "wiki_build"]);
    expect([...SYSTEM_RUN_KINDS_LIVE]).toEqual(["setup_check", "nightly_check"]);
    expect(liveSystemKindOf("nightly_run")).toBe("nightly_check");
    for (const purpose of ["setup_agent", "wiki_build", "task", "", "__proto__", "constructor", "toString", 5, null, undefined, {}]) expect(liveSystemKindOf(purpose), String(purpose)).toBeUndefined();
  });
});

describe("a system owner's start", () => {
  it("is accepted for its own project, for the free purpose only, with the flag on", async () => {
    const w = world();
    expect(await w.access.checkStart(principalOf(A, "payments"), "payments", "nightly_run")).toEqual({ allowed: true });
  });

  it.each([["setup_agent"], ["wiki_build"], ["task"], [undefined], ["__proto__"], ["nightly_run "]])("is refused for the purpose %j (an AI purpose waits for P2, and an ordinary task is never a system owner's)", async (purpose) => {
    const verdict = await world().access.checkStart(principalOf(A, "payments"), "payments", purpose);
    expect(verdict).toEqual({ allowed: false, code: "FORBIDDEN", message: SYSTEM_OWNER_NOT_ALLOWED });
  });

  it("is refused while the company's SystemRuns flag is off", async () => {
    const w = world();
    w.flag.on = false;
    expect((await w.access.checkStart(principalOf(A, "payments"), "payments", "nightly_run")).allowed).toBe(false);
  });

  it("is refused without a flag reader at all (never accepted by default)", async () => {
    const access = hostedTaskAccess({ companyId: A, membershipOf: async () => undefined, projectGrant: async () => false });
    expect((await access.checkStart(principalOf(A, "payments"), "payments", "nightly_run")).allowed).toBe(false);
  });

  it("is refused for another project: a system owner is derived from company AND project", async () => {
    const w = world();
    expect((await w.access.checkStart(principalOf(A, "billing"), "payments", "nightly_run")).allowed).toBe(false);
    expect((await w.access.checkStart(principalOf(A, "payments"), "billing", "nightly_run")).allowed).toBe(false);
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

  it("is refused for a principal that merely carries the id, or merely the provider", async () => {
    const w = world();
    expect((await w.access.checkStart({ ...principalOf(A, "payments"), provider: "hosted" }, "payments", "nightly_run")).allowed).toBe(false);
    expect((await w.access.checkStart({ ...principalOf(A, "payments"), personId: MEMBER }, "payments", "nightly_run")).allowed).toBe(false);
    expect((await w.access.checkStart({ companyId: A, personId: MEMBER, displayName: "x", roles: [], provider: SYSTEM_OWNER_PROVIDER }, "payments", "nightly_run")).allowed).toBe(false);
  });

  it("never asks membership for a system owner (it is not a member and takes no member rule)", async () => {
    const w = world();
    await w.access.checkStart(principalOf(A, "payments"), "payments", "nightly_run");
    expect(w.membershipCalls).toEqual([]);
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
  it("goes on for its own project's free task, read from the task's own stored row", async () => {
    const w = world();
    await putTask(w, "t1", systemTask(A, "payments", "nightly_run"));
    expect(await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).toEqual({ allowed: true });
  });

  it("reads the nightly run's purpose from its automatic mark too", async () => {
    const w = world();
    await putTask(w, "t1", { companyId: A, developerId: systemOwnerIdOf(A, "payments"), project: "payments", automatic: { job: "nightly", purpose: "nightly_run" } });
    expect((await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).allowed).toBe(true);
  });

  it.each([["setup_agent"], ["wiki_build"], [undefined], ["task"]])("stops for the purpose %j (an AI purpose waits for P2)", async (purpose) => {
    const w = world();
    const { purpose: _unused, ...base } = systemTask(A, "payments", "x");
    await putTask(w, "t1", purpose === undefined ? base : { ...base, purpose });
    expect(await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).toEqual({ allowed: false, message: SYSTEM_OWNER_NOT_ALLOWED });
  });

  it("stops while the flag is off, and when the task row is missing", async () => {
    const w = world();
    await putTask(w, "t1", systemTask(A, "payments", "nightly_run"));
    expect((await w.access.checkStep({ taskId: "nope", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).allowed).toBe(false);
    w.flag.on = false;
    expect((await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "payments"), project: "payments" })).allowed).toBe(false);
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

  it("two companies: another company's system owner never steps in this one, even on a task row that says so", async () => {
    const w = world(A);
    await putTask(w, "t1", systemTask(B, "payments", "nightly_run"));
    expect((await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(B, "payments"), project: "payments" })).allowed).toBe(false);
    const other = world(B);
    await putTask(other, "t1", systemTask(B, "payments", "nightly_run"));
    expect((await other.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(B, "payments"), project: "payments" })).allowed).toBe(true);
  });

  it("never falls through to the member rules (membership is not asked)", async () => {
    const w = world();
    await putTask(w, "t1", systemTask(A, "payments", "nightly_run"));
    await w.access.checkStep({ taskId: "t1", developerId: systemOwnerIdOf(A, "payments"), project: "payments" });
    expect(w.membershipCalls).toEqual([]);
  });

  it("a person developer id whose stored row says it is a system purpose gets no system rule", async () => {
    const w = world();
    await putTask(w, "t1", { companyId: A, developerId: MEMBER, project: "payments", purpose: "nightly_run" });
    // The member rules decide: live member with the grant.
    expect(await w.access.checkStep({ taskId: "t1", developerId: MEMBER, project: "payments" })).toEqual({ allowed: true });
    expect(await w.access.checkStep({ taskId: "t1", developerId: OUTSIDER, project: "payments" })).toEqual({ allowed: false, message: NOT_A_MEMBER_HERE });
  });
});
