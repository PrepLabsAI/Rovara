import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  E2EApplicationSelectionRecordSchema, WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, requalifyHoldKey as holdKeyOf, workflowApplicationRetryOffered,
  type E2EApplicationSelectionRecord,
} from "../../packages/contracts/src/index.js";
import {
  ApplicationRuntimeRenewed, REQUALIFY_DEFERRED_MESSAGE, assertNoRequalifyHold, isRenewalOnlyChange, isRuntimeRenewedBlock,
  recycleDriftedWorker, replayPredatesRenewal, requalifyDrainCount, requalifyDrainStatus, requalifyHoldActive, requalifySetupWorkRow, requireRenewalOnlyReapproval, selectionChangedRefusal,
} from "../../packages/broker/src/e2e/requalify-hold.js";
import { E2E_REPLAY_REFUSALS } from "../../packages/contracts/src/index.js";
import { E2E_OWNER_SENTENCES } from "../../packages/broker/src/e2e/owner-sentences.js";
import { ApplicationDispatchRefusal } from "../../packages/broker/src/e2e/application-dispatch-check.js";

const NOW = Date.parse("2026-10-27T03:00:00.000Z");
const RUN = "0b8a2f64-7c1d-4e0a-9f1b-3d5c6e7f8a90";
const k = (key: { pk: string; sk: string }) => `${key.pk}|${key.sk}`;
const iso = (ms: number) => new Date(ms).toISOString();

/** A small in-memory table that applies the few conditions the module relies on, so a lost race fails as DynamoDB would. */
function table() {
  const items = new Map<string, Record<string, unknown>>();
  const conditional = () => Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
  type Key = { pk: string; sk: string };
  type Write = { ConditionCheck?: { Key: Key; ConditionExpression: string; ExpressionAttributeValues: Record<string, string> }; Put?: { Item: Key & Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeValues: Record<string, string> } };
  type Input = { Key: Key; ConditionExpression?: string; ExpressionAttributeValues: Record<string, string>; TransactItems: Write[]; IndexName?: string };
  const send = async (command: { constructor: { name: string }; input: Input }) => {
    const { input } = command;
    switch (command.constructor.name) {
      case "GetCommand": return { Item: items.get(k(input.Key)) };
      case "DeleteCommand": {
        const current = items.get(k(input.Key));
        if (input.ConditionExpression === "runId = :runId" && current?.runId !== input.ExpressionAttributeValues[":runId"]) throw conditional();
        items.delete(k(input.Key));
        return {};
      }
      case "TransactWriteCommand": {
        for (const write of input.TransactItems) {
          if (write.ConditionCheck?.ConditionExpression === "runId = :runId AND expiresAt > :now") {
            const lock = items.get(k(write.ConditionCheck.Key));
            if (lock === undefined || lock.runId !== write.ConditionCheck.ExpressionAttributeValues[":runId"] || String(lock.expiresAt) <= String(write.ConditionCheck.ExpressionAttributeValues[":now"])) throw conditional();
          }
          if (write.Put?.ConditionExpression === "attribute_not_exists(pk) OR runId = :runId") {
            const current = items.get(k(write.Put.Item));
            if (current !== undefined && current.runId !== write.Put.ExpressionAttributeValues[":runId"]) throw conditional();
          }
        }
        for (const write of input.TransactItems) if (write.Put) items.set(k(write.Put.Item), write.Put.Item);
        return {};
      }
      case "QueryCommand": {
        const rows = [...items.values()];
        if (input.IndexName === "bySessionState") return { Items: rows.filter((row) => row.sessionState === input.ExpressionAttributeValues[":state"]) };
        const pk = input.ExpressionAttributeValues[":pk"];
        const prefix = input.ExpressionAttributeValues[":operation"] ?? input.ExpressionAttributeValues[":setup"] ?? "";
        return { Items: rows.filter((row) => row.pk === pk && String(row.sk).startsWith(prefix)) };
      }
      default: throw new Error(`unexpected ${command.constructor.name}`);
    }
  };
  return { items, store: { documentClient: { send } as never, tableName: "state" } };
}
type Table = ReturnType<typeof table>;


