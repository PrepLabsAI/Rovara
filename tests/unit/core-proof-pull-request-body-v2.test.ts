// TE-A2b: the pull request description calls the shared evidence renderer for its first line and its evidence block when the writer is version 2 and the pack is a v2 pack for this code. Version 1 stays the default
// and is byte for byte what it was. A reader meets every shape: a v1 pack, a v2 pack with parts it does not know, a v2 pack for other code, a hostile one. Everything a repository wrote goes through the shared inert text.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVIDENCE_COMPACT_POINTER, NEWER_EVIDENCE_WORDS, readEvidencePack, type EvidencePack, type EvidencePackRead } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { rovaraPullRequestBody, rovaraStatusLines, PULL_REQUEST_BODY_MAX_BYTES, type PullRequestBodyContext } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { buildEvidencePack, evidencePackV2Of, type EvidenceV2Writer } from "../../packages/broker/src/core/proof/evidence-pack.js";
import { evidenceV2Lines } from "../../packages/broker/src/core/proof/evidence-v2-lines.js";
import type { ChangedFileEntry } from "../../packages/broker/src/core/proof/verification-report.js";

const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "1".repeat(40), baseCommitSha: "e".repeat(40) }]);
const workflow = () => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-11-13T12:00:00.000Z", definitionVersion: "1.1.0" }),
  stage: "PULL_REQUEST", state: "READY", candidate,
  checkPolicy: { required: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/app", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], optional: [], selectedOptionalIds: [], proposed: [] },
  verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: "2026-11-13T12:00:00.000Z", results: [{ checkId: "unit", status: "PASS" }] },
  reviews: (["CRITIC", "SECURITY"] as const).map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: "2026-11-13T12:00:00.000Z" })),
});
const DIGEST = candidate.digest;
const rawText = JSON.stringify({ schemaVersion: 1, candidateDigest: DIGEST, checks: [{ checkId: "readiness:0", tests: { total: 4, passed: 4, failed: 0, skipped: 0, errored: 0, names: [{ name: "t.py::a", status: "passed" }], newTests: ["t.py::a"] } }], selection: { method: "full", selected: 4, total: 4 } });
const check = (label = "pytest -q") => ({ id: "readiness:0", label, source: "project" as const, before: "passed" as const, after: "passed" as const, class: "passing" as const, output: "", durationMs: 700, exitCode: 0 });
const v1Pack = (label?: string): EvidencePack => buildEvidencePack({ candidateDigest: DIGEST, rawText, checks: [check(label)], checkKinds: new Map([["readiness:0", "test" as const]]), environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] }, storedArtifacts: new Map() }).pack!;
const writer: EvidenceV2Writer = { version: 2, producer: { edition: "code", isolation: "sandbox" } };
const v2Read = (pack = v1Pack(), w: EvidenceV2Writer = writer): EvidencePackRead => {
  const read = readEvidencePack(JSON.parse(JSON.stringify(evidencePackV2Of(pack, w))));
  if (read.status !== "v2") throw new Error("not v2");
  return read;
};
const ORIGIN = "https://rovara.example";
const evidence = (over: Record<string, unknown> = {}) => ({ pack: v1Pack(), mode: "link" as const, origin: ORIGIN, taskUrl: `${ORIGIN}/tasks/1`, ...over });
const context = (over: Partial<PullRequestBodyContext> = {}, evidenceOver: Record<string, unknown> = {}): PullRequestBodyContext => ({ proof: { evidence: evidence({ read: v2Read(), ...evidenceOver }) }, changedFiles: { files: [{ repository: "app", path: "src/a.ts", added: 2, removed: 1 }], complete: true }, repositoryKnownPrivate: true, ...over });
const status = (ctx: PullRequestBodyContext) => rovaraStatusLines(workflow(), ctx, () => ["- no findings"]);
const body = (ctx: PullRequestBodyContext) => rovaraPullRequestBody({ summary: ["Retry the payment"], fallbackTitle: "t", workflow: workflow(), context: ctx, reviewLines: () => ["- no findings"], pageUrl: undefined });

