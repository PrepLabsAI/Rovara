// #1300: the operator move of the legacy install's Slack workspace and GitHub App installations between the built-in company and one named company. Preview by default,
// one side always the built-in company, and a move only from the company the binding holds now.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { companyInstallationKey, moveGithubInstallation } from "../../packages/broker/src/aws/github-credentials.js";
import { LEGACY_MOVE_ARGUMENTS_REFUSED, parseLegacyMoveArguments } from "../../packages/broker/src/aws/legacy-install-move.js";
import { companyWorkspaceKey, markerKey, moveSlackWorkspace, teamKey } from "../../packages/broker/src/aws/slack-workspace-binding.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const TABLE = "State";
const TEAM = "T0LEGACY01";
const INSTALLATION = 4242;
const NOW = Date.parse("2026-11-21T12:00:00.000Z");

function world() {
  const db = new FakeDynamoDb();
  db.set({ ...markerKey });
  const binding = { ...teamKey(TEAM), entityType: "SLACK_WORKSPACE_BINDING", teamId: TEAM, companyId: IMPLICIT_COMPANY_ID, boundAt: "2026-11-19T20:21:42.842Z", boundBy: "backfill" };
  db.set(binding);
  db.set({ ...companyWorkspaceKey(IMPLICIT_COMPANY_ID, TEAM), entityType: "COMPANY_SLACK_WORKSPACE_VIEW", teamId: TEAM, companyId: IMPLICIT_COMPANY_ID, boundAt: binding.boundAt, boundBy: binding.boundBy });
  db.set({ pk: `GITHUB_INSTALLATION#${INSTALLATION}`, sk: "BINDING", entityType: "GITHUB_INSTALLATION_BINDING", installationId: INSTALLATION, accountLogin: "legacy-org",
    companyId: IMPLICIT_COMPANY_ID, boundAt: "2026-11-19T20:21:42.842Z", boundBy: "backfill" });
  return { db, deps: { client: db, tableName: TABLE, now: () => NOW } };
}

describe("moving the legacy Slack workspace", () => {
  it("previews by default and writes nothing", async () => {
    const { db, deps } = world();
    const before = JSON.stringify([...db.items.entries()]);
    const plan = await moveSlackWorkspace(deps, { teamId: TEAM, from: IMPLICIT_COMPANY_ID, to: A, by: "operator.move" });
    expect(plan).toMatchObject({ teamId: TEAM, from: IMPLICIT_COMPANY_ID, to: A, applied: false });
    expect(JSON.stringify([...db.items.entries()])).toBe(before);
  });

  it("applied, moves the binding and its company views in one step", async () => {
    const { db, deps } = world();
    await moveSlackWorkspace(deps, { teamId: TEAM, from: IMPLICIT_COMPANY_ID, to: A, by: "operator.move", apply: true });
    expect(db.get(teamKey(TEAM).pk, "BINDING")).toMatchObject({ companyId: A, boundBy: "operator.move", boundAt: new Date(NOW).toISOString() });
    expect(db.get(companyWorkspaceKey(IMPLICIT_COMPANY_ID, TEAM).pk, `TEAM#${TEAM}`)).toBeUndefined();
    expect(db.get(companyWorkspaceKey(A, TEAM).pk, `TEAM#${TEAM}`)).toMatchObject({ companyId: A, teamId: TEAM });
    // And back: the undo is the same move the other way.
    await moveSlackWorkspace(deps, { teamId: TEAM, from: A, to: IMPLICIT_COMPANY_ID, by: "operator.undo", apply: true });
    expect(db.get(teamKey(TEAM).pk, "BINDING")).toMatchObject({ companyId: IMPLICIT_COMPANY_ID });
    expect(db.get(companyWorkspaceKey(A, TEAM).pk, `TEAM#${TEAM}`)).toBeUndefined();
  });

  it("refuses a move between two named companies, from a company the binding does not hold, or with a bad label", async () => {
    const { db, deps } = world();
    await moveSlackWorkspace(deps, { teamId: TEAM, from: IMPLICIT_COMPANY_ID, to: A, by: "operator.move", apply: true });
    const before = JSON.stringify([...db.items.entries()]);
    await expect(moveSlackWorkspace(deps, { teamId: TEAM, from: A, to: B, by: "operator.move", apply: true })).rejects.toThrow("This Slack workspace is not available.");
    await expect(moveSlackWorkspace(deps, { teamId: TEAM, from: IMPLICIT_COMPANY_ID, to: B, by: "operator.move", apply: true })).rejects.toThrow("This Slack workspace is not available.");
    await expect(moveSlackWorkspace(deps, { teamId: TEAM, from: A, to: IMPLICIT_COMPANY_ID, by: "Not A Label", apply: true })).rejects.toThrow("This Slack workspace is not available.");
    expect(JSON.stringify([...db.items.entries()])).toBe(before);
  });
});

