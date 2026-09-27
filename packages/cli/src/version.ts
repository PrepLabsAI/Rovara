// The release version pack-cli bakes in with esbuild's define. A plain tsc build from source has
// no define; typeof on an undeclared identifier never throws, so it falls through to undefined.
declare const __AGENTX_VERSION__: string | undefined;

/** The release this CLI was packed from (pack-cli's esbuild define); undefined for a build from source. */
export const RELEASE_VERSION: string | undefined = typeof __AGENTX_VERSION__ === "string" ? __AGENTX_VERSION__ : undefined;

export const CLI_VERSION = RELEASE_VERSION ?? "0.1.0";

/**
 * True when `version` carries a semver prerelease suffix (e.g. "1.2.3-beta.1"), the same shape
 * ReleaseManifestSchema accepts for release.json's `version` field. `init` calls this on the
 * loaded release's version right after the release loads, before the plan is confirmed, and
 * refuses to continue with a prerelease build.
 */
export function isPrereleaseVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}