describe("the writer version is a parameter and the default is version 1", () => {
  it("a v2 pack in the context changes nothing while the writer is not 2: the description is byte for byte what a v1 pack gives", () => {
    const v1Only = status({ ...context(), proof: { evidence: evidence() } });
    for (const ctx of [context(), context({ evidenceWriter: 1 })]) expect(status(ctx)).toEqual(v1Only);
    expect(v1Only.join("\n")).not.toContain("## Evidence");
  });
  it("version 2 adds an Evidence block, first in Rovara's block, led by the renderer's first line", () => {
    const lines = status(context({ evidenceWriter: 2 }));
    expect(lines[0]).toBe("## Evidence");
    expect(lines[1]).toBe("Verified · Run by Rovara, not sealed");
    expect(lines[2]).toBe("");
    expect(lines).toContain("Checked in the agent's sandbox (not sealed)");
    expect(lines.indexOf("## Evidence")).toBeLessThan(lines.indexOf("## What changed"));
    expect(lines.join("\n")).toContain("- Tests: pytest -q: passed, 4 tests (1 new)");
  });
  it("golden: the same fixture under the v1 writer and the v2 writer", () => {
    const v1Text = status(context()).join("\n");
    const v2Text = status(context({ evidenceWriter: 2 })).join("\n");
    expect(v2Text.startsWith("## Evidence\nVerified · Run by Rovara, not sealed\n\nChecked in the agent's sandbox (not sealed)\n\nChecks: 1 (1 passed)\n- Tests: pytest -q: passed, 4 tests (1 new)\n\n")).toBe(true);
    // Everything v1 said is still said, after the block: the v2 block is added, it takes none of the v1 sections away.
    expect(v2Text).not.toBe(v1Text);
    expect(v2Text.endsWith(v1Text)).toBe(true);
  });
});

describe("old data and unknown parts", () => {
  it("a v1 pack with the v2 writer on prints what a v1 pack always printed (no level, no first line is invented)", () => {
    const ctx = context({ evidenceWriter: 2 }, { read: { status: "v1", pack: v1Pack() } });
    expect(status(ctx)).toEqual(status({ ...context(), proof: { evidence: evidence() } }));
  });
  it("no pack at all with the v2 writer on is the description without evidence", () => {
    expect(status({ ...context({ evidenceWriter: 2 }), proof: undefined }).join("\n")).not.toContain("## Evidence");
  });
  it("a v2 pack with parts this build does not know says 'newer evidence' and still renders the rest", () => {
    const wire = JSON.parse(JSON.stringify(evidencePackV2Of(v1Pack(), writer))) as Record<string, unknown>;
    wire.hologram = { x: 1 };
    (wire.checks as Record<string, unknown>[])[0]!.telemetry = [1];
    const text = status(context({ evidenceWriter: 2 }, { read: readEvidencePack(wire) })).join("\n");
    expect(text).toContain(NEWER_EVIDENCE_WORDS);
    expect(text).toContain("Verified · Run by Rovara, not sealed");
  });
  it("a v2 pack for other code is not shown, however well it parses", () => {
    const other = JSON.parse(JSON.stringify(evidencePackV2Of(v1Pack(), writer))) as { candidate: { digest: string } };
    other.candidate.digest = "d".repeat(64);
    expect(status(context({ evidenceWriter: 2 }, { read: readEvidencePack(other) })).join("\n")).not.toContain("## Evidence");
  });
  it("a pack that is only 'newer' or unreadable gives no block", () => {
    for (const read of [{ status: "newer", schemaVersion: 3 }, { status: "unreadable", reason: "core_invalid" }]) {
      expect(status(context({ evidenceWriter: 2 }, { read })).join("\n")).not.toContain("## Evidence");
    }
  });
});

describe("the flags and the weakening words are the shared ones, once", () => {
  const files: ChangedFileEntry[] = [{ repository: "app", path: "CLAUDE.md", added: 1, removed: 0 }, { repository: "app", path: "a/__snapshots__/x.snap", added: 1, removed: 1, snapshotChanged: true }];
  it("the v2 block carries them, built from the description's own changed files, and the v1 flags block is not printed a second time", () => {
    const text = status(context({ evidenceWriter: 2, changedFiles: { files, complete: true } })).join("\n");
    expect(text.match(/Rovara instruction files changed/gu)).toHaveLength(1);
    expect(text.match(/Snapshot files changed/gu)).toHaveLength(1);
    expect(text).not.toContain("## Flags for the reviewer");
    expect(text.indexOf("Rovara instruction files changed")).toBeLessThan(text.indexOf("Tests may be weaker:"));
  });
  it("under the v1 writer the flags are still Rovara's own block at the top", () => {
    const lines = status(context({ changedFiles: { files, complete: true } }));
    expect(lines[0]).toBe("## Flags for the reviewer");
  });
  it("a v2 pack the writer made with the files in it still shows them when the description has no file list", () => {
    const read = v2Read(v1Pack(), { ...writer, changedFiles: files });
    const text = status({ ...context({ evidenceWriter: 2 }, { read }), changedFiles: undefined }).join("\n");
    expect(text).toContain("Rovara instruction files changed (a flag, not an approval): CLAUDE.md");
  });
  it("shows the tests that ran before and not now, from the pack's tests part", () => {
    const pack = v1Pack();
    const tests = { ...pack.checks[0]!.tests!, absentOnNew: ["t.py::gone"], absentOnNewCount: 1 };
    const withAbsent: EvidencePack = { ...pack, checks: [{ ...pack.checks[0]!, tests }] };
    const text = status(context({ evidenceWriter: 2 }, { pack: withAbsent, read: v2Read(withAbsent) })).join("\n");
    expect(text).toContain("1 test ran before and not now: t.py::gone");
  });
});

