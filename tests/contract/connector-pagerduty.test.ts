// the PagerDuty connector. It reads incidents, their log entries and the current on-calls of one set of services through an org connection's REST
// API key, at `https://api.pagerduty.com/` (US) or `https://api.eu.pagerduty.com/` (EU), in the broker. Every list is bound to the scope's services and every item
// is checked to be on one. The PagerDuty API is faked; no test reaches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverTools, executeTool, type ConnectorDefinition, type Ledger } from "@agentx/gateway";
import { ProjectDefinitionSchema, type OrgId } from "../../packages/contracts/src/index.js";
import { resolveConnectors, type ResolvedConnector } from "../../packages/broker/src/aws/connector-types.js";
import { pagerdutyConnectionCheck, pagerdutyConnectorType } from "../../packages/broker/src/connectors/native/pagerduty-connector-type.js";
import { PAGERDUTY_TOOL_NAMES } from "../../packages/broker/src/connectors/native/pagerduty.js";
import { PROJECT_CONNECTOR_TOOLS } from "../support/project-connector-tools.js";
import { orgCredentialRegistry } from "../../packages/broker/src/connections/registry.js";
import { OrgConnectionStore } from "../../packages/broker/src/connections/store.js";
import { InMemoryConnectionSecrets, memoryStore } from "../support/connection-fakes.js";
import { routeFetch } from "../support/developer-fakes.js";
import { fakePagerDuty } from "../support/fake-vendor-apis.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ENV = "staging";
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "a".repeat(64);
const API_KEY = ["pd", "api", "key", "x".repeat(16)].join("-");
const TOOLS = ["list_incidents", "get_incident", "list_incident_log_entries", "list_oncalls"] as const;
const PAY = { alias: "pay", serviceIds: ["PSVC001"] };
type Region = "us" | "eu";
type PagerDutyScope = { alias: string; serviceIds: string[] };
const ROUTING = { scopeAlias: "pay", serviceIds: "PSVC001" };

// A check or a tool may reach PagerDuty only through the fetch it is given; the global one fails the test (review A-M3).
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used; a PagerDuty check and tool use only the fetch they are given"); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const db = memoryStore();
  const secrets = new InMemoryConnectionSecrets(ENV);
  const deps = { store: db, env: ENV, secrets, now: () => Date.now() };
  return { db, deps, registry: orgCredentialRegistry(deps, ORG_A) };
}

async function connected(region: Region = "us") {
  const s = setup();
  const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined });
  await store.put({ orgId: ORG_A, connection: { connectionId: CON, type: "pagerduty", label: "PagerDuty", access: "read", region }, secret: { apiKey: API_KEY }, by: ALICE });
  return { ...s, store };
}

