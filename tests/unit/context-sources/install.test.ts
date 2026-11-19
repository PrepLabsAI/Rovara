// What the install passes to the context-source builders: the operator's settings are read once and fail closed (ranges, the install's own network, the MCP host's address and token), and the
// builders keep the rules a shared install needs unless a single-owner install says otherwise.
import { describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { installContextSources, privateMcpInstallConfig } from "../../../packages/broker/src/context-sources/install.js";
import { createContextSourceOwnerDependencies } from "../../../packages/broker/src/context-sources/wiring.js";
import { contextToolsDependencies } from "../../../packages/broker/src/local/app/context-tools.js";
import { confirmSourceChange, proposeSourceChange, toolSchemaHash } from "../../../packages/broker/src/context-sources/settings.js";
import { InMemoryConnectionSecrets, memoryStore } from "../../support/connection-fakes.js";
import { NOW, ORG, SEARCH_TOOL, source } from "./fixtures.js";

const HOST_TOKEN = ["h", "o", "s", "t"].join("").padEnd(40, "x");

describe("the install's MCP settings", () => {
  it("no setting means no private ranges, no package-run servers and no host", () => {
    expect(privateMcpInstallConfig({})).toEqual({ privateCidrs: [], rovaraCidrs: [], stdioEnabled: false });
  });

  it("reads the private ranges from ROVARA_PRIVATE_MCP_CIDRS and keeps package-run servers off unless the value is exactly 1", () => {
    expect(privateMcpInstallConfig({ ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16, 192.168.4.0/24", ROVARA_VPC_CIDRS: "10.42.0.0/16" })).toMatchObject({ privateCidrs: ["10.1.0.0/16", "192.168.4.0/24"], rovaraCidrs: ["10.42.0.0/16"], stdioEnabled: false });
    for (const value of ["true", "yes", "0", "", "1 "]) expect(privateMcpInstallConfig({ ROVARA_STDIO_MCP_SERVERS: value, MCP_HOST_URL: "https://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN }).stdioEnabled, value).toBe(false);
  });

  it("a range outside the private networks stops the install and never widens it", () => {
    for (const cidr of ["8.8.8.0/24", "0.0.0.0/0", "169.254.0.0/16", "not-a-range"]) expect(() => privateMcpInstallConfig({ ROVARA_PRIVATE_MCP_CIDRS: cidr, ROVARA_VPC_CIDRS: "10.42.0.0/16" }), cidr).toThrow(/ROVARA_PRIVATE_MCP_CIDRS/u);
  });

  it("private ranges without the install's own network stop it, since the overlap could not be checked", () => {
    for (const vpc of [undefined, "", "  "]) {
      expect(() => privateMcpInstallConfig({ ROVARA_PRIVATE_MCP_CIDRS: "10.1.0.0/16", ...(vpc === undefined ? {} : { ROVARA_VPC_CIDRS: vpc }) }), String(vpc)).toThrow(/ROVARA_VPC_CIDRS/u);
    }
    expect(privateMcpInstallConfig({})).toMatchObject({ privateCidrs: [] });
  });

  it("a private range that overlaps the install's own network stops it, and so does a network that is not a list of ranges", () => {
    const base = { ROVARA_VPC_CIDRS: "10.42.0.0/16" };
    expect(privateMcpInstallConfig({ ...base, ROVARA_PRIVATE_MCP_CIDRS: "10.43.0.0/16" })).toMatchObject({ rovaraCidrs: ["10.42.0.0/16"], privateCidrs: ["10.43.0.0/16"] });
    for (const cidr of ["10.0.0.0/8", "10.42.0.0/16", "10.42.9.0/24"]) expect(() => privateMcpInstallConfig({ ...base, ROVARA_PRIVATE_MCP_CIDRS: cidr }), cidr).toThrow(/overlaps the network Rovara/u);
    expect(() => privateMcpInstallConfig({ ROVARA_VPC_CIDRS: "nonsense" })).toThrow(/ROVARA_VPC_CIDRS/u);
  });

  it("package-run servers switched on need the host's address and token, and the address must be https", () => {
    const on = { ROVARA_STDIO_MCP_SERVERS: "1" };
    expect(() => privateMcpInstallConfig(on)).toThrow(/MCP_HOST_URL/u);
    expect(() => privateMcpInstallConfig({ ...on, MCP_HOST_URL: "https://mcp-host.example.net" })).toThrow(/MCP_HOST_TOKEN/u);
    expect(() => privateMcpInstallConfig({ ...on, MCP_HOST_URL: "http://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN })).toThrow(/https/u);
    expect(() => privateMcpInstallConfig({ ...on, MCP_HOST_URL: "mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN })).toThrow(/web address/u);
    expect(privateMcpInstallConfig({ ...on, MCP_HOST_URL: "https://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN })).toEqual({ privateCidrs: [], rovaraCidrs: [], stdioEnabled: true, mcpHost: { url: "https://mcp-host.example.net", token: HOST_TOKEN } });
  });

  it("an http:// host address is refused even while package-run servers are off, so a later switch-on cannot send the token in clear", () => {
    expect(() => privateMcpInstallConfig({ MCP_HOST_URL: "http://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN })).toThrow(/https/u);
    // only this machine's loopback may use http (a test host never leaves it)
    expect(privateMcpInstallConfig({ MCP_HOST_URL: "http://127.0.0.1:8080", MCP_HOST_TOKEN: HOST_TOKEN }).mcpHost).toEqual({ url: "http://127.0.0.1:8080", token: HOST_TOKEN });
  });

  it("a host address given without its token is not half-used, and an error names the setting, never the token", () => {
    expect(() => privateMcpInstallConfig({ MCP_HOST_URL: "https://mcp-host.example.net" })).toThrow(/MCP_HOST_TOKEN/u);
    let message = "";
    try { privateMcpInstallConfig({ MCP_HOST_URL: "http://mcp-host.example.net", MCP_HOST_TOKEN: HOST_TOKEN }); } catch (error) { message = String(error); }
    expect(message).toContain("MCP host");
    expect(message).not.toContain(HOST_TOKEN);
  });
});

function build(over: { env?: Record<string, string>; ownerConfirmsOwn?: boolean; requireAuthority?: () => Promise<void> } = {}) {
  const store = memoryStore();
  const secrets = new InMemoryConnectionSecrets("local");
  return installContextSources({
    env: over.env ?? {}, connections: { store, env: "local", secrets, now: () => NOW }, store, now: () => NOW,
    requireAuthority: over.requireAuthority ?? (async () => undefined), ...(over.ownerConfirmsOwn === undefined ? {} : { ownerConfirmsOwn: over.ownerConfirmsOwn }),
  });
}

describe("the builders keep the rules of a shared install unless one owner decides", () => {
  const admin = (id: string) => ({ orgId: ORG, developerId: id, orgRole: "admin" });

  it("by default the person who proposed a change that carries reasons cannot confirm it: a second person must", async () => {
    const owner = build().owner.contextSources;
    expect(owner.ownerConfirmsOwn).toBeUndefined();
    // The shared builder, called without the option, says the same.
    expect(createContextSourceOwnerDependencies({ store: memoryStore(), now: () => NOW, connections: { read: async () => undefined, token: async () => undefined }, serverSecrets: { put: async () => "v", read: async () => undefined, remove: async () => undefined } }).ownerConfirmsOwn).toBeUndefined();
  });

  it("a single-owner install turns it on, and only then may one person confirm their own proposal", async () => {
    expect(build({ ownerConfirmsOwn: true }).owner.contextSources.ownerConfirmsOwn).toBe(true);
    expect(build({ ownerConfirmsOwn: false }).owner.contextSources.ownerConfirmsOwn).toBeUndefined();
  });

  it("the second-person rule holds through the shared builder's own store and rules", async () => {
    const shared = build().owner.contextSources;
    // A source that asks to be sent code on a vendor connection carries a reason; with the shared default the proposer may not confirm it.
    const withTool = { ...shared, env: { ...shared.env, connection: async () => ({ type: "mcp", access: "read" as const }), discoverTools: async () => [SEARCH_TOOL] } };
    const change = await proposeSourceChange(withTool, admin("dev1"), "proj", { kind: "set", source: source({ sendCodeSnippets: true, tools: [{ upstreamName: SEARCH_TOOL.name, role: "search", schemaHash: toolSchemaHash(SEARCH_TOOL) }] }) });
    expect(change.secondAdminReasons.join(" ")).toMatch(/receive code/);
    await expect(confirmSourceChange(withTool, admin("dev1"), "proj", change.changeId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await confirmSourceChange(withTool, admin("dev2"), "proj", change.changeId)).sources).toHaveLength(1);
  });
});

describe("the per-request authority hook is required", () => {
  it("an install cannot be built without it (a build that forgets it does not compile)", () => {
    // @ts-expect-error requireAuthority is required: a host that forgets it does not compile
    const forgot = () => installContextSources({ env: {}, connections: { store: memoryStore(), env: "local", secrets: new InMemoryConnectionSecrets("local"), now: () => NOW }, store: memoryStore(), now: () => NOW });
    expect(typeof forgot).toBe("function");
  });

  it("is what the stage routes ask on every request, and a refusal stops the request", async () => {
    let asked = 0;
    const refusing = async () => { asked += 1; throw agentXError("FORBIDDEN", "this person no longer has this task"); };
    const install = build({ requireAuthority: refusing });
    const deps = contextToolsDependencies({ store: memoryStore() }, install.runtime, () => NOW);
    await expect(deps.requireAuthority({ orgId: ORG, task: { taskId: "t", project: "p" }, operation: { id: "o", workflowMode: "PLAN" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(asked).toBe(1);
  });
});
