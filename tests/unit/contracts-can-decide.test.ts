// TE-B5a: `canDecide(actor, action, task, company)`, the one table of who may do what. Task-level exceptions go to the task's owner or a maintainer; company-level things to an admin; the role is read live
// (the caller passes what it just read, nothing is cached on the task); an unknown action or actor is refused.
import { describe, expect, it } from "vitest";
import { DECISION_ACTIONS, canDecide, type DecideActor, type DecideCompany, type DecideTask } from "../../packages/contracts/src/index.js";

const COMPANY: DecideCompany = { companyId: "co-1" };
const TASK: DecideTask = { companyId: "co-1", project: "web", ownerId: "person-owner" };
const actor = (over: Partial<DecideActor> = {}): DecideActor => ({ personId: "person-x", companyId: "co-1", orgRole: "member", projectRole: { project: "web", role: "contributor" }, ...over });
const TASK_LEVEL = ["mark_ready_anyway", "confirm_found_contract", "approve_recording_set"] as const;
const COMPANY_LEVEL = ["manage_provider_keys", "write_test_account", "set_company_lock"] as const;

describe("canDecide: task-level exceptions", () => {
  for (const action of TASK_LEVEL) {
    describe(action, () => {
      it("lets the task's owner (the requester) decide", () => {
        const result = canDecide(actor({ personId: "person-owner" }), action, TASK, COMPANY);
        expect(result).toEqual({ allowed: true, reason: "task_owner" });
      });
      it("lets a maintainer of the task's project decide", () => {
        expect(canDecide(actor({ projectRole: { project: "web", role: "maintainer" } }), action, TASK, COMPANY)).toEqual({ allowed: true, reason: "maintainer" });
      });
      it("lets a company admin or owner decide, as the maintainer of every project", () => {
        expect(canDecide(actor({ orgRole: "admin", projectRole: undefined }), action, TASK, COMPANY).allowed).toBe(true);
        expect(canDecide(actor({ orgRole: "owner", projectRole: undefined }), action, TASK, COMPANY).allowed).toBe(true);
      });
      it("refuses a member who is neither the owner nor a maintainer", () => {
        expect(canDecide(actor(), action, TASK, COMPANY)).toEqual({ allowed: false, reason: "not_allowed" });
        expect(canDecide(actor({ projectRole: { project: "web", role: "viewer" } }), action, TASK, COMPANY).allowed).toBe(false);
      });
      it("refuses a non-member, even the one named as the owner", () => {
        expect(canDecide(actor({ personId: "person-owner", orgRole: undefined, projectRole: undefined }), action, TASK, COMPANY)).toEqual({ allowed: false, reason: "not_a_member" });
        expect(canDecide(actor({ personId: "person-owner", orgRole: "auditor" }), action, TASK, COMPANY).allowed).toBe(false);
      });
      it("refuses the owner who is only a viewer now (the role is read live)", () => {
        expect(canDecide(actor({ personId: "person-owner", projectRole: { project: "web", role: "viewer" } }), action, TASK, COMPANY).allowed).toBe(false);
      });
      it("refuses the owner whose project role cannot be read", () => {
        expect(canDecide(actor({ personId: "person-owner", projectRole: undefined }), action, TASK, COMPANY).allowed).toBe(false);
      });
      it("refuses a maintainer of another project", () => {
        expect(canDecide(actor({ projectRole: { project: "other", role: "maintainer" } }), action, TASK, COMPANY).allowed).toBe(false);
        expect(canDecide(actor({ personId: "person-owner", projectRole: { project: "other", role: "contributor" } }), action, TASK, COMPANY).allowed).toBe(false);
      });
      it("refuses another company's actor and another company's task (tenant isolation)", () => {
        expect(canDecide(actor({ personId: "person-owner", companyId: "co-2" }), action, TASK, COMPANY)).toEqual({ allowed: false, reason: "other_company" });
        expect(canDecide(actor({ personId: "person-owner" }), action, { ...TASK, companyId: "co-2" }, COMPANY)).toEqual({ allowed: false, reason: "other_company" });
        expect(canDecide(actor({ orgRole: "admin" }), action, TASK, { companyId: "co-2" }).allowed).toBe(false);
      });
      it("refuses when there is no task", () => {
        expect(canDecide(actor({ orgRole: "admin" }), action, undefined, COMPANY)).toEqual({ allowed: false, reason: "no_task" });
      });
      it("refuses an owner id that is empty on both sides", () => {
        expect(canDecide(actor({ personId: "" }), action, { ...TASK, ownerId: "" }, COMPANY).allowed).toBe(false);
        expect(canDecide(actor(), action, { ...TASK, ownerId: undefined }, COMPANY).allowed).toBe(false);
      });
    });
  }
});