const connectorConfig = (over: Record<string, unknown> = {}) => ({
  name: "oncall", type: "pagerduty", credentialRef: CON, scopes: [PAY], tools: TOOLS.map((name) => ({ name, access: "read" })), ...over,
});
const project = (connectors: unknown[]) => ProjectDefinitionSchema.parse({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

async function resolved(options: { region?: Region; config?: Record<string, unknown>; api?: ReturnType<typeof fakePagerDuty> } = {}) {
  const s = await connected(options.region);
  const host = options.region === "eu" ? "api.eu.pagerduty.com" : "api.pagerduty.com";
  const api = options.api ?? fakePagerDuty({ apiKey: API_KEY, hosts: [host] });
  const [connector] = resolveConnectors(project([connectorConfig(options.config)]), { credentialRegistry: s.registry, nativeFetch: routeFetch(api.handler) }, { pagerduty: pagerdutyConnectorType });
  const definition = await connector!.definition();
  if ("notConnected" in definition) throw new Error(`not connected: ${definition.notConnected}`);
  return { ...s, api, connector: connector as ResolvedConnector<PagerDutyScope>, definition: definition as ConnectorDefinition<PagerDutyScope> };
}

const context = (scope: PagerDutyScope = PAY) => ({
  workspaceId: "ws", ownerKey: "owner", scopeAlias: scope.alias, scope, settingsRevision: 1,
  policy: { tools: TOOLS.map((name) => ({ name, access: "read" as const })) },
});
const ledger: Ledger = { claim: async () => true, get: async () => undefined, finish: async () => undefined };
const textOf = (result: { content?: Array<{ text?: string | undefined }> | undefined }) => result.content?.map((entry) => entry.text ?? "").join("") ?? "";

async function run(tool: string, args: Record<string, unknown>, options: Parameters<typeof resolved>[0] & { scope?: PagerDutyScope } = {}) {
  const r = await resolved(options);
  const scope = options.scope ?? PAY;
  const discovered = (await discoverTools(r.definition, context(scope), { connect: r.connector.connect! })).tools.find((entry) => entry.name === tool)!;
  const result = await executeTool(
    { requestId: "11111111-1111-4111-8111-111111111111", scope: scope.alias, tool, schemaHash: discovered.schemaHash, arguments: args },
    r.definition, context(scope), { connect: r.connector.connect!, ledger },
  );
  return { ...r, result };
}

async function direct(r: Awaited<ReturnType<typeof resolved>>) {
  return r.connector.connect!({ endpoint: r.definition.endpoint, token: API_KEY, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
}

describe("the PagerDuty connector type", () => {

  it("lists exactly the four tools a project may approve, no item argument, no label argument", async () => {
    expect(PROJECT_CONNECTOR_TOOLS.pagerduty).toEqual([...TOOLS]);
    expect(PAGERDUTY_TOOL_NAMES).toEqual([...TOOLS]);
    const { definition } = await resolved();
    expect(definition.itemArguments).toEqual([]);
    expect(definition).not.toHaveProperty("labelArgument");
  });

  it("calls the EU host for an eu connection and the US host for a us one, and pins the token to that host", async () => {
    for (const [region, host, other] of [["us", "api.pagerduty.com", "api.eu.pagerduty.com"], ["eu", "api.eu.pagerduty.com", "api.pagerduty.com"]] as const) {
      const r = await resolved({ region });
      expect(r.definition.endpoint.href).toBe(`https://${host}/`);
      expect((await r.registry.registration(CON))?.host).toBe(host);
      await expect(r.registry.provider(CON, { pin: { host: other, required: true } }).issue({}, "read")).rejects.toThrow();
      const { api, result } = await run("list_incidents", {}, { region });
      expect(result.status, region).toBe("SUCCEEDED");
      expect(api.requests.map((request) => new URL(request.url).hostname)).toEqual([host]);
    }
  });

});

describe("running the tools", () => {
  it("always sends the scope's service_ids[] and the version header, and the model cannot pass others", async () => {
    const { result, api } = await run("list_incidents", { statuses: ["triggered", "acknowledged"], sinceHoursAgo: 48 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("Payments API 5xx");
    expect(result.text).not.toContain("Billing batch failed");
    const request = api.requests[0]!;
    expect(request).toMatchObject({ method: "GET", authorization: `Token token=${API_KEY}`, accept: "application/vnd.pagerduty+json;version=2" });
    const url = new URL(request.url);
    expect(url.pathname).toBe("/incidents");
    expect(url.searchParams.getAll("service_ids[]")).toEqual(["PSVC001"]);
    expect(url.searchParams.getAll("statuses[]")).toEqual(["triggered", "acknowledged"]);
    const since = Date.parse(url.searchParams.get("since")!);
    expect(Date.now() - since).toBeGreaterThan(47 * 3_600_000);
    expect(Date.now() - since).toBeLessThan(49 * 3_600_000);
    const r = await resolved();
    const connection = await direct(r);
    for (const extra of [{ service_ids: ["PSVC002"] }, { "service_ids[]": ["PSVC002"] }]) {
      expect(textOf(await connection.call("list_incidents", { ...ROUTING, ...extra }))).toMatch(/is not allowed$/u);
    }
    expect(r.api.requests).toEqual([]);
    // Through the engine the routing value itself is the server's: a model that names it is refused before anything runs.
    const discovered = (await discoverTools(r.definition, context(), { connect: r.connector.connect! })).tools.find((entry) => entry.name === "list_incidents")!;
    await expect(executeTool(
      { requestId: "22222222-2222-4222-8222-222222222222", scope: "pay", tool: "list_incidents", schemaHash: discovered.schemaHash, arguments: { serviceIds: "PSVC002" } },
      r.definition, context(), { connect: r.connector.connect!, ledger },
    )).rejects.toThrow("routing arguments are server controlled");
    expect(r.api.requests).toEqual([]);
  });

  it("reads an incident on the scope's services, and refuses one on another service", async () => {
    const own = await run("get_incident", { incidentId: "PINC001" });
    expect(own.result.status).toBe("SUCCEEDED");
    expect(own.result.text).toContain("Payments API 5xx");
    expect(own.result.text).toContain("Dana Ops");
    const other = await run("get_incident", { incidentId: "PINC003" });
    expect(other.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that incident is not in pay" });
    expect(other.result.text).not.toContain("Billing batch failed");
    const missing = await run("get_incident", { incidentId: "PNOPE99" });
    expect(missing.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "PagerDuty has no such incident" });
  });

  it("reads an incident's log entries after confirming its service, leaving out channel details, and fetches none for another service's incident", async () => {
    const own = await run("list_incident_log_entries", { incidentId: "PINC001" });
    expect(own.result.status).toBe("SUCCEEDED");
    expect(own.result.text).toContain("Triggered through the API");
    expect(own.result.text).toContain("Acknowledged by Dana Ops");
    expect(own.result.text).not.toContain("secret-routing-key-123");
    expect(own.api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/incidents/PINC001", "/incidents/PINC001/log_entries"]);
    const other = await run("list_incident_log_entries", { incidentId: "PINC003" });
    expect(other.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that incident is not in pay" });
    expect(other.api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/incidents/PINC003"]);
  });

  it("lists the current on-calls of the escalation policies of the scope's services only", async () => {
    const { result, api } = await run("list_oncalls", {});
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("Dana Ops");
    expect(result.text).toContain("Payments on-call");
    expect(result.text).not.toContain("Eli Billing");
    expect(api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/services/PSVC001", "/oncalls"]);
    expect(new URL(api.requests[1]!.url).searchParams.getAll("escalation_policy_ids[]")).toEqual(["PEP0001"]);
    const two = await run("list_oncalls", {}, { scope: { alias: "both", serviceIds: ["PSVC001", "PSVC002"] }, config: { scopes: [{ alias: "both", serviceIds: ["PSVC001", "PSVC002"] }] } });
    expect(two.result.text).toContain("Eli Billing");
    expect(new URL(two.api.requests.at(-1)!.url).searchParams.getAll("escalation_policy_ids[]")).toEqual(["PEP0001", "PEP0002"]);
  });

  it("refuses an incident id that could change the path, making no request", async () => {
    const r = await resolved();
    const connection = await direct(r);
    for (const incidentId of ["../services/PSVC001", "PINC001/log_entries", "", "A".repeat(31), "PINC 001", "PINC001?x=1"]) {
      expect((await connection.call("get_incident", { ...ROUTING, incidentId })).isError, incidentId).toBe(true);
    }
    expect(textOf(await connection.call("list_incidents", { ...ROUTING, sinceHoursAgo: 721 }))).toBe("list_incidents: sinceHoursAgo is not allowed");
    expect(textOf(await connection.call("list_incidents", { ...ROUTING, statuses: ["open"] }))).toBe("list_incidents: statuses.0 is not allowed");
    expect(r.api.requests).toEqual([]);
  });

  it("answers a refused key, a missing item and an outage in fixed words, carrying nothing the vendor sent, and scrubs the key", async () => {
    const wrong = await run("list_incidents", {}, { api: fakePagerDuty({ apiKey: "pd-another-key-0123456789" }) });
    expect(wrong.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "PagerDuty refused the API key. Check that it is a valid REST API key for this region." });
    const down = await run("list_incidents", {}, { api: fakePagerDuty({ apiKey: API_KEY, status: 503 }) });
    expect(down.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "PagerDuty answered HTTP 503" });
    const forbidden = await run("list_incidents", {}, { api: fakePagerDuty({ apiKey: API_KEY, status: 403 }) });
    expect(forbidden.result.text).toBe("PagerDuty refused the API key. Check that it is a valid REST API key for this region.");
    const limited = await run("list_incidents", {}, { api: fakePagerDuty({ apiKey: API_KEY, status: 429 }) });
    expect(limited.result.text).toBe("PagerDuty is limiting requests; try again later");
    expect(JSON.stringify([wrong.result, down.result, limited.result])).not.toMatch(/Unauthorized|fake outage|2006/u);
  });
});

describe("the PagerDuty connection check", () => {
  async function checkWith(api: ReturnType<typeof fakePagerDuty>, region: Region = "us") {
    const s = await connected(region);
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, fetch: routeFetch(api.handler), checks: { pagerduty: pagerdutyConnectionCheck } });
    return { store, api };
  }

  it("asks for the abilities at the region's host, with the key and the version header", async () => {
    const { store, api } = await checkWith(fakePagerDuty({ apiKey: API_KEY, hosts: ["api.eu.pagerduty.com"] }), "eu");
    expect(await store.check(ORG_A, CON)).toEqual({ ok: true });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: "GET", authorization: `Token token=${API_KEY}`, accept: "application/vnd.pagerduty+json;version=2" });
    expect(new URL(api.requests[0]!.url).origin + new URL(api.requests[0]!.url).pathname).toBe("https://api.eu.pagerduty.com/abilities");
    expect((await store.get(ORG_A, CON))?.lastCheck).toMatchObject({ ok: true });
  });

  it("says PagerDuty refused the key, and answers an outage as retryable without recording a check", async () => {
    const bad = await checkWith(fakePagerDuty({ apiKey: "pd-another-key-0123456789" }));
    expect(await bad.store.check(ORG_A, CON)).toEqual({ ok: false, message: "PagerDuty refused the API key. Check that it is a valid REST API key for this region." });
    const down = await checkWith(fakePagerDuty({ apiKey: API_KEY, status: 503 }));
    const refusal = await down.store.check(ORG_A, CON).then(() => undefined, (error: { code?: string }) => error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await down.store.get(ORG_A, CON))?.lastCheck).toBeUndefined();
  });
});
