// L4-LM1c: merge tracking tells learning when a pull request's head is not one of Rovara's own pushes, and a person's push then becomes one human-edit job (over the real producer, on a fake host that
// answers as GitHub does). The tracking pass itself never changes for it: a failing receiver does not fail the pass, and the host's rate limit and the pass's spent allowance still go up.
import { describe, expect, it } from "vitest";
import { HostRateLimitError, type CommitIdentity, type OrgId } from "../../packages/contracts/src/index.js";
import { TrackingRequestCapError, trackPullRequest, type MergeTrackingDependencies } from "../../packages/broker/src/core/merge/index.js";
import { HUMAN_EDIT_REQUESTS_MAX } from "../../packages/broker/src/core/merge/merge-tracking.js";
import type { HumanEditPush } from "../../packages/broker/src/core/merge/seams.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { createHumanEditProducer, humanEditRowKey } from "../../packages/broker/src/lessons/human-edit-producer.js";
import type { ReflectQueueMessage } from "../../packages/broker/src/lessons/reflect-queue.js";
import { settings } from "./lessons/lesson-helpers.js";
import { ORG, TASK_ID, mergeWorld, type MergeWorld } from "../support/merge-world.js";
import { host as serviceHost } from "../support/service-host.js";
import { createMergeTrackingService, createMilestoneService } from "../../packages/broker/src/services/merge-tracking.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";

const acct = (login: string, id: string, accountType: "person" | "bot" = "person") => ({ login, hostUserId: id, accountType });
const person: CommitIdentity = { author: acct("rae", "1001"), committer: acct("rae", "1001"), webFlow: false };
const bot: CommitIdentity = { author: acct("rovara[bot]", "9001", "bot"), committer: acct("rovara[bot]", "9001", "bot"), webFlow: false };
const FIVE = "a()\nb()\nc()\nd()\ne()\n";

/** A push to the pull request's branch by `identity`, as the host would show it: a new head on the branch. */
function push(world: MergeWorld, identity: CommitIdentity | undefined, path = "src/a.ts", text = FIVE): string {
  const pr = world.prs[0]!;
  const branch = pr.model.getChangeRequest(String(pr.number)).sourceBranch;
  const head = pr.model.commit(branch, { [path]: text });
  if (identity !== undefined) pr.model.commitIdentities.set(head, identity);
  return head;
}

/** The tracking dependencies with the hook given; the recorded head is Rovara's own (the world's), so any other head is a person's. */
const withHook = (world: MergeWorld, humanEdit: MergeTrackingDependencies["humanEdit"]): MergeTrackingDependencies => ({ ...world.tracking, ...(humanEdit === undefined ? {} : { humanEdit }) });

