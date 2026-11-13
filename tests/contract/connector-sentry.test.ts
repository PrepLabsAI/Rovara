// the Sentry connector. It reads one Sentry project through an org connection's auth token, in the broker (a native connector, no MCP
// server): issues, one issue, its latest event and the project's releases. Every request goes to `https://<us|de>.sentry.io/api/0/` and nowhere else, and a
// tool can only reach the project its scope names. The Sentry API is faked; no test reaches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverTools, executeTool, type ConnectorDefinition, type Ledger } from "@agentx/gateway";
import { ProjectDefinitionSchema, type OrgId } from "../../packages/contracts/src/index.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors, type ResolvedConnector } from "../../packages/core/src/aws/connector-types.js";
import { sentryConnectionCheck, sentryConnectorType } from "../../packages/core/src/connectors/native/sentry-connector-type.js";
import { SENTRY_TOOLS } from "../../packages/core/src/connectors/native/sentry.js";
import { PROJECT_CONNECTOR_TOOLS } from "../support/project-connector-tools.js";
import { orgCredentialRegistry } from "../../packages/core/src/connections/registry.js";
import { OrgConnectionStore } from "../../packages/core/src/connections/store.js";
import { InMemoryConnectionSecrets, memoryStore } from "../support/connection-fakes.js";
import { routeFetch } from "../support/developer-fakes.js";
import { fakeSentry } from "../support/fake-vendor-apis.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ENV = "staging";
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "a".repeat(64);
const TOKEN = "sntrys_SENTRYTESTTOKEN0123456789";
const TOOLS = ["list_issues", "get_issue", "get_latest_event", "list_releases"] as const;

// A check or a tool may reach Sentry only through the fetch it is given (held to Sentry's host, no redirect); the global one fails the test (review A-M3).
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used; a Sentry check and tool use only the fetch they are given"); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const db = memoryStore();
  const secrets = new InMemoryConnectionSecrets(ENV);
  const deps = { store: db, env: ENV, secrets, now: () => Date.now() };
  return { db, deps, registry: orgCredentialRegistry(deps, ORG_A) };
}

async function connected(region: "us" | "de" = "us", orgSlug = "acme") {
  const s = setup();
  const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined });
  await store.put({ orgId: ORG_A, connection: { connectionId: CON, type: "sentry", label: "Sentry", access: "read", region, orgSlug }, secret: { authToken: TOKEN }, by: ALICE });
  return { ...s, store };
}

