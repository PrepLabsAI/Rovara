import { describe, expect, it } from "vitest";
import { PresentedToolSchema, ProjectDefinitionSchema, SlackThreadWorkspaceResultSchema, ToolPatternSchema, toolPatternMatches } from "../../packages/contracts/src/index.js";
import { expectLinearScaling } from "../support/scaling.js";

const repository = { name: "api", url: "https://github.com/example/api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" };
const project = (actionPolicy: unknown, connectors: unknown[] = [{ name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }, { name: "issue_write", access: "write" }] }]) => ({
  name: "payments", revision: 1, repositories: [repository], setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  integrations: { connectors }, actionPolicy,
});
const issues = (value: unknown) => {
  const parsed = ProjectDefinitionSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("action policy contracts", () => {

  it("matches a many-star pattern in linear time, with no catastrophic backtracking", () => {
    const pattern = "*a".repeat(8);
    const hostile = `${"*a".repeat(7)}*b*`; // every middle segment is found, then `b` is absent: the whole name is scanned
    expect(toolPatternMatches(pattern, `${"a".repeat(63)}b`)).toBe(false);
    let results: boolean[] = [];
    expectLinearScaling((size) => {
      const name = `${"a".repeat(size - 1)}b`;
      const allA = "a".repeat(size);
      return () => { results = [toolPatternMatches(pattern, name), toolPatternMatches(hostile, allA)]; };
    }, { n: 12_500, unitBytes: 2, label: "toolPatternMatches many-star pattern" });
    expect(results).toEqual([false, false]);
  });

  it("limits a tool pattern to at most 4 *", () => {
    expect(ToolPatternSchema.safeParse("a*b*c*d*e").success).toBe(true);
    expect(ToolPatternSchema.safeParse("a*b*c*d*e*f").success).toBe(false);
    expect(ToolPatternSchema.safeParse("*").success).toBe(true);
  });

  it("registers rules that name a configured connector's approved tools, a presented name or an in-house tool", () => {
    expect(issues(project({ rules: [
      { tool: "issue_write", connector: "github", whenArguments: ["state"], treatAs: "destructive" },
      { tool: "github__list_*", outcome: "allow" },
      { tool: "agentx_create_pull_request", outcome: "ask", reason: "Pull requests need a person." },
    ] }))).toEqual([]);
  });

  it("refuses a rule for a connector the project does not configure, or a pattern that matches nothing", () => {
    expect(issues(project({ rules: [{ tool: "save_issue", connector: "linear", outcome: "ask" }] })))
      .toEqual(["action policy rule 1: connector linear is not configured"]);
    expect(issues(project({ rules: [{ tool: "delete_*", connector: "github", outcome: "deny" }] })))
      .toEqual(["action policy rule 1: delete_* matches no approved github tool"]);
    expect(issues(project({ rules: [{ tool: "linear__*", outcome: "deny" }] })))
      .toEqual(["action policy rule 1: linear__* matches no tool this project offers"]);
  });

  it("reads the legacy githubMcp policy as a connector named github", () => {
    const legacy = { ...project({ rules: [{ tool: "issue_write", connector: "github", outcome: "ask" }] }), integrations: { githubMcp: { tools: [{ name: "issue_write", access: "write" }] } } };
    expect(issues(legacy)).toEqual([]);
  });

  it("carries a presented tool's two hints and item arguments and nothing else, and an optional action policy on the thread workspace result", () => {
    const tool = { name: "linear__save_issue", upstreamName: "save_issue", description: "Save.", inputSchema: {}, access: "write", scopes: [{ alias: "charterarc", schemaHash: "a".repeat(64) }] };
    expect(PresentedToolSchema.safeParse({ ...tool, hints: { readOnlyHint: false, destructiveHint: true }, itemArguments: ["id"] }).success).toBe(true);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArguments: [] }).success).toBe(true);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArguments: ["task_id", "tasks[].task"] }).success).toBe(true);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArguments: ["has space"] }).success).toBe(false);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArguments: ["tasks[]"] }).success).toBe(false);
    expect(PresentedToolSchema.safeParse({ ...tool, itemArgument: "id" }).success).toBe(false);
    expect(PresentedToolSchema.safeParse({ ...tool, hints: { idempotentHint: true } }).success).toBe(false);
    expect(SlackThreadWorkspaceResultSchema.safeParse({
      outcome: "WORKSPACE", workspaceId: "11111111-1111-4111-8111-111111111111", status: "READY", operationId: null, created: false,
      orchestratorInstructions: "Delegate.", actionPolicy: { rules: [{ tool: "*", outcome: "ask" }] },
    }).success).toBe(true);
  });
});
