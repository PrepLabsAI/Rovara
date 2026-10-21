import { createHash } from "node:crypto";
import {
  E2E_MODEL_ROUTE_DEFAULT_BUDGETS,
  E2EModelRouteDefinitionSchema,
  type E2EModelRouteDefinition,
} from "@agentx/contracts";
import type { E2EInvoke, E2EInvokeInput, E2EInvokeOutput } from "@agentx/model-runtime";

/**
 * The scripted model double (route `rovara-scripted/v1`) for qualification and CI (M1.4 Task 4.1).
 *
 * It is an `invoke` for the governed route, so it goes through the same proxy, budgets, credential scan, response
 * checks and receipts as the real model. It answers from a script keyed by the SHA-256 of the step's goal text (the
 * `goalDigest` the action ledger carries): each scripted turn taps a node whose accessible name matches a regex, types,
 * presses, selects, scrolls or navigates, or declares the step done without acting (the negative tests). It never calls
 * a provider and never reads an environment variable of its own.
 *
 * It is stateless: the turn is the number of assistant tool calls already in the prompt, so a re-sent request gets the
 * same answer. It reads nodes from the newest text that holds node lines of the form `#id role "name"` (the shape of
 * e2e's tree observation); Task 4.3's prompt must keep that shape, and the goal either as a whole text part or as a
 * `Goal: ...` line, or pass `goalCandidates`.
 */

export const SCRIPTED_E2E_ROUTE_ID = "rovara-scripted/v1";
export const SCRIPTED_E2E_MODEL_ID = "rovara-scripted-v1";

/** The scripted route is admitted only for a qualification policy, or when the CI harness sets `ROVARA_E2E_SCRIPTED_MODEL=1`. The registry refuses it for project setups. */
export function isScriptedE2EModelAdmissible(input: { policyScope: "standard" | "qualification"; environment: NodeJS.ProcessEnv }): boolean {
  return input.policyScope === "qualification" || input.environment["ROVARA_E2E_SCRIPTED_MODEL"] === "1";
}

export function scriptedE2ERouteDefinition(overrides: Partial<Pick<E2EModelRouteDefinition, "revision" | "budgets">> = {}): E2EModelRouteDefinition {
  return E2EModelRouteDefinitionSchema.parse({
    routeId: SCRIPTED_E2E_ROUTE_ID, revision: 1, scope: "qualification", provider: "rovara-scripted", region: null,
    modelId: SCRIPTED_E2E_MODEL_ID, inferenceProfileArn: null, secretArn: null, openRouter: null, budgets: { ...E2E_MODEL_ROUTE_DEFAULT_BUDGETS },
    promptProtocol: "e2e-0.20.0-act/v1", sampling: "provider-default", thinking: "off", effort: null, vision: false, ...overrides,
  });
}

export type ScriptedTurn =
  | { kind: "tap"; name: RegExp }
  | { kind: "type"; name: RegExp; value: string }
  | { kind: "press"; name: RegExp; key: string }
  | { kind: "select"; name: RegExp; value: string }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right" }
  | { kind: "navigate"; url: string }
  /** Concludes the step without acting. `status` defaults to passed. */
  | { kind: "done"; status?: "passed" | "failed"; summary?: string }
  /** The provider fails on this turn (an outage). */
  | { kind: "fail"; message: string };

export interface ScriptedE2EModelOptions {
  /** Turns by `goalDigest` (SHA-256 hex of the goal text). */
  scripts: Readonly<Record<string, readonly ScriptedTurn[]>>;
  /** The texts that may be the goal. Defaults to each user text part, its lines, and the rest of a `Goal:` line. */
  goalCandidates?: (call: E2EInvokeInput["call"]) => string[];
}

const NODE_LINE = /^\s*#([A-Za-z0-9_.:-]+)\s+([a-z]+)\s+"((?:[^"\\]|\\.)*)"/gm;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function userTexts(call: E2EInvokeInput["call"]): string[] {
  return call.prompt.flatMap((message) => (message.role === "user" ? message.content.map((part) => part.text) : []));
}

function defaultGoalCandidates(call: E2EInvokeInput["call"]): string[] {
  return userTexts(call).flatMap((text) => {
    const lines = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    return [text, text.trim(), ...lines, ...lines.flatMap((line) => (line.startsWith("Goal:") ? [line.slice(5).trim()] : []))];
  });
}

function latestNodes(call: E2EInvokeInput["call"]): Array<{ id: string; role: string; name: string }> {
  const texts: string[] = [];
  for (const message of call.prompt) {
    if (message.role === "user") texts.push(...message.content.map((part) => part.text));
    if (message.role === "tool") texts.push(...message.content.map((part) => (part.output.type === "content" ? part.output.value.map((item) => item.text).join("\n") : part.output.value)));
  }
  for (const text of texts.reverse()) {
    const nodes = [...text.matchAll(NODE_LINE)].map((match) => ({ id: match[1]!, role: match[2]!, name: match[3]!.replace(/\\(.)/g, "$1") }));
    if (nodes.length > 0) return nodes;
  }
  return [];
}

function turnIndex(call: E2EInvokeInput["call"]): number {
  return call.prompt.filter((message) => message.role === "assistant" && message.content.some((part) => part.type === "tool-call")).length;
}

export function createScriptedE2EInvoke(options: ScriptedE2EModelOptions): E2EInvoke {
  const candidates = options.goalCandidates ?? defaultGoalCandidates;
  return async (input): Promise<E2EInvokeOutput> => {
    const { call } = input;
    const digest = candidates(call).map(sha256).find((candidate) => options.scripts[candidate] !== undefined);
    if (digest === undefined) throw new Error("the scripted model has no script for this goal");
    const script = options.scripts[digest]!;
    const turn = turnIndex(call);
    const step = script[turn];
    const callId = (name: string) => `scripted_${turn}_${name}_${digest.slice(0, 8)}`;
    const toolCall = (toolName: string, args: Record<string, unknown>): E2EInvokeOutput => ({
      servedModelId: input.target.identifier,
      content: [{ type: "tool-call", toolCallId: callId(toolName), toolName, input: JSON.stringify(args) }],
      finishReason: { unified: "tool-calls", raw: "scripted" },
      usage: { inputTokens: Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(call), "utf8") / 4)), outputTokens: 20 },
    });
    if (step === undefined) return toolCall("complete_step", { status: "failed", summary: "The scripted model ran out of turns." });
    if (step.kind === "fail") throw new Error(step.message);
    if (step.kind === "done") return toolCall("complete_step", { status: step.status ?? "passed", summary: step.summary ?? "Done." });
    if (step.kind === "scroll") return toolCall("scroll", { direction: step.direction });
    if (step.kind === "navigate") return toolCall("navigate", { url: step.url });
    const node = latestNodes(call).find((candidate) => step.name.test(candidate.name));
    if (node === undefined) throw new Error(`the scripted ${step.kind} found no node matching ${String(step.name)}`);
    switch (step.kind) {
      case "tap": return toolCall("tap", { target: node.id });
      case "type": return toolCall("type", { target: node.id, value: step.value });
      case "press": return toolCall("press", { target: node.id, key: step.key });
      case "select": return toolCall("select", { target: node.id, value: step.value });
    }
  };
}