const requalifyHoldKey = () => holdKeyOf("linux-arm64-web-api-v1");
const putHold = (t: Table, until: number, extra: Record<string, unknown> = {}) => t.items.set(k(requalifyHoldKey()), { ...requalifyHoldKey(), entityType: "RUNTIME_REQUALIFY_HOLD", runId: RUN, acquiredAt: iso(NOW), until: iso(until), ...extra });

describe("the hold: new rounds and setup runs wait while a switch is in progress", () => {
  it("is active only until its own end, so a renewal that crashed cannot defer work for ever", async () => {
    const t = table();
    expect(await requalifyHoldActive(t.store, NOW)).toBe(false);
    putHold(t, NOW + 60_000);
    expect(await requalifyHoldActive(t.store, NOW + 59_000)).toBe(true);
    expect(await requalifyHoldActive(t.store, NOW + 60_000)).toBe(false);
  });

  it("reads a row that is not a hold as active (fail closed)", async () => {
    const t = table();
    t.items.set(k(requalifyHoldKey()), { ...requalifyHoldKey(), runId: "not-a-uuid" });
    expect(await requalifyHoldActive(t.store, NOW)).toBe(true);
    putHold(t, NOW + 60_000, { until: "tomorrow" });
    expect(await requalifyHoldActive(t.store, NOW)).toBe(true);
  });

  it("defers an interactive start with a retryable error and one fixed sentence", async () => {
    const t = table();
    await assertNoRequalifyHold(t.store, NOW);
    putHold(t, NOW + 60_000);
    await expect(assertNoRequalifyHold(t.store, NOW)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: `RUNTIME_UNAVAILABLE: ${REQUALIFY_DEFERRED_MESSAGE}` });
  });
});

