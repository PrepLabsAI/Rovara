// the Datadog connector. It reads monitors, metrics and logs through an org connection's two keys (an API key and an application key) at
// `https://api.<site>/`, in the broker. Every query is narrowed to the scope's tags, and a monitor is shown only when it carries all of them. The Datadog API is
// faked; no test reaches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverTools, executeTool, type ConnectorDefinition, type Ledger } from "@agentx/gateway";
import type { DATADOG_SITES} from "../../packages/contracts/src/index.js";
import { DatadogScopeSchema, ProjectDefinitionSchema, type OrgId } from "../../packages/contracts/src/index.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors, type ResolvedConnector } from "../../packages/core/src/aws/connector-types.js";
import { datadogConnectionCheck, datadogConnectorType } from "../../packages/core/src/connectors/native/datadog-connector-type.js";
import { DATADOG_TOOL_NAMES, isContainedQuery, scopedMetricQuery } from "../../packages/core/src/connectors/native/datadog.js";
import { PROJECT_CONNECTOR_TOOLS } from "../support/project-connector-tools.js";
import { orgCredentialRegistry } from "../../packages/core/src/connections/registry.js";
import { OrgConnectionStore } from "../../packages/core/src/connections/store.js";
import { InMemoryConnectionSecrets, memoryStore } from "../support/connection-fakes.js";
import { routeFetch } from "../support/developer-fakes.js";
import { fakeDatadog, type FakeDatadogLog } from "../support/fake-vendor-apis.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ENV = "staging";
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "a".repeat(64);
const API_KEY = ["dd", "api", "key", "x".repeat(16)].join("-");
const APP_KEY = ["dd", "app", "key", "x".repeat(16)].join("-");
const TOOLS = ["search_monitors", "get_monitor", "query_metrics", "search_logs"] as const;
const TAGS = ["service:payments", "env:prod"];
const PAY = { alias: "pay", tags: TAGS };
const ROUTING = { scopeAlias: "pay", tags: TAGS.join(",") };

// A check or a tool may reach Datadog only through the fetch it is given; the global one fails the test (review A-M3).
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used; a Datadog check and tool use only the fetch they are given"); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const db = memoryStore();
  const secrets = new InMemoryConnectionSecrets(ENV);
  const deps = { store: db, env: ENV, secrets, now: () => Date.now() };
  return { db, deps, registry: orgCredentialRegistry(deps, ORG_A) };
}

async function connected(site: (typeof DATADOG_SITES)[number] = "datadoghq.eu") {
  const s = setup();
  const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined });
  await store.put({ orgId: ORG_A, connection: { connectionId: CON, type: "datadog", label: "Datadog", access: "read", site }, secret: { apiKey: API_KEY, appKey: APP_KEY }, by: ALICE });
  return { ...s, store };
}

const connectorConfig = (over: Record<string, unknown> = {}) => ({
  name: "metrics", type: "datadog", credentialRef: CON, scopes: [PAY], tools: TOOLS.map((name) => ({ name, access: "read" })), ...over,
});
const project = (connectors: unknown[]) => ProjectDefinitionSchema.parse({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

type DatadogScope = { alias: string; tags: string[] };

async function resolved(options: { site?: (typeof DATADOG_SITES)[number]; config?: Record<string, unknown>; api?: ReturnType<typeof fakeDatadog> } = {}) {
  const s = await connected(options.site);
  const site = options.site ?? "datadoghq.eu";
  const api = options.api ?? fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, hosts: [`api.${site}`] });
  const fetch = routeFetch(api.handler);
  const [connector] = resolveConnectors(project([connectorConfig(options.config)]), { credentialRegistry: s.registry, nativeFetch: fetch }, { datadog: datadogConnectorType });
  const definition = await connector!.definition();
  if ("notConnected" in definition) throw new Error(`not connected: ${definition.notConnected}`);
  return { ...s, api, fetch, connector: connector as ResolvedConnector<DatadogScope>, definition: definition as ConnectorDefinition<DatadogScope> };
}

