// Guided onboarding PR 14 (DEC 254n item 1): GET/PUT /v1/dev/company/engine-model through the real developer dispatcher, the real membership reader and the SDK double.
// Two companies throughout: the company is always the caller's live membership; the list is the gateway's for THAT company; refusals are fixed words with no echo.
import { describe, expect, it, vi } from "vitest";
import { CompanyEngineModelViewSchema, type OrgId } from "@agentx/contracts";
import { companyRouteHarness, PERSON, TIME } from "../support/company-route-harness.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import {
  ENGINE_MODEL_ADMIN_ONLY, ENGINE_MODEL_BODY_INVALID, ENGINE_MODEL_LIST_UNAVAILABLE, ENGINE_MODEL_NOT_OFFERED_TO_COMPANY, ENGINE_MODEL_SETTING_UNAVAILABLE,
} from "../../packages/broker/src/aws/company-engine-model-routes.js";
import { companyEngineModelKey, readCompanyEngineModel } from "../../packages/broker/src/core-host/company-engine-model.js";
import { offeredAnswer } from "../support/offered-models-fake.js";
import { COMPANY_A_ID as A, COMPANY_B_ID as B } from "../../packages/testing/src/isolation/two-company.js";

const PERSON_B = "e".repeat(64);
const PATH = "/v1/dev/company/engine-model";
type Answer = Record<string, unknown> & { error: { code: string; message: string } };

function world(options: { lists?: Record<string, string[] | "fail" | "malformed">; install?: string | undefined; wired?: boolean } = {}) {
  const h = companyRouteHarness();
  const lists: Record<string, string[] | "fail" | "malformed"> = options.lists ?? { [A]: ["claude-sonnet-5-5", "zai.glm-5", "qwen.qwen3-coder-480b-a35b-v1:0"], [B]: ["claude-haiku-5-5", "claude-sonnet-5-5"] };
  const offered = vi.fn(async (companyId: OrgId) => {
    const list = lists[companyId];
    if (list === undefined || list === "fail") throw new Error("https://gateway.internal/v1/service refused");
    if (list === "malformed") return { version: 1, models: [] };
    return offeredAnswer(list);
  });
  const logs: Array<Record<string, unknown>> = [];
  h.deps.companies = companyMembershipFromDynamo(h.db, "SignIn");
  if (options.wired !== false) h.deps.developer.companyEngineModel = { offered, installModel: () => ("install" in options ? options.install : "claude-sonnet-5-5"), log: (entry) => logs.push(entry) };
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
  const audits = () => h.db.find((item) => item["entityType"] === "COMPANY_ENGINE_MODEL_AUDIT");
  const settingOf = (companyId: string) => readCompanyEngineModel({ get: async (key) => h.db.get(key.pk, key.sk) }, companyId as OrgId);
  return { h, as, call, offered, logs, audits, settingOf };
}

const viewOf = (body: Answer) => { const { requestId: _r, ...rest } = body; void _r; return CompanyEngineModelViewSchema.parse(rest); };

