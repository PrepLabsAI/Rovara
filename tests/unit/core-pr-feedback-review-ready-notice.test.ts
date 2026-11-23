// DEC 254zzz398 (4): when a PR feedback review finishes with findings that wait for the owner, the task's Slack thread hears it ONCE, through the slack-notices path (`workflowThreadRefresh`'s claim per
// session and key, `threadSender`). None for a failed review, a kept round, a decided round, or a round with nothing to decide.
import { describe, expect, it } from "vitest";
import { SLACK_CHANNEL, type ChannelAdapter, type ChannelEvent, type StoredDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { hostedSlackThreads } from "../../packages/broker/src/aws/slack-thread-channel.js";
import { workflowThreadRefresh } from "../../packages/broker/src/core/channel/workflow-notices.js";
import { recordTaskThread } from "../../packages/broker/src/core/channel/threads.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { taskSessionId } from "../../packages/broker/src/core/sessions/create.js";
import { createFakeWorld, FAKE_COMPANY } from "../support/core-host-fakes.js";
import { reviewedFeedbackWorld } from "../support/pr-feedback-world.js";

/** A real workflow the feedback review left behind (the owner's card waiting), as the thread refresh reads it from the task row. */
async function pending(status: "COMPLETE" | "BLOCKED" = "COMPLETE"): Promise<WorkflowSnapshot> {
  return structuredClone((await reviewedFeedbackWorld(status)).task.workflow!);
}

async function world(workflow: WorkflowSnapshot) {
  const fake = createFakeWorld();
  const taskId = workflow.taskId;
  const sessionId = taskSessionId(taskId);
  const events: ChannelEvent[] = [];
  let member = true;
  let milestones = true;
  let fails = false;
  const adapter: ChannelAdapter = { capabilities: { threads: true, buttons: 5, edits: true, maxTextLength: 40000, proactive: true }, projects: [], stepUp: [],
    async deliver(event) { if (fails) throw new Error("offline"); events.push(event); } };
  const put = async (value: WorkflowSnapshot) => fake.store.put({ item: JSON.parse(JSON.stringify({ ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: FAKE_COMPANY, orgId: FAKE_COMPANY, sessionId, project: "web", workflow: value })) as StoredDocument });
  await put(workflow);
  await recordTaskThread({ store: fake.store, orgId: FAKE_COMPANY, now: () => fake.clock.now }, { sessionId, personId: "dev-a", actor: { channel: SLACK_CHANNEL, tenant: "T0123456789", userId: "U0123456789" }, conversation: { channel: SLACK_CHANNEL, tenant: "T0123456789", space: "C0123456789", thread: "1700000000.000001" } });
  const threads = hostedSlackThreads({ workspaces: { requireCompany: async () => FAKE_COMPANY, tokenForCompany: async () => undefined } });
  const refresh = workflowThreadRefresh({ messageOf: (message) => threads.messageOf!(message), store: fake.store, companyId: FAKE_COMPANY, now: () => fake.clock.now, milestones: () => milestones,
    taskUrl: () => "https://app.example/app/sessions/" + sessionId, registry: { get: (() => adapter) as never }, companyOf: async () => FAKE_COMPANY, isMember: async () => member });
  const texts = () => events.flatMap(event => event.type === "message" ? [event.data.text] : []);
  return { fake, put, events, texts, refresh: () => refresh(FAKE_COMPANY, sessionId, taskId), member: (value: boolean) => { member = value; }, fails: (value: boolean) => { fails = value; }, milestones: (value: boolean) => { milestones = value; } };
}
const asRound = (workflow: WorkflowSnapshot, edit: (review: NonNullable<WorkflowSnapshot["feedbackReview"]>) => void): WorkflowSnapshot => {
  const next = structuredClone(workflow);
  edit(next.feedbackReview!);
  return next;
};

describe("the Slack thread hears that a feedback review is ready, once per round", () => {
  it("posts one message in the task's thread for a finished review with findings, naming the pull request and the task page", async () => {
    const w = await world(await pending());
    await w.refresh();
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ type: "message", conversation: { thread: "1700000000.000001" } });
    const [text] = w.texts();
    expect(text).toContain("review");
    expect(text).toContain("PR #1");
    expect(text).toMatch(/1 finding/u);
    expect(text).toContain("https://app.example/app/sessions/");
    // The core's owner moves are on the task page: no retired buttons that would refuse a core owner.
    const event = w.events[0]!;
    if (event.type !== "message") throw new Error("not a message");
    expect(event.data.actions ?? []).toEqual([]);
  });

  it("says it exactly once: refreshing again, or after a restart, sends nothing more (the claim is the dedupe)", async () => {
    const w = await world(await pending());
    await w.refresh(); await w.refresh(); await w.refresh();
    expect(w.events).toHaveLength(1);
  });

  it("a later round's review is a new notice; the first stays said", async () => {
    const first = await pending();
    const w = await world(first);
    await w.refresh();
    const second = asRound(first, review => {
      if (review.reviewRef === undefined) throw new Error("fixture needs a report");
      const sha = "d".repeat(64);
      review.reviewRef = { ...review.reviewRef, objectKey: review.reviewRef.objectKey.replace(review.reviewRef.sha256, sha), sha256: sha };
    });
    await w.put({ ...second, revision: first.revision + 3 });
    await w.refresh(); await w.refresh();
    expect(w.events).toHaveLength(2);
  });

  it.each([
    ["a failed review", async () => pending("BLOCKED")],
    ["a failed review that still lists findings", async () => asRound(await pending(), review => { if (review.reviewRef !== undefined) { review.reviewRef.status = "BLOCKED"; review.reviewRef.blockReason = "The reviewer could not complete."; } })],
    ["a kept round", async () => asRound(await pending(), review => { review.status = "DISMISSED"; })],
    ["a round the owner decided (fix chosen)", async () => asRound(await pending(), review => { review.status = "APPROVED"; })],
    ["a round the owner sent back", async () => asRound(await pending(), review => { review.status = "CHANGES_REQUESTED"; })],
    ["a review that found nothing to decide", async () => asRound(await pending(), review => { if (review.reviewRef !== undefined) { review.reviewRef.findingRefs = []; } })],
  ])("says nothing for %s", async (_name, make) => {
    const w = await world(await make());
    await w.refresh(); await w.refresh();
    expect(w.events).toEqual([]);
  });

  it.each([["RUNNING"], ["BLOCKED"]] as const)("says nothing when the task no longer waits for the merge (%s)", async state => {
    const w = await world({ ...(await pending()), state });
    await w.refresh();
    expect(w.texts().filter(text => text.includes("review of the feedback"))).toEqual([]);
  });

  it("says nothing while the review is still collecting", async () => {
    const workflow = await pending();
    const w = await world({ ...workflow, feedbackReview: { status: "COLLECTING", bundleRefs: workflow.feedbackReview!.bundleRefs, threadObservations: [] } });
    await w.refresh();
    expect(w.events).toEqual([]);
  });

  it("retries a failed delivery, then says it once", async () => {
    const w = await world(await pending());
    w.fails(true);
    await expect(w.refresh()).rejects.toThrow("offline");
    w.fails(false);
    await w.refresh(); await w.refresh();
    expect(w.events).toHaveLength(1);
  });

  it("only to a thread of this company whose person is still served", async () => {
    const w = await world(await pending());
    w.member(false);
    await w.refresh();
    expect(w.events).toEqual([]);
    w.member(true);
    await w.refresh();
    expect(w.events).toHaveLength(1);
  });

  it("a request for the owner is not muted with the milestone lines", async () => {
    const w = await world(await pending());
    w.milestones(false);
    await w.refresh();
    expect(w.events).toHaveLength(1);
  });

  it("a task with no Slack thread hears nothing and nothing throws", async () => {
    const workflow = await pending();
    const fake = createFakeWorld();
    const taskId = workflow.taskId;
    await fake.store.put({ item: JSON.parse(JSON.stringify({ ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: FAKE_COMPANY, orgId: FAKE_COMPANY, sessionId: taskSessionId(taskId), workflow })) as StoredDocument });
    const events: ChannelEvent[] = [];
    const adapter = { capabilities: { threads: true, buttons: 5, edits: true, maxTextLength: 40000, proactive: true }, projects: [], stepUp: [], async deliver(event: ChannelEvent) { events.push(event); } } as ChannelAdapter;
    const refresh = workflowThreadRefresh({ messageOf: () => undefined, store: fake.store, companyId: FAKE_COMPANY, now: () => fake.clock.now, registry: { get: (() => adapter) as never } });
    await expect(refresh(FAKE_COMPANY, taskSessionId(taskId), taskId)).resolves.toBeUndefined();
    expect(events).toEqual([]);
  });
});
