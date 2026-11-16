// A fake of the model gateway's offered-models answer (contract: OfferedAgentModels). The list is Cloud's gateway as of 2026-11-16 (Rovara's AI on): the Claude engine names, then
// ROVARA_AI_US_CONVERSE_MODELS, each named by the exact id that is called. A test changes a company's list with `set`, makes it fail with `fail`, or answers something that is not the contract with `answer`.
import type { OrgId } from "@agentx/contracts";
import type { OfferedModelsReader } from "../../packages/broker/src/core-host/gateway-model-selection.js";

export const GATEWAY_CLAUDE_MODELS = ["claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"] as const;
export const GATEWAY_CONVERSE_MODELS = [
  "qwen.qwen3-coder-480b-a35b-v1:0", "qwen.qwen3-coder-30b-a3b-v1:0", "qwen.qwen3-235b-a22b-2507-v1:0", "mistral.devstral-2-123b", "mistral.mistral-large-3-675b-instruct",
  "deepseek.v3-v1:0", "moonshotai.kimi-k2.5", "zai.glm-5", "zai.glm-4.7", "us.amazon.nova-2-lite-v1:0", "openai.gpt-oss-120b-1:0", "openai.gpt-oss-20b-1:0", "us.amazon.nova-pro-v1:0",
] as const;
export const GATEWAY_OFFERED_MODELS: readonly string[] = [...GATEWAY_CLAUDE_MODELS, ...GATEWAY_CONVERSE_MODELS];

export const offeredAnswer = (names: readonly string[]) => ({ version: 1, models: names.map((model) => ({ model })) });

export interface FakeOfferedModels extends OfferedModelsReader {
  /** The companies asked, in order. */
  readonly asked: OrgId[];
  /** This company's list from now on (the default is the whole gateway list). */
  set(companyId: OrgId, names: readonly string[]): void;
  /** Every read fails (with a message that names a host, which must never reach a caller). */
  fail(failing?: boolean): void;
  /** Every read answers this (not the contract), or the list again when undefined. */
  answer(value: unknown): void;
  /** Every read never answers. */
  hang(hanging?: boolean): void;
}

export function createFakeOfferedModels(): FakeOfferedModels {
  const lists = new Map<string, readonly string[]>();
  const asked: OrgId[] = [];
  let failing = false, hanging = false;
  let fixed: { value: unknown } | undefined;
  return {
    asked,
    set: (companyId, names) => { lists.set(companyId, names); },
    fail: (value = true) => { failing = value; },
    answer: (value) => { fixed = value === undefined ? undefined : { value }; },
    hang: (value = true) => { hanging = value; },
    async offered(companyId) {
      asked.push(companyId);
      if (hanging) return new Promise(() => undefined);
      if (failing) throw new Error("connect ECONNREFUSED gateway.internal.example:443");
      if (fixed !== undefined) return fixed.value;
      return offeredAnswer(lists.get(companyId) ?? GATEWAY_OFFERED_MODELS);
    },
  };
}