describe("the Evidence block is printed only where the repository is known to be private (B12 review M2)", () => {
  const withNames = (over: Partial<PullRequestBodyContext>) => {
    const pack = v1Pack("pytest -q for jane.doe@example.com");
    return { ...context({ evidenceWriter: 2, ...over }, { pack, read: v2Read(pack) }) };
  };
  it("a private repository gets the block", () => {
    expect(status(withNames({ repositoryKnownPrivate: true })).join("\n")).toContain("## Evidence");
  });
  it.each([["public", false], ["unknown", undefined]])("a %s repository gets no block, no check label and no v2 text: the description is the v1 one", (_name, known) => {
    const ctx = withNames({ repositoryKnownPrivate: known });
    const text = status(ctx).join("\n");
    expect(text).not.toContain("## Evidence");
    expect(text).not.toContain("jane.doe");
    expect(text).not.toContain("Run by Rovara, not sealed");
    expect(status(ctx)).toEqual(status({ ...ctx, evidenceWriter: 1 }));
    expect(body(ctx)).not.toContain("## Evidence");
  });
});

describe("a stored pack whose producer and level disagree is not shown as a Rovara run (TE-A2b review M3)", () => {
  it.each(["developer_machine", "imported", "teleport"])("a v2 pack with isolation %s and level rovara_real_run gives no Evidence block", (isolation) => {
    const wire = JSON.parse(JSON.stringify(evidencePackV2Of(v1Pack(), { ...writer, producer: { edition: "code", isolation: "sealed" } }))) as { producer: { isolation: string }; level: { reached: string } };
    wire.producer.isolation = isolation;
    wire.level.reached = "rovara_real_run";
    const read = readEvidencePack(wire);
    expect(read.status).toBe("v2");
    const text = status(context({ evidenceWriter: 2 }, { read })).join("\n");
    expect(text).not.toContain("## Evidence");
    expect(text).not.toContain("Run by Rovara");
  });
  it("a laptop pack that is honest about itself (the CI still running) still shows, in the laptop words", () => {
    const wire = JSON.parse(JSON.stringify(evidencePackV2Of(v1Pack(), { ...writer, producer: { edition: "code", isolation: "developer_machine" } }))) as unknown;
    const text = status(context({ evidenceWriter: 2 }, { read: readEvidencePack(wire) })).join("\n");
    expect(text).toContain("Verified · Ran on a developer machine");
    expect(text).not.toContain("Sandbox only");
  });
});

