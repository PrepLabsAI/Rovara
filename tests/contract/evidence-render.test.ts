// TE-A2a: the pure evidence renderer (first line and body). Golden text for the five levels and each producer line; slots appear only when given; output stays bounded; nothing outside contracts calls it yet.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LEVELS, EVIDENCE_RENDER_LIMITS, NEWER_EVIDENCE_WORDS, evidencePackV1ToV2, readEvidencePack, renderEvidence, renderEvidenceRead, type EvidencePackV2,
} from "../../packages/contracts/src/index.js";
import { v1Pack, v2Pack } from "../support/evidence-v2-fixtures.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const withLevel = (reached: string, isolation = "sealed", result = "verified"): EvidencePackV2 => v2Pack({ level: { reached, required: [] }, producer: { edition: "cloud", isolation }, result });

describe("the first line, one golden per level", () => {
  it.each([
    ["rovara_real_run", "Verified · Real run by Rovara"],
    ["their_ci", "Verified · Checked by your CI"],
    ["sandbox_only", "Verified · Sandbox only, not a real run"],
    ["no_ci", "Verified · No CI to check against"],
    ["ci_not_readable", "Verified · Your CI results could not be read"],
  ])("%s", (level, expected) => {
    expect(renderEvidence(withLevel(level)).firstLine).toBe(expected);
  });

  it("covers every level the schema knows", () => {
    for (const level of EVIDENCE_LEVELS) expect(renderEvidence(withLevel(level)).firstLine).not.toContain(NEWER_EVIDENCE_WORDS);
  });

  it("names the result axis and the weakest stage, and says 'not sealed' when the round ran in the sandbox", () => {
    const pack = v2Pack({ level: { reached: "sandbox_only", required: ["sealed"], weakest: { stageId: "sealed", words: "38 tests used recorded answers" } }, producer: { edition: "cloud", isolation: "sandbox" }, result: "partially_verified" });
    expect(renderEvidence(pack).firstLine).toBe("Partly verified · Sandbox only, not a real run · weakest: 38 tests used recorded answers · not sealed");
    expect(renderEvidence(withLevel("rovara_real_run", "sealed", "code_failed")).firstLine).toBe("Code failed checks · Real run by Rovara");
    expect(renderEvidence(withLevel("rovara_real_run", "sealed", "blocked_by_environment")).firstLine).toBe("Blocked by the environment · Real run by Rovara");
  });

  it("says nothing better than the words it has for a level or result it does not know", () => {
    const read = readEvidencePack({ ...clone(v2Pack()), level: { reached: "quantum", required: [] }, result: "mystery" });
    expect(read.status).toBe("v2");
    if (read.status === "v2") expect(renderEvidence(read.pack, { newer: read.newer }).firstLine).toBe(`${NEWER_EVIDENCE_WORDS} · ${NEWER_EVIDENCE_WORDS}`);
  });
});

describe("the producer line", () => {
  it.each([
    ["developer_machine", "Ran on a developer machine"],
    ["sealed", "Checked in a sealed round"],
    ["sandbox", "Checked in the agent's sandbox (not sealed)"],
    ["imported", "Imported from your CI (not run by Rovara)"],
  ])("%s", (isolation, expected) => {
    expect(renderEvidence(withLevel("rovara_real_run", isolation)).producerLine).toBe(expected);
    expect(renderEvidence(withLevel("rovara_real_run", isolation)).body[0]).toBe(expected);
  });

  it("puts 'not sealed' in the first line only for the sandbox", () => {
    expect(renderEvidence(withLevel("rovara_real_run", "sandbox")).firstLine.endsWith("not sealed")).toBe(true);
    for (const isolation of ["sealed", "developer_machine", "imported"]) expect(renderEvidence(withLevel("rovara_real_run", isolation)).firstLine).not.toContain("not sealed");
  });
});

describe("the full text of a complete pack", () => {
  it("is this golden", () => {
    expect(renderEvidence(v2Pack()).text).toBe([
      "Verified · Real run by Rovara",
      "Checked in a sealed round",
      "Checks: 2 (2 passed)",
      "- Tests: pytest -q: passed, 3 tests (1 new), 90% of changed lines covered",
      "- Benchmark: render time: passed, p95 118 ms (was 120 ms)",
      "Change proof: 1 proven",
      "Dependencies: Real · Recorded (12 Nov)",
      "- stripe: Recorded (12 Nov)",
      "- postgres: Real",
      "Spent: $0.40 model, 12 machine minutes ($0.10)",
      "Not tested:",
      "- refund flow (no test)",
    ].join("\n"));
  });

  it("renders a v1 pack upgraded with its context", () => {
    const upgraded = evidencePackV1ToV2(v1Pack(), { producer: { edition: "code", isolation: "developer_machine" }, level: { reached: "their_ci", required: [] }, result: "verified" });
    const out = renderEvidence(upgraded);
    expect(out.firstLine).toBe("Verified · Checked by your CI");
    expect(out.producerLine).toBe("Ran on a developer machine");
    expect(out.text).toContain("- Tests: pytest -q: passed, 3 tests (1 new), 90% of changed lines covered");
  });
});

describe("slots", () => {
  it("shows the time-target line and the Rovara-problem line only when given", () => {
    const plain = renderEvidence(v2Pack());
    expect(plain.text).not.toContain("Time target");
    const slotted = renderEvidence(v2Pack(), { timeTargetLine: "Time target: ready in 40 min (p75 of 20 runs)", rovaraProblemLine: "Held back: Rovara problem, not your code" });
    expect(slotted.body.slice(0, 3)).toEqual(["Checked in a sealed round", "Held back: Rovara problem, not your code", "Time target: ready in 40 min (p75 of 20 runs)"]);
    expect(renderEvidence(v2Pack(), { timeTargetLine: "   " }).text).toBe(plain.text);
  });
});

