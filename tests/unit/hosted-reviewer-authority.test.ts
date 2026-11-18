import { describe, expect, it, vi } from "vitest";
import { agentGuardrailsKey, DEFAULT_AGENT_GUARDRAILS, type JsonValue } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { hostedAutonomy, reviewerAuthority } from "../../packages/broker/src/core-host/reviewer-authority.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa", B = "org_bbbbbbbbbbbbbbbbbbbb";
const models = [{ model: "claude-sonnet-4-6", provider: "anthropic" }, { model: "openai.gpt-oss-120b-1:0", provider: "bedrock" }];
const answer = (companyId = A, companyLimitUsd = 5) => ({ version: 1, models: models.map(({ model }) => ({ model })), reviewerAccess: { companyId, companyLimitUsd, models } });

describe("hosted reviewer authority", () => {
  it("requires this company's gateway attestation and a positive company limit", async () => {
    const offered = vi.fn(async () => answer());
    expect(await reviewerAuthority({ companyId: A, offered })).toMatchObject({ companyLimitUsd: 5, models });
    expect(offered).toHaveBeenCalledWith(A);
    for (const value of [answer(B), answer(A, 0), answer(A, -1), { version: 1, models: [{ model: models[0]!.model }] }, null]) {
      expect(await reviewerAuthority({ companyId: A, offered: async () => value })).toBeUndefined();
    }
    expect(await reviewerAuthority({ companyId: A, offered: async () => { throw new Error("private-canary"); } })).toBeUndefined();
  });
  it("refuses a connected-model claim absent from the offered list", async () => {
    const value = answer(); value.models.pop();
    expect(await reviewerAuthority({ companyId: A, offered: async () => value })).toBeUndefined();
  });
  it("reads only the task company's autonomy and asks on unknown, malformed or failed reads", async () => {
    const h = createHarness();
    await h.store.put({ item: { ...agentGuardrailsKey(A), revision: 1, guardrails: JSON.parse(JSON.stringify({ ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "prepare" })) as JsonValue } });
    await h.store.put({ item: { ...agentGuardrailsKey(B), revision: 1, guardrails: JSON.parse(JSON.stringify({ ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "suggest" })) as JsonValue } });
    const absent = hostedAutonomy({ store: createHarness().store, companyId: A });
    expect(await absent({ companyId: A } as never)).toEqual({ autonomy: "suggest", unreadable: true });
    const autonomy = hostedAutonomy({ store: h.store, companyId: A });
    expect(await autonomy({ companyId: A } as never)).toEqual({ autonomy: "prepare" });
    expect(await autonomy({ companyId: B } as never)).toEqual({ autonomy: "suggest", noCompany: true });
    await h.store.put({ item: { ...agentGuardrailsKey(A), revision: 1, guardrails: JSON.parse(JSON.stringify({ ...DEFAULT_AGENT_GUARDRAILS, maxAutonomy: "unknown" })) as JsonValue } });
    expect(await autonomy({ companyId: A } as never)).toEqual({ autonomy: "suggest", unreadable: true });
    h.deps.store.get = async () => { throw new Error("private-canary"); };
    expect(await autonomy({ companyId: A } as never)).toEqual({ autonomy: "suggest", unreadable: true });
  });
});
