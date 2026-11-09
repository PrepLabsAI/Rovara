// Proof and test environment E2: several detectors on one repository give ONE coherent detection (no duplicate commands, every citation kept, one copy of each question, the limits held) and a proposal that is valid.
import { afterEach, describe, expect, it } from "vitest";
import { TestEnvironmentBodySchema } from "@agentx/contracts";
import { DETECTORS, boundedReader, buildEnvironmentDraft, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import type { Detector } from "../../packages/worker/src/env-detect/types.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "service");
}
const GRADLE: Files = { "build.gradle": "plugins {\n  id 'java'\n  id 'checkstyle'\n}\n", gradlew: "", "gradle/wrapper/gradle-wrapper.properties": "", "gradle/wrapper/gradle-wrapper.jar": "", "src/test/java/ATest.java": "" };
const NODE: Files = { "package.json": '{\n  "scripts": {\n    "test": "vitest run",\n    "lint": "eslint ."\n  }\n}', "package-lock.json": "{}" };

const injected: string[] = [];
const inject = (name: string, run: Detector): void => { (DETECTORS as Array<{ name: string; run: Detector }>).push({ name, run }); injected.push(name); };
afterEach(() => { for (const name of injected.splice(0)) { const at = DETECTORS.findIndex((item) => item.name === name); if (at !== -1) (DETECTORS as Array<unknown>).splice(at, 1); } });

describe("several detectors, one detection", () => {
  it("Node + Java: both test checks are kept, the second under its detector's name, instead of one silently replacing the other", async () => {
    const detection = await detect({ ...NODE, ...GRADLE });
    expect(detection.checks.map((check) => [check.value.id, check.value.command.executable, check.source])).toEqual([
      ["unit", "npm", { path: "package.json", line: 3 }], ["lint", "npm", { path: "package.json", line: 4 }], ["unit-java", "./gradlew", { path: "build.gradle", line: 1 }], ["checkstyle", "./gradlew", { path: "build.gradle", line: 3 }],
    ]);
    expect(detection.setupCommands.map((item) => item.value.executable)).toEqual(["npm", "./gradlew"]);
    expect(detection.fullSuiteOn.map((item) => item.value)).toEqual(expect.arrayContaining(["package-lock.json", "package.json", "build.gradle", "gradlew"]));
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("not built");
    expect(TestEnvironmentBodySchema.safeParse(draft.environment).success).toBe(true);
    expect(draft.environment.repos[0]?.checks.map((check) => check.id)).toEqual(["unit", "lint", "unit-java", "checkstyle"]);
    expect(draft.valueSources).toContainEqual({ field: "repos[0].checks[2]", source: { path: "build.gradle", line: 1 } });
  });
  it("keeps the first of two identical commands (and its citation), and one copy of each note and question", async () => {
    inject("twin-a", () => Promise.resolve({
      checks: [{ value: { id: "unit", label: "Tests", kind: "test", command: { cwd: "service", executable: "make", args: ["test"], timeoutSeconds: 600 } }, source: { path: "Makefile", line: 3 } }],
      setupCommands: [{ value: { cwd: "service", executable: "make", args: ["setup"], timeoutSeconds: 600 }, source: { path: "Makefile", line: 1 } }],
      notes: ["same note"], questions: ["same question?"],
    }));
    inject("twin-b", () => Promise.resolve({
      checks: [{ value: { id: "tests", label: "Tests again", kind: "test", command: { cwd: "service", executable: "make", args: ["test"], timeoutSeconds: 600 } }, source: { path: "docs.md", line: 9 } }],
      setupCommands: [{ value: { cwd: "service", executable: "make", args: ["setup"], timeoutSeconds: 600 }, source: { path: "docs.md", line: 8 } }],
      notes: ["same note"], questions: ["same question?"],
    }));
    const detection = await detect({ "README.md": "x" });
    expect(detection.checks.map((check) => [check.value.id, check.source])).toEqual([["unit", { path: "Makefile", line: 3 }]]);
    expect(detection.setupCommands.map((item) => item.source)).toEqual([{ path: "Makefile", line: 1 }]);
    expect(detection.notes.filter((note) => note === "same note")).toHaveLength(1);
    expect(detection.questions).toEqual(["same question?"]);
  });
  it("holds the limits (32 checks, 20 setup commands, 90 detected full-suite globs) and says so", async () => {
    inject("many", () => Promise.resolve({
      checks: Array.from({ length: 40 }, (_, index) => ({ value: { id: `c${String(index)}`, label: "c", kind: "test" as const, command: { cwd: "service", executable: "make", args: [`t${String(index)}`], timeoutSeconds: 60 } }, source: "detector:many" as const })),
      setupCommands: Array.from({ length: 25 }, (_, index) => ({ value: { cwd: "service", executable: "make", args: [`s${String(index)}`], timeoutSeconds: 60 }, source: "detector:many" as const })),
      fullSuiteOn: Array.from({ length: 120 }, (_, index) => ({ value: `g${String(index)}/**`, source: "detector:many" as const })),
    }));
    const detection = await detect({ "README.md": "x" });
    expect(detection.checks).toHaveLength(32);
    expect(detection.setupCommands).toHaveLength(20);
    expect(detection.fullSuiteOn).toHaveLength(90);
    expect(detection.notes.join(" ")).toContain("More than 32 checks");
    expect(detection.notes.join(" ")).toContain("More than 20 setup commands");
    expect(detection.notes.join(" ")).toContain("More than 90 full-suite paths");
    const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" });
    if ("ok" in draft) throw new Error("not built");
    expect(draft.environment.repos[0]?.checks).toHaveLength(32);
    expect(draft.environment.selection.fullSuiteOn).toEqual(expect.arrayContaining([".github/**", ".gitlab-ci.yml", "Makefile"]));
  });
  it("renames a colliding id to something the environment still accepts", async () => {
    inject("a-very-long-detector-name-that-goes-on-and-on", () => Promise.resolve({ checks: [{ value: { id: "x".repeat(60), label: "c", kind: "test", command: { cwd: "service", executable: "make", args: ["one"], timeoutSeconds: 60 } }, source: "detector:x" }] }));
    inject("second-long-detector-name-that-goes-on-and-on-too", () => Promise.resolve({ checks: [{ value: { id: "x".repeat(60), label: "c", kind: "test", command: { cwd: "service", executable: "make", args: ["two"], timeoutSeconds: 60 } }, source: "detector:x" }] }));
    const detection = await detect({ "README.md": "x" });
    expect(detection.checks).toHaveLength(2);
    expect(detection.checks.every((check) => /^[a-z][a-z0-9_-]{0,63}$/u.test(check.value.id))).toBe(true);
    expect(new Set(detection.checks.map((check) => check.value.id)).size).toBe(2);
  });
});