const context = (tools = TOOLS, scope: DatadogScope = PAY) => ({
  workspaceId: "ws", ownerKey: "owner", scopeAlias: scope.alias, scope, settingsRevision: 1,
  policy: { tools: tools.map((name) => ({ name, access: "read" as const })) },
});
const ledger: Ledger = { claim: async () => true, get: async () => undefined, finish: async () => undefined };
const textOf = (result: { content?: Array<{ text?: string | undefined }> | undefined }) => result.content?.map((entry) => entry.text ?? "").join("") ?? "";

async function run(tool: string, args: Record<string, unknown>, options: Parameters<typeof resolved>[0] & { scope?: DatadogScope } = {}) {
  const r = await resolved(options);
  const scope = options.scope ?? PAY;
  const discovered = (await discoverTools(r.definition, context(TOOLS, scope), { connect: r.connector.connect! })).tools.find((entry) => entry.name === tool)!;
  const result = await executeTool(
    { requestId: "11111111-1111-4111-8111-111111111111", scope: scope.alias, tool, schemaHash: discovered.schemaHash, arguments: args },
    r.definition, context(TOOLS, scope), { connect: r.connector.connect!, ledger },
  );
  return { ...r, result };
}

describe("the Datadog connector type", () => {
  it("is built in, named datadog, and resolves its label, vendor, scope noun, scopes and ledger", async () => {
    expect(BUILT_IN_CONNECTOR_TYPES["datadog"]).toBe(datadogConnectorType);
    const s = await connected();
    const [connector] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: s.registry });
    expect(connector).toMatchObject({
      name: "metrics", type: "datadog", label: "Datadog", vendor: "Datadog", scopeNoun: "tag scope", attribution: false,
      ledger: { prefix: "CONNECTOR#metrics#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: CON, accepts: ["static-secret"] },
      scopes: [{ alias: "pay", scope: { alias: "pay", tags: TAGS } }],
    });
  });

  it("lists exactly the four tools a project may approve, and declares no item argument and no label argument", async () => {
    expect(PROJECT_CONNECTOR_TOOLS.datadog).toEqual([...TOOLS]);
    expect(DATADOG_TOOL_NAMES).toEqual([...TOOLS]);
    const { definition } = await resolved();
    expect(definition.itemArguments).toEqual([]);
    expect(definition).not.toHaveProperty("labelArgument");
    expect(definition.guards).toEqual([]);
  });

  it("refuses a Datadog site outside the enum when the connection is saved", async () => {
    const s = setup();
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined });
    const refused = await store.put({ orgId: ORG_A, connection: { connectionId: CON, type: "datadog", label: "Datadog", access: "read", site: "datadoghq.example" }, secret: { apiKey: API_KEY, appKey: APP_KEY }, by: ALICE }).then(() => undefined, (error: { code?: string }) => error);
    expect(refused).toMatchObject({ code: "CONFIG_INVALID" });
    expect((await s.db.query({ pk: `ORG#${ORG_A}#CONNECTIONS` })).items).toEqual([]);
  });

  it("serves the site's own API base and pins the keys to that site's host: a token for api.datadoghq.com is refused for api.datadoghq.eu", async () => {
    for (const site of ["datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", "ap2.datadoghq.com", "us2.ddog-gov.com", "uk1.datadoghq.com"] as const) {
      const { definition, registry } = await resolved({ site });
      expect(definition.endpoint.href).toBe(`https://api.${site}/`);
      expect((await registry.registration(CON))?.host).toBe(`api.${site}`);
      const other = site === "datadoghq.eu" ? "api.datadoghq.com" : "api.datadoghq.eu";
      await expect(registry.provider(CON, { pin: { host: other, required: true } }).issue({}, "read"), site).rejects.toThrow();
    }
  });

  it("is not connected when the record is pinned to another site, has no host, or the connection is not Datadog's", async () => {
    const s = await connected("datadoghq.eu");
    const of = (registry: unknown) => resolveConnectors(project([connectorConfig()]), { credentialRegistry: registry as never })[0]!;
    expect(await of(s.registry).configured()).toBe(true);
    const wrongSite = { ...s.registry, registration: async (ref: string) => ({ ...(await s.registry.registration(ref))!, host: "api.datadoghq.com" }) };
    expect(await of(wrongSite).definition()).toEqual({ notConnected: `credential ${CON} is pinned to api.datadoghq.com, not api.datadoghq.eu, so AgentX does not send it there` });
    const unpinned = { ...s.registry, registration: async (ref: string) => { const { host: _host, ...rest } = (await s.registry.registration(ref))!; return rest; } }; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    expect(await of(unpinned).definition()).toEqual({ notConnected: `credential ${CON} is not pinned to a host; register it again with --host api.datadoghq.eu` });
    const other = setup();
    await new OrgConnectionStore({ ...other.deps, checkEndpoint: async () => undefined }).put({ orgId: ORG_A, connection: { connectionId: CON, type: "vercel", label: "Vercel", access: "read" }, secret: { token: "vercel-token-0123456789" }, by: ALICE });
    expect(await of(other.registry).definition()).toEqual({ notConnected: `connection ${CON} is not a Datadog connection` });
  });

  it("issues one credential that carries both keys, read with the connection's own secret version, and nothing but the keys the tools need", async () => {
    const { definition, registry } = await resolved();
    const issued = await definition.credentials.issue(PAY, "read");
    expect(JSON.parse(issued.token)).toEqual({ apiKey: API_KEY, appKey: APP_KEY });
    expect(issued.bindings).toEqual({});
    // The registry reads the whole secret by the version the connection's own save wrote.
    expect(await registry.connectionSecret?.(CON)).toEqual({ apiKey: API_KEY, appKey: APP_KEY });
  });

  it("refuses to issue a credential when the connection's secret can no longer be read", async () => {
    const s = await connected();
    const unreadable = { ...s.registry, connectionSecret: async () => undefined };
    const [connector] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: unreadable });
    const definition = await connector!.definition();
    if ("notConnected" in definition) throw new Error("expected a definition");
    await expect(definition.credentials.issue(PAY, "read")).rejects.toThrow(`credential ${CON} could not be read; save the connection's secret again`);
  });

  it("treats a malformed stored entry as unusable and never throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stored = { ...project([connectorConfig()]), integrations: { connectors: [connectorConfig({ scopes: [{ alias: "pay" }] })] } } as never;
    expect(resolveConnectors(stored, { credentialRegistry: setup().registry }, { datadog: datadogConnectorType })).toEqual([]);
    const reasons = log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event?: string; reason?: string }).filter((line) => line.event === "connector.unusable");
    expect(reasons[0]?.reason).toBe("invalid datadog connector configuration: scopes");
  });
});

