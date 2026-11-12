// Convergence lane A1: the `storage` plug-in "dynamodb" for the registry. Opt-in: Code's default store stays SQLite, and nothing loads
// this module unless the owner's config names it. Config entry:
//   { "point": "storage", "name": "dynamodb", "module": "@rovara/aws-adapters/dynamodb",
//     "settings": { "tableName": "...", "region": "us-west-2", "indexes": [ ... ], "ttlAttribute": "<the table's time-to-live attribute>" } }
// Credentials come from the AWS SDK's default chain (environment, profile, instance role); the config never holds one. The change feed
// is not configured here: it belongs to the process that reads the table's stream, which builds `DynamoStreamChangeFeed` itself.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DocumentStoreError, OUTBOX_PENDING_INDEX, type IndexDefinition, type JsonObject, type JsonValue, type PluginModule } from "@agentx/contracts";
import { DynamoDocumentStore, type DynamoDbSender } from "./document-store.js";

const SETTINGS = ["tableName", "region", "endpoint", "indexes", "ttlAttribute"] as const;

const refuse = (message: string): DocumentStoreError => new DocumentStoreError("invalid_request", `dynamodb storage settings: ${message}`);

function text(settings: JsonObject, key: string, required: boolean): string | undefined {
  const value = settings[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value === "" || value.length > 1_024) throw refuse(`${key} is non-empty text`);
  return value;
}

/** The indexes from the settings; the outbox's index is always among them, with its fixed shape. */
export function indexesOfSettings(value: JsonValue | undefined): IndexDefinition[] {
  const wanted: IndexDefinition[] = [OUTBOX_PENDING_INDEX];
  if (value === undefined) return wanted;
  if (!Array.isArray(value)) throw refuse("indexes is a list of index definitions");
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw refuse("an index definition is an object");
    const { name, partitionAttribute, sortAttribute, sortType, ...rest } = entry;
    if (Object.keys(rest).length > 0) throw refuse("an index definition has name, partitionAttribute, sortAttribute and sortType only");
    if (typeof name !== "string" || name === "" || typeof partitionAttribute !== "string" || partitionAttribute === "") throw refuse("an index definition needs a name and a partitionAttribute");
    if (sortAttribute !== undefined && (typeof sortAttribute !== "string" || sortAttribute === "")) throw refuse("sortAttribute is text");
    if (sortType !== undefined && sortType !== "string" && sortType !== "number") throw refuse("sortType is string or number");
    const definition: IndexDefinition = { name, partitionAttribute, ...(sortAttribute === undefined ? {} : { sortAttribute }), ...(sortType === undefined ? {} : { sortType }) };
    const same = wanted.find((existing) => existing.name === name);
    if (same === undefined) wanted.push(definition);
    else if (same.name === OUTBOX_PENDING_INDEX.name && JSON.stringify({ sortType: "string", ...same }) === JSON.stringify({ sortType: "string", ...definition })) continue;
    else throw refuse(same.name === OUTBOX_PENDING_INDEX.name ? `the ${name} index is fixed by the outbox` : `two indexes are named ${name}`);
  }
  return wanted;
}

/** Builds the store from settings. `client` replaces the SDK client (tests); otherwise one is made for the region and endpoint given. */
export function createDynamoStoreFromSettings(settings: JsonObject, client?: DynamoDbSender): DynamoDocumentStore {
  for (const key of Object.keys(settings)) if (!(SETTINGS as readonly string[]).includes(key)) throw refuse(`unknown setting ${JSON.stringify(key).slice(0, 40)}`);
  const tableName = text(settings, "tableName", true)!;
  const region = text(settings, "region", false);
  const endpoint = text(settings, "endpoint", false);
  if (endpoint !== undefined && !/^https?:\/\/[^\s/]+(\/.*)?$/.test(endpoint)) throw refuse("endpoint is an http(s) URL");
  const ttl = settings.ttlAttribute;
  if (ttl !== undefined && ttl !== null && (typeof ttl !== "string" || ttl === "")) throw refuse("ttlAttribute is text, or null for none");
  return new DynamoDocumentStore({
    client: client ?? new DynamoDBClient({ ...(region === undefined ? {} : { region }), ...(endpoint === undefined ? {} : { endpoint }) }),
    tableName,
    indexes: indexesOfSettings(settings.indexes),
    ...(typeof ttl === "string" ? { ttlAttribute: ttl } : {}),
  });
}

export const plugin: PluginModule<"storage"> = {
  point: "storage",
  name: "dynamodb",
  create(context) {
    return createDynamoStoreFromSettings(context.settings);
  },
};

export default plugin;
