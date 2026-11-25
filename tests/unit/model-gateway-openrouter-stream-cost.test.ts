import { expect, it } from "vitest";
import { UsageCollector } from "../../packages/model-gateway/src/usage.js";
import { claims, now } from "./model-gateway-fixture.js";
import { initialCharge, finishCharge } from "../../packages/model-gateway/src/charge-producer.js";
import { ChatStreamToSse, fromChatCompletion } from "../../packages/model-gateway/src/agent-openai.js";
it.each([undefined, 0.001])("retains an observed debit when a later usage frame reports %s", cost => {
 const c = new ChatStreamToSse("openrouter", "vendor/model", "fixture");
 const frame = (value: unknown) => c.push(Buffer.from(`data: ${JSON.stringify(value)}\n\n`));
 frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
 frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.02 } });
 frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, ...(cost === undefined ? {} : { cost }) } });
 c.push(Buffer.from("data: [DONE]\n\n")); c.finish();
 expect(c.reportedCost).toBe(20_000);
 expect(c.reportedCostComplete).toBe(false);
});

it("does not erase an observed cache write when a later usage frame says zero", () => {
 const c = new ChatStreamToSse("openrouter", "openai/gpt-5-mini", "fixture");
 const collector = new UsageCollector();
 const frame = (value: unknown) => collector.push(c.push(Buffer.from(`data: ${JSON.stringify(value)}\n\n`)));
 frame({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 1 }, cost: 0.02 } });
 frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 0 }, cost: 0.02 } });
 collector.push(c.push(Buffer.from("data: [DONE]\n\n"))); collector.push(c.finish());
 expect(collector.finish()).toMatchObject({ input: 9, cacheWrite: 1 });
});

// LIVE2: reasoning above a requested 1024 cap is still billable output; neither
// the requested cap nor the reservation may clamp the token/debit floor.
it.each([false, true])("settles uncapped reasoning at max(token cost, reported debit), streaming=%s", stream => {
 for (const [reported, expected] of [[0.002, 3003], [0.004, 4000]] as const) {
  const wireUsage = { prompt_tokens: 10, completion_tokens: 1500, completion_tokens_details: { reasoning_tokens: 1500 }, cost: reported };
  const collector = new UsageCollector(); let debit: number | undefined;
  if (stream) {
   const c = new ChatStreamToSse("openrouter", "openai/gpt-5-mini", "fixture");
   collector.push(c.push(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }], usage: wireUsage })}\n\n`)));
   collector.push(c.push(Buffer.from("data: [DONE]\n\n"))); collector.push(c.finish()); debit = c.reportedCost;
  } else {
   const translated = fromChatCompletion({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: wireUsage }, "openrouter", "openai/gpt-5-mini", "fixture");
   collector.whole(translated.message); debit = translated.reportedCost;
  }
  const usage = collector.finish(); expect(usage).toMatchObject({ input: 10, output: 1500 });
  const price = { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 2_000_000, estimated: false };
  const initial = initialCharge({ ...claims, aud: "rovara-model-gateway", src: "app", pay: { kind: "member", developerId: claims.per } }, { provider: "openrouter", modelId: "openai/gpt-5-mini" }, { source: { kind: "company_key", id: "src_fixture", name: "Fixture", provider: "openrouter", connectionRevision: "r1" }, billing: "external_provider" }, 2693, now, price);
  const receipt = finishCharge(initial, { ...(usage === undefined ? {} : { usage }), ...(debit === undefined ? {} : { reportedCostMicros: debit }), price, notSent: false, now });
  expect(receipt.amountMicros).toEqual({ state: "available", value: expected });
 }
});
