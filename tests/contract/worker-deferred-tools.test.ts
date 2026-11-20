// Pi's deferred tool exposure plus tool_search in the worker: a stage with many source tools or an agent step with many connector grants declares few tools
// first, finds the rest with tool_search, and reaches them through the same broker bridge. A stage can find only what it was given. No network, no Docker.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_STEP_PREAMBLE, DEFERRED_TOOLS_ABOVE, type ConnectorCatalog, type ContextToolCatalog } from "../../packages/contracts/src/index.js";
import { createConnectorBridgeTools } from "../../packages/worker/src/agent-run/connector-bridge.js";
import { createContextTools } from "../../packages/worker/src/context-sources/bridge.js";
import { createDefaultPiSessionAdapter, createWorkspacePiSession, openRegisteredWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const toolNames = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name).sort();
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

describe("a Plan stage with many source tools", () => {

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

