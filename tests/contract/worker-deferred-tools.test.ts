// Pi's deferred tool exposure plus tool_search in the worker: a stage with many source tools or an agent step with many connector grants declares few tools
// first, finds the rest with tool_search, and reaches them through the same broker bridge. A stage can find only what it was given. No network, no Docker.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STEP_PREAMBLE, DEFERRED_TOOLS_ABOVE, type ConnectorCatalog, type ContextToolCatalog } from "../../packages/contracts/src/index.js";
import { createConnectorBridgeTools } from "../../packages/worker/src/agent-run/connector-bridge.js";
import { createContextTools } from "../../packages/worker/src/context-sources/bridge.js";
import { createDefaultPiSessionAdapter, createWorkspacePiSession, openRegisteredWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const SECRET = "TICKET-BODY-ONLY-IN-LIVE-MEMORY";
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const toolNames = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name).sort();
/** The latest tool result. A tool change adds a system message after it, so it is not always the last message. */
const lastResult = (context: TranscriptContext) => JSON.parse(JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"))) as { toolName: string; isError: boolean; content: Array<{ text: string }> };
const WORDS = ["invoice", "customer", "sprint", "roadmap", "incident", "deployment", "calendar", "budget", "release", "ticket"];

/** `count` source tools, `src_wiki_tool_0`...: each described by its own distinctive word. */
function sources(count: number, sourceId = "wiki"): ContextToolCatalog {
  return {
    sources: [{ sourceId, label: sourceId.toUpperCase(), quotes: "citations_only" }],
    tools: Array.from({ length: count }, (_, index) => ({
      name: `src_${sourceId}_tool_${index}`, sourceId, upstreamName: `tool_${index}`, role: "search" as const,
      description: `Search the ${WORDS[index % WORDS.length]} ${index} pages of ${sourceId}.`, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    })),
    searchTeamKnowledge: false, unavailable: [], disabled: [],
  };
}

/** `count` connector tools for an agent step. */
function connector(count: number, name = "tracker"): ConnectorCatalog {
  return {
    connector: name, skipped: [],
    tools: Array.from({ length: count }, (_, index) => ({
      name: `${name}__tool_${index}`, upstreamName: `tool_${index}`, description: `Read the ${WORDS[index % WORDS.length]} ${index} of ${name}.`, access: "read" as const,
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: [] }, scopes: [{ alias: "main", schemaHash: "a".repeat(64) }],
    })),
  };
}

const cleanup: string[] = [];
beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "deferred-state-"));
  cleanup.push(state);
  vi.stubEnv("AGENTX_WORKER_STATE_DIR", state);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function world(script: Parameters<Awaited<ReturnType<typeof fauxModelRuntime>>["faux"]["setResponses"]>[0]) {
  const rootPath = await mkdtemp(join(tmpdir(), "deferred-root-"));
  cleanup.push(rootPath);
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(script);
  const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  return { rootPath, adapter };
}

const CONTEXT = { workspaceId: "ws", conversationId: "conv", operationId: "op" };

/** Registers a deferred tool of its own, named like an MCP tool (Pi keeps those registered whatever the allowlist says): the worst case for a search that is not limited to the stage. */
const rogueExtension = (executed: string[]): InlineExtension => ({
  name: "rogue", hidden: true,
  factory: (pi) => {
    pi.registerTool({
      name: "mcp__rogue__delete_everything", label: "rogue", description: "Delete everything in the wiki for good.", parameters: { type: "object", properties: {} } as never, exposure: "deferred",
      execute: async () => { executed.push("rogue"); return { content: [{ type: "text", text: "deleted" }], details: {} }; },
    });
  },
});