describe("the drain: nothing that started on the old machine is still running", () => {
  const WORKSPACE = "ws-1";
  const session = (t: Table, workspaceId: string, state = "READY") => t.items.set(`s|${workspaceId}`, { pk: `WORKSPACE#${workspaceId}`, sk: "SESSION", workspaceId, sessionState: state });
  const operation = (t: Table, workspaceId: string, extra: Record<string, unknown>) => {
    const id = randomUUID();
    t.items.set(`o|${id}`, { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${id}`, entityType: "OPERATION", id, kind: "task", workflowMode: "CHECKS", status: "RUNNING",
      createdAt: iso(NOW - 60_000), updatedAt: iso(NOW - 30_000), workflowE2EAdmission: { kind: "application" }, ...extra });
    return id;
  };

  it("counts a running browser and API round, attributed to its own workspace, and nothing else", async () => {
    const t = table();
    expect(await requalifyDrainStatus(t.store, NOW)).toEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
    session(t, WORKSPACE); session(t, "ws-2"); session(t, "ws-stopped", "STOPPING");
    operation(t, WORKSPACE, { status: "ACCEPTED" });
    operation(t, "ws-2", { status: "RUNNING" });
    // Not counted: a finished round, a portable round, a different kind of operation, an operation of a workspace whose compute is not READY.
    operation(t, WORKSPACE, { status: "SUCCEEDED" });
    operation(t, WORKSPACE, { status: "FAILED" });
    operation(t, WORKSPACE, { workflowE2EAdmission: { kind: undefined } });
    operation(t, WORKSPACE, { workflowMode: "IMPLEMENT" });
    operation(t, "ws-stopped", { status: "RUNNING" });
    expect(await requalifyDrainStatus(t.store, NOW)).toEqual({ drained: false, applicationRounds: 2, setupRuns: 0 });
  });

  it("does not wait for an operation the stale-run sweep has long since ended", async () => {
    const t = table(); session(t, WORKSPACE);
    operation(t, WORKSPACE, { updatedAt: iso(NOW - 3_600_001) });
    expect(await requalifyDrainStatus(t.store, NOW)).toMatchObject({ drained: true });
    operation(t, WORKSPACE, { updatedAt: iso(NOW - 3_599_000) });
    expect(await requalifyDrainStatus(t.store, NOW)).toMatchObject({ drained: false, applicationRounds: 1 });
  });

  it("counts a project setup run until it ends, its marker lapses, or its record is terminal", async () => {
    const t = table();
    const marker = (state: string | undefined, deadlineAt: string) => {
      const id = randomUUID();
      const row = requalifySetupWorkRow(id, deadlineAt);
      t.items.set(k(row as never), row);
      if (state !== undefined) t.items.set(`PROJECT_SETUP#${id}|EXECUTION`, { pk: `PROJECT_SETUP#${id}`, sk: "EXECUTION", state });
      return id;
    };
    const live = iso(NOW + 600_000);
    marker("ACCEPTED", live); marker("DISPATCHING", live);
    // Not counted: terminal records, and a marker whose run and grace are over.
    marker("SUCCEEDED", live); marker("FAILED", live); marker("PARKED", live); marker("DISPATCHING", iso(NOW - 6 * 60_000));
    expect(await requalifyDrainStatus(t.store, NOW)).toEqual({ drained: false, applicationRounds: 0, setupRuns: 2 });
    // A marker whose execution record cannot be found counts until the marker itself ends (fail closed).
    const t2 = table();
    const orphan = requalifySetupWorkRow(randomUUID(), live);
    t2.items.set(k(orphan as never), orphan);
    expect(await requalifyDrainStatus(t2.store, NOW)).toMatchObject({ setupRuns: 1 });
  });

  it("gives the renewal one number: rounds plus setup runs, zero only when both are done", async () => {
    const t = table();
    expect(await requalifyDrainCount(t.store, NOW)).toBe(0);
    session(t, WORKSPACE);
    operation(t, WORKSPACE, { status: "RUNNING" });
    const row = requalifySetupWorkRow(randomUUID(), iso(NOW + 600_000));
    t.items.set(k(row as never), row);
    expect(await requalifyDrainCount(t.store, NOW)).toBe(2);
  });

  it("writes the setup marker so that it expires with the table's time to live, after the run's own end", () => {
    const row = requalifySetupWorkRow(randomUUID(), iso(NOW));
    expect(row).toMatchObject({ entityType: "RUNTIME_REQUALIFY_SETUP_WORK", until: iso(NOW + 5 * 60_000) });
    expect(row.indexExpiresAt).toBeGreaterThan(Math.floor((NOW + 5 * 60_000) / 1000));
  });
});

const digest = (c: string) => c.repeat(64);
const row = (kind: "web" | "api", extra: Record<string, unknown> = {}) => ({ kind, profileId: "linux-arm64-web-api-v1", runtimeCatalogId: "catalog", catalogRevision: 3, generation: 4,
  bindingDigest: digest("b"), capabilityDigest: digest("c"), expiresAt: "2026-11-01T00:00:00.000Z", ...extra });
const selection = (overrides: Record<string, unknown> = {}): E2EApplicationSelectionRecord => E2EApplicationSelectionRecordSchema.parse({
  schemaVersion: "e2e-application-selection/v1", intentDigest: digest("1"), planDigest: digest("2"),
  semanticApproval: { artifactId: "plan-1", digest: digest("3") }, setupApproval: { artifactId: "setup-1", digest: digest("4") }, applicationApprovalBindingDigest: digest("5"),
  applicationExecutionPlanDigest: digest("6"), applicationBundleDigest: digest("7"), executableTargetIds: ["orders-api"], unavailableCriteria: [],
  runtimeRows: [row("web"), row("api")], accountRefs: [{ applicationId: "orders", profileId: "tester", revision: 2, definitionDigest: digest("8") }],
  evaluatedAt: "2026-10-26T10:00:00.000Z", ...overrides });
const renewedRows = (extra: Record<string, unknown> = {}) => [row("web", { generation: 5, expiresAt: "2026-11-08T00:00:00.000Z", ...extra }), row("api", { generation: 5, expiresAt: "2026-11-08T00:00:00.000Z", ...extra })];

