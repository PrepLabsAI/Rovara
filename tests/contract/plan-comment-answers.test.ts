// After Request changes on the page, the planner says what it did with each included comment; those answers become
// replies from AgentX under the comments, written once, never past the task's comment cap, and never in the plan's way.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCommentAnswers, plainPageRefs, plannerReplyCommentId, type PlanDocument, type TaskComment, type WorkflowSnapshot } from "@agentx/contracts";
import { decideTaskWorkflow, type DeveloperTaskRouteDependencies } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { readDecisionDetail } from "../../packages/broker/src/developer/owner-answers.js";
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
async function designApproved(options: { comments?: number } = {}) {
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
  const ids = Array.from({ length: options.comments ?? 2 }, (_, index) => seed(index === 0 ? "Keep each item to one line." : "Why two steps?"));
  harness.db.set({ pk: `DEVTASK#${taskId}`, sk: "COMMENTS", entityType: "TASK_COMMENT_COUNTER", taskId, count: ids.length, seq: ids.length });
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
  return { harness, taskId, workspaceId, requestId, ids, plan, prompt };
}

describe("planner answers to comments sent with an Approve", () => {
  const cited = (ref: string) => planDocument({ title: "Retry banner coding plan", decisions: [], claims: [{ id: "1", text: "Each bullet stays on one line.",
    evidence: [{ kind: "quote", text: "Keep each item to one line.", author: `owner (comment ${ref})` }] }, { id: "2", text: "A payment is never charged twice." }] });

  it("the coding plan's answers become replies on the design's comments, saying which document handled them and where", async () => {
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
    expect(replies.find((reply) => reply.commentId === plannerReplyCommentId(t.ids[0]!, coding.id))).toMatchObject({
      parentId: t.ids[0], document: "design", version: 1, target: { kind: "document" }, text: "Each bullet stays on one line.",
      author: { kind: "agentx", source: "planner", outcome: "done", forVersion: 1, handledIn: "plan", claim: "1" },
    });
    const kept = replies.find((reply) => reply.commentId === plannerReplyCommentId(t.ids[1]!, coding.id))!;
    expect(kept).toMatchObject({ parentId: t.ids[1], document: "design", author: { outcome: "not_changed", handledIn: "plan" } });
    expect(kept.author).not.toHaveProperty("claim");
  });

  it("the planner is asked for the answers after an Approve with comments, and not when the approval has none", async () => {
    const t = await designApproved();
    expect(t.prompt()).toContain("agentx-comment-answers");
    expect(t.prompt()).toContain("The owner sent the comments above with their approval");
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
      taskId: t.taskId, artifactId: workflow.artifacts.at(-1)!.id, version: 1, detail, handledIn: "plan",
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

describe("plain references in AgentX text", () => {
  const decisions = new Map([["d1", "Where does the banner go?"], ["d2", "How many times should a payment be retried and for how long before it is given up on for good?"]]);
  it("names a decision by its question and a comment by what it is", () => {
    expect(plainPageRefs("This was confirmed by you in decision d1.", { decisions })).toBe('This was confirmed by you in decision "Where does the banner go".');
    expect(plainPageRefs("You settled decision d1 (Algorithms expansion + more) earlier.", { decisions })).toBe("You settled the decision (Algorithms expansion + more) earlier.");
    expect(plainPageRefs("See d2.", { decisions })).toBe('See "How many times should a payment be retried and for how long…".');
    expect(plainPageRefs("As comment c1 asked, and c2 too.", { decisions })).toBe("As that comment asked, and c2 too.");
    expect(plainPageRefs("As comment c1 asked, and c2 too.", { decisions, bareComments: true })).toBe("As that comment asked, and that comment too.");
  });
  it("makes a decision the plan does not have plain, and leaves other text alone", () => {
    expect(plainPageRefs("Decision d9 is not here; d9 stays, and a3 or d100 are left.", { decisions })).toBe("a decision is not here; d9 stays, and a3 or d100 are left.");
  });
});