describe("a Plan stage with many source tools", () => {
  it("declares the file tools and tool_search first, finds a source tool, and calls it through the broker bridge", async () => {
    const offered: string[][] = [];
    const seen: string[] = [];
    const w = await world([
      (context) => { offered.push(toolNames(context)); return toolUse(fauxToolCall("tool_search", { query: "incident" }, { id: "s1" })); },
      (context) => { offered.push(toolNames(context)); seen.push(lastResult(context).content[0]!.text); return toolUse(fauxToolCall("src_wiki_tool_4", { query: "login" }, { id: "t1" })); },
      (context) => { seen.push(JSON.stringify(context.messages.findLast((message) => message.role === "toolResult"))); return fauxAssistantMessage("Plan done."); },
    ]);
    const calls: unknown[] = [];
    const contextTools = createContextTools(sources(DEFERRED_TOOLS_ABOVE + 10), async (request) => { calls.push(request); return { status: "OK", text: `<source-result source="WIKI" item="P1" fetched="2026-11-01T10:00:00.000Z" untrusted="true" standing="outsider">\n${SECRET}\n</source-result>` }; }, CONTEXT);
    const handle = await createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools, contextNote: "Sources note." }, w.adapter);
    try { await handle.prompt("plan it"); } finally { handle.dispose(); }
    expect(offered[0]).toEqual(["find", "grep", "ls", "read", "tool_search"]);
    expect(offered[1]).toContain("src_wiki_tool_4");
    expect(offered[1]!.length).toBeLessThan(10);
    expect(seen[0]).toContain("src_wiki_tool_4");
    expect(calls).toEqual([expect.objectContaining({ tool: "src_wiki_tool_4", arguments: { query: "login" } })]);
    expect(seen[1]).toContain(SECRET);
    // A source's text still never stays in the saved transcript, and the search did not change that.
    const directory = join(w.rootPath, "agent-sessions");
    const saved = await readFile(join(directory, (await readdir(directory))[0]!), "utf8");
    expect(saved).not.toContain(SECRET);
  });

  it("tells the model that tool_search loads the rest, and says nothing of it when there are few source tools", async () => {
    const prompts: string[] = [];
    for (const count of [DEFERRED_TOOLS_ABOVE + 1, DEFERRED_TOOLS_ABOVE]) {
      const w = await world([fauxAssistantMessage("ok")]);
      const contextTools = createContextTools(sources(count), async () => ({ status: "OK", text: "x" }), CONTEXT);
      const handle = await createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools }, w.adapter);
      try { prompts.push(handle.systemPromptText?.() ?? ""); } finally { handle.dispose(); }
    }
    expect(prompts[0]).toContain("tool_search");
    expect(prompts[1]).not.toContain("tool_search");
  });

  it("keeps every source tool declared when there are few, exactly as before", async () => {
    const offered: string[][] = [];
    const w = await world([(context) => { offered.push(toolNames(context)); return fauxAssistantMessage("ok"); }]);
    const contextTools = createContextTools(sources(DEFERRED_TOOLS_ABOVE), async () => ({ status: "OK", text: "x" }), CONTEXT);
    const handle = await createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools }, w.adapter);
    try { await handle.prompt("go"); } finally { handle.dispose(); }
    expect(offered[0]).toContain("src_wiki_tool_0");
    expect(offered[0]).not.toContain("tool_search");
  });

  it("cannot call a source tool before finding it", async () => {
    const calls: unknown[] = [];
    let result: ReturnType<typeof lastResult> | undefined;
    const w = await world([
      toolUse(fauxToolCall("src_wiki_tool_4", { query: "x" }, { id: "t1" })),
      (context) => { result = lastResult(context); return fauxAssistantMessage("could not"); },
    ]);
    const contextTools = createContextTools(sources(DEFERRED_TOOLS_ABOVE + 10), async (request) => { calls.push(request); return { status: "OK", text: "x" }; }, CONTEXT);
    const handle = await createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools }, w.adapter);
    try { await handle.prompt("go"); } finally { handle.dispose(); }
    expect(result).toMatchObject({ toolName: "src_wiki_tool_4", isError: true });
    expect(calls).toEqual([]);
  });

  it("keeps what an earlier stage loaded when the conversation is reopened, and drops what the reopened stage was not given", async () => {
    const first = await world([toolUse(fauxToolCall("tool_search", { query: "incident" }, { id: "s1" })), fauxAssistantMessage("Loaded.")]);
    const wide = createContextTools(sources(DEFERRED_TOOLS_ABOVE + 10), async () => ({ status: "OK", text: "x" }), CONTEXT);
    const one = await createWorkspacePiSession({ rootPath: first.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools: wide }, first.adapter);
    const sessionFile = one.sessionFile;
    try { await one.prompt("find"); } finally { one.dispose(); }
    const seen: string[][] = [];
    for (const catalog of [sources(DEFERRED_TOOLS_ABOVE + 10), sources(DEFERRED_TOOLS_ABOVE + 10).tools.length > 0 ? { ...sources(DEFERRED_TOOLS_ABOVE + 10), tools: sources(DEFERRED_TOOLS_ABOVE + 10).tools.filter(({ name }) => name !== "src_wiki_tool_4") } : sources(0)]) {
      const { modelRuntime, faux } = await fauxModelRuntime();
      faux.setResponses([(context) => { seen.push(toolNames(context)); return fauxAssistantMessage("again"); }]);
      const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
      const contextTools = createContextTools(catalog, async () => ({ status: "OK", text: "x" }), CONTEXT);
      const reopened = await openRegisteredWorkspacePiSession({ rootPath: first.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", conversationId: "conv", sessionFile, localFileTools: true, contextTools }, adapter);
      try { await reopened.prompt("again"); } finally { reopened.dispose(); }
    }
    expect(seen[0]).toContain("src_wiki_tool_4");
    expect(seen[1]).not.toContain("src_wiki_tool_4");
  });
});

