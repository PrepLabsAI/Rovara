// M7 after-merge watcher, slice 2 (decision 252b): the code host's deployment facts, the real reporter, the real `afterMergeWatch` setting reader, the ingress calls and the periodic pass. The code host is the fake over the neutral
// port (never the real GitHub: the GitHub adapter's own mapping is in github-deployments.test.ts), the chat is a Rovara-made adapter, the store is the in-memory port implementation. A green run proves the watcher's wiring, its
// company binding and its bounds; it does not prove that a real GitHub, Slack or deploy tool behaves this way.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AfterMergeWatchSettingSchema, DocumentStoreError, INDEX_EXPIRY_ATTRIBUTE, ProjectDefinitionSchema, orgProjectCatalogKey, projectMetaKey, projectRevisionKey, workerProjectDefinition,
  type AuditEvent, type AuditSink, type ChannelEvent, type CodeHost, type OrgId, type TransactItem, type TriggerEvent,
} from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { mergeCommitIndexStep } from "../../packages/broker/src/core/proof/revert/merge-commit-index.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { recordTaskThread } from "../../packages/broker/src/core/channel/threads.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { agentSessionKey } from "@agentx/contracts";
import {
  createAfterMergeReporter, createAfterMergeService, createProjectAfterMergeSettings, createStoreAfterMergeTasks, createTaskHosts, deployFactOfEvent, deployFactsOfRead, githubRepositoryOfUrl,
  pullRequestLineOf, reconcileDeployments, RECONCILE_TARGETS_MAX, type AfterMergeDeps, type AfterMergeHosts, type AfterMergeService,
} from "../../packages/broker/src/core/after-merge/index.js";
import { HostRateLimitError } from "@agentx/contracts";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PROJECT = "shared-project";
const REPO = "acme/payments";
const REPO_URL = "https://github.com/acme/payments";
const SHA = "1".repeat(40);
const SHA2 = "2".repeat(40);
const T0 = Date.parse("2026-11-16T12:00:00.000Z");
const minutes = (count: number): number => count * 60_000;
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const CANARY = "canary-secret-host-words";

/** A fake host that counts the calls the watcher makes of it, and can be made to fail. */
class CountingHost extends FakeCodeHost {
  statusCalls = 0;
  commentCalls = 0;
  scopes: unknown[] = [];
  failStatuses: Error | undefined;
  failComments = 0;
  answer: unknown;
  override async deploymentStatuses(...args: Parameters<NonNullable<CodeHost["deploymentStatuses"]>>) {
    this.statusCalls += 1;
    this.scopes.push(args[2]);
    if (this.failStatuses !== undefined) throw this.failStatuses;
    if (this.answer !== undefined) return this.answer as Awaited<ReturnType<NonNullable<CodeHost["deploymentStatuses"]>>>;
    return super.deploymentStatuses(...args);
  }
  override async postComment(...args: Parameters<NonNullable<CodeHost["postComment"]>>) {
    this.commentCalls += 1;
    this.scopes.push(args[2]);
    if (this.failComments > 0) { this.failComments -= 1; throw new Error(CANARY); }
    return super.postComment(...args);
  }
  postedComments(): string[] {
    return this.model.changeRequests.flatMap((request) => request.comments.map((comment) => comment.body));
  }
}

interface Company {
  orgId: OrgId;
  model: FakeHostModel;
  host: CountingHost;
  chat: ChannelEvent[];
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  service: AfterMergeService;
  deps: AfterMergeDeps;
  hosts: AfterMergeHosts;
  options: { chatFails: number; tenantCompany: OrgId | undefined; member: boolean; noChat: boolean; surfaces?: { pull_request?: boolean; task?: boolean; chat?: boolean } };
}

