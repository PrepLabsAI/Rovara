import { createHash } from "node:crypto";
import { STATE_TABLE_INDEXES, STATE_TABLE_PLANNED_INDEXES } from "../../../packages/aws-adapters/src/dynamodb/state-table.js";
import { expect } from "vitest";
import { workspaceProjectIndexAttributes, workspaceProjectIndexValue } from "@agentx/contracts";
import { SHARED_RAW_IDS, TWO_COMPANIES, type TwoCompanyIsolation } from "../../../packages/testing/src/isolation/two-company.js";
import { createHarness, definition } from "../task-flow-harness.js";
import { dynamoWorld } from "./dynamodb-harness.js";
import { MemoryQueueService } from "../../../packages/broker/src/ports/memory-queue.js";
import { workspaceKey, conversationKey, operationRequestKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import { buildOperation } from "../../../packages/broker/src/core/task-flow/accept.js";
import { workspaceOperations } from "../../../packages/broker/src/core/task-flow/reads.js";
import { readOperation } from "../../../packages/broker/src/core/task-flow/results.js";
import { runDispatchOnce } from "../../../packages/broker/src/core/task-flow/dispatch.js";
import type { WorkspaceRecord } from "../../../packages/broker/src/core/task-flow/records.js";

// The kit has generic raw ids: reuse them identically in each company's workspace/operation/conversation/request.
const sharedUuid = (raw: string) => {
  const hex = createHash("sha256").update(raw).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const ws = sharedUuid(SHARED_RAW_IDS.machineKey), op = sharedUuid(SHARED_RAW_IDS.documentName), conv = sharedUuid(SHARED_RAW_IDS.thread), req = sharedUuid(SHARED_RAW_IDS.scheduleId);
export function taskflowKeysCompanies(perCompanyQueue = false): TwoCompanyIsolation {
  const { store } = dynamoWorld({ indexes: [...STATE_TABLE_INDEXES, ...STATE_TABLE_PLANNED_INDEXES] });
  let now = Date.parse("2026-11-09T10:00:00.000Z");
  const queues = new MemoryQueueService({ now: () => now });
  const worlds = new Map(TWO_COMPANIES.map((me) => {
    const h = createHarness({ companyId: me.orgId, machines: { startingChecks: 0, features: ["prepare.pins.v1"] }, backend: () => ({ store, queues }) });
    if (perCompanyQueue) h.deps.dispatchQueue = `dispatch-${me.label}`;
    return [me.orgId, h] as const;
  }));
  return { surfaces: [{ name: "S4a same raw records", kind: "read",
    async plant(me) {
      const h = worlds.get(me.orgId)!;
      await h.registerProject({ ...definition, repositories: definition.repositories.map((repository) => ({ ...repository, name: me.canary })) });
      const at = new Date(now).toISOString();
      const workspace: WorkspaceRecord = { ...workspaceKey(me.orgId, ws), sk: "META", entityType: "WORKSPACE", id: ws, companyId: me.orgId, orgId: me.orgId,
        ownerKey: "shared-owner", projectName: definition.name, projectRevision: 1, status: "PREPARING", activeOperationId: op, fence: 1, createdAt: at, updatedAt: at,
        ...workspaceProjectIndexAttributes({ orgId: me.orgId, projectName: definition.name, createdAt: at }) };
      const built = buildOperation(h.deps, { workspace, operationId: op, requestId: req, conversationId: conv, kind: "prepare", firstEvent: me.canary,
        dispatch: { kind: "prepare", projectRevision: 1, payload: { pins: [{ repository: me.canary, commit: me.label.toLowerCase().repeat(40) }] } } });
      expect((await store.transact([{ kind: "put", item: { ...workspace, marker: me.canary } },
        { kind: "put", item: { ...conversationKey(me.orgId, ws, conv), marker: me.canary } }, ...built.items])).applied).toBe(true);
      await h.deps.outbox.relay({ companyId: me.orgId });
    },
    async observe(me) {
      const operation = await readOperation(worlds.get(me.orgId)!.deps, ws, op);
      expect(operation?.companyId).toBe(me.orgId);
      expect(await store.get(operationRequestKey(me.orgId, "shared-owner", ws, req))).toMatchObject({ operationId: op });
      return { workspace: await store.get(workspaceKey(me.orgId, ws)), conversation: await store.get(conversationKey(me.orgId, ws, conv)), operation };
    },
  }, { name: "S4b workspace and project lists", kind: "list", async plant() {},
    async observe(me) {
      const operations = await workspaceOperations(worlds.get(me.orgId)!.deps, ws);
      expect(operations).toHaveLength(1); expect(operations[0]?.companyId).toBe(me.orgId);
      const page = await store.queryIndex({ index: "byWorkspaceProject", partition: workspaceProjectIndexValue(me.orgId, definition.name) });
      expect(page.items).toHaveLength(1);
      return page.items;
    },
  }, { name: `S4c positive dispatch ${perCompanyQueue ? "company queues" : "shared queue with release"}`, kind: "delivery", async plant() {},
    async observe(me) {
      const h = worlds.get(me.orgId)!;
      const other = TWO_COMPANIES.find((entry) => entry.orgId !== me.orgId)!;
      const before = await store.get(workspaceKey(other.orgId, ws));
      const otherOperation = await readOperation(worlds.get(other.orgId)!.deps, ws, op);
      let delivered = 0;
      for (let pass = 0; pass < 4; pass++) { delivered += (await runDispatchOnce(h.deps, { maxMessages: 10 })).delivered; now += 31_000; h.clock.advance(31); }
      expect(delivered).toBe(1);
      expect(await store.get(workspaceKey(other.orgId, ws))).toEqual(before);
      expect(await readOperation(worlds.get(other.orgId)!.deps, ws, op)).toEqual(otherOperation);
      const workspace = await store.get(workspaceKey(me.orgId, ws));
      const machineId = (workspace?.machine as { machineId: string }).machineId;
      const deliveries = h.machines.delivered(machineId);
      expect(deliveries.map((entry) => entry.operationId)).toEqual([op]);
      expect(deliveries[0]?.payload).toMatchObject({ pins: [{ repository: me.canary, commit: me.label.toLowerCase().repeat(40) }] });
      expect((await readOperation(h.deps, ws, op))?.companyId).toBe(me.orgId);
      return { marker: workspace?.marker, deliveries };
    },
  }] };
}

/** The kit must notice each broken guard, as well as accepting the real resolver. */
export async function taskflowGuardProbe(mutant?: "drop-company" | "any-legacy" | "skip-stored-company"): Promise<TwoCompanyIsolation> {
  const { IMPLICIT_COMPANY_ID } = await import("@agentx/contracts");
  const { locateWorkspace } = await import("../../../packages/broker/src/core/task-flow/workspace-location.js");
  const { legacyWorkspaceKey } = await import("../../../packages/broker/src/core/task-flow/legacy-keys.js");
  const { store } = dynamoWorld();
  return { surfaces: [{ name: `resolver guard ${mutant ?? "control"}`, kind: "read",
    async plant(me) {
      await store.put({ item: { ...(mutant === "drop-company" ? legacyWorkspaceKey(ws) : workspaceKey(me.orgId, ws)), companyId: me.orgId, marker: me.canary } });
      await store.put({ item: { ...legacyWorkspaceKey("probe"), companyId: me.orgId, marker: me.canary } });
    },
    async observe(me) {
      const own = (await locateWorkspace({ store, companyId: me.orgId }, ws))?.workspace;
      const extra = mutant === "any-legacy" || mutant === "skip-stored-company" ? await store.get(legacyWorkspaceKey("probe"))
        : (await locateWorkspace({ store, companyId: mutant === undefined ? IMPLICIT_COMPANY_ID : me.orgId }, "probe"))?.workspace;
      return { own, extra };
    },
  }], failClosed: [{ name: "legacy resolver unavailable", async prepare() {
    await store.put({ item: { ...legacyWorkspaceKey("failed"), marker: TWO_COMPANIES[0].canary } });
  }, async attempt(mode) {
    return locateWorkspace({ companyId: IMPLICIT_COMPANY_ID, store: { get: async (key) => {
      if (!key.pk.startsWith("WORKSPACE#")) return undefined;
      if (mode === "throws") throw new Error("unavailable"); return undefined;
    } } }, "failed");
  } }, ...["", "bad"].map((companyId) => ({ name: `invalid flow company ${companyId === "" ? "empty" : "malformed"}`, async prepare() {}, async attempt() {
    return readOperation({ store, companyId }, ws, op);
  } }))] };
}
