// the Grafana connector. It reads alerts, rules, dashboards and one Prometheus data source through an org connection's service account token at
// the base URL a person typed, in the broker. That address is one Rovara does not control, so every connection to it goes through the endpoint guard: the host is
// checked again, the connection is pinned to the addresses that check returned, and a redirect is refused. The Grafana API is faked; no test reaches a network.
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorNotConnected, discoverTools, executeTool, type ConnectorDefinition, type Ledger } from "@agentx/gateway";
import { ProjectDefinitionSchema, type OrgId } from "../../packages/contracts/src/index.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors, type ConnectorTypeContext, type ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";
import { grafanaConnectionCheck, grafanaConnectorType } from "../../packages/broker/src/connectors/native/grafana-connector-type.js";
import { GRAFANA_TOOL_NAMES } from "../../packages/broker/src/connectors/native/grafana.js";
import { PROJECT_CONNECTOR_TOOLS } from "../support/project-connector-tools.js";
import { mcpEndpointGuard, type McpEndpointGuard, type RequestFunction } from "../../packages/broker/src/connections/pinned-endpoint.js";
import { orgCredentialRegistry } from "../../packages/broker/src/connections/registry.js";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { InMemoryConnectionSecrets, memoryStore } from "../support/connection-fakes.js";
import { routeFetch } from "../support/developer-fakes.js";
import { fakeGrafana } from "../support/fake-vendor-apis.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ENV = "staging";
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "a".repeat(64);
const TOKEN = "glsa_GRAFANATESTTOKEN0123456789";
const BASE = "https://grafana.examplehost.com";
const TOOLS = ["list_firing_alerts", "get_alert_rule", "get_dashboard", "query_prometheus"] as const;
const PAY = { alias: "pay", folderUids: ["fold-pay"], datasourceUid: "prom1" };

// A check or a tool may reach Grafana only through the fetch it is given (pinned by the endpoint guard); the global one fails the test (review A-M3).
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used; a Grafana check and tool use only the fetch they are given"); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const db = memoryStore();
  const secrets = new InMemoryConnectionSecrets(ENV);
  const deps = { store: db, env: ENV, secrets, now: () => Date.now() };
  return { db, deps, registry: orgCredentialRegistry(deps, ORG_A) };
}

async function connected(baseUrl = BASE) {
  const s = setup();
  const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined });
  await store.put({ orgId: ORG_A, connection: { connectionId: CON, type: "grafana", label: "Grafana", access: "read", baseUrl }, secret: { serviceAccountToken: TOKEN }, by: ALICE });
  return { ...s, store };
}