/** One store for every company (so a key that forgets its company shows), one host, chat and service for each. */
function createWorld() {
  const clock = { ms: T0 };
  const store = new MemoryDocumentStore({ ttlAttribute: INDEX_EXPIRY_ATTRIBUTE, nowSeconds: () => Math.floor(clock.ms / 1_000) });
  const audit: AuditSink = {
    stage: (event: AuditEvent) => [{ kind: "put", item: { pk: `AUDIT_FAKE#${event.companyId}`, sk: event.eventId, action: event.action, digest: createHash("sha256").update(JSON.stringify(event)).digest("hex") } }] satisfies TransactItem[],
    record: async () => undefined,
  };
  const companies = new Map<OrgId, Company>();

  function company(orgId: OrgId, options: { hostOf?: (model: FakeHostModel) => CountingHost } = {}): Company {
    const existing = companies.get(orgId);
    if (existing !== undefined) return existing;
    const model = new FakeHostModel({ url: REPO_URL, id: "4242", fullName: REPO, webBase: "https://github.com" });
    const host = options.hostOf?.(model) ?? new CountingHost(model);
    const chat: ChannelEvent[] = [];
    const logs: Company["logs"] = [];
    const state: Company["options"] = { chatFails: 0, tenantCompany: undefined, member: true, noChat: false };
    const registry = {
      get: (point: string, name: string): unknown => {
        if (point === "code-host" && name === "fake") return host;
        if (point === "channel" && name === "chat" && !state.noChat) return { capabilities: {}, deliver: async (event: ChannelEvent) => { if (state.chatFails > 0) { state.chatFails -= 1; throw new Error(CANARY); } chat.push(event); } };
        return undefined;
      },
      names: (point: string): string[] => (point === "code-host" ? ["fake"] : point === "channel" ? ["chat"] : []),
    };
    const hosts = createTaskHosts({ store, registry: registry as never });
    const log = (event: string, fields: Record<string, unknown>): void => { logs.push({ event, fields }); };
    const deps: AfterMergeDeps = {
      store, audit, tasks: createStoreAfterMergeTasks(store), settings: createProjectAfterMergeSettings(store),
      reporter: createAfterMergeReporter({
        store, hosts, registry: registry as never, now: () => clock.ms, log,
        companyOf: () => state.tenantCompany ?? orgId, isMember: () => state.member, surfaces: () => state.surfaces ?? {},
      }),
      now: () => new Date(clock.ms), log,
    };
    const made: Company = { orgId, model, host, chat, logs, deps, hosts, options: state, service: createAfterMergeService({ companyId: orgId, deps, hosts }) };
    companies.set(orgId, made);
    return made;
  }

  /** The project (`afterMergeWatch` as given; absent: none), its catalog row, and the pinned repository on the fake host. */
  async function seedProject(orgId: OrgId, setting: unknown = { enabled: true, windowMinutes: 30, environments: ["staging"], revert: "report_only" }, name = PROJECT): Promise<void> {
    // "absent": the project has no setting at all (an `undefined` argument would take the default).
    const definition = {
      name, revision: 1, repositories: [{ name: "payments", url: REPO_URL, path: "repo/payments", defaultBranch: "main", credentialRef: "github", host: { kind: "fake" } }],
      setup: [], readiness: [], orchestratorInstructions: "Build it.", ...(setting === "absent" ? {} : { afterMergeWatch: setting }),
    };
    await store.put({ item: { ...projectRevisionKey(orgId, name, 1), definition: definition as never } });
    await store.put({ item: { ...orgProjectCatalogKey(orgId, name), latestRevision: 1 } });
  }

  /** A task of the company, a pull request on its host, a session and a thread, and the merge commit index row. */
  async function seedMerge(orgId: OrgId, input: { taskId?: string; sha?: string; project?: string; thread?: boolean; session?: boolean; repository?: string } = {}): Promise<{ taskId: string; number: number; url: string }> {
    const c = company(orgId);
    const taskId = input.taskId ?? `task-${orgId.charAt(4)}-7`;
    const sha = input.sha ?? SHA;
    c.model.commit(`feature/${taskId}`, { [`src/${taskId}.ts`]: "export const a = 1;\n" });
    const { cr } = c.model.reconcile({ sourceBranch: `feature/${taskId}`, targetBranch: "main", title: "Add a" });
    const number = Number(cr.id);
    const url = c.model.crUrl(cr.id);
    const sessionId = taskSessionId(taskId);
    await store.put({ item: { ...taskKey(taskId), taskId, companyId: orgId, project: input.project ?? PROJECT, startingRevision: 1, sessionId } });
    if (input.session !== false) await store.put({ item: { ...agentSessionKey(orgId, sessionId, "META"), orgId, sessionId } });
    if (input.thread !== false) await recordTaskThread({ store, orgId, now: () => clock.ms }, { sessionId, conversation: { channel: "chat", tenant: "t1", space: "c1", thread: "th1" }, personId: "person-1", actor: { channel: "chat", tenant: "t1", userId: "u1" } });
    const step = mergeCommitIndexStep({ orgId, repositoryFullName: input.repository ?? REPO, repositoryId: "4242", number, url, taskId, mergeCommit: sha, now: at(-minutes(5)) }, INDEX_EXPIRY_ATTRIBUTE);
    expect(await store.transact([step!])).toEqual({ applied: true });
    return { taskId, number, url };
  }

  return { store, clock, company, seedProject, seedMerge, audit };
}
type World = ReturnType<typeof createWorld>;

