// #1612: an install's old built-in-company projects, people and grants move into its own company, with no manual steps. A preview writes nothing; a run writes each row once; a
// second run writes nothing; legacy rows are never changed.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, SLACK_OIDC_ISSUER, orgProjectCatalogKey, projectRevisionKey } from "@agentx/contracts";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { grantKeyFor, projectMemberRowKeyFor } from "../../packages/broker/src/aws/company-layout.js";
import { moveIntoInstallCompany } from "../../packages/broker/src/aws/install-company-move.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { INSTALL_COMPANY_KEY, InstallCompanyStore } from "../../packages/broker/src/developer/install-company.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const INSTALL = "org_" + "i".repeat(20);
const OTHER = "org_" + "o".repeat(20);
const at = "2026-11-27T12:00:00.000Z";
const now = () => Date.parse(at);
const OWNER = ownerKeyForSubject("https://idp.example.test", "owner");
const SIGNED_IN = ownerKeyForSubject(SLACK_OIDC_ISSUER, "U0SIGNED");
const NOT_YET = ownerKeyForSubject(SLACK_OIDC_ISSUER, "U0NOTYET");
const ELSEWHERE = ownerKeyForSubject(SLACK_OIDC_ISSUER, "U0ELSEWHERE");
const definition = { name: "web", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };

function legacyGrant(db: FakeDynamoDb, personId: string, role: "developer" | "administrator") {
  db.set({ ...grantKeyFor(undefined, personId, "web"), entityType: "MEMBERSHIP", ownerKey: personId, projectName: "web", role, grantId: `grant-${personId.slice(0, 6)}`, grantedAt: at });
  db.set({ ...projectMemberRowKeyFor(undefined, "web", personId), entityType: "PROJECT_MEMBER", role, grantedAt: at });
}
const developer = (db: FakeDynamoDb, personId: string, extra: Record<string, unknown> = {}) =>
  db.set({ pk: `DEVELOPER#${personId}`, sk: "META", entityType: "DEVELOPER", provider: "slack", issuer: SLACK_OIDC_ISSUER, subject: "x", displayName: "Person", firstSignInAt: at, revoked: false, ...extra });

