// #1612: a person signing in with the install's own Slack workspace or OIDC, with no membership anywhere, joins the install's own company. The first to sign in with the owner's
// verified email is its owner (once); everyone else is a member. Anyone already in a company keeps it, a removed member stays refused, and other Slack workspaces join nothing.
import { describe, expect, it } from "vitest";
import { SLACK_OIDC_ISSUER } from "@agentx/contracts";
import { membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { INSTALL_COMPANY_KEY, InstallCompanyStore } from "../../packages/broker/src/developer/install-company.js";
import { TEAM } from "../support/developer-fakes.js";
import { person, sharedSignInWorld, X } from "../support/company-shared-signin-world.js";

const INSTALL = "org_" + "i".repeat(20);
const OTHER = "T0OTHER9";
const slackId = (subject: string) => ownerKeyForSubject(SLACK_OIDC_ISSUER, subject);
const slackUsers = [
  { userId: "U0INSTALL", name: "Install Person", email: "install@example.test", emailVerified: true },
  { userId: "U0FOREIGN", teamId: OTHER, name: "Foreign Person", email: "foreign@other.test", emailVerified: true },
];

function world(options: { administrator?: boolean } = {}) {
  const w = sharedSignInWorld({ slackUsers, ...options });
  const install = new InstallCompanyStore({ company: w.company, documentClient: w.db, tableName: "signin", now: w.now, newCompanyId: () => INSTALL });
  w.deps.installCompany = install;
  const membership = (id: string) => w.db.get(membershipKey(id).pk, "COMPANY");
  return { ...w, install, membership };
}

describe("signing in to the install's own company (#1612)", () => {
  it("makes the owner's email the owner, once, and everyone else from the install's OIDC a member", async () => {
    const w = world();
    await w.install.ensure({ name: "Acme", ownerEmail: "owner@example.test" });
    const owner = await w.signIn("owner");
    expect(owner.refused).toBeUndefined();
    expect(w.membership(person("owner"))).toMatchObject({ companyId: INSTALL, role: "owner", joinedVia: "install" });
    expect(w.db.get(INSTALL_COMPANY_KEY.pk, INSTALL_COMPANY_KEY.sk)).toMatchObject({ ownerClaimedBy: person("owner") });
    expect((await w.access(owner.access)).body).toMatchObject({ companyId: INSTALL });

    const carol = await w.signIn("carol", { cli: true });
    expect(carol.refused).toBeUndefined();
    expect(w.membership(person("carol"))).toMatchObject({ companyId: INSTALL, role: "member", joinedVia: "install" });
    // Signing in again changes nothing.
    await w.signIn("owner", { cli: true });
    expect(w.membership(person("owner"))).toMatchObject({ role: "owner" });
  });

  it("joins a person from the install's own Slack workspace, and nobody from another workspace", async () => {
    const w = world();
    await w.install.ensure({ name: "Acme" });
    const own = await w.signIn("U0INSTALL", { slackTeam: TEAM, cli: true });
    expect(own.refused).toBeUndefined();
    expect(w.membership(slackId("U0INSTALL"))).toMatchObject({ companyId: INSTALL, role: "member", joinedVia: "install" });
    expect((await w.signIn("U0FOREIGN", { slackTeam: OTHER, cli: true })).refused).toBe("not invited");
    expect(w.membership(slackId(`${OTHER}:U0FOREIGN`))).toBeUndefined();
  });

  it("never moves a person who is already in another company, and keeps a removed member refused", async () => {
    const w = world();
    await w.setup(); // owner makes company X by self-serve
    await w.install.ensure({ name: "Acme" });
    await w.signIn("owner", { cli: true });
    expect(w.membership(person("owner"))).toMatchObject({ companyId: X });

    await w.signIn("carol", { cli: true });
    expect(w.membership(person("carol"))).toMatchObject({ companyId: INSTALL });
    expect(await w.company.setRevoked(INSTALL, person("carol"), true)).toBe(true);
    expect((await w.signIn("carol", { cli: true })).refused).toBeDefined();
    expect(w.membership(person("carol"))).toMatchObject({ companyId: INSTALL });
    expect(w.membership(person("carol"))?.revokedAt).toBeDefined();
  });

  it("joins nobody into a company before the install has one", async () => {
    const w = world();
    expect((await w.signIn("carol", { cli: true })).refused).toBe("not invited");
    expect(w.membership(person("carol"))).toBeUndefined();
  });

  it("keeps the install administrator's flag in the install's own company", async () => {
    const w = world({ administrator: true });
    await w.install.ensure({ name: "Acme", ownerEmail: "owner@example.test" });
    const owner = await w.signIn("owner");
    expect((await w.access(owner.access)).body).toMatchObject({ companyId: INSTALL, administrator: true });
  });
});
