// B8, the "runs alone" rule across two gateway tasks: an overrun-capable stage call (media) never runs beside another call of the same
// stage, even when the stage's held cost has room for both, so the stage passes its hold by at most that one call (DEC 165).
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import { InMemoryMeter } from "../../packages/model-gateway/src/meter.js";
import { EVAL_HOLD_PATH, EVAL_SCOPE_HEADER, InMemoryEvalStageStore, ProductEvalStages, type EvalApproval } from "../../packages/model-gateway/src/product-eval.js";
import { handleGateway } from "../../packages/model-gateway/src/server.js";
import { MemorySink, mint, now } from "./model-gateway-fixture.js";
import { change, cid, geminiAnswer, geminiKey, maintainer, pid, productCall, productGateway, storeKit, streamPath } from "./model-gateway-product-fixture.js";

const approval: EvalApproval = { selection: "s", inputsDigest: "d".repeat(64), maxCalls: 400, maxCostMicros: 4_000_000, approver: { personId: "p1", provider: "github" } };
const grant = { company: cid, project: pid, selection: "s", role: "maintainer", inputsDigest: "d".repeat(64), provider: "customer", connected: true, maxCalls: 400, maxCostMicros: 4_000_000 };
const media = { contents: [{ role: "user", parts: [{ text: "x" }, { inlineData: { mimeType: "image/png", data: "aGk=" } }] }], generationConfig: { maxOutputTokens: 10 } };
const text = { contents: [{ role: "user", parts: [{ text: "x" }] }], generationConfig: { maxOutputTokens: 10 } };

describe("an overrun-capable stage call runs alone, across tasks", () => {
  it("while a media call of the stage is open on one task, no other call of the stage is sent on the other", async () => {
    const kit = storeKit();
    await kit.store.connect({ ...change(pid, 0, maintainer), sourceId: "src_gem", provider: "gemini", key: geminiKey() });
    const store = new InMemoryEvalStageStore();
    const agent = new InMemoryMeter(() => now);
    const product = new InMemoryMeter(() => now, undefined, undefined, { combineCompanyWith: agent });
    let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
    let sent = 0;
    const transport = async () => { sent++; if (sent === 1) await gate; return { status: 200, body: geminiAnswer({ promptTokenCount: 5, candidatesTokenCount: 2 }) }; };
    const task = async () => {
      const stages = new ProductEvalStages({ approvals: { current: async () => approval, roleOf: async () => "maintainer" }, now: () => now, store, waitMs: 1_500 });
      return productGateway({ kit, connect: false, evalStages: stages, productMeter: product, overrides: { meter: agent }, transport, companyCaps: new FixedCapsSource({ task: 1e9, projectMonth: 1e9, companyMonth: 1e9 }) });
    };
    const a = await task(); const b = await task();
    const sink = new MemorySink();
    await handleGateway(a.deps, { method: "POST", url: EVAL_HOLD_PATH, headers: { "content-type": "application/json", "x-api-key": mint() }, body: (async function* () { yield Buffer.from(JSON.stringify({ grant, calls: 10, costMicros: 4_000_000 })); })() }, sink);
    const scope = (JSON.parse(sink.text()) as { scope: string }).scope;
    const first = productCall(a.deps, streamPath, media, mint(), { [EVAL_SCOPE_HEADER]: scope });
    while (sent === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    // The stage has plenty of room, but the open media call may pass it: the other task's call waits, then gives up (busy).
    const second = await productCall(b.deps, streamPath, text, mint(), { [EVAL_SCOPE_HEADER]: scope });
    expect(sent).toBe(1);
    expect(second.text()).toContain('"class":"cap"');
    open();
    await first;
  });
});