const connectorConfig = (over: Record<string, unknown> = {}) => ({
  name: "errors", type: "sentry", credentialRef: CON, scopes: [{ alias: "web", projectSlug: "web-app" }], tools: TOOLS.map((name) => ({ name, access: "read" })), ...over,
});
const project = (connectors: unknown[]) => ProjectDefinitionSchema.parse({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

async function resolved(options: { region?: "us" | "de"; orgSlug?: string; config?: Record<string, unknown>; api?: ReturnType<typeof fakeSentry> } = {}) {
  const s = await connected(options.region, options.orgSlug);
  const api = options.api ?? fakeSentry({ token: TOKEN, ...(options.orgSlug === undefined ? {} : { org: options.orgSlug }) });
  const fetch = routeFetch(api.handler);
  const [connector] = resolveConnectors(project([connectorConfig(options.config)]), { credentialRegistry: s.registry, nativeFetch: fetch }, { sentry: sentryConnectorType });
  const definition = await connector!.definition();
  if ("notConnected" in definition) throw new Error(`not connected: ${definition.notConnected}`);
  return { ...s, api, fetch, connector: connector as ResolvedConnector<{ alias: string; projectSlug: string }>, definition: definition as ConnectorDefinition<{ alias: string; projectSlug: string }> };
}

const WEB = { alias: "web", projectSlug: "web-app" };
const context = (policyTools = TOOLS) => ({
  workspaceId: "ws", ownerKey: "owner", scopeAlias: "web", scope: WEB, settingsRevision: 1,
  policy: { tools: policyTools.map((name) => ({ name, access: "read" as const })) },
});
const ledger: Ledger = { claim: async () => true, get: async () => undefined, finish: async () => undefined };

describe("the Sentry connector type", () => {
  it("is built in, named sentry, and resolves its label, vendor, scope noun, scopes and ledger", async () => {
    expect(BUILT_IN_CONNECTOR_TYPES["sentry"]).toBe(sentryConnectorType);
    const s = await connected();
    const [connector] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: s.registry });
    expect(connector).toMatchObject({
      name: "errors", type: "sentry", label: "Sentry issues", vendor: "Sentry", scopeNoun: "project", attribution: false,
      ledger: { prefix: "CONNECTOR#errors#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: CON, accepts: ["static-secret"] },
      scopes: [{ alias: "web", scope: { alias: "web", projectSlug: "web-app" } }],
    });
    expect(connector!.approvals.map((tool) => tool.name)).toEqual([...TOOLS]);
  });

  it("lists exactly the four tools a project may approve, and every native type declares no item argument and no label argument", async () => {
    expect(PROJECT_CONNECTOR_TOOLS.sentry).toEqual([...TOOLS]);
    const { definition } = await resolved();
    expect(definition.itemArguments).toEqual([]);
    expect(definition).not.toHaveProperty("labelArgument");
    expect(definition.guards).toEqual([]);
  });

  it("is not connected without a registry, with a connection that is missing, of another type, removed or pinned to another host", async () => {
    const s = await connected();
    const of = (registry: unknown) => resolveConnectors(project([connectorConfig()]), { credentialRegistry: registry as never })[0]!;
    expect(await resolveConnectors(project([connectorConfig()]), {})[0]!.definition()).toEqual({ notConnected: "connector credentials are not configured in this deployment" });
    expect(await of(setup().registry).definition()).toEqual({ notConnected: `credential ${CON} is not registered` });
    // A connection of another type under the same kind of id.
    const other = setup();
    await new OrgConnectionStore({ ...other.deps, checkEndpoint: async () => undefined }).put({ orgId: ORG_A, connection: { connectionId: CON, type: "vercel", label: "Vercel", access: "read" }, secret: { token: "vercel-token-0123456789" }, by: ALICE });
    expect(await of(other.registry).definition()).toEqual({ notConnected: `connection ${CON} is not a Sentry connection` });
    expect(await of(s.registry).configured()).toBe(true);
    // A credential record pinned to a host other than the one the connection's region names is refused, so no token is issued for it.
    const pinnedElsewhere = { ...s.registry, registration: async (ref: string) => ({ ...(await s.registry.registration(ref))!, host: "evil.example" }) };
    expect(await of(pinnedElsewhere).definition()).toEqual({ notConnected: `credential ${CON} is pinned to evil.example, not us.sentry.io, so AgentX does not send it there` });
    expect(await of(pinnedElsewhere).configured()).toBe(false);
    // A credential record with no host at all is refused too: the pin is required, not a hint.
    const unpinned = { ...s.registry, registration: async (ref: string) => { const { host: _host, ...rest } = (await s.registry.registration(ref))!; return rest; } }; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    expect(await of(unpinned).definition()).toEqual({ notConnected: `credential ${CON} is not pinned to a host; register it again with --host us.sentry.io` });
    // And only a static-secret token serves a Sentry connector.
    const oauth = { ...s.registry, registration: async (ref: string) => ({ ...(await s.registry.registration(ref))!, type: "oauth-client-credentials" as const }) };
    expect(await of(oauth).definition()).toEqual({ notConnected: `credential ${CON} is oauth-client-credentials; a Sentry connector needs a static-secret token` });
  });

  it("serves the region's own API base, and issues the token only for that region's host", async () => {
    for (const [region, host] of [["us", "us.sentry.io"], ["de", "de.sentry.io"]] as const) {
      const { definition, registry } = await resolved({ region });
      expect(definition.endpoint.href).toBe(`https://${host}/api/0/`);
      expect((await registry.registration(CON))?.host).toBe(host);
      expect((await definition.credentials.issue(WEB, "read")).token).toBe(TOKEN);
      expect((await definition.credentials.issue(WEB, "read")).bindings).toEqual({ organization: "acme" });
      await expect(registry.provider(CON, { pin: { host: region === "us" ? "de.sentry.io" : "us.sentry.io", required: true } }).issue({}, "read")).rejects.toThrow();
    }
  });

  it("refuses a token for the other Sentry region's host: the connector pins it to its own, and checks again when the token is issued (review A-M2)", async () => {
    const r = await resolved({ region: "us" });
    // Moving the connection to Germany needs a new token, and the record then names the German host; the definition already built still pins the US one.
    await r.store.put({ orgId: ORG_A, connection: { connectionId: CON, type: "sentry", label: "Sentry", access: "read", region: "de", orgSlug: "acme" }, secret: { authToken: TOKEN }, by: ALICE });
    await expect(r.definition.credentials.issue(WEB, "read")).rejects.toThrow(`credential ${CON} is pinned to de.sentry.io, not us.sentry.io, so AgentX does not send it there`);
    // A connector resolved afresh follows the connection to its new region instead.
    const [fresh] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: r.registry }, { sentry: sentryConnectorType });
    const definition = await fresh!.definition();
    if ("notConnected" in definition) throw new Error("expected a definition");
    expect(definition.endpoint.hostname).toBe("de.sentry.io");
    expect((await definition.credentials.issue(WEB, "read")).token).toBe(TOKEN);
  });

  it("treats a malformed stored entry as unusable and never throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stored = { ...project([connectorConfig()]), integrations: { connectors: [connectorConfig({ scopes: [{ alias: "web" }] })] } } as never;
    expect(resolveConnectors(stored, { credentialRegistry: setup().registry }, { sentry: sentryConnectorType })).toEqual([]);
    const reasons = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event?: string; reason?: string }).filter((line) => line.event === "connector.unusable");
    expect(reasons[0]?.reason).toBe("invalid sentry connector configuration: scopes");
  });
});

