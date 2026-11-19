// Port lane P6 (item B1): what the broker does with the `build-system` point. It asks every registered adapter for its profile, checks it, and hands the result to the two places that need it:
// the machine launcher (the detector modules and setup programs go to the worker's start-up environment, `ROVARA_BUILD_SYSTEMS`) and the saved-environment key (the key-file globs go into the job's
// `detectorGlobs` and into the broker's own key, so both sides hash the same files). See `packages/contracts/src/ports/build-system.ts`.
import {
  BuildSystemProfileSchema,
  PluginRegistryError,
  buildSystemKeyFileGlobs,
  type BuildSystemProfile,
  type RegistryView,
} from "@agentx/contracts";

/**
 * The profile of every `build-system` adapter in the registry, in name order. A profile that is not valid, or whose name is not the name the adapter is registered under, is a configuration fault
 * and throws (the machine does not start with a build system half described). No adapter registered: `[]`.
 */
export async function collectBuildSystemProfiles(registry: Pick<RegistryView, "get" | "names">): Promise<BuildSystemProfile[]> {
  const profiles: BuildSystemProfile[] = [];
  for (const name of [...registry.names("build-system")].sort()) {
    const adapter = registry.get("build-system", name);
    if (adapter === undefined) continue;
    let answer: unknown;
    try {
      answer = await adapter.profile();
    } catch {
      throw new PluginRegistryError("create_failed", `the build-system adapter ${name} could not give its profile`);
    }
    const parsed = BuildSystemProfileSchema.safeParse(answer);
    if (!parsed.success) throw new PluginRegistryError("bad_module", `the build-system adapter ${name} gave a profile that is not valid: ${parsed.error.issues.slice(0, 2).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
    if (parsed.data.name !== name) throw new PluginRegistryError("bad_module", `a build-system adapter's profile must carry the name it is registered under (${name})`);
    profiles.push(parsed.data);
  }
  return profiles;
}

/**
 * The globs a saved-environment key and a job's `detectorGlobs` carry: what the detectors found (`Detection.fullSuiteOn`) plus every build system's key files, without repeats. The job schema allows 200.
 * Throws when they would not fit, because a key over fewer files is a wrong key (fail closed, like the key itself).
 */
export function detectorGlobsWithBuildSystems(detectorGlobs: readonly string[], profiles: readonly BuildSystemProfile[]): string[] {
  const merged = [...new Set([...detectorGlobs, ...buildSystemKeyFileGlobs(profiles)])];
  if (merged.length > 200) throw new PluginRegistryError("bad_config", "the detectors' globs and the build systems' key files are more than a saved-environment job can carry (200)");
  return merged;
}
