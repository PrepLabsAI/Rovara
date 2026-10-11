// After Request changes on the page, the planner says what it did with each included comment; those answers become
// replies from AgentX under the comments, written once, never past the task's comment cap, and never in the plan's way.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommentAnswers, plainPageRefs, plannerReplyCommentId, type PlanDocument, type TaskComment, type WorkflowSnapshot } from "@agentx/contracts";
import { decideTaskWorkflow, listPageComments, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { APPROVED_COMMENT_ANSWERS_INSTRUCTION, COMMENT_ANSWERS_INSTRUCTION, readDecisionDetail } from "../../packages/broker/src/developer/owner-answers.js";
import { writePlannerReplies } from "../../packages/broker/src/developer/page-comments.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { pagePlan } from "../support/page-tasks.js";
import { SLACK_CHANNEL } from "../support/slack-broker.js";
import { validatingDocumentClient } from "../support/validating-document-client.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const SAM_ID = "5".repeat(64);
const PLAN: PlanDocument = pagePlan();
delete PLAN.checks;
const maya: DeveloperCaller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack", name: MAYA.name, slackUserId: MAYA.slackUserId! };

const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const workflowOf = (harness: Harness, taskId: string) => (harness.db.get(`DEVTASK#${taskId}`, "META") as { workflow: WorkflowSnapshot }).workflow;
const comments = (harness: Harness, taskId: string) => harness.db.find((item) => item.pk === `DEVTASK#${taskId}` && item.entityType === "TASK_COMMENT") as Array<TaskComment & Record<string, unknown>>;
const agentxReplies = (harness: Harness, taskId: string) => comments(harness, taskId).filter((item) => item.author.kind === "agentx");

function routeDeps(harness: Harness): DeveloperTaskRouteDependencies {
  return {
    documentClient: validatingDocumentClient(harness.db), tableName: "state", actions: harness.actions,
    checkAccess: async () => ({ revision: 1, policy: {} as never, access: "channel", channelIds: [SLACK_CHANNEL] }),
    projectChannelIds: async () => [SLACK_CHANNEL], now: () => Date.now(), log: () => undefined,
  };
}

const answersBlock = (entries: unknown) => `\`\`\`agentx-comment-answers\n${typeof entries === "string" ? entries : JSON.stringify(entries)}\n\`\`\`\n\n`;

/** A Quick task whose v1 coding plan the owner sent back with three comments: c1 and c3 on claim 2.1, c2 a reply to c1. */
async function changesRequested() {
  const harness = await createDeveloperTaskBroker();
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const first = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
  await harness.artifact(workspaceId, String(first.id), "plan.md", planAnswer(PLAN));
  await harness.finish(workspaceId, String(first.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  let minute = 0;
  const seed = (extra: Partial<TaskComment> = {}): string => {
    const commentId = randomUUID();
    minute += 1;
    harness.db.set({
      pk: `DEVTASK#${taskId}`, sk: `COMMENT#${commentId}`, entityType: "TASK_COMMENT", schemaVersion: 1, taskId, commentId, document: "plan", version: 1,
      target: { kind: "claim", id: "2.1" }, author: { kind: "person", developerId: SAM_ID, name: "Sam Lee", owner: false },
      text: `Comment ${minute}`, createdAt: new Date(Date.parse("2026-10-11T09:00:00.000Z") + minute * 60_000).toISOString(), rev: 1, ...extra,
    });
    return commentId;
  };
  const c1 = seed();
  const c2 = seed({ parentId: c1 });
  const c3 = seed();
  harness.db.set({ pk: `DEVTASK#${taskId}`, sk: "COMMENTS", entityType: "TASK_COMMENT_COUNTER", taskId, count: 3, seq: 3 });
  const requestId = randomUUID();
  const workflow = workflowOf(harness, taskId);
  await decideTaskWorkflow(routeDeps(harness), maya, taskId, {
    requestId, expectedRevision: workflow.revision, decision: "REQUEST_CHANGES", artifactDigest: workflow.artifacts.at(-1)!.sha256, reason: "See the included comments.",
    answers: [{ decisionId: "d1", optionId: "below", opened: false }], includedCommentIds: [c1, c2, c3],
  }, { via: "PAGE" });
  const replanning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
  /** The planner's second answer: `prefix` (a comment answers block, or nothing) before the plan. */
  const replan = async (prefix: string) => {
    await harness.artifact(workspaceId, String(replanning.id), "plan.md", `${prefix}${planAnswer(PLAN)}`);
    await harness.finish(workspaceId, String(replanning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  };
  return { harness, taskId, workspaceId, requestId, replanning, replan, c1, c2, c3 };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("planner answers to included comments", () => {
  it("planner answers become AgentX replies; bad entries are ignored", async () => {
    const t = await changesRequested();
    await t.replan(answersBlock([
      { comment: "c1", outcome: "done", reason: "Moved the banner above the button." },
      { comment: "c2", outcome: "not_changed", reason: `Kept it. ${"x".repeat(5_000)}` },
      { comment: "c1", outcome: "not_changed", reason: "A second answer to c1." },
      { comment: "c9", outcome: "done", reason: "No such comment." },
      { comment: "c3", outcome: "maybe", reason: "Not an outcome." },
    ]));
    const workflow = workflowOf(t.harness, t.taskId);
    expect(workflow.stage).toBe("PLAN_REVIEW");
    const v2 = workflow.artifacts.at(-1)!;
    expect(v2.version).toBe(2);
    const replies = agentxReplies(t.harness, t.taskId).sort((left, right) => left.text.localeCompare(right.text));
    expect(replies).toHaveLength(2);
    const [done, kept] = [replies.find((reply) => reply.author.kind === "agentx" && reply.author.outcome === "done")!, replies.find((reply) => reply.author.kind === "agentx" && reply.author.outcome === "not_changed")!];
    expect(done).toMatchObject({
      commentId: plannerReplyCommentId(t.c1, v2.id), parentId: t.c1, document: "plan", version: 1, target: { kind: "claim", id: "2.1" },
      author: { kind: "agentx", source: "planner", outcome: "done", forVersion: 2 }, text: "Moved the banner above the button.", rev: 1,
    });
    // A reply's answer sits under its thread's top-level comment.
    expect(kept).toMatchObject({ commentId: plannerReplyCommentId(t.c2, v2.id), parentId: t.c1, author: { kind: "agentx", source: "planner", outcome: "not_changed", forVersion: 2 } });
    expect(kept.text.length).toBeLessThanOrEqual(200);
    expect(kept.text.startsWith("Kept it.")).toBe(true);
    expect(t.harness.db.get(`DEVTASK#${t.taskId}`, "COMMENTS")).toMatchObject({ count: 5, seq: 6 }); // the decision bumped seq once, each reply once more
  });

  it("the page's comment poll reads no stored document until a planner reply needs one, then only the document that handled the comments, once", async () => {
    const t = await changesRequested();
    const reads = vi.spyOn(t.harness.actions, "readArtifact");
    // No planner reply yet: nothing is read from storage.
    const before = await listPageComments(routeDeps(t.harness), maya, t.taskId);
    expect(before.comments.some((comment) => comment.planner !== undefined)).toBe(false);
    expect(reads).not.toHaveBeenCalled();
    await t.replan(answersBlock([{ comment: "c1", outcome: "done", reason: "Moved it under claim 2.1." }, { comment: "c3", outcome: "done", reason: "Shortened it." }]));
    reads.mockClear();
    // Two documents are stored (v1 and v2); the replies point at v2, so only v2 is read, and by the second poll it is remembered.
    const first = await listPageComments(routeDeps(t.harness), maya, t.taskId);
    expect(reads).toHaveBeenCalledTimes(1);
    const replied = first.comments.filter((comment) => comment.planner !== undefined);
    expect(replied).toHaveLength(2);
    expect(replied.find((comment) => comment.text.startsWith("Moved it"))!.planner).toMatchObject({ version: 2, document: "plan", parts: [{ text: "Moved it under claim " }, { claim: "2.1" }, { text: "." }] });
    await listPageComments(routeDeps(t.harness), maya, t.taskId);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("a done record follows the replies, also when the planner gave none, and takes no place in the comment count", async () => {
    const withAnswers = await changesRequested();
    await withAnswers.replan(answersBlock([{ comment: "c1", outcome: "done", reason: "Moved it." }]));
    const v2 = workflowOf(withAnswers.harness, withAnswers.taskId).artifacts.at(-1)!;
    expect(withAnswers.harness.db.get(`DEVTASK#${withAnswers.taskId}`, `PLANREPLIES#${v2.id}`)).toMatchObject({ entityType: "PLANNER_REPLIES_DONE", artifactId: v2.id, answers: 1 });
    expect(withAnswers.harness.db.get(`DEVTASK#${withAnswers.taskId}`, "COMMENTS")).toMatchObject({ count: 4 });
    // An older worker writes no block: nothing to reply with, and the record still says the replies are done.
    const none = await changesRequested();
    await none.replan("");
    const v2none = workflowOf(none.harness, none.taskId).artifacts.at(-1)!;
    expect(agentxReplies(none.harness, none.taskId)).toHaveLength(0);
    expect(none.harness.db.get(`DEVTASK#${none.taskId}`, `PLANREPLIES#${v2none.id}`)).toMatchObject({ entityType: "PLANNER_REPLIES_DONE", answers: 0 });
  });

  it("a resent callback writes each reply once", async () => {
    const t = await changesRequested();
    const answer = answersBlock([{ comment: "c1", outcome: "done", reason: "Moved it." }, { comment: "c3", outcome: "done", reason: "Shortened it." }]);
    await t.replan(answer);
    await t.harness.finish(t.workspaceId, String(t.replanning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    expect(agentxReplies(t.harness, t.taskId)).toHaveLength(2);
    // The same answers written again (a retried write) find their replies already there.
    const workflow = workflowOf(t.harness, t.taskId);
    const detail = (await readDecisionDetail(routeDeps(t.harness), t.taskId, t.requestId))!;
    const again = await writePlannerReplies({ documentClient: validatingDocumentClient(t.harness.db), tableName: "state", now: () => Date.now(), log: () => undefined }, {
      taskId: t.taskId, artifactId: workflow.artifacts.at(-1)!.id, version: 2, detail, answers: parseCommentAnswers(answer, new Set(["c1", "c2", "c3"])),
    });
    expect(again).toEqual({ written: 0 });
    expect(agentxReplies(t.harness, t.taskId)).toHaveLength(2);
    expect(t.harness.db.get(`DEVTASK#${t.taskId}`, "COMMENTS")).toMatchObject({ count: 5 });
  });

  it("a write that meets another in flight is tried once more, and one entry that cannot be written never stops the rest", async () => {
    const t = await changesRequested();
    const workflow = workflowOf(t.harness, t.taskId);
    const detail = (await readDecisionDetail(routeDeps(t.harness), t.taskId, t.requestId))!;
    const inner = validatingDocumentClient(t.harness.db);
    let transactions = 0;
    const events: string[] = [];
    const client = {
      send: async (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
          transactions += 1;
          if (transactions === 1) throw Object.assign(new Error("conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }] });
          if (transactions === 3) throw Object.assign(new Error("unexpected"), { name: "InternalServerError" });
        }
        return inner.send(command);
      },
    };
    const result = await writePlannerReplies({ documentClient: client, tableName: "state", now: () => Date.now(), log: (entry) => { events.push(String(entry.event)); } }, {
      taskId: t.taskId, artifactId: workflow.artifacts.at(-1)!.id, version: 2, detail,
      answers: parseCommentAnswers(answersBlock([{ comment: "c1", outcome: "done", reason: "Moved it." }, { comment: "c3", outcome: "done", reason: "Shortened it." }, { comment: "c2", outcome: "not_changed", reason: "Kept it." }]), new Set(["c1", "c2", "c3"])),
    });
    expect(result).toEqual({ written: 2 });
    expect(transactions).toBe(4);
    expect(agentxReplies(t.harness, t.taskId).map((reply) => reply.commentId).sort()).toEqual([plannerReplyCommentId(t.c1, workflow.artifacts.at(-1)!.id), plannerReplyCommentId(t.c2, workflow.artifacts.at(-1)!.id)].sort());
    expect(events).toContain("developer.planner_reply_not_written");
  });

  it("an answer with no block stores the plan and writes no replies", async () => {
    const t = await changesRequested();
    await t.replan("");
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(workflowOf(t.harness, t.taskId).artifacts.at(-1)?.version).toBe(2);
    expect(agentxReplies(t.harness, t.taskId)).toHaveLength(0);

    const broken = await changesRequestedAgainWith(answersBlock("[{\"comment\":\"c1\",\"outcome\":\"done\""));
    expect(broken.stored).toBe(true);
    expect(broken.replies).toBe(0);
  });

  it("a reply that would pass 300 items is not written and the plan is unaffected", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    const t = await changesRequested();
    t.harness.db.set({ pk: `DEVTASK#${t.taskId}`, sk: "COMMENTS", entityType: "TASK_COMMENT_COUNTER", taskId: t.taskId, count: 299, seq: 10 });
    await t.replan(answersBlock([{ comment: "c1", outcome: "done", reason: "Moved it." }, { comment: "c3", outcome: "done", reason: "Shortened it." }]));
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(agentxReplies(t.harness, t.taskId)).toHaveLength(1);
    expect(t.harness.db.get(`DEVTASK#${t.taskId}`, "COMMENTS")).toMatchObject({ count: 300 });
    const full = lines.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } })
      .find((entry) => entry.event === "developer.planner_replies_full");
    expect(full).toMatchObject({ taskId: t.taskId, written: 1, skipped: 1 });
    expect(JSON.stringify(full)).not.toContain("Shortened");
  });
});

/** A fresh task sent back with comments, replanned with `prefix`: whether v2 was stored, and how many AgentX replies exist. */
async function changesRequestedAgainWith(prefix: string): Promise<{ stored: boolean; replies: number }> {
  const t = await changesRequested();
  await t.replan(prefix);
  return { stored: workflowOf(t.harness, t.taskId).artifacts.at(-1)?.version === 2, replies: agentxReplies(t.harness, t.taskId).length };
}

/**
 * A Full task whose design v1 the owner approved with two comments (c1 an instruction, c2 a question), so the coding plan
 * is being written. The comments sit on the design; `plan` writes the coding plan's answer.
 */
async function designApproved(options: { comments?: number; long?: boolean } = {}) {
  const harness = await createDeveloperTaskBroker();
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Retry failed payments", client: "test-client", workflow: true, workflowPath: "FULL" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const step = async (document: PlanDocument) => {
    const running = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
    await harness.artifact(workspaceId, String(running.id), "plan.md", planAnswer(document));
    await harness.finish(workspaceId, String(running.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
  };
  const approve = async (includedCommentIds?: string[]) => {
    const workflow = workflowOf(harness, taskId);
    const requestId = randomUUID();
    await decideTaskWorkflow(routeDeps(harness), maya, taskId, {
      requestId, expectedRevision: workflow.revision, decision: "APPROVE", artifactDigest: workflow.artifacts.at(-1)!.sha256, reason: "Approved on the task page.",
      answers: [], ...(includedCommentIds === undefined ? {} : { includedCommentIds }),
    }, { via: "PAGE" });
    return requestId;
  };
  const requirements = planDocument({ title: "Retry banner requirements", decisions: [] });
  await step(requirements);
  await approve();
  await step({ ...requirements, title: "Retry banner design" });
  let minute = 0;
  const seed = (text: string, extra: Partial<TaskComment> = {}): string => {
    const commentId = randomUUID();
    minute += 1;
    harness.db.set({
      pk: `DEVTASK#${taskId}`, sk: `COMMENT#${commentId}`, entityType: "TASK_COMMENT", schemaVersion: 1, taskId, commentId, document: "design", version: 1,
      target: { kind: "document" }, author: { kind: "person", developerId: MAYA.developerId, name: "Maya Chen", owner: true },
      text, createdAt: new Date(Date.parse("2026-10-11T09:00:00.000Z") + minute * 60_000).toISOString(), rev: 1, ...extra,
    });
    return commentId;
  };
  const ids = Array.from({ length: options.comments ?? 2 }, (_, index) => seed(index === 0 ? "Keep each item to one line." : options.long === true ? `Comment ${index + 1}: ${"Long thought. ".repeat(100)}` : "Why two steps?"));
  // A comment on the design that the approval leaves out.
  const outside = seed("Left out for now.");
  harness.db.set({ pk: `DEVTASK#${taskId}`, sk: "COMMENTS", entityType: "TASK_COMMENT_COUNTER", taskId, count: ids.length + 1, seq: ids.length + 1 });
  const requestId = await approve(ids);
  const plan = async (prefix: string, document: PlanDocument = planDocument({ title: "Retry banner coding plan", decisions: [] })) => {
    const running = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
    await harness.artifact(workspaceId, String(running.id), "plan.md", `${prefix}${planAnswer(document)}`);
    await harness.finish(workspaceId, String(running.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    return running;
  };
  /** What the coding plan's planner was asked, while its step is running. */
  const prompt = () => {
    const running = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN" && item.status === "ACCEPTED")!;
    return String((harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === running.id)[0]?.invocation as { payload: { prompt: string } } | undefined)?.payload.prompt);
  };
  return { harness, taskId, workspaceId, requestId, ids, outside, plan, prompt };
}

describe("planner answers to comments sent with an Approve", () => {
  const cited = (ref: string) => planDocument({ title: "Retry banner coding plan", decisions: [], claims: [{ id: "1", text: "Each bullet stays on one line.",
    evidence: [{ kind: "quote", text: "Keep each item to one line.", author: `owner (comment ${ref})` }] }, { id: "2", text: "A payment is never charged twice." }] });

  it("the coding plan's answers become replies on the design's comments, and nothing new is stored with them", async () => {
    const t = await designApproved();
    await t.plan(answersBlock([
      { comment: "c1", outcome: "done", reason: "Each bullet stays on one line." },
      { comment: "c2", outcome: "not_changed", reason: "The steps stay as they are." },
    ]), cited("c1"));
    const workflow = workflowOf(t.harness, t.taskId);
    const coding = workflow.artifacts.at(-1)!;
    expect(coding.type).toBe("plan");
    const replies = agentxReplies(t.harness, t.taskId);
    expect(replies).toHaveLength(2);
    // On the document the comment was made on (the design), under that comment, for the version of the coding plan.
    const done = replies.find((reply) => reply.commentId === plannerReplyCommentId(t.ids[0]!, coding.id))!;
    expect(done).toMatchObject({
      parentId: t.ids[0], document: "design", version: 1, target: { kind: "document" }, text: "Each bullet stays on one line.",
      author: { kind: "agentx", source: "planner", outcome: "done", forVersion: 1 },
    });
    // Which document handled it and which claim cites it are worked out when the page is read: the author is exactly the shape
    // 0.2.13 wrote and reads (its schema is strict), so a rollback loses nothing.
    expect(Object.keys(done.author).sort()).toEqual(["forVersion", "kind", "outcome", "source"]);
    const released = z.object({ kind: z.literal("agentx"), source: z.enum(["answer", "planner"]), outcome: z.enum(["done", "not_changed"]).optional(), forVersion: z.number().int().positive().optional() }).strict();
    for (const reply of replies) expect(released.safeParse(reply.author).success).toBe(true);
    expect(replies.find((reply) => reply.commentId === plannerReplyCommentId(t.ids[1]!, coding.id))).toMatchObject({ parentId: t.ids[1], author: { outcome: "not_changed" } });
  });

  it("a quote that credits 'comment c1' is stored crediting the comment by its ID, from the refs of the step that wrote it", async () => {
    const t = await designApproved();
    await t.plan("", planDocument({ title: "Retry banner coding plan", decisions: [], claims: [{ id: "1", text: "Each bullet stays on one line.", evidence: [
      { kind: "quote", text: "Keep each item to one line.", author: "owner (comment c1)" },
      { kind: "quote", text: "Why two steps?", author: "comment c2" },
      { kind: "quote", text: "Nobody said this.", author: "comment c9" },
    ] }] }));
    const stored = JSON.parse(t.harness.s3.objects.get(workflowOf(t.harness, t.taskId).artifacts.at(-1)!.objectKey)!) as PlanDocument;
    expect(stored.claims[0]!.evidence!.map((item) => (item.kind === "quote" ? item.author : ""))).toEqual([`comment:${t.ids[0]}`, `comment:${t.ids[1]}`, "a comment"]);
  });

  it("a comment:<ID> the planner writes itself is kept only for a comment this step showed it; any other form naming a comment is 'a comment'", async () => {
    const t = await designApproved();
    await t.plan("", planDocument({ title: "Retry banner coding plan", decisions: [], claims: [
      { id: "1", text: "One.", evidence: [
        { kind: "quote", text: "Keep each item to one line.", author: `comment:${t.ids[0]}` },
        { kind: "quote", text: "Left out for now.", author: `comment:${t.outside}` },
        { kind: "quote", text: "Made up.", author: `comment:${randomUUID()}` },
      ] },
      { id: "2", text: "Two.", evidence: [
        { kind: "quote", text: "Keep each item to one line.", author: `owner (comment:${t.ids[0]})` },
        { kind: "quote", text: "Why two steps?", author: `COMMENT:${t.ids[1]!.toUpperCase()}` },
      ] },
    ] }));
    const stored = JSON.parse(t.harness.s3.objects.get(workflowOf(t.harness, t.taskId).artifacts.at(-1)!.objectKey)!) as PlanDocument;
    const authors = stored.claims.map((claim) => claim.evidence!.map((item) => (item.kind === "quote" ? item.author : "")));
    expect(authors).toEqual([[`comment:${t.ids[0]}`, "a comment", "a comment"], ["a comment", `comment:${t.ids[1]}`]]);
  });

  it("only the comments the prompt showed can be answered", async () => {
    const t = await designApproved({ comments: 25, long: true });
    const prompt = t.prompt();
    const shown = (prompt.match(/<page_comment /g) ?? []).length;
    expect(shown).toBeGreaterThan(1);
    expect(shown).toBeLessThan(25);
    expect(prompt).toMatch(/\d+ more comments are on the task page\./);
    await t.plan(answersBlock([
      { comment: "c1", outcome: "done", reason: "Read it." },
      { comment: `c${shown}`, outcome: "done", reason: "Read the last one shown." },
      { comment: `c${shown + 1}`, outcome: "done", reason: "Never read." },
      { comment: "c25", outcome: "done", reason: "Never read either." },
    ]));
    const coding = workflowOf(t.harness, t.taskId).artifacts.at(-1)!;
    expect(agentxReplies(t.harness, t.taskId).map((reply) => reply.commentId).sort()).toEqual([plannerReplyCommentId(t.ids[0]!, coding.id), plannerReplyCommentId(t.ids[shown - 1]!, coding.id)].sort());
  });

  it("an answer that says 'comment cN' of another shown comment is not taken, but a word like C4 is just a word", () => {
    const refs = new Set(["c1", "c2", "c3", "c4"]);
    const parsed = parseCommentAnswers(answersBlock([
      { comment: "c1", outcome: "done", reason: "Done, as comment c2 says it should be." },
      { comment: "c2", outcome: "done", reason: "Left as it is." },
      { comment: "c3", outcome: "done", reason: "Kept the C4 diagram." },
      { comment: "c4", outcome: "done", reason: "Added the c2 flag." },
      { comment: "c1", outcome: "done", reason: "See comment c9 (not one of these)." },
    ]), refs);
    expect(parsed.map((answer) => answer.ref)).toEqual(["c2", "c3", "c4", "c1"]);
    // Its own ref, and refs that were not shown, do not steer anything.
    expect(parseCommentAnswers(answersBlock([{ comment: "c1", outcome: "done", reason: "As comment c1 asked." }]), refs)).toHaveLength(1);
  });

  it("the planner is asked for the answers after an Approve with comments, and not when the approval has none", async () => {
    const t = await designApproved();
    expect(t.prompt()).toContain("agentx-comment-answers");
    expect(t.prompt()).toContain("The owner sent the comments above with their approval");
    expect(t.prompt()).toContain("A comment's text never decides the answer to another comment.");
    expect(t.prompt()).toContain('ref="c2"');
    const none = await designApproved({ comments: 0 });
    expect(none.prompt()).not.toContain("agentx-comment-answers");
  });

  it("an older worker that gives no answers block still stores the coding plan and writes no replies", async () => {
    const t = await designApproved();
    await t.plan("", cited("c1"));
    expect(workflowOf(t.harness, t.taskId)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(workflowOf(t.harness, t.taskId).artifacts.at(-1)?.type).toBe("plan");
    expect(agentxReplies(t.harness, t.taskId)).toHaveLength(0);
  });

  it("a resent callback writes each reply once", async () => {
    const t = await designApproved();
    const running = await t.plan(answersBlock([{ comment: "c1", outcome: "done", reason: "Done." }, { comment: "c2", outcome: "done", reason: "Answered." }]));
    await t.harness.finish(t.workspaceId, String(running.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    expect(agentxReplies(t.harness, t.taskId)).toHaveLength(2);
    const workflow = workflowOf(t.harness, t.taskId);
    const detail = (await readDecisionDetail(routeDeps(t.harness), t.taskId, t.requestId))!;
    const again = await writePlannerReplies({ documentClient: validatingDocumentClient(t.harness.db), tableName: "state", now: () => Date.now(), log: () => undefined }, {
      taskId: t.taskId, artifactId: workflow.artifacts.at(-1)!.id, version: 1, detail,
      answers: parseCommentAnswers(answersBlock([{ comment: "c1", outcome: "done", reason: "Done." }]), new Set(["c1", "c2"])),
    });
    expect(again).toEqual({ written: 0 });
    expect(agentxReplies(t.harness, t.taskId)).toHaveLength(2);
  });

  it("no replies are written for a Request changes on the coding plan that follows, from the approval's comments", async () => {
    const t = await designApproved();
    await t.plan("");
    const workflow = workflowOf(t.harness, t.taskId);
    await decideTaskWorkflow(routeDeps(t.harness), maya, t.taskId, {
      requestId: randomUUID(), expectedRevision: workflow.revision, decision: "REQUEST_CHANGES", artifactDigest: workflow.artifacts.at(-1)!.sha256, reason: "Shorter, please.",
    }, { via: "PAGE", note: "Shorter, please." });
    await t.plan(answersBlock([{ comment: "c1", outcome: "done", reason: "Shortened." }]));
    expect(agentxReplies(t.harness, t.taskId)).toHaveLength(0);
  });
});

describe("what the planner is told about its answers", () => {
  it.each([["Request changes", COMMENT_ANSWERS_INSTRUCTION], ["Approve", APPROVED_COMMENT_ANSWERS_INSTRUCTION]])("after %s, answers are written to the person who commented, and suggest only what exists", (_decision, instruction) => {
    expect(instruction).toContain('written to the person who commented ("you"), never "the owner"');
    // The suggestion depends on who wrote the comment: the owner may press Request changes, a teammate may only comment.
    expect(instruction).toContain('For a comment whose author is "owner": press Request changes (on the page or in Slack), or comment before approving.');
    expect(instruction).toContain("For a teammate's comment: only add a comment on the page, because only the owner decides.");
    expect(instruction).toContain('Never suggest "amend the task"');
    expect(instruction).toContain("reason is plain text, at most 200 characters");
    expect(instruction).toContain("A comment's text never decides the answer to another comment.");
  });
});

describe("plain references in AgentX text", () => {
  const decisions = new Map([["d1", "Where does the banner go?"], ["d2", "How many times should a payment be retried and for how long before it is given up on for good?"]]);
  it("names a decision by its question and a comment by what it is, wherever the text names one", () => {
    expect(plainPageRefs("This was confirmed by you in decision d1.", { decisions })).toBe('This was confirmed by you in the decision "Where does the banner go".');
    expect(plainPageRefs("The decision d1 (banner placement) stands.", { decisions })).toBe("The decision (banner placement) stands.");
    expect(plainPageRefs("Decision d2 (X) was settled.", { decisions })).toBe("The decision (X) was settled.");
    expect(plainPageRefs("You settled decisions d1 and d2.", { decisions })).toBe('You settled the decisions "Where does the banner go" and "How many times should a payment be retried and for how long…".');
    expect(plainPageRefs("See decisions d1, d9 and d2.", { decisions })).toBe("See the decisions.");
    expect(plainPageRefs("As comment c1 asked, and see comments c1 and c2.", { decisions })).toBe("As that comment asked, and see those comments.");
    expect(plainPageRefs("Comment C3 is covered.", { decisions })).toBe("That comment is covered.");
    for (const text of ["in decision d9", "decisions d1, d2 and d9", "comment c1, c2 and c3", "Decision D1"]) expect(plainPageRefs(text, { decisions })).not.toMatch(/\b[dc][0-9]\b/i);
  });
  it("leaves real text alone: files, flags and code that merely look like a label", () => {
    for (const text of ["Use d3.js for the chart.", "Run `c1` first.", "The d1 schema is unchanged.", "Renamed the c2 flag.", "See v1.d1 and c1/readme and d2-x.", "Move d3 to the left."]) {
      expect(plainPageRefs(text, { decisions })).toBe(text);
    }
    expect(plainPageRefs("Decision d3.js is a library, not a decision.", { decisions })).toBe("Decision d3.js is a library, not a decision.");
  });
});

describe("the page's view of comments sent with a decision", () => {
  const taskId = randomUUID();
  const person = (overrides: Partial<TaskComment> = {}): TaskComment => ({
    schemaVersion: 1, taskId, commentId: randomUUID(), document: "plan", version: 1, target: { kind: "document" },
    author: { kind: "person", developerId: SAM_ID, name: "Sam Lee", owner: false }, text: "Keep it short.", createdAt: "2026-10-11T09:00:00.000Z", rev: 1, ...overrides,
  });
  const approved = { requestId: randomUUID(), decision: "APPROVE" as const, at: "2026-10-11T09:30:00.000Z" };
  const context = { readerId: MAYA.developerId, now: Date.parse("2026-10-11T10:00:00.000Z"), artifacts: [] as Array<{ id: string; type: "requirements" | "design" | "plan"; version: number }> };

  it("a comment sent with the coding plan's approval reads as sent to coding, without hiding an answer that failed or one still coming", async () => {
    const { pageCommentViews } = await import("../../packages/broker/src/aws/plan-page/comments.js");
    const views = pageCommentViews([
      person({ lockedBy: approved }),
      person({ lockedBy: approved, ask: { state: "answered", at: "2026-10-11T09:10:00.000Z" } }),
      person({ lockedBy: approved, ask: { state: "failed", at: "2026-10-11T09:10:00.000Z" } }),
      person({ lockedBy: approved, ask: { state: "answering", at: "2026-10-11T09:55:00.000Z" } }),
      person({ document: "design", lockedBy: approved }),
      person({ lockedBy: { ...approved, decision: "REQUEST_CHANGES" } }),
    ], context);
    expect(views.map((view) => view.agentx)).toEqual(["sent_to_coding", "sent_to_coding", "couldnt", "answering", undefined, undefined]);
  });

  it("a planner reply says which document handled the comment and which claim cites it, worked out from its ID and the stored plans", async () => {
    const { pageCommentViews } = await import("../../packages/broker/src/aws/plan-page/comments.js");
    const asked = person({ document: "design", version: 1, lockedBy: approved });
    const artifact = { id: randomUUID(), type: "plan" as const, version: 2 };
    const reply = (id: string, forVersion: number): TaskComment => ({
      ...person({ document: "design", commentId: plannerReplyCommentId(asked.commentId, id), parentId: asked.commentId, text: "Done." }),
      author: { kind: "agentx", source: "planner", outcome: "done", forVersion },
    });
    const withArtifacts = { ...context, artifacts: [artifact], citations: new Map([[artifact.id, new Map([[asked.commentId, "1.2"]])]]) };
    const [, view] = pageCommentViews([asked, reply(artifact.id, 2)], withArtifacts);
    expect(view!.planner).toEqual({ outcome: "done", version: 2, document: "plan", in: "plan", claim: "1.2" });
    // A reply to a comment on the same kind of document (after Request changes) names no other document.
    const same = person({ document: "plan", version: 1, lockedBy: { ...approved, decision: "REQUEST_CHANGES" } });
    const [, again] = pageCommentViews([same, { ...reply(artifact.id, 2), commentId: plannerReplyCommentId(same.commentId, artifact.id), parentId: same.commentId, document: "plan" }], withArtifacts);
    expect(again!.planner).toEqual({ outcome: "done", version: 2, document: "plan" });
    // Only a comment sent with a decision can have been answered, so a reply to one that was not sent is read as it was written.
    const unsent = person({ document: "design", version: 1 });
    const [, unlocked] = pageCommentViews([unsent, { ...reply(artifact.id, 2), commentId: plannerReplyCommentId(unsent.commentId, artifact.id), parentId: unsent.commentId }], withArtifacts);
    expect(unlocked!.planner).toEqual({ outcome: "done", version: 2, document: "design" });
    // A reply whose document cannot be found (an artifact no longer listed) still reads as before.
    const [, lost] = pageCommentViews([asked, reply(randomUUID(), 2)], context);
    expect(lost!.planner).toEqual({ outcome: "done", version: 2, document: "design" });
  });

  it("a claim number in a planner's reply is a link only when that version of the handling document has the claim", async () => {
    const { pageCommentViews, replyParts } = await import("../../packages/broker/src/aws/plan-page/comments.js");
    const asked = person({ document: "design", version: 1, lockedBy: approved });
    const artifact = { id: randomUUID(), type: "plan" as const, version: 1 };
    const claimIds = new Map([[artifact.id, new Set(["1", "1.1", "1.1.1", "1.2", "1.2.1", "1.2.2", "1.2.3"])]]);
    const replyText = "Done in claims 1.2.1, 1.2.2 and 1.2.3 and the main sketch in 1.1.1. Not 1.9, v1.2 or 1.2.1.4. See claim 1 too, but 1 step is 1.";
    const reply: TaskComment = {
      ...person({ document: "design", commentId: plannerReplyCommentId(asked.commentId, artifact.id), parentId: asked.commentId, text: replyText }),
      author: { kind: "agentx", source: "planner", outcome: "done", forVersion: 1 },
    };
    const [, view] = pageCommentViews([asked, reply], { ...context, artifacts: [artifact], claimIds });
    const linked = view!.planner!.parts!.flatMap((part) => "claim" in part ? [part.claim] : []);
    expect(linked).toEqual(["1.2.1", "1.2.2", "1.2.3", "1.1.1", "1"]);
    // The parts put back together are the reply's own words.
    expect(view!.planner!.parts!.map((part) => "claim" in part ? part.claim : part.text).join("")).toBe(replyText);
    // No claims known (a document that could not be read), or none mentioned: no parts.
    expect(pageCommentViews([asked, reply], { ...context, artifacts: [artifact] })[1]!.planner!.parts).toBeUndefined();
    expect(replyParts("Nothing numbered here.", new Set(["1.1"]))).toBeUndefined();
    // Any case, and every number of a list after "claim(s)", also past a number that is no claim; quantities are never claims.
    const ids = new Set(["1", "2", "3", "2.5"]);
    const linkedIn = (text: string) => (replyParts(text, ids) ?? []).flatMap((part) => "claim" in part ? [part.claim] : []);
    expect(linkedIn("Claim 2 holds.")).toEqual(["2"]);
    expect(linkedIn("Claims 1, 2 and 3 changed.")).toEqual(["1", "2", "3"]);
    expect(linkedIn("See claims 2 and 3, and 1.")).toEqual(["2", "3", "1"]);
    expect(linkedIn("See claims 2 and 3. Then 1 step.")).toEqual(["2", "3"]);
    expect(linkedIn("claims 1, 9 and 3")).toEqual(["1", "3"]);
    expect(linkedIn("In 2 steps, 3 of them, but claim 1.")).toEqual(["1"]);
    expect(linkedIn("The timeout is 2.5 seconds, 2.5 minutes, 2.5% and 2.5 times; claim 2.5 stays.")).toEqual(["2.5"]);
    expect(linkedIn("It takes 2.5 ms.")).toEqual([]);
    expect(replyParts("Only 1.9.", new Set(["1.1"]))).toBeUndefined();
  });

  it("an AgentX reply shows as plain text: emphasis markers around a short phrase go, real asterisks and code stay", async () => {
    const { plainReplyText, pageCommentViews } = await import("../../packages/broker/src/aws/plan-page/comments.js");
    expect(plainReplyText("You can press *Request changes* in Slack, or add a _comment_ before approving.")).toBe("You can press Request changes in Slack, or add a comment before approving.");
    expect(plainReplyText("**Not changed**: *the copy*, (*one*) and _two_.")).toBe("Not changed: the copy, (one) and two.");
    for (const text of ["a*b and 2*3*4", "Match **/*.ts and src/*.js", "5 * 3 * 2", "snake_case_name and __init__", "set FOO=_bar_ and FOO:_baz_", "emoji :*) ok*", "an *unfinished phrase", "* a list marker", "Run `*raw*` and ```\n*fenced*\n```", "https://example.test/a_b_c"]) {
      expect(plainReplyText(text)).toBe(text);
    }
    expect(plainReplyText("Use `*raw*` but *this* goes.")).toBe("Use `*raw*` but this goes.");
    // Only AgentX's words are changed; a person's comment keeps what they typed.
    const answer: TaskComment = { ...person({ text: "Press *Request changes* here." }), author: { kind: "agentx", source: "answer" } };
    const mine = person({ text: "Please *keep* it short." });
    const views = pageCommentViews([mine, answer], context);
    expect(views.map((view) => view.text)).toEqual(["Please *keep* it short.", "Press Request changes here."]);
  });

  it("a locked comment says which decision it was sent with", async () => {
    const { pageCommentViews } = await import("../../packages/broker/src/aws/plan-page/comments.js");
    const views = pageCommentViews([person({ lockedBy: approved }), person({ lockedBy: { ...approved, decision: "REQUEST_CHANGES" } }), person()], context);
    expect(views.map((view) => [view.sent, view.sentWith])).toEqual([[true, "APPROVE"], [true, "REQUEST_CHANGES"], [false, undefined]]);
  });
});
