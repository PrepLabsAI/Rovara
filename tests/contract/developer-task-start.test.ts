// Spec 025 Task 8: POST /v1/dev/tasks, the start of a developer task (FR-017 to FR-020, R8, R9, R12).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAYA, OMAR, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, ensureWorkspace } from "../support/slack-broker.js";

const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });
const workspaces = (db: { find(predicate: (item: Record<string, unknown>) => boolean): unknown[] }) => db.find((item) => item.entityType === "WORKSPACE");
const refusals = (db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }) =>
  db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused");

describe("POST /v1/dev/tasks (FR-018)", () => {
  it("answers STARTING with a task ID and writes the task, its workspace and its audit record in one transaction", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(200);
    const task = response.body.task as { taskId: string; status: string; project: string; startingRevision: number; client: string; shared: boolean; title: string };
    expect(task).toMatchObject({ status: "STARTING", project: "payments", startingRevision: 1, client: "Claude Code", shared: false, title: "Fix the flaky retry test" });

    const record = db.get(`DEVTASK#${task.taskId}`, "META") as { workspaceId: string; ownerKey: string; conversationId: string; charge: unknown };
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK_INDEX" && item.taskId === task.taskId)).toEqual([expect.objectContaining({ pk: `DEVELOPER#${MAYA.developerId}`, status: "STARTING", shared: false })]);
    expect(db.get(`WORKSPACE#${record.workspaceId}`, "META")).toMatchObject({ ownerKey: record.ownerKey, status: "PREPARING", projectRevision: 1 });
    expect(db.get(`WORKSPACE#${record.workspaceId}`, "DEVELOPER_TASK")).toMatchObject({ taskId: task.taskId, pendingPrompt: "Fix the flaky retry test", conversationId: record.conversationId });
    expect(db.get(`WORKSPACE#${record.workspaceId}`, `CONVERSATION#${record.conversationId}`)).toMatchObject({ entityType: "CONVERSATION" });
    expect(db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === record.workspaceId).map((item) => (item.invocation as { kind: string }).kind)).toEqual(["prepare"]);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 1, tasks: new Set([task.taskId]) });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
    expect(db.find((item) => item.pk === `TASK#${task.taskId}`)).toEqual([expect.objectContaining({ origin: "ai_tool", action: "start", phase: "accepted", requestText: "Fix the flaky retry test", client: "Claude Code" })]);
  });

  it("keeps the instructions exactly as the tool wrote them (FR-019)", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const instructions = "  Fix it.\r\n\r\n```ts\nconst x = 1;\t\n```\n\u00e9\u{1f600}  ";
    const { body } = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions }));
    const record = db.get(`DEVTASK#${(body.task as { taskId: string }).taskId}`, "META") as { workspaceId: string };
    expect((db.get(`WORKSPACE#${record.workspaceId}`, "DEVELOPER_TASK") as { pendingPrompt: string }).pendingPrompt).toBe(instructions);
  });

  it("refuses instructions over 65,536 bytes even when they are under 65,536 characters (Review Focus 3)", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions: "\u20ac".repeat(21_846) }));
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(JSON.stringify(response.body)).toContain("65536");
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toHaveLength(0);
  });

  it("returns the first task for a repeated request ID, and refuses one reused with other content", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const request = start();
    const first = await dev(MAYA, "POST", "/v1/dev/tasks", request);
    const again = await dev(MAYA, "POST", "/v1/dev/tasks", request);
    expect((again.body.task as { taskId: string }).taskId).toBe((first.body.task as { taskId: string }).taskId);
    expect(workspaces(db)).toHaveLength(1);
    const reused = await dev(MAYA, "POST", "/v1/dev/tasks", { ...request, instructions: "something else" });
    expect(reused.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

describe("the start's refusals, in FR-018's order, before anything starts", () => {
  it("PROJECT_NOT_FOUND for a project that does not exist, and for a malformed name", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    for (const project of ["nope", "Not A Name!"]) {
      const response = await dev(MAYA, "POST", "/v1/dev/tasks", start({ project }));
      expect(response.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
      expect(String((response.body.error as { message: string }).message)).toContain("agentx_list_projects");
    }
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db).map((item) => (item.error as { code: string }).code)).toEqual(["PROJECT_NOT_FOUND", "PROJECT_NOT_FOUND"]);
  });

  it("PROJECT_ACCESS_DENIED names the public channel to join for a Slack member outside it", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelMembers: async () => ({ ok: true, memberOf: [] }) });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: join one of its channels (#payments-dev) or ask an admin" });
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db).map((item) => (item.error as { code: string }).code)).toEqual(["PROJECT_ACCESS_DENIED"]);
  });

  it("PROJECT_ACCESS_DENIED just says ask an admin to a developer with no Slack link", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const response = await dev(OMAR, "POST", "/v1/dev/tasks", start());
    expect(response.body.error).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: ask an admin" });
    expect(refusals(db).map((item) => (item.error as { code: string }).code)).toEqual(["PROJECT_ACCESS_DENIED"]);
  });

  it("SLACK_UNAVAILABLE when only a channel could give access and Slack cannot be reached", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelMembers: async () => ({ ok: false, error: "slack_unavailable" }) });
    expect((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body.error).toMatchObject({ code: "SLACK_UNAVAILABLE" });
    expect(refusals(db).map((item) => (item.error as { code: string }).code)).toEqual(["SLACK_UNAVAILABLE"]);
  });

  it("PROJECT_TASKS_DISABLED when the latest revision turns tasks off", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker();
    await registerRevision(handler, 2, { enabled: false });
    expect((await dev(MAYA, "POST", "/v1/dev/tasks", start())).body.error).toMatchObject({ code: "PROJECT_TASKS_DISABLED" });
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db).map((item) => (item.error as { code: string }).code)).toEqual(["PROJECT_TASKS_DISABLED"]);
  });

  it("CHANNEL_REQUIRED, not yet available, for a start that asks to share or a project that requires it (R9)", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker();
    const asked = await dev(MAYA, "POST", "/v1/dev/tasks", start({ shareToChannel: true, shareMode: "view" }));
    expect(asked.body.error).toMatchObject({ code: "CHANNEL_REQUIRED" });
    expect(String((asked.body.error as { message: string }).message)).toContain("not available yet");
    await registerRevision(handler, 2, { share: "required" });
    const required = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(required.body.error).toMatchObject({ code: "CHANNEL_REQUIRED" });
    expect(String((required.body.error as { message: string }).message)).toContain("requires");
    expect(workspaces(db)).toHaveLength(0);
  });

  it("WORKSPACE_LIMIT counts the developer's Slack threads, lists open tasks, and starts nothing", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker({ memberLimit: 2 });
    const first = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions: "First task" }));
    expect(first.status).toBe(200);
    expect((await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`, MAYA.slackUserId!)).body.created).toBe(true);
    const refused = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(refused.body.error).toMatchObject({ code: "WORKSPACE_LIMIT" });
    const message = String((refused.body.error as { message: string }).message);
    expect(message).toContain("limit of 2");
    expect(message).toContain((first.body.task as { taskId: string }).taskId);
    expect(message).toContain("First task");
    expect(workspaces(db)).toHaveLength(2);
  });
});

describe("developers without a Slack link (FR-020, R6)", () => {
  it("can use a granted project, on their own member counter", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    db.set({ pk: `MEMBER#${OMAR.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "payments", role: "developer" });
    const response = await dev(OMAR, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(200);
    expect(db.get(`DEVELOPER_LIMIT#${OMAR.developerId}`, "MEMBER")).toMatchObject({ count: 1 });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 1 });
  });

  it("counts on the developer organization counter when the environment has no Slack team ID", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ slackTeamId: null });
    db.set({ pk: `MEMBER#${OMAR.developerId}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: OMAR.developerId, projectName: "payments", role: "developer" });
    expect((await dev(OMAR, "POST", "/v1/dev/tasks", start())).status).toBe(200);
    expect(db.get("DEVELOPER_LIMIT#ORGANIZATION", "ORGANIZATION")).toMatchObject({ count: 1 });
  });
});

interface SentCommand { constructor: { name: string }; input: Record<string, unknown> }
type Send = (command: SentCommand) => Promise<unknown>;
/** Wraps the fake table's send; `around` sees each command and the original send. */
function intercept(db: { send: Send }, around: (command: SentCommand, original: Send) => Promise<unknown>): SentCommand[] {
  const sent: SentCommand[] = [];
  const original = db.send;
  db.send = async (command) => {
    sent.push(command);
    return around(command, original);
  };
  return sent;
}
const isTransaction = (command: SentCommand) => command.constructor.name === "TransactWriteCommand";
const FAKE_SECRET = `ghp_${"F".repeat(36)}`;

describe("the start's audit records (R12)", () => {
  it("puts each phase as its own row, never an update, and redacts the instructions only in the record", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ memberLimit: 1 });
    const sent = intercept(db, (command, original) => original(command));
    const instructions = `Use the token ${FAKE_SECRET} to fix the retry test`;
    const accepted = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions }));
    expect(accepted.status).toBe(200);
    const refused = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions, project: "nope" }));
    expect(refused.body.error).toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // The title comes from the first line of the instructions, so it is redacted wherever it goes.
    expect(JSON.stringify(accepted.body)).not.toContain(FAKE_SECRET);
    expect((accepted.body.task as { title: string }).title).toContain("[REDACTED]");
    const limited = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions: "Another task" }));
    expect(limited.body.error).toMatchObject({ code: "WORKSPACE_LIMIT" });
    const limitText = String((limited.body.error as { message: string }).message);
    expect(limitText).toContain((accepted.body.task as { taskId: string }).taskId);
    expect(limitText).not.toContain(FAKE_SECRET);

    const taskId = (accepted.body.task as { taskId: string }).taskId;
    const record = db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    // FR-019: the worker gets the instructions byte for byte.
    expect((db.get(`WORKSPACE#${record.workspaceId}`, "DEVELOPER_TASK") as { pendingPrompt: string }).pendingPrompt).toBe(instructions);
    expect(JSON.stringify(record)).not.toContain(FAKE_SECRET);
    const index = db.find((item) => item.entityType === "DEVELOPER_TASK_INDEX" && item.taskId === taskId);
    expect(index).toHaveLength(1);
    expect(JSON.stringify(index)).not.toContain(FAKE_SECRET);
    const turns = db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#"));
    expect(turns.map((item) => item.phase).sort()).toEqual(["accepted", "refused", "refused"]);
    expect(new Set(turns.map((item) => item.turnId)).size).toBe(3);
    expect(JSON.stringify(turns)).not.toContain(FAKE_SECRET);
    expect(turns.filter((item) => String(item.requestText).includes("[REDACTED]"))).toHaveLength(2);
    // Only Puts reach TurnRecords: the accepted row in the start's transaction, the refused row alone.
    const turnWrites = sent.flatMap((command) => (isTransaction(command)
      ? (command.input.TransactItems as Array<Record<string, { TableName?: string }>>).flatMap((entry) => Object.entries(entry).map(([kind, item]) => ({ kind, table: item.TableName })))
      : [{ kind: command.constructor.name.replace("Command", ""), table: command.input.TableName as string | undefined }]))
      .filter((write) => write.table === "turns");
    expect(turnWrites).toEqual([{ kind: "Put", table: "turns" }, { kind: "Put", table: "turns" }, { kind: "Put", table: "turns" }]);
    expect(sent.filter((command) => isTransaction(command) && JSON.stringify(command.input).includes('"turns"'))).toHaveLength(1);
  });

  it("redacts a title the tool gave, and caps a redacted first line at 120 characters without splitting an emoji", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const given = await dev(MAYA, "POST", "/v1/dev/tasks", start({ title: `Deploy with ${FAKE_SECRET}` }));
    expect((given.body.task as { title: string }).title).toBe("Deploy with [REDACTED]");
    const long = await dev(MAYA, "POST", "/v1/dev/tasks", start({ instructions: `${FAKE_SECRET} ${"\u{1f600}".repeat(200)}\nthe rest` }));
    const title = (long.body.task as { title: string }).title;
    expect(title.startsWith("[REDACTED] ")).toBe(true);
    expect(Array.from(title)).toHaveLength(120);
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(JSON.stringify(db.find((item) => item.entityType === "DEVELOPER_TASK" || item.entityType === "DEVELOPER_TASK_INDEX"))).not.toContain(FAKE_SECRET);
  });

  it("writes the refused record for a refusal after the checks, with its error code and no workspace", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker();
    await registerRevision(handler, 2, { share: "required" });
    await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toEqual([expect.objectContaining({ origin: "ai_tool", action: "start", outcome: "refused", error: { code: "CHANNEL_REQUIRED" }, requestText: "Fix the flaky retry test" })]);
  });

  it("answers a malformed body CONFIG_INVALID by field name, and writes nothing", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", { ...start(), unexpected: FAKE_SECRET });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(JSON.stringify(response.body)).not.toContain(FAKE_SECRET);
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toHaveLength(0);
  });
});

