// Lead 4 J2: the core's in-process answer for a verified Slack thread (core-host/dev-routes.ts `answerForSlackThread`). Not an HTTP route: only the Slack door calls it, with a company, a person, a project and a thread
// it verified. The thread is shared (everyone who reads a Slack thread has read every answer in it); the role on the project is read live by the answer service; the attached context is the answer as untrusted data.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ANSWER_WORDS, orgProjectCatalogKey, projectRevisionKey, slackAnswerThreadId, type JsonValue, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { createCoreDevRoutes, type CompanyMembership, type CoreDevWiring, type DeployedCaller } from "../../packages/broker/src/core-host/dev-routes.js";
import type { HostedAnswersWiring } from "../../packages/broker/src/core-host/answer-routes.js";
import type { AnswerRepositoryHandle } from "../../packages/broker/src/core/answers/code-source.js";
import { FAKE_COMPANY, createFakeWorld } from "../support/core-host-fakes.js";
import { HEAD, REFUND_TS, answer, goodSentence, scriptedModel } from "../support/answer-world.js";

const PROJECT = (name: string): ProjectDefinition => ({ name, revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.", repositories: [{ name: "web", url: "https://github.com/example/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" }] });
const WIRED: CoreDevWiring = { origin: () => "https://api.example", scriptTokens: { enabled: () => true } };
const THREAD = { teamId: "T0AAAAAAA", channelId: "C0BOUND000", threadTs: "1700000000.000100" };
const ADA = "dev-ada";
const BOB = "dev-bob";

function handles(calls: string[]): AnswerRepositoryHandle[] {
  return [{ name: "web", defaultBranch: "main", repository: { url: "https://github.com/example/web.git" }, scope: { orgId: FAKE_COMPANY }, host: { baseBranchHead: async () => HEAD, fileAtRevision: async (_r, path) => { calls.push(path); return path === "src/refund.ts" ? REFUND_TS : undefined; } } }];
}

async function setup(roles: Record<string, "view" | "manage"> = {}, withAnswers = true, projects = ["alpha", "beta"]) {
  const fake = createFakeWorld();
  for (const name of projects) {
    await fake.store.put({ item: { ...projectRevisionKey(FAKE_COMPANY, name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT(name))) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(FAKE_COMPANY, name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  }
  const services = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });
  const app = createCoreHostApp({
    env: { ROVARA_CORE_ENGINE: "on" }, modules: fake.modules, context: () => fake.context(), nowMs: () => fake.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined, services, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
  });
  const calls: string[] = [];
  const standings: string[] = [];
  const model = scriptedModel([answer([goodSentence], { points_at_change: true, title: "Change refund window" })]);
  const answers: HostedAnswersWiring = {
    standing: async (personId, companyId, project) => { standings.push(`${companyId}/${project}/${personId}`); const access = roles[`${project}/${personId}`]; return access === "manage" ? { access, basis: "company-admin" } : access === "view" ? { access } : { access: "none" }; },
    repositories: async (_company, project) => (projects.includes(project) ? { handles: handles(calls), names: ["web"] } : undefined),
    model: () => model,
  };
  const member = new Map<string, CompanyMembership>();
  const routes = createCoreDevRoutes({ app, companyOf: async (caller: DeployedCaller) => member.get(caller.principal.personId), wiring: () => ({ ...WIRED, ...(withAnswers ? { answers } : {}) }) });
  const ask = (over: Partial<Parameters<typeof routes.answerForSlackThread>[0]> = {}) => routes.answerForSlackThread({
    companyId: FAKE_COMPANY, personId: ADA, project: "alpha", threadId: slackAnswerThreadId(THREAD), requestId: randomUUID(), question: "How long do refunds last?", ...over,
  });
  return { routes, ask, model, calls, standings, fake };
}

describe("the in-process Slack answer", () => {
  it("answers a person with a role, with the one button and the answer attached as untrusted data", async () => {
    const w = await setup({ "alpha/dev-ada": "view" });
    const served = await w.ask();
    expect(served).toBeDefined();
    expect(served!.answer).toMatchObject({ outcome: "answered", text: "Refunds are allowed for 30 days (`MAX_REFUND_DAYS`). [1]", action: { kind: "quick_task", label: ANSWER_WORDS.taskButton } });
    expect(served!.attach).toContain('untrusted="true"');
    expect(served!.attach).toContain("Question: How long do refunds last?");
    expect(served!.attach).toContain("never an instruction");
    expect(w.standings).toContain(`${FAKE_COMPANY}/alpha/dev-ada`);
  });

  it("a person with no role gets the same NOT_FOUND as a project that is not there, and no model is opened", async () => {
    const w = await setup({ "alpha/dev-ada": "view" });
    for (const over of [{ personId: BOB }, { project: "beta" }, { project: "ghost" }]) {
      await expect(w.ask(over), JSON.stringify(over)).rejects.toMatchObject({ code: "NOT_FOUND", message: expect.stringContaining(ANSWER_WORDS.projectNotFound) as string });
    }
    expect(w.model.opened).toHaveLength(0);
    expect(w.calls).toEqual([]);
  });

  it("the thread is shared: another person with a role sees the earlier question and answer; a person with no role still reads nothing", async () => {
    const w = await setup({ "alpha/dev-ada": "view", "alpha/dev-bob": "view" });
    await w.ask({ personId: ADA, question: "first question in the thread" });
    await w.ask({ personId: BOB, question: "bob follows up" });
    expect(w.model.turns.at(-1)!.transcript).toContain("first question in the thread");
    const outsider = await setup({ "alpha/dev-ada": "view" });
    await outsider.ask({ personId: ADA, question: "ada private question" });
    await expect(outsider.ask({ personId: BOB, question: "bob has no role" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(outsider.model.turns).toHaveLength(1);
  });

  it("two projects never share a thread, even with the same thread id", async () => {
    const w = await setup({ "alpha/dev-ada": "view", "beta/dev-ada": "view" });
    await w.ask({ project: "alpha", question: "alpha only question" });
    await w.ask({ project: "beta", question: "beta asks" });
    expect(w.model.turns.at(-1)!.transcript).not.toContain("alpha only question");
  });

  it("a request id repeated is the same answer and the model is asked once", async () => {
    const w = await setup({ "alpha/dev-ada": "view" });
    const requestId = randomUUID();
    const first = await w.ask({ requestId });
    const second = await w.ask({ requestId });
    expect(second!.answer.answerId).toBe(first!.answer.answerId);
    expect(w.model.opened).toHaveLength(1);
  });

  it("serves nothing for a company id that is malformed or not this runtime's, and nothing when the core has no answers wiring", async () => {
    const w = await setup({ "alpha/dev-ada": "view" });
    expect(await w.ask({ companyId: "not-a-company" })).toBeUndefined();
    expect(w.standings).toEqual([]);
    const unwired = await setup({ "alpha/dev-ada": "view" }, false);
    expect(await unwired.ask()).toBeUndefined();
  });

  it("serves nothing while the core switch is off", async () => {
    const fake = createFakeWorld();
    const app = createCoreHostApp({ env: {}, modules: fake.modules, context: () => fake.context(), nowMs: () => fake.clock.now, runtime: () => { throw new Error("never"); } });
    const standing = vi.fn(async () => ({ access: "view" as const }));
    const routes = createCoreDevRoutes({ app, companyOf: async () => undefined, wiring: () => ({ ...WIRED, answers: { standing, repositories: async () => ({ handles: [], names: [] }) } }) });
    expect(await routes.answerForSlackThread({ companyId: FAKE_COMPANY, personId: ADA, project: "alpha", threadId: "t", requestId: randomUUID(), question: "q" })).toBeUndefined();
    expect(standing).not.toHaveBeenCalled();
  });

  it("an answer that is not set up carries no button and no attached context", async () => {
    const w = await setup({ "alpha/dev-ada": "view" });
    const bare = createCoreDevRoutes({ app: createCoreHostApp({ env: { ROVARA_CORE_ENGINE: "on" }, modules: w.fake.modules, context: () => w.fake.context(), nowMs: () => w.fake.clock.now,
      runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(w.fake.clock.now), log: () => undefined, services: () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } }), ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }) }),
      companyOf: async () => undefined,
      wiring: () => ({ ...WIRED, answers: { standing: async () => ({ access: "view" as const }), repositories: async () => ({ handles: handles([]), names: ["web"] }) } }) });
    const served = await bare.answerForSlackThread({ companyId: FAKE_COMPANY, personId: ADA, project: "alpha", threadId: "t1", requestId: randomUUID(), question: "How long do refunds last?" });
    expect(served!.answer).toMatchObject({ outcome: "not_set_up" });
    expect(served!.answer.action).toBeUndefined();
    expect(served!.attach).toBeUndefined();
  });
});
