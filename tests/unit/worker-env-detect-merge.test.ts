// Proof and test environment E2: several detectors on one repository give ONE coherent detection (no duplicate commands, every citation kept, one copy of each question, the limits held) and a proposal that is valid.
import { afterEach, describe, expect, it } from "vitest";
import { DETECTORS, boundedReader, buildEnvironmentDraft, runDetectors } from "../../packages/worker/src/env-detect/index.js";
import type { Detector } from "../../packages/worker/src/env-detect/types.js";

type Files = Record<string, string>;
async function detect(files: Files) {
  const bounded = boundedReader(Object.keys(files), (path) => Promise.resolve(files[path]));
  return runDetectors(bounded.reader, "service");
}

const injected: string[] = [];
const inject = (name: string, run: Detector): void => { (DETECTORS as Array<{ name: string; run: Detector }>).push({ name, run }); injected.push(name); };
afterEach(() => { for (const name of injected.splice(0)) { const at = DETECTORS.findIndex((item) => item.name === name); if (at !== -1) (DETECTORS as Array<unknown>).splice(at, 1); } });

describe("several detectors, one detection", () => {
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
});