describe("what a pass tells learning", () => {
  it("nothing while the head is Rovara's own, and the coordinates of the push once it is not", async () => {
    const world = await mergeWorld();
    const told: HumanEditPush[] = [];
    const deps = withHook(world, async (event) => { told.push(event); });
    await trackPullRequest(deps, TASK_ID);
    expect(told).toEqual([]);
    const head = push(world, person);
    await trackPullRequest(deps, TASK_ID);
    expect(told).toHaveLength(1);
    const pr = world.prs[0]!;
    expect(told[0]).toMatchObject({
      task: { taskId: TASK_ID, orgId: ORG }, pullRequest: { repositoryId: "app", number: pr.number }, base: pr.head, head, headRef: pr.model.getChangeRequest(String(pr.number)).sourceBranch,
      repository: { scope: { orgId: ORG } },
    });
    expect(told[0]!.repository.codeHost).toBeDefined();
    expect(typeof told[0]!.budget?.beforeRequest).toBe("function");
  });

  it("the base is the commit Rovara last pushed: the pull request record's head when it has one (a fix Rovara pushed after the workflow's head), else the workflow's head", async () => {
    const world = await mergeWorld();
    const pr = world.prs[0]!;
    const told: HumanEditPush[] = [];
    // Rovara pushed a fix: the record holds it, while the workflow still names the first head. A person then pushed on top of the fix.
    const fix = push(world, undefined, "src/fix.ts", FIVE);
    const person1 = push(world, person);
    await trackPullRequest({ ...withHook(world, async (event) => { told.push(event); }), recordedHead: async () => fix }, TASK_ID);
    expect(told.map((event) => [event.base, event.head])).toEqual([[fix, person1]]);
    // With no record the workflow's own head is the base.
    const bare = await mergeWorld();
    const bareTold: HumanEditPush[] = [];
    const head = push(bare, person);
    await trackPullRequest({ ...withHook(bare, async (event) => { bareTold.push(event); }), recordedHead: async () => undefined }, TASK_ID);
    expect(bareTold.map((event) => [event.base, event.head])).toEqual([[bare.prs[0]!.head, head]]);
    expect(pr.head).not.toBe(fix);
  });

  it("not for a pull request that is no longer open, and not at all when no receiver is given (the pass is what it was)", async () => {
    const world = await mergeWorld();
    const told: HumanEditPush[] = [];
    push(world, person);
    const pr = world.prs[0]!;
    pr.model.getChangeRequest(String(pr.number)).state = "closed";
    await trackPullRequest(withHook(world, async (event) => { told.push(event); }), TASK_ID);
    expect(told).toEqual([]);
    const plain = await mergeWorld();
    push(plain, person);
    await expect(trackPullRequest(withHook(plain, undefined), TASK_ID)).resolves.toBeDefined();
    expect(Object.keys(plain.tracking)).not.toContain("humanEdit");
  });

  it("a receiver that fails does not fail the pass (one fixed log line); the host's rate limit and the pass's spent allowance go up", async () => {
    const world = await mergeWorld();
    push(world, person);
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const log = (event: string, fields: Record<string, unknown>) => { logs.push({ event, fields }); };
    const result = await trackPullRequest({ ...withHook(world, async () => { throw new Error("secret detail of the failure"); }), log }, TASK_ID);
    expect(result).toBeDefined();
    expect(logs.map((entry) => entry.event)).toContain("merge_tracking.human_edit_failed");
    expect(JSON.stringify(logs)).not.toContain("secret detail");
    await expect(trackPullRequest(withHook(world, async () => { throw new HostRateLimitError(world.now.value + 60_000); }), TASK_ID)).rejects.toBeInstanceOf(HostRateLimitError);
    await expect(trackPullRequest(withHook(world, async () => { throw new TrackingRequestCapError(); }), TASK_ID)).rejects.toBeInstanceOf(TrackingRequestCapError);
  });

  it("the receiver has its own small allowance: past it only the receiver stops (told again on the next pass), the pass goes on", async () => {
    const world = await mergeWorld();
    push(world, person);
    const logs: string[] = [];
    let charged = 0;
    const result = await trackPullRequest({
      ...withHook(world, async (event) => { for (let n = 0; n <= HUMAN_EDIT_REQUESTS_MAX + 1; n += 1) { event.budget!.beforeRequest(); charged += 1; } }),
      log: (event) => { logs.push(event); },
    }, TASK_ID);
    expect(result).toBeDefined();
    expect(charged).toBe(HUMAN_EDIT_REQUESTS_MAX);
    expect(logs).toContain("merge_tracking.human_edit_allowance");
  });
});

