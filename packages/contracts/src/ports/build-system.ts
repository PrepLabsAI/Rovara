// Port lane P6 (item B1, owner decision 60): the `build-system` plug-in point's interface.
//
// A build system is a way of building and testing code that Rovara's built-in detectors do not know (an in-house tool, a monorepo manager). Three lists in the worker were fixed and a plug-in had to
// edit them by hand: the detectors (`env-detect`), the programs whose first words name a setup step (`setup-agent-journal.ts`), and the files that key a saved environment
// (`saved-env-key-files.ts`). A build-system adapter now supplies all three as a PROFILE:
//   - `detectorModule`: a module, installed in the worker's image, that exports detectors (see the worker's `env-detect/plugin-detectors.ts`). The worker adds them AFTER the built-in ones.
//   - `setupPrograms`: extra program names the setup governor groups into steps (`bazel build x` and `bazel build y` are two steps, not one).
//   - `keyFileGlobs`: extra files whose content decides what a saved environment holds.
//
// How the profile reaches the worker (and why it is not in the job): the profile is the OPERATOR's, like the worker image. A job comes from the broker for one task, and a module path in it would make
// every job able to name code the worker loads. So the machine launcher hands the profiles to the worker process at start, in the environment variable `ROVARA_BUILD_SYSTEMS`
// (`serializeBuildSystemProfiles`), where a project, a task or a repository cannot set it (the launcher reserves the name). The worker reads it once at boot and refuses to start on a profile
// it cannot read. The one part both sides must agree on is the key files: the broker passes `keyFileGlobs` in the job's existing `detectorGlobs` (`buildSystemKeyFileGlobs`) and uses the same
// list for its own key, so the worker needs no copy of them and the two keys cannot differ. No job line is added or changed.
//
// Neutral by design: nothing here names a build tool; the internal build-system detector stays an optional plug-in package outside the core (decision 45.11).
import { z } from "zod";
import { PluginKindSchema } from "../plugins/common.js";

/** The environment variable a worker reads its build-system profiles from. A machine spec cannot set it. */
export const BUILD_SYSTEM_PROFILES_ENV = "ROVARA_BUILD_SYSTEMS";
export const BUILD_SYSTEM_MAX_PROFILES = 16;
export const BUILD_SYSTEM_MAX_PROGRAMS = 64;
export const BUILD_SYSTEM_MAX_KEY_GLOBS = 100;
/** The most characters of the serialized profiles (one environment variable). */
export const BUILD_SYSTEM_PROFILES_MAX_CHARS = 32_768;

// eslint-disable-next-line no-control-regex -- the control characters are the point
const NO_CONTROLS = /^[^\u0000-\u001f\u007f]*$/u;

/**
 * Programs that run whatever text they are handed. As a "setup program" each `sh -c '<anything>'` would become a step of its own and wear down the setup governor's same-step limit, so they are refused here.
 */
export const BUILD_SYSTEM_SHELL_PROGRAMS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "csh", "tcsh", "fish", "busybox", "env", "xargs", "eval", "exec", "sudo", "su", "cmd", "powershell", "pwsh"]);

