// S-2: a coverage report counts only when the check's command names it or the approved setup gives its `coveragePath`. The setup wizard (the proposal the maintainer approves) therefore says, for each test check that has
// neither, that changed-line coverage will show as not measured, so the maintainer can add the report or the path before approving.
import { describe, expect, it } from "vitest";
import { buildEnvironmentDraft } from "../../packages/worker/src/env-detect/index.js";
import { emptyDetection, type Detection } from "../../packages/worker/src/env-detect/types.js";

const source = { path: "pyproject.toml", line: 3 };
const command = (executable: string, args: string[]) => ({ cwd: "svc", executable, args, timeoutSeconds: 600 });
const detectionOf = (checks: Detection["checks"]): Detection => ({ ...emptyDetection(), checks });
const check = (id: string, kind: "test" | "lint", cmd: ReturnType<typeof command>, extra: Record<string, unknown> = {}) => ({ value: { id, label: id, kind, command: cmd, ...extra }, source }) as Detection["checks"][number];
const notesOf = (detection: Detection) => { const draft = buildEnvironmentDraft(detection, { repositoryId: "svc" }); if ("ok" in draft) throw new Error("invalid"); return draft.notes; };
const WORDS = (id: string) => `The test check "${id}" names no coverage report (neither on its command line nor as a coverage path), so changed-line coverage will show as not measured for it.`;

describe("the proposal says which test checks have no named coverage report", () => {
  it("warns for a test check with no report on its command and no coveragePath, once per check", () => {
    expect(notesOf(detectionOf([check("unit", "test", command("pytest", ["-q"]))]))).toEqual([WORDS("unit")]);
    expect(notesOf(detectionOf([check("unit", "test", command("pytest", ["-q"])), check("integration", "test", command("pytest", ["-m", "slow"]))]))).toEqual([WORDS("unit"), WORDS("integration")]);
  });

  it("says nothing for a check with a coveragePath, one whose command names a report, or one that is not a test check", () => {
    expect(notesOf(detectionOf([check("unit", "test", command("pytest", ["-q"]), { coveragePath: "reports/coverage.xml" })]))).toEqual([]);
    expect(notesOf(detectionOf([check("unit", "test", command("pytest", ["--cov-report=xml:out/c.xml"]))]))).toEqual([]);
    expect(notesOf(detectionOf([check("lint", "lint", command("ruff", ["check"]))]))).toEqual([]);
  });

  it("does not repeat a note a detector already made about missing coverage", () => {
    const detection = { ...detectionOf([check("unit", "test", command("pytest", ["-q"]))]), notes: ["No XML coverage report is configured, so changed-line coverage will show as not measured."] };
    expect(notesOf(detection)).toEqual(["No XML coverage report is configured, so changed-line coverage will show as not measured."]);
  });
});
