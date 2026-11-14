// Convergence lane A1: the hosted product's State table, as the DynamoDB document store sees it. Data, not infrastructure: the table
// and its indexes are created by the hosted product's own deployment code, which stays private; nothing here creates or changes AWS.
import {
  OUTBOX_PENDING_INDEX,
  WORKFLOW_DISPATCH_DUE_INDEX,
  WORKSPACE_PROJECT_INDEX,
  WORKSPACE_SESSION_STATE_INDEX,
  type IndexDefinition,
} from "@agentx/contracts";

/**
 * The table's key schema: partition key `pk` (text) and sort key `sk` (text), the attributes the port's `DocumentKey` names. The
 * stream view must be NEW_AND_OLD_IMAGES (the change feed needs both images).
 */
export const STATE_TABLE_KEY = { partitionKey: "pk", sortKey: "sk", streamView: "NEW_AND_OLD_IMAGES" } as const;

// The table's time-to-live attribute is not named here: the hosted deployment owns it and passes it as the store's `ttlAttribute` setting.

/** The global secondary indexes the State table has today, each projecting every attribute, all keyed on text. */
export const STATE_TABLE_INDEXES: readonly IndexDefinition[] = Object.freeze([
  { name: WORKSPACE_SESSION_STATE_INDEX.name, partitionAttribute: WORKSPACE_SESSION_STATE_INDEX.partitionKey, sortAttribute: WORKSPACE_SESSION_STATE_INDEX.sortKey, sortType: "string" },
  { name: WORKSPACE_PROJECT_INDEX.name, partitionAttribute: WORKSPACE_PROJECT_INDEX.partitionKey, sortAttribute: WORKSPACE_PROJECT_INDEX.sortKey, sortType: "string" },
  { name: "github-webhook-recovery", partitionAttribute: "webhookRecoveryPk", sortAttribute: "webhookRecoverySk", sortType: "string" },
  { name: WORKFLOW_DISPATCH_DUE_INDEX.name, partitionAttribute: WORKFLOW_DISPATCH_DUE_INDEX.partitionKey, sortAttribute: WORKFLOW_DISPATCH_DUE_INDEX.sortKey, sortType: "string" },
]);

/**
 * The index the port's transactional outbox reads (`OUTBOX_PENDING_INDEX`): a sparse global secondary index, partition `outboxState`
 * (text), sort `outboxStagedAt` (text), projecting every attribute. The State table does not have it yet; adding it is a change to the
 * hosted deployment (an owner gate), not made here. Until it exists a query of it is refused by DynamoDB (`invalid_request`).
 */
export const STATE_TABLE_PLANNED_INDEXES: readonly IndexDefinition[] = Object.freeze([OUTBOX_PENDING_INDEX]);
