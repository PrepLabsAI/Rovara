// Proof and evidence P3, the broker's half: the changed-line coverage the worker read is kept in the pack (after the data guard and the broker's own consistency check) and the pull request shows counts only.
// A worker that sends no coverage (an older worker, or a project with no report) gives a pack without it, and the pull request says "no coverage report" plainly.
import { describe, expect, it } from "vitest";
import type { CheckEntry } from "../../packages/contracts/src/index.js";
import { EVIDENCE_OP, EVIDENCE_TASK, evidenceWorld } from "../support/evidence-keep-world.js";
import { evidenceLines } from "../../packages/broker/src/core/proof/evidence-lines.js";
import { keepEvidence, loadEvidencePack } from "../../packages/broker/src/core/proof/evidence-keep.js";

const DIGEST = "c".repeat(64);
const TASK = EVIDENCE_TASK;
const OP = EVIDENCE_OP;
const entry = (id: string, label: string, over: Partial<CheckEntry> = {}): CheckEntry => ({ id, label, source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 700, exitCode: 0, ...over });
const tests = { total: 3, passed: 3, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] };
const rawOf = (checks: unknown[]) => ({ schemaVersion: 1, candidateDigest: DIGEST, checks, selection: { method: "full", selected: 3, total: 3 } });

const keep = async (checks: unknown[], entries: CheckEntry[] = [entry("readiness:0", "pytest -q")]) => {
  const w = evidenceWorld(JSON.stringify(rawOf(checks)));
  const result = await keepEvidence(w.deps, { orgId: "org-a", task: TASK, operationId: OP, candidateDigest: DIGEST, checks: entries });
  return { result, pack: await loadEvidencePack(w.deps.store.blobs, TASK, DIGEST) };
};
const prLines = (pack: NonNullable<Awaited<ReturnType<typeof keep>>["pack"]>) => evidenceLines({ pack, mode: "summary" }, DIGEST, 0).lines.join("\n");

describe("changed-line coverage in the evidence", () => {

  it("says so when the report lists none of the changed lines, instead of a bare 0 of 0", async () => {
    const { pack } = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 0, linesCovered: 0, files: [] } }]);
    expect(prLines(pack!)).toContain("the coverage report lists none of the changed lines");
  });

  it("says in fixed words how many changed source files the report does not name, and 'at least' when several reports are summed", async () => {
    const one = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 8, linesCovered: 8, unlistedFiles: 2, files: [] } }]);
    expect(one.pack?.checks[0]?.coverage?.unlistedFiles).toBe(2);
    expect(prLines(one.pack!)).toContain("Changed lines covered by tests: 8 of 8 (100%); 2 changed source files are not in the coverage report");
    const single = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 8, linesCovered: 4, unlistedFiles: 1, files: [] } }]);
    expect(prLines(single.pack!)).toContain("(50%); 1 changed source file is not in the coverage report");
    // Two reports: a file one of them names may be named by the other, so only the smaller count is certain.
    const two = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 8, linesCovered: 8, unlistedFiles: 3, files: [] } }, { checkId: "readiness:1", tests, coverage: { linesChanged: 2, linesCovered: 2, unlistedFiles: 1, files: [] } }], [entry("readiness:0", "pytest -q"), entry("readiness:1", "pytest web")]);
    expect(prLines(two.pack!)).toContain("10 of 10 (100%); at least 1 changed source file is not in the coverage report");
    const none = await keep([{ checkId: "readiness:0", tests, coverage: { linesChanged: 8, linesCovered: 8, files: [] } }]);
    expect(prLines(none.pack!)).toContain("8 of 8 (100%)");
    expect(prLines(none.pack!)).not.toContain("not in the coverage report");
  });
});
