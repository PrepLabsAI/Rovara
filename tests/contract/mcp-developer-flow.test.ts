// Spec 025 Testing section: the MCP SDK's client drives `agentx mcp`'s server against the broker in
// process, through User Stories 1 and 2. The client lists the tools first, as real AI tools do, so
// every error result is also checked against SDK 1.30.1's output-schema validation (ruling F3).
import { describe, expect, it } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { URL_BASE, signedInClient } from "../support/mcp-broker-client.js";

type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;

const workspaceOf = (harness: Harness, taskId: string) => (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
const activeOf = (harness: Harness, workspaceId: string) => String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
const say = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });

describe("hand off a task from an AI tool and move on (US1)", () => {
  it("lists projects, starts, reads, continues and opens a PR, with every action audited", async () => {
    const harness = await createDeveloperTaskBroker();
    const { tool, expectNoTokenLeaked } = await signedInClient(harness, MAYA);

    expect((await tool("agentx_list_projects")).value).toMatchObject({ projects: [{ name: "payments", tasks_enabled: true }] });

    const started = await tool("agentx_start_task", { project: "payments", instructions: "Fix the flaky retry test in payments-api" });
    expect(started.value).toMatchObject({ status: "STARTING", client: "Claude Code" });
    const taskId = String(started.value.task_id);
    const workspaceId = workspaceOf(harness, taskId);

    await harness.finish(workspaceId, activeOf(harness, workspaceId), "SUCCEEDED");
    const operation = activeOf(harness, workspaceId);
    const outbox = harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operation)[0];
    expect((outbox?.invocation as { payload: { prompt: string } }).payload.prompt).toBe("Fix the flaky retry test in payments-api");
    await harness.events(workspaceId, operation, [say("Fixed the retry test; 212 tests pass.")]);
    await harness.finish(workspaceId, operation, "SUCCEEDED");
    expect((await tool("agentx_get_task", { task_id: taskId })).value).toMatchObject({ status: "SUCCEEDED", summary: "Fixed the retry test; 212 tests pass." });

    expect((await tool("agentx_continue_task", { task_id: taskId, instructions: "Add a test for the timeout path." })).value).toMatchObject({ status: "RUNNING" });
    await harness.finish(workspaceId, activeOf(harness, workspaceId), "SUCCEEDED");

    const pr = await tool("agentx_open_pull_request", { task_id: taskId, title: "Fix the flaky retry test" });
    expect(pr.value).toMatchObject({ operation_status: "ACCEPTED", task: { task_id: taskId } });
    expect(pr.value).not.toHaveProperty("timed_out");
    const publication = harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${String(pr.value.operation_id)}`) as { publication: { body: string; draft: boolean } };
    expect(publication.publication).toMatchObject({ draft: true, body: "Requested by `Maya Chen` via AgentX, started from Claude Code" });

    const turns = harness.db.find((item) => item.pk === `TASK#${taskId}`).map((item) => `${String(item.action)}:${String(item.phase)}`).sort();
    expect(turns).toEqual(["continue:accepted", "continue:completed", "pull_request:accepted", "start:accepted", "start:completed"]);
    expect((await tool("agentx_list_tasks")).value).toMatchObject({ tasks: [{ task_id: taskId }] });
    expectNoTokenLeaked();
  });

  it("tells another developer the task was not found (US1 scenario 6)", async () => {
    const harness = await createDeveloperTaskBroker();
    const maya = await signedInClient(harness, MAYA);
    const taskId = String((await maya.tool("agentx_start_task", { project: "payments", instructions: "x" })).value.task_id);
    const omar = await signedInClient(harness, OMAR);
    expect(await omar.tool("agentx_get_task", { task_id: taskId })).toMatchObject({ isError: true, error: { code: "TASK_NOT_FOUND" } });
    omar.expectNoTokenLeaked();
  });

  it("gives PROJECT_NOT_FOUND and PROJECT_ACCESS_DENIED their own codes (US1 scenario 7)", async () => {
    const harness = await createDeveloperTaskBroker();
    const omar = await signedInClient(harness, OMAR);
    expect((await omar.tool("agentx_start_task", { project: "nope", instructions: "x" })).error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect((await omar.tool("agentx_start_task", { project: "payments", instructions: "x" })).error).toMatchObject({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: ask an admin" });
    omar.expectNoTokenLeaked();
  });

  it("answers SIGN_IN_REQUIRED with the exact command when this computer has no sign-in", async () => {
    const harness = await createDeveloperTaskBroker();
    const { tool } = await signedInClient(harness, undefined);
    expect(await tool("agentx_list_projects")).toMatchObject({ isError: true, error: { code: "SIGN_IN_REQUIRED", next_step: `run npx @charterarc/agentx login ${URL_BASE}` } });
    // The server keeps answering after a sign-in error: it does not crash.
    expect(await tool("agentx_whoami")).toMatchObject({ isError: true, error: { code: "SIGN_IN_REQUIRED" } });
  });
});

describe("busy answers name the right next step (final review M1)", () => {
  it("tells the AI tool to try the start again with the same request_id when the start's transaction fails", async () => {
    const harness = await createDeveloperTaskBroker();
    const { tool } = await signedInClient(harness, MAYA);
    const original = harness.db.send;
    let failed = 0;
    harness.db.send = async (command) => {
      const input = JSON.stringify(command.input);
      if (failed === 0 && command.constructor.name === "TransactWriteCommand" && input.includes("DEVTASK#") && input.includes("IDEMPOTENCY")) {
        failed += 1;
        const items = (command.input as { TransactItems: unknown[] }).TransactItems;
        throw Object.assign(new Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: items.map((_, index) => ({ Code: index === items.length - 2 ? "ConditionalCheckFailed" : "None" })),
        });
      }
      return original(command);
    };
    const answer = await tool("agentx_start_task", { project: "payments", instructions: "Fix the flaky retry test" });
    expect(failed).toBe(1);
    expect(answer.error).toEqual({
      code: "TASK_BUSY",
      message: "AgentX could not start the task just now; try again with the same request_id",
      next_step: "try again with the same request_id",
    });
  });

  it("tells the AI tool to try the close again, not to wait or cancel, when a setup-failed close fails", async () => {
    const harness = await createDeveloperTaskBroker();
    const { tool } = await signedInClient(harness, MAYA);
    const taskId = String((await tool("agentx_start_task", { project: "payments", instructions: "x" })).value.task_id);
    const workspaceId = workspaceOf(harness, taskId);
    await harness.finish(workspaceId, activeOf(harness, workspaceId), "FAILED", { error: "npm ci exited 1" });
    // A task whose setup failed before #213 still holds its charge, and here the organization
    // counter lost it: not a race, not already released.
    Object.assign(harness.db.get("SLACK_LIMIT#T0BSHLLUGBD", `MEMBER#${MAYA.slackUserId}`) as Record<string, unknown>, { count: 1, tasks: new Set([taskId]) });
    (harness.db.get("SLACK_LIMIT#T0BSHLLUGBD", "ORGANIZATION") as Record<string, unknown>).count = 0;
    const answer = await tool("agentx_close_task", { task_id: taskId });
    expect(answer.error).toEqual({
      code: "TASK_BUSY",
      message: "AgentX could not close this task just now; try agentx_close_task again, and ask an admin if it keeps failing",
      next_step: "try agentx_close_task again in a moment, and ask an admin if it keeps failing",
    });
  });
});

describe("wait for a small task (US2)", () => {
  it("returns the finished task when it ends inside the wait", async () => {
    const harness = await createDeveloperTaskBroker();
    let done = false;
    const { tool } = await signedInClient(harness, MAYA, async () => {
      // The worker prepares the workspace and finishes the task while the tool waits.
      const workspaceId = harness.db.find((item) => item.entityType === "DEVELOPER_TASK")[0]?.workspaceId as string | undefined;
      if (workspaceId === undefined || done) return;
      done = true;
      await harness.finish(workspaceId, activeOf(harness, workspaceId), "SUCCEEDED");
      await harness.finish(workspaceId, activeOf(harness, workspaceId), "SUCCEEDED");
    });
    const result = await tool("agentx_start_task", { project: "payments", instructions: "run the payments test suite", wait_seconds: 60 });
    expect(result.value).toMatchObject({ timed_out: false, status: "SUCCEEDED" });
  });

  it("returns timed_out, not an error, when the task outlives the wait", async () => {
    const harness = await createDeveloperTaskBroker();
    const { tool } = await signedInClient(harness, MAYA);
    const taskId = String((await tool("agentx_start_task", { project: "payments", instructions: "long" })).value.task_id);
    const waited = await tool("agentx_wait_for_task", { task_id: taskId, wait_seconds: 5 });
    expect(waited).toMatchObject({ isError: false, value: { timed_out: true, status: "STARTING" } });
  });
});