describe("a proof that could not compare says so in the v2 block too (TE-B3)", () => {
  const proof = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, candidateDigest: DIGEST, status: "not_checked" as const, note: "stopped" as const, changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], durationMs: 1, ...over }) as never;
  const LINE = "Test weakening: could not compare (the run was stopped)";
  it("the line is in the Evidence block once, with the v1 flags block gone, and the v1 writer says it in the flags block", () => {
    const withProof = (over: Partial<PullRequestBodyContext>) => ({ ...context(over), proof: { evidence: evidence({ read: v2Read() }), testProof: proof() } }) as PullRequestBodyContext;
    const v2 = status(withProof({ evidenceWriter: 2 })).join("\n");
    expect(v2.match(/Test weakening: could not compare/gu)).toHaveLength(1);
    expect(v2).toContain(LINE);
    expect(v2).not.toContain("## Flags for the reviewer");
    expect(v2.indexOf(LINE)).toBeLessThan(v2.indexOf("## What changed"));
    expect(status(withProof({})).join("\n")).toContain(`## Flags for the reviewer\n- ${LINE}`);
  });
  it("no proof context, or a proof that did compare, adds no line", () => {
    expect(status(context({ evidenceWriter: 2 })).join("\n")).not.toContain("Test weakening");
    const compared = { weakening: [{ checkId: "readiness:0", skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 }], status: "checked", note: "completed" };
    const ctx = { ...context({ evidenceWriter: 2 }), proof: { evidence: evidence({ read: v2Read() }), testProof: proof(compared) } } as PullRequestBodyContext;
    expect(status(ctx).join("\n")).not.toContain("Test weakening");
  });
  it.each([false, true])("keeps every uncompared check in the v2 block when another check was compared: %s", (hasCompared) => {
    const compared = { checkId: "readiness:0", skippedBefore: 0, skippedAfter: 0, absentOnNew: [], absentOnNewCount: 0 };
    const ctx = { ...context({ evidenceWriter: 2 }), proof: { evidence: evidence({ read: v2Read() }), testProof: proof({
      status: "checked", note: "completed", weakening: hasCompared ? [compared] : [],
      items: [{ checkId: "readiness:1", label: "integration" }, { checkId: "readiness:2", label: "browser" }],
      weakeningNotCompared: [{ checkId: "readiness:1", reason: "original_run_truncated" }, { checkId: "readiness:2", reason: "no_report" }],
    }) } } as PullRequestBodyContext;
    const text = status(ctx).join("\n");
    expect(text.match(/Test weakening: could not compare/gu)).toHaveLength(2);
    expect(text).toContain("Test weakening: could not compare integration (the run on the original code looks cut short)");
    expect(text).toContain("Test weakening: could not compare browser (a test report was not available from both runs)");
    expect(text).not.toContain("## Flags for the reviewer");
  });
  it("the compact form keeps the line", () => {
    const ctx = { ...context({ evidenceWriter: 2 }), proof: { evidence: evidence({ read: v2Read() }), testProof: proof() } } as PullRequestBodyContext;
    const block = evidenceV2Lines(ctx.proof!.evidence, DIGEST, ctx.changedFiles?.files, 3, [LINE])!;
    expect(block).toContain(LINE);
    expect(block).toContain(EVIDENCE_COMPACT_POINTER);
  });
});