describe("what the model is offered", () => {
  it("marks every tool read with the read-only hints, and shows neither the tags nor the scope alias", async () => {
    const { definition, connector } = await resolved();
    const { tools, skipped } = await discoverTools(definition, context(), { connect: connector.connect! });
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of tools) {
      expect(tool.access, tool.name).toBe("read");
      expect(tool.hints, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      const names = Object.keys(tool.inputSchema["properties"] as object);
      expect(names).not.toEqual(expect.arrayContaining(["tags"]));
      expect(names).not.toEqual(expect.arrayContaining(["scopeAlias"]));
    }
    const props = (name: string) => (tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props("search_monitors")["state"]).toMatchObject({ enum: ["Alert", "Warn", "No Data"] });
    expect(props("get_monitor")["monitorId"]).toMatchObject({ type: "integer", minimum: 1 });
    expect(props("query_metrics")["query"]).toMatchObject({ type: "string", maxLength: 500 });
    expect(props("query_metrics")["fromMinutesAgo"]).toMatchObject({ type: "integer", minimum: 5, maximum: 1440 });
    expect(props("search_logs")["fromMinutesAgo"]).toMatchObject({ minimum: 5, maximum: 1440 });
    expect(props("search_logs")["limit"]).toMatchObject({ minimum: 1, maximum: 50 });
  });

});

