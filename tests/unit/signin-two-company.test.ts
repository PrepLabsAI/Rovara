// Both slices use the shared R4 kit over the real server, store and broker routes.
import { expect, it } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { assertSurfacesIsolated, assertFailsClosed, COMPANY_A, COMPANY_B, SHARED_RAW_IDS, type IsolationSurface } from "../../packages/testing/src/isolation/two-company.js";
import { signinCompanyWorld } from "../support/signin-company-world.js";
import type { CompanySignInAuditInput } from "../../packages/broker/src/developer/company-signin-audit.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { resolveDeveloper } from "../../packages/broker/src/aws/admin-actions.js";

const issuer = (label: string) => `https://${label.toLowerCase()}.identity.example.test`;
const person = (label: string) => ownerKeyForSubject(issuer(label), SHARED_RAW_IDS.user);
const email = "shared@example.test";

it("uses the R4 kit on real sign-in membership, join, preapproval, issuer and email paths", async () => {
  const membership = signinCompanyWorld();
  const approval = signinCompanyWorld();
  const provider = signinCompanyWorld();
  const indexed = signinCompanyWorld();
  const surfaces: IsolationSurface[] = [
    { name: "membership and join", kind: "read",
      async plant(me) {
        await membership.create(me.orgId);
        const signed = await membership.signInCompany(me.orgId, SHARED_RAW_IDS.user);
        expect(new URL(signed.headers.location!).searchParams.get("code")).toBeTruthy();
        return { handle: person(me.label), markers: [person(me.label)] };
      },
      async observe(me, planted) {
        const own = await membership.company.membership(planted.own as string);
        const foreign = await membership.company.join({ personId: planted.other as string, companyId: me.orgId, email });
        return { own, foreign };
      },
    },
    { name: "preapproval lookup/list", kind: "list",
      async plant(me) {
        await approval.create(me.orgId, "first@example.test");
        await approval.company.preapprove(me.orgId, email, "member", 24, person(me.label));
        return { handle: me.orgId, markers: [person(me.label)] };
      },
      observe: (me) => approval.company.list(me.orgId),
    },
    { name: "company issuer", kind: "read",
      async plant(me) {
        await provider.create(me.orgId);
        return { handle: me.orgId, markers: [issuer(me.label)] };
      },
      async observe(me) { return (await provider.deps.companyIssuer!(me.orgId))?.issuer; },
    },
    { name: "email index resolution", kind: "read",
      async plant(me) {
        await indexed.create(me.orgId);
        await indexed.signInCompany(me.orgId, SHARED_RAW_IDS.user);
        return { handle: person(me.label), markers: [person(me.label)] };
      },
      async observe(me) {
        return resolveDeveloper({ documentClient: indexed.db, tableName: "state", signInTableName: "signin", now: indexed.now, limitDefaults: { member: 0, organization: 0 }, companies: companyMembershipFromDynamo(indexed.db, "signin") }, email, me.orgId);
      },
    },
  ];
  await assertSurfacesIsolated(surfaces);
});

it("a membership read failure or disappearance refuses refresh on the real server", async () => {
  let h: ReturnType<typeof signinCompanyWorld>;
  let refresh: string;
  await assertFailsClosed([{
    name: "live membership on refresh",
    async prepare() {
      h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
      const signed = await h.signInCompany(COMPANY_A.orgId, SHARED_RAW_IDS.user);
      const token = await h.exchange(new URL(signed.headers.location!).searchParams.get("code")!);
      expect(token.status).toBe(200); refresh = token.body.refresh_token as string;
    },
    async attempt(mode) {
      if (mode === "throws") h.db.injectFault({ command: "GetCommand", match: (input) => (input.Key as { pk: string }).pk.startsWith("COMPANY_MEMBER#"), error: { name: "AccessDeniedException", message: COMPANY_A.canary + COMPANY_B.canary } });
      else h.db.delete(`COMPANY_MEMBER#${person(COMPANY_A.label)}`, "COMPANY");
      const answer = await h.refresh(refresh);
      // Fail closed: a removed person's refresh is refused (400), and a failed membership read is refused as RETRYABLE (503) and never granted.
      if (answer.status === 400 || answer.status === 503) throw new Error(JSON.stringify(answer.body));
      return answer;
    },
  }]);
});

it("writes a company audit row after membership resolves and none for an unknown person", async () => {
  const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
  const rows: CompanySignInAuditInput[] = [];
  h.deps.signInAudit = async (row) => { rows.push(row); };
  await h.signInCompany(COMPANY_A.orgId, "known-person", "shared@example.test");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ companyId: COMPANY_A.orgId, method: "cli", outcome: "succeeded" });
  expect(JSON.stringify(rows[0])).not.toContain("shared@example.test");
  const beforeUnknown = rows.length;
  await h.signInCompany(COMPANY_A.orgId, "unknown-person", "unknown@example.test");
  expect(rows).toHaveLength(beforeUnknown);
});