const deployEvent = (over: Record<string, unknown> = {}) => ({ eventId: "d-1", host: "github", type: "deployment.status", repository: { url: REPO_URL }, revision: SHA, environment: "staging", state: "success", ...over });
const alarm = (over: Record<string, unknown> = {}): TriggerEvent => ({
  source: "cloudwatch", type: "alarm.fired", eventKey: "evt-1", occurredAt: at(minutes(5)), project: PROJECT,
  subject: { kind: "alert", id: "HighLatency", title: "High latency on checkout" }, fields: {}, actor: { kind: "unknown" }, ...over,
});
const watchRows = async (world: World, orgId: OrgId): Promise<unknown[]> => (await world.store.query({ pk: `ORG#${orgId}#AFTER_MERGE`, sk: { op: "beginsWith", prefix: "WATCH#" } })).items;
const sessionLines = async (world: World, orgId: OrgId, taskId: string) => (await world.store.query({ pk: agentSessionKey(orgId, taskSessionId(taskId), "META").pk })).items.filter((item) => item["entityType"] === "AGENT_SESSION_EVENT");

/** The project with the default setting ("on, staging, report only") and one merge of the company. */
async function setupOn(world: World, orgId: OrgId = A, input: Parameters<World["seedMerge"]>[1] = {}) {
  await world.seedProject(orgId);
  return world.seedMerge(orgId, input);
}

describe("the deployment event: the ingress opens a watch for the company's own merge only", () => {

  it("is off for a project that does not exist, one that is archived, and a stored definition that does not parse", async () => {
    const world = createWorld();
    await world.seedMerge(A);
    expect(await world.company(A).service.codeHostEvent(deployEvent())).toEqual({ kind: "off" });
    await world.seedProject(A);
    await world.store.put({ item: { ...projectMetaKey(A, PROJECT), status: "archived" } });
    expect(await world.company(A).service.codeHostEvent(deployEvent())).toEqual({ kind: "off" });
    await world.store.put({ item: { ...projectMetaKey(A, PROJECT), status: "active" } });
    expect((await world.company(A).service.codeHostEvent(deployEvent())).kind).toBe("opened");
    await world.store.put({ item: { ...projectRevisionKey(A, PROJECT, 1), definition: { name: PROJECT, revision: 1 } } });
    expect(await createProjectAfterMergeSettings(world.store).read(A, PROJECT)).toBeUndefined();
  });

  it("answers other event types and shapes it cannot use with fixed words", async () => {
    const world = createWorld();
    await setupOn(world);
    const service = world.company(A).service;
    expect(await service.codeHostEvent({ eventId: "e", host: "github", type: "revision.pushed", repository: { url: REPO_URL }, branch: "main", revision: SHA })).toEqual({ kind: "ignored", reason: "not_a_deployment" });
    for (const bad of [null, undefined, "deployment.status", {}, deployEvent({ state: "inactive" }), deployEvent({ environment: "" }), deployEvent({ extra: 1 }), deployEvent({ revision: "" }), [deployEvent()]]) {
      expect(await service.codeHostEvent(bad)).toEqual({ kind: "ignored", reason: "invalid_event" });
    }
    // A host that is not GitHub (or a repository address that is not a plain repository) cannot be matched to a merge.
    for (const url of ["https://gitlab.example.test/acme/payments", "https://github.com/acme/payments/tree/main", "https://github.com/acme", "http://github.com/acme/payments"])  {
      expect(await service.codeHostEvent(deployEvent({ repository: { url } })), url).toEqual({ kind: "ignored", reason: "invalid_fact" });
    }
    // A name that merely ends in `.git` is a repository name of its own: nothing of ours.
    expect(await service.codeHostEvent(deployEvent({ repository: { url: "https://github.com/acme/payments.git" } }))).toEqual({ kind: "ignored", reason: "not_ours" });
    expect(await watchRows(world, A)).toEqual([]);
  });

  it("opens no watch for a deploy still in progress, and reports a failed deploy once", async () => {
    const world = createWorld();
    const { number } = await setupOn(world);
    const service = world.company(A).service;
    expect(await service.codeHostEvent(deployEvent({ state: "in_progress" }))).toEqual({ kind: "ignored", reason: "in_progress" });
    expect(await watchRows(world, A)).toEqual([]);
    expect((await service.codeHostEvent(deployEvent({ state: "failure" }))).kind).toBe("deploy_failed");
    expect(world.company(A).host.postedComments()).toEqual([expect.stringContaining("Deploy to staging failed")]);
    expect(await service.codeHostEvent(deployEvent({ state: "failure" }))).toBeDefined();
    expect(world.company(A).host.postedComments()).toHaveLength(1);
    expect(world.company(A).model.changeRequests.map((request) => Number(request.id))).toContain(number);
  });

  it("refuses to be made for a value that is not a company", () => {
    const world = createWorld();
    const deps = world.company(A).deps;
    for (const bad of ["", "org_x", "ORG#a", undefined]) expect(() => createAfterMergeService({ companyId: bad as never, deps }), String(bad)).toThrow("company id");
  });
});

