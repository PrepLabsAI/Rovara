// Pi's deferred tool exposure plus tool_search (audit recommendation 1): many approved connector tools no longer stop a turn from starting, the model's first
// request lists few tools, and a deferred tool is found with tool_search and then called through the same bridge and the same action gate as before.
// Real Pi turns with the scripted model. Search changes what the model is told, never what it may use.
import { defineTool } from "@earendil-works/pi-coding-agent";
import { PI_BUILT_IN_TOOL_NAMES, MAX_LOADED_DEFERRED_TOOLS, MAX_SEARCH_LIMIT, planToolExposure } from "../../packages/model-runtime/src/index.js";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DEFERRED_TOOLS_ABOVE, TOOL_LIMIT, type ConnectorCatalog } from "../../packages/contracts/src/index.js";
import { createGateSession, type GateSession } from "../../packages/orchestrator/src/action-gate.js";
import { ORCHESTRATION_TOOL_NAMES, RECOVERY_TOOL_NAMES, type OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createOrchestratorRuntime, createPiSessionRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const context = { workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" };
const IN_HOUSE = ORCHESTRATION_TOOL_NAMES.filter((name) => !(RECOVERY_TOOL_NAMES as readonly string[]).includes(name));
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const offered = (input: TranscriptContext) => getCurrentTools(input.messages).map((tool) => tool.name).sort();

/** A connector with `count` approved tools: `tracker__tool_0`..., each described by its own distinctive word, and one write tool that always asks. */
function manyTools(count: number, connector = "tracker"): ConnectorCatalog {
  const words = ["invoice", "customer", "sprint", "roadmap", "incident", "deployment", "calendar", "budget", "release", "ticket"];
  return {
    connector, skipped: [],
    tools: [
      ...Array.from({ length: count - 1 }, (_, index) => ({
        name: `${connector}__tool_${index}`, upstreamName: `tool_${index}`, description: `Read the ${words[index % words.length]} number ${index} (${connector}).`, access: "read" as const,
        hints: { readOnlyHint: true, destructiveHint: false }, itemArguments: [],
        scopes: [{ alias: "payments", schemaHash: "a".repeat(64) }], inputSchema: { type: "object", properties: { id: { type: "string" } }, required: [] },
      })),
      { name: `${connector}__close_item`, upstreamName: "close_item", description: "Close an item for good.", access: "write" as const, hints: { readOnlyHint: false, destructiveHint: true }, itemArguments: ["id"],
        scopes: [{ alias: "payments", schemaHash: "c".repeat(64) }], inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    ],
  };
}

/** `total` approved tools spread over connectors of 30 tools or fewer (a project's real approvals are 32 per connector at most), the first one named `tracker`. */
function manyCatalogs(total: number): ConnectorCatalog[] {
  return Array.from({ length: Math.ceil(total / 30) }, (_, index) => manyTools(Math.min(30, total - index * 30), index === 0 ? "tracker" : `tracker${String(index + 1)}`));
}

function results(messages: readonly unknown[]) {
  return messages.flatMap((message) => {
    const entry = message as { role?: string; toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> };
    return entry.role === "toolResult" ? [{ tool: entry.toolName, isError: entry.isError, text: (entry.content ?? []).map((block) => block.text ?? "").join("") }] : [];
  });
}

async function runtimeWith(approved: ConnectorCatalog | ConnectorCatalog[], options: { script?: Parameters<Awaited<ReturnType<typeof fauxModelRuntime>>["faux"]["setResponses"]>[0]; session?: GateSession; stateDirectory?: string; sessionFile?: string } = {}) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  if (options.script !== undefined) faux.setResponses(options.script);
  const catalogs = Array.isArray(approved) ? approved : [approved];
  const callConnectorTool = vi.fn(async (input: { tool: string }) => ({ requestId: "33333333-3333-4333-8333-333333333333", status: "SUCCEEDED", text: `ran ${input.tool}`, truncated: false, replayed: false }));
  const api = {
    discoverConnectorTools: vi.fn(async ({ connector }: { connector: string }) => catalogs.find((entry) => entry.connector === connector)!), callConnectorTool,
    submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn(),
  } satisfies OrchestrationApi;
  const stateDirectory = options.stateDirectory ?? await createFixtureDirectory("agentx-deferred-");
  const create = () => createOrchestratorRuntime({
    stateDirectory, projectInstructions: "Delegate.", api, context, modelRuntime, model: FAUX_MODEL,
    connectors: catalogs.map(({ connector }) => ({ name: connector, type: "tracker", label: connector, scopes: ["payments"], connected: true })),
    ...(options.session === undefined ? {} : { actionGate: { session: options.session } }),
    ...(options.sessionFile === undefined ? {} : { sessionFile: options.sessionFile }),
  });
  return { create, callConnectorTool, faux, stateDirectory };
}

describe("many approved connector tools", () => {
  it("starts with 60 approved tools, where it used to refuse more than 40", async () => {
    const { create } = await runtimeWith(manyCatalogs(60));
    const runtime = await create();
    try {
      expect(runtime.session.getActiveToolNames().sort()).toEqual([...IN_HOUSE, "tool_search"].sort());
    } finally { await runtime.dispose(); }
  });

  it("starts with 60 approved tools spread over three connectors, and finds and calls one of the third", async () => {
    const { create, callConnectorTool } = await runtimeWith([manyTools(20, "alpha"), manyTools(20, "beta"), manyTools(20, "gamma")], { script: [
      toolUse(fauxToolCall("tool_search", { query: "gamma roadmap" })),
      toolUse(fauxToolCall("gamma__tool_3", {})),
      fauxAssistantMessage([fauxText("Read.")]),
    ] });
    const runtime = await create();
    try {
      expect(runtime.session.getActiveToolNames().sort()).toEqual([...IN_HOUSE, "tool_search"].sort());
      await runOrchestratorTurn(runtime, "read the gamma roadmap");
    } finally { await runtime.dispose(); }
    expect(callConnectorTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ connector: "gamma", tool: "tool_3" }));
  });

  it("lists few tools in the model's first request: the in-house tools and tool_search, no connector tool", async () => {
    let first: string[] = [];
    const { create } = await runtimeWith(manyCatalogs(60), { script: [(input) => { first = offered(input); return fauxAssistantMessage([fauxText("Nothing to do.")]); }] });
    const runtime = await create();
    try { await runOrchestratorTurn(runtime, "hello"); } finally { await runtime.dispose(); }
    expect(first).toEqual([...IN_HOUSE, "tool_search"].sort());
    expect(first.length).toBeLessThanOrEqual(IN_HOUSE.length + 1);
    expect(first.some((name) => name.startsWith("tracker__"))).toBe(false);
  });

  it("tells the model that tool_search loads the rest", async () => {
    const { create } = await runtimeWith(manyCatalogs(60));
    const runtime = await create();
    try { expect(runtime.session.systemPrompt).toContain("tool_search"); } finally { await runtime.dispose(); }
  });

  it("keeps every tool declared when there are few, exactly as before", async () => {
    const { create } = await runtimeWith(manyTools(DEFERRED_TOOLS_ABOVE));
    const runtime = await create();
    try {
      const names = runtime.session.getActiveToolNames();
      expect(names).not.toContain("tool_search");
      expect(names).toContain("tracker__tool_0");
      expect(runtime.session.systemPrompt).not.toContain("tool_search");
    } finally { await runtime.dispose(); }
  });

  it("still refuses a project above the sanity limit", async () => {
    const { create } = await runtimeWith(manyCatalogs(TOOL_LIMIT + 1));
    await expect(create()).rejects.toMatchObject({ code: "CONFIG_INVALID", message: expect.stringContaining(`at most ${TOOL_LIMIT}`) as string });
  });
});

