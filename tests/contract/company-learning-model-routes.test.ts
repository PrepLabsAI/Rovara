// DEC 254zzz63: GET/PUT /v1/dev/company/learning-model through the real developer dispatcher, the real membership reader and the SDK double (mirrors company-engine-model-routes.test.ts).
// Two companies throughout: the company is always the caller's live membership; the list is the gateway's for THAT company, Claude models only; refusals are fixed words with no echo.
import { describe, expect, it, vi } from "vitest";
import { CORE_LEARNING_MODEL_DEFAULT, CompanyLearningModelViewSchema, type OrgId } from "@agentx/contracts";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import {
  LEARNING_MODEL_ADMIN_ONLY, LEARNING_MODEL_BODY_INVALID, LEARNING_MODEL_LIST_UNAVAILABLE, LEARNING_MODEL_NOT_OFFERED_TO_COMPANY, LEARNING_MODEL_SETTING_UNAVAILABLE,
} from "../../packages/broker/src/aws/company-learning-model-routes.js";
import { companyLearningModelKey, readCompanyLearningModel } from "../../packages/broker/src/core-host/company-learning-model.js";
import { offeredAnswer } from "../support/offered-models-fake.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";

const PERSON_B = "e".repeat(64);
const PATH = "/v1/dev/company/learning-model";
const SONNET = "claude-sonnet-5-5";
const HAIKU = CORE_LEARNING_MODEL_DEFAULT;
type Answer = Record<string, unknown> & { error: { code: string; message: string } };

function world(options: { lists?: Record<string, string[] | "fail" | "malformed">; install?: string | undefined; wired?: boolean } = {}) {
  const h = companyRouteHarness();
  const lists: Record<string, string[] | "fail" | "malformed"> = options.lists ?? { [A]: [SONNET, "zai.glm-5", "us.anthropic.claude-sonnet-4-6-v1:0", HAIKU], [B]: ["claude-haiku-4-5", SONNET] };
  const offered = vi.fn(async (companyId: OrgId) => {
    const list = lists[companyId];
    if (list === undefined || list === "fail") throw new Error("https://gateway.internal/v1/service refused");
    if (list === "malformed") return { version: 1, models: [] };
    return offeredAnswer(list);
  });
  const logs: Array<Record<string, unknown>> = [];
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  if (options.wired !== false) h.deps.developer.companyLearningModel = { offered, installModel: () => ("install" in options ? options.install : HAIKU), log: (entry) => logs.push(entry) };
  const as = (personId: string, companyId: string, role: "owner" | "admin" | "member" = "owner", extra: Record<string, unknown> = {}) => {
    h.db.set({ ...membershipKey(personId), entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: TIME, ...extra });
    h.db.set({ pk: `SESSION#session-${personId}`, sk: "META", developerId: personId, amr: "slack", startedAt: TIME, endsAt: Date.parse(TIME) / 1000 + 86_400 });
    h.db.set({ pk: `DEVELOPER#${personId}`, sk: "META", displayName: personId === PERSON ? "Ada Owner" : "Bea Admin" });
    h.claims.sub = personId; h.claims.sid = `session-${personId}`;
  };
  as(PERSON, A);
  const call = async (method: string, body?: unknown, path = PATH) => {
    const answer = await h.read(path, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Answer, raw: answer.body };
  };
  const audits = () => h.db.find((item) => item["entityType"] === "COMPANY_LEARNING_MODEL_AUDIT");
  const settingOf = (companyId: string) => readCompanyLearningModel({ get: async (key) => h.db.get(key.pk, key.sk) }, companyId);
  return { h, as, call, offered, logs, audits, settingOf };
}

const viewOf = (body: Answer) => { const { requestId: _r, ...rest } = body; void _r; return CompanyLearningModelViewSchema.parse(rest); };

describe("GET /v1/dev/company/learning-model", () => {

  it("preselects the first offered Claude model when the default is not offered, and null when no Claude model is offered", async () => {
    expect(viewOf((await world({ lists: { [A]: ["zai.glm-5", SONNET] } }).call("GET")).body)).toEqual({ model: HAIKU, source: "install", offered: [SONNET], preselect: SONNET });
    expect(viewOf((await world({ lists: { [A]: ["zai.glm-5"] } }).call("GET")).body)).toEqual({ model: HAIKU, source: "install", offered: [], preselect: null });
    expect(viewOf((await world({ install: undefined, lists: { [A]: [SONNET] } }).call("GET")).body)).toEqual({ model: null, source: "install", offered: [SONNET], preselect: SONNET });
  });

  it("any member reads; a list that cannot be read, or is not the contract, is a fixed 503 (never a guess)", async () => {
    const w = world({ lists: { [A]: "fail" } });
    w.as(PERSON, A, "member");
    const failed = await w.call("GET");
    expect(failed.status).toBe(503);
    expect(failed.body.error.message).toBe(LEARNING_MODEL_LIST_UNAVAILABLE);
    expect(failed.raw).not.toMatch(/gateway\.internal|refused/u);
    expect((await world({ lists: { [A]: "malformed" } }).call("GET")).body.error.message).toBe(LEARNING_MODEL_LIST_UNAVAILABLE);
  });

  it("an unreadable setting row (another company's, or not a Claude model) is a fixed 503", async () => {
    for (const row of [{ orgId: B, model: SONNET }, { orgId: A, model: "zai.glm-5" }]) {
      const w = world();
      w.h.db.set({ ...companyLearningModelKey(A), entityType: "COMPANY_LEARNING_MODEL", version: 1, updatedAt: TIME, updatedBy: PERSON, ...row });
      const read = await w.call("GET");
      expect(read.status).toBe(503);
      expect(read.body.error.message).toBe(LEARNING_MODEL_SETTING_UNAVAILABLE);
    }
  });

  it("is unknown where the model gateway is not wired, and needs a live, unrevoked membership", async () => {
    expect((await world({ wired: false }).call("GET")).status).toBe(404);
    const w = world();
    w.as(PERSON, A, "owner", { revokedAt: TIME });
    expect((await w.call("GET")).status).toBe(401);
    expect(w.offered).not.toHaveBeenCalled();
  });

  it("refuses other methods", async () => {
    const w = world();
    for (const method of ["POST", "DELETE"]) expect((await w.call(method, {})).status).toBe(404);
  });
});

