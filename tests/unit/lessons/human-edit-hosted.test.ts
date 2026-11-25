// L4-LM1c: the human-edit job on the hosted install's lessons (`createCoreLessons`), end to end over the fake world: a person's push is noticed (`host.noteHumanEdit`), queued once, and the worker's `humanEdit` handler runs
// it (the job is no longer "unavailable"). The extractor's model call is the reflector's: the company's own learning model and spend, never anything else; and every check the queue's message is not trusted for is
// made again from the company's own records: the company, the task, the pull request, the head, each author as a member of this company.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type CommitIdentity, type IdentityProvider, type JsonValue, type OrgId, type Principal, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime, type CoreRuntime } from "../../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE, type CoreLessons } from "../../../packages/broker/src/core-host/lessons.js";
import type { HumanEditPush } from "../../../packages/broker/src/core/merge/seams.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { humanEditRowKey } from "../../../packages/broker/src/lessons/human-edit-producer.js";
import { reflectQueueOf } from "../../../packages/broker/src/lessons/reflect-queue.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../../support/core-host-fakes.js";
import { ScriptedModel, Spend, candidateJson, reply } from "./lesson-helpers.js";
import { createHostedIdentity } from "../../../packages/broker/src/core-host/hosted-modules.js";
import { githubLinkReaderOver, linkGithubAccount, unlinkGithubAccount } from "../../../packages/broker/src/core/people/github-links.js";

afterEach(() => setLearnedLessonsGate(() => true));

const A = FAKE_COMPANY as OrgId;
const B = "org_corehost00000000000b" as OrgId;
const DEFINITION: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const FIVE = "await withRetry(() => load())\nawait withRetry(() => save())\nawait withRetry(() => sync())\nconst a = 1\nconst b = 2\n";
const acct = (login: string, id: string) => ({ login, hostUserId: id, accountType: "person" as const });
const personRae: CommitIdentity = { author: acct("rae", "1001"), committer: acct("rae", "1001"), webFlow: false };
const personKim: CommitIdentity = { author: acct("kim", "1002"), committer: acct("kim", "1002"), webFlow: false };

/** The members of the world's companies: Rae (1001) is a member of A on the project's roster, Kim (1002) is A's member but off the roster, Lou (1003) is B's. */
const MEMBERS: Record<string, { companyId: string; personId: string }> = { "1001": { companyId: A, personId: "member-rae" }, "1002": { companyId: A, personId: "member-kim" }, "1003": { companyId: B, personId: "member-lou" } };
const principalOf = (companyId: string, personId: string): Principal => ({ companyId, personId, displayName: personId, roles: [], provider: "test" });
/** The identity point as a real one answers: an account is a member of the company that asks, or nobody. */
const identity: Pick<IdentityProvider, "resolveExternalAccount"> = {
  async resolveExternalAccount(companyId, account) {
    const found = MEMBERS[account.accountId];
    return found === undefined || account.provider !== "github" || found.companyId !== companyId ? undefined : principalOf(companyId, found.personId);
  },
};
/** A careless one that answers with the account's own company whoever asks: the lessons must still refuse a person of another company. */
const careless: Pick<IdentityProvider, "resolveExternalAccount"> = {
  async resolveExternalAccount(_companyId, account) { const found = MEMBERS[account.accountId]; return found === undefined ? undefined : principalOf(found.companyId, found.personId); },
};
const people = (over: { roster?: readonly string[]; erased?: readonly string[] } = {}): HostedLessonPeople => ({
  async approvers() { return { complete: true, membershipVersion: 1, ownerIds: [], eligibleIds: [], lastEligibleLossAtMs: null }; },
  async onProjectRoster(company, _project, personId) { return personId === localOwnerPrincipal({ companyId: company }).personId || (over.roster ?? ["member-rae"]).includes(personId); },
  async linkedAccounts() { return []; }, async displayName() { return undefined; }, async isErased(_company, personId) { return (over.erased ?? []).includes(personId); },
});

interface Company { runtime: CoreRuntime; lessons: CoreLessons; taskId: string }
interface Setup { fake: FakeWorld; a: Company; b: Company; model: ScriptedModel; spend: Spend; entries: Array<Record<string, unknown>>; branch: string; rovara: string; number: number; url: string; push(head: string, over?: Partial<HumanEditPush>): HumanEditPush }