describe("the alarm ingress", () => {
  it("hands an alarm to the open watch of its project, and reports it once to the pull request", async () => {
    const world = createWorld();
    const { number } = await setupOn(world);
    const service = world.company(A).service;
    await service.codeHostEvent(deployEvent());
    world.clock.ms = T0 + minutes(5);
    expect(await service.triggerEvent(alarm())).toMatchObject({ kind: "recorded", watches: 1, reported: 1 });
    expect(world.company(A).host.postedComments()).toEqual([expect.stringContaining("High latency on checkout")]);
    expect(await service.triggerEvent(alarm())).toMatchObject({ kind: "recorded", reported: 0 });
    expect(world.company(A).host.postedComments()).toHaveLength(1);
    expect(world.company(A).model.changeRequests.map((request) => Number(request.id))).toContain(number);
    expect(await service.triggerEvent({ nonsense: true })).toEqual({ kind: "ignored", reason: "invalid_event" });
  });
});

describe("the reporter", () => {
  async function opened(world: World, orgId: OrgId = A, input: Parameters<World["seedMerge"]>[1] = {}) {
    const merged = await setupOn(world, orgId, input);
    await world.company(orgId).service.codeHostEvent(deployEvent({ revision: input.sha ?? SHA }));
    return merged;
  }
  const closeWindow = async (world: World, orgId: OrgId = A) => { world.clock.ms = T0 + minutes(31); return world.company(orgId).service.pass({ budgetMs: 5_000 }); };

  it("makes the pull request line one short line with no @, no control character and no more than 200 characters", () => {
    for (const text of ["Alarm after deploy to staging: @everyone look\nnow.", `Alarm: ${"x".repeat(400)}`, "a\u0000b\u0007c @@ d", "😀".repeat(150), "@"]) {
      const line = pullRequestLineOf(text);
      expect(line.length, text).toBeLessThanOrEqual(200);
      expect(line, text).not.toMatch(/[\p{Cc}@]/u);
      expect(line.startsWith("Rovara:")).toBe(true);
    }
    expect(pullRequestLineOf("Deployed to staging, healthy for 30 min.")).toBe("Rovara: Deployed to staging, healthy for 30 min.");
    // Cut on a character, never in the middle of a pair.
    expect(pullRequestLineOf("😀".repeat(150))).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u);
  });

  it("comments only on the pull request the report is about", async () => {
    const world = createWorld();
    const { taskId } = await opened(world);
    const c = world.company(A);
    const reporter = createAfterMergeReporter({ store: world.store, hosts: c.hosts, now: () => world.clock.ms });
    const base = { reportId: "b".repeat(64), kind: "healthy" as const, taskId, repository: REPO, number: 1, environment: "staging", text: "Deployed.", actions: { revert: false, expected: false } };
    for (const [index, url] of [`${REPO_URL}/pull/2`, "https://github.com/acme/other/pull/1", "https://example.test/pull/1", ""].entries()) {
      await reporter.report(A, { ...base, reportId: String(index).repeat(64), url });
    }
    expect(c.host.commentCalls).toBe(0);
    await reporter.report(A, { ...base, url: `${REPO_URL}/pull/1` });
    expect(c.host.commentCalls).toBe(1);
  });

  it("skips a surface that does not exist for the task instead of failing the report", async () => {
    const world = createWorld();
    const { taskId } = await opened(world, A, { thread: false, session: false });
    expect(await closeWindow(world)).toMatchObject({ closed: 1, delivered: 0 });
    const c = world.company(A);
    expect(c.host.postedComments()).toHaveLength(1);
    expect(c.chat).toEqual([]);
    expect(await sessionLines(world, A, taskId)).toEqual([]);
    expect((await world.store.query({ pk: `ORG#${A}#AFTER_MERGE_QUEUE`, sk: { op: "beginsWith", prefix: "PENDING#" } })).items).toEqual([]);
  });

  it("never tells a thread of another company's tenant, nor one whose person the host no longer serves, nor a chat that is not registered", async () => {
    for (const change of [
      (c: Company) => { c.options.tenantCompany = B; },
      (c: Company) => { c.options.member = false; },
      (c: Company) => { c.options.noChat = true; },
    ]) {
      const world = createWorld();
      await opened(world);
      change(world.company(A));
      expect(await closeWindow(world)).toMatchObject({ closed: 1, delivered: 0 });
      expect(world.company(A).chat).toEqual([]);
      expect(world.company(A).host.postedComments()).toHaveLength(1);
    }
  });

  it("skips the pull request comment for a host that has none, and for a repository the task's project does not pin", async () => {
    const world = createWorld();
    const { taskId } = await opened(world);
    const c = world.company(A);
    const reporter = createAfterMergeReporter({ store: world.store, hosts: { forTask: async () => undefined }, now: () => world.clock.ms });
    await reporter.report(A, { reportId: "c".repeat(64), kind: "healthy", taskId, repository: REPO, number: 1, url: `${REPO_URL}/pull/1`, environment: "staging", text: "x", actions: { revert: false, expected: false } });
    expect(c.host.commentCalls).toBe(0);
    const noComments = createAfterMergeReporter({ store: world.store, hosts: { forTask: async () => ({ codeHost: { kind: "fake" } as never, repository: { url: REPO_URL }, scope: { orgId: A } }) }, now: () => world.clock.ms });
    await expect(noComments.report(A, { reportId: "d".repeat(64), kind: "healthy", taskId, repository: REPO, number: 1, url: `${REPO_URL}/pull/1`, environment: "staging", text: "x", actions: { revert: false, expected: false } })).resolves.toBeUndefined();
    const other = await createTaskHosts({ store: world.store, registry: { get: () => c.host, names: () => ["fake"] } as never }).forTask(A, taskId, "acme/other");
    expect(other).toBeUndefined();
  });
});

