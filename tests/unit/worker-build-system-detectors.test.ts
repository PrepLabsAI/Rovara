// Port lane P6 (item B1): what a build-system profile adds inside the worker: detectors after the built-in ones, extra setup programs for the governor's step grouping.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_SYSTEM_PROFILES_ENV, serializeBuildSystemProfiles } from "@agentx/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { installBuildSystemProfiles, installedDetectorModules } from "../../packages/worker/src/build-systems.js";
import { BUILT_IN_DETECTOR_NAMES, boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { runDetectorsGuarded } from "../../packages/worker/src/env-detect/guarded.js";
import { loadPluginDetectors, vetDetectorModules, type PluginDetector } from "../../packages/worker/src/env-detect/plugin-detectors.js";
import { setExtraSubcommandPrograms, stepKeyOf } from "../../packages/worker/src/setup-agent-journal.js";
import type { Detection, Detector } from "../../packages/worker/src/env-detect/types.js";

const folders: string[] = [];
afterEach(async () => {
  setExtraSubcommandPrograms([]);
  installBuildSystemProfiles({});
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function folder(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "p6-detect-"));
  folders.push(path);
  return path;
}

const reader = (files: Record<string, string>) => boundedReader(Object.keys(files), (path) => Promise.resolve(files[path])).reader;
const exampleDetector: Detector = async ({ repo, cwd }): Promise<Partial<Detection>> => {
  if (!repo.paths.includes("EXAMPLE_BUILD")) return {};
  return { checks: [{ value: { id: "example-test", label: "Example tests", kind: "test", command: { cwd, executable: "examplebuild", args: ["test", "//..."], timeoutSeconds: 600 } }, source: "detector:example" }], fullSuiteOn: [{ value: "EXAMPLE_BUILD", source: "detector:example" }] };
};
const MODULE_TEXT = `export const detectors = [{ name: "example", run: async ({ repo, cwd }) => repo.paths.includes("EXAMPLE_BUILD") ? { checks: [{ value: { id: "example-test", label: "Example tests", kind: "test", command: { cwd, executable: "examplebuild", args: ["test", "//..."], timeoutSeconds: 600 } }, source: "detector:example" }] } : {} }];\n`;

describe("plug-in detectors", () => {
  it("run after the built-in ones and add their findings", async () => {
    const files = { "package.json": '{"scripts":{"test":"vitest"}}', "EXAMPLE_BUILD": "" };
    const plain = await runDetectors(reader(files), "svc");
    expect(plain.checks.map((check) => check.value.id)).not.toContain("example-test");
    const extended = await runDetectors(reader(files), "svc", { extraDetectors: [{ name: "example", run: exampleDetector }] });
    expect(extended.checks.map((check) => check.value.id)).toEqual([...plain.checks.map((check) => check.value.id), "example-test"]);
    expect(extended.fullSuiteOn.map((glob) => glob.value)).toContain("EXAMPLE_BUILD");
  });

  it("do not change a detection when there are none (today's result, byte for byte)", async () => {
    const files = { "package.json": '{"scripts":{"test":"vitest"}}' };
    expect(JSON.stringify(await runDetectors(reader(files), "svc", { extraDetectors: [] }))).toBe(JSON.stringify(await runDetectors(reader(files), "svc")));
  });

  it("are skipped when the caller asks for named detectors only", async () => {
    const detection = await runDetectors(reader({ EXAMPLE_BUILD: "" }), "svc", { only: ["iac"], extraDetectors: [{ name: "example", run: exampleDetector }] });
    expect(detection.checks).toEqual([]);
  });

  it("that throw are skipped with the same note a built-in one gets", async () => {
    const boom: PluginDetector = { name: "boom", run: () => { throw new Error("leaks nothing"); } };
    const detection = await runDetectors(reader({ "a.txt": "x" }), "svc", { extraDetectors: [boom] });
    expect(detection.notes).toContain("The boom detector could not finish.");
  });
});

describe("loading detector modules", () => {
  const good = { detectors: [{ name: "example", run: exampleDetector }] };

  it("takes the detectors a module exports, by name or as a default export", async () => {
    const loaded = await loadPluginDetectors(["a", "b"], BUILT_IN_DETECTOR_NAMES, async (specifier) => (specifier === "a" ? good : { default: { detectors: [{ name: "second", run: exampleDetector }] } }));
    expect(loaded.detectors.map((detector) => detector.name)).toEqual(["example", "second"]);
    expect(loaded.notes).toEqual([]);
  });

  it("adds nothing, and says so in fixed words, for a module that cannot be imported or has the wrong shape", async () => {
    const shapes: unknown[] = [undefined, {}, { detectors: "no" }, { detectors: [{ name: "Bad Name", run: exampleDetector }] }, { detectors: [{ name: "x" }] }, { detectors: [{ name: "x", run: exampleDetector }, { name: "x", run: exampleDetector }] }, { detectors: Array.from({ length: 17 }, (_, i) => ({ name: `d${String(i)}`, run: exampleDetector })) }];
    for (const shape of shapes) {
      const loaded = await loadPluginDetectors(["m"], BUILT_IN_DETECTOR_NAMES, async () => shape);
      expect(loaded.detectors, JSON.stringify(shape)).toEqual([]);
      expect(loaded.notes).toEqual(["A build-system detector could not be loaded, so its findings are missing."]);
    }
    const failing = await loadPluginDetectors(["m"], BUILT_IN_DETECTOR_NAMES, async () => { throw new Error("/secret/path"); });
    expect(failing.notes.join(" ")).not.toContain("secret");
  });

  it("never lets a plug-in take the place of a built-in detector", async () => {
    const loaded = await loadPluginDetectors(["m"], BUILT_IN_DETECTOR_NAMES, async () => ({ detectors: [{ name: "python", run: exampleDetector }] }));
    expect(loaded.detectors).toEqual([]);
    expect(BUILT_IN_DETECTOR_NAMES.has("python")).toBe(true);
  });

  it("keeps a good module when another is bad", async () => {
    const loaded = await loadPluginDetectors(["bad", "good"], BUILT_IN_DETECTOR_NAMES, async (specifier) => (specifier === "good" ? good : { detectors: 1 }));
    expect(loaded.detectors.map((detector) => detector.name)).toEqual(["example"]);
    expect(loaded.notes).toHaveLength(1);
  });
});

describe("vetting detector modules", () => {
  it("keeps a package name, and a file outside the workspace by its real path", async () => {
    const outside = await folder();
    await writeFile(join(outside, "d.mjs"), MODULE_TEXT);
    const vetted = await vetDetectorModules(["@example/detect", join(outside, "d.mjs")], join(outside, "workspace"));
    expect(vetted.modules[0]).toBe("@example/detect");
    expect(vetted.modules).toHaveLength(2);
    expect(vetted.notes).toEqual([]);
  });

  it("refuses a file inside the workspace (where repositories are checked out), a missing file, a folder, and a link into the workspace", async () => {
    const root = await folder();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "repo"), { recursive: true });
    await writeFile(join(workspace, "repo", "d.mjs"), MODULE_TEXT);
    const outside = join(root, "elsewhere");
    await mkdir(outside);
    await symlink(join(workspace, "repo", "d.mjs"), join(outside, "link.mjs"));
    const vetted = await vetDetectorModules([join(workspace, "repo", "d.mjs"), join(outside, "missing.mjs"), outside, join(outside, "link.mjs")], workspace);
    expect(vetted.modules).toEqual([]);
    expect(vetted.notes).toEqual(["A build-system detector could not be loaded, so its findings are missing."]);
  });
});

