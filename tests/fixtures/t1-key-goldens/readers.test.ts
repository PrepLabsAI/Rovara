// T1 Part 0: repeat the engine boundary census on 2e717e946 with complete core workspace rows.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { createBroker, loadSlackBroker } from "../../support/slack-broker.js";
import { createHarness } from "../../support/task-flow-harness.js";
import { workspaceOperations } from "../../../packages/broker/src/core/task-flow/reads.js";
import { stampForNewTask, stampItem } from "../../../packages/broker/src/core-host/engine-stamp.js";
import { CORE_ENGINE_ON } from "../../../packages/broker/src/core-host/flags.js";
import type { processGithubWorkflowEvent } from "../../../packages/broker/src/aws/broker.js";
import type { DeveloperTaskActions } from "../../../packages/broker/src/aws/developer-task-actions.js";
import { requireOperation } from "../../../packages/broker/src/aws/cancellation.js";
import { requalifyDrainStatus } from "../../../packages/broker/src/e2e/requalify-hold.js";
import { DRAIN_FIXTURE_NOW, drainFixtureRows, drainIamClient } from "../../support/drain-iam-client.js";

// ANSWER-2: flipped by T1 round 7 (2026-11-16): the workspace pointer routes all three direct readers to the core engine, so each refuses (NOT_FOUND).
const LEGACY_CORE_READERS_GUARDED = true;

let actionsModule: { createDeveloperTaskActions(input: never): DeveloperTaskActions; processGithubWorkflowEvent: typeof processGithubWorkflowEvent };
beforeAll(async () => {
  actionsModule = await loadSlackBroker() as unknown as typeof actionsModule;
});

