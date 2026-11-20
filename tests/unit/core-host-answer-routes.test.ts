// The smart Just answer route on the deployed API (lead 4, J1): any role on the project asks; anyone else, a missing project, another company's and a malformed name read the same; the body is checked
// after the role; refusals are fixed words with no echo; two companies and two projects never meet; with no model wired the answer is the fixed "not set up" outcome; a script token never reaches it.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ANSWER_WORDS, AgentXError, AnswerResponseSchema, orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { isAnswersPath, routeHostedAnswers, type HostedAnswersWiring } from "../../packages/broker/src/core-host/answer-routes.js";
import { AnswerModelRefused } from "../../packages/broker/src/core/answers/ports.js";
import type { AnswerRepositoryHandle } from "../../packages/broker/src/core/answers/code-source.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";
import { A, B, HEAD, REFUND_TS, T0, answer, goodSentence, scriptedModel, tool } from "../support/answer-world.js";

const PATH = "/v1/app/projects/alpha/answers";
const files: Record<string, Record<string, string>> = { [A]: { "src/refund.ts": REFUND_TS }, [B]: { "src/refund.ts": "export const OTHER_COMPANY = 1;" } };

function handles(companyId: string, calls: string[] = []): AnswerRepositoryHandle[] {
  return [{
    name: "web", defaultBranch: "main", repository: { url: `https://github.com/${companyId}/web.git` }, scope: { orgId: companyId },
    host: {
      baseBranchHead: async () => HEAD,
      fileAtRevision: async (repository, path) => { calls.push(`${companyId}:${repository.url}:${path}`); return files[companyId]?.[path]; },
    },
  }];
}

