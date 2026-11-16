import { afterEach, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { locateWorkspace } from "../../packages/broker/src/core/task-flow/workspace-location.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { readSavedEnvOperation, countOperationAttribute } from "../../packages/broker/src/core/test-env/saved-env-operations.js";
import { readTaskTokenRecords } from "../../packages/broker/src/core/model-gateway/records.js";

const A = IMPLICIT_COMPANY_ID, B = "org_bbbbbbbbbbbbbbbbbbbb";
afterEach(() => vi.restoreAllMocks());
for (const companyId of [A, B]) {
  for (const scoped of [undefined, { companyId: A === companyId ? B : A }, { companyId, orgId: A === companyId ? B : A }]) {
    it(`refuses and logs exactly once through every operation reader: ${companyId}, ${JSON.stringify(scoped)}`, async () => {
      const store = new MemoryDocumentStore();
      await store.put({ item: { pk: "WORKSPACE#ws", sk: "META", entityType: "WORKSPACE_COMPANY_POINTER", workspaceId: "ws", companyId } });
      if (scoped !== undefined) await store.put({ item: { ...workspaceKey(companyId, "ws"), ...scoped } });
      const deps = { store, companyId };
      const calls = [
        async () => expect(await locateWorkspace(deps, "ws")).toBeUndefined(),
        async () => expect(await readOperation(deps, "ws", "op")).toBeUndefined(),
        async () => expect(await workspaceOperations(deps, "ws")).toEqual([]),
        async () => expect(readSavedEnvOperation(store, companyId, "ws", "op")).rejects.toMatchObject({ code: "NOT_FOUND" }),
        async () => expect(await countOperationAttribute(store, companyId, "ws", "op", "count", 1)).toBe(false),
        async () => expect(readTaskTokenRecords(deps, { workspaceId: "ws", operationId: "op", fence: 1 })).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" }),
      ];
      const integrity = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const query = vi.spyOn(store, "query");
      for (const call of calls) {
        integrity.mockClear();
        await call();
        expect(integrity.mock.calls).toEqual([[{ component: "broker", event: "workspace.pointer_integrity" }]]);
      }
      expect(query).not.toHaveBeenCalled();
    });
  }
}
