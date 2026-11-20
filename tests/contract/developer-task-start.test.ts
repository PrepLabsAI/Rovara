// Spec 025 Task 8: POST /v1/dev/tasks, the start of a developer task (FR-017 to FR-020, R8, R9, R12).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker, registerRevision } from "../support/developer-task-broker.js";
import { SLACK_TEAM } from "../support/slack-broker.js";

const start = (overrides: Record<string, unknown> = {}) => ({ requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code", ...overrides });
const workspaces = (db: { find(predicate: (item: Record<string, unknown>) => boolean): unknown[] }) => db.find((item) => item.entityType === "WORKSPACE");
const refusals = (db: { find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }) =>
  db.find((item) => typeof item.pk === "string" && item.pk.startsWith("TASK#") && item.phase === "refused");

describe("POST /v1/dev/tasks (FR-018)", () => {

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

  it("PROJECT_ACCESS_DENIED names the public channel to join for a Slack member outside it", async () => {
    const { db, dev } = await createDeveloperTaskBroker({ channelMembers: async () => ({ ok: true, memberOf: [] }) });
    const response = await dev(MAYA, "POST", "/v1/dev/tasks", start());
    expect(response.status).toBe(403);
    expect(response.body.error).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments`: join one of its channels (#payments-dev) or ask an admin" });
    expect(workspaces(db)).toHaveLength(0);
    expect(refusals(db).map((item) => (item.error as { code: string }).code)).toEqual(["PROJECT_ACCESS_DENIED"]);
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


it("audits a company project-access workspace refusal with fixed 503 words", async () => {
  const h = await createDeveloperTaskBroker({ developerExtra: { companies: { companyOf: async () => "org_aaaaaaaaaaaaaaaaaaaa" } } });
  const response = await h.dev(MAYA, "POST", "/v1/dev/tasks", start());
  expect(response.status).toBe(503);
  expect(response.body.error).toEqual({ code: "SLACK_UNAVAILABLE", message: "This Slack workspace is not available." });
  expect(refusals(h.db)).toEqual([expect.objectContaining({ error: { code: "SLACK_UNAVAILABLE" }, phase: "refused" })]);
  expect(workspaces(h.db)).toHaveLength(0);
});
