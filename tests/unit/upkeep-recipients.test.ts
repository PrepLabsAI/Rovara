// L4-P2: who is told when nightly upkeep pauses (core-host/upkeep-recipients.ts): the project's administrators and the company's owners and admins, re-checked LIVE for THIS company, bounded, and never another
// company's people. Also the live "does this person still administer the project" read the notice delivery asks before every send. Mutants are listed in the PR body with the test that kills each.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type OrgId, type OrgRole } from "@agentx/contracts";
import { UPKEEP_RECIPIENTS_MAX, createUpkeepAdministers, createUpkeepRecipients, type UpkeepRecipientSources } from "../../packages/broker/src/core-host/upkeep-recipients.js";

const A: OrgId = IMPLICIT_COMPANY_ID;
const B: OrgId = "org_bbbbbbbbbbbbbbbbbbbb";
const id = (n: string): string => n.repeat(32).slice(0, 64);
const OWNER = id("a1"), ADMIN = id("a2"), PROJECT_ADMIN = id("b1"), MEMBER = id("c1"), FORMER = id("d1"), OTHER_COMPANY = id("e1"), DEMOTED_ADMIN = id("f1");

function sources(over: Partial<UpkeepRecipientSources> = {}): UpkeepRecipientSources & { calls: string[] } {
  const calls: string[] = [];
  const roles: Record<string, { companyId: OrgId; role: OrgRole } | undefined> = {
    [OWNER]: { companyId: A, role: "owner" }, [ADMIN]: { companyId: A, role: "admin" }, [PROJECT_ADMIN]: { companyId: A, role: "member" }, [MEMBER]: { companyId: A, role: "member" },
    [OTHER_COMPANY]: { companyId: B, role: "owner" }, [DEMOTED_ADMIN]: { companyId: A, role: "member" },
  };
  return {
    calls,
    // The lists are what the install's records say (they may be stale); the live reads decide.
    companyAdmins: async () => [OWNER, ADMIN, DEMOTED_ADMIN, FORMER, OTHER_COMPANY],
    projectAdmins: async (project) => (project === "beacon" ? [PROJECT_ADMIN, MEMBER, OWNER] : []),
    membershipOf: async (personId) => { calls.push(`member:${personId.slice(0, 2)}`); return roles[personId]; },
    projectGrantRole: async (personId, project) => (project === "beacon" && personId === PROJECT_ADMIN ? "administrator" : project === "beacon" && personId === MEMBER ? "developer" : undefined),
    ...over,
  };
}

describe("the recipients reader", () => {

  // MUTANT: the company binding is dropped.
  it("answers nobody for another company (never that company's admins) and for a company id it was not made for", async () => {
    const reader = createUpkeepRecipients(A, sources());
    expect(await reader(B, "beacon")).toEqual([]);
    const forB = createUpkeepRecipients(B, sources());
    expect(await forB(A, "beacon")).toEqual([]);
    // B's reader never names A's people even when the install's lists carry them: their membership is A's.
    expect(await forB(B, "beacon")).toEqual([OTHER_COMPANY]);
  });

  it("a person id that is not 64 hex is dropped, and the list is bounded", async () => {
    const many = Array.from({ length: UPKEEP_RECIPIENTS_MAX + 20 }, (_, i) => i.toString(16).padStart(2, "0").repeat(32));
    const reader = createUpkeepRecipients(A, sources({ companyAdmins: async () => ["not-a-person-id", ...many], membershipOf: async () => ({ companyId: A, role: "admin" as const }) }));
    const told = await reader(A, "beacon");
    expect(told).toHaveLength(UPKEEP_RECIPIENTS_MAX);
    expect(told.every((person) => /^[a-f0-9]{64}$/u.test(person))).toBe(true);
  });

});

describe("the live administers read", () => {
  it("is true for a live owner or admin and a live project administrator of THIS project; false for a member, a developer, a demoted admin, a stranger and another company's owner", async () => {
    const administers = createUpkeepAdministers(A, sources());
    expect(await administers(A, OWNER, "beacon")).toBe(true);
    expect(await administers(A, ADMIN, "other")).toBe(true);
    expect(await administers(A, PROJECT_ADMIN, "beacon")).toBe(true);
    // The project administrator of beacon is nothing on another project.
    expect(await administers(A, PROJECT_ADMIN, "other")).toBe(false);
    for (const person of [MEMBER, DEMOTED_ADMIN, FORMER, OTHER_COMPANY, "short"]) expect(await administers(A, person, "beacon"), person).toBe(false);
    expect(await administers(B, OWNER, "beacon")).toBe(false);
  });

  it("a read that fails is no (the delivery drops the row without a word)", async () => {
    const administers = createUpkeepAdministers(A, sources({ membershipOf: async () => { throw new Error("down"); } }));
    expect(await administers(A, OWNER, "beacon")).toBe(false);
  });
});