describe("moving a legacy GitHub App installation", () => {
  it("previews by default and writes nothing, naming the account", async () => {
    const { db, deps } = world();
    const before = JSON.stringify([...db.items.entries()]);
    expect(await moveGithubInstallation(deps, { installationId: INSTALLATION, from: IMPLICIT_COMPANY_ID, to: A, by: "operator.move" }))
      .toMatchObject({ installationId: INSTALLATION, accountLogin: "legacy-org", applied: false });
    expect(JSON.stringify([...db.items.entries()])).toBe(before);
  });

  it("applied, moves the binding and the company list row; the undo moves it back", async () => {
    const { db, deps } = world();
    await moveGithubInstallation(deps, { installationId: INSTALLATION, from: IMPLICIT_COMPANY_ID, to: A, by: "operator.move", apply: true });
    expect(db.get(`GITHUB_INSTALLATION#${INSTALLATION}`, "BINDING")).toMatchObject({ companyId: A, accountLogin: "legacy-org", boundBy: "operator.move" });
    const row = companyInstallationKey(A, INSTALLATION);
    expect(db.get(row.pk, row.sk)).toMatchObject({ entityType: "GITHUB_COMPANY_INSTALLATION", companyId: A, installationId: INSTALLATION, accountLogin: "legacy-org" });
    await moveGithubInstallation(deps, { installationId: INSTALLATION, from: A, to: IMPLICIT_COMPANY_ID, by: "operator.undo", apply: true });
    expect(db.get(`GITHUB_INSTALLATION#${INSTALLATION}`, "BINDING")).toMatchObject({ companyId: IMPLICIT_COMPANY_ID });
    expect(db.get(row.pk, row.sk)).toBeUndefined();
  });

  it("refuses a move between two named companies or from a company the binding does not hold", async () => {
    const { db, deps } = world();
    const before = JSON.stringify([...db.items.entries()]);
    await expect(moveGithubInstallation(deps, { installationId: INSTALLATION, from: A, to: B, by: "operator.move", apply: true })).rejects.toThrow("the GitHub installation is not connected");
    await expect(moveGithubInstallation(deps, { installationId: INSTALLATION, from: A, to: IMPLICIT_COMPANY_ID, by: "operator.move", apply: true })).rejects.toThrow("the GitHub installation is not connected");
    await expect(moveGithubInstallation(deps, { installationId: 1, from: IMPLICIT_COMPANY_ID, to: A, by: "operator.move", apply: true })).rejects.toThrow("the GitHub installation is not connected");
    expect(JSON.stringify([...db.items.entries()])).toBe(before);
  });
});

describe("the operator command's arguments", () => {
  it("takes exactly one move, preview unless --apply", () => {
    expect(parseLegacyMoveArguments(["--state-table", TABLE, "--slack-team", TEAM, "--from", IMPLICIT_COMPANY_ID, "--to", A, "--by", "operator.move"]))
      .toEqual({ kind: "slack", tableName: TABLE, teamId: TEAM, from: IMPLICIT_COMPANY_ID, to: A, by: "operator.move", apply: false });
    expect(parseLegacyMoveArguments(["--state-table", TABLE, "--github-installation", "4242", "--from", IMPLICIT_COMPANY_ID, "--to", A, "--by", "operator.move", "--apply"]))
      .toMatchObject({ kind: "github", installationId: 4242, apply: true });
    for (const args of [
      ["--state-table", TABLE, "--from", IMPLICIT_COMPANY_ID, "--to", A, "--by", "x"],
      ["--state-table", TABLE, "--slack-team", TEAM, "--github-installation", "1", "--from", IMPLICIT_COMPANY_ID, "--to", A, "--by", "x"],
      ["--state-table", TABLE, "--github-installation", "01", "--from", IMPLICIT_COMPANY_ID, "--to", A, "--by", "x"],
      ["--state-table", TABLE, "--slack-team", TEAM, "--from", IMPLICIT_COMPANY_ID, "--to", A, "--by", "x", "--apply", "--apply"],
      ["--state-table", TABLE, "--slack-team", TEAM, "--from", IMPLICIT_COMPANY_ID, "--to", A, "--by", "x", "--force"],
    ]) expect(() => parseLegacyMoveArguments(args), args.join(" ")).toThrow(LEGACY_MOVE_ARGUMENTS_REFUSED);
  });
});
