import type { TaskReadDecision } from "../../packages/broker/src/core/task-flow/read-rule.js";
// A queued question is answered using the document's current human comments, including changes after it was queued.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sharedTaskKey } from "@agentx/contracts";
import { workflowTaskAnswerContext } from "../../packages/broker/src/aws/developer-tasks.js";
import { createCoreTaskRuleRoutes } from "../../packages/broker/src/aws/core-task-rule-routes.js";
import { coreTaskMarkKey } from "../../packages/broker/src/core-host/core-task-mark.js";
import { pageTask, pagePlan, PRIYA } from "../support/page-tasks.js";

async function question() {
  const h = pageTask();
  h.addVersion("plan", pagePlan());
  const key = { pk: `DEVTASK#${h.taskId}`, sk: "META" };
  const task = h.db.get(key.pk, key.sk)!;
  h.db.set({ ...task, companyId: "org_corehost00000000000a" });
  h.deps.companyId = "org_corehost00000000000a";
  h.db.set({ ...coreTaskMarkKey(h.taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "all", stampedAt: new Date().toISOString() } });
  const share = task["share"] as { teamId: string; channelId: string; threadTs: string };
  const thread = { teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs };
  h.db.set({ ...sharedTaskKey(thread), taskId: h.taskId, workflowThread: true });
  h.deps.slackRequestQueue = { send: async () => undefined };
  // D1: the page's comment routes are gone; a comment is posted through the core's own route (POST /v1/dev/tasks/<id>/comments), which writes the rows the answer context reads.
  const routes = createCoreTaskRuleRoutes(() => h.deps);
  const path = `/v1/dev/tasks/${h.taskId}/comments`;
  const post = async (text: string, _ask = false) => {
    void _ask;
    const answer = await routes.route({ request: { method: "POST", path, headers: {}, body: JSON.stringify({ requestId: randomUUID(), document: "plan", text }) }, path,
      person: { developerId: PRIYA.developerId, name: PRIYA.name }, companyId: "org_corehost00000000000a", task: h.db.get(`DEVTASK#${h.taskId}`, "META")!, store: { query: async () => ({ items: [] }) },
      authorize: async () => ({ task: h.db.get(`DEVTASK#${h.taskId}`, "META")! } as unknown as TaskReadDecision) });
    return JSON.parse(answer.body) as { comment: { id?: string; commentId: string } };
  };
  const asked = await post("Which placement now?", true);
  if (typeof task["workspaceId"] !== "string") throw new Error("workspace missing");
  const input = { taskId: h.taskId, workspaceId: task["workspaceId"], thread, commentId: asked.comment.commentId };
  const context = () => workflowTaskAnswerContext(h.deps, input);
  h.advance(1000);
  return { ...h, post, asked, context };
}

describe("a core comment answer uses the current document's comment set", () => {
  it("add: includes another comment added after the question was queued", async () => {
    const h = await question();
    await h.post("ADDED_AFTER_QUEUED_QUESTION");
    expect(await h.context()).toContain("ADDED_AFTER_QUEUED_QUESTION");
  });

  it.each(["agent", "other document", "future version"] as const)("excludes %s text from current human comments", async (kind) => {
    const h = await question();
    const comment = await h.post("EXCLUDED_CURRENT_COMMENT");
    const row = h.db.get(`DEVTASK#${h.taskId}`, `COMMENT#${comment.comment.commentId}`)!;
    h.db.set({ ...row, ...(kind === "agent" ? { author: { kind: "agentx", source: "answer" } } : kind === "other document" ? { document: "design" } : { version: 99 }) });
    expect(await h.context()).not.toContain("EXCLUDED_CURRENT_COMMENT");
  });

  it.each(["deleted", "agent", "missing"] as const)("a %s queued question has no answer context", async (kind) => {
    const h = await question();
    const pk = `DEVTASK#${h.taskId}`, sk = `COMMENT#${h.asked.comment.commentId}`;
    if (kind === "missing") h.db.delete(pk, sk);
    else h.db.set({ ...h.db.get(pk, sk)!, ...(kind === "agent" ? { author: { kind: "agentx", source: "answer" } } : { text: "", deletedAt: "2026-11-22T12:00:00.000Z" }) });
    expect(await h.context()).toBeUndefined();
  });

  it("the version ceiling comes from the question's document, even when another document has newer versions", async () => {
    const h = await question();
    const comment = await h.post("FUTURE_PLAN_COMMENT");
    const row = h.db.get(`DEVTASK#${h.taskId}`, `COMMENT#${comment.comment.commentId}`)!;
    h.db.set({ ...row, version: 2 });
    h.addVersion("design", pagePlan());
    h.addVersion("design", pagePlan());
    const context = await h.context();
    expect(context).toContain("Which placement now?");
    expect(context).not.toContain("FUTURE_PLAN_COMMENT");
  });
});
