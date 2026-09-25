import { describe, expect, it } from "vitest";
import {
  ActionPolicySchema,
  IN_HOUSE_TOOL_NAMES,
  PresentedToolSchema,
  ProjectDefinitionSchema,
  SlackThreadWorkspaceResultSchema,
  StoredProjectDefinitionSchema,
  toolPatternMatches,
} from "../../packages/contracts/src/index.js";
import { ORCHESTRATION_TOOL_NAMES } from "../../packages/orchestrator/src/orchestration-tools.js";

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
  it("names the same in-house tools as the orchestrator", () => {
    expect([...IN_HOUSE_TOOL_NAMES]).toEqual([...ORCHESTRATION_TOOL_NAMES]);
  });

  it("matches tool patterns whole, with * as any run of characters", () => {
    expect(toolPatternMatches("save_issue", "save_issue")).toBe(true);
    expect(toolPatternMatches("save_issue", "save_issues")).toBe(false);
    expect(toolPatternMatches("delete_*", "delete_comment")).toBe(true);
    expect(toolPatternMatches("*__save_*", "linear__save_issue")).toBe(true);
    expect(toolPatternMatches("*", "anything")).toBe(true);
    expect(toolPatternMatches("save-issue", "save_issue")).toBe(false);
  });

  it("requires exactly one of outcome and treatAs, and refuses unknown fields and bad patterns", () => {
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "delete_*", connector: "linear", outcome: "deny" }] }).success).toBe(true);
    for (const treatAs of ["read", "create", "change", "destructive"]) {
      expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", connector: "linear", treatAs }] }).success).toBe(true);
    }
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", connector: "linear", treatAs: "write" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", outcome: "ask", treatAs: "change" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", outcome: "maybe" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save issue", outcome: "ask" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [{ tool: "save_issue", outcome: "ask", when: "always" }] }).success).toBe(false);
    expect(ActionPolicySchema.safeParse({ rules: [] }).success).toBe(false);
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

  it("keeps serving a stored revision with an action policy", () => {
    expect(StoredProjectDefinitionSchema.safeParse(project({ rules: [{ tool: "issue_write", connector: "github", outcome: "ask" }] })).success).toBe(true);
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
