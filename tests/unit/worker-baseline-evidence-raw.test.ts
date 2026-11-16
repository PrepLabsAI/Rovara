// TE-C1: the raw evidence file carries the worker's baseline claim only when it was asked for one, and an old plan writes the file it always wrote.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVIDENCE_RAW_ARTIFACT, EvidenceRawSchema, createCandidateManifest, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { collectEvidenceRaw, saveEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";

const DIGEST = "d".repeat(64);
const CLAIM = { sha: "e".repeat(40), commitsBack: 3 };
const command: ProjectCommand = { executable: "pytest", args: ["-q"], cwd: ".", timeoutSeconds: 60 };
const entry: CheckEntry = { id: "readiness:0", label: "pytest", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 1 };
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "baseline-raw-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("the baseline claim in the raw evidence file", () => {
  it("is written when given, even with no report to read, and the file still parses", async () => {
    const raw = await collectEvidenceRaw({ rootPath: root, commands: [command], entries: [entry], candidateDigest: DIGEST, repositories: [], baseline: CLAIM });
    expect(raw).toMatchObject({ schemaVersion: 1, candidateDigest: DIGEST, checks: [], baseline: CLAIM });
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
  });

  it("is absent when none was asked for: no file at all, exactly as before", async () => {
    expect(await collectEvidenceRaw({ rootPath: root, commands: [command], entries: [entry], candidateDigest: DIGEST, repositories: [] })).toBeUndefined();
  });

  it("is saved through the sink in evidence-raw.json for a project plan, and a plan that was not asked leaves the key out", async () => {
    const candidate = [{ repositoryId: "api", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) }];
    const saved: Array<{ name: string; content: string }> = [];
    const sink = (artifact: { name: string; content: string | Buffer }) => { saved.push({ name: artifact.name, content: String(artifact.content) }); return Promise.resolve(); };
    const plan = { source: "project" as const, readiness: [command] };
    const failed = { ...entry, after: "failed", class: "regression", exitCode: 1, output: "boom" } as CheckEntry;
    expect(await saveEvidenceRaw({ sink: sink, rootPath: root, plan: plan, entries: [failed], repositories: [], candidateBefore: candidate, baselineClaim: CLAIM })).toBe(true);
    expect(saved[0]?.name).toBe(EVIDENCE_RAW_ARTIFACT);
    const parsed = EvidenceRawSchema.parse(JSON.parse(saved[0]!.content));
    expect(parsed.baseline).toEqual(CLAIM);
    expect(parsed.candidateDigest).toBe(createCandidateManifest(candidate).digest);
    saved.length = 0;
    expect(await saveEvidenceRaw({ sink: sink, rootPath: root, plan: plan, entries: [failed], repositories: [], candidateBefore: candidate })).toBe(true);
    expect(JSON.parse(saved[0]!.content)).not.toHaveProperty("baseline");
  });
});
