import { BrowserStateCapError, type BrowserSecretState } from "./browser-state-secrets.js";

/**
 * Reads everything a browser context keeps that may be a login secret (MIDSTEP-2): Playwright's storage state (cookies, local storage, IndexedDB) plus what it does not give,
 * session storage (read in every frame of every page, over the page's own origin) and the URLs the frames are at.
 *
 * Fail closed: a frame of the application's origin whose session storage cannot be read (twice), or that holds more than the bounds below, rejects the whole read. The caller (the session sync)
 * then makes no model call. IndexedDB is read whole by the driver and checked against its bounds by `tellBrowserState`.
 */
export interface BrowserFrameLike { url(): string; evaluate(expression: string): Promise<unknown> }
export interface BrowserContextLike<Cookie extends { value: string; httpOnly: boolean } = { value: string; httpOnly: boolean }> {
  storageState(options?: { indexedDB?: boolean }): Promise<{
    cookies: ReadonlyArray<Cookie>;
    origins: ReadonlyArray<{ origin: string; localStorage: ReadonlyArray<{ name: string; value: string }>; indexedDB?: unknown }>;
  }>;
  pages(): ReadonlyArray<{ frames(): ReadonlyArray<BrowserFrameLike> }>;
}

export const SESSION_STORAGE_MAX_ENTRIES = 2_000;
export const SESSION_STORAGE_MAX_CHARS = 4 * 1024 * 1024;

// Runs in the page (a string: this package is compiled without the DOM types). Reads its own origin's session storage within the bounds, so a huge store is never copied out.
const READ_SESSION_STORAGE = `(() => {
  const entries = [];
  let chars = 0;
  for (let index = 0; index < sessionStorage.length; index += 1) {
    const name = sessionStorage.key(index);
    if (name === null) continue;
    const value = sessionStorage.getItem(name) ?? "";
    chars += name.length + value.length;
    if (entries.length >= ${SESSION_STORAGE_MAX_ENTRIES} || chars > ${SESSION_STORAGE_MAX_CHARS}) return { over: true, origin: location.origin, entries: [] };
    entries.push({ name, value });
  }
  return { over: false, origin: location.origin, entries };
})()`;

interface SessionStorageAnswer { over: boolean; origin: string; entries: Array<{ name: string; value: string }> }
function isAnswer(value: unknown): value is SessionStorageAnswer {
  if (value === null || typeof value !== "object") return false;
  const answer = value as Partial<SessionStorageAnswer>;
  return typeof answer.over === "boolean" && typeof answer.origin === "string" && Array.isArray(answer.entries)
    && answer.entries.every((entry) => entry !== null && typeof entry === "object" && typeof entry.name === "string" && typeof entry.value === "string");
}

async function readFrameSessionStorage(frame: BrowserFrameLike): Promise<SessionStorageAnswer> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const answer = await frame.evaluate(READ_SESSION_STORAGE);
      if (isAnswer(answer)) return answer;
    } catch { /* a frame in the middle of a navigation: tried once more */ }
  }
  throw new BrowserStateCapError("sessionstorage-unreadable");
}

/** The browser state with each cookie as the driver gave it (the sign-in keeps them whole) and each origin named. */
export type ReadBrowserState<Cookie extends { value: string; httpOnly: boolean }> = BrowserSecretState & {
  cookies: ReadonlyArray<Cookie>;
  origins: ReadonlyArray<{ origin: string; localStorage: ReadonlyArray<{ name: string; value: string }>; sessionStorage: ReadonlyArray<{ name: string; value: string }>; indexedDB?: unknown }>;
  urls: readonly string[];
};

export async function readBrowserState<Cookie extends { value: string; httpOnly: boolean }>(context: BrowserContextLike<Cookie>): Promise<ReadBrowserState<Cookie>> {
  const state = await context.storageState({ indexedDB: true });
  const origins = new Map<string, { origin: string; localStorage: Array<{ name: string; value: string }>; sessionStorage: Array<{ name: string; value: string }>; indexedDB?: unknown }>();
  for (const item of state.origins) {
    origins.set(item.origin, { origin: item.origin, localStorage: [...item.localStorage], sessionStorage: [], ...(item.indexedDB === undefined ? {} : { indexedDB: item.indexedDB }) });
  }
  const urls: string[] = [];
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      const url = frame.url();
      urls.push(url);
      // A blank, data or error frame has no origin of the application's; only an http(s) frame is asked.
      if (!/^https?:\/\//i.test(url)) continue;
      const answer = await readFrameSessionStorage(frame);
      if (answer.over) throw new BrowserStateCapError("sessionstorage-size");
      const existing = origins.get(answer.origin) ?? { origin: answer.origin, localStorage: [], sessionStorage: [] };
      existing.sessionStorage.push(...answer.entries);
      origins.set(answer.origin, existing);
    }
  }
  return { cookies: state.cookies, origins: [...origins.values()], urls };
}