async function world() {
  const db = new FakeDynamoDb();
  db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", definition, registeredAt: at });
  db.set({ ...orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  legacyGrant(db, OWNER, "administrator");
  legacyGrant(db, SIGNED_IN, "developer");
  legacyGrant(db, NOT_YET, "developer");
  legacyGrant(db, ELSEWHERE, "developer");
  developer(db, OWNER, { provider: "oidc" });
  db.set({ ...emailIndexKey("owner@example.test"), entityType: "DEVELOPER_EMAIL", developerId: OWNER, updatedAt: at });
  developer(db, SIGNED_IN);
  developer(db, ELSEWHERE);
  db.set({ ...membershipKey(ELSEWHERE), entityType: "COMPANY_MEMBERSHIP", personId: ELSEWHERE, companyId: OTHER, role: "member", joinedAt: at });
  const company = new CompanySignInStore({ documentClient: db, tableName: "signin", now });
  const install = new InstallCompanyStore({ company, documentClient: db, tableName: "signin", now, newCompanyId: () => INSTALL });
  await install.ensure({ name: "Acme", ownerEmail: "owner@example.test" });
  const deps = { documentClient: db, tableName: "state", signInTableName: "signin", now };
  return { db, deps };
}

describe("moving the built-in company into the install's company", () => {
  it("previews every write and writes nothing", async () => {
    const { db, deps } = await world();
    const before = JSON.stringify(db.find(() => true));
    const report = await moveIntoInstallCompany(deps, { companyId: INSTALL, apply: false });
    expect(report).toMatchObject({ failed: false, projects: { found: 1, written: 1 }, grants: { found: 4, written: 4 }, people: { found: 3, written: 2, conflicts: 1 }, notSignedIn: 1 });
    expect(JSON.stringify(db.find(() => true))).toBe(before);
  });

  it("moves the project, seats the people who signed in (the owner as owner) and copies every grant, once", async () => {
    const { db, deps } = await world();
    const report = await moveIntoInstallCompany(deps, { companyId: INSTALL, apply: true });
    expect(report).toMatchObject({ failed: false, projects: { found: 1, written: 1 }, grants: { found: 4, written: 4, conflicts: 0 }, people: { found: 3, written: 2, conflicts: 1 }, notSignedIn: 1 });
    expect(db.get(projectRevisionKey(INSTALL, "web", 1).pk, projectRevisionKey(INSTALL, "web", 1).sk)).toBeDefined();
    expect(db.get(orgProjectCatalogKey(INSTALL, "web").pk, orgProjectCatalogKey(INSTALL, "web").sk)).toBeDefined();
    expect(db.get(membershipKey(OWNER).pk, "COMPANY")).toMatchObject({ companyId: INSTALL, role: "owner", joinedVia: "install" });
    expect(db.get(INSTALL_COMPANY_KEY.pk, INSTALL_COMPANY_KEY.sk)).toMatchObject({ ownerClaimedBy: OWNER });
    expect(db.get(membershipKey(SIGNED_IN).pk, "COMPANY")).toMatchObject({ companyId: INSTALL, role: "member" });
    // Not signed in yet: no membership, but the grant is already in the company for when they join.
    expect(db.get(membershipKey(NOT_YET).pk, "COMPANY")).toBeUndefined();
    for (const [person, role] of [[OWNER, "administrator"], [SIGNED_IN, "developer"], [NOT_YET, "developer"]] as const) {
      expect(db.get(grantKeyFor(INSTALL, person, "web").pk, "PROJECT#web")).toMatchObject({ entityType: "MEMBERSHIP", ownerKey: person, projectName: "web", role });
      expect(db.get(projectMemberRowKeyFor(INSTALL, "web", person).pk, `DEVELOPER#${person}`)).toMatchObject({ entityType: "PROJECT_MEMBER", role });
    }
    // A member of another company keeps it.
    expect(db.get(membershipKey(ELSEWHERE).pk, "COMPANY")).toMatchObject({ companyId: OTHER });
    // Legacy rows are untouched.
    expect(db.get("PROJECT#web", "REV#000000000001")).toMatchObject({ entityType: "PROJECT" });
    expect(db.get(`MEMBER#${SIGNED_IN}`, "PROJECT#web")).toMatchObject({ role: "developer" });

    const again = await moveIntoInstallCompany(deps, { companyId: INSTALL, apply: true });
    expect(again).toMatchObject({ failed: false, projects: { written: 0, existing: 1 }, grants: { written: 0, existing: 4 }, people: { written: 0, existing: 2, conflicts: 1 } });
  });

  it("never writes over a different grant already in the company", async () => {
    const { db, deps } = await world();
    db.set({ ...grantKeyFor(INSTALL, NOT_YET, "web"), entityType: "MEMBERSHIP", ownerKey: NOT_YET, projectName: "web", role: "administrator", grantId: "g", grantedAt: at });
    const report = await moveIntoInstallCompany(deps, { companyId: INSTALL, apply: true });
    expect(report.grants).toMatchObject({ conflicts: 1, written: 3 });
    expect(db.get(grantKeyFor(INSTALL, NOT_YET, "web").pk, "PROJECT#web")).toMatchObject({ role: "administrator" });
  });

  it("refuses a company that is not the install's own before reading or writing anything else", async () => {
    const { db, deps } = await world();
    const before = JSON.stringify(db.find(() => true));
    expect(await moveIntoInstallCompany(deps, { companyId: OTHER, apply: true })).toMatchObject({ failed: true, projects: { found: 0, written: 0 }, grants: { found: 0 } });
    expect(JSON.stringify(db.find(() => true))).toBe(before);
    await expect(moveIntoInstallCompany(deps, { companyId: IMPLICIT_COMPANY_ID, apply: true })).rejects.toThrow();
  });
});
