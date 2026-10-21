import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2EModelChannelResponseSchema, E2EModelRouteDefinitionSchema, e2eModelRouteRevision } from "../../packages/contracts/src/e2e-model-channel.js";
import { createGovernedE2EModelRoute, createInMemoryE2EDayBudget } from "../../packages/model-runtime/src/e2e-route.js";
import {
  SCRIPTED_E2E_ROUTE_ID,
  createScriptedE2EInvoke,
  isScriptedE2EModelAdmissible,
  scriptedE2ERouteDefinition,
} from "../../packages/worker/src/e2e-model-scripted.js";
import { call, channelRequest } from "../support/e2e-model-fixtures.js";

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const GOAL = "export the orders";
const SNAPSHOT = '#n1 button "Export orders" testid="export"\n#n2 textbox "File name"\n#n3 button "Delete all orders"';

function routeFor(scripts: Record<string, never[] | readonly unknown[]>) {
  return createGovernedE2EModelRoute(scriptedE2ERouteDefinition(), { invoke: createScriptedE2EInvoke({ scripts: scripts as never }), now: Date.now, dayBudget: createInMemoryE2EDayBudget() });
}

describe("scripted e2e model route", () => {
  it("is a valid qualification-scoped route with the reserved id", () => {
    const definition = scriptedE2ERouteDefinition();
    expect(E2EModelRouteDefinitionSchema.parse(definition)).toMatchObject({ routeId: "rovara-scripted/v1", scope: "qualification", provider: "rovara-scripted", region: null, inferenceProfileArn: null });
    expect(SCRIPTED_E2E_ROUTE_ID).toBe("rovara-scripted/v1");
    expect(e2eModelRouteRevision(definition)).toMatch(/^r1-[a-f0-9]{12}$/);
  });

  it("is admissible only for a qualification policy or when the CI harness sets ROVARA_E2E_SCRIPTED_MODEL=1", () => {
    expect(isScriptedE2EModelAdmissible({ policyScope: "qualification", environment: {} })).toBe(true);
    expect(isScriptedE2EModelAdmissible({ policyScope: "standard", environment: { ROVARA_E2E_SCRIPTED_MODEL: "1" } })).toBe(true);
    expect(isScriptedE2EModelAdmissible({ policyScope: "standard", environment: {} })).toBe(false);
    expect(isScriptedE2EModelAdmissible({ policyScope: "standard", environment: { ROVARA_E2E_SCRIPTED_MODEL: "true" } })).toBe(false);
    expect(isScriptedE2EModelAdmissible({ policyScope: "standard", environment: { ROVARA_E2E_SCRIPTED_MODEL: "0" } })).toBe(false);
  });

  it("picks the snapshot node whose accessible name matches the regex, keyed by the goal digest", async () => {
    const route = routeFor({ [sha(GOAL)]: [{ kind: "tap", name: /^export orders$/i }, { kind: "done" }] });
    const first = await route.generate(channelRequest({ callOverride: call(SNAPSHOT) }));
    expect(first.receipt).toMatchObject({ outcome: "ok", provider: "rovara-scripted", routeId: "rovara-scripted/v1" });
    expect(first.result).toMatchObject({ status: "ok", content: [{ type: "tool-call", toolName: "tap", input: JSON.stringify({ target: "n1" }) }], finishReason: { unified: "tool-calls" } });
  });

  it("follows the script by how many tool calls the prompt already holds, so a re-sent turn gets the same answer", async () => {
    const route = routeFor({ [sha(GOAL)]: [{ kind: "tap", name: /export/i }, { kind: "type", name: /file name/i, value: "orders.csv" }, { kind: "done", summary: "All done." }] });
    const typed = await route.generate(channelRequest({ callOverride: call(SNAPSHOT, { typed: "x" }) }));
    // One earlier assistant tool call in the prompt: the second scripted turn.
    expect(typed.result).toMatchObject({ status: "ok", content: [{ toolName: "type", input: JSON.stringify({ target: "n2", value: "orders.csv" }) }] });
    const again = await route.generate(channelRequest({ callIndex: 1, callOverride: call(SNAPSHOT, { typed: "x" }) }));
    expect(again.result).toEqual(typed.result);
  });

  it("declares done without acting for the negative tests", async () => {
    const route = routeFor({ [sha(GOAL)]: [{ kind: "done", summary: "Nothing to do." }] });
    const { result } = await route.generate(channelRequest({ callOverride: call(SNAPSHOT) }));
    expect(result).toMatchObject({ status: "ok", content: [{ type: "tool-call", toolName: "complete_step" }] });
    const content = (result as { content: Array<{ input: string }> }).content;
    expect(JSON.parse(content[0]!.input)).toEqual({ status: "passed", summary: "Nothing to do." });
  });

  it("can pick a wrong node on purpose", async () => {
    const route = routeFor({ [sha(GOAL)]: [{ kind: "tap", name: /delete all/i }] });
    const { result } = await route.generate(channelRequest({ callOverride: call(SNAPSHOT) }));
    expect(JSON.parse((result as { content: Array<{ input: string }> }).content[0]!.input)).toEqual({ target: "n3" });
  });

  it("answers provider-error for a goal with no script, a tap with no matching node, and an outage turn", async () => {
    const none = await routeFor({}).generate(channelRequest({ callOverride: call(SNAPSHOT) }));
    expect(none.result).toMatchObject({ status: "error", code: "provider-error" });
    const nomatch = await routeFor({ [sha(GOAL)]: [{ kind: "tap", name: /no such button/ }] }).generate(channelRequest({ callOverride: call(SNAPSHOT) }));
    expect(nomatch.result).toMatchObject({ status: "error", code: "provider-error" });
    const outage = await routeFor({ [sha(GOAL)]: [{ kind: "fail", message: "scripted outage" }] }).generate(channelRequest({ callOverride: call(SNAPSHOT) }));
    expect(outage.result).toMatchObject({ status: "error", code: "provider-error" });
  });

  it("runs the other tools the toolset has, and its answers are valid channel responses", async () => {
    const route = routeFor({ [sha(GOAL)]: [
      { kind: "press", name: /file name/i, key: "Enter" }, { kind: "select", name: /file name/i, value: "CSV" },
      { kind: "scroll", direction: "down" }, { kind: "navigate", url: "/orders" },
    ] });
    const inputs: unknown[] = [];
    for (let index = 0; index < 4; index += 1) {
      const callWithHistory = call(SNAPSHOT);
      callWithHistory.tools = ["tap", "type", "press", "select", "scroll", "navigate", "complete_step"].map((name) => ({ type: "function" as const, name: name as "tap", inputSchema: { type: "object" } }));
      for (let earlier = 0; earlier < index; earlier += 1) {
        callWithHistory.prompt.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${earlier}`, toolName: "tap", input: { target: "n1" } }] });
        callWithHistory.prompt.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${earlier}`, toolName: "tap", output: { type: "text", value: "Tapped." } }] });
      }
      const { result, receipt } = await route.generate(channelRequest({ callIndex: index, callOverride: callWithHistory }));
      expect(E2EModelChannelResponseSchema.safeParse({ schemaVersion: "rovara-e2e-model-channel/v1", receiptId: receipt.receiptId, result }).success).toBe(true);
      inputs.push(JSON.parse((result as { content: Array<{ input: string }> }).content[0]!.input));
    }
    expect(inputs).toEqual([{ target: "n2", key: "Enter" }, { target: "n2", value: "CSV" }, { direction: "down" }, { url: "/orders" }]);
  });
});
