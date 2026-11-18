// Lessons phase 0, "confirm the wiring" (learning review, phase 0): which learning sources really run on a HOSTED install today. Each source is a test of what the hosted glue and source do, so the wiring table in
// the pull request is evidence, not memory. Where a source is NOT wired, the test pins the gap in plain words, so whoever wires it must change the test (and the table) with the change.
//   runs on hosted: decisions in tasks (a person's send-back, a close reason, learn on send-back, the merged/closed end), PR review comments.
//   wired by lane L4-LM1b: reverts (core/proof/revert/revert-watch.ts calls the detectors from the lessons pass and the laptop's lessons timer; tests/unit/lessons/revert-watch.test.ts).
//   not wired:      the human-edit extractor (nothing queues it, the worker answers "unavailable"), plan and design comments (a gate's "request changes" reason is not read).
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime, readCoreEngineFlags, type CoreRuntime } from "../../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../../packages/broker/src/core-host/lessons.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { reflectQueueOf, humanEditMessageOf } from "../../../packages/broker/src/lessons/reflect-queue.js";
import { createLocalLessonSources } from "../../../packages/broker/src/local/app/lessons-sources.js";
import { createLessonRepositories, type LessonRepositories } from "../../../packages/broker/src/local/app/lessons-repos.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../../support/core-host-fakes.js";

afterEach(() => setLearnedLessonsGate(undefined));

const A = FAKE_COMPANY as OrgId;
const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const PLAN_WORDS = "Split the schema migration into its own pull request before you approve this plan.";
const MEMBER = "ann";

const people = (members: string[]): HostedLessonPeople => ({
  async approvers() { return { complete: true, membershipVersion: 1, ownerIds: members.slice(0, 1), eligibleIds: members, lastEligibleLossAtMs: null }; },
  async onProjectRoster(_c, _p, personId) { return members.includes(personId); }, async linkedAccounts() { return []; }, async displayName() { return undefined; }, async isErased() { return false; },
});

