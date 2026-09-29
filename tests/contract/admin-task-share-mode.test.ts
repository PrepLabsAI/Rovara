// Spec 025 C25 (owner answer to Q2, 2026-09-29): an AgentX admin may switch a shared task between
// view only and continue, within the project's policy, through the admin API; nobody else but the
// owning developer may.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { setTaskShareMode } from "../../packages/cli/src/admin/task-share-mode.js";
import { MAYA, OMAR, createDeveloperTaskBroker, markThreadPosted, registerRevision } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, issuer } from "../support/slack-broker.js";

const ADMIN = { subject: "admin-subject", admin: true };

async function sharedTask(body: Record<string, unknown> = { shareToChannel: true, shareMode: "continue" }) {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", ...body });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const switchMode = (shareMode: string, user: { subject: string; admin?: boolean } = ADMIN, extra: Record<string, unknown> = {}) =>
    call(harness.handler, { method: "POST", path: `/v1/admin/tasks/${taskId}/share-mode`, user, body: { requestId: randomUUID(), shareMode, ...extra } });
  const record = () => harness.db.get(`DEVTASK#${taskId}`, "META") as { share?: { mode: string; modeReason?: string } };
  return { ...harness, taskId, switchMode, record };
}

describe("an admin switches a shared task's mode (C25)", () => {
  it("changes the task and its thread, audits it naming the admin, and answers the share only (D22)", async () => {
    const { db, taskId, switchMode, record } = await sharedTask();
    markThreadPosted(db, taskId);
    const answer = await switchMode("view");
    expect(answer.status).toBe(200);
    // Ruling F5: the task's id and share (mode, channel, thread link), never its title or results.
    expect(answer.body.task).toEqual({ taskId, share: { mode: "view", channelId: SLACK_CHANNEL, channelName: "payments-dev", sharedReason: "requested", threadUrl: `https://slack.com/archives/${SLACK_CHANNEL}/p1695500000000100` } });
    expect(answer.body.task).not.toHaveProperty("title");
    expect(record().share).toMatchObject({ mode: "view" });
    expect(db.get(`SHARED_TASK#${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000100`, "META")).toMatchObject({ mode: "view" });
    expect(db.find((item) => item.pk === `TASK#${taskId}` && item.action === "share")).toEqual([expect.objectContaining({
      origin: "ai_tool", phase: "accepted", admin: { issuer, subject: "admin-subject" }, developer: expect.objectContaining({ developerId: MAYA.developerId }) as unknown,
    })]);
  });

  it("stays within the project's policy: continue is view where the project does not allow it", async () => {
    const { handler, switchMode, record } = await sharedTask({ shareToChannel: true });
    await registerRevision(handler, 2, { shareMode: { default: "view", allowContinue: false } });
    expect((await switchMode("continue")).body.task).toMatchObject({ share: { mode: "view", modeReason: "continue_not_allowed" } });
    expect(record().share).toMatchObject({ mode: "view", modeReason: "continue_not_allowed" });
  });

  it("refuses a non-admin, and an admin who does not administer the project, and changes nothing", async () => {
    const { switchMode, record } = await sharedTask();
    expect((await switchMode("view", { subject: "someone", admin: false })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await switchMode("view", { subject: "other-admin", admin: true })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(record().share).toMatchObject({ mode: "continue" });
  });

  it("still refuses a developer who does not own the task, through the developer API", async () => {
    const { dev, taskId, record } = await sharedTask();
    expect((await dev(OMAR, "POST", `/v1/dev/tasks/${taskId}/share`, { requestId: randomUUID(), shareMode: "view" })).body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(record().share).toMatchObject({ mode: "continue" });
  });

  it("cannot share a private task or move it, and answers an unknown task TASK_NOT_FOUND", async () => {
    const priv = await sharedTask({});
    expect((await priv.switchMode("view")).body.error).toMatchObject({ code: "CONFIG_INVALID", message: "this task is private; only its developer can share it" });
    const shared = await sharedTask();
    expect((await shared.switchMode("view", ADMIN, { channel: "C0SECOND001" })).body.error).toMatchObject({ code: "CONFIG_INVALID" });
    const unknown = await call(shared.handler, { method: "POST", path: `/v1/admin/tasks/${randomUUID()}/share-mode`, user: ADMIN, body: { requestId: randomUUID(), shareMode: "view" } });
    expect(unknown.body.error).toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("answers a repeated request_id with the task and writes nothing", async () => {
    const { db, handler, taskId } = await sharedTask();
    const body = { requestId: randomUUID(), shareMode: "view" };
    await call(handler, { method: "POST", path: `/v1/admin/tasks/${taskId}/share-mode`, user: ADMIN, body });
    await call(handler, { method: "POST", path: `/v1/admin/tasks/${taskId}/share-mode`, user: ADMIN, body });
    expect(db.find((item) => item.pk === `TASK#${taskId}` && item.action === "share")).toHaveLength(1);
  });
});

describe("agentx admin task share-mode", () => {
  it("posts the mode with the admin token and a fresh request ID, and reports AgentX's refusal", async () => {
    const fetch = vi.fn(async () => Response.json({ task: { taskId: "t" } }));
    await setTaskShareMode({ controlPlaneUrl: "https://agentx.example.test/", accessToken: "admin-token", taskId: "44444444-4444-4444-8444-444444444444", mode: "view" }, fetch);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://agentx.example.test/v1/admin/tasks/44444444-4444-4444-8444-444444444444/share-mode");
    expect(init.headers).toMatchObject({ authorization: "Bearer admin-token" });
    expect(JSON.parse(init.body as string)).toMatchObject({ shareMode: "view", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown });
    const refused = vi.fn(async () => Response.json({ error: { code: "FORBIDDEN", message: "administrator claim is required" } }, { status: 403 }));
    await expect(setTaskShareMode({ controlPlaneUrl: "https://agentx.example.test", accessToken: "t", taskId: "x", mode: "continue" }, refused as unknown as typeof globalThis.fetch)).rejects.toThrow(/FORBIDDEN: administrator claim is required/);
  });
});