describe("the start's transaction and the workspace limit (FR-020, R6)", () => {
  it("turns a counter that filled after the check into WORKSPACE_LIMIT, with a refused record and nothing started", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ memberLimit: 1 });
    let raced = false;
    intercept(db, async (command, original) => {
      if (isTransaction(command) && !raced) {
        raced = true;
        // Another Slack thread takes the member's last slot between the check and the transaction.
        db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: `MEMBER#${MAYA.slackUserId}`, entityType: "SLACK_LIMIT", count: 1, threads: ["elsewhere"] });
      }
      return original(command);
    });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: "WORKSPACE_LIMIT" });
    expect(String((response.body.error as { message: string }).message)).toContain("limit of 1");
    expect(workspaces(db)).toHaveLength(0);
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK" || item.entityType === "IDEMPOTENCY")).toHaveLength(0);
    expect(refusals(db).map((item) => (item.error as { code: string }).code)).toEqual(["WORKSPACE_LIMIT"]);
  });

  it("turns the organization counter filling after the check into the organization's WORKSPACE_LIMIT", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ organizationLimit: 1 });
    let raced = false;
    intercept(db, async (command, original) => {
      if (isTransaction(command) && !raced) {
        raced = true;
        db.set({ pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION", entityType: "SLACK_LIMIT", count: 1 });
      }
      return original(command);
    });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.body.error).toMatchObject({ code: "WORKSPACE_LIMIT" });
    expect(String((response.body.error as { message: string }).message)).toContain("this AgentX has reached its limit of 1");
    expect(workspaces(db)).toHaveLength(0);
  });

  it("answers the task when its own transaction committed but the answer was lost (already charged)", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    intercept(db, async (command, original) => {
      if (!isTransaction(command) || !JSON.stringify(command.input).includes('"turns"')) return original(command);
      await original(command);
      // The SDK's retry of a committed transaction: every new-item condition now fails.
      return original(command);
    });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(200);
    const taskId = (response.body.task as { taskId: string }).taskId;
    expect(db.get(`DEVTASK#${taskId}`, "META")).toBeDefined();
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 1, tasks: new Set([taskId]) });
    expect(workspaces(db)).toHaveLength(1);
    expect(refusals(db)).toHaveLength(0);
  });

  it("answers the first task to a concurrent start with the same request ID", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const request = start();
    let first: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    intercept(db, async (command, original) => {
      if (isTransaction(command) && first === undefined) {
        // The same request, sent again, commits first.
        first = dev(MAYA, "POST", "/v1/dev/tasks", request);
        await first;
      }
      return original(command);
    });
    const second = await dev(MAYA, "POST", "/v1/dev/tasks", request);
    const winner = await first!;
    expect(second.status).toBe(200);
    expect((second.body.task as { taskId: string }).taskId).toBe((winner.body.task as { taskId: string }).taskId);
    expect(workspaces(db)).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 1 });
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(1);
    expect(db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "accepted")).toHaveLength(1);
  });

  it("answers IDEMPOTENCY_CONFLICT to a concurrent start that reuses the request ID with other content", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    const request = start();
    let first: Promise<{ status: number; body: Record<string, unknown> }> | undefined;
    intercept(db, async (command, original) => {
      if (isTransaction(command) && first === undefined) {
        // Another start with the same request ID and other instructions commits first.
        first = dev(MAYA, "POST", "/v1/dev/tasks", { ...request, instructions: "Something else entirely" });
        await first;
      }
      return original(command);
    });
    const second = await dev(MAYA, "POST", "/v1/dev/tasks", request);
    expect((await first!).status).toBe(200);
    expect(second.body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(workspaces(db)).toHaveLength(1);
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 1 });
  });

  it("answers WORKSPACE_BUSY, and records and charges nothing, when a revision is registered between the access check and the start", async () => {
    const { db, handler, dev } = await createDeveloperTaskBroker();
    let raced = false;
    intercept(db, async (command, original) => {
      const values = command.input.ExpressionAttributeValues as Record<string, unknown> | undefined;
      // latestProject's read (the access check's read projects only the policy).
      if (!raced && command.constructor.name === "QueryCommand" && values?.[":pk"] === "PROJECT#payments" && command.input.ProjectionExpression === undefined) {
        raced = true;
        await registerRevision(handler, 2, { enabled: false });
      }
      return original(command);
    });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(raced).toBe(true);
    expect(response.body.error).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(String((response.body.error as { message: string }).message)).toContain("the project changed while starting; try again");
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db)).toHaveLength(0);
    expect(db.find((item) => item.entityType === "DEVELOPER_TASK")).toHaveLength(0);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toBeUndefined();
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toBeUndefined();
  });

  it("answers WORKSPACE_BUSY, asking for the same request ID, when another write conflicts", async () => {
    const { db, dev } = await createDeveloperTaskBroker();
    intercept(db, async (command, original) => {
      if (isTransaction(command)) throw Object.assign(new Error("conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "TransactionConflict" }] });
      return original(command);
    });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.body.error).toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(String((response.body.error as { message: string }).message)).toContain("same request_id");
    expect(workspaces(db)).toHaveLength(0);
  });
});

