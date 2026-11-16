// TE-MR2b, the worker's half of the combined baseline: one claim per repository, all or none, found in the isolated git environment before any check runs; written to the raw file only when it was asked for.
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVIDENCE_RAW_ARTIFACT, EvidenceRawSchema, type CheckEntry, type ProjectCommand } from "../../packages/contracts/src/index.js";
import { findBaselineAncestors } from "../../packages/worker/src/verification/baseline-ancestry.js";
import { collectEvidenceRaw, saveEvidenceRaw } from "../../packages/worker/src/verification/evidence-raw.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
const clean = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const git = async (directory: string, ...args: string[]): Promise<string> => (await execFile("git", ["-C", directory, ...args], { encoding: "utf8", env: { ...clean(), GIT_CONFIG_NOSYSTEM: "1", HOME: directory } })).stdout.trim();
let counter = 0;
async function repository(commits: number): Promise<{ directory: string; shas: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), "agentx-baseline-multi-"));
  roots.push(directory);
  await git(directory, "init", "--quiet", "-b", "main");
  for (const [key, value] of [["user.email", "agentx@example.invalid"], ["user.name", "AgentX Test"], ["commit.gpgsign", "false"]] as const) await git(directory, "config", key, value);
  const shas: string[] = [];
  for (let n = 0; n < commits; n += 1) { counter += 1; await writeFile(join(directory, "file.txt"), `c ${String(counter)}\n`); await git(directory, "add", "-A"); await git(directory, "commit", "--quiet", "-m", `c ${String(counter)}`); shas.push(await git(directory, "rev-parse", "HEAD")); }
  return { directory, shas };
}
const ask = (repositories: Array<{ repositoryId: string; directory: string; baseCommitSha: string | undefined }>, candidates: string[]) => findBaselineAncestors({ repositories, candidates: candidates.map((sha) => ({ sha })) });

describe("one claim per repository, all or none", () => {
  it("claims each repository's nearest offered ancestor, sorted by repository", async () => {
    const lib = await repository(5); const service = await repository(4);
    const claims = await ask([{ repositoryId: "service", directory: service.directory, baseCommitSha: service.shas[3] }, { repositoryId: "lib", directory: lib.directory, baseCommitSha: lib.shas[4] }], [lib.shas[2]!, service.shas[3]!]);
    expect(claims).toEqual([{ repositoryId: "lib", sha: lib.shas[2], commitsBack: 2 }, { repositoryId: "service", sha: service.shas[3], commitsBack: 0 }]);
  });
  it("claims nothing when any repository has no offered ancestor", async () => {
    const lib = await repository(3); const service = await repository(3);
    expect(await ask([{ repositoryId: "lib", directory: lib.directory, baseCommitSha: lib.shas[2] }, { repositoryId: "service", directory: service.directory, baseCommitSha: service.shas[2] }], [lib.shas[0]!])).toBeUndefined();
  });
  it("claims nothing when one of three repositories has no offered ancestor: never a claim of some of them", async () => {
    const a = await repository(3); const b = await repository(3); const c = await repository(3);
    const held = [{ repositoryId: "a", directory: a.directory, baseCommitSha: a.shas[2] }, { repositoryId: "b", directory: b.directory, baseCommitSha: b.shas[2] }, { repositoryId: "c", directory: c.directory, baseCommitSha: c.shas[2] }];
    expect(await ask(held, [a.shas[2]!, b.shas[2]!])).toBeUndefined();
    expect(await ask(held, [a.shas[2]!, b.shas[2]!, c.shas[1]!])).toHaveLength(3);
  });
  it("claims nothing for one repository, for more than 32, with no candidates, with a base that is not a commit, or when one commit is every repository's", async () => {
    const lib = await repository(2); const service = await repository(2);
    const both = [{ repositoryId: "lib", directory: lib.directory, baseCommitSha: lib.shas[1] }, { repositoryId: "service", directory: service.directory, baseCommitSha: service.shas[1] }];
    expect(await ask([both[0]!], [lib.shas[1]!])).toBeUndefined();
    expect(await ask(both, [])).toBeUndefined();
    expect(await ask([both[0]!, { ...both[1]!, baseCommitSha: "not-a-sha" }], [lib.shas[1]!, service.shas[1]!])).toBeUndefined();
    expect(await ask(Array.from({ length: 33 }, (_, i) => ({ ...both[i % 2]!, repositoryId: `r${String(i)}` })), [lib.shas[1]!, service.shas[1]!])).toBeUndefined();
    // The same directory twice is one commit named twice: no claim.
    expect(await ask([{ ...both[0]!, repositoryId: "a" }, { ...both[0]!, repositoryId: "b" }], [lib.shas[1]!])).toBeUndefined();
  });
  it("stops at its time limit and claims nothing (never throws)", async () => {
    const lib = await repository(2); const service = await repository(2);
    const stop = new AbortController(); stop.abort();
    expect(await findBaselineAncestors({ repositories: [{ repositoryId: "lib", directory: lib.directory, baseCommitSha: lib.shas[1] }, { repositoryId: "service", directory: service.directory, baseCommitSha: service.shas[1] }], candidates: [{ sha: lib.shas[1]! }, { sha: service.shas[1]! }], signal: stop.signal })).toBeUndefined();
  });
});

describe("the claims in the raw evidence file", () => {
  const DIGEST = "d".repeat(64);
  const CLAIMS = [{ repositoryId: "lib", sha: "e".repeat(40), commitsBack: 1 }, { repositoryId: "service", sha: "f".repeat(40), commitsBack: 0 }];
  const command: ProjectCommand = { executable: "pytest", args: ["-q"], cwd: ".", timeoutSeconds: 60 };
  const entry: CheckEntry = { id: "readiness:0", label: "pytest", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 1 };
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "baseline-raw-multi-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  it("are written when given, even with no report, and parse", async () => {
    const raw = await collectEvidenceRaw({ rootPath: root, commands: [command], entries: [entry], candidateDigest: DIGEST, repositories: [], baselines: CLAIMS });
    expect(raw).toMatchObject({ schemaVersion: 1, checks: [], baselines: CLAIMS });
    expect(EvidenceRawSchema.safeParse(raw).success).toBe(true);
    expect(await collectEvidenceRaw({ rootPath: root, commands: [command], entries: [entry], candidateDigest: DIGEST, repositories: [] })).toBeUndefined();
  });
  it("go through the sink only when asked for", async () => {
    const candidate = [{ repositoryId: "api", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "c".repeat(40) }];
    const saved: string[] = [];
    const sink = (artifact: { name: string; content: string | Buffer }) => { if (artifact.name === EVIDENCE_RAW_ARTIFACT) saved.push(String(artifact.content)); return Promise.resolve(); };
    const plan = { source: "project" as const, readiness: [command] };
    const failed = { ...entry, after: "failed", class: "regression", exitCode: 1, output: "boom" } as CheckEntry;
    await saveEvidenceRaw({ sink, rootPath: root, plan, entries: [failed], repositories: [], candidateBefore: candidate, baselineClaims: CLAIMS });
    expect(EvidenceRawSchema.parse(JSON.parse(saved[0]!)).baselines).toEqual(CLAIMS);
    await saveEvidenceRaw({ sink, rootPath: root, plan, entries: [failed], repositories: [], candidateBefore: candidate });
    expect(JSON.parse(saved[1]!)).not.toHaveProperty("baselines");
  });
});
