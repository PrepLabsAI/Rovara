// Port lane P6 (item B1, owner decision 60): the build-system point's interface. A profile supplies a detector module, setup programs and key-file globs; it reaches the worker in its
// start-up environment (not in a job), and the key-file globs reach the saved-environment key through the job's existing `detectorGlobs`.
import { describe, expect, it } from "vitest";
import {
  BUILD_SYSTEM_PROFILES_ENV,
  BUILD_SYSTEM_PROFILES_MAX_CHARS,
  BUILD_SYSTEM_KEY_FILE_GLOBS_WIRED,
  BuildSystemGlobSchema,
  BuildSystemProfileSchema,
  PLUGIN_POINT_CARDINALITY,
  PrepareSavedEnvBuildSchema,
  PluginRegistryError,
  buildSystemDetectorModules,
  buildSystemKeyFileGlobs,
  buildSystemSetupPrograms,
  keyFilePaths,
  parseBuildSystemProfiles,
  serializeBuildSystemProfiles,
  type BuildSystem,
  type BuildSystemProfile,
} from "@agentx/contracts";
import { collectBuildSystemProfiles, createAdapterRegistry, detectorGlobsWithBuildSystems } from "../../packages/broker/src/ports/index.js";

const profile = (extra: Partial<BuildSystemProfile> = {}): BuildSystemProfile => BuildSystemProfileSchema.parse({ name: "examplebuild", detectorModule: "@example/detect-examplebuild", setupPrograms: ["examplebuild", "./exb.sh"], ...extra });
/** A profile with key-file globs, built by hand: the schema refuses them until the saved-environment lane is ported (the helpers below are ready for that day). */
const withKeyFiles = (base: BuildSystemProfile, keyFileGlobs: string[]): BuildSystemProfile => ({ ...base, keyFileGlobs });