describe("canDecide: company-level actions", () => {
  for (const action of COMPANY_LEVEL) {
    it(`${action} needs a company admin or owner`, () => {
      expect(canDecide(actor({ orgRole: "admin" }), action, TASK, COMPANY)).toEqual({ allowed: true, reason: "admin" });
      expect(canDecide(actor({ orgRole: "owner" }), action, undefined, COMPANY).allowed).toBe(true);
      expect(canDecide(actor({ projectRole: { project: "web", role: "maintainer" } }), action, TASK, COMPANY)).toEqual({ allowed: false, reason: "not_allowed" });
      expect(canDecide(actor({ personId: "person-owner" }), action, TASK, COMPANY).allowed).toBe(false);
      expect(canDecide(actor({ orgRole: undefined }), action, TASK, COMPANY).allowed).toBe(false);
      expect(canDecide(actor({ orgRole: "admin", companyId: "co-2" }), action, TASK, COMPANY).allowed).toBe(false);
    });
  }
  it("a product AI key may also be connected by a maintainer of the project (DECISIONS 157)", () => {
    expect(canDecide(actor({ projectRole: { project: "web", role: "maintainer" } }), "connect_product_ai_key", TASK, COMPANY).allowed).toBe(true);
    expect(canDecide(actor(), "connect_product_ai_key", TASK, COMPANY).allowed).toBe(false);
    expect(canDecide(actor({ orgRole: "admin" }), "connect_product_ai_key", undefined, COMPANY).allowed).toBe(true);
  });
});

describe("canDecide: role changes take effect at once", () => {
  it("answers from the roles passed in this call, never from the task", () => {
    const task: DecideTask = { companyId: "co-1", project: "web", ownerId: "person-owner" };
    const owner = (role: string): DecideActor => actor({ personId: "person-owner", projectRole: { project: "web", role } });
    expect(canDecide(owner("contributor"), "mark_ready_anyway", task, COMPANY).allowed).toBe(true);
    expect(canDecide(owner("viewer"), "mark_ready_anyway", task, COMPANY).allowed).toBe(false);
    expect(canDecide(owner("contributor"), "mark_ready_anyway", task, COMPANY).allowed).toBe(true);
  });
});

describe("canDecide: fails closed", () => {
  it("refuses an unknown action, including names every object has", () => {
    for (const name of ["", "merge", "constructor", "__proto__", "toString", "hasOwnProperty", "MARK_READY_ANYWAY"]) {
      expect(canDecide(actor({ orgRole: "owner" }), name, TASK, COMPANY)).toEqual({ allowed: false, reason: "unknown_action" });
    }
  });
  it("refuses a missing or malformed actor, task or company", () => {
    const bad: unknown[] = [undefined, null, 7, "x", [], {}, { personId: "p" }, { personId: "p", companyId: "co-1" }, { personId: 3, companyId: "co-1", orgRole: "owner" }];
    for (const value of bad) expect(canDecide(value as DecideActor, "mark_ready_anyway", TASK, COMPANY).allowed).toBe(false);
    expect(canDecide(actor({ orgRole: "owner" }), "mark_ready_anyway", TASK, undefined as unknown as DecideCompany).allowed).toBe(false);
    expect(canDecide(actor({ orgRole: "owner" }), "mark_ready_anyway", "task" as unknown as DecideTask, COMPANY).allowed).toBe(false);
  });
  it("gives a role named like an object property no power", () => {
    for (const role of ["constructor", "__proto__", "toString", "Owner", "ADMIN", " admin"]) expect(canDecide(actor({ orgRole: role }), "manage_provider_keys", TASK, COMPANY).allowed).toBe(false);
    for (const role of ["constructor", "__proto__", "Maintainer"]) expect(canDecide(actor({ projectRole: { project: "web", role } }), "mark_ready_anyway", TASK, COMPANY).allowed).toBe(false);
  });
  it("never throws for a hostile object", () => {
    const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
    expect(canDecide(hostile as unknown as DecideActor, "mark_ready_anyway", TASK, COMPANY).allowed).toBe(false);
    expect(canDecide(actor(), "mark_ready_anyway", hostile as unknown as DecideTask, COMPANY).allowed).toBe(false);
  });
  it("lists every action once, with its level", () => {
    expect(Object.keys(DECISION_ACTIONS).sort()).toEqual([...TASK_LEVEL, ...COMPANY_LEVEL, "connect_product_ai_key"].sort());
  });
});