describe("PUT /v1/dev/company/learning-model", () => {

  it("an admin may set it; a member may not (fixed 403, nothing read from the gateway or written)", async () => {
    const admin = world();
    admin.as(PERSON, A, "admin");
    expect((await admin.call("PUT", { model: SONNET })).status).toBe(200);
    const member = world();
    member.as(PERSON, A, "member");
    const refused = await member.call("PUT", { model: SONNET });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(LEARNING_MODEL_ADMIN_ONLY);
    expect(member.offered).not.toHaveBeenCalled();
    expect(await member.settingOf(A)).toBeUndefined();
    expect(member.audits()).toEqual([]);
  });

  it("a Claude model the gateway does not offer THIS company is refused (fixed words, no echo), even when another company is offered it; nothing is written", async () => {
    const w = world();
    const refused = await w.call("PUT", { model: "claude-haiku-4-5" });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(LEARNING_MODEL_NOT_OFFERED_TO_COMPANY);
    expect(refused.raw).not.toContain("haiku-4");
    expect(w.offered.mock.calls).toEqual([[A]]);
    expect(await w.settingOf(A)).toBeUndefined();
    expect(w.audits()).toEqual([]);
  });

  it.each([
    ["no body", undefined],
    ["not JSON", "{not json"],
  ])("refuses %s in fixed words, without echoing it, before the gateway is asked", async (_label, body) => {
    const w = world();
    const refused = await w.call("PUT", body);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(LEARNING_MODEL_BODY_INVALID);
    expect(refused.raw).not.toMatch(/script|org_bbbb/u);
    expect(w.offered).not.toHaveBeenCalled();
    expect(await w.settingOf(B)).toBeUndefined();
  });

  it("null clears the company's own model (the install default applies again), audited with the previous model", async () => {
    const w = world();
    await w.call("PUT", { model: SONNET });
    const cleared = await w.call("PUT", { model: null });
    expect(cleared.status).toBe(200);
    expect(viewOf(cleared.body)).toMatchObject({ model: HAIKU, source: "install", preselect: HAIKU });
    expect(await w.settingOf(A)).toBeUndefined();
    expect(w.audits().map((row) => [row["action"], row["model"], row["previousModel"]])).toEqual(expect.arrayContaining([["set", SONNET, null], ["clear", null, SONNET]]));
  });
});

describe("two companies", () => {
  it("A sets X; B's read still shows the install default with B's own list; A's read never shows B's; a body naming B is refused", async () => {
    const w = world();
    expect((await w.call("PUT", { model: SONNET })).status).toBe(200);
    w.as(PERSON_B, B, "admin");
    const b = await w.call("GET");
    expect(viewOf(b.body)).toEqual({ model: HAIKU, source: "install", offered: ["claude-haiku-4-5", SONNET], preselect: "claude-haiku-4-5" });
    expect((await w.call("PUT", { model: "claude-haiku-4-5" })).status).toBe(200);
    expect(await w.settingOf(A)).toBe(SONNET);
    expect(await w.settingOf(B)).toBe("claude-haiku-4-5");
    w.as(PERSON, A, "admin");
    const a = await w.call("GET", undefined, `${PATH}?companyId=${B}`);
    expect(viewOf(a.body)).toEqual({ model: SONNET, source: "company", offered: [SONNET, HAIKU], preselect: SONNET });
    expect(a.raw).not.toContain("haiku-4");
    expect((await w.call("PUT", { model: HAIKU, companyId: B })).status).toBe(400);
    expect(await w.settingOf(B)).toBe("claude-haiku-4-5");
    expect(w.offered.mock.calls.map(([company]) => company)).toEqual([A, B, B, A]);
    expect(w.audits().every((row) => row["pk"] === `ORG#${row["orgId"] as string}#LEARNING_MODEL_AUDIT`)).toBe(true);
  });
});