describe("shared broker helpers (ruling F9)", () => {
  it("defines hashJson and isConditional once, in the module broker.ts and developer-tasks.ts both import", () => {
    const source = (file: string) => readFileSync(new URL(`../../packages/broker/src/aws/${file}`, import.meta.url), "utf8");
    for (const file of ["broker.ts", "developer-tasks.ts"]) {
      expect(source(file)).not.toMatch(/(?:function|const)\s+(?:hashJson|isConditional)\b/);
      expect(source(file)).toMatch(/import \{[^}]*\bhashJson\b[^}]*\bisConditional\b[^}]*\} from "\.\/broker-shared\.js"/);
    }
    expect(source("broker-shared.ts")).toMatch(/export function hashJson/);
    expect(source("broker-shared.ts")).toMatch(/export function isConditional/);
  });
});

/** Registers revision `revision` of payments with the given developerTasks, as an administrator. */
async function registerRevision(handler: Parameters<typeof call>[0], revision: number, developerTasks: Record<string, unknown>) {
  const response = await call(handler, {
    method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true },
    body: {
      definition: {
        name: "payments", revision,
        repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
        setup: [], readiness: [], orchestratorInstructions: "Delegate work.", developerTasks,
      },
      runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" },
    },
  });
  if (response.status !== 201) throw new Error(`registration failed: ${JSON.stringify(response.body)}`);
}
