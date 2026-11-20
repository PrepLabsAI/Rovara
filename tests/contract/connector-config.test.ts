import { describe, expect, it } from "vitest";
import { ProjectDefinitionSchema, githubConnectorOf } from "../../packages/contracts/src/index.js";

const repository = (name: string) => ({
  name, url: `https://github.com/example/${name}.git`, path: `repo/${name}`, defaultBranch: "main", credentialRef: "github-app",
});
const tools = [{ name: "list_issues", access: "read" }];
const project = (integrations?: unknown) => ({
  name: "payments", revision: 1, repositories: [repository("api"), repository("web")],
  setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  ...(integrations === undefined ? {} : { integrations }),
});
const issues = (value: unknown) => {
  const parsed = ProjectDefinitionSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("connector configuration", () => {
  it("turns attribution off only when a connector says so", () => {
    const off = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools, attribution: false }] }));
    expect(githubConnectorOf(off)?.attribution).toBe(false);
    const on = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools }] }));
    expect(githubConnectorOf(on)?.attribution).toBe(true);
  });

  it("limits a github connector to its listed repositories", () => {
    const definition = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "gh", type: "github", scopes: ["web"], tools }] }));
    expect(githubConnectorOf(definition)?.repositories.map((entry) => entry.name)).toEqual(["web"]);
    expect(githubConnectorOf(definition)?.name).toBe("gh");
  });

  it("reads the legacy githubMcp policy as a github connector over all repositories", () => {
    const definition = ProjectDefinitionSchema.parse(project({ githubMcp: { tools } }));
    expect(githubConnectorOf(definition)).toEqual({ name: "github", repositories: definition.repositories, policy: { tools }, attribution: true });
    expect(githubConnectorOf(ProjectDefinitionSchema.parse(project()))).toBeUndefined();
  });

  it("refuses both configuration forms in one definition", () => {
    expect(issues(project({ githubMcp: { tools }, connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools }] })))
      .toContain("use either integrations.githubMcp or integrations.connectors, not both");
  });

  it("refuses scopes that name an unregistered repository", () => {
    expect(issues(project({ connectors: [{ name: "github", type: "github", scopes: ["mobile"], tools }] })))
      .toContain("connector github scopes unregistered repository mobile");
  });

  it("refuses duplicate names, a second github connector and types that are not supported yet", () => {
    const github = { name: "github", type: "github", scopes: "all-repositories", tools };
    expect(issues(project({ connectors: [github, github] }))).toContain("connector names must be unique");
    expect(issues(project({ connectors: [github, { ...github, name: "github-two" }] }))).toContain("at most one github connector is supported");
    expect(issues(project({ connectors: [{ name: "linear", type: "linear", credentialRef: "x", scopes: [], tools }] })).length).toBeGreaterThan(0);
    expect(issues(project({ connectors: [{ ...github, name: "GitHub" }] })).length).toBeGreaterThan(0);
  });
});

describe("jira connectors", () => {
  const CLOUD = "1437bb04-4c88-4efd-9d38-658e8febfeba";
  const jira = (overrides: Record<string, unknown> = {}) => ({
    name: "jira", type: "jira", credentialRef: "jira-agentx-sa",
    scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "PAY" }],
    tools: [{ name: "searchJiraIssuesUsingJql", access: "read" }, { name: "createJiraIssue", access: "write" }],
    ...overrides,
  });

  it.each([
    ["projectKey on some scopes only", { scopes: [{ alias: "pay", cloudId: CLOUD, projectKey: "PAY" }, { alias: "site", cloudId: CLOUD }] },
      "connector jira: set projectKey on every scope or on none"],
    ["a tool AgentX cannot hold to a project", { tools: [{ name: "executeWrite", access: "write" }] },
      "connector jira: tool executeWrite cannot be limited to a Jira project; approve only getJiraIssue, searchJiraIssuesUsingJql, createJiraIssue, editJiraIssue, transitionJiraIssue, addOrEditJiraIssueComment, or remove projectKey from every scope"],
    ["a write approved as read", { tools: [{ name: "createJiraIssue", access: "read" }] },
      "connector jira: tool createJiraIssue must be approved with access: write"],
    ["the same site and project twice", { scopes: [{ alias: "a", cloudId: CLOUD, projectKey: "PAY" }, { alias: "b", cloudId: CLOUD, projectKey: "PAY" }] },
      "connector jira: scopes a and b address the same Jira site and project"],
    ["a duplicate alias", { scopes: [{ alias: "a", cloudId: CLOUD, projectKey: "PAY" }, { alias: "a", cloudId: CLOUD, projectKey: "OPS" }] },
      "connector jira: scope aliases must be unique"],
  ])("refuses %s", (_label, overrides, message) => {
    expect(issues(project({ connectors: [jira(overrides)] }))).toContain(message);
  });



});