const connectorConfig = (over: Record<string, unknown> = {}) => ({
  name: "dash", type: "grafana", credentialRef: CON, scopes: [PAY], tools: TOOLS.map((name) => ({ name, access: "read" })), ...over,
});
const project = (connectors: unknown[]) => ProjectDefinitionSchema.parse({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

type GrafanaScope = { alias: string; folderUids?: string[]; datasourceUid?: string };
const ledger: Ledger = { claim: async () => true, get: async () => undefined, finish: async () => undefined };
const textOf = (result: { content?: Array<{ text?: string | undefined }> | undefined }) => result.content?.map((entry) => entry.text ?? "").join("") ?? "";

/** An endpoint guard whose pinned fetch is the fake Grafana: it records the endpoints it was asked to check. */
function fakeGuard(api: ReturnType<typeof fakeGrafana>) {
  const checked: string[] = [];
  const guard: McpEndpointGuard = async (endpoint) => { checked.push(endpoint.href); return routeFetch(api.handler); };
  return { guard, checked };
}

async function resolved(options: { baseUrl?: string; scope?: GrafanaScope; config?: Record<string, unknown>; api?: ReturnType<typeof fakeGrafana>; context?: Partial<ConnectorTypeContext> } = {}) {
  const s = await connected(options.baseUrl);
  const host = new URL(options.baseUrl ?? BASE).hostname;
  const api = options.api ?? fakeGrafana({ token: TOKEN, host });
  const { guard, checked } = fakeGuard(api);
  const scope = options.scope ?? PAY;
  const [connector] = resolveConnectors(project([connectorConfig({ scopes: [scope], ...options.config })]), { credentialRegistry: s.registry, endpointGuard: guard, ...options.context }, { grafana: grafanaConnectorType });
  const definition = await connector!.definition();
  if ("notConnected" in definition) throw new Error(`not connected: ${definition.notConnected}`);
  return { ...s, api, guard, checked, scope, connector: connector as ResolvedConnector<GrafanaScope>, definition: definition as ConnectorDefinition<GrafanaScope> };
}

const context = (scope: GrafanaScope, tools: readonly string[] = TOOLS) => ({
  workspaceId: "ws", ownerKey: "owner", scopeAlias: scope.alias, scope, settingsRevision: 1,
  policy: { tools: tools.map((name) => ({ name, access: "read" as const })) },
});

async function run(tool: string, args: Record<string, unknown>, options: Parameters<typeof resolved>[0] = {}) {
  const r = await resolved(options);
  const discovered = (await discoverTools(r.definition, context(r.scope), { connect: r.connector.connect! })).tools.find((entry) => entry.name === tool)!;
  const result = await executeTool(
    { requestId: "11111111-1111-4111-8111-111111111111", scope: r.scope.alias, tool, schemaHash: discovered.schemaHash, arguments: args },
    r.definition, context(r.scope), { connect: r.connector.connect!, ledger },
  );
  return { ...r, result };
}

/** A node `request` stand-in that records the options it was given and answers with `status`. */
function recordingRequest(status = 200, headers: Record<string, string> = {}, body = "{}") {
  const calls: Array<{ url: URL; options: { lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void; agent: unknown } }> = [];
  const request = vi.fn((url: URL, options: never, callback?: (response: unknown) => void) => {
    calls.push({ url, options });
    return {
      on: () => undefined,
      destroy: () => undefined,
      end: () => { const response = Object.assign(new PassThrough(), { statusCode: status, headers, statusMessage: "" }); response.end(body); callback?.(response); },
    } as never;
  });
  return { request: request as unknown as RequestFunction, calls };
}

describe("the Grafana connector type", () => {
  it("is built in, named grafana, and resolves its label, vendor, scope noun, scopes and ledger", async () => {
    expect(BUILT_IN_CONNECTOR_TYPES["grafana"]).toBe(grafanaConnectorType);
    const s = await connected();
    const [connector] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: s.registry });
    expect(connector).toMatchObject({
      name: "dash", type: "grafana", label: "Grafana", vendor: "Grafana", scopeNoun: "scope", attribution: false,
      ledger: { prefix: "CONNECTOR#dash#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: CON, accepts: ["static-secret"] },
      scopes: [{ alias: "pay", scope: PAY }],
    });
  });

  it("lists exactly the four tools a project may approve, and declares no item argument and no label argument", async () => {
    expect(PROJECT_CONNECTOR_TOOLS.grafana).toEqual([...TOOLS]);
    expect(GRAFANA_TOOL_NAMES).toEqual([...TOOLS]);
    const { definition } = await resolved();
    expect(definition.itemArguments).toEqual([]);
    expect(definition).not.toHaveProperty("labelArgument");
  });

  it("serves the base URL as its API base, keeping a path, and pins the token to that host", async () => {
    const plain = await resolved();
    expect(plain.definition.endpoint.href).toBe("https://grafana.examplehost.com/");
    expect((await plain.registry.registration(CON))?.host).toBe("grafana.examplehost.com");
    const nested = await resolved({ baseUrl: "https://tools.examplehost.com/grafana" });
    expect(nested.definition.endpoint.href).toBe("https://tools.examplehost.com/grafana/");
    await expect(nested.registry.provider(CON, { pin: { host: "grafana.examplehost.com", required: true } }).issue({}, "read")).rejects.toThrow();
    expect((await nested.definition.credentials.issue(PAY, "read")).token).toBe(TOKEN);
  });

  it("is not connected when the record is pinned to another host, has none, or the connection is not Grafana's", async () => {
    const s = await connected();
    const of = (registry: unknown) => resolveConnectors(project([connectorConfig()]), { credentialRegistry: registry as never })[0]!;
    expect(await of(s.registry).configured()).toBe(true);
    const elsewhere = { ...s.registry, registration: async (ref: string) => ({ ...(await s.registry.registration(ref))!, host: "grafana.other.dev" }) };
    expect(await of(elsewhere).definition()).toEqual({ notConnected: `credential ${CON} is pinned to grafana.other.dev, not grafana.examplehost.com, so AgentX does not send it there` });
    const unpinned = { ...s.registry, registration: async (ref: string) => { const { host: _host, ...rest } = (await s.registry.registration(ref))!; return rest; } }; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    expect(await of(unpinned).definition()).toEqual({ notConnected: `credential ${CON} is not pinned to a host; register it again with --host grafana.examplehost.com` });
    const other = setup();
    await new OrgConnectionStore({ ...other.deps, checkEndpoint: async () => undefined }).put({ orgId: ORG_A, connection: { connectionId: CON, type: "vercel", label: "Vercel", access: "read" }, secret: { token: "vercel-token-0123456789" }, by: ALICE });
    expect(await of(other.registry).definition()).toEqual({ notConnected: `connection ${CON} is not a Grafana connection` });
  });

  it("treats a malformed stored entry as unusable and never throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stored = { ...project([connectorConfig()]), integrations: { connectors: [connectorConfig({ scopes: [{ folderUids: ["a"] }] })] } } as never;
    expect(resolveConnectors(stored, { credentialRegistry: setup().registry }, { grafana: grafanaConnectorType })).toEqual([]);
    const reasons = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event?: string; reason?: string }).filter((line) => line.event === "connector.unusable");
    expect(reasons[0]?.reason).toBe("invalid grafana connector configuration: scopes");
  });
});

