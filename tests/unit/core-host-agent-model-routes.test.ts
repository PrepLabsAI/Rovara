// DEC 243c / DEC 236j: the company's agent model choice on the deployed API. Anyone of the company reads it; changing it is an owner's or an administrator's act (never a script token; DEC 254zzz73: no step-up),
// by an owner or an administrator, from the gateway's list; the company is the caller's membership, so one company's choice never reaches another's.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AgentModelPageSchema, agentModelIdentity, type OrgRole } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createLocalOwnerApprovers } from "../../packages/broker/src/ports/policy-defaults.js";
import { createCoreHostApp, type CoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_FOR_SCRIPT_TOKENS, NOT_ON_THE_CORE_YET, createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import { AGENT_MODELS_PATH, AGENT_MODEL_CHANGE_NOT_ALLOWED } from "../../packages/broker/src/core-host/agent-model-routes.js";
import { HOSTED_MODEL_WORDS, OFFERED_MODELS_UNAVAILABLE, createAgentModelChoice, type AgentModelChoice } from "../../packages/broker/src/core-host/gateway-model-selection.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { GATEWAY_OFFERED_MODELS, createFakeOfferedModels } from "../support/offered-models-fake.js";

const OTHER = "org_corehost00000000000b";
const DEFAULT = "claude-sonnet-5-5";
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
const HONEST_CI = { honest: true as const, ciMode: () => "their_ci_fix" as const };

function appOver(world: FakeWorld, env: NodeJS.ProcessEnv): CoreHostApp {
  return createCoreHostApp({
    env, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: HONEST_CI }),
  });
}
const get = (path = AGENT_MODELS_PATH) => ({ method: "GET", path, headers: {}, body: "" });
const post = (body: unknown, path = AGENT_MODELS_PATH) => ({ method: "POST", path, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) });
const bodyOf = (answer: { body: string } | undefined) => JSON.parse(answer!.body) as { error?: { code: string; message: string }; state?: { revision: number; steps: Array<{ stage: string; setting: { model?: unknown } | null }> }; offered?: { models: Array<{ model: string }> }; ok?: boolean; revision?: number };

function setup() {
  const world = createFakeWorld();
  const app = appOver(world, { ROVARA_CORE_ENGINE: "on" });
  const reader = createFakeOfferedModels();
  const members = new Map<string, CompanyMembership>();
  const choices = new Map<string, AgentModelChoice>();
  const wiring = (runtime: { companyId: string; flow: { deps: { store: never; audit: never } } }): CoreDevWiring => {
    const companyId = runtime.companyId as never;
    if (!choices.has(companyId)) choices.set(companyId, createAgentModelChoice({ store: runtime.flow.deps.store, companyId, audit: runtime.flow.deps.audit, approvers: createLocalOwnerApprovers({ now: () => new Date(world.clock.now) }), reader, defaultModel: async () => DEFAULT, now: () => world.clock.now, readTimeoutMs: 25 }));
    return { origin: () => "https://api.example", modelChoice: choices.get(companyId)!, scriptTokens: {} };
  };
  const routes = createCoreDevRoutes({ app, companyOf: async (caller) => members.get(caller.principal.personId + caller.principal.companyId), wiring: (runtime) => wiring(runtime as never) });
  const person = (companyId: string, role: OrgRole, extra: Partial<DeployedCaller> = {}): DeployedCaller => {
    const principal = localOwnerPrincipal({ companyId });
    const personId = `${role}-${companyId}`.padEnd(64, "0").slice(0, 64);
    const caller: DeployedCaller = { principal: { ...principal, personId }, client: "web", ...extra };
    members.set(personId + companyId, { companyId, role });
    return caller;
  };
  return { world, app, reader, routes, person, choices };
}
const SET_BUILD = (name: string, expectedRevision = 0) => ({ action: "set", stage: "build", choice: { model: agentModelIdentity(name) }, expectedRevision });

