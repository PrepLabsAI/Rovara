import { describe, expect, it, vi } from "vitest";
import { ConnectorConfigSchema } from "../../packages/contracts/src/connectors.js";
import { BUILT_IN_CONNECTOR_TYPES, githubConnectorType, resolveConnectors } from "../../packages/broker/src/aws/connector-types.js";
import { CredentialRegistry } from "../../packages/broker/src/aws/credentials.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TRACKER_ENDPOINT, trackerConnectorType } from "../support/tracker-connector.js";

const repositories = [
  { name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" },
  { name: "docs", url: "https://github.com/example/docs.git", path: "repo/docs", defaultBranch: "main", credentialRef: "github-app" },
];
const project = (integrations: unknown) => ({ name: "payments", revision: 3, repositories, setup: [], readiness: [], orchestratorInstructions: "x", integrations }) as never;
const githubMcp = { credentials: vi.fn(), connect: vi.fn() };

describe("connector resolution", () => {
  it("resolves the legacy githubMcp policy as the github connector over every repository", () => {
    const [github] = resolveConnectors(project({ githubMcp: { tools: [{ name: "list_issues", access: "read" }] } }), { githubMcp });
    expect(github).toMatchObject({
      name: "github", type: "github", label: "GitHub issues", vendor: "GitHub", scopeNoun: "repository", attribution: true,
      ledger: { prefix: "GITHUB_MCP#", entityType: "GITHUB_MCP_INVOCATION" },
    });
    expect(github!.scopes.map((scope) => scope.alias)).toEqual(["demo", "docs"]);
  });

  it("resolves a github connector's named scopes and attribution setting", async () => {
    const [github] = resolveConnectors(project({ connectors: [{ name: "gh", type: "github", scopes: ["docs"], attribution: false, tools: [{ name: "list_issues", access: "read" }] }] }), { githubMcp });
    expect(github).toMatchObject({ name: "gh", attribution: false });
    expect(github!.scopes.map((scope) => scope.alias)).toEqual(["docs"]);
    expect(await github!.configured()).toBe(true);
  });

  it("reports github as not configured when the deployment has no GitHub MCP", async () => {
    const [github] = resolveConnectors(project({ githubMcp: { tools: [{ name: "list_issues", access: "read" }] } }), {});
    expect(await github!.configured()).toBe(false);
    expect(await github!.definition()).toEqual({ notConnected: "GitHub MCP is not configured in this deployment" });
  });

  it("resolves an injected type in definition order after github and ignores, with a log line, a type it does not know", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const connectors = resolveConnectors(project({ connectors: [
        { name: "github", type: "github", scopes: "all-repositories", tools: [{ name: "list_issues", access: "read" }] },
        { name: "tracker", type: "tracker", credentialRef: "tracker-key", scopes: [{ alias: "payments", siteId: "site-42" }], tools: [{ name: "list_items", access: "read" }] },
        { name: "future", type: "future-vendor", tools: [{ name: "x", access: "read" }] },
      ] }), { githubMcp }, { github: githubConnectorType, tracker: trackerConnectorType });
      expect(connectors.map((connector) => connector.name)).toEqual(["github", "tracker"]);
      expect(connectors[1]).toMatchObject({ ledger: { prefix: "CONNECTOR#tracker#", entityType: "CONNECTOR_INVOCATION" } });
      const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("connector.type_unknown"));
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ component: "broker", event: "connector.type_unknown", project: "payments", revision: 3, connector: "future", type: "future-vendor" }]);
    } finally { log.mockRestore(); }
  });

  it("skips, with a log line, a connector its type cannot serve", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const connectors = resolveConnectors(project({ connectors: [
        { name: "tracker", type: "tracker", scopes: [{ alias: "payments", siteId: "site-42" }], tools: [{ name: "list_items", access: "read" }] },
      ] }), {}, { tracker: trackerConnectorType });
      expect(connectors).toEqual([]);
      const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("connector.unusable"));
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ component: "broker", event: "connector.unusable", project: "payments", revision: 3, connector: "tracker", type: "tracker", reason: "credentialRef is missing" }]);
    } finally { log.mockRestore(); }
  });

  it("skips, with a log line and without throwing, a malformed stored github connector", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const connectors = resolveConnectors(project({ connectors: [
        { name: "gh", type: "github", scopes: 5, tools: [{ name: "list_issues", access: "read" }] },
      ] }), { githubMcp });
      expect(connectors).toEqual([]);
      const lines = log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("connector.unusable"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ component: "broker", event: "connector.unusable", project: "payments", revision: 3, connector: "gh", type: "github", reason: "invalid github connector configuration: scopes" });
    } finally { log.mockRestore(); }
  });

  it("reports a type-owned connector as configured only when its credential is registered", async () => {
    const db = new FakeDynamoDb();
    const credentialRegistry = new CredentialRegistry({
      documentClient: db as never, tableName: "state",
      secrets: { read: vi.fn() }, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" },
    });
    const tracker = () => resolveConnectors(project({ connectors: [
      { name: "tracker", type: "tracker", credentialRef: "tracker-key", scopes: [{ alias: "payments", siteId: "site-42" }], tools: [{ name: "list_items", access: "read" }] },
    ] }), { credentialRegistry }, { tracker: trackerConnectorType })[0]!;
    expect(await tracker().configured()).toBe(false);
    expect(await tracker().definition()).toEqual({ notConnected: "credential tracker-key is not registered" });

    db.set({ pk: "CREDENTIALS", sk: "REF#tracker-key", entityType: "CREDENTIAL", ref: "tracker-key", type: "static-secret", secretName: "agentx/connectors/tracker-key", registeredBy: "admin", registeredAt: "2026-09-01T00:00:00.000Z" });
    expect(await credentialRegistry.has("tracker-key")).toBe(true);
    expect(await tracker().configured()).toBe(true);
    const definition = await tracker().definition();
    expect(definition).toMatchObject({ endpoint: new URL(TRACKER_ENDPOINT), guards: [], attributionKeys: ["body"] });
    if ("notConnected" in definition) throw new Error("expected a definition");
    expect(definition.binder.bind({ alias: "payments", siteId: "site-42" }, { token: "t", bindings: {} })).toEqual({ siteId: "site-42" });

    db.set({ pk: "CREDENTIALS", sk: "REF#broken", entityType: "CREDENTIAL", ref: "other", type: "static-secret" });
    expect(await credentialRegistry.has("broken")).toBe(false);
  });

  it("resolves a jira connector with its presentation strings, ledger and credential reference", async () => {
    const db = new FakeDynamoDb();
    const credentialRegistry = new CredentialRegistry({
      documentClient: db as never, tableName: "state",
      secrets: { read: vi.fn(async () => JSON.stringify({ apiKey: "jira-token-value" })) }, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" },
    });
    const resolve = (scopes: unknown) => resolveConnectors(project({ connectors: [
      { name: "jira", type: "jira", credentialRef: "jira-sa", scopes, tools: [{ name: "getJiraIssue", access: "read" }] },
    ] }), { credentialRegistry })[0]!;
    const projectScoped = resolve([{ alias: "kan", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" }]);
    expect(projectScoped).toMatchObject({
      name: "jira", type: "jira", label: "Jira issues", vendor: "Jira", scopeNoun: "Jira project", attribution: true,
      credential: { ref: "jira-sa", accepts: ["static-secret"] }, ledger: { prefix: "CONNECTOR#jira#", entityType: "CONNECTOR_INVOCATION" },
    });
    expect(resolve([{ alias: "site", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba" }]).scopeNoun).toBe("Jira site");
    expect(await projectScoped.configured()).toBe(false);
    expect(await projectScoped.definition()).toEqual({ notConnected: "credential jira-sa is not registered" });

    db.set({ pk: "CREDENTIALS", sk: "REF#jira-sa", entityType: "CREDENTIAL", ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa", registeredBy: "admin", registeredAt: "2026-09-01T00:00:00.000Z" });
    expect(await projectScoped.configured()).toBe(true);
    const definition = await projectScoped.definition();
    if ("notConnected" in definition) throw new Error("expected a definition");
    expect(definition.endpoint.href).toBe("https://mcp.atlassian.com/v2/mcp");
    expect(await definition.credentials.issue(projectScoped.scopes[0]!.scope, "read")).toEqual({ token: "jira-token-value", bindings: {} });

    // Re-registered later with another type: not connected with a reason, never a throw.
    db.set({ pk: "CREDENTIALS", sk: "REF#jira-sa", entityType: "CREDENTIAL", ref: "jira-sa", type: "oauth-client-credentials", secretName: "agentx/connectors/jira-sa", registeredBy: "admin", registeredAt: "2026-09-02T00:00:00.000Z" });
    expect(await projectScoped.configured()).toBe(false);
    expect(await projectScoped.definition()).toEqual({ notConnected: "credential jira-sa is oauth-client-credentials; a Jira connector needs a static-secret API token" });
  });

  it("binds projectKey only for a project-scoped jira connector, and reports no registry as not connected", async () => {
    const db = new FakeDynamoDb();
    db.set({ pk: "CREDENTIALS", sk: "REF#jira-sa", entityType: "CREDENTIAL", ref: "jira-sa", type: "static-secret", secretName: "agentx/connectors/jira-sa", registeredBy: "admin", registeredAt: "2026-09-01T00:00:00.000Z" });
    const credentialRegistry = new CredentialRegistry({
      documentClient: db as never, tableName: "state",
      secrets: { read: vi.fn(async () => JSON.stringify({ apiKey: "jira-token-value" })) }, githubApp: { ref: "github-app", secretName: "agentx/connectors/github-app" },
    });
    const resolve = (scopes: unknown, context: Parameters<typeof resolveConnectors>[1]) => resolveConnectors(project({ connectors: [
      { name: "jira", type: "jira", credentialRef: "jira-sa", scopes, tools: [{ name: "getJiraIssue", access: "read" }] },
    ] }), context)[0]!;
    const keyed = await resolve([{ alias: "kan", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" }], { credentialRegistry }).definition();
    const site = await resolve([{ alias: "site", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba" }], { credentialRegistry }).definition();
    if ("notConnected" in keyed || "notConnected" in site) throw new Error("expected definitions");
    expect(keyed.binder.optionalProperties).toEqual(["projectKey"]);
    expect(site.binder.optionalProperties).toBeUndefined();

    const unregistered = resolve([{ alias: "kan", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" }], {});
    expect(await unregistered.configured()).toBe(false);
    expect(await unregistered.definition()).toEqual({ notConnected: "connector credentials are not configured in this deployment" });
  });

  it("skips, with a log line, a stored jira connector that fails its schema", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(resolveConnectors(project({ connectors: [{ name: "jira", type: "jira", scopes: [], tools: [] }] }), {})).toEqual([]);
      const line = log.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes("connector.unusable"));
      expect(JSON.parse(line!)).toMatchObject({ event: "connector.unusable", connector: "jira", type: "jira", reason: "invalid jira connector configuration: credentialRef, scopes, tools" });
    } finally { log.mockRestore(); }
  });

  it("skips a stored project-scoped jira connector that approves a tool its guard cannot hold to the project", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(resolveConnectors(project({ connectors: [{ name: "jira", type: "jira", credentialRef: "jira-sa", scopes: [{ alias: "kan", cloudId: "1437bb04-4c88-4efd-9d38-658e8febfeba", projectKey: "KAN" }], tools: [{ name: "executeWrite", access: "write" }] }] }), {})).toEqual([]);
      const line = log.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes("connector.unusable"));
      expect(JSON.parse(line!)).toMatchObject({ event: "connector.unusable", connector: "jira", type: "jira", reason: "invalid jira connector configuration: entry; connector jira: tool executeWrite cannot be limited to a Jira project; approve only getJiraIssue, searchJiraIssuesUsingJql, createJiraIssue, editJiraIssue, transitionJiraIssue, addOrEditJiraIssueComment, or remove projectKey from every scope" });
    } finally { log.mockRestore(); }
  });

  it("caps the logged reason for a stored jira connector that breaks several rules at 300 characters", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const cloudId = "1437bb04-4c88-4efd-9d38-658e8febfeba";
      expect(resolveConnectors(project({ connectors: [{
        name: "jira", type: "jira", credentialRef: "jira-sa",
        scopes: [{ alias: "a", cloudId, projectKey: "KAN" }, { alias: "b", cloudId }, { alias: "c", cloudId }],
        tools: [{ name: "executeWrite", access: "write" }, { name: "executeRead", access: "read" }],
      }] }), {})).toEqual([]);
      const line = log.mock.calls.map(([entry]) => String(entry)).find((entry) => entry.includes("connector.unusable"));
      const reason = (JSON.parse(line!) as { reason: string }).reason;
      expect(reason.startsWith("invalid jira connector configuration: entry; connector jira: scopes b and c address the same Jira site and project; connector jira: set projectKey on every scope or on none")).toBe(true);
      expect(reason).toHaveLength(300);
    } finally { log.mockRestore(); }
  });

  it("has a built-in entry for every type ConnectorConfigSchema accepts, so none is silently dropped", () => {
    const schemaTypes = ConnectorConfigSchema.options.map((option) => option.shape.type.value as string);
    expect(schemaTypes).toEqual(["github", "jira"]);
    for (const type of schemaTypes) {
      expect(Object.hasOwn(BUILT_IN_CONNECTOR_TYPES, type)).toBe(true);
    }
  });

  it("resolves github with the context's connect only when this deployment's GitHub MCP has none of its own", () => {
    const contextConnect = vi.fn();
    const definition = project({ githubMcp: { tools: [{ name: "list_issues", access: "read" }] } });
    const [withoutOwnConnect] = resolveConnectors(definition, { githubMcp: { credentials: vi.fn() }, connect: contextConnect as never });
    expect(withoutOwnConnect!.connect).toBe(contextConnect);
  });

  it("keeps the deployment's own GitHub MCP connect ahead of the context's connect", () => {
    const contextConnect = vi.fn();
    const deploymentConnect = vi.fn();
    const definition = project({ githubMcp: { tools: [{ name: "list_issues", access: "read" }] } });
    const [withOwnConnect] = resolveConnectors(definition, { githubMcp: { credentials: vi.fn(), connect: deploymentConnect }, connect: contextConnect as never });
    expect(withOwnConnect!.connect).toBe(deploymentConnect);
  });

  it("passes the context's connect through to a type-owned connector, like the tracker test type", () => {
    const contextConnect = vi.fn();
    const definition = project({ connectors: [
      { name: "tracker", type: "tracker", credentialRef: "tracker-key", scopes: [{ alias: "payments", siteId: "site-42" }], tools: [{ name: "list_items", access: "read" }] },
    ] });
    const [tracker] = resolveConnectors(definition, { connect: contextConnect as never }, { tracker: trackerConnectorType });
    expect(tracker!.connect).toBe(contextConnect);
  });
});
