// Wiki W0: makes a project's file map on request and keeps the last one for a short while. Nothing is stored (W2 is the store). Shared by the hosted route and the laptop's.
//
// The cache is keyed by company AND project, so one project's map (or one company's) can never answer for another. A kept map is served only while the project still names the same repositories (a
// repository added or removed makes it stale at once), and only for `ttlMs`. A second request for the same project while a map is being made joins it, and a map made less than `reuseMs` ago is
// handed back instead of asking the code host again, so a button pressed twice costs one pass.
import { agentXError, type HostScope, type OrgId, type WikiFileMap } from "@agentx/contracts";
import { computeWikiFileMap, type FileMapDeps, type FileMapRepository } from "./file-map.js";

export const WIKI_MAP_TTL_MS = 10 * 60_000;
export const WIKI_MAP_REUSE_MS = 60_000;
export const WIKI_MAP_CACHE_MAX = 200;

/** What names a repository for the cache: its address AND the branch the map reads, so a changed default branch never serves an old map. */
export const repositoryKeyOf = (repository: { url: string; defaultBranch: string }): string => `${repository.url}\u0000${repository.defaultBranch}`;

export interface WikiMapService {
  /** The kept map of this project in this company, if it is fresh and the project's repositories (`repositoryKeyOf`) are the same ones; else undefined. */
  read(companyId: OrgId, project: string, repositoryKeys: readonly string[]): WikiFileMap | undefined;
  /** Makes (or, within `reuseMs`, reuses) the map. `force`: makes a new one even when one was made a moment ago (a map known to be pinned to a commit the branch no longer holds). */
  make(companyId: OrgId, project: string, repositories: readonly FileMapRepository[], scope: HostScope, options?: { force?: boolean }): Promise<WikiFileMap>;
}

// Like W0's cache, map admission is local to this broker process. Separate
// service instances still compete for one company's two slots.
const MAPS_PER_COMPANY = 2;
const activeMaps = new Map<OrgId, number>();

interface Kept { at: number; urls: string; map: WikiFileMap }

const keyOf = (companyId: string, project: string): string => `${companyId}\u0000${project}`;
const urlsOf = (urls: readonly string[]): string => [...urls].sort().join("\n");

export function createWikiMapService(options: { now: () => number; ttlMs?: number; reuseMs?: number; max?: number; log?: ((entry: Record<string, unknown>) => void) | undefined }): WikiMapService {
  const ttlMs = options.ttlMs ?? WIKI_MAP_TTL_MS;
  const reuseMs = options.reuseMs ?? WIKI_MAP_REUSE_MS;
  const max = options.max ?? WIKI_MAP_CACHE_MAX;
  const kept = new Map<string, Kept>();
  const running = new Map<string, Promise<WikiFileMap>>();
  const fresh = (entry: Kept | undefined, urls: string, within: number): entry is Kept => entry !== undefined && entry.urls === urls && options.now() - entry.at < within;
  return {
    read(companyId, project, repositoryKeys) {
      const entry = kept.get(keyOf(companyId, project));
      return fresh(entry, urlsOf(repositoryKeys), ttlMs) ? entry.map : undefined;
    },
    async make(companyId, project, repositories, scope, makeOptions) {
      const key = keyOf(companyId, project);
      const urls = urlsOf(repositories.map(repositoryKeyOf));
      const existing = kept.get(key);
      if (makeOptions?.force !== true && fresh(existing, urls, reuseMs)) return existing.map;
      const joined = running.get(`${key}\u0000${urls}`);
      if (joined !== undefined) return joined;
      const active = activeMaps.get(companyId) ?? 0;
      if (active >= MAPS_PER_COMPANY) throw agentXError("WORKSPACE_BUSY", "Two file maps are already running for this company. Try again shortly.");
      activeMaps.set(companyId, active + 1);
      const deps: FileMapDeps = { scope, now: options.now, ...(options.log === undefined ? {} : { log: options.log }) };
      const work = computeWikiFileMap({ project, repositories }, deps).then((map) => {
        kept.delete(key);
        kept.set(key, { at: options.now(), urls, map });
        while (kept.size > max) kept.delete(kept.keys().next().value!);
        return map;
      }).finally(() => {
        running.delete(`${key}\u0000${urls}`);
        const left = (activeMaps.get(companyId) ?? 1) - 1;
        if (left === 0) activeMaps.delete(companyId);
        else activeMaps.set(companyId, left);
      });
      running.set(`${key}\u0000${urls}`, work);
      return work;
    },
  };
}