function setup(standings: Record<string, "view" | "manage"> = {}, projects: Record<string, string[]> = { [A]: ["alpha", "beta"], [B]: ["alpha"] }) {
  const store = new MemoryDocumentStore();
  const calls: string[] = [];
  const standingCalls: string[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const model = scriptedModel([answer([goodSentence])]);
  const wiring: HostedAnswersWiring = {
    standing: async (personId, companyId, project) => { standingCalls.push(`${companyId}/${project}/${personId}`); const access = standings[`${companyId}/${project}/${personId}`]; return access === "manage" ? { access, basis: "company-admin" } : access === "view" ? { access } : { access: "none" }; },
    repositories: async (companyId, project) => (projects[companyId]?.includes(project) ? { handles: handles(companyId, calls), names: ["web"] } : undefined),
    model: () => model,
  };
  const post = async (companyId: OrgId, personId: string, body: unknown, overrides: Partial<HostedAnswersWiring> = {}, path = PATH) => {
    const answerResponse = await routeHostedAnswers({ request: { method: "POST", path, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }, path, personId, companyId, store, wiring: { ...wiring, ...overrides }, now: () => T0, log: (entry) => logs.push(entry) });
    return { status: answerResponse.statusCode, body: JSON.parse(answerResponse.body ?? "{}") as Record<string, unknown>, raw: answerResponse.body ?? "" };
  };
  return { store, post, calls, standingCalls, model, logs };
}
const ask = (extra: Record<string, unknown> = {}) => ({ requestId: `req-${randomUUID().slice(0, 12)}`, question: "How long do refunds last?", ...extra });

describe("the answer route: paths", () => {
  it("serves only POST on /v1/app/projects/{project}/answers", () => {
    expect(isAnswersPath(PATH, "POST")).toBe(true);
    for (const [method, path] of [["GET", PATH], ["PUT", PATH], ["DELETE", PATH], ["POST", "/v1/app/projects/alpha/answers/x"], ["POST", "/v1/app/projects//answers"], ["POST", "/v1/app/projects/alpha/answer"], ["POST", "/v1/app/projects/alpha/wiki/answers"]] as const) {
      expect(isAnswersPath(path, method), `${method} ${path}`).toBe(false);
    }
  });
});

describe("the answer route: who asks", () => {
  it.each([["a project grant (view)", "ada", "view"], ["a company owner or admin (manage)", "owner", "manage"]] as const)("%s asks and gets the answer object", async (_name, person, access) => {
    const w = setup({ [`${A}/alpha/${person}`]: access });
    const result = await w.post(A, person, ask());
    expect(result.status).toBe(200);
    expect(AnswerResponseSchema.parse(result.body)).toMatchObject({ outcome: "answered", text: "Refunds are allowed for 30 days (`MAX_REFUND_DAYS`). [1]", sources: [{ n: 1, repo: "web", path: "src/refund.ts", line: 3, commit: HEAD }] });
    expect(w.standingCalls).toContain(`${A}/alpha/${person}`);
  });

  it("no role, another project's role, a missing project, another company's project and a malformed name all get the same 404 and nothing is opened", async () => {
    const w = setup({ [`${A}/alpha/ada`]: "view", [`${B}/alpha/bob`]: "view" });
    const same = JSON.stringify({ error: { code: "NOT_FOUND", message: ANSWER_WORDS.projectNotFound } });
    for (const [company, person, path] of [[A, "stranger", PATH], [A, "ada", "/v1/app/projects/beta/answers"], [A, "ada", "/v1/app/projects/ghost/answers"], [A, "bob", PATH], [A, "ada", "/v1/app/projects/Not%20A%20Name/answers"], [A, "ada", "/v1/app/projects/%E0%A4%A/answers"], [A, "ada", "/v1/app/projects/al%23pha/answers"]] as const) {
      const result = await w.post(company, person, ask(), {}, path);
      expect(result.status, `${person} ${path}`).toBe(404);
      expect(result.raw, `${person} ${path}`).toBe(same);
    }
    expect(w.model.opened).toHaveLength(0);
    expect(w.calls).toEqual([]);
    expect((await w.post(B, "bob", ask())).status).toBe(200);
  });

  it("the body is checked after the role: a stranger learns nothing about its shape, a member gets one fixed 400", async () => {
    const w = setup({ [`${A}/alpha/ada`]: "view" });
    expect((await w.post(A, "stranger", "not json")).status).toBe(404);
    for (const bad of ["not json", "{}", JSON.stringify({ ...ask(), extra: 1 }), JSON.stringify({ ...ask(), question: "" })]) {
      const result = await w.post(A, "ada", bad);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: { code: "CONFIG_INVALID", message: ANSWER_WORDS.badRequest } });
    }
    const echoed = await w.post(A, "ada", { requestId: "req-echo-0001", question: "", secret: "CANARY-1234" });
    expect(echoed.raw).not.toContain("CANARY");
  });

  it("a standing that cannot be read is a fixed 503, and anything but view or manage is no", async () => {
    const w = setup({ [`${A}/alpha/ada`]: "view" });
    const down = await w.post(A, "ada", ask(), { standing: async () => { throw new Error("db down"); } });
    expect(down).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: ANSWER_WORDS.unavailable } } });
    for (const odd of [undefined, null, { access: "admin" }, { access: "" }, {}]) {
      expect((await w.post(A, "ada", ask(), { standing: async () => odd as never })).status).toBe(404);
    }
  });
});

describe("the answer route: two companies and two projects", () => {
  it("reads only the caller's company's code and writes only the caller's company's rows", async () => {
    const w = setup({ [`${A}/alpha/ada`]: "view", [`${B}/alpha/ada`]: "view" });
    expect((await w.post(A, "ada", ask())).status).toBe(200);
    expect(w.calls.every((call) => call.startsWith(`${A}:`))).toBe(true);
    const asB = await w.post(B, "ada", ask());
    // Company B's file does not hold the quoted line, so B's answer is not found; it never saw A's code.
    expect(asB.body["outcome"]).toBe("not_found");
    expect(w.calls.filter((call) => call.startsWith(`${B}:`)).length).toBeGreaterThan(0);
    const keys: string[] = [];
    let cursor: string | undefined;
    do { const page = await w.store.scanPage({ limit: 1_000, ...(cursor === undefined ? {} : { cursor }) }); keys.push(...page.items.map((item) => item.pk)); cursor = page.cursor; } while (cursor !== undefined);
    expect(keys.every((pk) => pk.startsWith(`ORG#${A}#`) || pk.startsWith(`ORG#${B}#`))).toBe(true);
    expect(keys.some((pk) => pk.startsWith(`ORG#${A}#`))).toBe(true);
    expect(keys.some((pk) => pk.startsWith(`ORG#${B}#`))).toBe(true);
  });
});