describe("untrusted text", () => {
  const hostile = "[click](https://evil.example) ![x](https://evil.example/i.png) @everyone #123 Fixes ABC-1 <img src=x> \u200b\u202e";
  it("a check label, which a repository wrote, is inert in the block", () => {
    const pack = v1Pack(hostile);
    const text = status(context({ evidenceWriter: 2 }, { pack, read: v2Read(pack) })).join("\n");
    expect(text).not.toMatch(/https:\/\/evil|<img|@everyone|\u200b|\u202e|\]\(/u);
    expect(text).toContain("## Evidence");
  });
  it.each(["# heading", "> quote", "---", "```", "~~~"])("a label that starts with %s cannot open a heading, a quote, a rule or a fence", (start) => {
    const pack = v1Pack(`${start} injected`);
    const lines = status(context({ evidenceWriter: 2 }, { pack, read: v2Read(pack) }));
    const block = lines.slice(0, lines.indexOf("## What changed"));
    expect(block.filter((line) => /^(#|>|-{3,}|`{3}|~{3})/u.test(line)).length).toBe(1);
    expect(block.filter((line) => line.startsWith("## ")).length).toBe(1);
  });
  it("a pack with a __proto__ key (at the top and in a check) renders, reports newer evidence and pollutes nothing", () => {
    const text = JSON.stringify(evidencePackV2Of(v1Pack(), writer)).replace(/^\{/u, '{"__proto__":{"polluted":true},').replace('"kind":"test"', '"__proto__":{"polluted":true},"kind":"test"');
    const read = readEvidencePack(JSON.parse(text));
    expect(read.status).toBe("v2");
    const out = status(context({ evidenceWriter: 2 }, { read })).join("\n");
    expect(out).toContain("## Evidence");
    expect(out).toContain(NEWER_EVIDENCE_WORDS);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("a 1 MB label is cut in the block and costs little time", () => {
    const pack = v1Pack("y".repeat(1_000_000).slice(0, 200));
    const read = readEvidencePack({ ...JSON.parse(JSON.stringify(evidencePackV2Of(pack, writer))), notTested: [{ what: "z".repeat(1_000_000), reason: "r".repeat(1_000_000) }] });
    const started = Date.now();
    const text = status(context({ evidenceWriter: 2 }, { pack, read })).join("\n");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(PULL_REQUEST_BODY_MAX_BYTES);
  });
});

describe("size", () => {
  it("shrinks to the compact form when the block does not fit, keeping the warnings and the pointer", () => {
    const checks = Array.from({ length: 64 }, (_unused, index) => ({ ...check(`check ${String(index)} ${"é".repeat(150)}`), id: `readiness:${String(index)}` }));
    const pack = buildEvidencePack({ candidateDigest: DIGEST, checks, environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] }, storedArtifacts: new Map() }).pack!;
    const files: ChangedFileEntry[] = Array.from({ length: 80 }, (_unused, index) => ({ repository: "app", path: `src/${"d".repeat(150)}${String(index)}.ts`, added: 1, removed: 1 }));
    files.push({ repository: "app", path: "AGENTS.md", added: 1, removed: 0 });
    const ctx = context({ evidenceWriter: 2, changedFiles: { files, complete: true } }, { pack, read: v2Read(pack) });
    const full = status(ctx);
    expect(Buffer.byteLength(full.join("\n"), "utf8")).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES - 6_000 - 2_000);
    expect(body(ctx).length).toBeLessThan(PULL_REQUEST_BODY_MAX_BYTES);
    // With almost no room the block is the compact form, and the instruction-file flag is still there.
    const tight = rovaraStatusLines(workflow(), ctx, () => ["- no findings"], 2_500);
    const text = tight.join("\n");
    expect(text).toContain(EVIDENCE_COMPACT_POINTER);
    expect(text).toContain("Rovara instruction files changed");
    expect(text).not.toContain("Checks: 64");
  });
  it("the whole description with the v2 block stays under the cap", () => {
    expect(Buffer.byteLength(body(context({ evidenceWriter: 2 })), "utf8")).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
  });
});

describe("AI evidence public and private descriptions", () => {
  it("an ordinary task with no eval renders byte-identically, with no synthetic Not run", () => {
    for (const repositoryKnownPrivate of [true, false, undefined]) {
      const control = body(context({ evidenceWriter: 2, repositoryKnownPrivate }));
      expect(control).not.toContain("AI checks");
      expect(control).not.toContain("Eval: Not run");
      for (const evalArtifact of [undefined, null, {}, "malformed root"]) {
        const read = v2Read(v1Pack(), { ...writer, evalArtifact });
        expect(body(context({ evidenceWriter: 2, repositoryKnownPrivate }, { read }))).toBe(control);
      }
    }
  });
  const aiArtifact = () => ({ schemaVersion: 1, candidateDigest: DIGEST, roundKind: "check_unsealed", evalPass: 1, outcome: "done", context: { aiChange: true, discovery: "configured", previousPasses: 0 }, questions: Array.from({ length: 1000 }, (_, i) => ({ id: i === 999 ? "CANARY-SAFETY" : `q${i}`, category: i === 999 ? "safety" : "ordinary", edited: false, old: [true, true, true], first: i !== 999, ...(i === 999 ? { freshOld: [true, true, true], freshNew: [false, false, false], answers: { old: ["CANARY-OLD", "CANARY-OLD", "CANARY-OLD"], first: "CANARY-NEW", freshOld: ["CANARY-OLD", "CANARY-OLD", "CANARY-OLD"], freshNew: ["CANARY-NEW", "CANARY-NEW", "CANARY-NEW"] } } : {}) })), options: { changedPromptCalls: 1, hiddenSetUsed: false, subsetSupported: true, sameJudgeFamily: false }, excluded: [], notices: [], usage: { calls: 1006 }, cache: "not_used" });
  it("keeps the label and counts in public bodies, full answers only in private bodies", () => {
    const read = v2Read(v1Pack(), { ...writer, evalArtifact: aiArtifact() });
    for (const repositoryKnownPrivate of [false, undefined, true]) {
      const ctx = context({ evidenceWriter: 2, repositoryKnownPrivate }, { read });
      const text = body(ctx);
      expect(text).toContain("Worse on eval: 1 question broke");
      expect(text).toContain("Eval counts: 1000 questions");
      expect(text.includes("CANARY")).toBe(repositoryKnownPrivate === true);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
    }
  });
  it("shrinking never sacrifices the label, counts or the broken safety question", () => {
    const read = v2Read(v1Pack(), { ...writer, evalArtifact: aiArtifact() });
    const ctx = context({ evidenceWriter: 2 }, { read });
    for (const level of [0, 1, 2, 3, 4]) {
      const text = evidenceV2Lines(ctx.proof?.evidence, DIGEST, [], level)!.join("\n");
      expect(text).toContain("Worse on eval: 1 question broke"); expect(text).toContain("1000 questions"); expect(text).toContain("CANARY-SAFETY");
    }
    const text = rovaraPullRequestBody({ summary: ["s".repeat(30000)], fallbackTitle: "t", workflow: workflow(), context: ctx, reviewLines: listed => Array.from({ length: listed }, () => "r".repeat(1500)), pageUrl: undefined });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
    expect(text).toContain("Worse on eval"); expect(text).toContain("1000 questions"); expect(text).toContain("CANARY-SAFETY");
  });
});
