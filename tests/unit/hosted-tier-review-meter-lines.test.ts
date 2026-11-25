// TIER-GROWTH-MERGE (from the Sonnet pre-review's probe): one test per line of the hosted tier review meter (core-host/hosted-tier-review.ts `meter`).
// Each refusal says WHY: `false` is the task's spending limit (admission, no room), "unavailable" is a read that could not be made (nothing is told about a limit).
import { describe, expect, it } from "vitest";
import { hostedTierReview } from "../../packages/broker/src/core-host/hosted-tier-review.js";
import { runPriceFor } from "../support/hosted-run-price.js";
import { signingWorld } from "../support/model-gateway.js";

const COMPANY = "org_corehost00000000000a";
const MODEL = "claude-sonnet-4-6";
const signer = signingWorld().signer;
const price = { ...runPriceFor(MODEL), companyId: COMPANY };
const OPEN = { pk: "TASK#t1", sk: "TASK", taskId: "t1", companyId: COMPANY, project: "demo", workflow: { stage: "WAIT_FOR_MERGE" } };

function meterOf(input: { task?: Record<string, unknown>; admit?: boolean; room?: number; quote?: boolean; alias?: string | undefined }) {
  const task = { ...OPEN, ...(input.task ?? {}) };
  const flow = { store: { get: async () => task, query: async () => ({ items: [] }), put: async () => undefined, delete: async () => undefined }, companyId: COMPANY, admission: { admit: async () => ({ allowed: input.admit !== false }) }, modelAccess: { route: async () => (input.alias === undefined && "alias" in input ? undefined : { alias: input.alias ?? MODEL }) } };
  const fetchStub = (async () => (input.quote === false ? new Response("{}", { status: 503 }) : Response.json({ runPrice: { ...price, expiresAt: Date.now() + 300_000 } }))) as unknown as typeof fetch;
  return hostedTierReview({
    env: { ROVARA_CORE_MODEL_GATEWAY_URL: "https://gateway.example", ROVARA_CORE_AGENT_MODEL: MODEL }, taskTokens: () => ({ signer, issuer: "https://api.example/v1/auth" }), flow: flow as never, companyId: COMPANY, now: () => new Date(),
    taskRoomUsd: async () => input.room ?? 5, booking: { bookUsageReport: async () => true }, fetch: fetchStub,
  })!.meter;
}
const ask = (meter: ReturnType<typeof meterOf>) => meter({ taskId: "t1", purpose: "code_review", model: undefined, promptChars: 1_000 });

describe("the hosted tier review meter: every line refuses on its own", () => {
  it("lets a call through only when everything holds (control)", async () => { expect(await ask(meterOf({}))).toBe(true); });
  it("refuses another company's task", async () => { expect(await ask(meterOf({ task: { companyId: "org_other0000000000000b" } }))).toBe("unavailable"); });
  it("refuses a closed task", async () => { expect(await ask(meterOf({ task: { closedAt: "2026-11-25T00:00:00.000Z" } }))).toBe("unavailable"); });
  it("refuses a released task", async () => { expect(await ask(meterOf({ task: { releasedAt: "2026-11-25T00:00:00.000Z" } }))).toBe("unavailable"); });
  it("refuses a task that is CLOSED or MERGED", async () => {
    expect(await ask(meterOf({ task: { workflow: { stage: "MERGED" } } }))).toBe("unavailable");
    expect(await ask(meterOf({ task: { workflow: { stage: "CLOSED" } } }))).toBe("unavailable");
  });
  it("refuses a task with no workflow", async () => { expect(await ask(meterOf({ task: { workflow: undefined } }))).toBe("unavailable"); });
  it("refuses when the admission does not let a run start", async () => { expect(await ask(meterOf({ admit: false }))).toBe(false); });
  it("refuses when the task has no room (0) or unknown room", async () => {
    expect(await ask(meterOf({ room: 0 }))).toBe(false);
    expect(await ask(meterOf({ room: Number.NaN }))).toBe(false);
  });
  it("refuses when the gateway's price cannot be read", async () => { expect(await ask(meterOf({ quote: false }))).toBe("unavailable"); });
  it("refuses when no model can be named", async () => { expect(await ask(meterOf({ alias: undefined }))).toBe("unavailable"); });
});