describe("what the model is offered", () => {
  it("marks every tool read with the read-only hints, and shows neither the organization nor the project", async () => {
    const { definition, connector } = await resolved();
    const { tools, skipped } = await discoverTools(definition, context(), { connect: connector.connect! });
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of tools) {
      expect(tool.access, tool.name).toBe("read");
      expect(tool.hints, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      const names = Object.keys(tool.inputSchema["properties"] as object);
      expect(names).not.toEqual(expect.arrayContaining(["organization"]));
      expect(names).not.toEqual(expect.arrayContaining(["projectSlug"]));
      expect(names).not.toEqual(expect.arrayContaining(["scopeAlias"]));
    }
    const byName = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(byName("get_issue").required).toEqual(["issueId"]);
    expect(byName("get_issue").properties["issueId"]).toMatchObject({ type: "string", pattern: "^\\d{1,20}$" });
    expect(byName("list_issues").properties["limit"]).toMatchObject({ type: "integer", minimum: 1, maximum: 25 });
    expect(byName("list_issues").properties["statsPeriod"]).toMatchObject({ enum: ["24h", "14d"] });
    expect(byName("list_issues").properties["query"]).toMatchObject({ type: "string", maxLength: 200 });
    expect(byName("list_releases").properties["limit"]).toMatchObject({ minimum: 1, maximum: 10 });
  });

});

