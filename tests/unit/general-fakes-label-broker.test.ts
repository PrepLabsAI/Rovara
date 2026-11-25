// General fakes slice 2 (DEC 234): the "Made by Rovara" label on a check RESULT reaches the places a person reads, with no test proof needed. The worker's entry carries `madeByRovara: true`; the broker keeps it
// on the recorded verification result, the proof table reads it as a `made_by_rovara` dependency (so the check is never Proven), and the pull request's checks section says so on the check's own line.
import { describe, expect, it } from "vitest";
import {
  AGENTX_PREAMBLE_VERSION, CheckEntrySchema, GENERAL_FAKE_LABEL, VerificationResultsSchema, agentxPreambleSha256, checksSection, type CheckEntry,
} from "@agentx/contracts";
import { verificationResultsOf } from "../../packages/broker/src/core/build-step/check-results.js";

const DIGEST = "1".repeat(64);
const entry = (overrides: Partial<CheckEntry> = {}): CheckEntry => ({ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "ok", durationMs: 10, ...overrides });
const report = (checks: CheckEntry[]) => ({ status: "verified" as const, source: "project" as const, preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(), checks, extraTry: "not_needed" as const, agentClaim: "success" as const });

describe("the label on the schemas", () => {
  it("an entry and a recorded result take `madeByRovara: true` and nothing else", () => {
    expect(CheckEntrySchema.safeParse(entry({ madeByRovara: true })).success).toBe(true);
    expect(CheckEntrySchema.safeParse({ ...entry(), madeByRovara: false }).success).toBe(false);
    expect(CheckEntrySchema.safeParse({ ...entry(), madeByRovara: "yes" }).success).toBe(false);
    const recorded = (result: object) => VerificationResultsSchema.safeParse({ candidateDigest: DIGEST, producer: "p", environmentId: "e", recordedAt: "2026-11-16T10:00:00.000Z", results: [{ checkId: "unit", status: "PASS", ...result }] });
    expect(recorded({ madeByRovara: true }).success).toBe(true);
    expect(recorded({ madeByRovara: false }).success).toBe(false);
    expect(recorded({}).success).toBe(true);
  });
});

describe("the pull request's checks section", () => {
  it("says on a check's own line that a Rovara-made fake answered it, and never on another line", () => {
    const section = checksSection([], report([entry({ madeByRovara: true }), entry({ id: "readiness:1", label: "npm run lint" })]));
    const lines = section.split("\n").filter((line) => line.startsWith("- "));
    expect(lines).toEqual([
      `- \`npm test\`: passed → passed, passing (${GENERAL_FAKE_LABEL}: answered by a fake Rovara made, never change proof)`,
      "- `npm run lint`: passed → passed, passing",
    ]);
  });

  it("a report with no label is exactly what it was (golden)", () => {
    expect(checksSection([], report([entry()]))).toBe(["## Checks", "", "No check that passed before this change fails now.", "", "After the last task, AgentX reran the project's checks:", "- `npm test`: passed → passed, passing"].join("\n"));
  });
});


describe("the recorded results (core build step)", () => {
  const selected = [0, 1, 2, 3, 4].map((index) => ({ id: `check-${String(index)}`, command: { cwd: "repo", executable: "npm", args: ["test"] } }));
  const at = (index: number, after: CheckEntry["after"], output = "", extra: Partial<CheckEntry> = {}) => entry({ id: `readiness:${String(index)}`, after, output, exitCode: after === "passed" ? 0 : 1, ...extra });

  it("keeps the label from the worker's entry, only on that check, and every other field is as before (golden)", () => {
    const results = verificationResultsOf(selected, [at(0, "passed", "", { madeByRovara: true }), at(1, "passed"), at(2, "failed", "spawn npm ENOENT", { exitCode: null }), at(3, "failed", "spawn npm EAGAIN", { exitCode: null }), at(4, "not_run")]);
    expect(results).toEqual([
      { checkId: "check-0", status: "PASS", madeByRovara: true },
      { checkId: "check-1", status: "PASS" },
      { checkId: "check-2", status: "FAILED", programNotFound: true, broken: true },
      { checkId: "check-3", status: "FAILED", broken: true, neverStarted: true },
      { checkId: "check-4", status: "UNKNOWN" },
    ]);
  });

  it("a command that could not run is broken whatever the label says", () => {
    expect(verificationResultsOf(selected.slice(0, 1), [at(0, "failed", "sh: npm: not found", { exitCode: 127, madeByRovara: true })])).toEqual([{ checkId: "check-0", status: "FAILED", broken: true, madeByRovara: true }]);
  });
});