describe("T1 Part 0 AWS reader boundary", () => {
  const coreOperation = async () => {
    const h = createHarness();
    await h.registerProject();
    const started = await h.flow.start(h.owner, {
      requestId: "30000000-0000-4000-8000-000000000001", project: "payments", instructions: "Reader census",
    });
    const [operation] = await workspaceOperations(h.deps, started.task.workspaceId);
    expect(operation).toBeDefined();
    const stamp = stampItem(h.deps.companyId, started.task.taskId,
      stampForNewTask(CORE_ENGINE_ON, h.deps.companyId, h.deps.now!()));
    const prefix = `ORG#${operation!.companyId}#`;
    // Keep the legacy fixture explicit after T1 changes the core's default key constructors.
    const rows = (await h.store.query({ pk: operation!.pk })).items.map(row => ({
      ...row, pk: row.pk.startsWith(prefix) ? row.pk.slice(prefix.length) : row.pk,
    }));
    return { operation: operation!, rows, stamp: stamp.item };
  };

  it("#681 routes the operations reader away from a stamped core workspace with its real pointer", async () => {
    const { operation, rows, stamp } = await coreOperation();
    const { db, brokerInput } = createBroker();
    for (const row of rows) db.set(row);
    db.set(stamp);
    const actions = actionsModule.createDeveloperTaskActions(brokerInput as never);
    expect(await actions.operations(operation.workspaceId)).toEqual([]);
    await expect(actions.workspace(operation.workspaceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an unstamped workspace remains readable through the operations action", async () => {
    const { operation, rows } = await coreOperation();
    const { db, brokerInput } = createBroker();
    for (const row of rows) db.set(row);
    const actions = actionsModule.createDeveloperTaskActions(brokerInput as never);
    expect((await actions.operations(operation.workspaceId)).map(({ id }) => id)).toEqual([operation.id]);
  });

  it("known gap: AWS broker operations reader finds nothing for a company-scoped workspace", async () => {
    const { operation, rows, stamp } = await coreOperation();
    const { db, brokerInput } = createBroker();
    for (const row of rows) db.set({ ...row, pk: companyScoped(operation.companyId, row.pk) });
    db.set(stamp);
    const actions = actionsModule.createDeveloperTaskActions(brokerInput as never);
    expect(await actions.operations(operation.workspaceId)).toEqual([]);
  });

  for (const action of ["workflowBinding", "workflowCandidateSourceExportDigest", "cancellation.requireOperation"] as const) {
    it(`known gap: ${action} reads legacy core rows but finds no scoped core operation`, async () => {
      const { operation, rows, stamp } = await coreOperation();
      for (const scoped of [false, true]) {
        const { db, brokerInput } = createBroker();
        for (const row of rows) db.set({ ...row, pk: scoped ? companyScoped(operation.companyId, row.pk) : row.pk });
        db.set(stamp);
        const sent = vi.spyOn(db, "send");
        const actions = actionsModule.createDeveloperTaskActions(brokerInput as never);
        const read = (id: string) => action === "cancellation.requireOperation"
          ? requireOperation({ documentClient: db as never, tableName: brokerInput.tableName }, operation.workspaceId, id)
          : actions[action](operation.workspaceId, id);
        // The same complete partition, pointer and engine stamp refuse the routed list.
        expect(await actions.operations(operation.workspaceId)).toEqual([]);
        sent.mockClear();
        if (scoped || LEGACY_CORE_READERS_GUARDED) {
          await expect(read(operation.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
        } else if (action === "cancellation.requireOperation") {
          await expect(read(operation.id)).resolves.toMatchObject({ id: operation.id });
        } else {
          await expect(read(operation.id)).resolves.toBeUndefined();
        }
        const storedPk = scoped ? companyScoped(operation.companyId, rows[0]!.pk) : rows[0]!.pk;
        expect(sent.mock.calls.some(([command]) => {
          const input = (command as { input: { Key?: { pk?: string; sk?: string } } }).input;
          return input.Key?.pk === storedPk && input.Key.sk === operation.sk;
        })).toBe(!scoped && !LEGACY_CORE_READERS_GUARDED);
        await expect(read("missing-operation")).rejects.toMatchObject({ code: "NOT_FOUND" });
      }
    });
  }

  it("known gap: renewal drain reports drained while scoped application operations are running", async () => {
    const { operation } = await coreOperation();
    const rows = drainFixtureRows().filter(row => row.pk === "WORKSPACE#ws-1");
    const legacy = drainIamClient(rows);
    expect(await requalifyDrainStatus({ documentClient: legacy.documentClient, tableName: "state" }, DRAIN_FIXTURE_NOW))
      .toEqual({ drained: false, applicationRounds: 1, setupRuns: 0 });
    // Sessions are intentionally unchanged by T1. Only operation partition keys move.
    const scoped = drainIamClient(rows.map(row => {
      if (typeof row.pk !== "string") throw new Error("invalid drain fixture key");
      return row.sk === "SESSION" ? row : { ...row, pk: companyScoped(operation.companyId, row.pk) };
    }));
    // Q4 reproduction, NOT a passing isolation guarantee. The desired count failed before pinning this gap.
    expect(await requalifyDrainStatus({ documentClient: scoped.documentClient, tableName: "state" }, DRAIN_FIXTURE_NOW))
      .toEqual({ drained: true, applicationRounds: 0, setupRuns: 0 });
    // 4f604a5ee (T1 follow-up) also reads each session's company, so the drain can see core operations under company keys; this
    // fixture's sessions carry no company and no core company mark, so the gap above still reproduces for it.
    expect(scoped.requests.find(request => request.indexName === "bySessionState")?.attributes).toEqual(["workspaceId", "companyId"]);
  });
});

describe("T1 remaining concrete AWS workspace readers", () => {
  it("known gap: worker callback requireOperation finds no scoped operation", async () => {
    const { db, brokerInput } = createBroker(); const ws = "callback-workspace", op = "callback-operation";
    const row = { pk: `WORKSPACE#${ws}`, sk: `OPERATION#${op}`, entityType: "OPERATION", id: op, workspaceId: ws };
    db.set({ ...row, pk: companyScoped("org_00000000000000000000", row.pk) });
    await expect(requireOperation({ documentClient: db as never, tableName: brokerInput.tableName }, ws, op)).rejects.toMatchObject({ code: "NOT_FOUND" });
    db.set(row);
    expect(await requireOperation({ documentClient: db as never, tableName: brokerInput.tableName }, ws, op)).toMatchObject({ id: op });
  });
  it("known gap: watchdog cancel retrier finds no scoped workspace", async () => {
    const { createCancelRetrier } = await import("../../../packages/broker/src/aws/stuck-cancels.js");
    const { db, brokerInput } = createBroker(); const ws = "watchdog-workspace", op = "watchdog-operation";
    const retry = createCancelRetrier({ client: db, tableName: brokerInput.tableName, callbackSigningKey: "x".repeat(40) });
    const row = { pk: `WORKSPACE#${ws}`, sk: "META", activeOperationId: op };
    db.set({ ...row, pk: companyScoped("org_00000000000000000000", row.pk) });
    expect(await retry(ws, op)).toEqual({ outcome: "SKIPPED", reason: "not-active" });
    db.set(row);
    expect(await retry(ws, op)).toEqual({ outcome: "SKIPPED", reason: "not-cancel-requested" });
  });
  it("known gap: reaper runtime binding finds no scoped workspace", async () => {
    const { workspaceBinding } = await import("../../../packages/broker/src/aws/sessions.js");
    const { db, brokerInput } = createBroker(); const ws = "reaper-workspace";
    const binding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0aaaaaaaaaaaaaaaa" }], volumeSizeGiB: 20, volumeType: "gp3" };
    db.set({ pk: "PROJECT#payments", sk: "REV#000000000001", runtimeBinding: binding });
    const row = { pk: `WORKSPACE#${ws}`, sk: "META", deploymentMode: "ec2-ebs", projectName: "payments", projectRevision: 1 };
    db.set({ ...row, pk: companyScoped("org_00000000000000000000", row.pk) });
    expect(await workspaceBinding(db as never, brokerInput.tableName, ws)).toBeUndefined();
    db.set(row);
    expect(await workspaceBinding(db as never, brokerInput.tableName, ws)).toEqual(binding);
  });
});

it("known gap: GitHub webhook recordedHead finds no scoped pull request", async () => {
  const webhooks = await import("../../../packages/broker/src/aws/github-webhooks.js");
  const { db, brokerInput } = createBroker(); const ws = "webhook-workspace";
  let observed: string | undefined;
  const reconcile = vi.spyOn(webhooks, "reconcileTaskPullRequestFeedback").mockImplementation(async (input) => {
    observed = await input.recordedHead!(ws, "demo", 1); return false;
  });
  const row = { pk: `WORKSPACE#${ws}`, sk: "PULL_REQUEST#demo#000000000001", expectedHeadCommit: "a".repeat(40) };
  const dependencies = { ...brokerInput, githubPullRequests: { ...brokerInput.githubPullRequests, getPullRequestFeedback: vi.fn() } };
  try {
    db.set({ ...row, pk: companyScoped("org_00000000000000000000", row.pk) });
    await actionsModule.processGithubWorkflowEvent(dependencies as never, { fullName: "example/demo", number: 1 } as never, "delivery");
    expect(reconcile).toHaveBeenCalledOnce(); expect(observed).toBeUndefined();
    db.set(row);
    await actionsModule.processGithubWorkflowEvent(dependencies as never, { fullName: "example/demo", number: 1 } as never, "delivery");
    expect(observed).toBe(row.expectedHeadCommit);
  } finally { reconcile.mockRestore(); }
});
