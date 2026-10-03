// Spec 055: the generic binder, the declarative ownership guard, the endpoint address check and the
// configurable auth header. Linear's guard is an ownership rule too; gateway-linear.test.ts covers it.
import { describe, expect, it, vi } from "vitest";
import { McpConnectorSchema, type McpConnectorConfig, type OwnershipRule } from "../../packages/contracts/src/index.js";
import {
  CredentialUnavailable, EndpointRefused, GuardRejection, checkEndpointAddresses, connectMcp, executeTool, genericBinder,
  isPublicAddress, mcpConnector, ownershipGuard, ownershipGuardedTools, reviewTools, type Invocation, type Ledger, type McpToolResult,
} from "../../packages/gateway/src/index.js";

const text = (value: unknown): McpToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

describe("generic binder", () => {
  it("binds required and optional arguments from named scope values", () => {
    const binder = genericBinder<Record<string, string>>({ required: { org: "organizationSlug" }, optional: { region: "region", regionId: "region" } });
    expect(binder).toMatchObject({ properties: ["org"], optionalProperties: ["region", "regionId"] });
    expect(binder.bind({ alias: "acme", organizationSlug: "acme", region: "us" }, { token: "t", bindings: {} })).toEqual({ org: "acme", region: "us", regionId: "us" });
  });

  it("declares no optional properties when there are none", () => {
    expect(genericBinder({ required: { cloudId: "cloudId" } }).optionalProperties).toBeUndefined();
    expect(genericBinder({})).toMatchObject({ properties: [] });
  });
});

/** A Notion-like rule: pages live under a parent page; tasks[] items name pages too. */
const PAGES: OwnershipRule = {
  mode: "ownership", itemNoun: "page",
  references: { get_page: ["pageId"], update_pages: ["pages[].pageId", "pages[].moveTo"], link_pages: ["links[]"] },
  lookup: { tool: "fetch", argument: "id", arguments: { format: "json" } },
  field: "ancestors[]", equals: "rootId",
  parent: { field: "parent.id", maxDepth: 2 },
  maxLookups: 4,
  refuse: [{ tools: ["update_pages"], arguments: ["pages[].workspaceId"], message: "This {vendor} connector stays in the {alias} workspace, so {argument} is not allowed on {tool}." }],
  require: [{ tools: ["get_page"], argument: "pageId", message: "Pass pageId." }],
};
const names = { vendor: "Notion", scopeNoun: "workspace" };
const scope = { alias: "eng", rootId: "ROOT" };

/** fetch answers each page from `pages`; "error" and "garbage" stand for a failed and an unreadable answer. */
function pagesConnection(pages: Record<string, unknown>) {
  return {
    call: vi.fn(async (_name: string, args: Record<string, unknown>): Promise<McpToolResult> => {
      const page = pages[String(args.id)];
      if (page === undefined || page === "error") return { isError: true, content: [] };
      if (page === "garbage") return { content: [{ type: "text", text: "<html>" }] };
      return text(page);
    }),
  };
}

