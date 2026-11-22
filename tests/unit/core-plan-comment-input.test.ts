// The next planning turn reads current retained comment rows and fences them with their existing counter.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { StoredDocument } from "@agentx/contracts";
import { commentsForPlanningStep } from "../../packages/broker/src/core/plan/comments.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { pageTask, pagePlan, PRIYA } from "../support/page-tasks.js";

const COMPANY = "org_corehost00000000000a";
function fixture() {
  const page = pageTask();
  page.addVersion("plan", pagePlan());
  const task = { ...page.db.get(`DEVTASK#${page.taskId}`, "META"), companyId: COMPANY } as unknown as TaskRecord;
  const store = new MemoryDocumentStore();
  const deps = { store, companyId: COMPANY };
  const counterKey = { pk: `DEVTASK#${page.taskId}`, sk: "COMMENTS" };
  const comment = (text: string, extra: Record<string, StoredDocument[string]> = {}): StoredDocument => {
    const id = randomUUID();
    return { pk: counterKey.pk, sk: `COMMENT#${id}`, entityType: "TASK_COMMENT", schemaVersion: 1, taskId: task.taskId, commentId: id,
      document: "plan", version: 1, target: { kind: "document" }, author: { kind: "person", developerId: PRIYA.developerId, name: PRIYA.name, owner: true }, text,
      createdAt: "2026-10-11T10:00:00.000Z", rev: 1, ...extra };
  };
  const read = () => commentsForPlanningStep(deps, { task, workflowMode: "PLAN", requestId: randomUUID() });
  return { task, store, deps, counterKey, comment, read };
}

describe("current planning comments", () => {
  it("omits deleted, foreign-task, future-version, other-document and agent text; follows pages", async () => {
    const h = fixture();
    const rows = [h.comment("CURRENT"), h.comment("", { deletedAt: "2026-10-11T10:01:00.000Z" }), h.comment("FOREIGN", { taskId: randomUUID() }), h.comment("FUTURE", { version: 2 }), h.comment("OTHER_DOCUMENT", { document: "design" }), h.comment("OLD_AGENT", { author: { kind: "agentx", source: "answer" } }), { pk: h.counterKey.pk, sk: "COMMENT#malformed", text: "MALFORMED" }];
    for (const item of rows) await h.store.put({ item });
    const query = h.store.query.bind(h.store);
    const pages = vi.spyOn(h.store, "query").mockImplementation((request) => query({ ...request, limit: 1 }));
    const input = await h.read();
    expect(input.suffix).toContain("CURRENT");
    expect(input.suffix.match(/<page_comment /gu)).toHaveLength(1);
    for (const absent of ["FOREIGN", "FUTURE", "OTHER_DOCUMENT", "OLD_AGENT", "MALFORMED"]) expect(input.suffix).not.toContain(absent);
    expect(pages).toHaveBeenCalledTimes(rows.length);
  });

  it("an empty current set supersedes earlier input and fences an add before acceptance", async () => {
    const h = fixture();
    const input = await h.read();
    expect(input.suffix).toContain("There are no current comments");
    expect(input.suffix).toContain("replaces earlier page-comment input");
    expect((await h.store.transact(input.items)).applied).toBe(true);
    await h.store.put({ item: { ...h.counterKey, seq: 1 } });
    expect((await h.store.transact(input.items)).applied).toBe(false);
  });

  it("an edit or delete after the read cancels acceptance at the previous counter revision", async () => {
    const h = fixture();
    await h.store.put({ item: { ...h.counterKey, seq: 1 } });
    await h.store.put({ item: h.comment("CURRENT") });
    const input = await h.read();
    expect((await h.store.transact(input.items)).applied).toBe(true);
    await h.store.put({ item: { ...h.counterKey, seq: 2 } });
    expect((await h.store.transact(input.items)).applied).toBe(false);
  });

  it("a different company is refused before reading the comment partition", async () => {
    const h = fixture();
    const get = vi.spyOn(h.store, "get");
    const query = vi.spyOn(h.store, "query");
    await expect(commentsForPlanningStep({ ...h.deps, companyId: "org_corehost00000000000b" }, { task: h.task, workflowMode: "PLAN", requestId: randomUUID() })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(get).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not add comment input to a nonplanning step, and a read failure propagates", async () => {
    const h = fixture();
    expect(await commentsForPlanningStep(h.deps, { task: h.task, workflowMode: "BUILD", requestId: randomUUID() })).toEqual({ suffix: "", items: [] });
    vi.spyOn(h.store, "query").mockRejectedValue(new Error("reader unavailable"));
    await expect(h.read()).rejects.toThrow("reader unavailable");
  });
});
