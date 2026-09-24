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
  it("resolves a github connector over all repositories", () => {
    const definition = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "github", type: "github", scopes: "all-repositories", tools }] }));
    const github = githubConnectorOf(definition);
    expect(github?.name).toBe("github");
    expect(github?.repositories.map((entry) => entry.name)).toEqual(["api", "web"]);
    expect(github?.policy).toEqual({ tools });
  });

  it("limits a github connector to its listed repositories", () => {
    const definition = ProjectDefinitionSchema.parse(project({ connectors: [{ name: "gh", type: "github", scopes: ["web"], tools }] }));
    expect(githubConnectorOf(definition)?.repositories.map((entry) => entry.name)).toEqual(["web"]);
    expect(githubConnectorOf(definition)?.name).toBe("gh");
  });

  it("reads the legacy githubMcp policy as a github connector over all repositories", () => {
    const definition = ProjectDefinitionSchema.parse(project({ githubMcp: { tools } }));
    expect(githubConnectorOf(definition)).toEqual({ name: "github", repositories: definition.repositories, policy: { tools } });
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
