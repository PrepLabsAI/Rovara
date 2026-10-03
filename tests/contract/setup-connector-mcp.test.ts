// Spec 055 phase 3: agentx connector add mcp. The server's own tool list is the test read; the
// engineer approves tools; the credential is pinned to the endpoint's host; the project gets a new
// revision only once the control plane confirms the connector is connected.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthorizeInput } from "../../packages/cli/src/admin/authorize.js";
import { addMcp, MCP_GUIDE, parseToolApprovals, vendorFromHost, type McpAddFlags } from "../../packages/cli/src/setup/connectors/mcp.js";
import { writeProjectFile } from "../../packages/cli/src/setup/project-add.js";
import { memoryInitSecrets, scriptedPrompter } from "../support/init-fakes.js";
import { CONTROL_PLANE, fakeControlPlane, fakeVendors } from "../support/setup-fakes.js";

const KEY = `sntrys_${"k".repeat(160)}`;
const ENDPOINT = "https://mcp.sentry.dev/mcp";
const SECRET_NAME = "agentx/staging/connectors/mcp-sentry";
const FOUNDATION = { Ec2WorkerLaunchTemplateId: "lt-0123456789abcdef0", Ec2WorkerSubnets: "us-east-1a=subnet-0aaa1111bbbb2222c" };
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token" };
let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "agentx-projects-"));
  await writeProjectFile(configDir, {
    name: "payments-api", revision: 1,
    repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate every repository read, edit, build, and test to the remote AgentX worker.",
  });
});
afterEach(async () => { await rm(configDir, { recursive: true, force: true }); });

function input(overrides: {
  script?: Array<string | boolean>; plane?: ReturnType<typeof fakeControlPlane>; vendors?: ReturnType<typeof fakeVendors>; lines?: string[];
  secrets?: ReturnType<typeof memoryInitSecrets>; flags?: McpAddFlags; authorize?: (options: AuthorizeInput) => Promise<unknown>;
} = {}) {
  const plane = overrides.plane ?? fakeControlPlane();
  const secrets = overrides.secrets ?? memoryInitSecrets();
  return {
    env: "staging", session, projectName: "payments-api", secrets,
    prompter: scriptedPrompter(overrides.script ?? []),
    processEnv: { SENTRY_KEY: KEY }, write: (line: string) => { overrides.lines?.push(line); },
    services: {
      fetch: plane.fetch, configDir, stackOutputs: async () => FOUNDATION, vendors: overrides.vendors ?? fakeVendors(),
      authorize: overrides.authorize ?? ((): Promise<unknown> => Promise.reject(new Error("test setup: no sign-in expected"))),
      authorizeSecrets: { read: async (name: string) => secrets.values.get(name), write: async (name: string, value: string) => { secrets.values.set(name, value); }, tag: async () => undefined },
    },
    flags: overrides.flags ?? {},
  };
}

const keyFlags: McpAddFlags = { endpoint: ENDPOINT, auth: "key", key: { envName: "SENTRY_KEY" } };
const registeredConnector = (plane: ReturnType<typeof fakeControlPlane>) =>
  (plane.registered.at(-1) as { definition: { revision: number; integrations: { connectors: Array<Record<string, unknown>> } } }).definition;