describe("a deferred tool", () => {
  it("is found with tool_search, declared from the next request, and called through the broker bridge", async () => {
    const seen: string[][] = [];
    const { create, callConnectorTool } = await runtimeWith(manyCatalogs(60), { script: [
      (input) => { seen.push(offered(input)); return toolUse(fauxToolCall("tool_search", { query: "incident" })); },
      (input) => { seen.push(offered(input)); return toolUse(fauxToolCall("tracker__tool_4", { id: "INC-1" })); },
      fauxAssistantMessage([fauxText("Read it.")]),
    ] });
    const runtime = await create();
    let reply: string | undefined;
    try {
      reply = await runOrchestratorTurn(runtime, "what is the incident?");
      const ran = results(runtime.session.messages);
      expect(ran[0]).toMatchObject({ tool: "tool_search", isError: false });
      expect(ran[0]!.text).toContain("tracker__tool_4");
      expect(ran[1]).toMatchObject({ tool: "tracker__tool_4", isError: false });
    } finally { await runtime.dispose(); }
    expect(reply).toBe("Read it.");
    expect(seen[0]).not.toContain("tracker__tool_4");
    expect(seen[1]).toContain("tracker__tool_4");
    // The call went to the control plane's connector route with the bridge's own request, scope and arguments.
    expect(callConnectorTool).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ connector: "tracker", tool: "tool_4", scope: "payments", schemaHash: "a".repeat(64), arguments: { id: "INC-1" } }));
  });

  it("cannot be called before it is found", async () => {
    const { create, callConnectorTool } = await runtimeWith(manyCatalogs(60), { script: [toolUse(fauxToolCall("tracker__tool_4", { id: "INC-1" })), fauxAssistantMessage([fauxText("Could not.")])] });
    const runtime = await create();
    try {
      await runOrchestratorTurn(runtime, "read the incident");
      const ran = results(runtime.session.messages);
      expect(ran).toHaveLength(1);
      expect(ran[0]).toMatchObject({ tool: "tracker__tool_4", isError: true });
    } finally { await runtime.dispose(); }
    expect(callConnectorTool).not.toHaveBeenCalled();
  });

  it("is not found, and cannot be called, when its connector was not approved for the project", async () => {
    let search = "";
    const { create, callConnectorTool } = await runtimeWith(manyCatalogs(60), { script: [
      toolUse(fauxToolCall("tool_search", { query: "github list issues" })),
      (input) => { search = results(input.messages).at(-1)?.text ?? ""; return toolUse(fauxToolCall("github__list_issues", {})); },
      fauxAssistantMessage([fauxText("Could not.")]),
    ] });
    const runtime = await create();
    try {
      await runOrchestratorTurn(runtime, "list github issues");
      const ran = results(runtime.session.messages);
      expect(ran[1]).toMatchObject({ tool: "github__list_issues", isError: true });
    } finally { await runtime.dispose(); }
    expect(search).toBe("No matching tools found.");
    expect(callConnectorTool).not.toHaveBeenCalled();
  });

  it("stays loaded in the next turn of the same thread", async () => {
    const first = await runtimeWith(manyCatalogs(60), { script: [toolUse(fauxToolCall("tool_search", { query: "incident" })), fauxAssistantMessage([fauxText("Found it.")])] });
    const one = await first.create();
    const sessionFile = one.session.sessionFile;
    try { await runOrchestratorTurn(one, "find incident tools"); } finally { await one.dispose(); }
    let second: string[] = [];
    const next = await runtimeWith(manyCatalogs(60), { stateDirectory: first.stateDirectory, ...(sessionFile === undefined ? {} : { sessionFile }), script: [(input) => { second = offered(input); return fauxAssistantMessage([fauxText("Ok.")]); }] });
    const two = await next.create();
    try { await runOrchestratorTurn(two, "again"); } finally { await two.dispose(); }
    expect(second).toContain("tracker__tool_4");
  });
});

