// TE-F1c: the laptop's PRODUCT key store: the user's OWN key for the model their product calls in a test, kept in a file of its own (`product-keys.json`, mode 0600, in the model-egress folder of the state folder).
// DECISIONS 157: apart from Rovara's own agent keys (`keys.json`, `local/model-proxy/credentials.ts`, the `ModelKeyStore` port), never read from or written to either. Those were read for their patterns only.
//
// A source is (owner, source id): the owner is the local workspace, the source id is the project's name for one connected key. Errors are fixed words and never carry a key, an id's content, or a file's content.
import { ModelEgressConnectionSchema, MODEL_EGRESS_MIN_KEY_CHARS, assertPlaceableSecret, type ModelEgressConnection } from "@agentx/contracts";
import { ensurePrivateDirectory, readOwnerFile, writeOwnerFile } from "../state-directory.js";
import { join } from "node:path";

export const PRODUCT_KEYS_FILE_NAME = "product-keys.json";
const ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const ROW_ID = /^[a-z][a-z0-9-]{0,39}$/u;
const KEY_CHARS_MAX = 4096;
const FILE_BYTES_MAX = 4 * 1024 * 1024;
const SOURCES_MAX = 500;

export interface ProductKeyEntry {
  /** The catalog row this key is for. A call for another row finds nothing. */
  readonly rowId: string;
  readonly key: string;
  /** A Vertex source's project and location, or an Azure resource's host: what the row cannot say. */
  readonly connection?: ModelEgressConnection;
}

export interface ProductKeyStore {
  get(owner: string, sourceId: string): Promise<ProductKeyEntry | undefined>;
  set(owner: string, sourceId: string, entry: ProductKeyEntry): Promise<void>;
  remove(owner: string, sourceId: string): Promise<boolean>;
  /** Sources without their keys. */
  list(owner: string): Promise<Array<{ readonly sourceId: string; readonly rowId: string }>>;
}

interface Stored { owner: string; source: string; rowId: string; key: string; connection?: ModelEgressConnection }

function checkedEntry(owner: string, sourceId: string, entry: ProductKeyEntry): void {
  if (!ID.test(owner) || !ID.test(sourceId)) throw new Error("not a usable owner or source name");
  if (!ROW_ID.test(entry.rowId)) throw new Error("not a usable model row");
  if (typeof entry.key !== "string" || entry.key.length < MODEL_EGRESS_MIN_KEY_CHARS || entry.key.length > KEY_CHARS_MAX) throw new Error("the key cannot be used: it is too short or too long");
  try {
    assertPlaceableSecret(entry.key);
  } catch {
    throw new Error("the key cannot be used: it holds a character a request cannot carry");
  }
  if (entry.connection !== undefined && !ModelEgressConnectionSchema.safeParse(entry.connection).success) throw new Error("the connection details are not valid");
}

function parseFile(text: string): Map<string, Stored> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the product key file is not readable");
  }
  const sources = typeof parsed === "object" && parsed !== null && (parsed as { version?: unknown }).version === 1 ? (parsed as { sources?: unknown }).sources : undefined;
  if (!Array.isArray(sources) || sources.length > SOURCES_MAX) throw new Error("the product key file is not readable");
  const held = new Map<string, Stored>();
  for (const item of sources as unknown[]) {
    const entry = item as Partial<Stored> | null;
    if (typeof entry !== "object" || entry === null || typeof entry.owner !== "string" || typeof entry.source !== "string" || typeof entry.rowId !== "string" || typeof entry.key !== "string") throw new Error("the product key file is not readable");
    checkedEntry(entry.owner, entry.source, { rowId: entry.rowId, key: entry.key, ...(entry.connection === undefined ? {} : { connection: entry.connection }) });
    held.set(`${entry.owner}\n${entry.source}`, { owner: entry.owner, source: entry.source, rowId: entry.rowId, key: entry.key, ...(entry.connection === undefined ? {} : { connection: entry.connection }) });
  }
  return held;
}

/** The store over a folder (created 0700 when missing). Writes are one at a time; a file write is atomic and mode 0600 from the start. */
export function createProductKeyStore(options: { readonly directory: string }): ProductKeyStore {
  const path = join(options.directory, PRODUCT_KEYS_FILE_NAME);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  async function load(): Promise<Map<string, Stored>> {
    const file = await readOwnerFile(path, { private: true, label: "product key file", maxBytes: FILE_BYTES_MAX });
    return file === undefined ? new Map() : parseFile(file.text);
  }
  async function save(held: Map<string, Stored>): Promise<void> {
    await ensurePrivateDirectory(options.directory);
    await writeOwnerFile(path, `${JSON.stringify({ version: 1, sources: [...held.values()] })}\n`);
  }
  return {
    get: async (owner, sourceId) => {
      if (!ID.test(owner) || !ID.test(sourceId)) return undefined;
      const found = (await load()).get(`${owner}\n${sourceId}`);
      return found === undefined ? undefined : { rowId: found.rowId, key: found.key, ...(found.connection === undefined ? {} : { connection: found.connection }) };
    },
    set: (owner, sourceId, entry) => serial(async () => {
      checkedEntry(owner, sourceId, entry);
      const held = await load();
      if (!held.has(`${owner}\n${sourceId}`) && held.size >= SOURCES_MAX) throw new Error("too many product keys");
      held.set(`${owner}\n${sourceId}`, { owner, source: sourceId, rowId: entry.rowId, key: entry.key, ...(entry.connection === undefined ? {} : { connection: entry.connection }) });
      await save(held);
    }),
    remove: (owner, sourceId) => serial(async () => {
      const held = await load();
      const removed = held.delete(`${owner}\n${sourceId}`);
      if (removed) await save(held);
      return removed;
    }),
    list: async (owner) => [...(await load()).values()].filter((entry) => entry.owner === owner).map((entry) => ({ sourceId: entry.source, rowId: entry.rowId })),
  };
}
