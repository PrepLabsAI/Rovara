import { companyScoped, OrgIdSchema, workspaceProjectIndexValue } from "@agentx/contracts";
import { STATE_TABLE_INDEXES, STATE_TABLE_PLANNED_INDEXES } from "../../../packages/aws-adapters/src/dynamodb/state-table.js";
import { createTransactionalOutbox } from "../../../packages/broker/src/ports/transactional-outbox.js";
import { MemoryQueueService } from "../../../packages/broker/src/ports/memory-queue.js";
import { dispatchPartition } from "../../../packages/broker/src/core/task-flow/keys.js";
import { SHARED_RAW_IDS, type IsolationCompany, type IsolationSurface, type TwoCompanyIsolation } from "../../../packages/testing/src/isolation/two-company.js";
import { dynamoWorld } from "./dynamodb-harness.js";

/** All surfaces share one actual DynamoDocumentStore, its SDK double, and the same raw ids. */
export function dynamoCompanies(mutant?: "store" | "index" | "dispatch-index"): TwoCompanyIsolation {
  const { store } = dynamoWorld({ indexes: [...STATE_TABLE_INDEXES, ...STATE_TABLE_PLANNED_INDEXES] });
  const queues = new MemoryQueueService();
  const outbox = createTransactionalOutbox({ store, queues });
  const key = (me: IsolationCompany, name: string) => ({ pk: mutant === "store" ? name : companyScoped(me.orgId, name), sk: "ITEM#shared" });
  const surfaces: IsolationSurface[] = ["get", "partition", "prefix", "delete"].map((operation) => ({
    name: `document ${operation}`, kind: "read",
    plant: async (me) => {
      await store.put({ item: { ...key(me, operation), marker: me.canary } });
    },
    observe: async (me) => {
      const own = key(me, operation);
      if (operation === "get") return store.get(own);
      if (operation === "partition") return store.query({ pk: own.pk });
      if (operation === "prefix") return store.query({ pk: own.pk, sk: { op: "beginsWith", prefix: "ITEM#" } });
      const before = await store.get(own);
      await store.delete({ key: own });
      if (await store.get(own) !== undefined) throw new Error("delete did not remove own row");
      return before;
    },
  }));
  for (const [index, partitionAttribute, sortAttribute, partition] of [
    ["byWorkspaceProject", "workspaceProject", "workspaceCreatedAt", (me: IsolationCompany) => workspaceProjectIndexValue(OrgIdSchema.parse(me.orgId), SHARED_RAW_IDS.project)],
    ["workflow-dispatch-due", "dispatchDuePk", "dispatchDueSk", (me: IsolationCompany) => dispatchPartition(me.orgId)],
  ] as const) {
    const scope = (me: IsolationCompany) => (mutant === "index" && index === "byWorkspaceProject") || (mutant === "dispatch-index" && index === "workflow-dispatch-due") ? SHARED_RAW_IDS.project : partition(me);
    surfaces.push({ name: index, kind: "list", plant: async (me) => {
      await store.put({ item: { ...key(me, index), marker: me.canary, [partitionAttribute]: scope(me), [sortAttribute]: "2026-11-14" } });
    }, observe: (me) => store.queryIndex({ index, partition: scope(me) }) });
  }
  surfaces.push({ name: "outbox pending and relay", kind: "delivery", plant: async (me) => {
    await store.transact([outbox.stage({ companyId: me.orgId, id: SHARED_RAW_IDS.documentName, queue: SHARED_RAW_IDS.machineKey, body: { marker: me.canary } })]);
  }, observe: async (me) => {
    const pending = await store.queryIndex({ index: "outbox-pending", partition: `PENDING#${me.orgId}` });
    await outbox.relay({ companyId: me.orgId });
    const queue = await queues.queue(SHARED_RAW_IDS.machineKey);
    const messages = await queue.receive({ maxMessages: 10 });
    for (const message of messages) await queue.ack(message.receiptHandle);
    return { pending, messages };
  } });
  return { surfaces };
}