/** A program name as a command line starts with it: `bazel`, `g++`, `./build.sh`. Never another path, and never a shell. */
export const BuildSystemProgramSchema = z.string().regex(/^(?:\.\/)?[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u, "a program name such as bazel or ./build.sh")
  .refine((program) => !BUILD_SYSTEM_SHELL_PROGRAMS.has(program.replace(/^\.\//u, "").toLowerCase().replace(/\.(?:exe|sh)$/u, "")), "a shell or a program that runs other programs cannot be a setup program");

/** A glob in the form the environment writes them (`**` crosses folders, `*` and `?` stay in one, `{a,b}` alternates). Repository-relative: never absolute, never `..`. */
export const BuildSystemGlobSchema = z.string().min(1).max(256).regex(NO_CONTROLS, "no control characters").refine(
  (glob) => !glob.startsWith("/") && !glob.includes("\\") && !glob.split("/").includes(".."),
  "a repository-relative glob (no leading /, no .., no backslash)",
);

/**
 * Where the detector module is: a package name the worker image installs (`@acme/detect-build`, optionally with a subpath), or an absolute path inside the image to a `.js` or `.mjs` file. Never a URL,
 * never a relative path, never `..`. (The worker also refuses a path inside its workspace, where repositories are checked out.)
 */
export const BuildSystemModuleSchema = z.string().min(1).max(256).regex(NO_CONTROLS, "no control characters").refine((value) => {
  if (value.startsWith("/")) return /^\/(?:[A-Za-z0-9._@+-]+\/)*[A-Za-z0-9._@+-]+\.m?js$/u.test(value) && !value.split("/").includes("..") && !value.split("/").includes(".");
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9._-]+)*$/u.test(value) && !value.split("/").some((part) => part === "." || part === "..") && !/^(?:node|file|http|https|data):/u.test(value);
}, "a package name, or an absolute path to a .js or .mjs file");

/**
 * Whether a profile's `keyFileGlobs` are used: TRUE. The saved-environment job builder and the broker's own key (`core/test-env/saved-env-rebuild.ts`, `saved-env-real.ts`) both read them through
 * `detectorGlobsWithBuildSystems`, from the one function `savedEnvBuildInputsOf`, so the job's `detectorGlobs` and the broker's key hash the same files.
 */
export const BUILD_SYSTEM_KEY_FILE_GLOBS_WIRED = true as boolean;

export const BuildSystemProfileSchema = z.object({
  /** The build system's name, the same as its adapter's name in the registry. */
  name: PluginKindSchema,
  detectorModule: BuildSystemModuleSchema.optional(),
  setupPrograms: z.array(BuildSystemProgramSchema).max(BUILD_SYSTEM_MAX_PROGRAMS).default([]),
  keyFileGlobs: z.array(BuildSystemGlobSchema).max(BUILD_SYSTEM_MAX_KEY_GLOBS).default([]),
}).strict();
export type BuildSystemProfile = z.infer<typeof BuildSystemProfileSchema>;
export type BuildSystemProfileInput = z.input<typeof BuildSystemProfileSchema>;

/** What a `build-system` adapter is: it names itself and supplies its profile. It runs nothing and reads no repository. */
export interface BuildSystem {
  /** The adapter's name; a profile's `name` is the same. */
  readonly name: string;
  profile(): BuildSystemProfile | Promise<BuildSystemProfile>;
}

const ProfileListSchema = z.array(BuildSystemProfileSchema).max(BUILD_SYSTEM_MAX_PROFILES).superRefine((profiles, context) => {
  const seen = new Set<string>();
  profiles.forEach((profile, index) => {
    if (seen.has(profile.name)) context.addIssue({ code: "custom", path: [index, "name"], message: "two build systems have the same name" });
    seen.add(profile.name);
  });
});

/** The value of `ROVARA_BUILD_SYSTEMS` for these profiles. Throws when a profile is not valid or the text would be too long to pass in one variable. */
export function serializeBuildSystemProfiles(profiles: readonly BuildSystemProfileInput[]): string {
  const text = JSON.stringify(ProfileListSchema.parse(profiles));
  if (text.length > BUILD_SYSTEM_PROFILES_MAX_CHARS) throw new Error(`the build-system profiles are over ${String(BUILD_SYSTEM_PROFILES_MAX_CHARS)} characters`);
  return text;
}

/** The profiles in `ROVARA_BUILD_SYSTEMS`; `[]` when it is absent or empty. Throws a plain error (naming no value) for text that is not valid, so a worker can refuse to start. */
export function parseBuildSystemProfiles(text: string | undefined): BuildSystemProfile[] {
  if (text === undefined || text.trim() === "") return [];
  if (text.length > BUILD_SYSTEM_PROFILES_MAX_CHARS) throw new Error(`${BUILD_SYSTEM_PROFILES_ENV} is over ${String(BUILD_SYSTEM_PROFILES_MAX_CHARS)} characters`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${BUILD_SYSTEM_PROFILES_ENV} is not valid JSON`);
  }
  const parsed = ProfileListSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${BUILD_SYSTEM_PROFILES_ENV} is not a list of build-system profiles: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  return parsed.data;
}

const unique = (lists: ReadonlyArray<readonly string[]>): string[] => [...new Set(lists.flat())];

/** The extra key-file globs of all profiles, without repeats. The broker adds them to the job's `detectorGlobs` and to its own key; the worker adds nothing. */
export function buildSystemKeyFileGlobs(profiles: readonly BuildSystemProfile[]): string[] {
  return unique(profiles.map((profile) => profile.keyFileGlobs));
}

/** The extra setup programs of all profiles, without repeats. */
export function buildSystemSetupPrograms(profiles: readonly BuildSystemProfile[]): string[] {
  return unique(profiles.map((profile) => profile.setupPrograms));
}

/** The detector modules of all profiles, in profile order, without repeats. */
export function buildSystemDetectorModules(profiles: readonly BuildSystemProfile[]): string[] {
  return unique(profiles.map((profile) => (profile.detectorModule === undefined ? [] : [profile.detectorModule])));
}