it.each(["membership", "preapproval", "issuer", "secret"] as const)("unreadable %s cannot fall back to implicit or write a person/code/session", async (kind) => {
  const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
  if (kind === "membership") h.db.set({ pk: `COMPANY_MEMBER#${person(COMPANY_A.label)}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: person(COMPANY_A.label), companyId: "malformed" });
  if (kind === "preapproval") {
    const row = h.db.find((item) => item.entityType === "COMPANY_PREAPPROVAL")[0]!; h.db.set({ ...row, role: "unknown" });
  }
  if (kind === "issuer") h.db.set({ pk: companyScoped(COMPANY_A.orgId, "SIGNIN_ISSUER"), sk: "OIDC", entityType: "COMPANY_SIGNIN_ISSUER", enabled: "true" });
  if (kind === "secret") h.secretDown();
  const answer = await h.signInCompany(COMPANY_A.orgId, SHARED_RAW_IDS.user);
  expect(answer.headers.location === undefined ? answer.statusCode : new URL(answer.headers.location).searchParams.get("code")).not.toBe(200);
  expect(answer.headers.location === undefined || !new URL(answer.headers.location).searchParams.has("code")).toBe(true);
  expect(h.db.find((row) => ["DEVELOPER", "DEVELOPER_EMAIL", "AUTH_CODE", "SESSION"].includes(row.entityType as string))).toEqual([]);
  expect(JSON.stringify([answer, h.logs])).not.toMatch(/secret-read-canary|rovara-canary/);
});

it("the R4 kit covers shared client ids, filtered lists, foreign put/remove and scoped invites", async () => {
  const { inviteCompanyWorld } = await import("../support/signin-company-world.js");
  const { attempt } = await import("../../packages/testing/src/isolation/two-company.js");
  const clients = signinCompanyWorld(); const invites = await inviteCompanyWorld();
  const raw = SHARED_RAW_IDS.user.toLowerCase();
  const at = new Date(clients.now()).toISOString();
  const input = (clientId: string, companyId: string, name: string) => ({ clientId, companyId, name, audience: clientId, redirectUris: [], loopback: true, createdAt: at, updatedAt: at, updatedBy: "operator" });
  await assertSurfacesIsolated([
    { name: "client get/list/put/remove in one global id namespace", kind: "write",
      async plant(me) {
        const id = me.label === "A" ? raw : `${raw}-b`;
        if (me.label === "B") await expect(clients.deps.store.putClient(input(raw, me.orgId, me.canary), me.orgId)).rejects.toThrow();
        await clients.deps.store.putClient(input(id, me.orgId, me.canary), me.orgId);
        return { handle: id };
      },
      async observe(me, planted) {
        const other = String(planted.other);
        const put = await attempt(() => clients.deps.store.putClient(input(other, me.orgId, me.canary), me.orgId));
        const removed = await clients.deps.store.removeClient(other, me.orgId);
        expect(put.ok).toBe(false); expect(removed).toBe(false);
        expect(await clients.deps.store.getClient(other, me.orgId)).toBeUndefined();
        return { own: await clients.deps.store.getClient(String(planted.own), me.orgId), list: await clients.deps.store.listClients(me.orgId) };
      },
    },
    { name: "invite route withdrawal and approval list", kind: "write",
      async plant(me) {
        invites.member(me.orgId, "admin", person(me.label));
        expect((await invites.post({ email: "shared@example.test", role: "member", expiresInHours: 24 })).statusCode).toBe(200);
        // The same hash exists in each company, and its scoped list is the observable marker.
        return { handle: me.orgId, markers: [person(me.label)] };
      },
      async observe(me) {
        invites.member(me.orgId, "admin", person(me.label));
        const before = await invites.identity.company.list(me.orgId);
        const sharedHash = (await import("../../packages/broker/src/developer/store.js")).emailIndexKey("shared@example.test").pk.slice(6);
        expect(before.preapprovals.find((row) => row.emailHash === sharedHash)?.status).toBe("live");
        expect((await invites.withdraw(sharedHash)).statusCode).toBe(200);
        const own = await invites.identity.company.list(me.orgId);
        expect(own.preapprovals.find((row) => row.emailHash === sharedHash)?.status).toBe("withdrawn");
        return { companyId: me.orgId, before, own };
      },
    },
  ]);
});
