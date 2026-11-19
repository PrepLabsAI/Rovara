// Port lane P6 (item B1): the worker's build-system profiles. Read ONCE at boot from `ROVARA_BUILD_SYSTEMS` (set by whoever starts the worker: the machine launcher, from the registered
// `build-system` adapters), never from a job or a repository. A value that cannot be read stops the worker at boot (fail closed: a profile half applied would key environments and group setup
// steps differently from the broker). The profiles then reach the two worker lists they extend: the detector pass (`env-detect/guarded.ts` reads the modules) and the setup governor's list of programs
// (`setup-agent-journal.ts`). The key-file globs are not used here: the broker passes them in the job's `detectorGlobs`.
import {
  BUILD_SYSTEM_PROFILES_ENV,
  buildSystemDetectorModules,
  buildSystemSetupPrograms,
  parseBuildSystemProfiles,
  type BuildSystemProfile,
} from "@agentx/contracts";
import { setExtraSubcommandPrograms } from "./setup-agent-journal.js";

let installed: readonly BuildSystemProfile[] = [];

/** Reads and applies the profiles in `environment`. Returns them. Throws a plain error (no value quoted) when the variable is not valid. */
export function installBuildSystemProfiles(environment: NodeJS.ProcessEnv = process.env): readonly BuildSystemProfile[] {
  const profiles = parseBuildSystemProfiles(environment[BUILD_SYSTEM_PROFILES_ENV]);
  installed = profiles;
  setExtraSubcommandPrograms(buildSystemSetupPrograms(profiles));
  return profiles;
}

export function installedBuildSystemProfiles(): readonly BuildSystemProfile[] {
  return installed;
}

/** The detector modules of the installed profiles. */
export function installedDetectorModules(): string[] {
  return buildSystemDetectorModules(installed);
}
