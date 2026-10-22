import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, type E2EModelDayBudgetRequest } from "@agentx/contracts";
import { handleE2EModelBudgetCallback, type E2EModelBudgetDependencies, type E2EModelBudgetOperation } from "../../packages/broker/src/e2e/model-budget-endpoint.js";
import { e2eModelBudgetKey, e2eModelBudgetReservationKey, isTransientAwsFault } from "../../packages/broker/src/e2e/model-route-registry.js";
import { issueCapability } from "../../packages/broker/src/aws/cancellation.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { startApplicationRound } from "../support/e2e-application-round-harness.js";
import { call } from "../support/slack-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

// Task 4.3a, test case 7 (Ruling DB-8): the worker's callback for the project's day budget.

afterEach(disposeRealCandidates);

const TABLE = "state";
const NOW = Date.parse("2026-10-21T10:00:00.000Z");
const TASK = "11111111-aaaa-4bbb-8ccc-111111111111";
const GROUP = "22222222-aaaa-4bbb-8ccc-222222222222";
const OTHER_GROUP = "33333333-aaaa-4bbb-8ccc-333333333333";
const DAY = "2026-10-21";
const CAPS = { tokens: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxInputTokensPerProjectDay, calls: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxCallsPerProjectDay };

function fixture(overrides: { operation?: Partial<E2EModelBudgetOperation>; task?: Record<string, unknown> | null } = {}) {
  const db = new FakeDynamoDb();
  if (overrides.task !== null) db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", workspaceId: "ws-1", project: "payments", ...overrides.task });
  const operation: E2EModelBudgetOperation = { id: "op-1", workspaceId: "ws-1", kind: "task", workflowMode: "CHECKS", status: "RUNNING",
    workflowE2EAdmission: { taskId: TASK, groupRunIds: [GROUP], agentSteps: true }, ...overrides.operation };
  const dependencies: E2EModelBudgetDependencies = { documentClient: { send: db.send }, tableName: TABLE, now: () => NOW };
  const call = (body: unknown, as: E2EModelBudgetOperation = operation) => handleE2EModelBudgetCallback(dependencies, as, body);
  return { db, operation, dependencies, call };
}
const base = (reservationId: string) => ({ schemaVersion: "rovara-e2e-model-budget/v1", reservationId });
const reserveBody = (reservationId: string, inputTokens = 4_000, groupRunId = GROUP): E2EModelDayBudgetRequest => ({ ...base(reservationId), stage: "reserve", groupRunId, inputTokens }) as E2EModelDayBudgetRequest;
const settleBody = (reservationId: string, actualInputTokens: number): E2EModelDayBudgetRequest => ({ ...base(reservationId), stage: "settle", actualInputTokens }) as E2EModelDayBudgetRequest;
const releaseBody = (reservationId: string): E2EModelDayBudgetRequest => ({ ...base(reservationId), stage: "release" }) as E2EModelDayBudgetRequest;
const dayRow = (db: FakeDynamoDb) => db.get("PROJECT#payments", `E2E_MODEL_BUDGET#${DAY}`);
const reservationRow = (db: FakeDynamoDb, id: string) => db.get("PROJECT#payments", `E2E_MODEL_BUDGET_RESERVATION#${id}`);
const forbidden = { code: "CALLBACK_FORBIDDEN" };

