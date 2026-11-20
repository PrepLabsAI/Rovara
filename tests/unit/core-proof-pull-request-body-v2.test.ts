// TE-A2b: the pull request description calls the shared evidence renderer for its first line and its evidence block when the writer is version 2 and the pack is a v2 pack for this code. Version 1 stays the default
// and is byte for byte what it was. A reader meets every shape: a v1 pack, a v2 pack with parts it does not know, a v2 pack for other code, a hostile one. Everything a repository wrote goes through the shared inert text.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EVIDENCE_COMPACT_POINTER, NEWER_EVIDENCE_WORDS, readEvidencePack, type EvidencePack, type EvidencePackRead } from "../../packages/contracts/src/index.js";
import { WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot } from "../../packages/contracts/src/task-workflow-node.js";
import { rovaraPullRequestBody, rovaraStatusLines, PULL_REQUEST_BODY_MAX_BYTES, type PullRequestBodyContext } from "../../packages/broker/src/core/proof/pull-request-body.js";
import { DRAWER_LEFT_OUT } from "../../packages/broker/src/core/proof/pull-request-layout.js";
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
/** L4-C: where the Evidence block now is: the text of the "Checks" drawer (the renderer's block without its heading, for a private repository with the version 2 writer; the counts-only AI lines for a public one). */
const checksDrawer = (lines: readonly string[] | string): string => {
  const text = typeof lines === "string" ? lines : lines.join("\n");
  const at = text.indexOf("<summary>Checks: ");
  return at === -1 ? "" : text.slice(at, text.indexOf("</details>", at));
};
const body = (ctx: PullRequestBodyContext) => rovaraPullRequestBody({ summary: ["Retry the payment"], fallbackTitle: "t", workflow: workflow(), context: ctx, reviewLines: () => ["- no findings"], pageUrl: undefined });

describe("old data and unknown parts", () => {
  it("a v1 pack with the v2 writer on prints what a v1 pack always printed (no level, no first line is invented)", () => {
    const ctx = context({ evidenceWriter: 2 }, { read: { status: "v1", pack: v1Pack() } });
    expect(status(ctx)).toEqual(status({ ...context(), proof: { evidence: evidence() } }));
  });
  it("a v2 pack with parts this build does not know says 'newer evidence' and still renders the rest", () => {
    const wire = JSON.parse(JSON.stringify(evidencePackV2Of(v1Pack(), writer))) as Record<string, unknown>;
    wire.hologram = { x: 1 };
    (wire.checks as Record<string, unknown>[])[0]!.telemetry = [1];
    const text = status(context({ evidenceWriter: 2 }, { read: readEvidencePack(wire) })).join("\n");
    expect(text).toContain(NEWER_EVIDENCE_WORDS);
    expect(text).toContain("Verified · Run by Rovara, not sealed");
  });
});

describe("the flags and the weakening words are the shared ones, once", () => {
  const files: ChangedFileEntry[] = [{ repository: "app", path: "CLAUDE.md", added: 1, removed: 0 }, { repository: "app", path: "a/__snapshots__/x.snap", added: 1, removed: 1, snapshotChanged: true }];
  it("a v2 pack the writer made with the files in it still shows them when the description has no file list", () => {
    const read = v2Read(v1Pack(), { ...writer, changedFiles: files });
    const text = status({ ...context({ evidenceWriter: 2 }, { read }), changedFiles: undefined }).join("\n");
    expect(text).toContain("Rovara instruction files changed (a flag, not an approval): CLAUDE.md");
  });
});

describe("the Evidence block is printed only where the repository is known to be private (B12 review M2)", () => {
  const withNames = (over: Partial<PullRequestBodyContext>) => {
    const pack = v1Pack("pytest -q for jane.doe@example.com");
    return { ...context({ evidenceWriter: 2, ...over }, { pack, read: v2Read(pack) }) };
  };
  it.each([["public", false], ["unknown", undefined]])("a %s repository gets no block, no check label and no v2 text: the description is the v1 one", (_name, known) => {
    const ctx = withNames({ repositoryKnownPrivate: known });
    const text = status(ctx).join("\n");
    expect(text).not.toContain("jane.doe");
    expect(text).not.toContain("Run by Rovara, not sealed");
    expect(status(ctx)).toEqual(status({ ...ctx, evidenceWriter: 1 }));
    expect(body(ctx)).not.toContain("Run by Rovara, not sealed");
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
    expect(text).not.toContain("Run by Rovara");
  });
});

describe("a proof that could not compare says so in the v2 block too (TE-B3)", () => {
  const proof = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1 as const, candidateDigest: DIGEST, status: "not_checked" as const, note: "stopped" as const, changedTests: { added: 1, changed: 0, deleted: 0 }, items: [], durationMs: 1, ...over }) as never;
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
});

