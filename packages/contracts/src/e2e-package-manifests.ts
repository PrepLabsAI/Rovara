import type { E2ESourceSnapshot } from "./e2e-source.js";

type SnapshotSource = E2ESourceSnapshot["sources"][number];

/** Paths the runner never reads as source, whatever their content. */
export const e2eRunnerUnsafePath = /(^|\/)(?:\.env(?:\..*)?|secrets?|credentials?|.*(?:token|password|private[-_]?key).*)$/i;

/**
 * The package manifests discovery and the project-contract reader both treat as owning an application.
 * One definition keeps their same-name counts, and so their derived application identities, in agreement.
 */
export function e2ePackageManifests(sources: Iterable<SnapshotSource>): SnapshotSource[] {
  return [...sources].filter((source) => source.kind === "blob" && /(^|\/)package\.json$/.test(source.path) && !e2eRunnerUnsafePath.test(source.path))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** Lossy UTF-8 decode, as discovery has always read manifests; it throws only on invalid JSON. */
export function parseE2EPackageManifest(source: SnapshotSource): unknown {
  return JSON.parse(Buffer.from(source.bytes).toString("utf8"));
}
