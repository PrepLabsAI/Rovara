import { isSessionCookieSecret } from "./cookie-secret.js";
import { type ClassifiedValue } from "./credential-classifier.js";
import { urlSecrets } from "./request-secrets.js";
import { classifyStorageEntry, classifyStructure } from "./storage-entry-classifier.js";

/**
 * What a browser context holds that may be a login secret, told to a `learn` callback with its tier (MIDSTEP-2): cookies, local storage, session storage, IndexedDB, and the URLs the
 * pages are at. One function for every point the executor reads the browser (sign-in capture, every mid-step sync, case close), so none of them can lag behind another.
 */
export interface BrowserSecretState {
  cookies: ReadonlyArray<{ value: string; httpOnly: boolean }>;
  origins: ReadonlyArray<{
    localStorage: ReadonlyArray<{ name: string; value: string }>;
    sessionStorage?: ReadonlyArray<{ name: string; value: string }>;
    /** Playwright's `storageState({ indexedDB: true })` shape: databases, their object stores, their records (values encoded). */
    indexedDB?: unknown;
  }>;
  /** The URL of every frame of every page, read when the state was. */
  urls?: readonly string[];
}

/** IndexedDB is read whole by the browser driver; the executor accepts it only up to these bounds and otherwise fails closed (the caller's read rejects and no model call is made). */
export const BROWSER_STATE_IDB_MAX_RECORDS = 5_000;
export const BROWSER_STATE_IDB_MAX_BYTES = 4 * 1024 * 1024;

/** A bound of the browser state read was exceeded. Carries a fixed code only, never a value. */
export class BrowserStateCapError extends Error {
  constructor(readonly code: "indexeddb-records" | "indexeddb-bytes" | "indexeddb-shape" | "sessionstorage-size" | "sessionstorage-unreadable") {
    super(`browser state exceeds a fixed bound (${code})`);
    this.name = "BrowserStateCapError";
  }
}

/** Playwright encodes an IndexedDB value as `{o:[{k,v}]}` (object), `{a:[...]}` (array), `{d}` a date, `{ta}` a typed array; strings and numbers are plain. */
function decodeIndexedDbValue(node: unknown, depth = 0): unknown {
  if (depth > 16 || node === null || typeof node !== "object") return typeof node === "string" ? node : null;
  if (Array.isArray(node)) return node.map((item) => decodeIndexedDbValue(item, depth + 1));
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.o)) {
    const out: Record<string, unknown> = {};
    for (const entry of record.o as unknown[]) {
      const pair = entry as { k?: unknown; v?: unknown } | null;
      if (pair !== null && typeof pair === "object" && typeof pair.k === "string") out[pair.k] = decodeIndexedDbValue(pair.v, depth + 1);
    }
    return out;
  }
  if (Array.isArray(record.a)) return record.a.map((item) => decodeIndexedDbValue(item, depth + 1));
  if ("d" in record || "ta" in record || "ab" in record || "n" in record || "bi" in record) return null;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) out[key] = decodeIndexedDbValue(child, depth + 1);
  return out;
}

function tellIndexedDb(indexedDB: unknown, learn: (item: ClassifiedValue) => void): void {
  if (!Array.isArray(indexedDB)) throw new BrowserStateCapError("indexeddb-shape");
  let records = 0;
  let bytes = 0;
  for (const database of indexedDB as Array<{ name?: unknown; stores?: unknown }>) {
    if (database === null || typeof database !== "object" || !Array.isArray(database.stores)) throw new BrowserStateCapError("indexeddb-shape");
    for (const store of database.stores as Array<{ name?: unknown; records?: unknown }>) {
      if (store === null || typeof store !== "object" || !Array.isArray(store.records)) throw new BrowserStateCapError("indexeddb-shape");
      const path = `${typeof database.name === "string" ? database.name : "db"}.${typeof store.name === "string" ? store.name : "store"}`;
      for (const record of store.records as Array<Record<string, unknown>>) {
        records += 1;
        if (records > BROWSER_STATE_IDB_MAX_RECORDS) throw new BrowserStateCapError("indexeddb-records");
        const raw = JSON.stringify(record) ?? "";
        bytes += raw.length;
        if (bytes > BROWSER_STATE_IDB_MAX_BYTES) throw new BrowserStateCapError("indexeddb-bytes");
        const value = decodeIndexedDbValue(record.valueEncoded ?? record.value);
        for (const item of classifyStructure(path, value, () => raw)) learn(item);
        const key = decodeIndexedDbValue(record.keyEncoded ?? record.key);
        if (typeof key === "string") for (const item of classifyStructure(`${path}.key`, key, () => raw)) learn(item);
      }
    }
  }
}

/** Tells `learn` every value of the browser state that is worth registering, with its tier. Throws `BrowserStateCapError` when IndexedDB is over its bounds or unreadable in shape. */
export function tellBrowserState(state: BrowserSecretState, learn: (item: ClassifiedValue) => void): void {
  // Only what looks like a secret: a consent flag is not one (the cookie rule of the sign-in and the sync).
  for (const cookie of state.cookies) if (isSessionCookieSecret(cookie)) learn({ value: cookie.value, tier: "strong" });
  for (const origin of state.origins) {
    for (const entry of origin.localStorage) for (const item of classifyStorageEntry(entry)) learn(item);
    for (const entry of origin.sessionStorage ?? []) for (const item of classifyStorageEntry(entry)) learn(item);
    if (origin.indexedDB !== undefined) tellIndexedDb(origin.indexedDB, learn);
  }
  for (const url of state.urls ?? []) for (const item of urlSecrets(url)) learn(item);
}