describe("a build-system profile", () => {
  it("is a name with optional detector module, setup programs and key-file globs (the last two default to none)", () => {
    expect(BuildSystemProfileSchema.parse({ name: "examplebuild" })).toEqual({ name: "examplebuild", setupPrograms: [], keyFileGlobs: [] });
    expect(profile().detectorModule).toBe("@example/detect-examplebuild");
    expect(PLUGIN_POINT_CARDINALITY["build-system"]).toBe("many");
  });

  it("takes a detector module as a package name or an absolute .js/.mjs path, and nothing else", () => {
    const accepted = ["@example/detect", "example-detect", "example-detect/detectors", "/opt/rovara/plugins/detect.mjs", "/opt/rovara/plugins/detect.js"];
    const refused = ["", "./detect.js", "../detect.js", "detect/../x", "file:///opt/x.js", "https://example.com/x.js", "node:fs", "data:text/javascript,1", "/opt/x/../detect.js", "/opt/detect.ts", "/opt/detect", "C:\\x.js", "bad name", "UPPER", "/opt/de tect.js", "x\u0000y"];
    for (const value of accepted) expect(BuildSystemProfileSchema.safeParse({ name: "b", detectorModule: value }).success, value).toBe(true);
    for (const value of refused) expect(BuildSystemProfileSchema.safeParse({ name: "b", detectorModule: value }).success, JSON.stringify(value)).toBe(false);
  });

  it("takes setup programs as program names, not paths", () => {
    for (const value of ["bazel", "g++", "./build.sh", "my-tool_2"]) expect(BuildSystemProfileSchema.safeParse({ name: "b", setupPrograms: [value] }).success, value).toBe(true);
    for (const value of ["", "/usr/bin/bazel", "a/b", "../x", "-flag", "two words", "a;b", "x".repeat(65)]) expect(BuildSystemProfileSchema.safeParse({ name: "b", setupPrograms: [value] }).success, value).toBe(false);
  });

  it("takes key-file globs relative to the repository", () => {
    for (const value of ["**/BUILD", "gradle/*.lockfile", "{a,b}/pins.txt", "pins.lock"]) expect(BuildSystemGlobSchema.safeParse(value).success, value).toBe(true);
    for (const value of ["", "/etc/passwd", "../x", "a/../b", "a\\b", "bad\nglob", "x".repeat(257)]) expect(BuildSystemGlobSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("refuses an unknown field and an over-long list", () => {
    expect(BuildSystemProfileSchema.safeParse({ name: "b", command: "rm -rf /" }).success).toBe(false);
    expect(BuildSystemProfileSchema.safeParse({ name: "b", setupPrograms: Array.from({ length: 65 }, (_, i) => `p${String(i)}`) }).success).toBe(false);
  });

  it("accepts a profile's key files, and still refuses an unsafe glob", () => {
    expect(BUILD_SYSTEM_KEY_FILE_GLOBS_WIRED).toBe(true);
    expect(BuildSystemProfileSchema.parse({ name: "b", keyFileGlobs: ["WORKSPACE"] }).keyFileGlobs).toEqual(["WORKSPACE"]);
    expect(parseBuildSystemProfiles(serializeBuildSystemProfiles([{ name: "b", keyFileGlobs: ["WORKSPACE", "tools/**/*.bzl"] }]))[0]?.keyFileGlobs).toEqual(["WORKSPACE", "tools/**/*.bzl"]);
    expect(BuildSystemProfileSchema.safeParse({ name: "b", keyFileGlobs: [] }).success).toBe(true);
    for (const glob of ["/etc/passwd", "../outside", "a/../b", "", "x\0y"]) expect(BuildSystemProfileSchema.safeParse({ name: "b", keyFileGlobs: [glob] }).success, glob).toBe(false);
  });

  it("refuses a shell, or a program that runs other programs, as a setup program (each command would become a step of its own)", () => {
    for (const value of ["sh", "bash", "zsh", "dash", "env", "xargs", "sudo", "./sh", "BASH", "bash.exe", "sh.sh", "powershell"]) expect(BuildSystemProfileSchema.safeParse({ name: "b", setupPrograms: [value] }).success, value).toBe(false);
    for (const value of ["bazel", "shellcheck", "./build.sh", "bashate", "cmake"]) expect(BuildSystemProfileSchema.safeParse({ name: "b", setupPrograms: [value] }).success, value).toBe(true);
  });
});

describe("the profiles in the worker's environment", () => {
  it("round-trips, and an absent or empty variable is no build system", () => {
    const profiles = [profile(), profile({ name: "otherbuild", detectorModule: undefined, setupPrograms: [] })];
    expect(parseBuildSystemProfiles(serializeBuildSystemProfiles(profiles))).toEqual(profiles);
    expect(parseBuildSystemProfiles(undefined)).toEqual([]);
    expect(parseBuildSystemProfiles("  ")).toEqual([]);
    expect(BUILD_SYSTEM_PROFILES_ENV).toBe("ROVARA_BUILD_SYSTEMS");
  });

  it("refuses text that is not valid, without quoting it", () => {
    expect(() => parseBuildSystemProfiles("{not json")).toThrow(/not valid JSON/);
    expect(() => parseBuildSystemProfiles('{"name":"b"}')).toThrow(/not a list/);
    expect(() => parseBuildSystemProfiles('[{"name":"b","detectorModule":"file:///etc/secret-ish.js"}]')).toThrow(/not a list/);
    try {
      parseBuildSystemProfiles('[{"name":"b","detectorModule":"file:///etc/secret-ish.js"}]');
    } catch (error) {
      expect(String(error)).not.toContain("secret-ish");
    }
    expect(() => parseBuildSystemProfiles("x".repeat(BUILD_SYSTEM_PROFILES_MAX_CHARS + 1))).toThrow(/characters/);
  });

  it("refuses two profiles with one name, and more than sixteen profiles", () => {
    expect(() => serializeBuildSystemProfiles([profile(), profile()])).toThrow();
    expect(() => serializeBuildSystemProfiles(Array.from({ length: 17 }, (_, i) => ({ name: `b${String(i)}` })))).toThrow();
  });

  it("flattens the lists of several profiles without repeats", () => {
    const profiles = [withKeyFiles(profile(), ["**/EXAMPLE_BUILD", "tools/pins/*.lock"]), withKeyFiles(profile({ name: "otherbuild", detectorModule: "@example/other", setupPrograms: ["examplebuild", "other"] }), ["tools/pins/*.lock", "x.lock"])];
    expect(buildSystemSetupPrograms(profiles)).toEqual(["examplebuild", "./exb.sh", "other"]);
    expect(buildSystemKeyFileGlobs(profiles)).toEqual(["**/EXAMPLE_BUILD", "tools/pins/*.lock", "x.lock"]);
    expect(buildSystemDetectorModules(profiles)).toEqual(["@example/detect-examplebuild", "@example/other"]);
    expect(buildSystemDetectorModules([profile({ detectorModule: undefined })])).toEqual([]);
  });
});

describe("the key files", () => {
  it("make a build system's own files part of the key, through the job's detectorGlobs", () => {
    const paths = ["package.json", "tools/pins/a.lock", "src/EXAMPLE_BUILD", "src/main.ts"];
    expect(keyFilePaths(paths, [])).toEqual(["package.json"]);
    const globs = detectorGlobsWithBuildSystems([], [withKeyFiles(profile(), ["**/EXAMPLE_BUILD", "tools/pins/*.lock"])]);
    expect(keyFilePaths(paths, globs)).toEqual(["package.json", "src/EXAMPLE_BUILD", "tools/pins/a.lock"]);
  });

  it("keeps the detectors' own globs, adds none twice, and still fits the job's schema", () => {
    const merged = detectorGlobsWithBuildSystems(["a.lock", "tools/pins/*.lock"], [withKeyFiles(profile(), ["**/EXAMPLE_BUILD", "tools/pins/*.lock"])]);
    expect(merged).toEqual(["a.lock", "tools/pins/*.lock", "**/EXAMPLE_BUILD"]);
    const job = PrepareSavedEnvBuildSchema.shape.detectorGlobs.parse(merged);
    expect(job).toEqual(merged);
  });

  it("fails closed when the globs would not fit in a job (a key over fewer files is a wrong key)", () => {
    const many = Array.from({ length: 150 }, (_, i) => `d${String(i)}.lock`);
    const profiles = [withKeyFiles(profile(), Array.from({ length: 100 }, (_, i) => `k${String(i)}.lock`))];
    expect(() => detectorGlobsWithBuildSystems(many, profiles)).toThrow(PluginRegistryError);
  });
});

describe("collecting the profiles of the registered adapters", () => {
  const adapter = (name: string, answer: unknown): BuildSystem => ({ name, profile: () => answer as BuildSystemProfile });

  it("gives [] for no adapter, and the profiles in name order otherwise", async () => {
    const registry = createAdapterRegistry();
    expect(await collectBuildSystemProfiles(registry)).toEqual([]);
    registry.register("build-system", "zbuild", adapter("zbuild", { name: "zbuild", setupPrograms: [], keyFileGlobs: [] }));
    registry.register("build-system", "examplebuild", adapter("examplebuild", profile()));
    expect((await collectBuildSystemProfiles(registry)).map((entry) => entry.name)).toEqual(["examplebuild", "zbuild"]);
  });

  it("accepts an adapter whose profile is built asynchronously", async () => {
    const registry = createAdapterRegistry();
    registry.register("build-system", "examplebuild", { name: "examplebuild", profile: async () => profile() });
    expect(await collectBuildSystemProfiles(registry)).toEqual([profile()]);
  });

  it("refuses a profile that is not valid, one under another name, and one that throws (the machine does not start half described)", async () => {
    const invalid = createAdapterRegistry();
    invalid.register("build-system", "bad", adapter("bad", { name: "bad", detectorModule: "../escape.js", setupPrograms: [], keyFileGlobs: [] }));
    await expect(collectBuildSystemProfiles(invalid)).rejects.toThrow(/not valid/);
    const renamed = createAdapterRegistry();
    renamed.register("build-system", "one", adapter("one", { name: "two", setupPrograms: [], keyFileGlobs: [] }));
    await expect(collectBuildSystemProfiles(renamed)).rejects.toThrow(/registered under/);
    const throwing = createAdapterRegistry();
    throwing.register("build-system", "boom", { name: "boom", profile: () => { throw new Error("secret detail"); } });
    await expect(collectBuildSystemProfiles(throwing)).rejects.toThrow(/could not give its profile/);
    await expect(collectBuildSystemProfiles(throwing)).rejects.not.toThrow(/secret detail/);
  });
});