describe("the real afterMergeWatch setting", () => {
  it("is a contract field: valid values save, anything unknown or out of range is refused, and a worker is never sent it", () => {
    const base = { name: PROJECT, revision: 1, repositories: [{ name: "payments", url: REPO_URL, path: "repo/payments", defaultBranch: "main", credentialRef: "github" }], setup: [], readiness: [], orchestratorInstructions: "Build it." };
    for (const good of [{ enabled: true }, { enabled: false }, { enabled: true, windowMinutes: 1, environments: ["staging"], revert: "offer_revert" }, { enabled: true, windowMinutes: 1440, environments: [] }]) {
      expect(ProjectDefinitionSchema.safeParse({ ...base, afterMergeWatch: good }).success, JSON.stringify(good)).toBe(true);
    }
    for (const bad of [{}, { enabled: "true" }, { enabled: true, surprise: 1 }, { enabled: true, windowMinutes: 0 }, { enabled: true, windowMinutes: 1441 }, { enabled: true, windowMinutes: 1.5 }, { enabled: true, revert: "auto" },
      { enabled: true, environments: Array.from({ length: 21 }, (_, index) => `e${String(index)}`) }, { enabled: true, environments: [""] }, { enabled: true, environments: ["e".repeat(65)] }, null, "on"]) {
      expect(ProjectDefinitionSchema.safeParse({ ...base, afterMergeWatch: bad }).success, JSON.stringify(bad)).toBe(false);
      expect(AfterMergeWatchSettingSchema.safeParse(bad).success).toBe(false);
    }
    expect(ProjectDefinitionSchema.safeParse(base).success).toBe(true);
    expect(workerProjectDefinition({ ...base, afterMergeWatch: { enabled: true } })).not.toHaveProperty("afterMergeWatch");
  });

  it("reads a task of the company with its project, and nothing for another company's, a missing one or one with no project", async () => {
    const world = createWorld();
    await world.store.put({ item: { ...taskKey("t1"), taskId: "t1", companyId: A, project: PROJECT } });
    await world.store.put({ item: { ...taskKey("t2"), taskId: "t2", companyId: B, project: PROJECT } });
    await world.store.put({ item: { ...taskKey("t3"), taskId: "t3", companyId: A } });
    await world.store.put({ item: { ...taskKey("t4"), taskId: "other-id", companyId: A, project: PROJECT } });
    const tasks = createStoreAfterMergeTasks(world.store);
    expect(await tasks.read(A, "t1")).toEqual({ taskId: "t1", orgId: A, project: PROJECT });
    for (const id of ["t2", "t3", "t4", "missing", ""]) expect(await tasks.read(A, id), id).toBeUndefined();
  });
});

