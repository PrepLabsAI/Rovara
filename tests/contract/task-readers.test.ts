// Spec 067: task readers. A task's owner shares it read-only with another member of its project; the reader reads the task and
// its events and nothing else, only while they are still a member; for anyone else a shared task reads as not found.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DeveloperTaskViewSchema, TaskReaderDeleteResponseSchema, TaskReaderPutResponseSchema, TaskReadersResponseSchema } from "../../packages/contracts/src/index.js";
import { MAYA, OMAR, createDeveloperTaskBroker, grantProject } from "../support/developer-task-broker.js";

const NOBODY = "c".repeat(64);

/** An answer without the request id Code adds to every answer. */
const answer = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([key]) => key !== "requestId"));

/** Maya's task in payments; Omar is registered but not a member of payments until a test grants it. */
async function mayasTask() {
  const harness = await createDeveloperTaskBroker();
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "Rovara Cloud" });
  const taskId = (started.body.task as { taskId: string }).taskId;
  const path = `/v1/dev/tasks/${taskId}`;
  const share = (who = OMAR.developerId, by = MAYA) => harness.dev(by, "PUT", `${path}/readers/${who}`, { requestId: randomUUID(), role: "viewer" });
  const unshare = (who = OMAR.developerId, by = MAYA) => harness.dev(by, "DELETE", `${path}/readers/${who}`);
  const readers = (by = MAYA) => harness.dev(by, "GET", `${path}/readers`);
  return { ...harness, taskId, path, share, unshare, readers };
}

const notFound = (response: { status: number; body: Record<string, unknown> }, taskId: string) => {
  expect(response.status).toBe(404);
  expect(response.body.error).toEqual({ code: "TASK_NOT_FOUND", message: `no task ${taskId} of yours` });
};

describe("sharing a task with a reader (spec 067)", () => {
  it("shares only with a member of the task's project, once, and lists the reader for the owner", async () => {
    const { db, share, readers } = await mayasTask();
    const refused = await share();
    expect(refused.status).toBe(400);
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "that person isn't a member of payments; add them to the project first" });
    // Someone who isn't registered is told the same, so the answer doesn't say who is.
    expect((await share(NOBODY)).body.error).toEqual(refused.body.error);
    grantProject(db, OMAR);
    const first = await share();
    expect(first.status).toBe(200);
    expect(TaskReaderPutResponseSchema.parse(answer(first.body))).toMatchObject({ already: false, reader: { developerId: OMAR.developerId, name: "Omar Diaz", role: "viewer", projectMember: true } });
    expect(TaskReaderPutResponseSchema.parse(answer((await share()).body)).already).toBe(true);
    expect(TaskReadersResponseSchema.parse(answer((await readers()).body)).readers).toMatchObject([{ developerId: OMAR.developerId, name: "Omar Diaz", projectMember: true }]);
  });

  it("refuses sharing with yourself, a malformed id, a role other than viewer, and a missing request id", async () => {
    const { db, path, share, dev } = await mayasTask();
    grantProject(db, OMAR);
    expect((await share(MAYA.developerId)).body.error).toMatchObject({ code: "CONFIG_INVALID", message: "you own this task, so you already read it" });
    expect((await share("not-an-id")).body.error).toMatchObject({ code: "CONFIG_INVALID", message: "name the person by their developer ID" });
    for (const body of [{ requestId: randomUUID(), role: "owner" }, { role: "viewer" }, { requestId: randomUUID(), role: "viewer", extra: true }]) {
      expect((await dev(MAYA, "PUT", `${path}/readers/${OMAR.developerId}`, body)).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    }
  });

  it("lets a reader read the task and its events in the viewer view, and do nothing else", async () => {
    const { db, taskId, path, share, unshare, readers, dev } = await mayasTask();
    notFound(await dev(OMAR, "GET", path), taskId);
    grantProject(db, OMAR);
    await share();
    const read = await dev(OMAR, "GET", path);
    expect(read.status).toBe(200);
    expect(DeveloperTaskViewSchema.parse((read.body as { task: unknown }).task)).toMatchObject({ taskId, project: "payments" });
    expect((await dev(OMAR, "GET", `${path}/events`)).status).toBe(200);
    // Everything else stays the owner's: the task reads as not found there, as it does to anyone it isn't shared with.
    for (const [method, suffix, body] of [
      ["POST", "/cancel", { requestId: randomUUID() }], ["POST", "/close", { requestId: randomUUID() }], ["GET", "/plan", undefined],
      ["POST", "/continue", { requestId: randomUUID(), instructions: "more" }], ["POST", "/workflow/decision", { requestId: randomUUID(), expectedRevision: 1, decision: "APPROVE", reason: "ok", artifactDigest: "a".repeat(64) }],
    ] as const) {
      const refused = await dev(OMAR, method, `${path}${suffix}`, body);
      expect([suffix, refused.status, refused.body.error]).toEqual([suffix, 404, expect.objectContaining({ code: "TASK_NOT_FOUND" })]);
    }
    // Only the owner shares, unshares and lists: a reader is told so.
    for (const response of [await share(OMAR.developerId, OMAR), await unshare(OMAR.developerId, OMAR), await readers(OMAR)]) {
      expect(response.status).toBe(403);
      expect(response.body.error).toEqual({ code: "FORBIDDEN", message: "only the task's owner can share it" });
    }
  });

  it("writes nothing when a reader reads", async () => {
    const { db, path, share, dev } = await mayasTask();
    grantProject(db, OMAR);
    await share();
    const writes: unknown[] = [];
    const stop = db.onWrite((change) => { writes.push(change); });
    await dev(OMAR, "GET", path);
    await dev(OMAR, "GET", `${path}/events`);
    stop();
    expect(writes).toEqual([]);
  });

  it("ends a reader's access when they leave the project or the owner unshares", async () => {
    const { db, taskId, path, share, unshare, readers, dev } = await mayasTask();
    grantProject(db, OMAR);
    await share();
    expect((await dev(OMAR, "GET", path)).status).toBe(200);
    db.delete(`MEMBER#${OMAR.developerId}`, "PROJECT#payments");
    notFound(await dev(OMAR, "GET", path), taskId);
    notFound(await dev(OMAR, "GET", `${path}/events`), taskId);
    expect(TaskReadersResponseSchema.parse(answer((await readers()).body)).readers).toMatchObject([{ developerId: OMAR.developerId, projectMember: false }]);
    grantProject(db, OMAR);
    expect((await dev(OMAR, "GET", path)).status).toBe(200);
    expect(TaskReaderDeleteResponseSchema.parse(answer((await unshare()).body))).toEqual({ developerId: OMAR.developerId, removed: true });
    expect(TaskReaderDeleteResponseSchema.parse(answer((await unshare()).body))).toEqual({ developerId: OMAR.developerId, removed: false });
    notFound(await dev(OMAR, "GET", path), taskId);
    expect(TaskReadersResponseSchema.parse(answer((await readers()).body)).readers).toEqual([]);
  });

  it("ends a removed person's reading", async () => {
    const { db, path, share, dev } = await mayasTask();
    grantProject(db, OMAR);
    await share();
    db.set({ ...db.get(`DEVELOPER#${OMAR.developerId}`, "META")!, revoked: true });
    expect((await dev(OMAR, "GET", path)).status).not.toBe(200);
  });
});