describe("a renewal of the test machine is not any other change of the approved selection", () => {
  it("is recognised when only the runtime rows moved to a newer generation", () => {
    expect(isRenewalOnlyChange(selection(), selection({ runtimeRows: renewedRows() }))).toBe(true);
    // A newer catalog revision comes with a new row; only one of the two rows moving is also a renewal.
    expect(isRenewalOnlyChange(selection(), selection({ runtimeRows: renewedRows({ catalogRevision: 4 }) }))).toBe(true);
    expect(isRenewalOnlyChange(selection(), selection({ runtimeRows: [row("web"), row("api", { generation: 5 })] }))).toBe(true);
  });

  it.each([
    ["nothing moved", () => selection()],
    ["the generation did not grow", () => selection({ runtimeRows: renewedRows({ generation: 4 }) })],
    ["the generation went back", () => selection({ runtimeRows: renewedRows({ generation: 3 }) })],
    ["the binding changed", () => selection({ runtimeRows: renewedRows({ bindingDigest: digest("e") }) })],
    ["the capabilities changed", () => selection({ runtimeRows: renewedRows({ capabilityDigest: digest("e") }) })],
    ["the catalog changed", () => selection({ runtimeRows: renewedRows({ runtimeCatalogId: "other" }) })],
    ["the catalog revision went back", () => selection({ runtimeRows: renewedRows({ catalogRevision: 2 }) })],
    ["a row is gone", () => selection({ runtimeRows: [renewedRows()[0]] })],
    ["a row was swapped for another profile's", () => selection({ runtimeRows: [renewedRows()[0], row("api", { profileId: "other-profile", generation: 5 })] })],
    ["the intent changed", () => selection({ runtimeRows: renewedRows(), intentDigest: digest("f") })],
    ["the plan approval changed", () => selection({ runtimeRows: renewedRows(), semanticApproval: { artifactId: "plan-1", digest: digest("f") } })],
    ["the setup approval changed", () => selection({ runtimeRows: renewedRows(), setupApproval: { artifactId: "setup-1", digest: digest("f") } })],
    ["the application binding changed", () => selection({ runtimeRows: renewedRows(), applicationApprovalBindingDigest: digest("f") })],
    ["the targets changed", () => selection({ runtimeRows: renewedRows(), executableTargetIds: ["orders-api", "orders-web"] })],
    ["a test account moved", () => selection({ runtimeRows: renewedRows(), accountRefs: [{ applicationId: "orders", profileId: "tester", revision: 3, definitionDigest: digest("9") }] })],
    ["a test account was dropped", () => selection({ runtimeRows: renewedRows(), accountRefs: [] })],
  ])("is not recognised when %s", (_name, current) => {
    expect(isRenewalOnlyChange(selection(), current())).toBe(false);
  });

  it("is never a renewal of a selection that has no runtime rows", () => {
    expect(isRenewalOnlyChange(selection({ runtimeRows: [] }), selection({ runtimeRows: renewedRows() }))).toBe(false);
    expect(isRenewalOnlyChange(selection({ runtimeRows: [row("web")] }), selection({ runtimeRows: renewedRows() }))).toBe(false);
  });

  it("gives the renewal its own refusal and block text, and every other change the ordinary one", () => {
    const renewed = selectionChangedRefusal(selection(), selection({ runtimeRows: renewedRows() }), "the api runtime moved", WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX);
    expect(renewed).toBeInstanceOf(ApplicationRuntimeRenewed);
    expect(renewed.message).toBe(`${WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX}the api runtime moved`);
    const ordinary = selectionChangedRefusal(selection(), selection({ runtimeRows: renewedRows(), intentDigest: digest("f") }), "the intent moved", WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX);
    expect(ordinary).toBeInstanceOf(ApplicationDispatchRefusal);
    expect(ordinary).not.toBeInstanceOf(ApplicationRuntimeRenewed);
    expect(ordinary.message).toBe(`${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}the intent moved`);
  });

  it("is offered as a retry, never as a send back, and is told apart from the other blocks by its prefix", () => {
    const blocked = (blockReason: string) => ({ stage: "VERIFY", state: "BLOCKED", blockReason, e2e: { required: true, applicationSelection: {} } });
    expect(workflowApplicationRetryOffered(blocked(`${WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX}x`))).toBe(true);
    expect(isRuntimeRenewedBlock(`${WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX}x`)).toBe(true);
    expect(isRuntimeRenewedBlock(`${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}x`)).toBe(false);
    expect(isRuntimeRenewedBlock(undefined)).toBe(false);
    expect(WORKFLOW_APPLICATION_RUNTIME_RENEWED_PREFIX.length).toBeLessThan(200);
  });

  it("holds Rovara's own re-approval to the renewal: other changes, and accounts the owner's re-approval would move, are refused", () => {
    expect(() => requireRenewalOnlyReapproval(selection(), selection({ runtimeRows: renewedRows() }))).not.toThrow();
    for (const derived of [
      selection({ runtimeRows: renewedRows(), accountRefs: [{ applicationId: "orders", profileId: "tester", revision: 3, definitionDigest: digest("9") }] }),
      selection({ runtimeRows: renewedRows(), intentDigest: digest("f") }),
      selection({ runtimeRows: renewedRows({ capabilityDigest: digest("e") }) }),
      selection(),
    ]) expect(() => requireRenewalOnlyReapproval(selection(), derived)).toThrow(/only a renewal of the test machine is approved again automatically/);
  });
});

