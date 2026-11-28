// #1612: an install's GitHub App installations, its own Slack workspace and that workspace's channels move from the built-in company into the install's own company. A preview
// writes nothing; a run writes once; a second run writes nothing; nothing another company holds is touched.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { companyInstallationKey } from "../../packages/broker/src/aws/github-credentials.js";
import { moveInstallConnections } from "../../packages/broker/src/aws/install-company-connections.js";
import { slackChannelBindingKeyFor } from "../../packages/broker/src/aws/slack-company-layout.js";
import { companyWorkspaceKey, markerKey, teamKey } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { InstallCompanyStore } from "../../packages/broker/src/developer/install-company.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const INSTALL = "org_" + "i".repeat(20);
const OTHER = "org_" + "o".repeat(20);
const TEAM = "T0INSTALL1";
const at = "2026-11-27T12:00:00.000Z";
const now = () => Date.parse(at);
const binding = (installationId: number, companyId: string) => ({ pk: `GITHUB_INSTALLATION#${installationId}`, sk: "BINDING", entityType: "GITHUB_INSTALLATION_BINDING", installationId, accountLogin: `acct${installationId}`, companyId, boundAt: at, boundBy: "operator-lambda" });
const channel = (channelId: string, projectName = "web") => ({ pk: `SLACK_BINDING#${TEAM}`, sk: `CHANNEL#${channelId}`, entityType: "CHANNEL_BINDING", channel: "slack", tenant: TEAM, space: channelId, projectName, updatedAt: at, updatedBy: "owner" });
const installations = [1, 2, 3, 4].map((id) => ({ installationId: id, accountLogin: `acct${id}` }));

async function world() {
  const db = new FakeDynamoDb();
  const install = new InstallCompanyStore({ company: new CompanySignInStore({ documentClient: db, tableName: "signin", now }), documentClient: db, tableName: "signin", now, newCompanyId: () => INSTALL });
  await install.ensure({ name: "Acme" });
  db.set(binding(1, IMPLICIT_COMPANY_ID));   // the built-in company's: moves
  // 2: no binding yet: claimed for the install's company
  db.set(binding(3, INSTALL));               // already the install's: left
  db.set(binding(4, OTHER));                 // another company's: never moved
  db.set(channel("C0001")); db.set(channel("C0002", "api"));
  const deps = { documentClient: db, tableName: "state", signInTableName: "signin", now };
  return { db, deps };
}
const input = (apply: boolean) => ({ companyId: INSTALL, slackTeamId: TEAM, installations, apply });

describe("moving the install's connections into its company", () => {
  it("previews every write and writes nothing", async () => {
    const { db, deps } = await world();
    const before = JSON.stringify(db.find(() => true));
    expect(await moveInstallConnections(deps, input(false))).toMatchObject({ failed: false, githubInstallations: { found: 4, written: 2, existing: 1, conflicts: 1 }, slackChannels: { found: 2, written: 2 }, slackWorkspace: "moved" });
    expect(JSON.stringify(db.find(() => true))).toBe(before);
  });

  it("moves GitHub installations, copies the channels and moves the workspace (before the binding backfill), once", async () => {
    const { db, deps } = await world();
    expect(await moveInstallConnections(deps, input(true))).toMatchObject({ failed: false, githubInstallations: { written: 2, existing: 1, conflicts: 1 }, slackChannels: { written: 2 }, slackWorkspace: "moved" });
    for (const id of [1, 2]) {
      expect(db.get(`GITHUB_INSTALLATION#${id}`, "BINDING")).toMatchObject({ companyId: INSTALL });
      expect(db.get(companyInstallationKey(INSTALL, id).pk, companyInstallationKey(INSTALL, id).sk)).toBeDefined();
    }
    expect(db.get("GITHUB_INSTALLATION#4", "BINDING")).toMatchObject({ companyId: OTHER });
    for (const [id, project] of [["C0001", "web"], ["C0002", "api"]] as const) {
      const key = slackChannelBindingKeyFor(INSTALL, TEAM, id);
      expect(db.get(key.pk, key.sk)).toMatchObject({ projectName: project, space: id, updatedBy: "operator.install_move" });
      // The legacy row is kept.
      expect(db.get(`SLACK_BINDING#${TEAM}`, `CHANNEL#${id}`)).toMatchObject({ projectName: project });
    }
    expect(db.get(markerKey.pk, markerKey.sk)).toBeDefined();
    expect(db.get(teamKey(TEAM).pk, teamKey(TEAM).sk)).toMatchObject({ companyId: INSTALL });
    expect(db.get(companyWorkspaceKey(INSTALL, TEAM).pk, companyWorkspaceKey(INSTALL, TEAM).sk)).toBeDefined();

    expect(await moveInstallConnections(deps, input(true))).toMatchObject({ failed: false, githubInstallations: { written: 0, existing: 3, conflicts: 1 }, slackChannels: { written: 0, existing: 2 }, slackWorkspace: "existing" });
  });

  it("binds a workspace with no binding after the backfill, and never moves one another company holds", async () => {
    const { db, deps } = await world();
    db.set({ ...markerKey });
    expect((await moveInstallConnections(deps, input(true))).slackWorkspace).toBe("bound");
    expect(db.get(teamKey(TEAM).pk, teamKey(TEAM).sk)).toMatchObject({ companyId: INSTALL });

    const other = await world();
    other.db.set({ ...markerKey });
    other.db.set({ ...teamKey(TEAM), entityType: "SLACK_WORKSPACE_BINDING", teamId: TEAM, companyId: OTHER, boundAt: at, boundBy: "operator" });
    expect((await moveInstallConnections(other.deps, input(true))).slackWorkspace).toBe("conflict");
    expect(other.db.get(teamKey(TEAM).pk, teamKey(TEAM).sk)).toMatchObject({ companyId: OTHER });
  });

  it("never writes over a different channel binding already in the company", async () => {
    const { db, deps } = await world();
    const key = slackChannelBindingKeyFor(INSTALL, TEAM, "C0001");
    db.set({ ...channel("C0001", "other"), ...key });
    expect((await moveInstallConnections(deps, input(true))).slackChannels).toMatchObject({ conflicts: 1, written: 1 });
    expect(db.get(key.pk, key.sk)).toMatchObject({ projectName: "other" });
  });

  it("refuses a company that is not the install's own before reading or writing anything else", async () => {
    const { db, deps } = await world();
    const before = JSON.stringify(db.find(() => true));
    expect(await moveInstallConnections(deps, { ...input(true), companyId: OTHER })).toMatchObject({ failed: true, githubInstallations: { found: 0 } });
    expect(JSON.stringify(db.find(() => true))).toBe(before);
  });
});
