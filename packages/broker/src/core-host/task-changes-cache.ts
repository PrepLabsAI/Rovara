// RD-2b2: a short cache with single-flight for the pull request pages the Changes read asks the code host for. Every page is a call on the repository owner's GitHub App installation (shared with builds and PR feedback), so a tab that
// reloads must not multiply them. It is only ever asked AFTER the caller's access to the task and to source code were decided (core-host/task-changes-routes.ts); its key names the task and the pull request's head, so a new push is a
// new key. Only a page that was read is kept: a failure is never remembered (the next ask tries again), and a page that is still loading is shared by whoever asks meanwhile.
interface Entry<T> { at: number; value?: T; pending?: Promise<T | undefined> }

export interface PageCache {
  once<T>(key: string, load: () => Promise<T | undefined>): Promise<T | undefined>;
}

export function createPageCache(options: { ttlMs: number; max: number; now?: () => number }): PageCache {
  const entries = new Map<string, Entry<unknown>>();
  const now = options.now ?? Date.now;
  return {
    async once<T>(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
      const found = entries.get(key) as Entry<T> | undefined;
      if (found?.pending !== undefined) return found.pending;
      if (found?.value !== undefined && now() - found.at < options.ttlMs) return found.value;
      const pending = load().catch(() => undefined);
      entries.set(key, { at: now(), pending });
      const value = await pending;
      if (value === undefined) entries.delete(key);
      else entries.set(key, { at: now(), value });
      // The oldest entries go first once the cache is full (Map keeps insertion order).
      for (const oldest of entries.keys()) {
        if (entries.size <= options.max) break;
        entries.delete(oldest);
      }
      return value;
    },
  };
}