describe("the action gate on a deferred tool", () => {
  it("still decides every call: a destructive deferred tool asks and never reaches the control plane", async () => {
    const session = createGateSession("U0123456789");
    const { create, callConnectorTool } = await runtimeWith(manyCatalogs(60), { session, script: [
      toolUse(fauxToolCall("tool_search", { query: "close item for good" })),
      toolUse(fauxToolCall("tracker__close_item", { id: "TRK-9" })),
      fauxAssistantMessage([fauxText("I asked you to confirm.")]),
    ] });
    const runtime = await create();
    try {
      await runOrchestratorTurn(runtime, "close TRK-9");
      const ran = results(runtime.session.messages);
      expect(ran[0]).toMatchObject({ tool: "tool_search", isError: false });
      expect(ran[1]).toMatchObject({ tool: "tracker__close_item", isError: true });
    } finally { await runtime.dispose(); }
    expect(callConnectorTool).not.toHaveBeenCalled();
    expect(session.asks).toMatchObject([{ tool: "tracker__close_item", kind: "destructive" }]);
    // The search is not an action that ran: a turn that searched and then only asked is still "only asked", so Slack withholds the model's reply (processor.ts).
    expect(session.ran).toBe(0);
    // The search itself is a read: it needed no classifier and asked nothing.
    expect(session.decisions.map((decision) => [decision.tool, decision.outcome])).toEqual([["tool_search", "allow"], ["tracker__close_item", "ask"]]);
  });

  it("runs a deferred read the gate allows, and counts it", async () => {
    const session = createGateSession("U0123456789");
    const { create, callConnectorTool } = await runtimeWith(manyCatalogs(60), { session, script: [
      toolUse(fauxToolCall("tool_search", { query: "incident" })),
      toolUse(fauxToolCall("tracker__tool_4", {})),
      fauxAssistantMessage([fauxText("Read.")]),
    ] });
    const runtime = await create();
    try { await runOrchestratorTurn(runtime, "read the incident"); } finally { await runtime.dispose(); }
    expect(callConnectorTool).toHaveBeenCalledOnce();
    expect(session.ran).toBe(1);
  });
});

