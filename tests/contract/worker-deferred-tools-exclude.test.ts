// The worker's own `excludeTools` is the second layer against a deferred tool's `name*` allowlist entry switching on one of Pi's host tools. planToolExposure's
// prefix rule is the first, and it would hide a missing exclude, so this test wraps the plan to let the `wr*` entry through. Then only the exclude stands
// between the entry and Pi's own unsandboxed `write`.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ModelRuntime from "@agentx/model-runtime";
import { AGENT_STEP_PREAMBLE, DEFERRED_TOOLS_ABOVE, type ConnectorCatalog } from "../../packages/contracts/src/index.js";
import { createConnectorBridgeTools } from "../../packages/worker/src/agent-run/connector-bridge.js";
import { createDefaultPiSessionAdapter, createWorkspacePiSession } from "../../packages/worker/src/pi-session.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

vi.mock("@agentx/model-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof ModelRuntime>();
  return {
    ...actual,
    // The plan as if it had no prefix rule: the odd tool `wr` is allowlisted by the pattern `wr*`, as a deferred tool would be.
    planToolExposure: (...args: Parameters<typeof actual.planToolExposure>) => {
      const plan = actual.planToolExposure(...args);
      return { ...plan, names: plan.names.map((name) => (name === "wr" ? "wr*" : name)) };
    },
  };
});

const toolNames = (context: TranscriptContext) => getCurrentTools(context.messages).map((tool) => tool.name).sort();
const cleanup: string[] = [];
beforeEach(async () => {
  const state = await mkdtemp(join(tmpdir(), "exclude-state-"));
  cleanup.push(state);
  vi.stubEnv("AGENTX_WORKER_STATE_DIR", state);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("a `wr*` allowlist entry in a read-only agent step", () => {
  it("does not switch on Pi's own write, because the session excludes the host tools the stage did not choose", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "exclude-root-"));
    cleanup.push(rootPath);
    const { modelRuntime, faux } = await fauxModelRuntime();
    const offered: string[][] = [];
    faux.setResponses([(context) => { offered.push(toolNames(context)); return fauxAssistantMessage("ok"); }]);
    const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
    const base: ConnectorCatalog = {
      connector: "tracker", skipped: [],
      tools: Array.from({ length: DEFERRED_TOOLS_ABOVE + 1 }, (_, index) => ({
        name: `tracker__tool_${String(index)}`, upstreamName: `tool_${String(index)}`, description: "Read.", access: "read" as const,
        inputSchema: { type: "object", properties: {}, required: [] }, scopes: [{ alias: "main", schemaHash: "a".repeat(64) }],
      })),
    };
    const odd: ConnectorCatalog = { ...base, tools: [...base.tools, { ...base.tools[0]!, name: "wr", upstreamName: "wr" }] };
    const bridge = createConnectorBridgeTools([odd], async () => ({ status: "SUCCEEDED" }), { workspaceId: "ws", conversationId: "conv", operationId: "op" });
    const handle = await createWorkspacePiSession({ rootPath, model: FAUX_MODEL, localFileTools: true, agentRun: { systemPrompt: AGENT_STEP_PREAMBLE, tools: bridge } }, adapter);
    try { await handle.prompt("triage"); } finally { handle.dispose(); }
    expect(offered[0]).not.toContain("write");
    // `wr` itself is matched by its own pattern and so declared; Pi's host write is not.
    expect(offered[0]).toEqual(["find", "grep", "ls", "read", "tool_search", "wr"]);
  });
});