async function hostedWorld(): Promise<{ fake: FakeWorld; runtime: CoreRuntime; lessons: CoreLessons; taskId: string }> {
  const env = { [CORE_LESSONS_VARIABLE]: "on" };
  const fake = createFakeWorld();
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: fake.modules, context: fake.context(), areas: ["flow", "build", "merge"] });
  await fake.store.put({ item: { ...projectRevisionKey(A, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
  await fake.store.put({ item: { ...orgProjectCatalogKey(A, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  const runtime = createCoreRuntime({
    registry, companyId: A, flags: readCoreEngineFlags({ ROVARA_CORE_ENGINE: "on" }), callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
    repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined,
  });
  const hosts = new Map<string, CoreLessons>();
  const lessons = createCoreLessons({ flow: runtime.flow, registry, companyId: A, lessonsSwitch: readCoreLessonsSwitch(env).value, people: people([MEMBER]), hostFor: async (id) => hosts.get(id)?.host, now: () => fake.clock.now })!;
  hosts.set(A, lessons);
  lessons.attach();
  const { task } = await runtime.flow.start({ principal: localOwnerPrincipal({ companyId: A }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  return { fake, runtime, lessons, taskId: task.taskId };
}

/** Writes decisions onto the task's stored workflow, as the flow would have committed them. */
async function decide(fake: FakeWorld, taskId: string, decisions: Array<Record<string, unknown>>, over: Record<string, unknown> = {}): Promise<string[]> {
  const record = (await fake.store.get(taskKey(taskId)))! as unknown as Record<string, unknown> & { workflow: { decisions: unknown[]; revision: number } };
  const at = new Date(fake.clock.now).toISOString();
  const added = decisions.map((d) => ({ requestId: randomUUID(), workflowRevision: record.workflow.revision, actorId: MEMBER, actorRole: "TASK_OWNER", at, ...d }));
  await fake.store.put({ item: { ...record, workflow: { ...record.workflow, decisions: [...record.workflow.decisions, ...added], ...over } } as never });
  return added.map((entry) => entry.requestId as string);
}

const queued = async (fake: FakeWorld): Promise<Array<Record<string, unknown>>> => (await (await reflectQueueOf(fake.queues)).receive({ maxMessages: 10 })).map((message) => message.body as Record<string, unknown>);

function hostedSources(w: { fake: FakeWorld; runtime: CoreRuntime }, repos: unknown = { ofProject: async () => [], ofTask: async () => undefined }, extra: { personOfAccount?: (c: OrgId, p: string, login: string) => Promise<string | undefined> } = {}) {
  return createLocalLessonSources({
    flow: w.runtime.flow.deps, companyId: A, ownerId: "rovara-system", repos: repos as LessonRepositories, now: () => w.fake.clock.now,
    hosted: { people: people([MEMBER]), ...extra },
  });
}

describe("decisions in tasks run on hosted", () => {
  it("the flow's lessons slots are filled, so a send-back, an ended task and a revert reach lessons", async () => {
    const w = await hostedWorld();
    expect(w.runtime.flow.deps.learned).toBeTypeOf("function");
    expect(w.runtime.flow.deps.lessonsUsed).toBeTypeOf("function");
    expect(w.runtime.flow.deps.lessonsSentBack).toBeTypeOf("function");
    expect(w.runtime.flow.deps.milestones).toBeDefined();
  });

  it("learn on send-back: a member's send-back with words queues one sent_back reflection of ids", async () => {
    const w = await hostedWorld();
    await decide(w.fake, w.taskId, [{ decision: "REQUEST_CHANGES", source: "SEND_BACK", reason: "Use the shared retry helper, not a loop." }]);
    await w.runtime.flow.deps.lessonsSentBack!(w.taskId);
    const sent = await queued(w.fake);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ orgId: A, taskId: w.taskId, outcome: "sent_back", round: 1 });
    expect(JSON.stringify(sent)).not.toContain("retry helper");
  });

  it("the end of a task: merged and closed queue a reflection under the task's company", async () => {
    const w = await hostedWorld();
    const at = new Date(w.fake.clock.now).toISOString();
    await w.lessons.host.milestone.on({ kind: "merged", orgId: A, taskId: w.taskId, at, text: "merged" });
    await w.lessons.host.milestone.on({ kind: "closed", orgId: A, taskId: w.taskId, at, text: "closed" });
    expect((await queued(w.fake)).map((m) => m["outcome"]).sort()).toEqual(["closed", "merged"]);
  });

  it("the hosted subject carries a member's send-back (as a fact with words) and a close reason (as a span)", async () => {
    const w = await hostedWorld();
    const [sendBackId] = await decide(w.fake, w.taskId, [
      { decision: "REQUEST_CHANGES", source: "SEND_BACK", reason: "Name it healthz like the others." },
      { decision: "REJECT", source: "GATE", reason: "Closing: this belongs in the billing service." },
    ]);
    const sources = hostedSources(w);
    const read = await sources.source.read({ workspaceId: A, taskId: w.taskId });
    expect(read?.sendBackRequestIds).toEqual([sendBackId]);
    expect(await sources.rows.sendBack({ workspaceId: A, project: "payments", taskId: w.taskId, requestId: sendBackId! })).toMatchObject({ origin: "human", actorDeveloperId: MEMBER, actorTrust: "member", reasonText: "Name it healthz like the others." });
    expect((read?.facts.rest.spans ?? []).find((span) => span.kind === "close_reason")).toMatchObject({ trust: "member", authorId: MEMBER, text: "Closing: this belongs in the billing service." });
  });
});

describe("PR review comments run on hosted", () => {
  it("a comment from an account linked to a person on the roster is a member's; an unlinked account is an outsider's (removed before any model call)", async () => {
    const w = await hostedWorld();
    await decide(w.fake, w.taskId, [], { outcome: "MERGED", pullRequests: [{ repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", state: "MERGED", headSha: "a".repeat(40) }] });
    const comments = [{ id: "1", kind: "review_comment", author: "ann-gh", body: "Name it healthz like the others" }, { id: "2", kind: "review_comment", author: "stranger-gh", body: "Unlinked words" }];
    const codeHost = { kind: "github", feedback: async () => ({ comments, changeRequest: { headTreeRevision: "t" } }), standing: async () => ({ permission: "write", accountType: "person" }) };
    const repo = { name: "demo", url: "https://github.com/example/demo.git", place: "github:repo/1", fullName: "example/demo", private: true, codeHost, repository: { url: "https://github.com/example/demo.git" }, scope: {} };
    const registry = await buildCoreRegistry({ modules: w.fake.modules, context: w.fake.context(), areas: ["flow", "build", "merge"] });
    const repos = { ...createLessonRepositories({ flow: { store: w.fake.store, projects: undefined as never }, registry, companyId: A, now: () => w.fake.clock.now }), ofProject: async () => [repo], ofTask: async () => repo };
    const read = await hostedSources(w, repos, { personOfAccount: async (_c, _p, login) => (login === "ann-gh" ? MEMBER : undefined) }).source.read({ workspaceId: A, taskId: w.taskId });
    const spans = (read?.facts.rest.spans ?? []).filter((span) => span.kind === "pr_comment");
    expect(spans.map((span) => [span.authorId, span.trust])).toEqual([[MEMBER, "member"], ["github_stranger-gh", "outsider"]]);
  });
});

describe("NOT wired on hosted today (the gaps, pinned; reverts are wired and pinned below)", () => {
  // Batch 14: #965 (L4-LM1c) gives the hosted worker its human-edit handler, so a message for a push it cannot prove reads no facts (done, no retry) instead of "unavailable".
  it("human edits: the hosted worker has a human-edit handler (#965); a message whose push yields nothing to learn is done with no facts, never retried", async () => {
    const w = await hostedWorld();
    const message = humanEditMessageOf({
      repo: { host: "github", id: "1", fullName: "example/demo", isPrivate: true, workspaceId: A, project: "payments" }, project: "payments", taskId: w.taskId,
      pullRequest: { number: 7, url: "https://github.com/example/demo/pull/7" }, candidateHeadSha: "a".repeat(40), headSha: "b".repeat(40),
    }, randomUUID());
    expect(await w.lessons.host.reflectOne(JSON.stringify(message))).toMatchObject({ result: "no_facts", retry: false });
  });

  // Batch 14: #965 (L4-LM1c) wires human edits; the callers are pinned exactly, as the reverts' are below.
  it("human edits ARE wired (#965): the host glue builds the extractor, the producer queues the message, and the work and glue call learnFromHumanEdit, nothing else", () => {
    const root = join(process.cwd(), "packages/broker/src");
    const files: string[] = [];
    const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (path.endsWith(".ts")) files.push(path); } };
    walk(root);
    const where = (needle: string): string[] => files.filter((file) => readFileSync(file, "utf8").includes(needle)).map((file) => relative(root, file).split(sep).join("/")).sort();
    expect(where("createHumanEditExtractor")).toEqual(["lessons/host-glue.ts", "lessons/human-edit.ts"]);
    expect(where("humanEditMessageOf")).toEqual(["lessons/human-edit-producer.ts", "lessons/reflect-queue.ts"]);
    expect(where("learnFromHumanEdit")).toEqual(["lessons/host-glue.ts", "lessons/human-edit-producer.ts", "lessons/human-edit-work.ts", "lessons/human-edit.ts"]);
  });

  it("reverts ARE wired (lane L4-LM1b): the revert watch is the one caller of the two detectors, and the lessons glue is the one caller of the host's noteReverted", () => {
    const root = join(process.cwd(), "packages/broker/src");
    const files: string[] = [];
    const walk = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (path.endsWith(".ts")) files.push(path); } };
    walk(root);
    const where = (needle: string): string[] => files.filter((file) => readFileSync(file, "utf8").includes(needle)).map((file) => relative(root, file).split(sep).join("/")).sort();
    expect(where("detectRevertFromMergedChangeRequest")).toEqual(["core/proof/revert/revert-detect.ts", "core/proof/revert/revert-watch.ts"]);
    expect(where("detectRevertFromPushedCommit")).toEqual(["core/proof/revert/revert-detect.ts", "core/proof/revert/revert-watch.ts"]);
    // The laptop wrapper delegates to the host's `noteReverted`; the glue (one per company, hosted and laptop alike) calls it once for each newly recorded revert.
    expect(where(".noteReverted(")).toEqual(["lessons/revert-watch-glue.ts", "local/app/lessons.ts"]);
    // The lessons pass (hosted) and the lessons timer (laptop) are the two places the watch runs.
    expect(where("createLessonsRevertWatch(")).toEqual(["core-host/lessons.ts", "lessons/revert-watch-glue.ts", "local/app/lessons.ts"]);
  });

  it("plan and design comments: a person's 'request changes' at a plan or design gate (their reason is a decision on the task) is not read by the hosted subject, and is not a send-back either", async () => {
    const w = await hostedWorld();
    const [planChangeId] = await decide(w.fake, w.taskId, [{ decision: "REQUEST_CHANGES", source: "GATE", reason: PLAN_WORDS, commentsIncluded: 2, via: "PAGE" }]);
    const sources = hostedSources(w);
    const read = await sources.source.read({ workspaceId: A, taskId: w.taskId });
    // The capture point exists (the decision is on the task's workflow, with the person's own words and the count of page comments sent with it), yet no span, no send-back request and no fact carries it.
    expect(JSON.stringify(read)).not.toContain(PLAN_WORDS);
    expect(read?.sendBackRequestIds).toEqual([]);
    expect(await sources.rows.sendBack({ workspaceId: A, project: "payments", taskId: w.taskId, requestId: planChangeId! })).toMatchObject({ origin: "automatic" });
    await w.runtime.flow.deps.lessonsSentBack!(w.taskId);
    expect(await queued(w.fake)).toEqual([]);
  });
});
