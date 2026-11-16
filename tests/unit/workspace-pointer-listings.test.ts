import { expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createHarness } from "../support/task-flow-harness.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { listTasks, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { queryAllItems } from "../../packages/broker/src/aws/admin-reads.js";
import { outboxCompaniesOf } from "../../packages/broker/src/aws/core-outbox-stream.js";
import { indexActivity } from "../../packages/broker/src/aws/activity-index.js";
import { readStream } from "../../packages/broker/src/developer/notifications.js";
import { marshall } from "@aws-sdk/util-dynamodb";

const companyId = IMPLICIT_COMPANY_ID;
const pointer = { pk: "WORKSPACE#pointer-canary", sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: "pointer-canary", companyId };
it("workspace operation lists omit discovery pointers in a returned store page", async () => {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...workspaceKey(companyId, "ws"), companyId } });
  vi.spyOn(store, "query").mockResolvedValue({ items: [pointer] });
  expect(await workspaceOperations({ store, companyId }, "ws")).toEqual([]);
});
it("task lists omit discovery pointers in a returned store page", async () => {
  const h = createHarness();
  vi.spyOn(h.store, "query").mockResolvedValue({ items: [{ ...pointer, orgId: companyId }] });
  expect((await listTasks(h.deps, h.owner)).tasks).toEqual([]);
});
it("admin partition enumeration never returns a discovery pointer", async () => {
  const deps = { tableName: "state", documentClient: { send: async () => ({ Items: [pointer] }) } };
  expect(await queryAllItems(deps as never, pointer.pk, "META")).toEqual([]);
});
it("State change feeds never relay or index a discovery pointer", async () => {
  const record = { eventSource: "aws:dynamodb", eventName: "INSERT", dynamodb: { SequenceNumber: "1", NewImage: marshall(pointer) } };
  expect(outboxCompaniesOf({ Records: [record] })).toEqual([]);
  expect(readStream([record])).toEqual({ notices: [], skipped: [] });
  const store = { get: vi.fn(), put: vi.fn() };
  expect(await indexActivity([record], store, vi.fn())).toEqual({ failures: 0, usage: 0, failed: 0 });
  expect(store.get).not.toHaveBeenCalled();
  expect(store.put).not.toHaveBeenCalled();
});