describe("trust and proof words", () => {
  it("shows a scripted-AI proof as 'proven with scripted AI replies', never Real", () => {
    const pack = clone(v2Pack());
    Object.assign(pack.checks[0]!, { proofBasis: "scripted_ai_replies", trust: "simulated" });
    const out = renderEvidence(pack).text;
    expect(out).toContain("proven with scripted AI replies");
    const line = out.split("\n").find((entry) => entry.startsWith("- Tests"))!;
    expect(line).not.toMatch(/Real/u);
  });

  it("counts Made by Rovara mocks by when they were made", () => {
    const pack = clone(v2Pack());
    pack.dependencies = [
      { name: "a", kind: "http", backing: "fake", label: "hand_written_fake", trust: "made_by_rovara", mock: { setId: "m1", version: 1, branch: "main", madeIn: "this_task", store: "rovara" } },
      { name: "b", kind: "http", backing: "fake", label: "hand_written_fake", trust: "made_by_rovara", mock: { setId: "m2", version: 1, branch: "main", madeIn: "this_task", store: "rovara" } },
      { name: "c", kind: "http", backing: "none", label: "faked_by_tests", trust: "no_outside_calls" },
    ];
    expect(renderEvidence(pack).text).toContain("Dependencies: Made by Rovara (2 made during this task) · No outside calls");
  });
});

describe("newer evidence", () => {
  it("adds one line when the reader met parts it did not know, and a first-line stand-in for a later version", () => {
    const read = readEvidencePack({ ...clone(v2Pack()), hologram: 1 });
    expect(read.status).toBe("v2");
    if (read.status === "v2") expect(renderEvidence(read.pack, { newer: read.newer }).body.at(-1)).toBe(NEWER_EVIDENCE_WORDS);
    expect(renderEvidenceRead(readEvidencePackLater()).firstLine).toBe(NEWER_EVIDENCE_WORDS);
    expect(renderEvidenceRead({ status: "unreadable", reason: "not_a_pack" }).firstLine).toBe("Evidence could not be read, open in Rovara");
    expect(renderEvidenceRead({ status: "v1", pack: v1Pack() }).firstLine).toBe("Evidence from an older Rovara, open in Rovara for the level");
  });
});

function readEvidencePackLater() {
  return readEvidencePack({ schemaVersion: 3 });
}

describe("bounds", () => {
  it("stays inside the character limit and says how many it left out, for 64 checks with long labels and 200 not-tested rows", () => {
    const pack = clone(v2Pack());
    pack.checks = Array.from({ length: 64 }, (_, index) => ({ id: `c${index}`, kind: "test", label: "L".repeat(200), before: "passed", after: "passed", class: "passing", durationMs: 1, tests: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0, names: [], newTests: [] } }));
    pack.notTested = Array.from({ length: 200 }, (_unused, index) => ({ what: "W".repeat(300), reason: `R${String(index)}` }));
    pack.dependencies = Array.from({ length: 24 }, (_unused, index) => ({ name: `${"D".repeat(70)}${String(index)}`, kind: "http", backing: "none", label: "not_available", trust: "simulated" }));
    const out = renderEvidence(pack);
    expect(out.text.length).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.textMax);
    expect(out.firstLine.length).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.lineMax);
    for (const line of out.text.split("\n")) expect(Array.from(line).length, line.slice(0, 40)).toBeLessThanOrEqual(EVIDENCE_RENDER_LIMITS.lineMax);
    expect(out.text).toContain(`and ${64 - EVIDENCE_RENDER_LIMITS.checksListed} more checks`);
    expect(out.text).toContain(`and ${200 - EVIDENCE_RENDER_LIMITS.notTestedListed} more`);
  });

  it("makes every word from a repository inert: no hidden characters, mentions, links, images, issue references or closing keys", () => {
    const pack = clone(v2Pack());
    pack.checks[0]!.label = "![x](http://evil.test/a.png) @octocat see https://evil.test #123 Fixes ENG-42‮ <!-- hide";
    pack.notTested = [{ what: "<script>alert(1)</script> [click](http://e.co)", reason: "line\nbreak" }];
    const text = renderEvidence(pack).text;
    expect(text).not.toMatch(/[‮]/u);
    expect(text).not.toMatch(/!\[/u);
    expect(text).not.toMatch(/@octocat/u);
    expect(text).not.toMatch(/:\/\/(?!\u200D)/u);
    expect(text).not.toMatch(/#123/u);
    expect(text).not.toMatch(/ENG-42/u);
    expect(text).not.toContain("<");
  });
});

describe("no callers", () => {
  it("nothing outside packages/contracts imports the renderer or the v2 reader yet", () => {
    const found = spawnSync("git", ["grep", "--untracked", "-lE", "evidence-render|renderEvidence|readEvidencePack|evidencePackV1ToV2|check-kinds", "--", "packages", "scripts", "infra"], { encoding: "utf8", cwd: fileURLToPath(new URL("../..", import.meta.url)) });
    expect([0, 1]).toContain(found.status);
    const hits = found.stdout.split("\n").filter((entry) => entry !== "");
    expect(hits.filter((file) => !file.startsWith("packages/contracts/"))).toEqual([]);
  });
});
