import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { E2E_MODEL_ROUTE_DEFAULT_BUDGETS, type E2EModelDayBudgetRequest } from "@agentx/contracts";
import { handleE2EModelBudgetCallback, type E2EModelBudgetDependencies, type E2EModelBudgetOperation } from "../../packages/broker/src/e2e/model-budget-endpoint.js";
import { e2eModelBudgetKey, isTransientAwsFault } from "../../packages/broker/src/e2e/model-route-registry.js";
import { disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { FakeDynamoDb, assumeDrivingTestsPassed } from "../support/fake-dynamodb.js";
import { TEST_ORG, testProjectPk } from "../support/orgs.js";

// The gate itself is tested in e2e-driving-test-gate.test.ts; here every digest counts as driven (Task 4.10C).
assumeDrivingTestsPassed();

// Task 4.3a, test case 7 (Ruling DB-8): the worker's callback for the project's day budget.

afterEach(disposeRealCandidates);

const TABLE = "state";
const NOW = Date.parse("2026-10-21T10:00:00.000Z");
const TASK = "11111111-aaaa-4bbb-8ccc-111111111111";
const GROUP = "22222222-aaaa-4bbb-8ccc-222222222222";
const DAY = "2026-10-21";
const CAPS = { tokens: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxInputTokensPerProjectDay, calls: E2E_MODEL_ROUTE_DEFAULT_BUDGETS.maxCallsPerProjectDay };

function fixture(overrides: { operation?: Partial<E2EModelBudgetOperation>; task?: Record<string, unknown> | null } = {}) {
  const db = new FakeDynamoDb();
  if (overrides.task !== null) db.set({ pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVTASK", workspaceId: "ws-1", project: "payments", ...overrides.task });
  const operation: E2EModelBudgetOperation = { id: "op-1", workspaceId: "ws-1", kind: "task", workflowMode: "CHECKS", status: "RUNNING",
    workflowE2EAdmission: { taskId: TASK, groupRunIds: [GROUP], agentSteps: true }, ...overrides.operation };
  const dependencies: E2EModelBudgetDependencies = { documentClient: { send: db.send }, tableName: TABLE, now: () => NOW, orgOf: async () => TEST_ORG };
  const call = (body: unknown, as: E2EModelBudgetOperation = operation) => handleE2EModelBudgetCallback(dependencies, as, body);
  return { db, operation, dependencies, call };
}
const base = (reservationId: string) => ({ schemaVersion: "rovara-e2e-model-budget/v1", reservationId });
const reserveBody = (reservationId: string, inputTokens = 4_000, groupRunId = GROUP): E2EModelDayBudgetRequest => ({ ...base(reservationId), stage: "reserve", groupRunId, inputTokens }) as E2EModelDayBudgetRequest;
const settleBody = (reservationId: string, actualInputTokens: number): E2EModelDayBudgetRequest => ({ ...base(reservationId), stage: "settle", actualInputTokens }) as E2EModelDayBudgetRequest;
const releaseBody = (reservationId: string): E2EModelDayBudgetRequest => ({ ...base(reservationId), stage: "release" }) as E2EModelDayBudgetRequest;
const dayRow = (db: FakeDynamoDb) => db.get(testProjectPk("payments"), `E2E_MODEL_BUDGET#${DAY}`);
const reservationRow = (db: FakeDynamoDb, id: string) => db.get(testProjectPk("payments"), `E2E_MODEL_BUDGET_RESERVATION#${id}`);
const forbidden = { code: "CALLBACK_FORBIDDEN" };

describe("reserve", () => {

  it("uses the day caps of the route it derives, not any limit the worker could send", async () => {
    const { db, dependencies, operation } = fixture();
    // A caller that names its own limits is refused by the schema; the caps are the broker's.
    await expect(handleE2EModelBudgetCallback(dependencies, operation, { ...reserveBody(randomUUID()), limits: { maxInputTokens: 10 } })).rejects.toThrow();
    const withInstallation = { ...dependencies, e2eAgentInstallation: async () => ({ provider: "amazon-bedrock", region: "us-east-1" }) };
    db.set({ pk: testProjectPk("payments"), sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: CAPS.tokens, calls: 1 });
    expect(await handleE2EModelBudgetCallback(withInstallation, operation, reserveBody(randomUUID(), 1))).toMatchObject({ status: "exhausted" });
  });

});

describe("settle and release", () => {

  it("never charges more than was reserved: a settle above the reservation is clamped to it (the day total cannot pass its cap), logged as a code, and bounded at 64000 by the schema", async () => {
    const { db, call, dependencies } = fixture();
    const logged: Array<Record<string, unknown>> = [];
    const logging = (body: unknown) => handleE2EModelBudgetCallback({ ...dependencies, log: (entry) => logged.push(entry) }, fixture().operation, body);
    const id = randomUUID();
    await call(reserveBody(id, 4_000));
    await logging(settleBody(id, 64_000));
    expect(dayRow(db)).toMatchObject({ inputTokens: 4_000, calls: 1 });
    expect(reservationRow(db, id)).toMatchObject({ status: "settled", settledInputTokens: 4_000 });
    expect(logged).toEqual([{ event: "e2e_model_budget.settle_clamped", code: "settled-above-reserved" }]);
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

  it("never lets a counter go below zero: a correction the day cannot take is refused and the reservation stays open", async () => {
    const { db, call } = fixture();
    const id = randomUUID();
    await call(reserveBody(id, 4_000));
    db.set({ pk: testProjectPk("payments"), sk: `E2E_MODEL_BUDGET#${DAY}`, entityType: "E2E_MODEL_BUDGET", inputTokens: 100, calls: 1 });
    await expect(call(releaseBody(id))).rejects.toMatchObject(forbidden);
    expect(reservationRow(db, id)).toMatchObject({ status: "open" });
    expect(dayRow(db)).toMatchObject({ inputTokens: 100, calls: 1 });
  });
});

describe("who may call it", () => {
  it.each<[string, Partial<E2EModelBudgetOperation>]>([
    ["an operation whose admission reference has no agentSteps", { workflowE2EAdmission: { taskId: TASK, groupRunIds: [GROUP] } }],
  ])("refuses %s with CALLBACK_FORBIDDEN, and writes nothing", async (_what, overrides) => {
    const { db, call, operation } = fixture();
    await expect(call(reserveBody(randomUUID()), { ...operation, ...overrides })).rejects.toMatchObject(forbidden);
    expect(db.find((item) => String(item.pk).includes("PROJECT#"))).toEqual([]);
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
    expect(db.find((item) => String(item.pk).includes("PROJECT#"))).toEqual([]);
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
    expect(e2eModelBudgetKey(TEST_ORG, "payments", DAY).sk).toBe("E2E_MODEL_BUDGET#2026-10-21");
  });
});