describe("a stage can find only the tools it was given", () => {
  it("does not find a tool of another stage's sources, and cannot call it", async () => {
    let search = "";
    let call: ReturnType<typeof lastResult> | undefined;
    const w = await world([
      toolUse(fauxToolCall("tool_search", { query: "incident otherwiki" }, { id: "s1" })),
      (context) => { search = lastResult(context).content[0]!.text; return toolUse(fauxToolCall("src_otherwiki_tool_4", { query: "x" }, { id: "t1" })); },
      (context) => { call = lastResult(context); return fauxAssistantMessage("done"); },
    ]);
    const calls: unknown[] = [];
    const stageTools = createContextTools(sources(DEFERRED_TOOLS_ABOVE + 10, "wiki"), async (request) => { calls.push(request); return { status: "OK", text: "x" }; }, CONTEXT);
    const handle = await createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools: stageTools }, w.adapter);
    try { await handle.prompt("go"); } finally { handle.dispose(); }
    expect(search).not.toContain("otherwiki");
    expect(call).toMatchObject({ toolName: "src_otherwiki_tool_4", isError: true });
    expect(calls).toEqual([]);
  });

  it("does not find a deferred tool that some other extension registered, even one Pi would keep registered and searchable", async () => {
    const executed: string[] = [];
    let search = "";
    let call: ReturnType<typeof lastResult> | undefined;
    const w = await world([
      toolUse(fauxToolCall("tool_search", { query: "delete everything for good" }, { id: "s1" })),
      (context) => { search = lastResult(context).content[0]!.text; return toolUse(fauxToolCall("mcp__rogue__delete_everything", {}, { id: "t1" })); },
      (context) => { call = lastResult(context); return fauxAssistantMessage("done"); },
    ]);
    const contextTools = createContextTools(sources(DEFERRED_TOOLS_ABOVE + 10), async () => ({ status: "OK", text: "x" }), CONTEXT);
    const handle = await createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools, extensionFactories: [rogueExtension(executed)] }, w.adapter);
    try { await handle.prompt("go"); } finally { handle.dispose(); }
    expect(search).toBe("No matching tools found.");
    expect(call).toMatchObject({ isError: true });
    expect(executed).toEqual([]);
  });

  it("gives a Build stage no source tools at all, so there is nothing to search", async () => {
    const w = await world([fauxAssistantMessage("ok")]);
    const contextTools = createContextTools(sources(DEFERRED_TOOLS_ABOVE + 10), async () => ({ status: "OK", text: "x" }), CONTEXT);
    await expect(createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, workflowMode: "IMPLEMENT", localFileTools: true, contextTools }, w.adapter)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("an agent step with many connector grants", () => {
  it("declares only choose_branch, the read-only file tools and tool_search first, then calls a found connector tool through the bridge with the step's call id", async () => {
    const offered: string[][] = [];
    const calls: Array<{ connector: string; tool: string; arguments: unknown }> = [];
    const w = await world([
      (context) => { offered.push(toolNames(context)); return toolUse(fauxToolCall("tool_search", { query: "roadmap" }, { id: "s1" })); },
      (context) => { offered.push(toolNames(context)); return toolUse(fauxToolCall("tracker__tool_3", { id: "R-1" }, { id: "t1" })); },
      fauxAssistantMessage([fauxText("Report.")]),
    ]);
    const bridge = createConnectorBridgeTools([connector(DEFERRED_TOOLS_ABOVE + 10)], async (input) => { calls.push(input); return { status: "SUCCEEDED" }; }, { workspaceId: "ws", conversationId: "conv", operationId: "op" });
    const choose = { name: "choose_branch", label: "choose_branch", description: "Choose the branch.", parameters: { type: "object", properties: {} } as never, execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }) };
    const handle = await createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, localFileTools: true, agentRun: { systemPrompt: AGENT_STEP_PREAMBLE, tools: [...bridge, choose] } }, w.adapter);
    try { await handle.prompt("triage"); } finally { handle.dispose(); }
    expect(offered[0]).toEqual(["choose_branch", "find", "grep", "ls", "read", "tool_search"]);
    // "roadmap" is a word of three tool descriptions (3, 13, 23): the matches are declared, the other 27 are not.
    expect(offered[1]).toEqual(["choose_branch", "find", "grep", "ls", "read", "tool_search", "tracker__tool_13", "tracker__tool_23", "tracker__tool_3"]);
    expect(calls).toEqual([expect.objectContaining({ connector: "tracker", tool: "tool_3", arguments: { id: "R-1" } })]);
  });
});

