// the Vercel connector. It reads the deployments of one project, and their build events, through an org connection's access token at
// `https://api.vercel.com/`, in the broker. A connection with a team id adds it to every request, and an item is shown only if it belongs to the scope's project.
// The Vercel API is faked; no test reaches a network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverTools, executeTool, type ConnectorDefinition, type Ledger } from "@agentx/gateway";
import { ProjectDefinitionSchema, type OrgId } from "../../packages/contracts/src/index.js";
import { BUILT_IN_CONNECTOR_TYPES, resolveConnectors, type ResolvedConnector } from "../../packages/core/src/aws/connector-types.js";
import { vercelConnectionCheck, vercelConnectorType } from "../../packages/core/src/connectors/native/vercel-connector-type.js";
import { VERCEL_TOOL_NAMES } from "../../packages/core/src/connectors/native/vercel.js";
import { PROJECT_CONNECTOR_TOOLS } from "../support/project-connector-tools.js";
import { orgCredentialRegistry } from "../../packages/core/src/connections/registry.js";
import { OrgConnectionStore } from "../../packages/core/src/connections/store.js";
import { InMemoryConnectionSecrets, memoryStore } from "../support/connection-fakes.js";
import { routeFetch } from "../support/developer-fakes.js";
import { fakeVercel } from "../support/fake-vendor-apis.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ENV = "staging";
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "a".repeat(64);
const TOKEN = "vercel-token-0123456789abcdef";
const TEAM = "team_abc123";
const TOOLS = ["list_deployments", "get_deployment", "get_deployment_events"] as const;
const WEB = { alias: "site", projectId: "prj_web1" };
type VercelScope = { alias: string; projectId: string };

// A check or a tool may reach Vercel only through the fetch it is given; the global one fails the test (review A-M3).
beforeEach(() => { vi.stubGlobal("fetch", () => { throw new Error("test: the global fetch was used; a Vercel check and tool use only the fetch they are given"); }); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const db = memoryStore();
  const secrets = new InMemoryConnectionSecrets(ENV);
  const deps = { store: db, env: ENV, secrets, now: () => Date.now() };
  return { db, deps, registry: orgCredentialRegistry(deps, ORG_A) };
}

async function connected(teamId?: string) {
  const s = setup();
  const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined });
  await store.put({ orgId: ORG_A, connection: { connectionId: CON, type: "vercel", label: "Vercel", access: "read", ...(teamId === undefined ? {} : { teamId }) }, secret: { token: TOKEN }, by: ALICE });
  return { ...s, store };
}

const connectorConfig = (over: Record<string, unknown> = {}) => ({
  name: "deploys", type: "vercel", credentialRef: CON, scopes: [WEB], tools: TOOLS.map((name) => ({ name, access: "read" })), ...over,
});
const project = (connectors: unknown[]) => ProjectDefinitionSchema.parse({
  name: "payments", revision: 1,
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
  setup: [], readiness: [], orchestratorInstructions: "x", integrations: { connectors },
});

async function resolved(options: { teamId?: string; api?: ReturnType<typeof fakeVercel> } = {}) {
  const s = await connected(options.teamId);
  const api = options.api ?? fakeVercel({ token: TOKEN });
  const [connector] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: s.registry, nativeFetch: routeFetch(api.handler) }, { vercel: vercelConnectorType });
  const definition = await connector!.definition();
  if ("notConnected" in definition) throw new Error(`not connected: ${definition.notConnected}`);
  return { ...s, api, connector: connector as ResolvedConnector<VercelScope>, definition: definition as ConnectorDefinition<VercelScope> };
}

const context = (scope: VercelScope = WEB) => ({
  workspaceId: "ws", ownerKey: "owner", scopeAlias: scope.alias, scope, settingsRevision: 1,
  policy: { tools: TOOLS.map((name) => ({ name, access: "read" as const })) },
});
const ledger: Ledger = { claim: async () => true, get: async () => undefined, finish: async () => undefined };
const textOf = (result: { content?: Array<{ text?: string | undefined }> | undefined }) => result.content?.map((entry) => entry.text ?? "").join("") ?? "";

async function run(tool: string, args: Record<string, unknown>, options: Parameters<typeof resolved>[0] = {}) {
  const r = await resolved(options);
  const discovered = (await discoverTools(r.definition, context(), { connect: r.connector.connect! })).tools.find((entry) => entry.name === tool)!;
  const result = await executeTool(
    { requestId: "11111111-1111-4111-8111-111111111111", scope: "site", tool, schemaHash: discovered.schemaHash, arguments: args },
    r.definition, context(), { connect: r.connector.connect!, ledger },
  );
  return { ...r, result };
}