describe("ownership guard", () => {
  const guard = ownershipGuard(PAGES, names);
  const check = (tool: string, args: Record<string, unknown>, connection: ReturnType<typeof pagesConnection>, target: unknown = scope) =>
    guard.check({ tool, arguments: args, bound: {}, scope: target, connection });

  it("asks for the lookup tool only when a call names an item", () => {
    expect(guard.requiredTools("get_page", { pageId: "p1" })).toEqual(["fetch"]);
    expect(guard.requiredTools("update_pages", { pages: [{ title: "x" }] })).toEqual([]);
    expect(guard.requiredTools("update_pages", { pages: [{ pageId: "p1" }] })).toEqual(["fetch"]);
    expect(guard.requiredTools("link_pages", { links: [] })).toEqual([]);
    expect(guard.requiredTools("link_pages", { links: "p1" })).toEqual(["fetch"]);
    expect(guard.requiredTools("search", { q: "x" })).toEqual([]);
  });

  it("reads each item with the lookup's constant arguments and accepts any matching list element", async () => {
    const connection = pagesConnection({ p1: { ancestors: ["OTHER", "ROOT"] } });
    await expect(check("get_page", { pageId: "p1" }, connection)).resolves.toBeUndefined();
    expect(connection.call).toHaveBeenCalledWith("fetch", { format: "json", id: "p1" });
  });

  it("walks parents up to maxDepth, reading a shared parent once", async () => {
    const connection = pagesConnection({ p1: { ancestors: [], parent: { id: "p2" } }, p3: { ancestors: [], parent: { id: "p2" } }, p2: { ancestors: ["ROOT"] } });
    await expect(check("update_pages", { pages: [{ pageId: "p1" }, { pageId: "p3" }] }, connection)).resolves.toBeUndefined();
    expect(connection.call.mock.calls.map(([, args]) => args.id)).toEqual(["p1", "p2", "p3"]);
    const deep = pagesConnection({ a: { ancestors: [], parent: { id: "b" } }, b: { ancestors: [], parent: { id: "c" } }, c: { ancestors: [], parent: { id: "d" } }, d: { ancestors: ["ROOT"] } });
    await expect(check("get_page", { pageId: "a" }, deep)).rejects.toThrow(new GuardRejection('Notion page "a" is not in the eng workspace this connector may use.'));
  });

  it("refuses an item in another scope, without a parent, a missing one and an unreadable answer", async () => {
    await expect(check("get_page", { pageId: "p1" }, pagesConnection({ p1: { ancestors: ["OTHER"] } }))).rejects.toThrow(new GuardRejection('Notion page "p1" is not in the eng workspace this connector may use.'));
    await expect(check("get_page", { pageId: "p1" }, pagesConnection({ p1: { ancestors: ["OTHER"], parent: null } }))).rejects.toThrow(new GuardRejection('Notion page "p1" is not in the eng workspace this connector may use.'));
    await expect(check("get_page", { pageId: "p1" }, pagesConnection({}))).rejects.toThrow(new GuardRejection('Notion page "p1" was not found or this connector cannot see it.'));
    await expect(check("get_page", { pageId: "p1" }, pagesConnection({ p1: "garbage" }))).rejects.toThrow(new GuardRejection('Could not confirm that Notion page "p1" is in the eng workspace, so the request was not sent.'));
    await expect(check("get_page", { pageId: "p1" }, pagesConnection({ p1: { title: "no ancestors field" } }))).rejects.toThrow(new GuardRejection('Could not confirm that Notion page "p1" is in the eng workspace, so the request was not sent.'));
    await expect(check("get_page", { pageId: "p1" }, pagesConnection({ p1: { ancestors: [], parent: { id: 7 } } }))).rejects.toThrow(GuardRejection);
  });

  it("compares case-sensitively unless the rule says otherwise, and never merges IDs that differ in case", async () => {
    await expect(check("get_page", { pageId: "p1" }, pagesConnection({ p1: { ancestors: ["root"] } }))).rejects.toThrow(GuardRejection);
    const connection = pagesConnection({ p1: { ancestors: ["ROOT"] }, P1: { ancestors: ["OTHER"] } });
    await expect(check("link_pages", { links: ["p1", "P1"] }, connection)).rejects.toThrow(new GuardRejection('Notion page "P1" is not in the eng workspace this connector may use.'));
    const insensitive = ownershipGuard({ ...PAGES, caseInsensitive: true }, names);
    await expect(insensitive.check({ tool: "get_page", arguments: { pageId: "p1" }, bound: {}, scope, connection: pagesConnection({ p1: { ancestors: ["root"] } }) })).resolves.toBeUndefined();
  });

  it("refuses a malformed reference before any lookup", async () => {
    const connection = pagesConnection({});
    for (const args of [{ links: "p1" }, { links: ["p1", 7] }, { links: [""] }, { links: ["x".repeat(129)] }]) {
      await expect(check("link_pages", args, connection)).rejects.toThrow(new GuardRejection("Invalid Notion page ID."));
    }
    await expect(check("update_pages", { pages: "p1" }, connection)).rejects.toThrow(new GuardRejection("Invalid Notion page ID."));
    await expect(check("update_pages", { pages: [{ pageId: { id: "p1" } }] }, connection)).rejects.toThrow(new GuardRejection("Invalid Notion page ID."));
    expect(connection.call).not.toHaveBeenCalled();
  });

  it("caps references and lookups, parents included", async () => {
    const many = pagesConnection({});
    await expect(check("link_pages", { links: ["a", "b", "c", "d", "e"] }, many)).rejects.toThrow(new GuardRejection("This Notion request references more than 4 pages, so it was not sent."));
    expect(many.call).not.toHaveBeenCalled();
    const chain = pagesConnection({ a: { ancestors: [], parent: { id: "x" } }, b: { ancestors: [], parent: { id: "y" } }, x: { ancestors: ["ROOT"] }, y: { ancestors: ["ROOT"] }, c: { ancestors: ["ROOT"] } });
    await expect(check("link_pages", { links: ["a", "b", "c"] }, chain)).rejects.toThrow(new GuardRejection("This Notion request needs more than 4 page checks. Split it into smaller requests."));
  });

  it("applies refuse and require rules with their messages, before any lookup", async () => {
    const connection = pagesConnection({ p1: { ancestors: ["ROOT"] } });
    await expect(check("update_pages", { pages: [{ pageId: "p1", workspaceId: "w2" }] }, connection))
      .rejects.toThrow(new GuardRejection("This Notion connector stays in the eng workspace, so pages[].workspaceId is not allowed on update_pages."));
    await expect(check("get_page", {}, connection)).rejects.toThrow(new GuardRejection("Pass pageId."));
    expect(connection.call).not.toHaveBeenCalled();
  });

  it("fails closed without a usable scope, and ignores tools it does not name", async () => {
    const connection = pagesConnection({ p1: { ancestors: ["ROOT"] } });
    // Called directly: check() would turn an explicit undefined scope into its default.
    for (const target of [undefined, { alias: "eng" }, { alias: "", rootId: "ROOT" }, { alias: "eng", rootId: "" }]) {
      await expect(guard.check({ tool: "get_page", arguments: { pageId: "p1" }, bound: {}, scope: target, connection }))
        .rejects.toThrow(new GuardRejection("The Notion workspace check could not run, so the request was not sent."));
    }
    await expect(guard.check({ tool: "search", arguments: { q: "x" }, bound: {}, scope: undefined, connection })).resolves.toBeUndefined();
    expect(connection.call).not.toHaveBeenCalled();
  });

  it("declares the tools it guards and the arguments that name an item", () => {
    expect(ownershipGuardedTools(PAGES)).toEqual({ tools: ["get_page", "update_pages", "link_pages"], targetArguments: ["pageId", "pages", "links"] });
    expect(ownershipGuardedTools({ ...PAGES, targetArguments: ["pageId"] }).targetArguments).toEqual(["pageId"]);
  });
});