describe("the answer route: fixed failure logging", () => {
  it.each([new Error("PROVIDER-CANARY"), new AgentXError("RUNTIME_UNAVAILABLE", "PROVIDER-CANARY", 503)])("logs a construction failure once, including structured runtime errors", async (error) => {
    const w = setup({ [`${A}/alpha/ada`]: "view" });
    const result = await w.post(A, "ada", ask({ question: "QUESTION-CANARY" }), { model: () => { throw error; } });
    expect(result.status).toBe(503);
    expect(w.logs.filter((entry) => entry.event === "answer.failed")).toEqual([{ component: "answers", event: "answer.failed", cause: "unexpected" }]);
    expect(JSON.stringify(w.logs)).not.toMatch(/CANARY/);
  });

  it.each([new Error("PROVIDER-CANARY"), new AnswerModelRefused("unavailable"), new AnswerModelRefused("not_set_up")])("logs a later-turn model failure once and keeps the degraded not_found", async (error) => {
    const w = setup({ [`${A}/alpha/ada`]: "view" });
    const result = await w.post(A, "ada", ask({ question: "QUESTION-CANARY" }), { model: () => scriptedModel([tool({ tool: "code_read", repo: "web", path: "src/refund.ts", from: 1, to: 7 }), error]) });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ outcome: "not_found", text: "" });
    expect(w.logs.filter((entry) => entry.event === "answer.failed")).toEqual([{ component: "answers", event: "answer.failed", cause: "model_unavailable" }]);
    expect(JSON.stringify(w.logs)).not.toMatch(/CANARY/);
  });

  it("logs a rejected availability check and keeps not_set_up", async () => {
    const w = setup({ [`${A}/alpha/ada`]: "view" });
    const result = await w.post(A, "ada", ask({ question: "QUESTION-CANARY" }), { model: () => ({ ...w.model, available: async () => { throw new Error("PROVIDER-CANARY"); } }) });
    expect(result.status).toBe(200);
    expect(result.body["outcome"]).toBe("not_set_up");
    expect(w.logs).toEqual([{ component: "answers", event: "answer.failed", cause: "model_unavailable" }]);
  });

  it("logs a fixed repository failure code without logging the question or answer", async () => {
    const w = setup({ [`${A}/alpha/ada`]: "view" });
    const result = await w.post(A, "ada", ask({ question: "QUESTION-CANARY" }), { repositories: async () => { throw new Error("ANSWER-CANARY"); } });
    expect(result.status).toBe(503);
    expect(w.logs).toContainEqual({ component: "answers", event: "answer.failed", cause: "repository_unavailable" });
    expect(JSON.stringify(w.logs)).not.toMatch(/QUESTION-CANARY|ANSWER-CANARY/);
  });
});

describe("the answer route: the team knowledge briefing (lead 4 L4-AK2b)", () => {
  it("each company's answer is briefed by ITS OWN company's seam, only for a person with a role, and an absent seam leaves the answer as before", async () => {
    const w = setup({ [`${A}/alpha/ada`]: "view", [`${B}/alpha/bob`]: "view" });
    const asked: string[] = [];
    const briefing: NonNullable<HostedAnswersWiring["briefing"]> = (companyId) => async (input) => { asked.push(`${companyId}/${input.project}`); return `<<team-knowledge>> notes of ${companyId} <</team-knowledge>>`; };
    expect((await w.post(A, "ada", ask(), { briefing })).status).toBe(200);
    expect(asked).toEqual([`${A}/alpha`]);
    expect(w.model.turns[0]!.transcript).toContain(`notes of ${A}`);
    expect(w.model.turns[0]!.transcript).not.toContain(B);
    expect((await w.post(B, "bob", ask(), { briefing })).status).toBe(200);
    expect(asked).toEqual([`${A}/alpha`, `${B}/alpha`]);
    expect(w.model.turns.at(-1)!.transcript).toContain(`notes of ${B}`);
    expect(w.model.turns.at(-1)!.transcript).not.toContain(A);
    // A stranger gets the same 404 and the seam is never asked.
    expect((await w.post(A, "stranger", ask(), { briefing })).status).toBe(404);
    expect(asked).toHaveLength(2);
    // No seam: no briefing block at all.
    const before = w.model.turns.length;
    await w.post(A, "ada", ask());
    expect(w.model.turns[before]!.transcript).not.toContain("team-knowledge");
  });
});