describe("reading the company's agent model choice", () => {
  it("any member of the company reads its setting and every model the gateway offers it", async () => {
    const t = setup();
    const answer = await t.routes.route(get(), t.person(FAKE_COMPANY, "member"));
    expect(answer?.statusCode).toBe(200);
    const page = bodyOf(answer);
    expect(AgentModelPageSchema.safeParse(page).success).toBe(true);
    expect(page.offered!.models.map((entry) => entry.model)).toEqual(GATEWAY_OFFERED_MODELS);
    expect(page.state!.revision).toBe(0);
  });
  it("says 'not on the core yet' where the deployment wired no choice, and nothing is read for a path it does not own", async () => {
    const t = setup();
    const bare = createCoreDevRoutes({ app: t.app, companyOf: async () => ({ companyId: FAKE_COMPANY, role: "owner" }), wiring: () => ({ origin: () => "https://api.example" }) });
    const answer = await bare.route(get(), t.person(FAKE_COMPANY, "owner"));
    expect(answer?.statusCode).toBe(404);
    expect(bodyOf(answer).error?.message).toBe(NOT_ON_THE_CORE_YET);
    // Other methods are the old broker's.
    for (const method of ["PUT", "DELETE", "PATCH"]) expect(await t.routes.route({ ...get(), method }, t.person(FAKE_COMPANY, "owner"))).toBeUndefined();
  });
  it("is the old broker's, reading nothing, while the engine switch is off", async () => {
    const t = setup();
    const off = createCoreDevRoutes({ app: appOver(t.world, {}), companyOf: vi.fn(async () => undefined), wiring: () => ({ origin: () => "x" }) });
    expect(await off.route(get(), t.person(FAKE_COMPANY, "owner"))).toBeUndefined();
    expect(await off.route(post(SET_BUILD(DEFAULT)), t.person(FAKE_COMPANY, "owner"))).toBeUndefined();
  });
  it("answers fixed words (no cause) when the gateway's list cannot be read", async () => {
    const t = setup();
    t.reader.fail();
    const answer = await t.routes.route(get(), t.person(FAKE_COMPANY, "owner"));
    expect(answer?.statusCode).toBeGreaterThanOrEqual(500);
    expect(bodyOf(answer).error?.message).toBe(OFFERED_MODELS_UNAVAILABLE);
    expect(answer!.body).not.toMatch(/ECONNREFUSED|gateway\.internal/u);
  });
  it("a script token reads nothing and changes nothing here", async () => {
    const t = setup();
    const caller = { ...t.person(FAKE_COMPANY, "owner"), scriptToken: { tokenId: randomUUID() } };
    for (const request of [get(), post(SET_BUILD("claude-opus-5-5"))]) {
      const answer = await t.routes.route(request, caller);
      expect(answer?.statusCode).toBe(403);
      expect(bodyOf(answer).error?.message).toBe(NOT_FOR_SCRIPT_TOKENS);
    }
  });
});