describe("untrusted text", () => {
  it.each(["# heading", "> quote", "---", "```", "~~~"])("a label that starts with %s cannot open a heading, a quote, a rule or a fence", (start) => {
    const pack = v1Pack(`${start} injected`);
    const lines = status(context({ evidenceWriter: 2 }, { pack, read: v2Read(pack) }));
    // No line of the Checks drawer starts a heading, a quote, a rule or a fence, and the page has the one heading it always has.
    expect(checksDrawer(lines).split("\n").filter((line) => /^(#|>|-{3,}|`{3}|~{3})/u.test(line))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("## ")).length).toBe(1);
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
    // The drawers' bodies point to the Check and the task page, and what a reader must see stays above the fold.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2_500);
    // Even the smallest budget shows the compact form or the pointer, never the 64 checks one by one.
    expect(text.includes(DRAWER_LEFT_OUT) || text.includes(EVIDENCE_COMPACT_POINTER)).toBe(true);
    expect(text.indexOf("Rovara instruction files changed")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Rovara instruction files changed")).toBeLessThan(text.indexOf("<details>"));
    expect(text).not.toContain("Checks: 64 (");
  });
});

describe("AI evidence public and private descriptions", () => {
  const aiArtifact = () => ({ schemaVersion: 1, candidateDigest: DIGEST, roundKind: "check_unsealed", evalPass: 1, outcome: "done", context: { aiChange: true, discovery: "configured", previousPasses: 0 }, questions: Array.from({ length: 1000 }, (_, i) => ({ id: i === 999 ? "CANARY-SAFETY" : `q${i}`, category: i === 999 ? "safety" : "ordinary", edited: false, old: [true, true, true], first: i !== 999, ...(i === 999 ? { freshOld: [true, true, true], freshNew: [false, false, false], answers: { old: ["CANARY-OLD", "CANARY-OLD", "CANARY-OLD"], first: "CANARY-NEW", freshOld: ["CANARY-OLD", "CANARY-OLD", "CANARY-OLD"], freshNew: ["CANARY-NEW", "CANARY-NEW", "CANARY-NEW"] } } : {}) })), options: { changedPromptCalls: 1, hiddenSetUsed: false, subsetSupported: true, sameJudgeFamily: false }, excluded: [], notices: [], usage: { calls: 1006 }, cache: "not_used" });
  it("keeps the label and counts in public bodies, full answers only in private bodies", () => {
    const read = v2Read(v1Pack(), { ...writer, evalArtifact: aiArtifact() });
    for (const repositoryKnownPrivate of [false, undefined, true]) {
      const ctx = context({ evidenceWriter: 2, repositoryKnownPrivate }, { read });
      const text = body(ctx);
      expect(text).toContain("Worse on eval: 1 question broke");
      expect(text).toContain("Eval counts: 1000 questions");
      expect(text.includes("CANARY")).toBe(repositoryKnownPrivate === true);
      if (repositoryKnownPrivate !== true) {
        const drawer = checksDrawer(text);
        expect(drawer).toContain("Worse on eval: 1 question broke\n\nAI checks\n\nEval: Worse on eval\n\nEval counts: 1000 questions; 1 broke; 0 newly fail; 0 newly pass; 0 flaky; 999 unchanged; 0 excluded\n\nReal-model run: Not run (not available yet)");
        expect(drawer).not.toContain("Checks by trust:");
        expect(drawer).not.toContain("Checked in a sealed round");
      }
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(PULL_REQUEST_BODY_MAX_BYTES);
    }
  });
  it.each(["not_run", "done"] as const)("public non-Worse blocks contain only AI evidence (%s)", outcome => {
    const base = aiArtifact();
    const evalArtifact = outcome === "not_run"
      ? { ...base, outcome, notRunReason: "no_eval_configured", questions: undefined, options: undefined, context: { aiChange: true, discovery: "not_configured", previousPasses: 0 }, evalConfigured: false }
      : { ...base, questions: base.questions.map(q => ({ ...q, first: true, freshOld: undefined, freshNew: undefined, answers: undefined })) };
    const read = v2Read(v1Pack(), { ...writer, evalArtifact });
    for (const repositoryKnownPrivate of [false, undefined]) {
      const text = body(context({ evidenceWriter: 2, repositoryKnownPrivate }, { read }));
      const drawer = checksDrawer(text);
      const block = drawer.slice(drawer.indexOf("AI checks"));
      expect(block).toContain(outcome === "not_run" ? "Eval: Not run." : "Eval: No regression measured (eval)");
      // A public repository gets the AI lines only (counts and labels): none of the private block's checks, tests, proof or dependency lines.
      expect(drawer).not.toContain("Run by Rovara");
      expect(block).not.toMatch(/Verified|Checks: \d|- Tests:|Change proof:|Dependencies:|below/u);
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