async function setup(over: { learning?: boolean; people?: { roster?: readonly string[]; erased?: readonly string[] }; replies?: string[]; identity?: Pick<IdentityProvider, "resolveExternalAccount"> | null } = {}): Promise<Setup> {
  const fake = createFakeWorld();
  const env = { [CORE_LESSONS_VARIABLE]: "on" };
  setCoreLessonsGate(env);
  const registry = await buildCoreRegistry({ modules: fake.modules, context: fake.context(), areas: ["flow", "build", "merge"] });
  const lessonsSwitch = readCoreLessonsSwitch(env).value;
  const hosts = new Map<string, CoreLessons>();
  const model = new ScriptedModel(over.replies ?? [reply(candidateJson({ type: "convention", evidenceSpanIds: ["S1"], citations: [] }))]);
  const spend = new Spend();
  const entries: Array<Record<string, unknown>> = [];
  const companies = new Map<OrgId, Company>();
  for (const companyId of [A, B]) {
    await fake.store.put({ item: { ...projectRevisionKey(companyId, DEFINITION.name, DEFINITION.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(DEFINITION)) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(companyId, DEFINITION.name), entityType: "PROJECT_CATALOG", latestRevision: DEFINITION.revision } });
    const runtime = createCoreRuntime({
      registry, companyId, callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined,
    });
    const lessons = createCoreLessons({
      flow: runtime.flow, registry, companyId, lessonsSwitch, people: people(over.people), ...(over.identity === null ? {} : { identity: over.identity ?? identity }), hostFor: async (id) => hosts.get(id)?.host, now: () => fake.clock.now,
      ...(over.learning === false ? {} : { learning: { model, spend } }), log: (entry) => { entries.push(entry); },
    })!;
    lessons.attach();
    hosts.set(companyId, lessons);
    const { task } = await runtime.flow.start({ principal: localOwnerPrincipal({ companyId }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Make the retries use the helper", workflow: true, workflowPath: "QUICK" });
    companies.set(companyId, { runtime, lessons, taskId: task.taskId });
  }
  // One pull request on the fake host (both companies' tasks name the same repository address; only A's task links it), Rovara's own head first.
  const hostModel = fake.host.model;
  const branch = "agentx/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rovara = hostModel.commit(branch, { "src/fetch.ts": "load()\n" });
  const { cr } = hostModel.reconcile({ sourceBranch: branch, targetBranch: "main", title: "Make retries use the helper" });
  const number = Number(cr.id);
  const url = hostModel.crUrl(cr.id);
  const a = companies.get(A)!;
  const b = companies.get(B)!;
  for (const company of [a, b]) {
    const record = (await fake.store.get(taskKey(company.taskId)))! as unknown as Record<string, unknown> & { workflow: Record<string, unknown> };
    const workflow = { ...record.workflow, pullRequests: [{ repositoryId: "demo", number, url, headSha: rovara, headTreeSha: "d".repeat(40), candidateDigest: "c".repeat(64), required: true, state: "OPEN" }] };
    await fake.store.put({ item: { ...record, workflow } as never });
  }
  const push = (head: string, extra: Partial<HumanEditPush> = {}): HumanEditPush => ({
    task: { taskId: a.taskId, orgId: A, project: "payments" } as HumanEditPush["task"], pullRequest: { repositoryId: "demo", number, url },
    repository: { url: hostModel.url, codeHost: fake.host, scope: { orgId: A } }, base: rovara, head, headRef: branch, ...extra,
  });
  return { fake, a, b, model, spend, entries, branch, rovara, number, url, push };
}

const personPush = (s: Setup, identityOf: CommitIdentity = personRae, files: Record<string, string | null> = { "src/fetch.ts": FIVE }): string => {
  const head = s.fake.host.model.commit(s.branch, files);
  s.fake.host.model.commitIdentities.set(head, identityOf);
  return head;
};

async function queued(fake: FakeWorld): Promise<Array<Record<string, unknown>>> {
  const queue = await reflectQueueOf(fake.queues);
  return (await queue.receive({ maxMessages: 10 })).map((message) => message.body as Record<string, unknown>);
}
const classes = (s: Setup): string[] => s.entries.filter((entry) => entry["event"] === "lessons_worker.result").map((entry) => String(entry["class"]));

describe("a person's push on the hosted install", () => {
  it("is noticed, queued once, and the worker runs the job: the extractor reads the person's lines under the person's member id, with the company's own model", async () => {
    const s = await setup();
    const head = personPush(s);
    await s.a.lessons.host.noteHumanEdit(s.push(head));
    await s.a.lessons.host.noteHumanEdit(s.push(head));
    const messages = await queued(s.fake);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "human_edit", orgId: A, taskId: s.a.taskId, headSha: head, candidateHeadSha: s.rovara });
    const outcome = await s.a.lessons.host.reflectOne(JSON.stringify(messages[0]));
    // The job ran: not "unavailable", and the company's own learning model was asked exactly once, about the person's lines.
    expect(classes(s)).not.toContain("human_edit_unavailable");
    expect(outcome.result).not.toBe("failed");
    expect(s.model.calls).toHaveLength(1);
    const prompt = JSON.stringify(s.model.calls[0]);
    expect(prompt).toContain("kind=human_edit");
    expect(prompt).toContain("withRetry");
    expect(s.spend.asked.length).toBeGreaterThan(0);
    // A redelivery of the same job is already done: no second call, nothing more spent.
    const again = await s.a.lessons.host.reflectOne(JSON.stringify(messages[0]));
    expect(again.result).toBe("already");
    expect(s.model.calls).toHaveLength(1);
    // The head is dealt with: another notice reads nothing and queues nothing.
    await s.a.lessons.host.noteHumanEdit(s.push(head));
    expect(await queued(s.fake)).toEqual([]);
  });

  it("without the handler the same message would be 'unavailable' and retried (the control): the host without `humanEdit` input answers so", async () => {
    // The worker's own rule, unchanged: a human-edit message with no handler fails and comes back.
    const { runReflectMessage } = await import("../../../packages/broker/src/lessons/reflect-worker.js");
    const { documentReflectClaims } = await import("../../../packages/broker/src/lessons/reflect-claims.js");
    const s = await setup();
    const head = personPush(s);
    await s.a.lessons.host.noteHumanEdit(s.push(head));
    const [message] = await queued(s.fake);
    const logs: string[] = [];
    const bare = await runReflectMessage({
      claims: documentReflectClaims({ store: s.fake.store, keysOutcome: async () => "clear" }), now: () => s.fake.clock.now, deadlineMs: 60_000, log: (event, fields) => { logs.push(`${event}:${String(fields["class"])}`); },
      learn: async () => ({ status: "no_facts", retry: false }),
    }, JSON.stringify(message));
    expect(bare).toEqual({ result: "failed", retry: true });
    expect(logs).toContain("lessons_worker.result:human_edit_unavailable");
  });

  it("with no AI key of the company's own nothing is spent and no model is asked: the job ends quietly (no retry), as the learning path does without a key, and Rovara pays for nothing", async () => {
    const s = await setup({ learning: false });
    const head = personPush(s);
    await s.a.lessons.host.noteHumanEdit(s.push(head));
    const [message] = await queued(s.fake);
    const edit = await s.a.lessons.host.reflectOne(JSON.stringify(message));
    expect(s.model.calls).toEqual([]);
    expect(s.spend.asked).toEqual([]);
    expect(edit.retry).toBe(false);
    expect(classes(s)).not.toContain("human_edit_unavailable");
    // The company's learning path with no model refuses every call (the refusing model and the denying spend): with one given, the same job asks it.
    const keyed = await setup();
    const keyedHead = personPush(keyed);
    await keyed.a.lessons.host.noteHumanEdit(keyed.push(keyedHead));
    const [keyedMessage] = await queued(keyed.fake);
    await keyed.a.lessons.host.reflectOne(JSON.stringify(keyedMessage));
    expect(keyed.model.calls).toHaveLength(1);
  });
});

describe("what is ignored or refused", () => {
  it("a bot's push, an unlinked identity, and a merge-only push queue nothing and the handler is never asked", async () => {
    const s = await setup();
    const bot: CommitIdentity = { author: { login: "rovara[bot]", hostUserId: "9001", accountType: "bot" }, committer: { login: "rovara[bot]", hostUserId: "9001", accountType: "bot" }, webFlow: false };
    for (const identityOf of [bot, { webFlow: false } as CommitIdentity]) {
      await s.a.lessons.host.noteHumanEdit(s.push(personPush(s, identityOf)));
    }
    expect(await queued(s.fake)).toEqual([]);
    expect(s.model.calls).toEqual([]);
  });

  it("another company: A's host ignores a push of B's task; a job for B delivered to A is dropped (company mismatch) and never reads the code host", async () => {
    const s = await setup();
    const head = personPush(s);
    await s.a.lessons.host.noteHumanEdit(s.push(head, { task: { taskId: s.b.taskId, orgId: B, project: "payments" } as HumanEditPush["task"] }));
    // B's task id under A's own company: the record is B's, so A's host does not own it.
    await s.a.lessons.host.noteHumanEdit(s.push(head, { task: { taskId: s.b.taskId, orgId: A, project: "payments" } as HumanEditPush["task"] }));
    expect(await queued(s.fake)).toEqual([]);
    // Positive control: A's own task queues.
    await s.a.lessons.host.noteHumanEdit(s.push(head));
    const [message] = await queued(s.fake);
    expect(message).toBeDefined();
    // The same message as B's (a forged or misrouted copy) given to A's worker: it names B, so A's host answers nothing to learn and reads nothing.
    const forged = { ...message!, orgId: B, taskId: s.b.taskId };
    const outcome = await s.a.lessons.host.reflectOne(JSON.stringify(forged));
    expect(s.model.calls).toEqual([]);
    expect(outcome.retry).toBe(false);
  });

  it("a push whose person is not a member of this company, or is not on the project's roster, or is erased, teaches nothing and calls no model", async () => {
    for (const [name, identityOf, over] of [
      ["an account of no member", { author: acct("zed", "7777"), committer: acct("zed", "7777"), webFlow: false } as CommitIdentity, undefined],
      ["a member of another company (even from a careless identity point)", { author: acct("lou", "1003"), committer: acct("lou", "1003"), webFlow: false } as CommitIdentity, { identity: careless, people: { roster: ["member-lou"] } }],
      ["a member off the roster", personKim, undefined],
      ["an erased member", personRae, { people: { erased: ["member-rae"] } }],
    ] as const) {
      const s = await setup(over ?? {});
      const head = personPush(s, identityOf);
      await s.a.lessons.host.noteHumanEdit(s.push(head));
      const [message] = await queued(s.fake);
      expect(message, name).toBeDefined();
      await s.a.lessons.host.reflectOne(JSON.stringify(message));
      expect(s.model.calls, name).toEqual([]);
    }
  });

  it("a job whose head moved on, whose pull request is not the task's, or whose repository is not the project's is skipped without a model call", async () => {
    const s = await setup();
    const first = personPush(s);
    await s.a.lessons.host.noteHumanEdit(s.push(first));
    const [message] = await queued(s.fake);
    // The pull request's head moved on before the worker ran.
    personPush(s, personRae, { "src/save.ts": FIVE });
    await s.a.lessons.host.reflectOne(JSON.stringify(message));
    expect(s.model.calls).toEqual([]);
    // Another pull request number, and another repository name, in a job for the task.
    const head = personPush(s, personRae, { "src/sync.ts": FIVE });
    await s.a.lessons.host.noteHumanEdit(s.push(head));
    const [latest] = await queued(s.fake);
    const stray = { ...latest!, requestId: "stray-1", pullRequest: { number: 999, url: "https://github.com/example/demo/pull/999" } };
    await s.a.lessons.host.reflectOne(JSON.stringify(stray));
    const elsewhere = { ...latest!, requestId: "stray-2", repo: { ...(latest!["repo"] as object), fullName: "someone-else/repo" } };
    await s.a.lessons.host.reflectOne(JSON.stringify(elsewhere));
    expect(s.model.calls).toEqual([]);
  });

  it("with no identity option the registry's own identity point is asked: the fake world's links no accounts, so no push is read from the host and nothing is queued (the hosted identity point of an install without account links is the same)", async () => {
    const s = await setup({ identity: null });
    let hostReads = 0;
    const head = personPush(s);
    const host = s.fake.host;
    const original = host.commitChanges.bind(host);
    host.commitChanges = async (...args) => { hostReads += 1; return original(...args); };
    await s.a.lessons.host.noteHumanEdit(s.push(head));
    expect(await queued(s.fake)).toEqual([]);
    expect(hostReads).toBe(0);
    expect(s.model.calls).toEqual([]);
  });

  it("the project's learning mode Off or Collect: nothing queued, and the host is not read", async () => {
    const { writeLearningMode } = await import("../../../packages/broker/src/lessons/document-settings.js");
    for (const mode of ["Off", "Collect"] as const) {
      const s = await setup();
      await writeLearningMode(s.a.lessons.runtime.documents, { workspaceId: A, project: "payments" }, mode, s.fake.clock.now);
      const head = personPush(s);
      await s.a.lessons.host.noteHumanEdit(s.push(head));
      expect(await queued(s.fake), mode).toEqual([]);
      expect(await s.fake.store.get(humanEditRowKey(A, s.a.taskId, head)), mode).toBeUndefined();
    }
  });
});

describe("the real hosted identity point with linked GitHub accounts (L4-GH): the producer's author proof places a linked member and skips an unlinked one", () => {
  const ROLES: Record<string, string> = { "member-rae": A, "member-kim": A, "member-lou": B };
  /** The stock hosted identity point over the world's own store, so a link written through the link module is what the lessons' `personOf` reads. */
  const hosted = (store: () => FakeWorld["store"]) => createHostedIdentity({
    membershipOf: async (personId) => (ROLES[personId] === undefined ? undefined : { companyId: ROLES[personId], role: "member" }),
    displayNameOf: async (personId) => personId,
    githubLinks: githubLinkReaderOver({ get: (key) => store().get(key) }),
  });
  async function linked(over: { people?: { roster?: readonly string[]; erased?: readonly string[] } } = {}) {
    const held: { world?: Setup } = {};
    const s = await setup({ ...over, identity: hosted(() => held.world!.fake.store) });
    held.world = s;
    const link = (companyId: string, githubUserId: string, personId: string) => linkGithubAccount(s.fake.store, { companyId, githubUserId, login: `u${githubUserId}`, personId, linkedAt: "2026-11-17T10:00:00.000Z" });
    return { s, link };
  }
  const run = async (s: Setup, identityOf: CommitIdentity) => {
    await s.a.lessons.host.noteHumanEdit(s.push(personPush(s, identityOf)));
    for (const message of await queued(s.fake)) await s.a.lessons.host.reflectOne(JSON.stringify(message));
  };

  it("a push by a member who linked their GitHub account is learned from; the same push by an unlinked author calls no model", async () => {
    const unlinked = await linked();
    await run(unlinked.s, personRae);
    expect(unlinked.s.model.calls).toEqual([]);
    const { s, link } = await linked();
    expect(await link(A, "1001", "member-rae")).toBe("linked");
    await run(s, personRae);
    expect(s.model.calls).toHaveLength(1);
    expect(JSON.stringify(s.model.calls[0])).toContain("withRetry");
  });
  it("an account linked to a member of ANOTHER company, or linked then unlinked, places nobody in this company", async () => {
    const other = await linked();
    expect(await other.link(B, "1001", "member-lou")).toBe("linked");
    await run(other.s, personRae);
    expect(other.s.model.calls).toEqual([]);
    const gone = await linked();
    await gone.link(A, "1001", "member-rae");
    await unlinkGithubAccount(gone.s.fake.store, A, "member-rae");
    await run(gone.s, personRae);
    expect(gone.s.model.calls).toEqual([]);
  });
  it("a link whose member left the company (no membership now) places nobody", async () => {
    const left = await linked();
    await left.link(A, "1001", "member-gone");
    await run(left.s, personRae);
    expect(left.s.model.calls).toEqual([]);
  });
});
