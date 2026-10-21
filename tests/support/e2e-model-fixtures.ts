import {
  E2E_MODEL_ROUTE_DEFAULT_BUDGETS,
  E2EModelRouteDefinitionSchema,
  type E2EModelChannelRequest,
  type E2EModelRouteBudgets,
  type E2EModelRouteDefinition,
} from "../../packages/contracts/src/e2e-model-channel.js";

/** Fixtures shared by the Task 4.1 tests: a pinned route, a channel request and a fake provider answer. */

export const RUN_ID = "7f1c2a4e-5b6d-4c8e-9f01-23456789abcd";
export const CASE_ID = "case-orders-export";
export const MODEL_ID = "us.anthropic.claude-haiku-5-5";

export function bedrockRoute(overrides: Record<string, unknown> = {}): E2EModelRouteDefinition {
  return E2EModelRouteDefinitionSchema.parse({
    routeId: "rovara-e2e-default", revision: 1, scope: "standard", provider: "amazon-bedrock", region: "us-east-1",
    modelId: MODEL_ID, inferenceProfileArn: null, budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS },
    promptProtocol: "e2e-0.20.0-act/v1", temperature: 0, vision: false, ...overrides,
  });
}

export function loweredBudgets(lowered: Partial<E2EModelRouteBudgets>): E2EModelRouteBudgets {
  return { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS, ...lowered };
}

export const TOOLS = [
  { type: "function" as const, name: "tap" as const, description: "Tap one node", inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] } },
  { type: "function" as const, name: "type" as const, description: "Type into a node", inputSchema: { type: "object", properties: { target: { type: "string" }, value: { type: "string" } }, required: ["target", "value"] } },
  { type: "function" as const, name: "complete_step" as const, description: "Conclude", inputSchema: { type: "object", properties: { status: { type: "string" }, summary: { type: "string" } }, required: ["status", "summary"] } },
];

export type ChannelCall = E2EModelChannelRequest["call"];

/** A valid call. `observation` is the page text the model is shown; `typed` is an earlier action of the agent, if any. */
export function call(observation = '#n1 button "Export orders"\n#n2 textbox "File name"', options: { typed?: string; system?: string; toolResult?: string } = {}): ChannelCall {
  const prompt: ChannelCall["prompt"] = [
    { role: "system", content: options.system ?? "You drive a web application one tool call at a time." },
    { role: "user", content: [{ type: "text", text: `Goal: export the orders\n${observation}` }] },
  ];
  if (options.typed !== undefined) {
    prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "type", input: { target: "n2", value: options.typed } }] });
    prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "type", output: { type: "text", value: options.toolResult ?? "Typed." } }] });
  }
  return { prompt, tools: TOOLS, toolChoice: { type: "required" } };
}

export function channelRequest(overrides: Partial<E2EModelChannelRequest> & { callOverride?: ChannelCall } = {}): E2EModelChannelRequest {
  const { callOverride, ...rest } = overrides;
  return { schemaVersion: "rovara-e2e-model-channel/v1", runId: RUN_ID, caseId: CASE_ID, stepIndex: 0, callIndex: 0, call: callOverride ?? call(), ...rest };
}

/** What a provider returns for a model that taps the Export button. */
export function tapAnswer(overrides: Record<string, unknown> = {}) {
  return {
    servedModelId: MODEL_ID,
    content: [{ type: "tool-call" as const, toolCallId: "call_tap_1", toolName: "tap", input: JSON.stringify({ target: "n1" }) }],
    finishReason: { unified: "tool-calls", raw: "tool_use" },
    usage: { inputTokens: 900, outputTokens: 40 },
    ...overrides,
  };
}