describe("the deploy read (the code host's deployment statuses)", () => {
  it("maps a host's answer to deploy facts, and ignores an answer that does not check", () => {
    expect(deployFactsOfRead(REPO, SHA, { statuses: [{ environment: "staging", state: "success" }], complete: true })).toEqual({ facts: [{ repository: REPO, revision: SHA, environment: "staging", state: "success", source: "code_host" }], complete: true });
    for (const bad of [undefined, null, {}, { statuses: [{ environment: "staging", state: "inactive" }], complete: true }, { statuses: [], complete: "yes" }, { statuses: [{ environment: "", state: "success" }], complete: true }, { statuses: [], complete: true, extra: 1 }]) {
      expect(deployFactsOfRead(REPO, SHA, bad)).toBeUndefined();
    }
    expect(githubRepositoryOfUrl("https://github.com/Acme/Payments")).toBe(REPO);
    for (const bad of [undefined, 5, "", "https://github.com/acme", "https://github.com/acme/payments/", "https://evil.example.test/acme/payments", "https://github.com/acme/pay ments"]) expect(githubRepositoryOfUrl(bad), String(bad)).toBeUndefined();
    expect(deployFactOfEvent(deployEvent())).toEqual({ repository: REPO, revision: SHA, environment: "staging", state: "success", source: "code_host" });
    expect(deployFactOfEvent({ ...deployEvent(), type: "revision.pushed" })).toBeUndefined();
  });

  const targets = (...shas: string[]) => shas.map((revision) => ({ repository: REPO, revision }));

  it("asks nothing for a commit the company did not merge, for a project that is off, or for a repository its project does not pin", async () => {
    const world = createWorld();
    await setupOn(world);
    const c = world.company(A);
    c.model.setDeployment(SHA2, "staging", "success");
    expect(await reconcileDeployments(c.deps, A, c.hosts, targets(SHA2))).toEqual([{ kind: "skipped", reason: "not_ours" }]);
    expect(await reconcileDeployments(c.deps, A, c.hosts, [{ repository: "acme/other", revision: SHA }])).toEqual([{ kind: "skipped", reason: "not_ours" }]);
    expect(await reconcileDeployments(c.deps, A, c.hosts, [{ repository: "not a repository", revision: SHA }, { repository: REPO, revision: 7 as never }])).toEqual([{ kind: "skipped", reason: "not_ours" }, { kind: "skipped", reason: "not_ours" }]);
    await world.seedProject(A, { enabled: false });
    expect(await reconcileDeployments(c.deps, A, c.hosts, targets(SHA))).toEqual([{ kind: "off" }]);
    expect(c.host.statusCalls).toBe(0);
    await world.seedProject(A);
    expect(await reconcileDeployments(c.deps, A, { forTask: async () => undefined }, targets(SHA))).toEqual([{ kind: "skipped", reason: "no_host" }]);
    expect(await reconcileDeployments({ ...c.deps, settings: undefined }, A, c.hosts, targets(SHA))).toEqual([{ kind: "off" }]);
    expect(c.host.statusCalls).toBe(0);
  });

  it("answers unsupported for a host without the read, and unavailable (never 'no deployments') for one that throws or answers badly", async () => {
    const world = createWorld();
    await setupOn(world);
    const c = world.company(A);
    const without = { forTask: async () => ({ codeHost: { kind: "fake" } as never, repository: { url: REPO_URL }, scope: { orgId: A } }) };
    expect(await reconcileDeployments(c.deps, A, without, targets(SHA))).toEqual([{ kind: "skipped", reason: "unsupported" }]);
    c.host.failStatuses = new Error(CANARY);
    expect(await reconcileDeployments(c.deps, A, c.hosts, targets(SHA))).toEqual([{ kind: "unavailable" }]);
    expect(JSON.stringify(c.logs)).not.toContain(CANARY);
    expect(await watchRows(world, A)).toEqual([]);
    c.host.failStatuses = undefined;
    c.host.answer = { statuses: [{ environment: "staging", state: "weird" }], complete: true };
    expect(await reconcileDeployments(c.deps, A, c.hosts, targets(SHA))).toEqual([{ kind: "unavailable" }]);
    c.host.answer = undefined;
    const faulty = { forTask: async () => { throw new Error(CANARY); } };
    expect(await reconcileDeployments(c.deps, A, faulty, targets(SHA))).toEqual([{ kind: "unavailable" }]);
    expect(JSON.stringify(c.logs)).not.toContain(CANARY);
  });

  it("is bounded in total: at most the target limit, and a spent request allowance stops the pass", async () => {
    const world = createWorld();
    await setupOn(world);
    const c = world.company(A);
    for (let index = 0; index < RECONCILE_TARGETS_MAX + 5; index += 1) await world.seedMerge(A, { taskId: `t-${String(index)}`, sha: String(index + 3).padStart(2, "0").repeat(20) });
    const many = targets(...Array.from({ length: RECONCILE_TARGETS_MAX + 5 }, (_, index) => String(index + 3).padStart(2, "0").repeat(20)));
    expect(await reconcileDeployments(c.deps, A, c.hosts, many)).toHaveLength(RECONCILE_TARGETS_MAX);
    expect(c.host.statusCalls).toBe(RECONCILE_TARGETS_MAX);
    c.host.statusCalls = 0;
    expect(await reconcileDeployments(c.deps, A, c.hosts, many, { targets: 3 })).toHaveLength(3);
    // The allowance is shared by every target: one request each, so a pass of two requests handles two targets and skips the rest.
    c.host.statusCalls = 0;
    const limited = await reconcileDeployments(c.deps, A, c.hosts, many, { targets: 4, requests: 2 });
    expect(limited.map((outcome) => outcome.kind)).toEqual(["read", "read", "skipped", "skipped"]);
    // A pass that is out of time does the same.
    const slow = await reconcileDeployments({ ...c.deps, now: (() => { let tick = 0; return () => new Date(T0 + (tick += 1) * 10_000); })() }, A, c.hosts, many, { targets: 4, ms: 15_000 });
    expect(slow.some((outcome) => outcome.kind === "skipped")).toBe(true);
  });

  it("is the periodic pass's backstop: the merges the host names are read, a failing list is logged, and the sweep still runs", async () => {
    const world = createWorld();
    await setupOn(world);
    const c = world.company(A);
    c.model.setDeployment(SHA, "staging", "success");
    let supply: () => Promise<readonly { repository: string; revision: string }[]> = async () => targets(SHA);
    const service = createAfterMergeService({ companyId: A, deps: c.deps, hosts: c.hosts, recentMerges: () => supply() });
    expect(await service.pass({ budgetMs: 5_000 })).toMatchObject({ read: 1, readSkipped: 0, readUnavailable: 0 });
    expect(await watchRows(world, A)).toHaveLength(1);
    world.clock.ms = T0 + minutes(31);
    supply = async () => { throw new Error(CANARY); };
    expect(await service.pass({ budgetMs: 5_000 })).toMatchObject({ closed: 1 });
    expect(JSON.stringify(c.logs)).not.toContain(CANARY);
    expect(c.host.postedComments()).toHaveLength(1);
    // No supplier, or an empty list: no read at all.
    c.host.statusCalls = 0;
    expect(await createAfterMergeService({ companyId: A, deps: c.deps, hosts: c.hosts }).pass({ budgetMs: 5_000 })).not.toHaveProperty("read");
    expect(await createAfterMergeService({ companyId: A, deps: c.deps, hosts: c.hosts, recentMerges: async () => [] }).pass({ budgetMs: 5_000 })).toMatchObject({ read: 0 });
    expect(c.host.statusCalls).toBe(0);
  });
});