describe("running the tools", () => {
  it("narrows a log search to the scope's tags, as the plan words it, and sends both keys to the site's host", async () => {
    const { result, api } = await run("search_logs", { query: "service:billing", fromMinutesAgo: 60, limit: 10 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("charge failed for order 17");
    expect(api.requests).toHaveLength(1);
    const request = api.requests[0]!;
    expect(request).toMatchObject({ method: "POST", apiKey: API_KEY, appKey: APP_KEY });
    expect(new URL(request.url).origin + new URL(request.url).pathname).toBe("https://api.datadoghq.eu/api/v2/logs/events/search");
    expect(request.body).toEqual({ filter: { query: "(service:payments AND env:prod) AND (service:billing)", from: "now-60m", to: "now" }, sort: "-timestamp", page: { limit: 10 } });
  });

  it("quotes a tag value that has characters a log query reads as syntax", async () => {
    const { api } = await run("search_logs", { query: "status:error", fromMinutesAgo: 5 }, { scope: { alias: "pay", tags: ["team:core-api", "env:prod"] }, config: { scopes: [{ alias: "pay", tags: ["team:core-api", "env:prod"] }] } });
    expect((api.requests[0]!.body as { filter: { query: string } }).filter.query).toBe('(team:"core-api" AND env:prod) AND (status:error)');
  });

  it("refuses a log query that could close the scope's group or open a quote, making no request", async () => {
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: await tokenOf(r), tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    for (const query of ["x) OR (y", ")(", "(a", 'a "b', "a\nb", "a\u0000b"]) {
      await expect(connection.call("search_logs", { ...ROUTING, query, fromMinutesAgo: 5 }), query).rejects.toMatchObject({ name: "ToolRefusal", message: "search_logs: query is not allowed", reason: "policy_denied" });
    }
    // Brackets and quotes that balance are fine.
    await expect(connection.call("search_logs", { ...ROUTING, query: '(a OR b) AND "c (d"', fromMinutesAgo: 5 })).resolves.toMatchObject({});
    expect(r.api.requests).toHaveLength(1);
  });

  // Minor hardening: look-alikes of the three syntax characters. Datadog is not known to read them as syntax, but the guard should not rest on that.
  const LOOKALIKES = [
    ["U+201C left double quotation mark", "\u201C"],
    ["U+201D right double quotation mark", "\u201D"],
    ["U+FF02 fullwidth quotation mark", "\uFF02"],
    ["U+FF08 fullwidth left parenthesis", "\uFF08"],
    ["U+FF09 fullwidth right parenthesis", "\uFF09"],
    ["U+FF3C fullwidth reverse solidus", "\uFF3C"],
  ] as const;

  for (const [label, char] of LOOKALIKES) {
    it(`refuses ${label}, alone, inside a word, inside quotes and inside brackets, in a log or monitor search, in fixed words, making no request`, async () => {
      for (const query of [char, `a${char}b`, `"a${char}b"`, `(a${char}b)`, `${char}) OR (x`, `x ${char}`]) expect(isContainedQuery(query), query).toBe(false);
      const r = await resolved();
      const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: await tokenOf(r), tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
      const query = `status:error ${char}x`;
      await expect(connection.call("search_logs", { ...ROUTING, query, fromMinutesAgo: 5 }), query).rejects.toMatchObject({ name: "ToolRefusal", message: "search_logs: query is not allowed", reason: "policy_denied" });
      await expect(connection.call("search_monitors", { ...ROUTING, query }), query).rejects.toMatchObject({ name: "ToolRefusal", message: "search_monitors: query is not allowed", reason: "policy_denied" });
      expect(r.api.requests).toEqual([]);
    });
  }

  it("still accepts other non-ASCII text, and the ASCII quote, bracket and backslash it always read", () => {
    for (const query of ["message:caf\u00E9", "message:\u65E5\u672C\u8A9E", '(a OR b) AND "c (d"', "a\\(b", "\u2018single\u2019"]) expect(isContainedQuery(query), query).toBe(true);
  });

  it("reads a backslash as an escape outside quotes as well as inside, as Datadog does (review C-1)", () => {
    // The two queries the review sent: `\(` and `\"` are literal characters to Datadog, so neither opens a bracket or a quote there.
    expect(isContainedQuery("x\\( ) OR * OR (x \\)")).toBe(false);
    expect(isContainedQuery('a\\") OR *:* OR (b"c\\"d"')).toBe(false);
    // Outside quotes: an escaped bracket or quote opens nothing, and does not hide the real ones around it.
    expect(isContainedQuery("a\\(b")).toBe(true);
    expect(isContainedQuery("a\\)b")).toBe(true);
    expect(isContainedQuery('a\\"b')).toBe(true);
    expect(isContainedQuery("(a\\))")).toBe(true);
    expect(isContainedQuery("(a\\)")).toBe(false);
    expect(isContainedQuery("a\\\\(b")).toBe(false);
    expect(isContainedQuery("a\\\\\\(b)")).toBe(false);
    expect(isContainedQuery('a\\\\"b')).toBe(false);
    // Inside quotes the escape still holds.
    expect(isContainedQuery('"a\\"b"')).toBe(true);
    expect(isContainedQuery('"a\\"')).toBe(false);
    expect(isContainedQuery('"a\\\\"')).toBe(true);
    expect(isContainedQuery('"a\\\\" OR (b')).toBe(false);
    // A trailing backslash would escape the bracket the scope puts after the query.
    for (const query of ["foo\\", "\\", "(a)\\", "a\\\\\\", '"a"\\']) expect(isContainedQuery(query), query).toBe(false);
    for (const query of ["a\\\\", "foo", "(a OR b) AND \"c (d\""]) expect(isContainedQuery(query), query).toBe(true);
  });

  it("refuses the review's escape queries, a trailing backslash and an unbalanced escape in a log or monitor search, in fixed words, making no request", async () => {
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: await tokenOf(r), tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    const queries = ["x\\( ) OR * OR (x \\)", 'a\\") OR *:* OR (b"c\\"d"', "foo\\", "(a)\\", '"a\\"', "a\\\\(b", "(a\\)"];
    for (const query of queries) {
      await expect(connection.call("search_logs", { ...ROUTING, query, fromMinutesAgo: 5 }), query).rejects.toMatchObject({ name: "ToolRefusal", message: "search_logs: query is not allowed", reason: "policy_denied" });
      await expect(connection.call("search_monitors", { ...ROUTING, query }), query).rejects.toMatchObject({ name: "ToolRefusal", message: "search_monitors: query is not allowed", reason: "policy_denied" });
    }
    expect(r.api.requests).toEqual([]);
    // A backslash that escapes something harmless is fine, and goes through inside its own group.
    await expect(connection.call("search_logs", { ...ROUTING, query: "message:a\\(b", fromMinutesAgo: 5 })).resolves.toMatchObject({});
    expect((r.api.requests[0]!.body as { filter: { query: string } }).filter.query).toBe("(service:payments AND env:prod) AND (message:a\\(b)");
  });

  it("drops a log that does not carry every scope tag, whatever the vendor's filter let through (review C-1)", async () => {
    const logs: FakeDatadogLog[] = [
      { id: "own-1", service: "payments", tags: ["env:prod", "team:core"], message: "own log by service attribute" },
      { id: "own-2", service: "web", tags: ["service:payments", "env:prod"], message: "own log by service tag" },
      { id: "other-service", service: "billing", tags: ["env:prod"], message: "another service's secret log" },
      { id: "other-env", service: "payments", tags: ["env:dev"], message: "the dev environment's log" },
      { id: "no-tags", service: "payments", tags: [], message: "a log with no tags" },
    ];
    const { result } = await run("search_logs", { query: "*", fromMinutesAgo: 60 }, { api: fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, logs }) });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("2 logs in pay");
    expect(result.text).toContain("own log by service attribute");
    expect(result.text).toContain("own log by service tag");
    expect(result.text).not.toMatch(/another service|dev environment|no tags/u);
    const none = await run("search_logs", { query: "*", fromMinutesAgo: 60 }, { api: fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, logs: logs.slice(2) }) });
    expect(none.result.text).toBe("No logs in pay for that search.");
    // The limit counts the logs that are shown, not the ones the vendor sent.
    const limited = await run("search_logs", { query: "*", fromMinutesAgo: 60, limit: 1 }, { api: fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, logs: [logs[2]!, logs[0]!, logs[1]!] }) });
    expect(limited.result.text).toContain("1 log in pay");
    expect(limited.result.text).toContain("own log by service attribute");
    expect(limited.result.text).not.toContain("another service");
  });

  it("counts a log's host attribute as its host tag", async () => {
    const scope = { alias: "web", tags: ["host:web1", "env:prod"] };
    const logs: FakeDatadogLog[] = [
      { id: "h1", service: "x", host: "web1", tags: ["env:prod"], message: "from web1" },
      { id: "h2", service: "x", host: "web2", tags: ["env:prod"], message: "from web2" },
      { id: "h3", service: "x", tags: ["env:prod"], message: "from nowhere" },
    ];
    const { result } = await run("search_logs", { query: "*", fromMinutesAgo: 60 }, { scope, config: { scopes: [scope] }, api: fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, logs }) });
    expect(result.text).toContain("1 log in web");
    expect(result.text).toContain("from web1");
    expect(result.text).not.toMatch(/web2|nowhere/u);
  });

  it("drops a monitor from a search when it does not carry every scope tag, whatever the vendor's filter let through (review C-1)", async () => {
    const { result } = await run("search_monitors", { query: "*" });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("1 monitor in pay");
    expect(result.text).toContain("Payments latency");
    expect(result.text).not.toContain("Billing errors");
    const none = await run("search_monitors", {}, { api: fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, monitors: [{ id: 12, name: "Billing errors", tags: ["service:billing", "env:prod"] }, { id: 13, name: "Payments in dev", tags: ["service:payments", "env:dev"] }, { id: 14, name: "Untagged", tags: [] }] }) });
    expect(none.result.text).toBe("No monitors in pay.");
  });

  it("refuses a monitor search that could close the scope's group, like a log search, making no request", async () => {
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: await tokenOf(r), tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    await expect(connection.call("search_monitors", { ...ROUTING, query: "x) OR (y" })).rejects.toMatchObject({ message: "search_monitors: query is not allowed", reason: "policy_denied" });
    expect(r.api.requests).toEqual([]);
  });

  it("shows a monitor only if it carries every one of the scope's tags", async () => {
    const own = await run("get_monitor", { monitorId: 11 });
    expect(own.result.status).toBe("SUCCEEDED");
    expect(own.result.text).toContain("Payments latency");
    expect(own.result.text).toContain("Alert");
    const other = await run("get_monitor", { monitorId: 12 });
    expect(other.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that monitor is not in pay" });
    expect(other.result.text).not.toContain("Billing errors");
    const missing = await run("get_monitor", { monitorId: 99 });
    expect(missing.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Datadog has no such monitor" });
  });

  it("searches monitors within the scope's tags and the chosen state, with the model's words in a group of their own", async () => {
    const { result, api } = await run("search_monitors", { query: "latency", state: "No Data" });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("Payments latency");
    const url = new URL(api.requests[0]!.url);
    expect(url.pathname).toBe("/api/v1/monitor/search");
    expect(url.searchParams.get("query")).toBe('tag:"service:payments" tag:"env:prod" status:"no data" (latency)');
    expect(url.searchParams.get("per_page")).toBe("25");
  });

  it("narrows a metric query by adding the scope's tags to its filter, and refuses a filter that could widen it", async () => {
    const queried = async (query: string) => (await run("query_metrics", { query, fromMinutesAgo: 60 }));
    const plain = await queried("avg:system.cpu.user{host:web1} by {host}");
    expect(plain.result.status).toBe("SUCCEEDED");
    const sent = new URL(plain.api.requests[0]!.url);
    expect(sent.pathname).toBe("/api/v1/query");
    expect(sent.searchParams.get("query")).toBe("avg:system.cpu.user{host:web1,service:payments,env:prod} by {host}");
    expect(Number(sent.searchParams.get("to")) - Number(sent.searchParams.get("from"))).toBe(3600);
    expect(plain.result.text).toContain("payments.latency");
    expect(plain.result.text).toContain("2.5");
    expect(new URL((await queried("sum:trace.requests{*}.as_count()")).api.requests[0]!.url).searchParams.get("query")).toBe("sum:trace.requests{service:payments,env:prod}.as_count()");
    expect(new URL((await queried("max:a.b{!env:dev,region:eu}.rollup(max, 60)")).api.requests[0]!.url).searchParams.get("query")).toBe("max:a.b{!env:dev,region:eu,service:payments,env:prod}.rollup(max, 60)");
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: await tokenOf(r), tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    for (const query of ["avg:a.b{x:1 OR y:2}", "avg:a.b{(x:1)}", "avg:a.b{x:1},avg:c.d{y:2}", "a.b{x:1}", "avg:a.b{x:1} + avg:c.d{y:2}", "avg:a.b{x:1}\navg:c", "avg:a.b{x:1} by {host}.foo{}", "avg:a b{x:1}", "avg:a.b{x:1,}", "avg:a.b{}"]) {
      await expect(connection.call("query_metrics", { ...ROUTING, query, fromMinutesAgo: 60 }), query).rejects.toMatchObject({ message: "query_metrics: query is not allowed" });
    }
    expect(r.api.requests).toEqual([]);
  });

  it("takes no backslash in a metric query, in the filter, the grouping or a function's arguments", () => {
    expect(scopedMetricQuery("avg:a.b{x:1}.rollup(max, 60)", TAGS)).toBe("avg:a.b{x:1,service:payments,env:prod}.rollup(max, 60)");
    for (const query of ["avg:a.b{x\\:1}", "avg:a.b{x:1} by {h\\ost}", "avg:a.b{x:1}.rollup(max\\, 60)", "avg:a.b{x:1}.rollup(\\)", "avg:a.b{x:1}.rollup(60)\\"]) {
      expect(scopedMetricQuery(query, TAGS), query).toBeUndefined();
    }
  });

  it("accepts a scope of the longest tags the schema allows, 829 characters of them in the routing value, and shows its monitors", async () => {
    const tags = ["a", "b", "c", "d", "e"].map((letter) => `k${"y".repeat(63)}:${letter}${"v".repeat(99)}`);
    expect(tags.every((tag) => tag.length === 165)).toBe(true);
    const scope = { alias: "long", tags };
    expect(DatadogScopeSchema.safeParse(scope).success).toBe(true);
    expect(tags.join(",")).toHaveLength(829);
    const api = fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, monitors: [{ id: 21, name: "Long scoped monitor", tags: [...tags, "extra:1"] }, { id: 22, name: "Short scoped monitor", tags: tags.slice(0, 4) }] });
    const { result } = await run("search_monitors", {}, { scope, config: { scopes: [scope] }, api });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("1 monitor in long");
    expect(result.text).toContain("Long scoped monitor");
    expect(result.text).not.toContain("Short scoped monitor");
  });

  it("scrubs both keys from anything a tool answers with", async () => {
    const { result } = await run("search_logs", { query: "x", fromMinutesAgo: 5 }, { api: fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, logMessage: `leaked ${APP_KEY} and ${API_KEY} in a log line` }) });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("leaked [REDACTED] and [REDACTED] in a log line");
    expect(JSON.stringify(result)).not.toContain(APP_KEY);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it("answers a refused key, a missing monitor and an outage in fixed words, carrying nothing the vendor sent", async () => {
    const wrong = await run("search_monitors", {}, { api: fakeDatadog({ apiKey: API_KEY, appKey: "dd-some-other-app-key-0123" }) });
    expect(wrong.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Datadog refused the keys. Check the API key, and that the application key has monitors_read, timeseries_query and logs_read_data." });
    const down = await run("search_monitors", {}, { api: fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, status: 503 }) });
    expect(down.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Datadog answered HTTP 503" });
    const limited = await run("search_monitors", {}, { api: fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, status: 429 }) });
    expect(limited.result.text).toBe("Datadog is limiting requests; try again later");
    expect(JSON.stringify([wrong.result, down.result, limited.result])).not.toMatch(/fake outage|Forbidden/u);
  });

  it("goes only to the connection's site host, whatever a tool is asked", async () => {
    const { api } = await run("search_logs", { query: "x", fromMinutesAgo: 5 });
    expect(api.requests.map((request) => new URL(request.url).hostname)).toEqual(["api.datadoghq.eu"]);
    const us = await run("search_logs", { query: "x", fromMinutesAgo: 5 }, { site: "us3.datadoghq.com" });
    expect(us.api.requests.map((request) => new URL(request.url).hostname)).toEqual(["api.us3.datadoghq.com"]);
  });

  it("refuses an argument the model may not set without any request", async () => {
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: await tokenOf(r), tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    expect(textOf(await connection.call("search_logs", { ...ROUTING, query: "x", fromMinutesAgo: 4 }))).toBe("search_logs: fromMinutesAgo is not allowed");
    expect(textOf(await connection.call("search_logs", { ...ROUTING, query: "x", fromMinutesAgo: 1441 }))).toBe("search_logs: fromMinutesAgo is not allowed");
    expect(textOf(await connection.call("search_logs", { ...ROUTING, query: "x", fromMinutesAgo: 5, limit: 51 }))).toBe("search_logs: limit is not allowed");
    expect(textOf(await connection.call("search_logs", { ...ROUTING, query: "x", fromMinutesAgo: 5, indexes: ["*"] }))).toBe("search_logs: indexes is not allowed");
    expect(textOf(await connection.call("search_monitors", { ...ROUTING, state: "OK" }))).toBe("search_monitors: state is not allowed");
    expect(textOf(await connection.call("get_monitor", { ...ROUTING, monitorId: "11" }))).toBe("get_monitor: monitorId is not allowed");
    expect(textOf(await connection.call("query_metrics", { ...ROUTING, query: "x".repeat(501), fromMinutesAgo: 5 }))).toBe("query_metrics: query is not allowed");
    expect(r.api.requests).toEqual([]);
  });
});