describe("GET /v1/dev/company/engine-model", () => {
  it("a company without its own model reads the install default, the gateway's list for ITS company, and preselects the default when offered", async () => {
    const w = world();
    const read = await w.call("GET");
    expect(read.status).toBe(200);
    expect(viewOf(read.body)).toEqual({ model: "claude-sonnet-5-5", source: "install", offered: ["claude-sonnet-5-5", "zai.glm-5", "qwen.qwen3-coder-480b-a35b-v1:0"], preselect: "claude-sonnet-5-5" });
    expect(w.offered.mock.calls).toEqual([[A]]);
  });

  it("preselects the best offered (the gateway's first) when the default is not offered, or there is none", async () => {
    const w = world({ lists: { [A]: ["zai.glm-5", "claude-haiku-5-5"] } });
    expect(viewOf((await w.call("GET")).body)).toMatchObject({ model: "claude-sonnet-5-5", source: "install", preselect: "zai.glm-5" });
    const none = world({ install: undefined, lists: { [A]: ["zai.glm-5"] } });
    expect(viewOf((await none.call("GET")).body)).toEqual({ model: null, source: "install", offered: ["zai.glm-5"], preselect: "zai.glm-5" });
  });

  it("any member reads; a list that cannot be read, or is not the contract, is a fixed 503 (never a guess)", async () => {
    const w = world({ lists: { [A]: "fail" } });
    w.as(PERSON, A, "member");
    const failed = await w.call("GET");
    expect(failed.status).toBe(503);
    expect(failed.body.error.message).toBe(ENGINE_MODEL_LIST_UNAVAILABLE);
    expect(failed.raw).not.toMatch(/gateway\.internal|refused/u);
    const malformed = world({ lists: { [A]: "malformed" } });
    expect((await malformed.call("GET")).body.error.message).toBe(ENGINE_MODEL_LIST_UNAVAILABLE);
  });

  it("an unreadable setting row (not exactly this company's) is a fixed 503", async () => {
    const w = world();
    w.h.db.set({ ...companyEngineModelKey(A as OrgId), entityType: "COMPANY_ENGINE_MODEL", orgId: B, version: 1, model: "zai.glm-5", updatedAt: TIME, updatedBy: PERSON });
    const read = await w.call("GET");
    expect(read.status).toBe(503);
    expect(read.body.error.message).toBe(ENGINE_MODEL_SETTING_UNAVAILABLE);
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

describe("PUT /v1/dev/company/engine-model", () => {
  it("an owner sets a model the gateway offers the company: stored under the company's own key, audited with the person, logged, and read back as source company", async () => {
    const w = world();
    const set = await w.call("PUT", { model: "zai.glm-5" });
    expect(set.status).toBe(200);
    expect(viewOf(set.body)).toEqual({ model: "zai.glm-5", source: "company", offered: ["claude-sonnet-5-5", "zai.glm-5", "qwen.qwen3-coder-480b-a35b-v1:0"], preselect: "zai.glm-5" });
    expect(await w.settingOf(A)).toBe("zai.glm-5");
    expect(w.h.db.get(`ORG#${A}#SETTINGS`, "ENGINE_MODEL")).toMatchObject({ entityType: "COMPANY_ENGINE_MODEL", orgId: A, model: "zai.glm-5", updatedBy: PERSON });
    expect(w.audits()).toEqual([expect.objectContaining({ pk: `ORG#${A}#ENGINE_MODEL_AUDIT`, orgId: A, action: "set", model: "zai.glm-5", previousModel: null, personId: PERSON })]);
    expect(w.logs).toEqual([{ companyId: A, event: "company.engine_model_set", actor: PERSON }]);
    expect(viewOf((await w.call("GET")).body)).toMatchObject({ model: "zai.glm-5", source: "company" });
  });

  it("an admin may set it; a member may not (fixed 403, nothing read from the gateway or written)", async () => {
    const admin = world();
    admin.as(PERSON, A, "admin");
    expect((await admin.call("PUT", { model: "zai.glm-5" })).status).toBe(200);
    const member = world();
    member.as(PERSON, A, "member");
    const refused = await member.call("PUT", { model: "zai.glm-5" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(ENGINE_MODEL_ADMIN_ONLY);
    expect(member.offered).not.toHaveBeenCalled();
    expect(await member.settingOf(A)).toBeUndefined();
    expect(member.audits()).toEqual([]);
  });

  it("a model the gateway does not offer THIS company is refused (fixed words, no echo), even when another company is offered it; nothing is written", async () => {
    const w = world();
    const refused = await w.call("PUT", { model: "claude-haiku-5-5" });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(ENGINE_MODEL_NOT_OFFERED_TO_COMPANY);
    expect(refused.raw).not.toContain("haiku");
    expect(w.offered.mock.calls).toEqual([[A]]);
    expect(await w.settingOf(A)).toBeUndefined();
    expect(w.audits()).toEqual([]);
  });

  it("a list that cannot be read changes nothing (fixed 503)", async () => {
    const w = world({ lists: { [A]: "fail" } });
    const refused = await w.call("PUT", { model: "zai.glm-5" });
    expect(refused.status).toBe(503);
    expect(refused.body.error.message).toBe(ENGINE_MODEL_LIST_UNAVAILABLE);
    expect(await w.settingOf(A)).toBeUndefined();
    expect(w.audits()).toEqual([]);
  });

  it.each([
    ["no body", undefined],
    ["not JSON", "{not json"],
    ["no model", {}],
    ["a malformed model", { model: "has space<script>" }],
    ["a Claude-like name that is not an engine name", { model: "anthropic-opus" }],
    ["a company named in the body", { model: "zai.glm-5", companyId: B }],
    ["an extra field", { model: "zai.glm-5", source: "company" }],
  ])("refuses %s in fixed words, without echoing it, before the gateway is asked", async (_label, body) => {
    const w = world();
    const refused = await w.call("PUT", body);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(ENGINE_MODEL_BODY_INVALID);
    expect(refused.raw).not.toMatch(/script|org_bbbb|anthropic-opus/u);
    expect(w.offered).not.toHaveBeenCalled();
    expect(await w.settingOf(B)).toBeUndefined();
  });

  it("null clears the company's own model (the install default applies again), audited with the previous model", async () => {
    const w = world();
    await w.call("PUT", { model: "zai.glm-5" });
    const cleared = await w.call("PUT", { model: null });
    expect(cleared.status).toBe(200);
    expect(viewOf(cleared.body)).toMatchObject({ model: "claude-sonnet-5-5", source: "install", preselect: "claude-sonnet-5-5" });
    expect(await w.settingOf(A)).toBeUndefined();
    expect(w.audits().map((row) => [row["action"], row["model"], row["previousModel"]])).toEqual(expect.arrayContaining([["set", "zai.glm-5", null], ["clear", null, "zai.glm-5"]]));
  });
});

describe("two companies", () => {
  it("A sets X; B's read still shows the install default with B's own list; A's read never shows B's; A's admin cannot reach B's setting", async () => {
    const w = world();
    expect((await w.call("PUT", { model: "zai.glm-5" })).status).toBe(200);
    // B's admin: B's list, the install default, nothing of A's.
    w.as(PERSON_B, B, "admin");
    const b = await w.call("GET");
    expect(viewOf(b.body)).toEqual({ model: "claude-sonnet-5-5", source: "install", offered: ["claude-haiku-5-5", "claude-sonnet-5-5"], preselect: "claude-sonnet-5-5" });
    expect(b.raw).not.toContain("glm");
    // B sets its own; A's stays A's.
    expect((await w.call("PUT", { model: "claude-haiku-5-5" })).status).toBe(200);
    expect(await w.settingOf(A)).toBe("zai.glm-5");
    expect(await w.settingOf(B)).toBe("claude-haiku-5-5");
    // Back to A: A's read is A's, never B's; a body naming B is refused, and the query string names nothing.
    w.as(PERSON, A, "admin");
    const a = await w.call("GET", undefined, `${PATH}?companyId=${B}`);
    expect(viewOf(a.body)).toEqual({ model: "zai.glm-5", source: "company", offered: ["claude-sonnet-5-5", "zai.glm-5", "qwen.qwen3-coder-480b-a35b-v1:0"], preselect: "zai.glm-5" });
    expect((await w.call("PUT", { model: "claude-haiku-5-5", companyId: B })).status).toBe(400);
    expect(await w.settingOf(B)).toBe("claude-haiku-5-5");
    // Every gateway read named the caller's own company.
    expect(w.offered.mock.calls.map(([company]) => company)).toEqual([A, B, B, A]);
    expect(w.audits().map((row) => row["orgId"])).toEqual(expect.arrayContaining([A, B]));
    expect(w.audits().every((row) => row["pk"] === `ORG#${row["orgId"] as string}#ENGINE_MODEL_AUDIT`)).toBe(true);
  });
});