describe("the Vercel connector type", () => {
  it("is built in, named vercel, and resolves its label, vendor, scope noun, scopes and ledger", async () => {
    expect(BUILT_IN_CONNECTOR_TYPES["vercel"]).toBe(vercelConnectorType);
    const s = await connected();
    const [connector] = resolveConnectors(project([connectorConfig()]), { credentialRegistry: s.registry });
    expect(connector).toMatchObject({
      name: "deploys", type: "vercel", label: "Vercel", vendor: "Vercel", scopeNoun: "project", attribution: false,
      ledger: { prefix: "CONNECTOR#deploys#", entityType: "CONNECTOR_INVOCATION" },
      credential: { ref: CON, accepts: ["static-secret"] },
      scopes: [{ alias: "site", scope: WEB }],
    });
  });

  it("lists exactly the three tools a project may approve, no item argument, no label argument", async () => {
    expect(PROJECT_CONNECTOR_TOOLS.vercel).toEqual([...TOOLS]);
    expect(VERCEL_TOOL_NAMES).toEqual([...TOOLS]);
    const { definition } = await resolved();
    expect(definition.itemArguments).toEqual([]);
    expect(definition).not.toHaveProperty("labelArgument");
  });

  it("serves api.vercel.com and pins the token to it: a token pinned to another host is refused", async () => {
    const r = await resolved();
    expect(r.definition.endpoint.href).toBe("https://api.vercel.com/");
    expect((await r.registry.registration(CON))?.host).toBe("api.vercel.com");
    await expect(r.registry.provider(CON, { pin: { host: "api.evil.example", required: true } }).issue({}, "read")).rejects.toThrow();
    const s = await connected();
    const of = (registry: unknown) => resolveConnectors(project([connectorConfig()]), { credentialRegistry: registry as never })[0]!;
    const wrong = { ...s.registry, registration: async (ref: string) => ({ ...(await s.registry.registration(ref))!, host: "vercel.com" }) };
    expect(await of(wrong).definition()).toEqual({ notConnected: `credential ${CON} is pinned to vercel.com, not api.vercel.com, so AgentX does not send it there` });
    const unpinned = { ...s.registry, registration: async (ref: string) => { const { host: _host, ...rest } = (await s.registry.registration(ref))!; return rest; } }; // eslint-disable-line @typescript-eslint/no-unused-vars -- dropped on purpose
    expect(await of(unpinned).definition()).toEqual({ notConnected: `credential ${CON} is not pinned to a host; register it again with --host api.vercel.com` });
    const other = setup();
    await new OrgConnectionStore({ ...other.deps, checkEndpoint: async () => undefined }).put({ orgId: ORG_A, connection: { connectionId: CON, type: "pagerduty", label: "PD", access: "read", region: "us" }, secret: { apiKey: ["pd", "api", "key", "x".repeat(16)].join("-") }, by: ALICE });
    expect(await of(other.registry).definition()).toEqual({ notConnected: `connection ${CON} is not a Vercel connection` });
  });

  it("treats a malformed stored entry as unusable and never throws", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stored = { ...project([connectorConfig()]), integrations: { connectors: [connectorConfig({ scopes: [{ alias: "site", projectId: "web1" }] })] } } as never;
    expect(resolveConnectors(stored, { credentialRegistry: setup().registry }, { vercel: vercelConnectorType })).toEqual([]);
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as { reason?: string }).find((line) => line.reason !== undefined)?.reason).toBe("invalid vercel connector configuration: scopes");
  });
});

describe("what the model is offered", () => {
  it("marks every tool read with the read-only hints, and shows no project, team or alias", async () => {
    const { definition, connector } = await resolved();
    const { tools, skipped } = await discoverTools(definition, context(), { connect: connector.connect! });
    expect(skipped).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS]);
    for (const tool of tools) {
      expect(tool.access, tool.name).toBe("read");
      expect(tool.hints, tool.name).toEqual({ readOnlyHint: true, destructiveHint: false });
      const names = Object.keys(tool.inputSchema["properties"] as object);
      for (const hidden of ["projectId", "teamId", "scopeAlias"]) expect(names, tool.name).not.toContain(hidden);
    }
    const props = (name: string) => (tools.find((tool) => tool.name === name)!.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props("list_deployments")["limit"]).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
    expect(props("list_deployments")["target"]).toMatchObject({ enum: ["production", "preview"] });
    expect(props("get_deployment")["deploymentId"]).toMatchObject({ type: "string" });
    expect(props("get_deployment_events")["limit"]).toMatchObject({ minimum: 1, maximum: 200 });
  });

});

