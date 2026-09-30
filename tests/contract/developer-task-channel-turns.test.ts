// tests/contract/developer-task-channel-turns.test.ts
// Spec 025 C15: the channel's turns on a shared task, from the thread's Slack turn records.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker, markThreadPosted } from "../support/developer-task-broker.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

async function sharedTask() {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", shareToChannel: true, shareMode: "continue" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const subject = markThreadPosted(harness.db, taskId);
  const turn = (at: string, fields: Record<string, unknown>) => harness.db.set({
    pk: `THREAD#${subject}`, sk: `TURN#${at}#Ev${at.replace(/\D/g, "").slice(0, 12)}`, origin: "slack", subject, receivedAt: at,
    requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0PRIYA001" }, disposition: "answered", requestText: "run the linter", responseText: "done", ...fields,
  });
  return { ...harness, taskId, subject, turn };
}

describe("channel turns (C15)", () => {
  it("lists this task's turns newest first, with author, time, request and outcome", async () => {
    const { dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId, requesterName: "Priya" });
    turn("2026-09-29T10:02:00.000Z", { taskId, requestedBy: { teamId: "T0BSHLLUGBD", userId: "U0LEO00001" }, disposition: "failed", requestText: "also bump the version" });
    turn("2026-09-29T10:03:00.000Z", {});
    turn("2026-09-29T10:04:00.000Z", { taskId: randomUUID() });
    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { channelTurns: unknown[] };
    expect(view.channelTurns).toEqual([
      { author: { slackUserId: "U0LEO00001" }, at: "2026-09-29T10:02:00.000Z", request: "also bump the version", outcome: "failed" },
      { author: { slackUserId: "U0PRIYA001", name: "Priya" }, at: "2026-09-29T10:01:00.000Z", request: "run the linter", outcome: "answered" },
    ]);
  });

  it("cuts a request to 300 characters and redacts it again on the way out", async () => {
    const { dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId, requestText: `use ${SECRET} ${"y".repeat(500)}` });
    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { channelTurns: Array<{ request: string }> };
    expect(view.channelTurns[0]!.request.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });

  it("shows at most 20, and none for a task whose thread is not posted", async () => {
    const { dev, taskId, turn } = await sharedTask();
    for (let index = 0; index < 25; index += 1) turn(`2026-09-29T10:${String(10 + index).padStart(2, "0")}:00.000Z`, { taskId });
    const newest = ((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { channelTurns: Array<{ at: string }> }).channelTurns;
    expect(newest).toHaveLength(20);
    expect([newest[0]!.at, newest[19]!.at]).toEqual(["2026-09-29T10:34:00.000Z", "2026-09-29T10:15:00.000Z"]);
    const fresh = await createDeveloperTaskBroker();
    const other = await fresh.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", shareToChannel: true });
    const otherId = (other.body.task as { taskId: string }).taskId;
    expect((await fresh.dev(MAYA, "GET", `/v1/dev/tasks/${otherId}`)).body.task).not.toHaveProperty("channelTurns");
  });

  it("still answers the read when the turn records cannot be read", async () => {
    const { db, dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId });
    const original = db.send;
    db.send = async (command) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("THREAD#")) throw Object.assign(new Error("nope"), { name: "InternalServerError" });
      return original(command);
    };
    const read = await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(read.status).toBe(200);
    expect(read.body.task).not.toHaveProperty("channelTurns");
  });

  it("leaves out a record that has no time, so the view stays valid", async () => {
    const { db, dev, taskId, subject, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId });
    db.set({ pk: `THREAD#${subject}`, sk: "TURN#2026-09-29T10:05:00.000Z#EvNoTime", origin: "slack", subject, taskId, requestedBy: { userId: "U0PRIYA001" }, disposition: "answered", requestText: "no time" });
    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { channelTurns: Array<{ at: string }> };
    expect(view.channelTurns.map((entry) => entry.at)).toEqual(["2026-09-29T10:01:00.000Z"]);
  });

  it("shows the turns only to the task's owner, never a teammate's reply text (FR-036)", async () => {
    const { dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId, requesterName: "Priya", responseText: "the private reply" });
    const other = await dev(OMAR, "GET", `/v1/dev/tasks/${taskId}`);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toContain("run the linter");
    const own = await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(JSON.stringify(own.body)).not.toContain("the private reply");
  });

  it("leaves out a record whose time is not a timestamp", async () => {
    const { dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId });
    turn("2026-09-29T10:02:00.000Z", { taskId, receivedAt: "yesterday" });
    turn("2026-09-29T10:03:00.000Z", { taskId, receivedAt: "2026-09-29" });
    const view = (await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { channelTurns: Array<{ at: string }> };
    expect(view.channelTurns.map((entry) => entry.at)).toEqual(["2026-09-29T10:01:00.000Z"]);
  });

  it("logs when the read stops at its page cap, with counts and no text", async () => {
    const { db, dev, taskId, turn } = await sharedTask();
    turn("2026-09-29T10:01:00.000Z", { taskId });
    const original = db.send;
    let pages = 0;
    db.send = async (command) => {
      const input = JSON.stringify(command.input);
      if (command.constructor.name === "QueryCommand" && input.includes("THREAD#")) {
        pages += 1;
        return { Items: [{ pk: "x", sk: `TURN#${pages}`, taskId: "another-task", receivedAt: "2026-09-29T10:00:00.000Z", requestText: "run the linter" }], LastEvaluatedKey: { pk: "x", sk: `TURN#${pages}` } };
      }
      return original(command);
    };
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const read = await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
      expect(read.status).toBe(200);
      expect(pages).toBe(5);
      const lines = logs.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("developer.channel_turns_capped"));
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ component: "broker", event: "developer.channel_turns_capped", pages: 5, found: 0 }]);
      expect(lines.join("\n")).not.toContain("run the linter");
    } finally {
      logs.mockRestore();
    }
  });
});
