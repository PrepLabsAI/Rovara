// Lane W (contract v0 client.projects.codeSettings.*): a project's merge rules on the deployed developer API, in Code's own CodeSettings shape (the one the merge core enforces).
// Company-scoped records; another company's project looks missing; loosening a rule needs the same role as any change (DEC 254zzz73: no step-up); a stale revision is refused in Code's fixed words.
import { describe, expect, it, vi } from "vitest";
import { AgentXError, CODE_SETTINGS_STALE_MESSAGE, DEFAULT_CODE_SETTINGS, IMPLICIT_COMPANY_ID, ON_THE_WEBSITE_MESSAGE } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { CODE_SETTINGS_BODY, NOT_A_PROJECT_ADMIN, codeSettingsKey, codeSettingsReader, loosens } from "../../packages/broker/src/aws/project-code-settings.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { companyProjectRow } from "../support/company-layout-projects.js";

const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const ADA = "a".repeat(64);
const BEN = "b".repeat(64);
const CAL = "c".repeat(64);
const REQUEST = "0b9f1c3e-7a51-4c1e-9d55-0f3a4b6c7d8e";
const CANARY = "leak-canary-31";
const PATH = (project = "alpha") => `/v1/dev/client/projects/${project}/code-settings`;

function harness(options: { companies?: boolean; fullAccess?: boolean; webApp?: boolean } = {}) {
  const db = new FakeDynamoDb({ seed: 3 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ADA, sid: "s-ada", amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, installLevel: true, secretHash: "f".repeat(64), ...(options.fullAccess === false ? {} : { fullAccess: true }),
    // Owner DEC 254zzz91: the operator-marked Rovara website client by default (loosening a merge rule is its act alone).
    ...(options.fullAccess === false || options.webApp === false ? {} : { webApp: true }), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  for (const [id, name, sid] of [[ADA, "Ada", "s-ada"], [BEN, "Ben", "s-ben"], [CAL, "Cal", "s-cal"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, revoked: false });
    db.set({ pk: `SESSION#${sid}`, sk: "META", sessionId: sid, developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  }
  // DEC 254zzz80: each person's live company decides where their grants live (a named company's own partition; the implicit company or none: the legacy row).
  const companyOfPerson = new Map<string, string>();
  const join = (id: string, companyId: string, role: "admin" | "member") => (companyOfPerson.set(id, companyId), db.set({ pk: `COMPANY_MEMBER#${id}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME }));
  const project = (name: string, companyId?: string) => db.set(companyProjectRow(companyId, name, 1)); // DEC 254zzz80: a named company's project in its own partition
  const grantPk = (id: string) => { const companyId = companyOfPerson.get(id); return companyId === undefined || companyId === IMPLICIT_COMPANY_ID ? `MEMBER#${id}` : `ORG#${companyId}#MEMBER#${id}`; };
  const grant = (id: string, name: string, role: "administrator" | "developer") => db.set({ pk: grantPk(id), sk: `PROJECT#${name}`, entityType: "MEMBERSHIP", ownerKey: id, projectName: name, role, grantedAt: TIME });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW,
    ...(options.companies === false ? {} : { companies: companyMembershipFromDynamo(db, "State") }),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
    },
  };
  const jwt = () => { const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"); return `Bearer ${part({ alg: "none" })}.${part(claims)}.sig`; };
  const call = async (method: string, path: string, body?: unknown) => {
    const request = { method, path, headers: { authorization: jwt() }, requestId: "r", ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  const as = (id: string, sid: string) => { claims.sub = id; claims.sid = sid; };
  return { db, claims, deps, call, as, join, project, grant };
}
const error = (code: string, message: string) => ({ error: { code, message } });

describe("reading a project's merge rules", () => {

  it("answers another company's project, a project the person may not use and a missing one alike", async () => {
    const h = harness(); h.join(ADA, COMPANY_A.orgId, "admin");
    h.project("foreign", COMPANY_B.orgId); h.grant(ADA, "foreign", "administrator");
    h.project("closed", COMPANY_A.orgId);
    const missing = { status: 404, body: error("NOT_FOUND", "project not found") };
    for (const project of ["foreign", "closed", "nothing", "%E0%A4%A", CANARY]) {
      expect(await h.call("GET", PATH(project))).toEqual(missing);
      expect(await h.call("PUT", PATH(project), { requestId: REQUEST, expectedRevision: 0, mergeMethod: "merge" })).toEqual(missing);
    }
  });

  it("never applies a record that names another company, and keeps two companies' same-named projects apart", async () => {
    const h = harness(); h.join(ADA, COMPANY_A.orgId, "member"); h.project("alpha", COMPANY_A.orgId); h.grant(ADA, "alpha", "developer");
    h.db.set({ ...codeSettingsKey(COMPANY_B.orgId, "alpha"), companyId: COMPANY_B.orgId, project: "alpha", settings: { allowSelfApproval: true, mergeMethod: "merge", codeReviewers: [], revision: 7 } });
    expect(await h.call("GET", PATH())).toEqual({ status: 200, body: { settings: DEFAULT_CODE_SETTINGS } });
    h.db.set({ ...codeSettingsKey(COMPANY_A.orgId, "alpha"), companyId: COMPANY_B.orgId, project: "alpha", settings: { allowSelfApproval: true, mergeMethod: "merge", codeReviewers: [], revision: 7 } });
    expect(await h.call("GET", PATH())).toEqual({ status: 503, body: error("RUNTIME_UNAVAILABLE", "the project's merge rules could not be read") });
    await expect(codeSettingsReader({ documentClient: h.db, tableName: "State" }).read(COMPANY_A.orgId as never, "alpha")).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(await codeSettingsReader({ documentClient: h.db, tableName: "State" }).read(COMPANY_B.orgId as never, "alpha")).toMatchObject({ allowSelfApproval: true, revision: 7 });
  });
});

describe("changing a project's merge rules", () => {
  it("lets the project's administrator tighten; the merge core's reader sees the saved rules", async () => {
    const h = harness(); h.join(ADA, COMPANY_A.orgId, "member"); h.project("alpha", COMPANY_A.orgId); h.grant(ADA, "alpha", "administrator");
    const saved = await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 0, mergeMethod: "merge", codeReviewers: ["octo-org/core"] });
    expect(saved).toEqual({ status: 200, body: { settings: { allowSelfApproval: false, mergeMethod: "merge", codeReviewers: ["octo-org/core"], revision: 1 } } });
    expect(await h.call("GET", PATH())).toEqual(saved);
    expect(await codeSettingsReader({ documentClient: h.db, tableName: "State" }).read(COMPANY_A.orgId as never, "alpha")).toEqual(saved.body.settings);
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 0, mergeMethod: "squash" })).toEqual({ status: 409, body: error("CHANGE_STALE", CODE_SETTINGS_STALE_MESSAGE) });
  });

  it("DEC 254zzz73: the project's administrator loosens with no step-up; a developer of the project and another company's admin still cannot", async () => {
    const h = harness(); h.join(ADA, COMPANY_A.orgId, "member"); h.join(BEN, COMPANY_A.orgId, "member"); h.project("alpha", COMPANY_A.orgId);
    h.grant(ADA, "alpha", "administrator"); h.grant(BEN, "alpha", "developer");
    await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 0, codeReviewers: ["octo-org/core", "octo-org/sec"] });
    expect(h.claims).not.toHaveProperty("step_up_at");
    // A developer of the project: refused for self-approval on and for a reviewer off, nothing saved.
    h.as(BEN, "s-ben");
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 1, allowSelfApproval: true })).toEqual({ status: 403, body: error("FORBIDDEN", NOT_A_PROJECT_ADMIN) });
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 1, codeReviewers: ["octo-org/core"] })).toEqual({ status: 403, body: error("FORBIDDEN", NOT_A_PROJECT_ADMIN) });
    // Another company's admin (with a forged grant): the project looks missing.
    h.join(CAL, COMPANY_B.orgId, "admin"); h.grant(CAL, "alpha", "administrator"); h.as(CAL, "s-cal");
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 1, allowSelfApproval: true })).toEqual({ status: 404, body: error("NOT_FOUND", "project not found") });
    h.as(ADA, "s-ada");
    expect(await h.call("GET", PATH())).toMatchObject({ body: { settings: { allowSelfApproval: false, revision: 1 } } });
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 1, allowSelfApproval: true, codeReviewers: ["OCTO-ORG/core"] })).toMatchObject({ status: 200, body: { settings: { allowSelfApproval: true, revision: 2 } } });
  });

  it("owner DEC 254zzz91: another full-access client (an AI tool's) tightens and changes the merge method, but loosening is refused with the website words and nothing is saved", async () => {
    const h = harness({ webApp: false }); h.join(ADA, COMPANY_A.orgId, "member"); h.project("alpha", COMPANY_A.orgId); h.grant(ADA, "alpha", "administrator");
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 0, mergeMethod: "merge", codeReviewers: ["octo-org/core"] })).toMatchObject({ status: 200, body: { settings: { revision: 1 } } });
    const website = { status: 403, body: error("FORBIDDEN", ON_THE_WEBSITE_MESSAGE) };
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 1, allowSelfApproval: true })).toEqual(website);
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 1, codeReviewers: [] })).toEqual(website);
    expect(await h.call("GET", PATH())).toMatchObject({ body: { settings: { allowSelfApproval: false, codeReviewers: ["octo-org/core"], revision: 1 } } });
    // The website's own client loosens the same rule.
    const web = harness(); web.join(ADA, COMPANY_A.orgId, "member"); web.project("alpha", COMPANY_A.orgId); web.grant(ADA, "alpha", "administrator");
    expect(await web.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 0, allowSelfApproval: true })).toMatchObject({ status: 200, body: { settings: { allowSelfApproval: true } } });
  });

  it("refuses unknown fields, bad values and a missing revision in fixed words", async () => {
    const h = harness(); h.join(ADA, COMPANY_A.orgId, "member"); h.project("alpha", COMPANY_A.orgId); h.grant(ADA, "alpha", "administrator");
    for (const body of [{ requestId: REQUEST, mergeMethod: "merge" }, { requestId: REQUEST, expectedRevision: 0, mergeRule: CANARY }, { requestId: REQUEST, expectedRevision: 0, mergeMethod: CANARY }, { requestId: REQUEST, expectedRevision: 0, codeReviewers: ["a", "A"] }, { requestId: CANARY, expectedRevision: 0 }]) {
      const answer = await h.call("PUT", PATH(), body);
      expect(answer).toEqual({ status: 400, body: error("CONFIG_INVALID", CODE_SETTINGS_BODY) });
    }
  });

  it("without a company layer: the install's company, and the install administrator or the project's administrator", async () => {
    const h = harness({ companies: false }); h.project("alpha"); h.grant(ADA, "alpha", "administrator");
    expect(await h.call("PUT", PATH(), { requestId: REQUEST, expectedRevision: 0, mergeMethod: "merge" })).toMatchObject({ status: 200 });
    expect(h.db.get(codeSettingsKey(IMPLICIT_COMPANY_ID, "alpha").pk, "CODE_SETTINGS")).toMatchObject({ companyId: IMPLICIT_COMPANY_ID });
  });
});

describe("what counts as loosening", () => {
  it("only self-approval on, or a reviewer taken off (names compared without case)", () => {
    const current = { allowSelfApproval: false, mergeMethod: "squash" as const, codeReviewers: ["Octo/Core"], revision: 3 };
    expect(loosens(current, { ...current, mergeMethod: "merge" })).toBe(false);
    expect(loosens(current, { ...current, codeReviewers: ["octo/core", "x"] })).toBe(false);
    expect(loosens(current, { ...current, allowSelfApproval: true })).toBe(true);
    expect(loosens(current, { ...current, codeReviewers: [] })).toBe(true);
  });
});