describe("agentx connector add mcp: an API key", () => {
  it("lists the server's tools as its test read, approves read-only ones by default, and registers a pinned credential", async () => {
    const plane = fakeControlPlane();
    const vendors = fakeVendors();
    const secrets = memoryInitSecrets();
    const lines: string[] = [];
    // Prompts: the name (default), then the tools (default: the read-only ones).
    const result = await addMcp(input({ plane, vendors, secrets, lines, flags: keyFlags, script: ["", ""] }));
    expect(result).toEqual({ ref: "mcp-sentry", name: "sentry", revision: 2, tools: 1 });
    expect(lines[0]).toBe(MCP_GUIDE);
    expect(lines.join("\n")).toContain("mcp.sentry.dev offers 2 tools:\n    get_issue (read-only): Read an issue\n    update_issue (changes data): Change an issue");
    expect(vendors.mcpCalls).toEqual([{ endpoint: ENDPOINT, token: KEY, auth: undefined }]);
    expect(JSON.parse(secrets.values.get(SECRET_NAME)!)).toEqual({ apiKey: KEY });
    expect(plane.credentials).toContainEqual({ ref: "mcp-sentry", type: "static-secret", secretName: SECRET_NAME, host: "mcp.sentry.dev" });
    const definition = registeredConnector(plane);
    expect(definition.revision).toBe(2);
    expect(definition.integrations.connectors[0]).toEqual({
      name: "sentry", type: "mcp", endpoint: ENDPOINT, vendor: "Sentry", label: "Sentry", credentialRef: "mcp-sentry",
      scopes: [{ alias: "sentry", values: {} }], scoping: { mode: "credential" }, tools: [{ name: "get_issue", access: "read" }],
    });
    const file = await readFile(join(configDir, "payments-api.yaml"), "utf8");
    expect(file).toContain("revision: 2");
    expect(file).not.toContain(KEY);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  it("sends the key in the configured header, and keeps that header on the connector", async () => {
    const plane = fakeControlPlane();
    const vendors = fakeVendors();
    await addMcp(input({ plane, vendors, flags: { ...keyFlags, name: "pd", authHeader: "Authorization", authPrefix: "Token token=", tools: "get_issue" } }));
    expect(vendors.mcpCalls[0]).toMatchObject({ auth: { header: "Authorization", prefix: "Token token=" } });
    expect(registeredConnector(plane).integrations.connectors[0]).toMatchObject({ name: "pd", credentialRef: "mcp-pd", auth: { header: "Authorization", prefix: "Token token=" } });
  });

  it("stores and registers nothing when the server refuses the key", async () => {
    const plane = fakeControlPlane();
    const secrets = memoryInitSecrets();
    await expect(addMcp(input({ plane, secrets, vendors: fakeVendors({ mcpRefuses: true }), flags: { ...keyFlags, name: "sentry" } })))
      .rejects.toThrow("mcp.sentry.dev refused the key; check you copied all of it, that it is not revoked, and the header it goes in (--auth-header, --auth-prefix). Nothing was stored");
    expect(secrets.values.size).toBe(0);
    expect(plane.credentials.some((entry) => entry.ref === "mcp-sentry")).toBe(false);
    expect(plane.registered).toEqual([]);
  });

  it("refuses write tools without an ownership rule unless acknowledged, storing nothing", async () => {
    const secrets = memoryInitSecrets();
    await expect(addMcp(input({ secrets, flags: { ...keyFlags, name: "sentry", tools: "get_issue,update_issue" }, script: [false] })))
      .rejects.toThrow("approve only read tools, or give an ownership rule in --config-file (docs/connectors/custom-mcp.md)");
    expect(secrets.values.size).toBe(0);
    const plane = fakeControlPlane();
    await addMcp(input({ plane, flags: { ...keyFlags, name: "sentry", tools: "get_issue,update_issue", acknowledgeUnscopedWrites: true } }));
    expect(registeredConnector(plane).integrations.connectors[0]).toMatchObject({
      scoping: { mode: "credential", acknowledgeUnscopedWrites: true }, tools: [{ name: "get_issue", access: "read" }, { name: "update_issue", access: "write" }],
    });
  });

  it("takes scopes, bindings and an ownership rule from --config-file, with no acknowledgment needed for its write tools", async () => {
    const plane = fakeControlPlane();
    const configFile = join(configDir, "sentry.json");
    await writeFile(configFile, JSON.stringify({
      scopeNoun: "organization", scopes: [{ alias: "acme", values: { org: "acme" } }], bind: { required: { organizationSlug: "org" } },
      scoping: { mode: "ownership", itemNoun: "issue", references: { update_issue: ["issueId"] }, lookup: { tool: "get_issue", argument: "issueId" }, field: "organization.slug", equals: "org" },
    }));
    await addMcp(input({ plane, flags: { ...keyFlags, name: "sentry", tools: "get_issue,update_issue", configFile } }));
    expect(registeredConnector(plane).integrations.connectors[0]).toMatchObject({
      scopeNoun: "organization", scopes: [{ alias: "acme", values: { org: "acme" } }], bind: { required: { organizationSlug: "org" } },
      scoping: { mode: "ownership", equals: "org" }, tools: [{ name: "get_issue", access: "read" }, { name: "update_issue", access: "write" }],
    });
  });

  it("refuses an invalid --config-file before storing anything", async () => {
    const secrets = memoryInitSecrets();
    const configFile = join(configDir, "bad.json");
    await writeFile(configFile, JSON.stringify({ scoping: { mode: "ownership", itemNoun: "issue", references: {}, lookup: { tool: "get_issue", argument: "id" }, field: "x", equals: "missing" } }));
    await expect(addMcp(input({ secrets, flags: { ...keyFlags, name: "sentry", tools: "get_issue", configFile } }))).rejects.toThrow("the connector is invalid: scoping.references");
    expect(secrets.values.size).toBe(0);
  });

  it("refuses an http endpoint, a bad name, and a name another connector type already uses", async () => {
    await expect(addMcp(input({ flags: { ...keyFlags, endpoint: "http://mcp.sentry.dev/mcp" } }))).rejects.toThrow("--endpoint: endpoint must use https");
    await expect(addMcp(input({ flags: { ...keyFlags, name: "Sentry_Prod" } }))).rejects.toThrow("--name Sentry_Prod: a connector name is lowercase letters");
    const plane = fakeControlPlane();
    await addMcp(input({ plane, flags: { ...keyFlags, name: "linear", tools: "get_issue" } }));
    // The project file now holds an mcp connector named linear; replacing it with another mcp entry is fine.
    await addMcp(input({ plane, flags: { ...keyFlags, name: "linear", tools: "get_issue" } }));
    expect(registeredConnector(plane).integrations.connectors.filter((entry) => entry.name === "linear")).toHaveLength(1);
  });

  it("refuses to reuse a built-in connector's name", async () => {
    const definition = { name: "payments-api", revision: 1, repositories: [{ name: "payments-api", url: "https://github.com/acme/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }], setup: [], readiness: [], orchestratorInstructions: "x",
      integrations: { connectors: [{ name: "linear", type: "linear", credentialRef: "linear", scopes: [{ alias: "pay", teamId: "c408e946-78aa-4db8-923e-f78053dd954f" }], tools: [{ name: "list_issues", access: "read" }] }] } };
    await writeProjectFile(configDir, definition as never);
    const secrets = memoryInitSecrets();
    await expect(addMcp(input({ secrets, flags: { ...keyFlags, name: "linear" } }))).rejects.toThrow("project payments-api already has a linear connector named linear; choose another --name. Nothing was stored");
    expect(secrets.values.size).toBe(0);
  });

  it("does not register a revision the control plane reports as not connected", async () => {
    const plane = fakeControlPlane();
    plane.preflight.sentry = { status: "not_connected", problem: "credential mcp-sentry is not pinned to a host" };
    await expect(addMcp(input({ plane, flags: { ...keyFlags, name: "sentry", tools: "get_issue" } }))).rejects.toThrow("the sentry connector is not_connected: credential mcp-sentry is not pinned to a host");
  });
});

describe("agentx connector add mcp: OAuth", () => {
  const TOKEN_URL = "https://auth.vendor.example/token";
  /** The sign-in as admin/authorize.ts does it: stores the refresh token beside the client and registers the pinned credential. */
  function fakeAuthorize(plane: ReturnType<typeof fakeControlPlane>) {
    const calls: Array<Record<string, unknown>> = [];
    const authorize = async (options: { secrets: { read(n: string): Promise<string | undefined>; write(n: string, v: string): Promise<void> }; secretName: string; ref: string; endpoint?: string; registerClient?: boolean; scope?: string; openBrowser?: unknown; showUrl: (url: string, redirect: string) => void }) => {
      calls.push({ ref: options.ref, endpoint: options.endpoint, registerClient: options.registerClient, scope: options.scope, openBrowser: options.openBrowser });
      options.showUrl("https://auth.vendor.example/authorize?x=1", "(the mcp.vendor.example app's redirect URL must be exactly http://localhost:8765/callback)");
      const app = JSON.parse((await options.secrets.read(options.secretName))!) as Record<string, string>;
      const client = options.registerClient === true ? { clientId: "dyn-client" } : app;
      await options.secrets.write(options.secretName, JSON.stringify({ ...client, refreshToken: "refresh-1" }));
      plane.credentials.push({ ref: options.ref, type: "oauth-refresh-token", secretName: options.secretName, host: "mcp.vendor.example", tokenUrl: TOKEN_URL, resource: options.endpoint!, builtIn: false, tokenCached: false });
      return { registered: true };
    };
    return { calls, authorize };
  }

  it("signs the bot in with a registered client, refreshes once, writes a rotated token back, and lists tools with the access token", async () => {
    const plane = fakeControlPlane();
    const vendors = fakeVendors({ oauthRotates: "refresh-2" });
    const secrets = memoryInitSecrets();
    const lines: string[] = [];
    const signIn = fakeAuthorize(plane);
    const result = await addMcp(input({
      plane, vendors, secrets, lines, authorize: signIn.authorize, script: [""],
      flags: { endpoint: "https://mcp.vendor.example/mcp", auth: "oauth", registerClient: true, scope: "read", tools: "get_issue" },
    }));
    expect(result).toEqual({ ref: "mcp-vendor", name: "vendor", revision: 2, tools: 1 });
    expect(signIn.calls).toEqual([{ ref: "mcp-vendor", endpoint: "https://mcp.vendor.example/mcp", registerClient: true, scope: "read", openBrowser: undefined }]);
    expect(lines.join("\n")).toContain("Open this address in a private window signed in as the bot user:\nhttps://auth.vendor.example/authorize?x=1");
    expect(vendors.mcpCalls).toEqual([
      { refresh: { tokenUrl: TOKEN_URL, clientId: "dyn-client", clientSecret: undefined, refreshToken: "refresh-1", resource: "https://mcp.vendor.example/mcp" } },
      { endpoint: "https://mcp.vendor.example/mcp", token: "mcp-access", auth: undefined },
    ]);
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/mcp-vendor")!)).toEqual({ clientId: "dyn-client", refreshToken: "refresh-2" });
    expect(registeredConnector(plane).integrations.connectors[0]).toMatchObject({ name: "vendor", credentialRef: "mcp-vendor", tools: [{ name: "get_issue", access: "read" }] });
  });

  it("uses an OAuth app's client from the flags, and leaves the project unchanged when the refresh is refused", async () => {
    const plane = fakeControlPlane();
    const signIn = fakeAuthorize(plane);
    const secrets = memoryInitSecrets();
    await expect(addMcp(input({
      plane, secrets, vendors: fakeVendors({ oauthRefuses: true }), authorize: signIn.authorize, script: [""],
      flags: { endpoint: "https://mcp.vendor.example/mcp", auth: "oauth", clientId: "app-1", tools: "get_issue" },
    }))).rejects.toThrow("the token endpoint refused to renew the bot user's sign-in, so the project was not changed");
    expect(signIn.calls[0]).toMatchObject({ registerClient: undefined });
    expect(JSON.parse(secrets.values.get("agentx/staging/connectors/mcp-vendor")!)).toEqual({ clientId: "app-1", refreshToken: "refresh-1" });
    expect(plane.registered).toEqual([]);
  });
});

describe("connector add mcp helpers", () => {
  it("names the vendor from the endpoint's host", () => {
    expect(vendorFromHost("mcp.sentry.dev")).toBe("Sentry");
    expect(vendorFromHost("mcp.eu.pagerduty.com")).toBe("Pagerduty");
    expect(vendorFromHost("api.example.co")).toBe("Example");
  });

  it("parses approvals, defaulting access from the server's read-only hint", () => {
    const offered = [{ name: "a", description: "", readOnly: true }, { name: "b", description: "" }, { name: "c", description: "", readOnly: false }];
    expect(parseToolApprovals("a, b, c:read, a", offered)).toEqual([{ name: "a", access: "read" }, { name: "b", access: "write" }, { name: "c", access: "read" }]);
    expect(() => parseToolApprovals("d", offered)).toThrow("the server offers no tool d; it offers a, b, c");
    expect(() => parseToolApprovals("a:admin", offered)).toThrow("tool a:admin must be a name, optionally followed by :read or :write");
    expect(() => parseToolApprovals(" , ", offered)).toThrow("approve at least one tool");
  });
});
