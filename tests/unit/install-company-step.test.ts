// #1612: init and upgrade make (or find) the install's own company and move the built-in company's records into it; doctor previews what is left. No manual steps.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, orgProjectCatalogKey } from "@agentx/contracts";
import { installCompanyLines, installCompanyPending, runInstallCompanyStep } from "../../packages/cli/src/company/install-company-step.js";
import { INSTALL_COMPANY_KEY } from "../../packages/broker/src/developer/install-company.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const at = "2026-11-27T12:00:00.000Z";
const MOVED = "org_" + "m".repeat(20);
const TEAM = "T0INSTALL1";
const outputs = { StateTableName: "state", DeveloperSignInTableName: "signin" };
const definition = { name: "web", revision: 1, repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }], setup: [], readiness: [], orchestratorInstructions: "Delegate work." };

function world() {
  const db = new FakeDynamoDb();
  db.set({ pk: "PROJECT#web", sk: "REV#000000000001", entityType: "PROJECT", definition, registeredAt: at });
  db.set({ ...orgProjectCatalogKey(IMPLICIT_COMPANY_ID, "web"), entityType: "PROJECT_CATALOG", latestRevision: 1 });
  const lines: string[] = [];
  const deps = { documentClient: db, installations: async () => [{ installationId: 7, accountLogin: "acme" }], now: () => Date.parse(at), write: (line: string) => lines.push(line) };
  return { db, deps, lines };
}

describe("the install company step", () => {
  it("is skipped until the control plane names its sign-in table", async () => {
    const { deps } = world();
    const result = await runInstallCompanyStep(deps, { env: "acme", outputs: { StateTableName: "state" }, parameters: {}, apply: true });
    expect(result).toEqual({ status: "skipped", reason: "the control plane names no sign-in table yet; upgrade it first" });
    expect(installCompanyLines(result)).toEqual(["Company: skipped, the control plane names no sign-in table yet; upgrade it first"]);
  });

  it("previews without making anything on an install with no company yet", async () => {
    const { db, deps } = world();
    const before = JSON.stringify(db.find(() => true));
    const result = await runInstallCompanyStep(deps, { env: "acme", outputs, parameters: { SlackTeamId: TEAM }, apply: false });
    expect(result).toEqual({ status: "skipped", reason: "this install has no company yet; run agentx upgrade" });
    expect(JSON.stringify(db.find(() => true))).toBe(before);
  });

  it("makes the company named after the environment, names the owner, moves the records, and finds the same company next time", async () => {
    const { db, deps } = world();
    const first = await runInstallCompanyStep(deps, { env: "acme", outputs, parameters: { SlackTeamId: TEAM }, ownerEmail: "owner@example.test", apply: true });
    expect(first).toMatchObject({ status: "done", outcome: "created", move: { failed: false, projects: { written: 1 } }, connections: { failed: false, githubInstallations: { written: 1 }, slackWorkspace: "moved" } });
    const companyId = (first as { companyId: string }).companyId;
    expect(db.get(INSTALL_COMPANY_KEY.pk, INSTALL_COMPANY_KEY.sk)).toMatchObject({ companyId, via: "created", ownerEmailHash: expect.any(String) as unknown });
    expect(db.get(`ORG#${companyId}#COMPANY`, "META")).toMatchObject({ name: "acme" });
    expect(installCompanyLines(first)[0]).toBe(`Company: ${companyId} (created)`);
    expect(installCompanyLines(first)[1]).toBe("Company: moved 1 projects, 0 people, 0 grants, 1 GitHub installations, 0 Slack channels; Slack workspace moved");

    const preview = await runInstallCompanyStep(deps, { env: "acme", outputs, parameters: { SlackTeamId: TEAM }, apply: false });
    expect(preview).toMatchObject({ status: "done", companyId, outcome: "existing" });
    expect(installCompanyPending(preview)).toBe(0);
    const again = await runInstallCompanyStep(deps, { env: "acme", outputs, parameters: { SlackTeamId: TEAM }, apply: true });
    expect(again).toMatchObject({ status: "done", companyId, outcome: "existing", move: { projects: { written: 0, existing: 1 } } });
  });

  it("names the company after the Slack workspace when it is known", async () => {
    const { db, deps } = world();
    const result = await runInstallCompanyStep(deps, { env: "acme", outputs, parameters: {}, slackTeamName: "Acme Corp", apply: true });
    expect(db.get(`ORG#${(result as { companyId: string }).companyId}#COMPANY`, "META")).toMatchObject({ name: "Acme Corp" });
  });

  it("adopts the named company the install's Slack workspace is already bound to (an install moved by hand)", async () => {
    const { db, deps } = world();
    db.set({ pk: `ORG#${MOVED}#COMPANY`, sk: "META", entityType: "COMPANY", companyId: MOVED, name: "Moved", status: "active", createdAt: at, createdBy: "operator" });
    db.set({ pk: `SLACK_TEAM#${TEAM}`, sk: "BINDING", entityType: "SLACK_WORKSPACE_BINDING", teamId: TEAM, companyId: MOVED, boundAt: at, boundBy: "operator.move" });
    db.set({ pk: "SLACK_WORKSPACE_BINDING", sk: "BACKFILL" });
    const result = await runInstallCompanyStep(deps, { env: "acme", outputs, parameters: { SlackTeamId: TEAM }, apply: true });
    expect(result).toMatchObject({ status: "done", companyId: MOVED, outcome: "adopted", connections: { slackWorkspace: "existing" } });
  });

  it("still moves the rest when the GitHub App's installations cannot be read", async () => {
    const { deps, lines } = world();
    const result = await runInstallCompanyStep({ ...deps, installations: async () => { throw new Error("private-detail"); } }, { env: "acme", outputs, parameters: {}, apply: true });
    expect(result).toMatchObject({ status: "done", move: { projects: { written: 1 } }, connections: { githubInstallations: { found: 0 } } });
    expect(lines).toEqual(["Company: the GitHub App's installations could not be read; GitHub is moved on the next run"]);
  });
});
