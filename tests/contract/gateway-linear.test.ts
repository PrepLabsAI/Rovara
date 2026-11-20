import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LINEAR_MCP_ENDPOINT, issueInTeamGuard, linearBinder, linearConnector, GuardRejection, type LinearTeamScope } from "../../packages/gateway/src/index.js";

/** The live get_issue result (2026-09-24), free text replaced: top-level teamId (UUID), team (name), id (identifier). */
const issueFixture = JSON.parse(readFileSync(new URL("../fixtures/vendors/linear-get-issue.json", import.meta.url), "utf8")) as Record<string, unknown>;
const CHARTERARC = "c408e946-78aa-4db8-923e-f78053dd954f";
const OTHER = "0b6f3f7e-5d1a-4c1e-9a53-2f0f5a8f1c11";
const scope: LinearTeamScope = { alias: "charterarc", teamId: CHARTERARC };
const bound = { team: CHARTERARC, teamId: CHARTERARC };

/** The live get_issue result with its team UUID set to `teamId`. */
const issueIn = (teamId: string): Record<string, unknown> => ({ ...structuredClone(issueFixture), teamId });
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

describe("linear connector definition", () => {
  it("points at the Linear MCP endpoint and signs description, then body", () => {
    const definition = linearConnector({ issue: vi.fn() });
    expect(LINEAR_MCP_ENDPOINT.href).toBe("https://mcp.linear.app/mcp");
    expect(definition).toMatchObject({ label: "Linear", endpoint: LINEAR_MCP_ENDPOINT, attributionKeys: ["description", "body"], guards: [issueInTeamGuard], binder: linearBinder });
  });

});

describe("issue-in-team guard", () => {
  /** `teamId` is a team UUID, or "error" / "garbage" for a failed or unreadable get_issue. */
  const connection = (teamId: string) => ({
    call: vi.fn(async () => teamId === "error" ? { isError: true, content: [{ type: "text", text: "Entity not found" }] }
      : teamId === "garbage" ? { content: [{ type: "text", text: "not json" }] } : text(issueIn(teamId))),
  });
  /** An explicit `undefined` target is passed through as a missing scope; only an omitted one defaults. */
  const check = (tool: string, args: Record<string, unknown>, conn: ReturnType<typeof connection>, ...target: [unknown?]) =>
    issueInTeamGuard.check({ tool, arguments: args, bound, scope: target.length > 0 ? target[0] : scope, connection: conn });

  it("refuses get_issue with includeRelations: true before any Linear call, and leaves includeRelations false or absent unchanged", async () => {
    const conn = connection(CHARTERARC);
    await expect(check("get_issue", { id: "CHA-1", includeRelations: true }, conn))
      .rejects.toThrow(new GuardRejection("This Linear connector refuses get_issue with includeRelations: true, because related issues can belong to another team it does not return."));
    expect(conn.call).not.toHaveBeenCalled();
    await expect(check("get_issue", { id: "CHA-1", includeRelations: false }, conn)).resolves.toBeUndefined();
    await expect(check("get_issue", { id: "CHA-1" }, conn)).resolves.toBeUndefined();
    expect(conn.call).toHaveBeenCalledTimes(2);
  });

  it("refuses an issue in another team, a missing issue and an unreadable answer", async () => {
    await expect(check("save_issue", { id: "OTH-9" }, connection(OTHER))).rejects.toThrow(new GuardRejection('Linear issue "OTH-9" is not in the charterarc team this connector may use.'));
    await expect(check("save_comment", { issueId: "OTH-9", body: "x" }, connection(OTHER))).rejects.toBeInstanceOf(GuardRejection);
    await expect(check("get_issue", { id: "OTH-9" }, connection(OTHER))).rejects.toBeInstanceOf(GuardRejection);
    await expect(check("save_issue", { id: "CHA-404" }, connection("error"))).rejects.toThrow(new GuardRejection('Linear issue "CHA-404" was not found or this connector cannot see it.'));
    await expect(check("save_issue", { id: "CHA-1" }, connection("garbage"))).rejects.toThrow(new GuardRejection('Could not confirm that Linear issue "CHA-1" is in the charterarc team, so the request was not sent.'));
    // Only the live field counts: a result with the team name but no teamId is refused.
    const nameOnly = { call: vi.fn(async () => text({ ...issueFixture, teamId: undefined, team: "CharterArc" })) };
    await expect(check("save_issue", { id: "CHA-1" }, nameOnly as never)).rejects.toThrow(new GuardRejection('Could not confirm that Linear issue "CHA-1" is in the charterarc team, so the request was not sent.'));
  });

  it("does not check a create, and refuses comment targets it cannot verify", async () => {
    const conn = connection(CHARTERARC);
    await expect(check("save_issue", { title: "new" }, conn)).resolves.toBeUndefined();
    for (const other of ["id", "parentId", "projectId", "initiativeId", "documentId", "milestoneId", "statusUpdateId", "statusUpdateType"]) {
      await expect(check("save_comment", { [other]: "x", body: "b" }, conn)).rejects.toThrow(new GuardRejection(`This Linear connector only works with comments on issues in the charterarc team, so ${other} is not allowed. Pass issueId.`));
    }
    await expect(check("list_comments", {}, conn)).rejects.toThrow(new GuardRejection("Pass issueId: this Linear connector only works with comments on issues in the charterarc team."));
    expect(conn.call).not.toHaveBeenCalled();
  });
});

describe("issue-in-team guard: issues referenced by save_issue", () => {
  /** get_issue answers with the team in `teamOf`, "garbage" for an unreadable answer, and an error otherwise. */
  const teams = (teamOf: Record<string, string>) => ({
    call: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      const team = teamOf[String(args.id)];
      if (team === undefined) return { isError: true, content: [{ type: "text", text: "Entity not found" }] };
      return team === "garbage" ? { content: [{ type: "text", text: "not json" }] } : text(issueIn(team));
    }),
  });
  const check = (args: Record<string, unknown>, conn: ReturnType<typeof teams>) =>
    issueInTeamGuard.check({ tool: "save_issue", arguments: args, bound, scope, connection: conn });


  it("fails closed on a reference that is not an issue id", async () => {
    const conn = teams({ "CHA-1": CHARTERARC, "CHA-2": CHARTERARC });
    await expect(check({ id: "CHA-1", blocks: ["CHA-2", 7] }, conn)).rejects.toThrow(new GuardRejection("Invalid Linear issue ID."));
    await expect(check({ id: "CHA-1", relatedTo: "CHA-2" }, conn)).rejects.toThrow(new GuardRejection("Invalid Linear issue ID."));
    await expect(check({ title: "new", parentId: "" }, conn)).rejects.toThrow(new GuardRejection("Invalid Linear issue ID."));
    expect(conn.call).not.toHaveBeenCalled();
  });

});

