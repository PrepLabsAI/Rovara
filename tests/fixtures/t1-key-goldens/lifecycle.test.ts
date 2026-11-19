// Captured on engine-boundary base 2e717e946 before T1; amended only for E's persisted usageStartQuote. No git-history dependency.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type * as Crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DocumentKey, JsonValue, StoredDocument } from "@agentx/contracts";
import { createHarness } from "../../support/task-flow-harness.js";
import { materializeT1Golden, normalizeT1Golden } from "../../support/t1-golden-normalizer.js";
import { dynamoWorld } from "../../support/ports/dynamodb-harness.js";
import { MemoryQueueService } from "../../../packages/broker/src/ports/memory-queue.js";
import { TASK_FLOW_INDEXES } from "../../../packages/broker/src/core/task-flow/flow.js";
import { locateWorkspace } from "../../../packages/broker/src/core/task-flow/workspace-location.js";
import { workspaceOperations, type TaskView } from "../../../packages/broker/src/core/task-flow/reads.js";
import type { WorkspaceRecord } from "../../../packages/broker/src/core/task-flow/records.js";

interface GoldenSnapshot {
  phase: string; nextId: number; clock: number; keys: DocumentKey[]; rows: StoredDocument[];
  taskViewJson: string; listTasksJson: string; workspaceOperationsJson: string; workspaceOperationsWithoutKeysJson: string;
}
interface Golden { base: string; backend: string; snapshots: GoldenSnapshot[] }

const ids = vi.hoisted(() => ({ value: 0 }));
vi.mock("node:crypto", async (original) => ({
  ...await original<typeof Crypto>(),
  randomUUID: () => `00000000-0000-4000-8000-${String(++ids.value).padStart(12, "0")}`,
}));

