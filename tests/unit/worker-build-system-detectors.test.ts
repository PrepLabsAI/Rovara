// Port lane P6 (item B1): what a build-system profile adds inside the worker: detectors after the built-in ones, extra setup programs for the governor's step grouping.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installBuildSystemProfiles } from "../../packages/worker/src/build-systems.js";
import { BUILT_IN_DETECTOR_NAMES, boundedReader, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import { runDetectorsGuarded } from "../../packages/worker/src/env-detect/guarded.js";
import { loadPluginDetectors, vetDetectorModules, type PluginDetector } from "../../packages/worker/src/env-detect/plugin-detectors.js";
import { setExtraSubcommandPrograms } from "../../packages/worker/src/setup-agent-journal.js";
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

  it("says a module was not loaded when it is missing, and still gives the built-in findings", async () => {
    const files = { "package.json": '{"scripts":{"test":"vitest"}}' };
    const guarded = await runDetectorsGuarded(reader(files), "svc", { timeoutMs: 30_000, detectorModules: ["/nonexistent/folder/d.mjs"] });
    expect(guarded.checks.map((check) => check.value.id)).toContain("unit");
    expect(guarded.notes).toContain("A build-system detector could not be loaded, so its findings are missing.");
  });

  it("never imports a plug-in into the main thread when no detector thread can be started: built-in detectors only, and a note", async () => {
    const outside = await folder();
    const module = join(outside, "side-effect-detector.mjs");
    await writeFile(module, `globalThis.__p6Imported = true;\n${MODULE_TEXT}`);
    const files = { "package.json": '{"scripts":{"test":"vitest"}}', EXAMPLE_BUILD: "" };
    const direct = await runDetectors(reader(files), "svc");
    const detection = await runDetectorsGuarded(reader(files), "svc", {
      timeoutMs: 5_000, log: () => undefined, detectorModules: [module],
      entry: { url: new URL("../support/no-such-thread.ts", import.meta.url), execArgv: ["--import", "tsx"] },
    });
    expect((globalThis as { __p6Imported?: boolean }).__p6Imported).toBeUndefined();
    expect(detection.checks.map((check) => check.value.id)).toEqual(direct.checks.map((check) => check.value.id));
    expect(detection.checks.map((check) => check.value.id)).not.toContain("example-test");
    expect(detection.notes).toContain("A build-system detector could not be loaded, so its findings are missing.");
  });

});