describe("the address a person typed (Review Focus 6)", () => {
  it("checks the base URL again before every connection, through the endpoint guard", async () => {
    const r = await resolved();
    await discoverTools(r.definition, context(r.scope), { connect: r.connector.connect! });
    await discoverTools(r.definition, context(r.scope), { connect: r.connector.connect! });
    expect(r.checked).toEqual(["https://grafana.examplehost.com/", "https://grafana.examplehost.com/"]);
  });

  it("refuses a base URL whose host resolves to 10.0.0.5 at connect time and sends no request", async () => {
    const { request, calls } = recordingRequest();
    const guard = mcpEndpointGuard({ resolveHost: async () => ["10.0.0.5"], request });
    const r = await resolved({ context: { endpointGuard: guard } });
    await expect(discoverTools(r.definition, context(r.scope), { connect: r.connector.connect! })).rejects.toBeInstanceOf(ConnectorNotConnected);
    const discovered = { schemaHash: "x" };
    const executed = await executeTool(
      { requestId: "11111111-1111-4111-8111-111111111111", scope: "pay", tool: "list_firing_alerts", schemaHash: discovered.schemaHash, arguments: {} },
      r.definition, context(r.scope), { connect: r.connector.connect!, ledger },
    );
    expect(executed).toMatchObject({ status: "FAILED", reason: "not_connected" });
    expect(executed.text).toContain("not a public address");
    expect(executed.text).not.toContain("10.0.0.5");
    expect(request).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("answers a failed address lookup as not connected, making no request", async () => {
    const { request, calls } = recordingRequest();
    const guard = mcpEndpointGuard({ resolveHost: async () => { throw new Error("SERVFAIL grafana.examplehost.com"); }, request });
    const r = await resolved({ context: { endpointGuard: guard } });
    await expect(discoverTools(r.definition, context(r.scope), { connect: r.connector.connect! })).rejects.toBeInstanceOf(ConnectorNotConnected);
    expect(calls).toEqual([]);
  });

  it("connects only to the addresses the check returned, on a connection of its own", async () => {
    const { request, calls } = recordingRequest(200, {}, "[]");
    const guard = mcpEndpointGuard({ resolveHost: async () => ["52.1.2.3"], request });
    const r = await resolved({ context: { endpointGuard: guard }, scope: { alias: "all" } });
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    await connection.call("list_firing_alerts", { scopeAlias: "all", folderUids: "", datasourceUid: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.href).toBe("https://grafana.examplehost.com/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false");
    const answer = await new Promise<unknown[]>((resolve) => calls[0]!.options.lookup("grafana.examplehost.com", { all: true }, (...args) => resolve(args)));
    expect(answer).toEqual([null, [{ address: "52.1.2.3", family: 4 }]]);
    expect(calls[0]!.options.agent).toBe(false);
  });

  it("does not follow a redirect to another host", async () => {
    const { request, calls } = recordingRequest(302, { location: "http://169.254.169.254/latest/meta-data/" });
    const guard = mcpEndpointGuard({ resolveHost: async () => ["52.1.2.3"], request });
    const r = await resolved({ context: { endpointGuard: guard }, scope: { alias: "all" } });
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    await expect(connection.call("get_dashboard", { scopeAlias: "all", folderUids: "", datasourceUid: "", uid: "dash-pay" })).rejects.toMatchObject({ message: "the vendor answered with a redirect, which is refused", reason: "vendor_error" });
    expect(calls.map((call) => call.url.hostname)).toEqual(["grafana.examplehost.com"]);
  });

  it("is not connected where the deployment has no endpoint guard, and uses the guard's fetch rather than the test fetch when it has one", async () => {
    const withoutGuard = await resolved({ context: { endpointGuard: undefined as never } });
    await expect(discoverTools(withoutGuard.definition, context(withoutGuard.scope), { connect: withoutGuard.connector.connect! })).rejects.toThrow("address checks are not configured in this deployment");
    await expect(discoverTools(withoutGuard.definition, context(withoutGuard.scope), { connect: withoutGuard.connector.connect! })).rejects.toBeInstanceOf(ConnectorNotConnected);
    const nativeSpy = vi.fn(async () => new Response("[]"));
    const r = await resolved({ context: { nativeFetch: nativeSpy } });
    await discoverTools(r.definition, context(r.scope), { connect: r.connector.connect! });
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    await connection.call("list_firing_alerts", { scopeAlias: "pay", folderUids: "fold-pay", datasourceUid: "prom1" });
    expect(nativeSpy).not.toHaveBeenCalled();
    expect(r.api.requests.length).toBeGreaterThan(0);
  });
});

describe("what the model is offered", () => {
  it("marks every tool read with the read-only hints, and shows no scope value", async () => {
    const { definition, connector, scope } = await resolved();
    const { tools, skipped } = await discoverTools(definition, context(scope), { connect: connector.connect! });
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of tools) {
      expect(tool.access, tool.name).toBe("read");
      expect(tool.hints, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false });
      const names = Object.keys(tool.inputSchema["properties"] as object);
      for (const hidden of ["scopeAlias", "folderUids", "datasourceUid"]) expect(names, tool.name).not.toContain(hidden);
    }
    const props = (name: string) => (tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props("get_alert_rule")["uid"]).toMatchObject({ type: "string", pattern: "^[A-Za-z0-9_-]{1,40}$" });
    expect(props("query_prometheus")["expr"]).toMatchObject({ type: "string", maxLength: 500 });
    expect(props("query_prometheus")["fromMinutesAgo"]).toMatchObject({ minimum: 5, maximum: 1440 });
    expect(props("query_prometheus")["stepSeconds"]).toMatchObject({ minimum: 15, maximum: 3600 });
    expect(Object.keys(props("list_firing_alerts"))).toEqual([]);
  });

  it("leaves query_prometheus out of the catalog for a scope with no datasourceUid, and says why", async () => {
    const r = await resolved({ scope: { alias: "pay", folderUids: ["fold-pay"] } });
    const { tools, skipped } = await discoverTools(r.definition, context(r.scope), { connect: r.connector.connect! });
    expect(tools.map((tool) => tool.name)).toEqual(["list_firing_alerts", "get_alert_rule", "get_dashboard"]);
    expect(skipped).toEqual([{ tool: "query_prometheus", reason: "this scope has no data source (datasourceUid)" }]);
    // And a call to it is refused as an unknown tool, whatever the model sends.
    const result = await executeTool(
      { requestId: "11111111-1111-4111-8111-111111111111", scope: "pay", tool: "query_prometheus", schemaHash: "x", arguments: { expr: "up", fromMinutesAgo: 5 } },
      r.definition, context(r.scope), { connect: r.connector.connect!, ledger },
    );
    expect(result.status).toBe("FAILED");
    expect(r.api.requests).toEqual([]);
  });

});

describe("running the tools", () => {
  it("lists only the firing alerts of the scope's folders", async () => {
    const { result, api } = await run("list_firing_alerts", {});
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("Payments error rate");
    expect(result.text).not.toContain("Web latency");
    expect(api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/api/v1/provisioning/alert-rules", "/api/alertmanager/grafana/api/v2/alerts"]);
    expect(new URL(api.requests[1]!.url).searchParams.get("active")).toBe("true");
    expect(api.requests.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("lists every firing alert for a scope with no folders, without asking for the rules", async () => {
    const { result, api } = await run("list_firing_alerts", {}, { scope: { alias: "pay" } });
    expect(result.text).toContain("Payments error rate");
    expect(result.text).toContain("Web latency");
    expect(api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/api/alertmanager/grafana/api/v2/alerts"]);
  });

  it("reads an alert rule of the scope's folders, and refuses one of another folder", async () => {
    const own = await run("get_alert_rule", { uid: "rule-pay" });
    expect(own.result.status).toBe("SUCCEEDED");
    expect(own.result.text).toContain("Payments error rate");
    expect(own.result.text).toContain("rate(payments_errors_total[5m])");
    expect(new URL(own.api.requests[0]!.url).pathname).toBe("/api/v1/provisioning/alert-rules/rule-pay");
    const other = await run("get_alert_rule", { uid: "rule-web" });
    expect(other.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that alert rule is not in pay" });
    expect(other.result.text).not.toContain("Web is slow");
    const missing = await run("get_alert_rule", { uid: "nope" });
    expect(missing.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Grafana has no such alert rule or dashboard" });
  });

  it("reads a dashboard of the scope's folders, and refuses one of another folder", async () => {
    const own = await run("get_dashboard", { uid: "dash-pay" });
    expect(own.result.status).toBe("SUCCEEDED");
    expect(own.result.text).toContain("Payments overview");
    expect(own.result.text).toContain("Error rate");
    const other = await run("get_dashboard", { uid: "dash-web" });
    expect(other.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that dashboard is not in pay" });
    const open = await run("get_dashboard", { uid: "dash-web" }, { scope: { alias: "all" } });
    expect(open.result.status).toBe("SUCCEEDED");
  });

  it("queries the scope's data source only, whatever the model writes, and summarises the series", async () => {
    const { result, api } = await run("query_prometheus", { expr: "rate(payments_errors_total[5m])", fromMinutesAgo: 60, stepSeconds: 30 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("job=payments");
    expect(result.text).toContain("3 points");
    expect(result.text).toContain("2.5");
    const request = api.requests[0]!;
    expect(request).toMatchObject({ method: "POST", authorization: `Bearer ${TOKEN}` });
    expect(new URL(request.url).pathname).toBe("/api/ds/query");
    const body = request.body as { queries: Array<Record<string, unknown>>; from: string; to: string };
    expect(body.queries).toEqual([expect.objectContaining({ refId: "A", datasource: { uid: "prom1" }, expr: "rate(payments_errors_total[5m])", range: true, instant: false, intervalMs: 30_000 })]);
    expect(Number(body.to) - Number(body.from)).toBe(3_600_000);
  });

  it("refuses a query Grafana rejected without repeating Grafana's words, and will not take a data source from the model", async () => {
    const failed = await run("query_prometheus", { expr: "rate(", fromMinutesAgo: 5 }, { api: fakeGrafana({ token: TOKEN, queryError: true }) });
    expect(failed.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Grafana could not run that query" });
    expect(JSON.stringify(failed.result)).not.toContain("bad expression");
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    const routing = { scopeAlias: "pay", folderUids: "fold-pay", datasourceUid: "prom1" };
    expect(textOf(await connection.call("query_prometheus", { ...routing, expr: "up", fromMinutesAgo: 5, datasource: { uid: "other" } }))).toBe("query_prometheus: datasource is not allowed");
    expect(textOf(await connection.call("query_prometheus", { ...routing, expr: "up", fromMinutesAgo: 4 }))).toBe("query_prometheus: fromMinutesAgo is not allowed");
    expect(textOf(await connection.call("query_prometheus", { ...routing, expr: "up", fromMinutesAgo: 5, stepSeconds: 14 }))).toBe("query_prometheus: stepSeconds is not allowed");
    expect(textOf(await connection.call("query_prometheus", { ...routing, expr: "x".repeat(501), fromMinutesAgo: 5 }))).toBe("query_prometheus: expr is not allowed");
    expect(textOf(await connection.call("get_dashboard", { ...routing, uid: "../admin" }))).toBe("get_dashboard: uid is not allowed");
    expect(r.api.requests).toEqual([]);
    // A scope with no data source refuses even if the tool were somehow reached.
    await expect(connection.call("query_prometheus", { scopeAlias: "pay", folderUids: "", datasourceUid: "", expr: "up", fromMinutesAgo: 5 })).rejects.toMatchObject({ message: "that scope has no data source" });
  });

  it("answers a refused token, a missing item and an outage in fixed words, carrying nothing the vendor sent", async () => {
    const wrong = await run("get_dashboard", { uid: "dash-pay" }, { api: fakeGrafana({ token: "glsa_SOMETHINGELSE" }) });
    expect(wrong.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Grafana refused the token. Check that the service account token is valid and its role can read alerts, dashboards and data sources." });
    const down = await run("get_dashboard", { uid: "dash-pay" }, { api: fakeGrafana({ token: TOKEN, status: 503 }) });
    expect(down.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Grafana answered HTTP 503" });
    const limited = await run("get_dashboard", { uid: "dash-pay" }, { api: fakeGrafana({ token: TOKEN, status: 429 }) });
    expect(limited.result.text).toBe("Grafana is limiting requests; try again later");
    expect(JSON.stringify([wrong.result, down.result, limited.result])).not.toMatch(/Unauthorized|fake outage/u);
  });

  it("goes only to the base URL's host, with the token", async () => {
    const { api } = await run("list_firing_alerts", {});
    expect(api.requests.every((request) => new URL(request.url).hostname === "grafana.examplehost.com" && request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const nested = await run("get_dashboard", { uid: "dash-pay" }, { baseUrl: "https://tools.examplehost.com/grafana", api: fakeGrafana({ token: TOKEN, host: "tools.examplehost.com", basePath: "/grafana" }) });
    expect(nested.result.status).toBe("SUCCEEDED");
    expect(new URL(nested.api.requests[0]!.url).pathname).toBe("/grafana/api/dashboards/uid/dash-pay");
  });
});

describe("the Grafana connection check", () => {
  async function checkWith(api: ReturnType<typeof fakeGrafana>) {
    const s = await connected();
    const { guard, checked } = fakeGuard(api);
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, endpointGuard: guard, checks: { grafana: grafanaConnectionCheck } });
    return { store, api, checked };
  }

  it("checks the health and then the token, over the guard's pinned fetch", async () => {
    const { store, api, checked } = await checkWith(fakeGrafana({ token: TOKEN }));
    expect(await store.check(ORG_A, CON)).toEqual({ ok: true });
    expect(checked).toEqual(["https://grafana.examplehost.com/"]);
    expect(api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/api/health", "/api/user"]);
    expect(api.requests[1]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect((await store.get(ORG_A, CON))?.lastCheck).toMatchObject({ ok: true });
  });

  it("says Grafana refused the token, and answers an outage as retryable without recording a check", async () => {
    const bad = await checkWith(fakeGrafana({ token: "glsa_SOMETHINGELSE" }));
    const result = await bad.store.check(ORG_A, CON);
    expect(result).toEqual({ ok: false, message: "Grafana refused the token. Check that the service account token is valid and not expired." });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const down = await checkWith(fakeGrafana({ token: TOKEN, status: 503 }));
    const refusal = await down.store.check(ORG_A, CON).then(() => undefined, (error: { code?: string }) => error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await down.store.get(ORG_A, CON))?.lastCheck).toBeUndefined();
  });

  it("answers an unhealthy Grafana as retryable even when the token would be accepted, recording nothing", async () => {
    const { store } = await checkWith(fakeGrafana({ token: TOKEN, healthStatus: 500 }));
    const refusal = await store.check(ORG_A, CON).then(() => undefined, (error: { code?: string }) => error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await store.get(ORG_A, CON))?.lastCheck).toBeUndefined();
  });

  it("refuses an address the guard refuses, running no check", async () => {
    const s = await connected();
    const { request, calls } = recordingRequest();
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, endpointGuard: mcpEndpointGuard({ resolveHost: async () => ["10.0.0.5"], request }), checks: { grafana: grafanaConnectionCheck } });
    const result = await store.check(ORG_A, CON);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a public address");
    expect(calls).toEqual([]);
  });
});
