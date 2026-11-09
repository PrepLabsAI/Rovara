// Port lane L3: the `storage` plug-in "sqlite" for the W0 registry. Config entry:
//   { "point": "storage", "name": "sqlite", "module": "@agentx/local-adapters/storage",
//     "settings": { "path": ".rovara/state.db", "indexes": [ ... ], "ttlAttribute": "expiresAt" } }
// Not wired into the broker here: lane L4 loads it.
import { OUTBOX_PENDING_INDEX, type IndexDefinition, type JsonValue, type PluginModule } from "@agentx/contracts";
import { allowOnly, databasePath, optionalNumber, SettingsError, synchronousSetting } from "./settings.js";
import { SqliteDocumentStore } from "./sqlite-document-store.js";

const SETTINGS = ["path", "busyTimeoutMs", "synchronous", "indexes", "ttlAttribute", "sweepIntervalMs", "changeFeed"] as const;

function indexesOf(value: JsonValue | undefined): IndexDefinition[] {
  const wanted: IndexDefinition[] = [OUTBOX_PENDING_INDEX];
  if (value === undefined) return wanted;
  if (!Array.isArray(value)) throw new SettingsError("indexes is a list of index definitions");
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new SettingsError("an index definition is an object");
    const { name, partitionAttribute, sortAttribute, sortType, ...rest } = entry;
    if (Object.keys(rest).length > 0) throw new SettingsError("an index definition has name, partitionAttribute, sortAttribute and sortType only");
    if (typeof name !== "string" || typeof partitionAttribute !== "string") throw new SettingsError("an index definition needs a name and a partitionAttribute");
    if (sortAttribute !== undefined && typeof sortAttribute !== "string") throw new SettingsError("sortAttribute is text");
    if (sortType !== undefined && sortType !== "string" && sortType !== "number") throw new SettingsError("sortType is string or number");
    const definition: IndexDefinition = {
      name,
      partitionAttribute,
      ...(sortAttribute === undefined ? {} : { sortAttribute }),
      ...(sortType === undefined ? {} : { sortType }),
    };
    const same = wanted.find((existing) => existing.name === name);
    if (same === undefined) wanted.push(definition);
    else if (same.name === OUTBOX_PENDING_INDEX.name && JSON.stringify(same) === JSON.stringify(definition)) continue;
    else throw new SettingsError(same.name === OUTBOX_PENDING_INDEX.name ? `the ${name} index is fixed by the outbox` : `two indexes are named ${name}`);
  }
  return wanted;
}

export const plugin: PluginModule<"storage"> = {
  point: "storage",
  name: "sqlite",
  create(context) {
    const settings = context.settings;
    allowOnly(settings, SETTINGS);
    // Absent: `expiresAt`. `null`: no expiry at all.
    const ttl = settings.ttlAttribute === undefined ? "expiresAt" : settings.ttlAttribute;
    if (ttl !== null && typeof ttl !== "string") throw new SettingsError("ttlAttribute is text, or null for no expiry");
    const busyTimeoutMs = optionalNumber(settings, "busyTimeoutMs", 0, 600_000);
    const synchronous = synchronousSetting(settings);
    const sweepIntervalMs = optionalNumber(settings, "sweepIntervalMs", 0, 86_400_000);
    const feed = settings.changeFeed;
    if (feed !== undefined && feed !== false && (typeof feed !== "object" || feed === null || Array.isArray(feed))) throw new SettingsError("changeFeed is false or an object");
    let changeFeed: false | { pollMs?: number; retryDelayMs?: number; maxAttempts?: number; batchSize?: number } | undefined;
    if (feed === false) changeFeed = false;
    else if (feed !== undefined) {
      allowOnly(feed, ["pollMs", "retryDelayMs", "maxAttempts", "batchSize"]);
      const pollMs = optionalNumber(feed, "pollMs", 1, 3_600_000);
      const retryDelayMs = optionalNumber(feed, "retryDelayMs", 1, 60_000);
      const maxAttempts = optionalNumber(feed, "maxAttempts", 1, 1_000);
      const batchSize = optionalNumber(feed, "batchSize", 1, 1_000);
      changeFeed = {
        ...(pollMs === undefined ? {} : { pollMs }),
        ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        ...(batchSize === undefined ? {} : { batchSize }),
      };
    }
    return SqliteDocumentStore.open({
      path: databasePath(settings),
      indexes: indexesOf(settings.indexes),
      ...(ttl === null ? {} : { ttlAttribute: ttl }),
      // The plug-in's config owns the file's layout: a new index in the config is built at the next start.
      migrate: true,
      nowSeconds: () => Math.floor(context.now().getTime() / 1_000),
      ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
      ...(synchronous === undefined ? {} : { synchronous }),
      ...(sweepIntervalMs === undefined ? {} : { sweepIntervalMs }),
      ...(changeFeed === undefined ? {} : { changeFeed }),
    });
  },
};

export default plugin;