describe("reserve", () => {
  it("writes one reservation row and moves the day's tokens and calls, in one step", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    expect(await call(reserveBody(id))).toEqual({ schemaVersion: "rovara-e2e-model-budget/v1", reservationId: id, status: "reserved" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 4_000, calls: 1 });
    expect(reservationRow(db, id)).toMatchObject({ entityType: "E2E_MODEL_BUDGET_RESERVATION", status: "open", day: DAY, reservedInputTokens: 4_000, groupRunId: GROUP, operationId: "op-1" });
    expect(e2eModelBudgetReservationKey("payments", id)).toEqual({ pk: "PROJECT#payments", sk: `E2E_MODEL_BUDGET_RESERVATION#${id}` });
    expect(db.commandNames().filter((name) => name === "TransactWriteCommand")).toHaveLength(1);
  });

  it("gives every row a time to live (indexExpiresAt), the reservation and the day's", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    await call(reserveBody(id));
    for (const row of [reservationRow(db, id), dayRow(db)]) {
      expect(typeof row!.indexExpiresAt).toBe("number");
      expect(row!.indexExpiresAt as number).toBeGreaterThan(Math.floor(NOW / 1000));
    }
  });

  it("takes the project from the operation's task, never from the body: the body has no place for one, and every row lands in the task's project", async () => {
    const { db, call, operation } = fixture();
    await expect(call({ ...reserveBody(randomUUID()), project: "billing" })).rejects.toThrow();
    await expect(call({ ...reserveBody(randomUUID()), day: "2020-01-01" })).rejects.toThrow();
    await expect(call({ ...reserveBody(randomUUID()), maxInputTokens: 1_000_000_000 })).rejects.toThrow();
    const id = randomUUID();
    await call(reserveBody(id), operation);
    expect(db.find((item) => String(item.pk).startsWith("PROJECT#")).every((item) => item.pk === "PROJECT#payments")).toBe(true);
    // Another project's task writes to its own partition.
    const other = fixture({ task: { project: "billing" } });
    await other.call(reserveBody(id));
    expect(other.db.get("PROJECT#billing", `E2E_MODEL_BUDGET#${DAY}`)).toMatchObject({ calls: 1 });
    expect(other.db.get("PROJECT#payments", `E2E_MODEL_BUDGET#${DAY}`)).toBeUndefined();
  });

  it("a repeated reserve (a redelivery) returns the stored status and does not charge twice; the same id for another request is refused", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    await call(reserveBody(id));
    expect(await call(reserveBody(id))).toMatchObject({ reservationId: id, status: "reserved" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 4_000, calls: 1 });
    await call(settleBody(id, 3_000));
    expect(await call(reserveBody(id))).toMatchObject({ status: "settled" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 3_000, calls: 1 });
    await expect(call(reserveBody(id, 5_000))).rejects.toMatchObject(forbidden);
    await expect(call(reserveBody(id, 4_000, GROUP), { ...fixture().operation, id: "op-2" })).rejects.toMatchObject(forbidden);
  });

  it("over the day's token cap or call cap it answers exhausted and writes no row", async () => {
    const { db, call } = fixture();
    db.set({ pk: "PROJECT#payments", sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: CAPS.tokens - 3_999, calls: 10 });
    const tokens = randomUUID();
    expect(await call(reserveBody(tokens, 4_000))).toMatchObject({ status: "exhausted" });
    expect(reservationRow(db, tokens)).toBeUndefined();
    expect(dayRow(db)).toMatchObject({ inputTokens: CAPS.tokens - 3_999, calls: 10 });
    // Exactly the room left is reserved (the boundary).
    const fits = randomUUID();
    expect(await call(reserveBody(fits, 3_999))).toMatchObject({ status: "reserved" });
    db.set({ pk: "PROJECT#payments", sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: 100, calls: CAPS.calls });
    const calls = randomUUID();
    expect(await call(reserveBody(calls, 1_000))).toMatchObject({ status: "exhausted" });
    expect(reservationRow(db, calls)).toBeUndefined();
    expect(dayRow(db)).toMatchObject({ inputTokens: 100, calls: CAPS.calls });
  });

  it("uses the day caps of the route it derives, not any limit the worker could send", async () => {
    const { db, dependencies, operation } = fixture();
    // A caller that names its own limits is refused by the schema; the caps are the broker's.
    await expect(handleE2EModelBudgetCallback(dependencies, operation, { ...reserveBody(randomUUID()), limits: { maxInputTokens: 10 } })).rejects.toThrow();
    const withInstallation = { ...dependencies, e2eAgentInstallation: async () => ({ provider: "amazon-bedrock", region: "us-east-1" }) };
    db.set({ pk: "PROJECT#payments", sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: CAPS.tokens, calls: 1 });
    expect(await handleE2EModelBudgetCallback(withInstallation, operation, reserveBody(randomUUID(), 1))).toMatchObject({ status: "exhausted" });
  });

  it("two racing reserves never pass the cap together", async () => {
    const { db, call } = fixture();
    db.set({ pk: "PROJECT#payments", sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: CAPS.tokens - 10_000, calls: 0 });
    const results = await Promise.all(Array.from({ length: 5 }, () => call(reserveBody(randomUUID(), 4_000))));
    expect(results.filter((result) => result.status === "reserved")).toHaveLength(2);
    expect(dayRow(db)).toMatchObject({ inputTokens: CAPS.tokens - 2_000, calls: 2 });
  });
});