describe("a granted tool whose name starts a Pi host tool's name", () => {
  it("does not switch on Pi's own write or bash in a read-only agent step", async () => {
    const offered: string[][] = [];
    const w = await world([(context) => { offered.push(toolNames(context)); return fauxAssistantMessage("ok"); }]);
    const base = connector(DEFERRED_TOOLS_ABOVE + 1);
    const odd: ConnectorCatalog = { ...base, tools: [...base.tools, ...["wr", "ba", "ed", "po"].map((name) => ({ ...base.tools[0]!, name, upstreamName: name }))] };
    const bridge = createConnectorBridgeTools([odd], async () => ({ status: "SUCCEEDED" }), { workspaceId: "ws", conversationId: "conv", operationId: "op" });
    const handle = await createWorkspacePiSession({ rootPath: w.rootPath, model: FAUX_MODEL, localFileTools: true, agentRun: { systemPrompt: AGENT_STEP_PREAMBLE, tools: bridge } }, w.adapter);
    try { await handle.prompt("triage"); } finally { handle.dispose(); }
    expect(offered[0]).toEqual(["find", "grep", "ls", "read", "tool_search", "ba", "ed", "po", "wr"].sort());
  });
});

describe("what a reopened stage restores", () => {
  /** A deferred tool named like an MCP tool, which Pi keeps registered, and which can be made active by the extension that owns it. */
  const owner = (activate: boolean): InlineExtension => ({
    name: "owner", hidden: true,
    factory: (pi) => {
      pi.registerTool({ name: "mcp__owner__helper", label: "helper", description: "Helps.", parameters: { type: "object", properties: {} } as never, exposure: "codemode", execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
      if (activate) pi.on("session_start", () => { pi.setActiveTools([...pi.getActiveTools(), "mcp__owner__helper"]); });
    },
  });

  it("puts back only tools this session deferred, never another registered tool that an earlier run had declared", async () => {
    const first = await world([fauxAssistantMessage("First.")]);
    const contextTools = () => createContextTools(sources(DEFERRED_TOOLS_ABOVE + 10), async () => ({ status: "OK", text: "x" }), CONTEXT);
    const one = await createWorkspacePiSession({ rootPath: first.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools: contextTools(), extensionFactories: [owner(true)] }, first.adapter);
    const sessionFile = one.sessionFile;
    try { await one.prompt("go"); } finally { one.dispose(); }
    const seen: string[][] = [];
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([(context) => { seen.push(toolNames(context)); return fauxAssistantMessage("again"); }]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const reopened = await openRegisteredWorkspacePiSession({ rootPath: first.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", conversationId: "conv", sessionFile, localFileTools: true, contextTools: contextTools(), extensionFactories: [owner(false)] }, adapter);
    try { await reopened.prompt("again"); } finally { reopened.dispose(); }
    // The positive control: the earlier run did declare it.
    expect(JSON.stringify(await readFile(sessionFile, "utf8"))).toContain("mcp__owner__helper");
    expect(seen[0]).not.toContain("mcp__owner__helper");
  });
});

describe("the restore cap when other deferred tools are already active", () => {
  it("keeps at most 40 deferred tools active when a reopened session already has some, as on a reload, resume or fork", async () => {
    const wide = () => createContextTools(sources(DEFERRED_TOOLS_ABOVE + 30), async () => ({ status: "OK", text: "x" }), CONTEXT);
    const first = await world([toolUse(fauxToolCall("tool_search", { query: "1 2 3 4 5 6 7 8 9 10", limit: 10 }, { id: "s1" })), fauxAssistantMessage("Loaded.")]);
    const one = await createWorkspacePiSession({ rootPath: first.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", localFileTools: true, contextTools: wide() }, first.adapter);
    const sessionFile = one.sessionFile;
    try { await one.prompt("find"); } finally { one.dispose(); }
    // Another extension, started before the search extension, has already made 35 other deferred tools active when the session starts again.
    const booster: InlineExtension = {
      name: "booster", hidden: true,
      factory: (pi) => { pi.on("session_start", () => { pi.setActiveTools([...pi.getActiveTools(), ...Array.from({ length: 35 }, (_, index) => `src_wiki_tool_${String(index + 15)}`)]); }); },
    };
    const seen: string[][] = [];
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([(context) => { seen.push(toolNames(context)); return fauxAssistantMessage("again"); }]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const reopened = await openRegisteredWorkspacePiSession({ rootPath: first.rootPath, model: FAUX_MODEL, workflowMode: "PLAN", conversationId: "conv", sessionFile, localFileTools: true, contextTools: wide(), extensionFactories: [booster] }, adapter);
    try { await reopened.prompt("again"); } finally { reopened.dispose(); }
    expect(seen[0]!.filter((name) => name.startsWith("src_wiki_tool_"))).toHaveLength(40);
  });
});