describe("T1 unmodified-base lifecycle goldens", () => {
  for (const mode of ["memory", "dynamo", "legacy"] as const) {
    it(`${mode}: preserves exact stored keys, rows and JSON through two dispatched operations and close`, async () => {
      const backend = mode === "legacy" ? "memory" : mode;
      ids.value = 0;
      const h = createHarness(backend === "memory" ? {} : {
        backend: (clock) => ({ store: dynamoWorld({ indexes: TASK_FLOW_INDEXES }).store, queues: new MemoryQueueService({ now: () => clock.now }) }),
      });
      let nextId = 0;
      h.deps.newId = () => `10000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`;
      const puts = vi.spyOn(h.store, "put");
      const updates = vi.spyOn(h.store, "update");
      const transactions = vi.spyOn(h.store, "transact");
      const rows = async () => {
        const keys = new Map<string, DocumentKey>();
        const add = ({ pk, sk }: DocumentKey) => { keys.set(`${pk}\u0000${sk}`, { pk, sk }); };
        for (const [call] of puts.mock.calls) add(call.item);
        for (const [call] of updates.mock.calls) add(call.key);
        for (const [call] of transactions.mock.calls) for (const item of call) add(item.kind === "put" ? item.item : item.key);
        const found = await Promise.all([...keys.values()].map((key) => h.store.get(key)));
        return found.filter((row) => row !== undefined).sort((a, b) => a.pk.localeCompare(b.pk) || a.sk.localeCompare(b.sk));
      };
      await h.registerProject();
      const started = mode === "legacy" ? await (async () => {
        const saved = materializeT1Golden(JSON.parse(readFileSync(new URL("./memory.json", import.meta.url), "utf8")) as Golden).snapshots[0]!;
        for (const row of saved.rows) await h.store.put({ item: row });
        nextId = saved.nextId; h.clock.now = saved.clock;
        const outbox = saved.rows.find((row) => row.entityType === "OUTBOX") as unknown as { queue: string; body: JsonValue; attributes: Record<string, string> };
        await (await h.queues.queue(outbox.queue)).enqueue({ body: outbox.body, attributes: outbox.attributes });
        return { task: JSON.parse(saved.taskViewJson) as TaskView };
      })() : await h.flow.start(h.owner, {
        requestId: "20000000-0000-4000-8000-000000000001", project: "payments", instructions: "Add a health endpoint",
      });
      const snapshots: GoldenSnapshot[] = [];
      const capture = async (phase: string) => {
        const storedRows = await rows();
        const operations = await workspaceOperations(h.deps, started.task.workspaceId);
        snapshots.push({ phase, nextId, clock: h.clock.now,
          keys: storedRows.map(({ pk, sk }) => ({ pk, sk })), rows: storedRows,
          taskViewJson: JSON.stringify(await h.flow.get(h.owner, started.task.taskId)),
          listTasksJson: JSON.stringify(await h.flow.list(h.owner)),
          workspaceOperationsJson: JSON.stringify(operations),
          // The migration may change ONLY these storage fields in operation JSON.
          workspaceOperationsWithoutKeysJson: JSON.stringify(operations.map(({ pk, sk, ...operation }) => {
            void pk; void sk;
            return operation;
          })),
        });
      };
      await capture("start");
      const drain = async () => {
        for (let round = 0; round < 12; round++) {
          const report = await h.flow.dispatchOnce({ maxMessages: 10 });
          if (report.received === 0) return;
          h.clock.advance(70);
        }
        throw new Error("golden dispatch did not drain");
      };
      await drain();
      await capture("prepare-dispatched");
      const workspace = (await locateWorkspace(h.deps, started.task.workspaceId))?.workspace as unknown as WorkspaceRecord;
      const machineId = workspace.machine!.machineId;
      const prepare = h.machines.delivered(machineId).at(-1)!;
      expect(prepare.kind).toBe("prepare");
      h.machines.finish(machineId, prepare.operationId);
      await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
      await capture("prepare-result");
      await drain();
      await capture("second-dispatched");
      const run = h.machines.delivered(machineId).at(-1)!;
      expect(run).toBeDefined();
      expect(run.kind).toBe("task");
      expect(run.operationId).not.toBe(prepare.operationId);
      expect([prepare.kind, run.kind]).toEqual(["prepare", "task"]);
      h.machines.finish(machineId, run.operationId);
      await h.flow.recordResult({ workspaceId: workspace.id, operationId: run.operationId, fence: 2, status: "SUCCEEDED", outcome: { kind: "ended" } });
      expect((await h.flow.get(h.owner, started.task.taskId)).status).toBe("SUCCEEDED");
      await capture("second-result");
      expect((await h.flow.close(h.owner, started.task.taskId)).status).toBe("CLOSED");
      await capture("closed");
      const actual = `${JSON.stringify({ base: ["2e717e946", "86ed134cacec979a9a0f4a0e4c69771"].join(""), backend, snapshots }, null, 2)}\n`;
      const fixture = fileURLToPath(new URL(`./${backend}.json`, import.meta.url));
      if (process.env.T1_CAPTURE_BASE_GOLDENS === "1") writeFileSync(fixture, `${JSON.stringify(normalizeT1Golden(JSON.parse(actual) as Golden), null, 2)}\n`);
      expect(existsSync(fixture), "base golden must have been captured before migrating production keys").toBe(true);
      const base: unknown = JSON.parse(readFileSync(fixture, "utf8"));
      const normalized = JSON.parse(actual) as Golden;
      const strip = (pk: string) => pk.startsWith(`ORG#${h.deps.companyId}#WORKSPACE#`) || (pk.startsWith(`ORG#${h.deps.companyId}#IDEMPOTENCY#`) && !pk.endsWith("#DEVTASK")) ? pk.slice(`ORG#${h.deps.companyId}#`.length) : pk;
      for (const snapshot of normalized.snapshots) {
        // T1 adds exactly one row the base never had: a new workspace's id-only discovery pointer (WORKSPACE#<id>/META,
        // WORKSPACE_COMPANY_POINTER). It is asserted separately below; every other byte must still match the base capture.
        if (mode !== "legacy") {
          const pointer = (key: DocumentKey) => key.pk.startsWith("WORKSPACE#") && key.sk === "META";
          snapshot.rows = snapshot.rows.filter((row) => !(pointer(row) && row.entityType === "WORKSPACE_COMPANY_POINTER"));
          snapshot.keys = snapshot.keys.filter((key) => !pointer(key));
        }
        for (const row of [...snapshot.keys, ...snapshot.rows]) row.pk = strip(row.pk);
        snapshot.keys.sort((a: DocumentKey, b: DocumentKey) => a.pk.localeCompare(b.pk) || a.sk.localeCompare(b.sk));
        snapshot.rows.sort((a: DocumentKey, b: DocumentKey) => a.pk.localeCompare(b.pk) || a.sk.localeCompare(b.sk));
        snapshot.workspaceOperationsJson = JSON.stringify((JSON.parse(snapshot.workspaceOperationsJson) as DocumentKey[]).map((row: DocumentKey) => ({ ...row, pk: strip(row.pk) })));
      }
      expect(`${JSON.stringify(normalizeT1Golden(normalized), null, 2)}\n`).toBe(`${JSON.stringify(base, null, 2)}\n`);
      for (const snapshot of snapshots) {
        expect(snapshot.rows.some((row) => row.pk.startsWith("WORKSPACE#") && row.entityType !== "WORKSPACE_COMPANY_POINTER")).toBe(mode === "legacy");
        expect(snapshot.rows.some((row) => row.entityType === "WORKSPACE_COMPANY_POINTER")).toBe(mode !== "legacy");
        expect(snapshot.rows.some((row) => row.pk.startsWith(`ORG#${h.deps.companyId}#WORKSPACE#`))).toBe(mode !== "legacy");
      }
    });
  }
});