describe("settle and release", () => {
  it("settle corrects the day to what was charged, once: a second settle of the same id is a no-op and does not adjust twice", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    await call(reserveBody(id, 4_000));
    expect(await call(settleBody(id, 900))).toMatchObject({ status: "settled" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 900, calls: 1 });
    expect(reservationRow(db, id)).toMatchObject({ status: "settled", settledInputTokens: 900 });
    expect(await call(settleBody(id, 900))).toMatchObject({ status: "settled" });
    expect(await call(settleBody(id, 50_000))).toMatchObject({ status: "settled" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 900, calls: 1 });
  });

  it("settles an overrun in full (the call was billed), bounded at 64000 by the schema", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    await call(reserveBody(id, 4_000));
    await call(settleBody(id, 64_000));
    expect(dayRow(db)).toMatchObject({ inputTokens: 64_000 });
    await expect(call(settleBody(randomUUID(), 64_001))).rejects.toThrow();
  });

  it("release gives back the tokens and the call, once; a repeat is a no-op", async () => {
    const { db, call } = fixture();
    const kept = randomUUID();
    const gone = randomUUID();
    await call(reserveBody(kept, 1_000));
    await call(reserveBody(gone, 4_000));
    expect(await call(releaseBody(gone))).toMatchObject({ status: "released" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 1_000, calls: 1 });
    expect(await call(releaseBody(gone))).toMatchObject({ status: "released" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 1_000, calls: 1 });
    expect(reservationRow(db, gone)).toMatchObject({ status: "released" });
  });

  it("a release after a settle is refused, and so is a settle after a release; the day is left as the first one made it", async () => {
    const { db, call } = fixture();
    const settled = randomUUID();
    const released = randomUUID();
    await call(reserveBody(settled, 4_000));
    await call(settleBody(settled, 2_000));
    await expect(call(releaseBody(settled))).rejects.toMatchObject(forbidden);
    await call(reserveBody(released, 1_000));
    await call(releaseBody(released));
    await expect(call(settleBody(released, 500))).rejects.toMatchObject(forbidden);
    expect(dayRow(db)).toMatchObject({ inputTokens: 2_000, calls: 1 });
  });

  it("settles the day the reservation was made on, even if the settle comes after midnight", async () => {
    const { db, call, dependencies, operation } = fixture();
    const id = randomUUID();
    await call(reserveBody(id, 4_000));
    const tomorrow = { ...dependencies, now: () => Date.parse("2026-10-22T00:00:05.000Z") };
    await handleE2EModelBudgetCallback(tomorrow, operation, settleBody(id, 1_000));
    expect(dayRow(db)).toMatchObject({ inputTokens: 1_000, calls: 1 });
    expect(db.get("PROJECT#payments", "E2E_MODEL_BUDGET#2026-10-22")).toBeUndefined();
  });

  it("refuses a reservation that does not exist, or that another operation made", async () => {
    const { db, call, operation } = fixture();
    await expect(call(settleBody(randomUUID(), 100))).rejects.toMatchObject(forbidden);
    await expect(call(releaseBody(randomUUID()))).rejects.toMatchObject(forbidden);
    const id = randomUUID();
    await call(reserveBody(id, 4_000));
    await expect(call(settleBody(id, 100), { ...operation, id: "op-other" })).rejects.toMatchObject(forbidden);
    expect(dayRow(db)).toMatchObject({ inputTokens: 4_000 });
  });

  it("never lets a counter go below zero: a correction the day cannot take is refused and the reservation stays open", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    await call(reserveBody(id, 4_000));
    db.set({ pk: "PROJECT#payments", sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: 100, calls: 1 });
    await expect(call(releaseBody(id))).rejects.toMatchObject(forbidden);
    expect(reservationRow(db, id)).toMatchObject({ status: "open" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 100, calls: 1 });
  });
});

