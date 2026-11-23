// A queued question is answered using the document's current human comments, including changes after it was queued.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sharedTaskKey } from "@agentx/contracts";
import { createPageComment, deletePageComment, editPageComment, workflowTaskAnswerContext } from "../../packages/broker/src/aws/developer-tasks.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { pageTask, pagePlan, PRIYA } from "../support/page-tasks.js";

async function question() {
  const h = pageTask();
  h.addVersion("plan", pagePlan());
  const key = { pk: `DEVTASK#${h.taskId}`, sk: "META" };
  const task = h.db.get(key.pk, key.sk)!;
  h.db.set({ ...task, companyId: "org_corehost00000000000a" });
  h.deps.companyId = "org_corehost00000000000a";
  h.db.set({ ...engineStampKey(h.taskId), coreEngine: { engine: "core", areas: { flow: "core", build: "core", merge: "core" }, flags: "all", stampedAt: new Date().toISOString() } });
  const share = task["share"] as { teamId: string; channelId: string; threadTs: string };
  const thread = { teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs };
  h.db.set({ ...sharedTaskKey(thread), taskId: h.taskId, workflowThread: true });
  h.deps.slackRequestQueue = { send: async () => undefined };
  const post = (text: string, ask = false) => createPageComment(h.deps, PRIYA, h.taskId, { requestId: randomUUID(), document: "plan", version: 1, target: { kind: "document" }, text, ask });
  const asked = await post("Which placement now?", true);
  if (typeof task["workspaceId"] !== "string") throw new Error("workspace missing");
  const input = { taskId: h.taskId, workspaceId: task["workspaceId"], thread, commentId: asked.comment.id };
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

  it("edit: replaces another comment's old text in the answer context", async () => {
    const h = await question();
    const comment = await h.post("OBSOLETE_OTHER_COMMENT");
    expect(await h.context()).toContain("OBSOLETE_OTHER_COMMENT");
    await editPageComment(h.deps, PRIYA, h.taskId, { commentId: comment.comment.id, rev: 1, text: "REPLACEMENT_OTHER_COMMENT" });
    const context = await h.context();
    expect(context).toContain("REPLACEMENT_OTHER_COMMENT");
    expect(context).not.toContain("OBSOLETE_OTHER_COMMENT");
  });

  it("delete: removes another comment from the answer context", async () => {
    const h = await question();
    const comment = await h.post("REMOVE_OTHER_COMMENT");
    expect(await h.context()).toContain("REMOVE_OTHER_COMMENT");
    await deletePageComment(h.deps, PRIYA, h.taskId, { commentId: comment.comment.id, rev: 1 });
    const context = await h.context();
    expect(context).not.toContain("REMOVE_OTHER_COMMENT");
    expect(context?.match(/<page_comment /gu)).toHaveLength(1);
  });

  it.each(["agent", "other document", "future version"] as const)("excludes %s text from current human comments", async (kind) => {
    const h = await question();
    const comment = await h.post("EXCLUDED_CURRENT_COMMENT");
    const row = h.db.get(`DEVTASK#${h.taskId}`, `COMMENT#${comment.comment.id}`)!;
    h.db.set({ ...row, ...(kind === "agent" ? { author: { kind: "agentx", source: "answer" } } : kind === "other document" ? { document: "design" } : { version: 99 }) });
    expect(await h.context()).not.toContain("EXCLUDED_CURRENT_COMMENT");
  });

  it.each(["deleted", "agent", "missing"] as const)("a %s queued question has no answer context", async (kind) => {
    const h = await question();
    const pk = `DEVTASK#${h.taskId}`, sk = `COMMENT#${h.asked.comment.id}`;
    if (kind === "missing") h.db.delete(pk, sk);
    else h.db.set({ ...h.db.get(pk, sk)!, ...(kind === "agent" ? { author: { kind: "agentx", source: "answer" } } : { text: "", deletedAt: "2026-11-22T12:00:00.000Z" }) });
    expect(await h.context()).toBeUndefined();
  });

  it("the version ceiling comes from the question's document, even when another document has newer versions", async () => {
    const h = await question();
    const comment = await h.post("FUTURE_PLAN_COMMENT");
    const row = h.db.get(`DEVTASK#${h.taskId}`, `COMMENT#${comment.comment.id}`)!;
    h.db.set({ ...row, version: 2 });
    h.addVersion("design", pagePlan());
    h.addVersion("design", pagePlan());
    const context = await h.context();
    expect(context).toContain("Which placement now?");
    expect(context).not.toContain("FUTURE_PLAN_COMMENT");
  });

  it("an edited queued question cannot be answered from its obsolete queue text", async () => {
    const h = await question();
    await editPageComment(h.deps, PRIYA, h.taskId, { commentId: h.asked.comment.id, rev: 1, text: "Changed question" });
    expect(await h.context()).toBeUndefined();
  });
});