describe("review fixes: rate limits, retries, claims and bounds", () => {
  const targets = (...shas: string[]) => shas.map((revision) => ({ repository: REPO, revision }));
  const opened = async (world: World, orgId: OrgId = A) => { await world.seedProject(orgId); const merged = await world.seedMerge(orgId); await world.company(orgId).service.codeHostEvent(deployEvent()); return merged; };

  it("stops the pass at a host that said slow down, and leaves it alone until its time", async () => {
    const world = createWorld();
    await world.seedProject(A);
    for (const sha of [SHA, SHA2, "3".repeat(40)]) await world.seedMerge(A, { taskId: `t-${sha[0]!}`, sha });
    const c = world.company(A);
    c.host.failStatuses = new HostRateLimitError(T0 + 5 * 60_000);
    expect(await reconcileDeployments(c.deps, A, c.hosts, targets(SHA, SHA2, "3".repeat(40)))).toEqual([{ kind: "rate_limited", retryAt: T0 + 5 * 60_000 }]);
    expect(c.host.statusCalls).toBe(1);
    expect(JSON.stringify(c.logs)).not.toContain("retryAt");
    // The service keeps off the host until the time it named.
    c.host.statusCalls = 0;
    const service = createAfterMergeService({ companyId: A, deps: c.deps, hosts: c.hosts, recentMerges: async () => targets(SHA) });
    expect(await service.pass({ budgetMs: 5_000 })).toMatchObject({ rateLimited: true });
    expect(c.host.statusCalls).toBe(1);
    world.clock.ms = T0 + minutes(2);
    expect(await service.pass({ budgetMs: 5_000 })).toMatchObject({ rateLimited: false });
    expect(c.host.statusCalls).toBe(1);
    c.host.failStatuses = undefined;
    world.clock.ms = T0 + minutes(6);
    await service.pass({ budgetMs: 5_000 });
    expect(c.host.statusCalls).toBe(2);
  });

  it("never deletes or marks the claim another pass took over, and an expired claim is taken again", async () => {
    const world = createWorld();
    await opened(world);
    const c = world.company(A);
    const key = { pk: `ORG#${A}#AFTER_MERGE_SENT`, sk: "" };
    // A pass that is slow: while its comment is in flight its lease runs out and another pass claims the surface.
    const original = c.host.postComment.bind(c.host);
    const steal = async (): Promise<void> => {
      const rows = (await world.store.query({ pk: key.pk })).items.filter((row) => row["surface"] === "pull_request");
      expect(rows).toHaveLength(1);
      world.clock.ms += 200_000;
      await world.store.put({ item: { ...rows[0]!, claimId: "other-pass", leaseUntil: world.clock.ms + 120_000, state: "sending" } });
    };
    c.host.postComment = async () => { await steal(); throw new Error(CANARY); };
    world.clock.ms = T0 + minutes(31);
    await c.service.pass({ budgetMs: 5_000 });
    const after = (await world.store.query({ pk: key.pk })).items.find((row) => row["surface"] === "pull_request")!;
    expect(after["claimId"]).toBe("other-pass");
    expect(after["state"]).toBe("sending");
    // Its lease runs out: the surface is claimed again and told.
    c.host.postComment = original;
    world.clock.ms += 300_000;
    await c.service.pass({ budgetMs: 5_000 });
    expect(c.host.postedComments()).toHaveLength(1);
    expect((await world.store.query({ pk: key.pk })).items.find((row) => row["surface"] === "pull_request")!["state"]).toBe("done");
  });

  it("says in fixed words when a surface was told but could not be marked", async () => {
    const world = createWorld();
    await opened(world);
    const c = world.company(A);
    const update = world.store.update.bind(world.store);
    world.store.update = async (request) => { if (request.key.pk.endsWith("AFTER_MERGE_SENT")) throw new DocumentStoreError("unavailable", `mark ${CANARY}`); return update(request); };
    world.clock.ms = T0 + minutes(31);
    await c.service.pass({ budgetMs: 5_000 });
    expect(c.logs.some((entry) => entry.event === "after_merge.sent_mark_failed")).toBe(true);
    expect(JSON.stringify(c.logs)).not.toContain(CANARY);
  });

  it("drops a report whose task record names another task id, and reads no repository for a task with no starting revision", async () => {
    const world = createWorld();
    await opened(world);
    const c = world.company(A);
    await world.store.put({ item: { ...taskKey("task-a-7"), taskId: "someone-else", companyId: A, project: PROJECT, startingRevision: 1 } });
    const reporter = createAfterMergeReporter({ store: world.store, hosts: c.hosts, now: () => world.clock.ms });
    await reporter.report(A, { reportId: "e".repeat(64), kind: "healthy", taskId: "task-a-7", repository: REPO, number: 1, url: `${REPO_URL}/pull/1`, environment: "staging", text: "x", actions: { revert: false, expected: false } });
    expect(c.host.commentCalls).toBe(0);
    expect(await c.hosts.forTask(A, "task-a-7", REPO)).toBeUndefined();
    await world.store.put({ item: { ...taskKey("task-a-7"), taskId: "task-a-7", companyId: A, project: PROJECT, startingRevision: "1" } });
    expect(await c.hosts.forTask(A, "task-a-7", REPO)).toBeUndefined();
    await world.store.put({ item: { ...taskKey("task-a-7"), taskId: "task-a-7", companyId: A, project: PROJECT, startingRevision: 1 } });
    expect((await c.hosts.forTask(A, "task-a-7", REPO))?.repository).toEqual({ url: REPO_URL });
  });
});
