// Lead 4 TA12: every gateway refusal log line carries its fixed reason (code, status, the cap row, the route and the payer), so a refusal that is a spent
// budget can be told apart from a scanner. Fixed words and numbers only: no token, key, prompt or id.
import { denyNetwork } from "./model-gateway-no-network.js";
beforeAll(denyNetwork);
import { beforeAll, describe, expect, it } from "vitest";
import { type AgentAiSource, type AgentAiSourceReader, type RovaraAi } from "../../packages/model-gateway/src/agent-ai.js";
import { FixedCapsSource } from "../../packages/model-gateway/src/caps.js";
import type { LearningKeySource } from "../../packages/model-gateway/src/learning-route.js";
import { logCode, type RefusedLog } from "../../packages/model-gateway/src/server.js";
import { answer, call, caps, claims, mint, requestBody, scope, setup } from "./model-gateway-fixture.js";

const refusals = (logs: readonly unknown[]) => logs.filter((line): line is RefusedLog => (line as { event?: unknown }).event === "refused");
const MODEL = claims.mdl[0]!;
class Keys implements LearningKeySource {
  async connected(): Promise<boolean> { return true; }
  async keyFor(): Promise<string | undefined> { return "customer-key"; }
}
class Choices implements AgentAiSourceReader {
  readonly saved = new Map<string, AgentAiSource>();
  async sourceFor(cid: string): Promise<AgentAiSource | undefined> { return this.saved.get(cid); }
}

describe("gateway refusal log lines carry a fixed reason", () => {
  it("each cap row names itself, with the code, status and route, and no secret", async () => {
    for (const [field, cap] of [["task", "task"], ["personMonth", "person"], ["projectMonth", "project"], ["companyMonth", "company"]] as const) {
      const f = setup({ caps: new FixedCapsSource({ ...caps, [field]: 0 }) });
      const sink = await call(f.deps, { ...requestBody, messages: [{ role: "user", content: "PROMPT-CANARY" }] });
      expect(sink.status).toBe(422);
      expect(refusals(f.logs)).toEqual([{ event: "refused", code: "budget_exceeded", status: 422, cap, route: "agent" }]);
      expect(JSON.stringify(f.logs)).not.toMatch(/PROMPT-CANARY|fixture-|eyJ/u);
    }
  });

  it("a held budget, a bad token, an oversize body and an ended task say which refusal they are", async () => {
    const f = setup({ caps: new FixedCapsSource({ ...caps, task: 250 }) });
    await f.meter.reserve({ scope, caps: { ...caps, task: 250 }, estimateMicros: 200 });
    await call(f.deps);
    await call(f.deps, requestBody, "not-a-token");
    await call(f.deps, Buffer.alloc(4 * 1024 * 1024 + 1));
    f.ended.end(scope.iss, scope.cid, scope.tid); await call(f.deps);
    expect(refusals(f.logs)).toEqual([
      { event: "refused", code: "budget_held", status: 429, route: "agent" },
      { event: "refused", code: "authentication_error", status: 401, route: "agent" },
      { event: "refused", code: "request_too_large", status: 413, route: "agent" },
      { event: "refused", code: "task_ended", status: 403, route: "agent" },
    ]);
  });

  it("a meter busy refusal records only the fixed meter reason", async () => {
    const f = setup();
    f.meter.reserve = async () => ({ ok: false, reason: "busy" });
    await call(f.deps, { ...requestBody, messages: [{ role: "user", content: "PROMPT-CANARY" }] });
    expect(refusals(f.logs)).toEqual([{ event: "refused", code: "unavailable", status: 503, route: "agent", reason: "meter_busy" }]);
    expect(JSON.stringify(f.logs)).not.toContain("PROMPT-CANARY");
  });

  it("a code that is not a fixed lower-case word is logged as other", () => {
    for (const odd of ["Provider said: sk-secret", "", "a".repeat(65), "has space", "UPPER"]) expect(logCode(odd)).toBe("other");
    expect(logCode("budget_exceeded")).toBe("budget_exceeded");
  });

  it("the company-key route names the payer of the refused call (two companies, two payers)", async () => {
    const rovara: RovaraAi = { models: new Map([[MODEL, "us.anthropic.claude-sonnet-4-5-20250929-v1:0"]]), exempt: new Set([claims.cid]), transport: async () => ({ status: 200, body: answer() }) };
    const cidB = `org_${"b".repeat(20)}`;
    const choices = new Choices(); choices.saved.set(claims.cid, "rovara"); choices.saved.set(cidB, "anthropic_key");
    const f = setup({ agentKeys: new Keys(), agentAi: { sources: choices, rovara }, caps: new FixedCapsSource({ ...caps, task: 0 }) });
    await call(f.deps, requestBody, mint({ cid: claims.cid }));
    await call(f.deps, requestBody, mint({ cid: cidB }));
    expect(refusals(f.logs)).toEqual([
      { event: "refused", code: "budget_exceeded", status: 422, cap: "task", route: "agent", payer: "rovara" },
      { event: "refused", code: "budget_exceeded", status: 422, cap: "task", route: "agent", payer: "anthropic_key" },
    ]);
    expect(JSON.stringify(f.logs)).not.toContain("customer-key");
  });
});