describe("changing the company's agent model choice (an owner or administrator; no step-up)", () => {
  it("is made by a signed-in administrator with no step-up, from the gateway's list, and is the next step's model", async () => {
    const t = setup();
    const admin = t.person(FAKE_COMPANY, "admin");
    const answer = await t.routes.route(post(SET_BUILD("qwen.qwen3-coder-480b-a35b-v1:0")), admin);
    expect(answer?.statusCode).toBe(200);
    expect(bodyOf(answer)).toMatchObject({ ok: true, revision: 1 });
    const read = bodyOf(await t.routes.route(get(), t.person(FAKE_COMPANY, "member")));
    expect(read.state!.revision).toBe(1);
    expect(read.state!.steps.find((step) => step.stage === "build")?.setting?.model).toEqual({ provider: "amazon-bedrock", modelId: "qwen.qwen3-coder-480b-a35b-v1:0" });
    const runtime = await t.app.runtimeFor(FAKE_COMPANY);
    expect(runtime.companyId).toBe(FAKE_COMPANY);
    // The audit event names the company and the caller it came through.
    expect(t.world.audit.map((event) => event.action)).toContain("model.policy.changed");
  });

  it("an owner may too", async () => {
    const t = setup();
    expect((await t.routes.route(post(SET_BUILD("claude-opus-5-5")), t.person(FAKE_COMPANY, "owner")))?.statusCode).toBe(200);
  });

  it("is refused for a member (the live role from membership), with no step-up asked", async () => {
    const t = setup();
    const answer = await t.routes.route(post(SET_BUILD("claude-opus-5-5")), t.person(FAKE_COMPANY, "member"));
    expect(answer?.statusCode).toBe(403);
    expect(bodyOf(answer).error).toEqual({ code: "FORBIDDEN", message: AGENT_MODEL_CHANGE_NOT_ALLOWED });
    expect(bodyOf(await t.routes.route(get(), t.person(FAKE_COMPANY, "owner"))).state!.revision).toBe(0);
  });

  it("refuses a model the gateway does not offer, a body that is not a change, and a stale revision, each in fixed words that echo nothing", async () => {
    const t = setup();
    const owner = t.person(FAKE_COMPANY, "owner");
    const offered = await t.routes.route(post({ action: "set", stage: "build", choice: { model: { provider: "amazon-bedrock", modelId: "meta.llama3-1-405b-instruct-v1:0" } }, expectedRevision: 0 }), owner);
    expect(offered?.statusCode).toBe(400);
    expect(bodyOf(offered).error?.message).toBe(HOSTED_MODEL_WORDS.unavailable("amazon-bedrock/meta.llama3-1-405b-instruct-v1:0"));
    for (const body of ["", "not json", "[]", "null", { action: "set" }, { action: "nuke" }, { ...SET_BUILD("claude-opus-5-5"), companyId: OTHER }]) {
      const answer = await t.routes.route(post(body), owner);
      expect(answer?.statusCode, JSON.stringify(body)).toBe(400);
      expect(answer!.body).not.toContain("not json");
      expect(answer!.body).not.toContain(OTHER);
    }
    expect((await t.routes.route(post(SET_BUILD("claude-opus-5-5", 5)), owner))?.statusCode).toBe(409);
    expect(bodyOf(await t.routes.route(get(), owner)).state!.revision).toBe(0);
  });

  it("refuses when the gateway's list cannot be read, and changes nothing", async () => {
    const t = setup();
    const owner = t.person(FAKE_COMPANY, "owner");
    t.reader.fail();
    const answer = await t.routes.route(post(SET_BUILD("claude-opus-5-5")), owner);
    expect(answer?.statusCode).toBe(400);
    expect(answer!.body).not.toMatch(/ECONNREFUSED|gateway\.internal/u);
    t.reader.fail(false);
    expect(bodyOf(await t.routes.route(get(), owner)).state!.revision).toBe(0);
  });
});

describe("two companies", () => {
  it("the company is the caller's membership: one company's administrator changes only that company's choice, and each reads only its own list", async () => {
    const t = setup();
    t.reader.set(FAKE_COMPANY, GATEWAY_OFFERED_MODELS);
    t.reader.set(OTHER, ["claude-sonnet-5-5", "claude-haiku-5-5"]);
    const adminA = t.person(FAKE_COMPANY, "admin");
    const adminB = t.person(OTHER, "admin");
    expect((await t.routes.route(post(SET_BUILD("deepseek.v3-v1:0")), adminA))?.statusCode).toBe(200);
    // B's list does not have it: refused, and B's setting is untouched.
    expect((await t.routes.route(post({ ...SET_BUILD("deepseek.v3-v1:0"), companyId: FAKE_COMPANY }), adminB))?.statusCode).toBe(400);
    expect((await t.routes.route(post(SET_BUILD("claude-haiku-5-5")), adminB))?.statusCode).toBe(200);
    const a = bodyOf(await t.routes.route(get(), adminA));
    const b = bodyOf(await t.routes.route(get(), adminB));
    expect(a.state!.steps.find((step) => step.stage === "build")?.setting?.model).toEqual({ provider: "amazon-bedrock", modelId: "deepseek.v3-v1:0" });
    expect(b.state!.steps.find((step) => step.stage === "build")?.setting?.model).toEqual({ provider: "anthropic", modelId: "claude-haiku-5-5" });
    expect(a.offered!.models).toHaveLength(GATEWAY_OFFERED_MODELS.length);
    expect(b.offered!.models.map((entry) => entry.model)).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    // A person of A with membership of B is a sign-in refusal (the principal must be of the member company).
    const crossed = createCoreDevRoutes({ app: t.app, companyOf: async () => ({ companyId: OTHER, role: "owner" }), wiring: () => ({ origin: () => "x" }) });
    expect((await crossed.route(get(), adminA))?.statusCode).toBe(401);
  });
});
