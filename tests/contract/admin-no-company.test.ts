// P0-14 (live test 0.5.28), the same class: an administrator route that scopes its work to the administrator's OWN company refused an install operator in no company with
// AUTH_REQUIRED ("your AgentX sign-in has ended; run agentx login <url> again"), which signing in again can never fix. resolveAdminCompany keeps every refusal, but says what is
// wrong (403 FORBIDDEN ADMIN_NOT_IN_A_COMPANY); a membership read that fails still gets the fixed sign-in words (fail closed).
import { describe, expect, it } from "vitest";
import { AgentXError, agentXError } from "@agentx/contracts";
import { ADMIN_NOT_IN_A_COMPANY, resolveAdminCompany, resolveCompany, type CompanyMembershipReader } from "../../packages/broker/src/aws/company-check.js";
import { planChange, type PlanDependencies } from "../../packages/broker/src/aws/admin-change-plans.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";

const ORG_A = "org_adminnocompany00000a";
const ORG_B = "org_adminnocompany00000b";
const reader = (answer: () => Promise<unknown>): CompanyMembershipReader => ({ companyOf: answer as () => Promise<string | undefined> });
const caught = async (work: Promise<unknown>) => await work.then(() => undefined, (error: unknown) => error as AgentXError);

describe("resolveAdminCompany", () => {
  it("answers the administrator's own company exactly as resolveCompany does", async () => {
    for (const company of [ORG_A, ORG_B]) {
      expect(await resolveAdminCompany(reader(async () => company), "person")).toBe(company);
      expect(await resolveCompany(reader(async () => company), "person")).toBe(company);
    }
    expect(await resolveAdminCompany(undefined, "person")).toBeUndefined();
  });

  it("refuses an administrator in no company (or a malformed one) with FORBIDDEN in fixed words, not AUTH_REQUIRED", async () => {
    for (const answer of [undefined, "", "not-a-company", "org_../../secret", 42]) {
      const error = await caught(resolveAdminCompany(reader(async () => answer), "person"));
      expect(error, String(answer)).toBeInstanceOf(AgentXError);
      expect(error?.code, String(answer)).toBe("FORBIDDEN");
      expect(error?.statusCode, String(answer)).toBe(403);
      expect(error?.message, String(answer)).toContain(ADMIN_NOT_IN_A_COMPANY);
      // Before: the loop the operator could not leave.
      expect((await caught(resolveCompany(reader(async () => answer), "person")))?.code, String(answer)).toBe("AUTH_REQUIRED");
    }
  });

  it("keeps the fixed sign-in refusal when the membership read fails (fail closed), never its cause", async () => {
    const error = await caught(resolveAdminCompany(reader(async () => { throw new Error("secret-table broke"); }), "person"));
    expect(error?.code).toBe("AUTH_REQUIRED");
    expect(error?.message).not.toContain("secret");
  });

  it("takes the caller's own refusal", async () => {
    const error = await caught(resolveAdminCompany(reader(async () => undefined), "person", () => agentXError("CONFIG_INVALID", "name one")));
    expect(error?.code).toBe("CONFIG_INVALID");
    expect(error?.message).toContain("name one");
  });
});

describe("GET /v1/admin/sign-in-clients for an operator in no company", () => {
  const registry = () => {
    const asked: Array<string | undefined> = [];
    return { asked, signInClients: { list: async (company?: string) => { asked.push(company); return []; } } };
  };

  it("is 403 with the clear words, not 401, and lists nothing", async () => {
    const clients = registry();
    const { handler } = await createAdminBroker({ linking: { companies: reader(async () => undefined), signInClients: clients.signInClients } as never });
    const answer = await adminCall(handler, { method: "GET", path: "/v1/admin/sign-in-clients" });
    expect(answer).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: ADMIN_NOT_IN_A_COMPANY } } });
    expect(clients.asked).toEqual([]);
  });

  it("still lists only the member administrator's own company", async () => {
    for (const company of [ORG_A, ORG_B]) {
      const clients = registry();
      const { handler } = await createAdminBroker({ linking: { companies: reader(async () => company), signInClients: clients.signInClients } as never });
      expect((await adminCall(handler, { method: "GET", path: "/v1/admin/sign-in-clients" })).status, company).toBe(200);
      expect(clients.asked, company).toEqual([company]);
    }
  });

  it("is never looser for a non-administrator", async () => {
    const clients = registry();
    const { handler } = await createAdminBroker({ linking: { companies: reader(async () => ORG_A), signInClients: clients.signInClients } as never });
    expect((await adminCall(handler, { method: "GET", path: "/v1/admin/sign-in-clients", admin: false })).status).toBe(403);
    expect(clients.asked).toEqual([]);
  });
});

describe("admin change plans that act on the administrator's own company, for an operator in no company", () => {
  const identity = { issuer: "https://identity.example.test", subject: "admin-subject", ownerKey: "owner-key", isAdministrator: true, claims: {} } as AuthenticatedIdentity;
  const deps = (company: unknown) => {
    const asked: Array<string | undefined> = [];
    const signInClients = { list: async (companyId?: string) => { asked.push(companyId); return []; }, put: async () => undefined, remove: async () => false };
    return { asked, deps: { actions: { companies: reader(async () => company), signInClients, now: () => 0 }, reads: {}, handlers: {}, connectorSecretPrefix: "agentx/" } as unknown as PlanDependencies };
  };
  const registration = { name: "Scheduler", audience: "scheduler", redirectUris: [], loopback: true };
  const changes = [
    { kind: "register_sign_in_client", clientId: "scheduler", registration },
    { kind: "remove_sign_in_client", clientId: "scheduler" },
    { kind: "revoke_signin", developer: "dev@example.com" },
  ] as const;

  it.each(changes)("$kind is refused with FORBIDDEN in the clear words, not AUTH_REQUIRED, before anything is read", async (change) => {
    const world = deps(undefined);
    const error = await caught(planChange(world.deps, identity, change));
    expect(error?.code).toBe("FORBIDDEN");
    expect(error?.message).toContain(ADMIN_NOT_IN_A_COMPANY);
    expect(world.asked).toEqual([]);
  });

  it("register_sign_in_client still plans for a member administrator, in its own company", async () => {
    const world = deps(ORG_A);
    const plan = await planChange(world.deps, identity, changes[0]);
    expect(plan.effect).toContain("Register sign-in client scheduler");
    expect(world.asked).toEqual([ORG_A]);
  });
});