describe("endpoint addresses", () => {
  it.each([
    ["93.184.215.14", true], ["2606:4700::6810:84e5", true],
    ["127.0.0.1", false], ["10.1.2.3", false], ["172.20.0.1", false], ["192.168.1.1", false], ["169.254.169.254", false],
    ["100.64.0.1", false], ["0.0.0.0", false], ["224.0.0.1", false], ["255.255.255.255", false],
    ["::1", false], ["::", false], ["fd00::1", false], ["fe80::1", false], ["ff02::1", false],
    ["::ffff:127.0.0.1", false], ["::ffff:169.254.169.254", false], ["64:ff9b::a9fe:a9fe", false], ["2002:a9fe:a9fe::1", false],
    ["not-an-ip", false],
  ])("%s is public: %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it("refuses an endpoint when any resolved address is not public, and passes a public one", async () => {
    const endpoint = new URL("https://mcp.example.com/mcp");
    await expect(checkEndpointAddresses(endpoint, async () => [{ address: "93.184.215.14" }])).resolves.toBeUndefined();
    const refusal = checkEndpointAddresses(endpoint, async () => [{ address: "93.184.215.14" }, { address: "169.254.169.254" }]);
    await expect(refusal).rejects.toBeInstanceOf(EndpointRefused);
    await expect(refusal).rejects.toBeInstanceOf(CredentialUnavailable);
    await expect(refusal).rejects.toThrow("endpoint host mcp.example.com resolves to 169.254.169.254, which is not a public address, so AgentX does not connect to it");
    // A lookup failure is the vendor being unreachable, not a refusal.
    const unresolved = checkEndpointAddresses(endpoint, async () => { throw new Error("ENOTFOUND"); });
    await expect(unresolved).rejects.not.toBeInstanceOf(EndpointRefused);
    await expect(checkEndpointAddresses(endpoint, async () => [])).rejects.not.toBeInstanceOf(EndpointRefused);
  });
});

describe("auth header", () => {
  /** Captures the first request's headers, then fails it so connectMcp stops. */
  async function headersSent(auth?: { header?: string; prefix?: string }): Promise<Headers> {
    let sent: Headers | undefined;
    const fetchImplementation = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response("nope", { status: 500 });
    });
    await connectMcp({ endpoint: new URL("https://mcp.example.com/mcp"), token: "tok", tools: ["a"], signal: AbortSignal.timeout(5_000), fetchImplementation: fetchImplementation, ...(auth ? { auth } : {}) }).catch(() => undefined);
    return sent!;
  }

  it("sends Authorization: Bearer by default, and the configured header and prefix otherwise", async () => {
    expect((await headersSent()).get("authorization")).toBe("Bearer tok");
    const pagerduty = await headersSent({ prefix: "Token token=" });
    expect(pagerduty.get("authorization")).toBe("Token token=tok");
    const custom = await headersSent({ header: "X-Api-Key", prefix: "" });
    expect(custom.get("x-api-key")).toBe("tok");
    expect(custom.get("authorization")).toBeNull();
    expect(custom.get("x-mcp-tools")).toBe("a");
  });
});