describe("the answer route: no model wired", () => {
  it("answers 200 with the fixed 'not set up' outcome, no button, and spends and records nothing", async () => {
    const w = setup({ [`${A}/alpha/ada`]: "view" });
    const before = await w.store.scanPage({ limit: 1_000 });
    const result = await w.post(A, "ada", ask(), { model: undefined });
    expect(result.status).toBe(200);
    expect(AnswerResponseSchema.parse(result.body)).toMatchObject({ outcome: "not_set_up", text: "", honesty: ANSWER_WORDS.notSetUp, sources: [] });
    expect(result.body["action"]).toBeUndefined();
    expect(result.body["answerId"]).toBeUndefined();
    expect(w.calls).toEqual([]);
    expect((await w.store.scanPage({ limit: 1_000 })).items).toEqual(before.items);
  });
});

describe("the answer route through the deployed API's guards", () => {
  const PROJECT: ProjectDefinition = { name: "alpha", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "web", url: "https://github.com/example/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" }] };
  const WIRED: CoreDevWiring = { origin: () => "https://api.example", scriptTokens: { enabled: () => true } };
  async function over() {
    const fake = createFakeWorld();
    for (const company of [FAKE_COMPANY]) {
      await fake.store.put({ item: { ...projectRevisionKey(company, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
      await fake.store.put({ item: { ...orgProjectCatalogKey(company, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
    }
    const services = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
    const app = createCoreHostApp({
      env: { ROVARA_CORE_ENGINE: "on" }, modules: fake.modules, context: () => fake.context(), nowMs: () => fake.clock.now,
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined, services, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
    });
    const member = new Map<string, CompanyMembership>();
    const companyOf = vi.fn(async (caller: DeployedCaller) => member.get(caller.principal.personId + caller.principal.companyId));
    const caller = { principal: localOwnerPrincipal({ companyId: FAKE_COMPANY }), client: "cli" } as DeployedCaller;
    member.set(caller.principal.personId + FAKE_COMPANY, { companyId: FAKE_COMPANY, role: "owner" });
    return { app, companyOf, caller };
  }
  const post = (path: string, body: unknown = {}) => ({ method: "POST", path, headers: {}, body: JSON.stringify(body) });

  it("serves the member company's own answer, refuses a script token (403) and a caller with no company (401) before anything is read, and says 'not on the core yet' when unwired", async () => {
    const { app, companyOf, caller } = await over();
    const standing = vi.fn(async () => ({ access: "view" as const }));
    const repositories = vi.fn(async () => ({ handles: handles(FAKE_COMPANY), names: ["web"] }));
    const routes = createCoreDevRoutes({ app, companyOf, wiring: () => ({ ...WIRED, answers: { standing, repositories } }) });
    const served = await routes.route(post(PATH, ask()), caller);
    expect(served?.statusCode).toBe(200);
    expect(JSON.parse(served!.body)).toMatchObject({ outcome: "not_set_up" });
    expect(standing).toHaveBeenCalledWith(caller.principal.personId, FAKE_COMPANY, "alpha");
    standing.mockClear();
    const token = await routes.route(post(PATH, ask()), { ...caller, scriptToken: { tokenId: "stk_aaaaaaaaaaaaaaaaaaaa" } });
    expect(token?.statusCode).toBe(403);
    expect((JSON.parse(token!.body) as { error: { message: string } }).error.message).toBe(NOT_FOR_SCRIPT_TOKENS);
    expect((await routes.route(post(PATH, ask()), { ...caller, principal: { ...caller.principal, personId: "no-membership" } }))?.statusCode).toBe(401);
    expect(standing).not.toHaveBeenCalled();
    const unwired = createCoreDevRoutes({ app, companyOf, wiring: () => WIRED });
    expect((JSON.parse((await unwired.route(post(PATH, ask()), caller))!.body) as { error: { message: string } }).error.message).toBe(NOT_ON_THE_CORE_YET);
    expect(await routes.route({ method: "GET", path: PATH, headers: {}, body: "" }, caller)).toBeUndefined();
    void tool;
  });
});