describe("who may call it", () => {
  it.each<[string, Partial<E2EModelBudgetOperation>]>([
    ["an operation whose admission reference has no agentSteps", { workflowE2EAdmission: { taskId: TASK, groupRunIds: [GROUP] } }],
    ["a baseline round, even one that says agentSteps", { workflowE2EAdmission: { taskId: TASK, groupRunIds: [GROUP], agentSteps: true, purpose: "baseline" } }],
    ["an operation with no admission", { workflowE2EAdmission: undefined }],
    ["an operation that is not running", { status: "SUCCEEDED" }],
    ["an operation that is not a CHECKS task", { workflowMode: "IMPLEMENT" }],
    ["a task operation of another kind", { kind: "publish" }],
  ])("refuses %s with CALLBACK_FORBIDDEN, and writes nothing", async (_what, overrides) => {
    const { db, call, operation } = fixture();
    await expect(call(reserveBody(randomUUID()), { ...operation, ...overrides })).rejects.toMatchObject(forbidden);
    expect(db.find((item) => String(item.pk).startsWith("PROJECT#"))).toEqual([]);
  });

  it("refuses a reservation for a group run the operation's admission does not list", async () => {
    const { db, call } = fixture();
    await expect(call(reserveBody(randomUUID(), 1_000, OTHER_GROUP))).rejects.toMatchObject(forbidden);
    expect(db.find((item) => String(item.pk).startsWith("PROJECT#"))).toEqual([]);
  });

  it("refuses an operation whose task is missing, in another workspace, or closed", async () => {
    for (const task of [null, { workspaceId: "ws-other" }, { closedAt: "2026-10-21T00:00:00.000Z" }, { project: "" }]) {
      const { call } = fixture({ task });
      await expect(call(reserveBody(randomUUID())), JSON.stringify(task)).rejects.toMatchObject(forbidden);
    }
  });

  it("rethrows a DynamoDB fault that a later attempt can get past, and writes nothing", async () => {
    const { db, call } = fixture();
    db.injectFault({ command: "TransactWriteCommand", error: { name: "ProvisionedThroughputExceededException" } });
    const error = await call(reserveBody(randomUUID())).catch((caught: unknown) => caught);
    expect(isTransientAwsFault(error)).toBe(true);
    expect(db.find((item) => String(item.pk).startsWith("PROJECT#"))).toEqual([]);
    const id = randomUUID();
    await call(reserveBody(id));
    db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    expect(isTransientAwsFault(await call(settleBody(id, 100)).catch((caught: unknown) => caught))).toBe(true);
    expect(reservationRow(db, id)).toMatchObject({ status: "open" });
    expect(await call(settleBody(id, 100))).toMatchObject({ status: "settled" });
  });

  it("a conflicting transaction is a fault to retry, not an answer about the budget", async () => {
    const { db, call } = fixture();
    db.injectFault({ command: "TransactWriteCommand", error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }] } });
    await expect(call(reserveBody(randomUUID()))).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(e2eModelBudgetKey("payments", DAY).sk).toBe("E2E_MODEL_BUDGET#2026-10-21");
  });
});