describe("a replay of a round from before a renewal", () => {
  it("has its own refusal code and one fixed sentence", () => {
    expect(E2E_REPLAY_REFUSALS).toContain("replay-runtime-renewed");
    expect(E2E_OWNER_SENTENCES.replayRuntimeRenewed).toBe("The test machine was renewed since this round, so it can't be replayed exactly.");
  });

  const registered = (kind: "web" | "api", extra: Record<string, unknown> = {}) => ({ profileId: "linux-arm64-web-api-v1", generation: 4, capabilities: { kind }, qualifiedAt: "2026-10-26T00:00:00.000Z", ...extra }) as never;
  it("is a replay of an earlier machine when a row it ran on is gone or is not the registered row", () => {
    expect(replayPredatesRenewal([registered("api")], [registered("api")])).toBe(false);
    expect(replayPredatesRenewal([registered("api")], [registered("api", { generation: 5 })])).toBe(true);
    expect(replayPredatesRenewal([registered("api")], [registered("api", { qualifiedAt: "2026-10-27T00:00:00.000Z" })])).toBe(true);
    expect(replayPredatesRenewal([registered("api")], [registered("web")])).toBe(true);
    expect(replayPredatesRenewal([registered("web"), registered("api")], [registered("api")])).toBe(true);
  });
});

describe("recycling a task worker that booted on another image than the test machine", () => {
  const session = (state: string) => ({ workspaceId: "ws-1", state, generation: 2 });
  const sessions = (seen: { state: string } | undefined, claimed = true) => {
    const claim = vi.fn(async () => claimed);
    return { claim, manager: { get: async () => seen as never, claimStop: claim } };
  };
  it("claims a READY worker with the reaper's atomic claim, and reports whether it won", async () => {
    const won = sessions(session("READY"));
    expect(await recycleDriftedWorker(won.manager, "ws-1")).toBe(true);
    expect(won.claim).toHaveBeenCalledWith(session("READY"));
    const lost = sessions(session("READY"), false);
    expect(await recycleDriftedWorker(lost.manager, "ws-1")).toBe(false);
  });
  it("leaves a worker that is not READY, or no worker at all, alone", async () => {
    for (const seen of [session("STOPPING"), session("STOPPED"), session("PROVISIONING"), undefined]) {
      const w = sessions(seen);
      expect(await recycleDriftedWorker(w.manager, "ws-1")).toBe(false);
      expect(w.claim).not.toHaveBeenCalled();
    }
  });
});