describe("running the tools", () => {
  it("lists the project's deployments with the token, and leaves out the creator's email and the commit author's", async () => {
    const { result, api } = await run("list_deployments", { limit: 10 });
    expect(result.status).toBe("SUCCEEDED");
    expect(result.text).toContain("dpl_web1prod");
    expect(result.text).toContain("Fix checkout");
    expect(result.text).toContain("production");
    expect(result.text).not.toContain("dpl_api1prod");
    expect(result.text).not.toContain("dana@example.com");
    expect(api.requests[0]).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}` });
    const url = new URL(api.requests[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.vercel.com/v7/deployments");
    expect(url.searchParams.get("projectId")).toBe("prj_web1");
    expect(url.searchParams.get("limit")).toBe("10");
    expect(url.searchParams.has("teamId")).toBe(false);
  });

  it("filters by target, treating preview as anything that is not production, and shows only the scope's project even when the vendor ignores the filter", async () => {
    const production = await run("list_deployments", { target: "production" });
    expect(new URL(production.api.requests[0]!.url).searchParams.get("target")).toBe("production");
    expect(production.result.text).toContain("dpl_web1prod");
    expect(production.result.text).not.toContain("dpl_web1prev");
    const preview = await run("list_deployments", { target: "preview" });
    expect(preview.result.text).toContain("dpl_web1prev");
    expect(preview.result.text).not.toContain("dpl_web1prod");
    const leaky = await run("list_deployments", {}, { api: fakeVercel({ token: TOKEN, ignoreProjectFilter: true }) });
    expect(leaky.result.text).toContain("dpl_web1prod");
    expect(leaky.result.text).not.toContain("dpl_api1prod");
  });

  it("adds the team id to every request when the connection has one, and to none when it has not", async () => {
    for (const [tool, args] of [["list_deployments", {}], ["get_deployment", { deploymentId: "dpl_web1prod" }], ["get_deployment_events", { deploymentId: "dpl_web1prod" }]] as const) {
      const withTeam = await run(tool, args, { teamId: TEAM });
      expect(withTeam.result.status, tool).toBe("SUCCEEDED");
      expect(withTeam.api.requests.length, tool).toBeGreaterThan(0);
      for (const request of withTeam.api.requests) expect(new URL(request.url).searchParams.get("teamId"), `${tool} ${request.url}`).toBe(TEAM);
      const without = await run(tool, args);
      for (const request of without.api.requests) expect(new URL(request.url).searchParams.has("teamId"), tool).toBe(false);
    }
  });

  it("reads a deployment of the scope's project, and refuses one of another project", async () => {
    const own = await run("get_deployment", { deploymentId: "dpl_web1prev" });
    expect(own.result.status).toBe("SUCCEEDED");
    expect(own.result.text).toContain("ERROR");
    expect(own.result.text).toContain("Build failed");
    expect(own.result.text).not.toContain("dana@example.com");
    expect(new URL(own.api.requests[0]!.url).pathname).toBe("/v13/deployments/dpl_web1prev");
    const other = await run("get_deployment", { deploymentId: "dpl_api1prod" });
    expect(other.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that deployment is not in site" });
    const missing = await run("get_deployment", { deploymentId: "dpl_nothere" });
    expect(missing.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Vercel has no such deployment" });
  });

  it("reads a deployment's build events after confirming its project, newest last, and fetches none for another project's", async () => {
    const own = await run("get_deployment_events", { deploymentId: "dpl_web1prod", limit: 50 });
    expect(own.result.status).toBe("SUCCEEDED");
    expect(own.result.text).toContain("npm run build");
    expect(own.result.text).toContain("Error: boom in build");
    // Oldest first, though Vercel answers the newest first for direction=backward.
    expect(own.result.text.indexOf("npm run build")).toBeLessThan(own.result.text.indexOf("compiled with a warning"));
    expect(own.result.text.indexOf("compiled with a warning")).toBeLessThan(own.result.text.indexOf("Error: boom in build"));
    expect(own.api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/v13/deployments/dpl_web1prod", "/v3/deployments/dpl_web1prod/events"]);
    expect(new URL(own.api.requests[1]!.url).searchParams.get("limit")).toBe("50");
    const other = await run("get_deployment_events", { deploymentId: "dpl_api1prod" });
    expect(other.result).toMatchObject({ status: "FAILED", reason: "policy_denied", text: "that deployment is not in site" });
    expect(other.api.requests.map((request) => new URL(request.url).pathname)).toEqual(["/v13/deployments/dpl_api1prod"]);
  });

  it("refuses a deployment id that could change the path or be a hostname, making no request", async () => {
    const r = await resolved();
    const connection = await r.connector.connect!({ endpoint: r.definition.endpoint, token: TOKEN, tools: [...TOOLS], signal: AbortSignal.timeout(5_000) });
    const routing = { scopeAlias: "site", projectId: "prj_web1", teamId: "" };
    for (const deploymentId of ["../user", "dpl_x/events", "web-abc.vercel.app", "", "dpl_" + "a".repeat(65), "dpl_a?teamId=other"]) {
      expect((await connection.call("get_deployment", { ...routing, deploymentId })).isError, deploymentId).toBe(true);
    }
    expect(textOf(await connection.call("list_deployments", { ...routing, limit: 21 }))).toBe("list_deployments: limit is not allowed");
    expect(textOf(await connection.call("list_deployments", { ...routing, target: "staging" }))).toBe("list_deployments: target is not allowed");
    expect(textOf(await connection.call("list_deployments", { ...routing, projectId: "prj_api1", limit: 5 }))).not.toBe("");
    expect(r.api.requests.filter((request) => new URL(request.url).searchParams.get("projectId") === "prj_api1" && false)).toEqual([]);
  });

  it("answers a refused token, a missing deployment and an outage in fixed words, carrying nothing the vendor sent", async () => {
    const wrong = await run("list_deployments", {}, { api: fakeVercel({ token: "vercel-another-token-0123456789" }) });
    expect(wrong.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Vercel refused the token. Check that it is a valid access token for this team and can read deployments." });
    const down = await run("list_deployments", {}, { api: fakeVercel({ token: TOKEN, status: 503 }) });
    expect(down.result).toMatchObject({ status: "FAILED", reason: "vendor_error", text: "Vercel answered HTTP 503" });
    const limited = await run("list_deployments", {}, { api: fakeVercel({ token: TOKEN, status: 429 }) });
    expect(limited.result.text).toBe("Vercel is limiting requests; try again later");
    expect(JSON.stringify([wrong.result, down.result, limited.result])).not.toMatch(/Not authorized|fake outage/u);
  });
});

describe("the Vercel connection check", () => {
  async function checkWith(api: ReturnType<typeof fakeVercel>, teamId?: string) {
    const s = await connected(teamId);
    const store = new OrgConnectionStore({ ...s.deps, checkEndpoint: async () => undefined, fetch: routeFetch(api.handler), checks: { vercel: vercelConnectionCheck } });
    return { store, api };
  }

  it("asks for the user with the token at api.vercel.com", async () => {
    const { store, api } = await checkWith(fakeVercel({ token: TOKEN }));
    expect(await store.check(ORG_A, CON)).toEqual({ ok: true });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: "GET", authorization: `Bearer ${TOKEN}` });
    expect(new URL(api.requests[0]!.url).origin + new URL(api.requests[0]!.url).pathname).toBe("https://api.vercel.com/v2/user");
    expect((await store.get(ORG_A, CON))?.lastCheck).toMatchObject({ ok: true });
  });

  it("adds the connection's team id to the check, and none without one", async () => {
    const team = await checkWith(fakeVercel({ token: TOKEN }), TEAM);
    expect(await team.store.check(ORG_A, CON)).toEqual({ ok: true });
    expect(new URL(team.api.requests[0]!.url).searchParams.get("teamId")).toBe(TEAM);
    const none = await checkWith(fakeVercel({ token: TOKEN }));
    await none.store.check(ORG_A, CON);
    expect(new URL(none.api.requests[0]!.url).searchParams.has("teamId")).toBe(false);
  });

  it("says Vercel refused the token, and answers an outage as retryable without recording a check", async () => {
    const bad = await checkWith(fakeVercel({ token: "vercel-another-token-0123456789" }));
    expect(await bad.store.check(ORG_A, CON)).toEqual({ ok: false, message: "Vercel refused the token. Check that it is a valid access token for this team and can read deployments." });
    const down = await checkWith(fakeVercel({ token: TOKEN, status: 503 }));
    const refusal = await down.store.check(ORG_A, CON).then(() => undefined, (error: { code?: string }) => error);
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await down.store.get(ORG_A, CON))?.lastCheck).toBeUndefined();
  });
});