describe("through the broker's callback route", () => {
  const route = (round: Awaited<ReturnType<typeof startApplicationRound>>, operationId: string, capability: string, body: unknown) => call(round.harness.handler, { method: "POST",
    path: `/v1/internal/workspaces/${round.workspaceId}/operations/${operationId}/e2e-model-budget`, headers: { "x-agentx-callback-capability": capability }, body });

  it("a claim without e2e-model-budget gets CALLBACK_FORBIDDEN: the capability a round with no AI navigation step is issued does not carry it", async () => {
    const round = await startApplicationRound();
    round.markRunning();
    const response = await route(round, round.operationId, round.capabilityFor(round.operationId), reserveBody(randomUUID(), 1_000, round.admissionRef.groupRunIds[0]));
    expect(response.body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(JSON.stringify(response.body)).toMatch(/does not allow e2e-model-budget/);
    expect(round.harness.db.find((item) => String(item.sk).startsWith("E2E_MODEL_BUDGET"))).toEqual([]);
  });

  it("with the claim, but an admission reference without agentSteps, it is still CALLBACK_FORBIDDEN", async () => {
    const round = await startApplicationRound();
    round.markRunning();
    const key = (round.harness.brokerInput as { callbackSigningKey: string });
    const operation = round.operationNow() as { fence: number };
    const capability = issueCapability(key, round.workspaceId, round.operationId, operation.fence, false, false, false, false, false, true, true);
    const response = await route(round, round.operationId, capability, reserveBody(randomUUID(), 1_000, round.admissionRef.groupRunIds[0]));
    expect(response.body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
    expect(JSON.stringify(response.body)).toMatch(/AI navigation steps/);
    expect(round.harness.db.find((item) => String(item.sk).startsWith("E2E_MODEL_BUDGET"))).toEqual([]);
  });

  it("with the claim and an admission reference that says agentSteps, it reserves, settles and releases for the task's project", async () => {
    const round = await startApplicationRound();
    round.markRunning();
    const operation = round.operationNow() as Record<string, unknown> & { fence: number; workflowE2EAdmission: Record<string, unknown> };
    round.harness.db.set({ ...operation, pk: `WORKSPACE#${round.workspaceId}`, sk: `OPERATION#${round.operationId}`, workflowE2EAdmission: { ...operation.workflowE2EAdmission, agentSteps: true } });
    const capability = issueCapability(round.harness.brokerInput as { callbackSigningKey: string }, round.workspaceId, round.operationId, operation.fence, false, false, false, false, false, true, true);
    const group = round.admissionRef.groupRunIds[0]!;
    const id = randomUUID();
    const reserved = await route(round, round.operationId, capability, reserveBody(id, 2_000, group));
    expect(reserved.status, JSON.stringify(reserved.body)).toBe(200);
    expect(reserved.body).toMatchObject({ schemaVersion: "rovara-e2e-model-budget/v1", reservationId: id, status: "reserved" });
    const reservation = round.harness.db.find((item) => item.sk === `E2E_MODEL_BUDGET_RESERVATION#${id}`)[0]!;
    expect(reservation).toMatchObject({ pk: "PROJECT#payments", status: "open", operationId: round.operationId, groupRunId: group });
    expect((await route(round, round.operationId, capability, settleBody(id, 1_500))).body).toMatchObject({ status: "settled" });
    expect(round.harness.db.find((item) => String(item.sk).startsWith("E2E_MODEL_BUDGET#"))[0]).toMatchObject({ inputTokens: 1_500, calls: 1 });
    // A group run the reference does not list is forbidden through the route too.
    expect((await route(round, round.operationId, capability, reserveBody(randomUUID(), 1_000, OTHER_GROUP))).body).toMatchObject({ error: { code: "CALLBACK_FORBIDDEN" } });
  });
});
