// The public AWS adapters of Rovara Code (owner decision 72, O2): generic adapters on Code's ports, opt-in, never the default.
// Lane A1: the DynamoDB document store and its change feed.
export { DynamoDocumentStore, portError, type DynamoDbCommand, type DynamoDbSender, type DynamoDocumentStoreOptions } from "./dynamodb/document-store.js";
export { ConsumerNotReadyError, DynamoStreamChangeFeed, SEQUENCE_WIDTH, changeOfRecord, type DynamoStreamChangeFeedOptions, type DynamoStreamRecord } from "./dynamodb/change-feed.js";
export { CLOUD_READABLE_NUMBER_MAX, UnrepresentableValueError, assertCloudReadableNumbers, fromWire, fromWireItem, toWire, toWireItem, type WireItem, type WireValue } from "./dynamodb/attribute-values.js";
export { ExpressionBuilder } from "./dynamodb/expressions.js";
export { STATE_TABLE_INDEXES, STATE_TABLE_KEY, STATE_TABLE_PLANNED_INDEXES } from "./dynamodb/state-table.js";
export { createDynamoStoreFromSettings, indexesOfSettings } from "./dynamodb/plugin.js";
// Lane A3: S3 objects and Secrets Manager secrets. Their plug-in modules (which give them an AWS identity) are in the broker: `@agentx/broker/plugins/object-storage-s3`, `@agentx/broker/plugins/secrets-aws`.
export * from "./s3/index.js";
export * from "./secrets-manager/index.js";
