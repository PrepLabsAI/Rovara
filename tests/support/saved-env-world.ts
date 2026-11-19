// A SavedEnvDeps for tests of the saved environment rules and their wiring (handlers, triggers, panel): the memory store, an image registry made of plain functions, and the registry's own rules.
import { ImageRegistryError, SavedEnvRegistryAuthSchema, savedEnvRepositoryName, type ImageRegistry, type RegistryImage, type RepositoryState, type SavedEnvManifest } from "../../packages/contracts/src/index.js";
import type { SavedEnvDeps, SavedEnvImageRecord, SavedEnvState } from "../../packages/broker/src/core/test-env/saved-env.js";
import type { SavedEnvSessionConfig, SavedEnvSessionPorts } from "../../packages/broker/src/core/test-env/saved-env-session.js";
import { memorySavedEnvStore } from "./memory-saved-env-store.js";

export const DAY = 86_400_000;
export const T0 = Date.parse("2026-11-02T12:00:00Z");
export const APPROVED = { revision: 4, digest: "a".repeat(64) };
export const KEY = "c".repeat(64);
export const COMMIT = "f".repeat(40);
export const REGISTRY_HOST = "127.0.0.1:5999";
export const iso = (ms: number): string => new Date(ms).toISOString();
export const dig = (n: number): string => `sha256:${String(n).repeat(64)}`;

export const manifestOf = (over: Partial<SavedEnvManifest> = {}): SavedEnvManifest => ({
  schemaVersion: 1, environmentKey: KEY, testEnvRevision: 4, commits: [{ repositoryId: "svc", sha: COMMIT }], proveReportDigest: "b".repeat(64), imageDigest: dig(1), builtAt: iso(T0), ...over,
});
export const imageOf = (digest: string, over: Partial<SavedEnvImageRecord> = {}): SavedEnvImageRecord => ({ approved: APPROVED, digest, tag: `k-${digest.slice(7, 12)}`, manifest: manifestOf({ imageDigest: digest }), recordedAt: iso(T0), status: "ready", ...over });

export interface WorldOptions {
  ids?: { orgId: string; projectId: string };
  enabled?: boolean; approved?: typeof APPROVED | undefined; key?: string | undefined; heads?: Map<string, string> | undefined; now?: number; images?: RegistryImage[];
  /** What the registry says of the project's repository. Default `matches`. */
  state?: RepositoryState;
  /** Calls of the registry to replace (an error to throw, an answer to give). */
  registry?: Partial<ImageRegistry>;
  capabilities?: Partial<ImageRegistry["capabilities"]>;
  keep?: number; proveHolds?: boolean;
}

export function savedEnvWorld(over: WorldOptions = {}) {
  const ids = over.ids ?? { orgId: "org-1", projectId: "proj-1" };
  const clock = { now: over.now ?? T0 };
  const store = memorySavedEnvStore(() => clock.now);
  const config: SavedEnvSessionConfig = { enabled: over.enabled ?? true, env: "test" };
  const state = { approved: "approved" in over ? over.approved : APPROVED, key: "key" in over ? over.key : KEY, heads: "heads" in over ? over.heads : new Map([["svc", COMMIT]]) as Map<string, string> | undefined };
  const logins: Array<{ repository: string; access: "push" | "pull"; maxSeconds: number }> = [];
  const calls = { deleted: [] as string[][], repoDeleted: 0, scans: [] as string[], listed: 0, inspected: 0, reached: 0, repositories: [] as string[] };
  const touch = (call: { repository: string }): void => { calls.reached += 1; calls.repositories.push(call.repository); };
  const registry: ImageRegistry = {
    capabilities: { workerPush: true, workerPull: true, scan: true, ...over.capabilities },
    async inspect(call) { touch(call); calls.inspected += 1; return over.state ?? "matches"; },
    async login(call) {
      touch(call);
      if (over.state === "unusable") throw new ImageRegistryError("unavailable", "no");
      logins.push({ repository: call.repository, access: call.access, maxSeconds: call.maxSeconds });
      const expiresAtMs = clock.now + call.maxSeconds * 1000;
      return { auth: SavedEnvRegistryAuthSchema.parse({ registry: REGISTRY_HOST, repository: call.repository, username: "rovara-local", password: "p".repeat(30), expiresAt: iso(expiresAtMs) }), expiresAtMs };
    },
    async list(call) { touch(call); calls.listed += 1; return over.images ?? []; },
    async deleteImages(call) { touch(call); calls.deleted.push([...call.digests]); },
    async deleteRepository(call) { touch(call); calls.repoDeleted += 1; return "deleted" as const; },
    async startScan(call) { touch(call); calls.scans.push(call.digest); },
    ...over.registry,
  };
  const ports: SavedEnvSessionPorts = {
    registry,
    async readApproved() { return state.approved; },
    async proveHolds() { return over.proveHolds ?? true; },
    now: () => clock.now,
  };
  let counter = 0;
  const deps: SavedEnvDeps = {
    store, session: { config, ports },
    approved: async () => state.approved,
    currentKey: async () => state.key,
    defaultHeads: async () => state.heads,
    keep: async () => over.keep ?? 3,
    now: () => clock.now,
    random: () => { counter += 1; return `${String(counter).padStart(2, "0")}`.repeat(24); },
  };
  const repository = savedEnvRepositoryName({ env: "test", orgId: ids.orgId, projectId: ids.projectId });
  const seed = (change: Partial<SavedEnvState>): void => { store.rows.set(`${ids.orgId}#${ids.projectId}`, { orgId: ids.orgId, projectId: ids.projectId, version: 1, enabled: true, images: [], health: "never_proved", ...change }); };
  const row = (): SavedEnvState | undefined => store.rows.get(`${ids.orgId}#${ids.projectId}`);
  return { deps, store, clock, logins, calls, registry, ids, repository, seed, row, state };
}