describe("mcp connector definition", () => {
  const config = (overrides: Record<string, unknown> = {}): McpConnectorConfig => McpConnectorSchema.parse({
    name: "notion", type: "mcp", endpoint: "https://mcp.notion.example/mcp", label: "Notion pages", vendor: "Notion", scopeNoun: "workspace",
    credentialRef: "notion-bot", scopes: [{ alias: "eng", values: { rootId: "ROOT", workspace: "w1" } }],
    bind: { required: { workspace: "workspace" } }, scoping: PAGES, tools: [{ name: "get_page", access: "read" }, { name: "update_pages", access: "write" }],
    auth: { header: "X-Api-Key", prefix: "" }, itemArguments: ["pageId"], attributionKeys: ["content"],
    ...overrides,
  });

  it("builds the binder, the ownership guard, auth and item arguments from the configuration", () => {
    const definition = mcpConnector(config(), { issue: vi.fn() });
    expect(definition).toMatchObject({
      label: "Notion", endpoint: new URL("https://mcp.notion.example/mcp"), permissionsHint: "the Notion credential's permissions",
      auth: { header: "X-Api-Key", prefix: "" }, itemArguments: ["pageId"], attributionKeys: ["content"],
      guardedItemTools: { tools: ["get_page", "update_pages", "link_pages"] },
    });
    expect(definition.binder).toMatchObject({ properties: ["workspace"] });
    expect(definition.guards).toHaveLength(1);
    expect(mcpConnector(config({ scoping: { mode: "credential" }, tools: [{ name: "get_page", access: "read" }], auth: undefined }), { issue: vi.fn() }))
      .toMatchObject({ guards: [], permissionsHint: "the Notion credential's permissions" });
    expect(mcpConnector(config({ scoping: { mode: "credential" }, tools: [{ name: "get_page", access: "read" }], auth: undefined }), { issue: vi.fn() }).auth).toBeUndefined();
  });

  function memoryLedger(): Ledger {
    const records = new Map<string, Invocation>();
    return {
      claim: async (record) => { if (records.has(record.requestId)) return false; records.set(record.requestId, record); return true; },
      get: async (id) => records.get(id),
      finish: async (record) => { records.set(record.requestId, record); },
    };
  }
  const tools = [
    { name: "get_page", inputSchema: { type: "object", properties: { pageId: { type: "string" }, workspace: { type: "string" } }, required: ["pageId", "workspace"] } },
    { name: "fetch", inputSchema: { type: "object", properties: { id: { type: "string" }, format: { type: "string" } } } },
  ];
  const context = { workspaceId: "w", ownerKey: "o", scopeAlias: "eng", scope: { alias: "eng", rootId: "ROOT", workspace: "w1" }, policy: { tools: [{ name: "get_page", access: "read" as const }] } };

  it("refuses a private endpoint before issuing a credential or connecting", async () => {
    const issue = vi.fn(async () => ({ token: "secret", bindings: {} }));
    const connect = vi.fn();
    const definition = mcpConnector(config(), { issue }, { lookup: async () => [{ address: "10.0.0.5" }] });
    const result = await executeTool({ requestId: "44444444-4444-4444-8444-444444444444", scope: "eng", tool: "get_page", schemaHash: "x".repeat(64), arguments: { pageId: "p1" } },
      definition, context, { ledger: memoryLedger(), connect: connect as never });
    expect(result).toMatchObject({ status: "FAILED", reason: "not_connected" });
    expect(result.text).toContain("resolves to 10.0.0.5, which is not a public address");
    expect(issue).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("checks ownership, binds the scope value and sends the token in the configured header", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const connect = vi.fn(async () => ({
      tools,
      call: vi.fn(async (name: string, args: Record<string, unknown>) => { calls.push([name, args]); return name === "fetch" ? text({ ancestors: ["ROOT"] }) : text({ ok: true }); }),
      close: async () => undefined,
    }));
    const definition = mcpConnector(config(), { issue: async () => ({ token: "secret", bindings: {} }) }, { lookup: async () => [{ address: "93.184.215.14" }] });
    const reviewed = reviewTools({ tools }, definition, context);
    expect(reviewed.tools[0]!.inputSchema).toMatchObject({ properties: { pageId: { type: "string" } }, required: ["pageId"] });
    const result = await executeTool({ requestId: "55555555-5555-4555-8555-555555555555", scope: "eng", tool: "get_page", schemaHash: reviewed.tools[0]!.schemaHash, arguments: { pageId: "p1" } },
      definition, context, { ledger: memoryLedger(), connect: connect });
    expect(result.status).toBe("SUCCEEDED");
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ token: "secret", auth: { header: "X-Api-Key", prefix: "" }, tools: ["get_page", "fetch"] }));
    expect(calls).toEqual([["fetch", { format: "json", id: "p1" }], ["get_page", { pageId: "p1", workspace: "w1" }]]);
  });
});