describe("running the tools", () => {
  const run = async (tool: string, args: Record<string, unknown>, options: Parameters<typeof resolved>[0] = {}) => {
    const r = await resolved(options);
    const discovered = (await discoverTools(r.definition, context(), { connect: r.connector.connect! })).tools.find((entry) => entry.name === tool)!;
    const result = await executeTool(
      { requestId: "11111111-1111-4111-8111-111111111111", scope: "web", tool, schemaHash: discovered.schemaHash, arguments: args },
      r.definition, context(), { connect: r.connector.connect!, ledger },
    );
    return { ...r, result };
  };

  it("lists the project's issues with the token, to the region's host, and nothing about another project", async () => {
    const { result, api } = await run("list_issues", { statsPeriod: "24h", limit: 5, query: "is:unresolved" });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("WEB-1");
    expect(result.text).toContain("TypeError: x is undefined");
    expect(result.text).toContain("WEB-2");
    expect(result.text).not.toContain("API-1");
    expect(result.text).not.toContain("Database connection lost");
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}` });
    const url = new URL(api.requests[0]!.url);
    expect(url.origin + url.pathname).toBe("https://us.sentry.io/api/0/projects/acme/web-app/issues/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ query: "is:unresolved", statsPeriod: "24h", limit: "5" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("goes to the German host for a de connection, and to no other host", async () => {
    const { result, api } = await run("list_releases", { limit: 1 }, { region: "de" });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("web@1.2.3");
    expect(result.text).not.toContain("web@1.2.2");
    expect(api.requests.map((request) => new URL(request.url).hostname)).toEqual(["de.sentry.io"]);
    expect(new URL(api.requests[0]!.url).pathname).toBe("/api/0/projects/acme/web-app/releases/");
  });

  it("shows the model the formatted text of the issues, permalink included, and no structured copy (review I-2)", async () => {
    const { result } = await run("list_issues", { limit: 5 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("https://sentry.io/organizations/acme/issues/101/");
    expect(result.text).toContain("WEB-1 [error, unresolved] TypeError: x is undefined");
    expect(result.text.startsWith("[{")).toBe(false);
    expect(result.text.length).toBeLessThanOrEqual(32_768);
  });

  it("reads an issue of its own project", async () => {
    const { result, api } = await run("get_issue", { issueId: "101" });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("WEB-1");
    expect(result.text).toContain("unresolved");
    expect(new URL(api.requests[0]!.url).pathname).toBe("/api/0/organizations/acme/issues/101/");
  });

  it("reads the latest event of an issue of its own project after confirming the project, and leaves out the user's details", async () => {
    const { result, api } = await run("get_latest_event", { issueId: "101" });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("evt101");
    expect(result.text).toContain("app/checkout.js");
    expect(result.text).toContain("environment");
    expect(result.text).not.toContain("private@example.com");
    expect(result.text).not.toContain("203.0.113.9");
    expect(api.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/0/organizations/acme/issues/101/", "/api/0/organizations/acme/issues/101/events/latest/",
    ]);
  });

  it("lists only issues that are in the scope's project, whatever the vendor's endpoint answered (review M-5)", async () => {
    const { result } = await run("list_issues", {}, { api: fakeSentry({ token: TOKEN, leakOtherProjects: true }) });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("WEB-1");
    expect(result.text).not.toContain("API-1");
    expect(result.text).not.toContain("Database connection lost");
    expect(result.text.startsWith("2 issues in web")).toBe(true);
  });

  it("shows the tags of an event that describe the software, not the person or the request (review M-5)", async () => {
    const { result } = await run("get_latest_event", { issueId: "101" });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("environment=prod");
    expect(result.text).toContain("release=web@1.2.3");
    expect(result.text).toContain("browser.name=Chrome");
    for (const hidden of ["id:4242", "private@example.com", "shop.example", "token=abc", "203.0.113.9", "203.0.113.10", "web-7f9c", "cus_123456", "user=", "user.email", "url=", "ip=", "client_ip", "server_name", "customer_id"]) {
      expect(result.text, hidden).not.toContain(hidden);
    }
  });

  it("refuses an issue of another project with the plan's words, and fetches no event for it", async () => {
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    const routing = { organization: "acme", projectSlug: "web-app", scopeAlias: "web" };
    for (const tool of ["get_issue", "get_latest_event"]) {
      await expect(connection.call(tool, { ...routing, issueId: "201" }), tool).rejects.toMatchObject({ name: "ToolRefusal", message: "that issue is not in web", reason: "policy_denied" });
    }
    expect(r.api.requests.map((request) => new URL(request.url).pathname)).not.toContain("/api/0/organizations/acme/issues/201/events/latest/");
    expect(JSON.stringify(await connection.call("get_issue", { ...routing, issueId: "201" }).catch((error: Error) => error.message))).not.toContain("Database connection lost");
  });

  it("answers a missing issue, a refused token and an outage in fixed words that carry nothing the vendor sent", async () => {
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    const routing = { organization: "acme", projectSlug: "web-app", scopeAlias: "web" };
    await expect(connection.call("get_issue", { ...routing, issueId: "999" })).rejects.toMatchObject({ message: "Sentry has no such project or issue", reason: "vendor_error" });
    const bad = await r.connector.connect!({ endpoint: r.definition.endpoint, token: "sntrys_WRONG", tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    await expect(bad.call("list_issues", routing)).rejects.toMatchObject({ message: "Sentry refused the token. Check that it has org:read, project:read and event:read.", reason: "vendor_error" });
    const down = await resolved({ api: fakeSentry({ token: TOKEN, status: 503 }) });
    await expect((await down.connector.connect!({ endpoint: down.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) })).call("list_releases", routing)).rejects.toMatchObject({ message: "Sentry answered HTTP 503" });
    const limited = await resolved({ api: fakeSentry({ token: TOKEN, status: 429 }) });
    await expect((await limited.connector.connect!({ endpoint: limited.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) })).call("list_releases", routing)).rejects.toMatchObject({ message: "Sentry is limiting requests; try again later" });
  });

  it("answers a 403 as a refused token, like a 401, and a Sentry that answers 403 to the check the same way", async () => {
    const r = await resolved({ api: fakeSentry({ token: TOKEN, status: 403 }) });
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    await expect(connection.call("list_issues", { organization: "acme", projectSlug: "web-app", scopeAlias: "web" })).rejects.toMatchObject({ message: "Sentry refused the token. Check that it has org:read, project:read and event:read." });
    const s = await connected();
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, fetch: routeFetch(fakeSentry({ token: TOKEN, status: 403 }).handler), checks: { sentry: sentryConnectionCheck } });
    expect(await store.check(ORG_A, CON)).toEqual({ ok: false, message: "Sentry refused the token. Check that it has org:read, project:read and event:read." });
  });

  it("opens no connection to an endpoint that is not https, and puts the organization and project in a path as one segment each", async () => {
    const r = await resolved();
    await expect(r.connector.connect!({ endpoint: new URL("http://us.sentry.io/api/0/"), token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) })).rejects.toThrow("over https only");
    const paths: string[] = [];
    const fetcher = async (target: string | URL) => { paths.push(String(target)); return { status: 200, json: [] }; };
    const tool = SENTRY_TOOLS.find((entry) => entry.name === "list_issues")!;
    await tool.run({}, { scope: { organization: "a/b", projectSlug: "c?d", alias: "web" }, credential: { token: TOKEN, bindings: {} }, fetch: fetcher });
    expect(paths[0]!.startsWith("projects/a%2Fb/c%3Fd/issues/?")).toBe(true);
  });

  it("returns the words we wrote to the model when the engine runs a refused call, and keeps the vendor's own words out of it", async () => {
    const other = await run("get_issue", { issueId: "201" });
    expect(other.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that issue is not in web" });
    const missing = await run("get_issue", { issueId: "999" });
    expect(missing.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Sentry has no such project or issue" });
    const outage = await run("list_releases", {}, { api: fakeSentry({ token: TOKEN, status: 503 }) });
    expect(outage.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Sentry answered HTTP 503" });
    // The fake's own error body ("fake outage") is never repeated, nor is the token.
    expect(JSON.stringify(outage.result)).not.toContain("fake outage");
    const refused = await run("list_issues", {}, { api: fakeSentry({ token: "sntrys_SOMETHINGELSE" }) });
    expect(refused.result).toMatchObject({ status: "FAILED", text: "Sentry refused the token. Check that it has org:read, project:read and event:read." });
    expect(JSON.stringify([other.result, missing.result, outage.result, refused.result])).not.toMatch(/Invalid token|sntrys_/u);
  });

  it("refuses an issue id that is not digits, and an argument the model may not set, without any request", async () => {
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    const routing = { organization: "acme", projectSlug: "web-app", scopeAlias: "web" };
    for (const issueId of ["../../organizations/other/", "101/events", "", "1".repeat(21), "10a"]) {
      expect((await connection.call("get_issue", { ...routing, issueId })).isError, issueId).toBe(true);
    }
    expect(textOf(await connection.call("list_issues", { ...routing, url: "https://evil.example/" }))).toBe("list_issues: url is not allowed");
    expect(textOf(await connection.call("list_issues", { ...routing, limit: 26 }))).toBe("list_issues: limit is not allowed");
    expect(textOf(await connection.call("list_issues", { ...routing, statsPeriod: "90d" }))).toBe("list_issues: statsPeriod is not allowed");
    expect(textOf(await connection.call("list_issues", { ...routing, query: "x".repeat(201) }))).toBe("list_issues: query is not allowed");
    expect(r.api.requests).toEqual([]);
  });

  it("keeps the organization and project to the server's: a model cannot name them through the engine", async () => {
    const r = await resolved();
    const discovered = (await discoverTools(r.definition, context(), { connect: r.connector.connect! })).tools.find((entry) => entry.name === "list_issues")!;
    await expect(executeTool(
      { requestId: "22222222-2222-4222-8222-222222222222", scope: "web", tool: "list_issues", schemaHash: discovered.schemaHash, arguments: { projectSlug: "api-app" } },
      r.definition, context(), { connect: r.connector.connect!, ledger },
    )).rejects.toThrow("routing arguments are server controlled");
    expect(r.api.requests).toEqual([]);
  });
});

const textOf = (result: { content?: Array<{ text?: string | undefined }> | undefined }) => result.content?.map((entry) => entry.text ?? "").join("") ?? "";

describe("the Sentry connection check", () => {
  async function checkWith(api: ReturnType<typeof fakeSentry>, region: "us" | "de" = "us") {
    const s = await connected(region);
    const fetch = routeFetch(api.handler);
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, fetch, checks: { sentry: sentryConnectionCheck } });
    return { store, s, api };
  }

  it("asks for the organization with the saved token, at the region's host, and says ok", async () => {
    const { store, api } = await checkWith(fakeSentry({ token: TOKEN }));
    expect(await store.check(ORG_A, CON)).toEqual({ ok: true });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}` });
    expect(new URL(api.requests[0]!.url).origin + new URL(api.requests[0]!.url).pathname).toBe("https://us.sentry.io/api/0/organizations/acme/");
    expect((await store.get(ORG_A, CON))?.lastCheck).toMatchObject({ ok: true });
  });

  it("uses the German host for a de connection", async () => {
    const { store, api } = await checkWith(fakeSentry({ token: TOKEN }), "de");
    expect(await store.check(ORG_A, CON)).toEqual({ ok: true });
    expect(new URL(api.requests[0]!.url).hostname).toBe("de.sentry.io");
  });

  it("says Sentry refused the token, with the scopes to check, when the fake refuses it", async () => {
    const { store, api } = await checkWith(fakeSentry({ token: "sntrys_SOMETHINGELSE" }));
    const result = await store.check(ORG_A, CON);
    expect(result).toEqual({ ok: false, message: "Sentry refused the token. Check that it has org:read, project:read and event:read." });
    expect(api.requests).toHaveLength(1);
    expect((await store.get(ORG_A, CON))?.lastCheck).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("says when the organization does not exist, and answers an outage as retryable without recording a check", async () => {
    const missing = await checkWith(fakeSentry({ token: TOKEN, org: "someone-else" }));
    expect(await missing.store.check(ORG_A, CON)).toEqual({ ok: false, message: "Sentry has no organization called acme" });
    const outage = await checkWith(fakeSentry({ token: TOKEN, status: 503 }));
    const refusal = await outage.store.check(ORG_A, CON).then(() => undefined, (error: { code?: string; message: string }) => error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await outage.store.get(ORG_A, CON))?.lastCheck).toBeUndefined();
  });

  it("is held to the Sentry host: the check cannot be pointed anywhere else", async () => {
    const s = await connected();
    const seen: string[] = [];
    const recording = (async (input: string | URL | Request) => { seen.push(String(input instanceof Request ? input.url : input)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, fetch: recording, checks: { sentry: sentryConnectionCheck } });
    await store.check(ORG_A, CON);
    expect(seen.map((url) => new URL(url).hostname)).toEqual(["us.sentry.io"]);
  });
});
