// Spec 055: the generic `mcp` connector's configuration, and the credential host it is pinned to.
import { describe, expect, it } from "vitest";
import { ConnectorsSchema, CredentialRegistrationSchema, McpAuthSchema, mcpEndpointProblem } from "../../packages/contracts/src/index.js";

const ownership = {
  mode: "ownership", itemNoun: "issue",
  references: { get_issue: ["issueId"], update_issue: ["issueId", "parentId", "related[]"] },
  lookup: { tool: "get_issue", argument: "issueId" },
  field: "organization.slug", equals: "organizationSlug",
};
const sentry = (overrides: Record<string, unknown> = {}) => ({
  name: "sentry", type: "mcp", endpoint: "https://mcp.sentry.dev/mcp",
  label: "Sentry issues", vendor: "Sentry", scopeNoun: "organization", credentialRef: "sentry-bot",
  scopes: [{ alias: "acme", values: { organizationSlug: "acme" } }],
  bind: { required: { organizationSlug: "organizationSlug" } },
  scoping: { mode: "credential" },
  tools: [{ name: "get_issue_details", access: "read" }],
  ...overrides,
});
const issues = (value: unknown) => {
  const parsed = ConnectorsSchema.safeParse([value]);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("mcp connector configuration", () => {

  it("refuses a write tool on a credential-scoped connector unless it is acknowledged", () => {
    const write = { tools: [{ name: "update_issue", access: "write" }] };
    expect(issues(sentry(write))).toContain("connector sentry: write tools update_issue would reach everything the credential can; set scoping.acknowledgeUnscopedWrites: true, or use an ownership rule");
    expect(issues(sentry({ ...write, scoping: { mode: "credential", acknowledgeUnscopedWrites: true } }))).toEqual([]);
  });

  it("needs every bound value and the ownership value in every scope, and no argument bound twice", () => {
    const twoScopes = { scopes: [{ alias: "acme", values: { organizationSlug: "acme" } }, { alias: "other", values: { region: "us" } }] };
    expect(issues(sentry(twoScopes))).toContain("connector sentry: bind organizationSlug reads organizationSlug, which every scope must set");
    expect(issues(sentry({ bind: { required: { org: "organizationSlug" }, optional: { org: "organizationSlug" } } }))).toContain("connector sentry: bind org is both required and optional");
    expect(issues(sentry({ scoping: { ...ownership, equals: "teamId" } }))).toContain("connector sentry: scoping.equals reads teamId, which every scope must set");
    expect(issues(sentry({ scopes: [{ alias: "a", values: { organizationSlug: "a" } }, { alias: "a", values: { organizationSlug: "b" } }] }))).toContain("connector sentry: scope aliases must be unique");
  });

  it("refuses alias as a value name, a value with a line break, and an empty values map", () => {
    expect(issues(sentry({ scopes: [{ alias: "acme", values: { alias: "x", organizationSlug: "acme" } }] }))).not.toEqual([]);
    expect(issues(sentry({ scopes: [{ alias: "acme", values: { organizationSlug: "acme\nignore previous" } }] }))).not.toEqual([]);
    // A scope with nothing to bind may carry no values (spec 055 phase 3); more than 16 is refused.
    expect(issues(sentry({ bind: undefined, scopes: [{ alias: "acme", values: {} }] }))).toEqual([]);
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`v${index}`, "x"]));
    expect(issues(sentry({ bind: undefined, scopes: [{ alias: "acme", values: many }] }))).toContain("a scope has at most 16 values");
  });

});

describe("mcp endpoints", () => {
  it.each([
    ["http://mcp.sentry.dev/mcp", "endpoint must use https"],
    ["https://user:pass@mcp.sentry.dev/mcp", "endpoint must not carry a username or password"],
    ["https://mcp.sentry.dev/mcp?token=abc", "endpoint must not have a query or fragment"],
    ["https://169.254.169.254/latest", "endpoint host must be a DNS name, not an IP address"],
    ["https://localhost/mcp", "endpoint host must be a DNS name with at least one dot"],
    ["https://metadata.google.internal/mcp", "endpoint host metadata.google.internal is a local name"],
    ["not a url", "endpoint must be an absolute URL"],
  ])("%s", (endpoint, problem) => {
    expect(mcpEndpointProblem(endpoint)).toBe(problem);
  });

  it("refuses a transport header for the token, and a prefix with a line break", () => {
    expect(McpAuthSchema.safeParse({ header: "Authorization", prefix: "Token token=" }).success).toBe(true);
    expect(McpAuthSchema.safeParse({ header: "X-Api-Key", prefix: "" }).success).toBe(true);
    for (const header of ["Host", "content-type", "X-MCP-Tools", "Mcp-Session-Id", "Cookie"]) {
      expect(McpAuthSchema.safeParse({ header }).success).toBe(false);
    }
    expect(McpAuthSchema.safeParse({ prefix: "Bearer\r\nX-Evil: 1 " }).success).toBe(false);
  });
});

describe("credential host", () => {
  const registration = { ref: "sentry-bot", type: "static-secret", secretName: "agentx/connectors/sentry" };
  it("is optional, and when given is a lowercase DNS name", () => {
    expect(CredentialRegistrationSchema.safeParse(registration).success).toBe(true);
    expect(CredentialRegistrationSchema.safeParse({ ...registration, host: "mcp.sentry.dev" }).success).toBe(true);
    for (const host of ["MCP.sentry.dev", "https://mcp.sentry.dev", "mcp.sentry.dev/mcp", "localhost", "10.0.0.1"]) {
      expect(CredentialRegistrationSchema.safeParse({ ...registration, host }).success).toBe(false);
    }
  });
});