describe("a person's push, through the producer, becomes one job", () => {
  function producer(world: MergeWorld, over: { mode?: "Off" | "Suggest" } = {}) {
    const sent: ReflectQueueMessage[] = [];
    const task = { taskId: TASK_ID, companyId: ORG, project: "web" } as unknown as TaskRecord;
    const produce = createHumanEditProducer({
      companyId: ORG, store: world.store, settings: settings({ mode: over.mode ?? "Suggest" }), enabled: () => true, canPlaceAuthors: () => true, ownTask: async (taskId) => (taskId === TASK_ID ? task : undefined),
      queue: async () => ({ async send(message) { sent.push(message); } }), now: () => world.now.value, log: () => undefined,
    });
    return { sent, deps: withHook(world, async (event) => { await produce(event); }) };
  }

  it("a person's push is queued once however many passes see it; the job names the coordinates of the push", async () => {
    const world = await mergeWorld();
    const { sent, deps } = producer(world);
    const head = push(world, person);
    for (let pass = 0; pass < 3; pass += 1) await trackPullRequest(deps, TASK_ID);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "human_edit", orgId: ORG, taskId: TASK_ID, project: "web", headSha: head, candidateHeadSha: world.prs[0]!.head, pullRequest: { number: world.prs[0]!.number } });
    expect(await world.store.get(humanEditRowKey(ORG as OrgId, TASK_ID, head))).toMatchObject({ state: "queued" });
  });

  it("a bot's push is ignored, and an unlinked identity (as Rovara's own git identity is) is ignored", async () => {
    const botted = await mergeWorld();
    const first = producer(botted);
    const head = push(botted, bot);
    await trackPullRequest(first.deps, TASK_ID);
    expect(first.sent).toEqual([]);
    expect(await botted.store.get(humanEditRowKey(ORG as OrgId, TASK_ID, head))).toMatchObject({ state: "skipped", reason: "no_person_commit" });
    const anon = await mergeWorld();
    const second = producer(anon);
    push(anon, undefined);
    await trackPullRequest(second.deps, TASK_ID);
    expect(second.sent).toEqual([]);
  });

  it("a mixed push (a person's commit, then a bot's on top) queues the head; a bot's commit alone on top of a person's already-judged head does not repeat it", async () => {
    const world = await mergeWorld();
    const { sent, deps } = producer(world);
    push(world, person, "src/a.ts", FIVE);
    const top = push(world, bot, "src/gen.ts", FIVE);
    await trackPullRequest(deps, TASK_ID);
    expect(sent).toHaveLength(1);
    expect((sent[0] as { headSha: string }).headSha).toBe(top);
  });

  it("learning off for the project: nothing is read of the host and nothing is queued", async () => {
    const world = await mergeWorld();
    const { sent, deps } = producer(world, { mode: "Off" });
    let hostReads = 0;
    const host = (await world.host.repository("web", 1, "app", ORG))!.codeHost;
    const watched = { ...deps, repository: async () => ({ url: "https://github.com/acme/app", codeHost: Object.create(host, { commitChanges: { value: async (...args: Parameters<NonNullable<typeof host.commitChanges>>) => { hostReads += 1; return host.commitChanges!(...args); } } }) as typeof host }) };
    push(world, person);
    await trackPullRequest(watched, TASK_ID);
    expect(sent).toEqual([]);
    expect(hostReads).toBe(0);
  });
});

describe("the tracking service tells only for its own company", () => {
  it("a person's push is told by the company's own service with the company's scope; another company's service never reaches the task, whatever the raw pull request number", async () => {
    const w = await serviceHost();
    const other = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
    const pr = w.world.prs[0]!;
    const branch = pr.model.getChangeRequest(String(pr.number)).sourceBranch;
    const head = pr.model.commit(branch, { "src/a.ts": FIVE });
    pr.model.commitIdentities.set(head, person);
    const told: Array<{ company: string; head: string; scope: unknown }> = [];
    const serviceFor = (companyId: OrgId) => createMergeTrackingService({
      flow: w.h.deps, registry: w.registry, companyId, milestones: createMilestoneService({ store: w.h.store, now: () => w.clock.ms }), people: w.people, settings: fixedCodeSettings(),
      ciMode: async () => "their_ci_fix" as const, now: () => w.clock.ms, humanEdit: async (event) => { told.push({ company: companyId, head: event.head, scope: event.repository.scope }); },
    });
    // The other company's pass first: nothing of this company's task is read or told.
    await serviceFor(other).sweep({ budgetMs: 1_000 });
    expect(told).toEqual([]);
    // Positive control: the task's own company's pass does tell it, with its own scope.
    await w.h.store.put({ item: { ...recoveryRowKey(TASK_ID), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: TASK_ID, nextAttemptAt: 0 } });
    await serviceFor(ORG).sweep({ budgetMs: 1_000 });
    expect(told).toEqual([{ company: ORG, head, scope: { orgId: ORG } }]);
  });
});