describe("the detector pass with a build system's module", () => {
  it("loads the module in the detector thread and runs its detector after the built-in ones", async () => {
    const outside = await folder();
    const module = join(outside, "example-detector.mjs");
    await writeFile(module, MODULE_TEXT);
    const files = { "package.json": '{"scripts":{"test":"vitest"}}', EXAMPLE_BUILD: "" };
    const direct = await runDetectors(reader(files), "svc");
    const guarded = await runDetectorsGuarded(reader(files), "svc", { timeoutMs: 30_000, detectorModules: [module] });
    expect(guarded.checks.map((check) => check.value.id)).toEqual([...direct.checks.map((check) => check.value.id), "example-test"]);
    expect(guarded.notes).toEqual(direct.notes);
  });

  it("says a module was not loaded when it is missing, and still gives the built-in findings", async () => {
    const files = { "package.json": '{"scripts":{"test":"vitest"}}' };
    const guarded = await runDetectorsGuarded(reader(files), "svc", { timeoutMs: 30_000, detectorModules: ["/nonexistent/folder/d.mjs"] });
    expect(guarded.checks.map((check) => check.value.id)).toContain("unit");
    expect(guarded.notes).toContain("A build-system detector could not be loaded, so its findings are missing.");
  });

  it("uses the installed profiles' modules by default, and none when nothing is installed", async () => {
    const outside = await folder();
    const module = join(outside, "example-detector.mjs");
    await writeFile(module, MODULE_TEXT);
    expect(installedDetectorModules()).toEqual([]);
    installBuildSystemProfiles({ [BUILD_SYSTEM_PROFILES_ENV]: serializeBuildSystemProfiles([{ name: "examplebuild", detectorModule: module }]) });
    expect(installedDetectorModules()).toEqual([module]);
    const guarded = await runDetectorsGuarded(reader({ EXAMPLE_BUILD: "" }), "svc", { timeoutMs: 30_000 });
    expect(guarded.checks.map((check) => check.value.id)).toContain("example-test");
  });
});

describe("a build system's setup programs", () => {
  it("make the governor group its commands into steps by subcommand, like a built-in tool's", () => {
    expect(stepKeyOf("examplebuild build //a:b --verbose")).toBe("examplebuild build");
    expect(stepKeyOf("examplebuild build //a:b")).toBe("examplebuild build");
    setExtraSubcommandPrograms(["examplebuild"]);
    expect(stepKeyOf("examplebuild build //a:b --verbose")).toBe("examplebuild build //a:b");
    expect(stepKeyOf("examplebuild build //c:d")).toBe("examplebuild build //c:d");
    setExtraSubcommandPrograms([]);
    expect(stepKeyOf("examplebuild build //a:b")).toBe("examplebuild build");
  });

  it("are installed from the worker's environment, and an unreadable value stops the boot", () => {
    installBuildSystemProfiles({ [BUILD_SYSTEM_PROFILES_ENV]: serializeBuildSystemProfiles([{ name: "examplebuild", setupPrograms: ["examplebuild"] }]) });
    expect(stepKeyOf("examplebuild build //a:b")).toBe("examplebuild build //a:b");
    expect(() => installBuildSystemProfiles({ [BUILD_SYSTEM_PROFILES_ENV]: "{broken" })).toThrow(/ROVARA_BUILD_SYSTEMS/);
    expect(() => installBuildSystemProfiles({ [BUILD_SYSTEM_PROFILES_ENV]: '[{"name":"x","setupPrograms":["/bin/sh"]}]' })).toThrow();
  });

  it("do not stay installed after a boot without any", () => {
    installBuildSystemProfiles({ [BUILD_SYSTEM_PROFILES_ENV]: serializeBuildSystemProfiles([{ name: "examplebuild", setupPrograms: ["examplebuild"] }]) });
    installBuildSystemProfiles({});
    expect(stepKeyOf("examplebuild build //a:b")).toBe("examplebuild build");
  });
});