describe("a deferred tool whose name starts a Pi host tool's name", () => {
  const names = ["wr", "ba", "ed", "po", "r", "l", "f", "g"];
  const named = (connector: string): ConnectorCatalog => ({
    connector, skipped: [],
    tools: names.map((name) => ({ ...manyTools(2, connector).tools[0]!, name, upstreamName: name })),
  });

  it("never switches Pi's write, bash, edit or powershell on in the orchestrator", async () => {
    let first: string[] = [];
    const { create } = await runtimeWith([...manyCatalogs(30), named("odd")], { script: [(input) => { first = offered(input); return fauxAssistantMessage([fauxText("ok")]); }] });
    const runtime = await create();
    try {
      await runOrchestratorTurn(runtime, "hello");
      expect(runtime.session.getActiveToolNames().filter((name) => PI_BUILT_IN_TOOL_NAMES.includes(name))).toEqual([]);
    } finally { await runtime.dispose(); }
    expect(first.filter((name) => PI_BUILT_IN_TOOL_NAMES.includes(name))).toEqual([]);
    // The odd tools are still the project's tools, declared by their exact names.
    expect(first).toEqual(expect.arrayContaining(names));
  });

  it("is kept directly declared by the plan, with an exact name that matches only itself", () => {
    const tool = (name: string) => defineTool({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) });
    const plan = planToolExposure([tool("core_tool"), tool("core"), tool("wr"), tool("ba"), ...Array.from({ length: 25 }, (_, index) => tool(`c__t${String(index)}`))], { deferrable: ({ name }) => name !== "core_tool" });
    expect(plan.deferred).not.toContain("wr");
    expect(plan.deferred).not.toContain("ba");
    // `core` is a prefix of the non-deferred `core_tool`.
    expect(plan.deferred).not.toContain("core");
    expect(plan.names).toEqual(expect.arrayContaining(["wr", "ba", "core"]));
    expect(plan.names.filter((name) => name.endsWith("*")).every((entry) => entry.startsWith("c__t"))).toBe(true);
  });

  it("is stopped by the session itself even when a `wr*` entry reaches the allowlist", async () => {
    const { modelRuntime } = await fauxModelRuntime();
    const wr = { ...defineTool({ name: "wr", label: "wr", description: "w", parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }), exposure: "deferred" as const };
    const runtime = await createPiSessionRuntime({ stateDirectory: await createFixtureDirectory("agentx-wr-"), modelRuntime, model: FAUX_MODEL, systemPrompt: "x", customTools: [wr], toolNames: ["wr*"], extensions: [] });
    try { expect(runtime.session.getActiveToolNames()).toEqual([]); } finally { await runtime.dispose(); }
  });
});

describe("tool_search limits", () => {
  const loadedNames = (text: string) => [...text.matchAll(/^- (\S+?):/gmu)].map((match) => match[1]!);

  it("loads at most 10 tools however high the limit, and at most 40 in a session, also after a reopen", async () => {
    const query = { query: "read number tracker", limit: 500 };
    const first = await runtimeWith(manyCatalogs(60), { script: [
      ...Array.from({ length: 5 }, () => toolUse(fauxToolCall("tool_search", query))), fauxAssistantMessage([fauxText("Done.")]),
    ] });
    const one = await first.create();
    const sessionFile = one.session.sessionFile;
    try {
      await runOrchestratorTurn(one, "load everything");
      const ran = results(one.session.messages);
      expect(MAX_SEARCH_LIMIT).toBe(10);
      expect(ran.slice(0, 4).map((result) => loadedNames(result.text).length)).toEqual([10, 10, 10, 10]);
      expect(ran[4]!.text).toContain(`${String(MAX_LOADED_DEFERRED_TOOLS)} tools are already loaded`);
    } finally { await one.dispose(); }
    let second: string[] = [];
    const next = await runtimeWith(manyCatalogs(60), { stateDirectory: first.stateDirectory, ...(sessionFile === undefined ? {} : { sessionFile }), script: [
      (input) => { second = offered(input); return toolUse(fauxToolCall("tool_search", { query: "release number" })); }, fauxAssistantMessage([fauxText("Ok.")]),
    ] });
    const two = await next.create();
    try {
      await runOrchestratorTurn(two, "again");
      expect(results(two.session.messages).at(-1)!.text).toContain("already loaded");
    } finally { await two.dispose(); }
    expect(second.filter((name) => name.includes("__tool_") || name.includes("__close"))).toHaveLength(40);
  });

  it("puts a frame before the connector-written lines, and cuts a long line", async () => {
    const [catalog] = manyCatalogs(30) as [ConnectorCatalog];
    catalog.tools[4] = { ...catalog.tools[4]!, description: `Read the incident number 4. ${"padding ".repeat(200)}` };
    const { create } = await runtimeWith([catalog, manyTools(30, "tracker2")], { script: [toolUse(fauxToolCall("tool_search", { query: "incident padding" })), fauxAssistantMessage([fauxText("Ok.")])] });
    const runtime = await create();
    try {
      await runOrchestratorTurn(runtime, "find");
      const text = results(runtime.session.messages)[0]!.text;
      expect(text).toContain("written by connectors");
      expect(text.indexOf("written by connectors")).toBeLessThan(text.indexOf("- tracker__tool_4"));
      expect(Math.max(...text.split("\n").map((line) => line.length))).toBeLessThanOrEqual(245);
    } finally { await runtime.dispose(); }
  });
});