/** The packed credential a connect would be given, as the definition issues it. */
async function tokenOf(r: Awaited<ReturnType<typeof resolved>>): Promise<string> {
  return (await r.definition.credentials.issue(PAY, "read")).token;
}

describe("the Datadog connection check", () => {
  async function checkWith(api: ReturnType<typeof fakeDatadog>, site: (typeof DATADOG_SITES)[number] = "datadoghq.eu") {
    const s = await connected(site);
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, fetch: routeFetch(api.handler), checks: { datadog: datadogConnectionCheck } });
    return { store, api };
  }

  it("validates the API key and then the application key, at the site's host, with both headers", async () => {
    const { store, api } = await checkWith(fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY }));
    expect(await store.check(ORG_A, CON)).toEqual({ ok: true });
    expect(api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/api/v1/validate", "/api/v1/monitor/search"]);
    for (const request of api.requests) expect(request).toMatchObject({ apiKey: API_KEY, appKey: APP_KEY, method: "GET" });
    expect(new URL(api.requests[0]!.url).hostname).toBe("api.datadoghq.eu");
    expect((await store.get(ORG_A, CON))?.lastCheck).toMatchObject({ ok: true });
  });

  it("says which key Datadog refused", async () => {
    const badApi = await checkWith(fakeDatadog({ apiKey: "dd-another-api-key-0123456", appKey: APP_KEY }));
    expect(await badApi.store.check(ORG_A, CON)).toEqual({ ok: false, message: "Datadog refused the API key. Check that it is an API key for this site." });
    const badApp = await checkWith(fakeDatadog({ apiKey: API_KEY, appKey: "dd-another-app-key-0123456" }));
    expect(await badApp.store.check(ORG_A, CON)).toEqual({ ok: false, message: "Datadog accepted the API key but refused the application key. Check that it has monitors_read, timeseries_query and logs_read_data." });
    expect(JSON.stringify([await badApi.store.get(ORG_A, CON), await badApp.store.get(ORG_A, CON)])).not.toContain(APP_KEY);
  });

  it("answers an outage as retryable without recording a check", async () => {
    const { store } = await checkWith(fakeDatadog({ apiKey: API_KEY, appKey: APP_KEY, status: 503 }));
    const refusal = await store.check(ORG_A, CON).then(() => undefined, (error: { code?: string }) => error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await store.get(ORG_A, CON))?.lastCheck).toBeUndefined();
  });
});
