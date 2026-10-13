import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runContainedCandidate } from "../../packages/verifier/src/contained-candidate.js";

const roots: string[] = [];
const FIXTURE_ENTRY = "café #?.mjs";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function packet(bytes: Uint8Array, sidecar = new TextEncoder().encode("unicode sidecar fixture\n")) {
  return { schemaVersion: 1 as const, entry: FIXTURE_ENTRY, files: [
    { path: FIXTURE_ENTRY, bytes, sha256: hash(bytes) },
    { path: "fixtures/naïve café.txt", bytes: sidecar, sha256: hash(sidecar) },
  ] };
}
async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "agentx-candidate-git-"));
  roots.push(root);
  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "Contained Candidate Fixture"]);
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"]);
  const commit = async (source: string) => {
    await writeFile(join(root, FIXTURE_ENTRY), source);
    await mkdir(join(root, "fixtures"), { recursive: true });
    await writeFile(join(root, "fixtures", "naïve café.txt"), "unicode sidecar fixture\n");
    execFileSync("git", ["-C", root, "add", "--", FIXTURE_ENTRY, "fixtures/naïve café.txt"]);
    execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-m", "candidate revision"], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_DATE: "2026-10-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-12T00:00:00Z" } });
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
    const exactBytes = execFileSync("git", ["-C", root, "show", `${sha}:${FIXTURE_ENTRY}`]);
    const sidecarBytes = execFileSync("git", ["-C", root, "show", `${sha}:fixtures/naïve café.txt`]);
    return { sha, tree, bytes: new Uint8Array(exactBytes), sidecarBytes: new Uint8Array(sidecarBytes) };
  };
  return { root, commit };
}

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("actual pinned Docker candidate containment", () => {
  it("observes the candidate defect on one Git tree and the corrected behavior on a fresh tree", async () => {
    const repo = await fixtureRepo();
    const faulty = await repo.commit("export default () => ({ exportedRows: ['a1', 'a2', 'beta-b1'] });\n");
    const faultRun = await runContainedCandidate(packet(faulty.bytes, faulty.sidecarBytes), { requestId: "faulty-1", input: { mode: "export" } });
    if (process.env.CONTAINED_FOUNDATION_EVIDENCE === "1") console.info("candidate-fixture", JSON.stringify({ faulty: { sha: faulty.sha, tree: faulty.tree, exportBytes: faulty.bytes.byteLength + faulty.sidecarBytes.byteLength, exportFiles: [{ path: FIXTURE_ENTRY, bytes: faulty.bytes.byteLength, sha256: hash(faulty.bytes) }, { path: "fixtures/naïve café.txt", bytes: faulty.sidecarBytes.byteLength, sha256: hash(faulty.sidecarBytes) }], sourceDigest: faultRun.receipt.sourceDigest, sourceBytes: faultRun.receipt.sourceBytes, owner: faultRun.receipt.owner, endpoint: faultRun.receipt.endpoint, containerId: faultRun.receipt.containerId, exitCode: faultRun.receipt.exitCode, cleanup: faultRun.receipt.cleanup, observedOutput: faultRun.observation?.output } }));
    expect(faultRun.error).toBeUndefined();
    expect(faultRun.receipt.cleanup).toBe("confirmed");
    expect(faultRun.receipt.owner.labels["agentx.nonce"]).toBe(faultRun.receipt.owner.nonce);
    expect(faultRun.receipt.owner.labels["agentx.source"]).toBe(faultRun.receipt.sourceDigest);
    expect(faultRun.receipt.endpoint).toBe("unix:///Users/abhishekgarg/.colima/default/docker.sock");
    expect(faultRun.receipt.sourceBytes).toBe(faulty.bytes.byteLength + new TextEncoder().encode("unicode sidecar fixture\n").byteLength);
    expect(faultRun.receipt.exitCode).toBe(0);
    expect(faultRun.receipt.sourceDigest).not.toBeFalsy();
    expect(faultRun.observation?.output).toEqual({ exportedRows: ["a1", "a2", "beta-b1"] });

    const fixed = await repo.commit("export default () => ({ exportedRows: ['a1', 'a2'] });\n");
    expect(fixed.sha).not.toBe(faulty.sha);
    expect(fixed.tree).not.toBe(faulty.tree);
    const fixedRun = await runContainedCandidate(packet(fixed.bytes, fixed.sidecarBytes), { requestId: "fixed-1", input: { mode: "export" } });
    if (process.env.CONTAINED_FOUNDATION_EVIDENCE === "1") console.info("candidate-fixture", JSON.stringify({ fixed: { sha: fixed.sha, tree: fixed.tree, exportBytes: fixed.bytes.byteLength + fixed.sidecarBytes.byteLength, exportFiles: [{ path: FIXTURE_ENTRY, bytes: fixed.bytes.byteLength, sha256: hash(fixed.bytes) }, { path: "fixtures/naïve café.txt", bytes: fixed.sidecarBytes.byteLength, sha256: hash(fixed.sidecarBytes) }], sourceDigest: fixedRun.receipt.sourceDigest, sourceBytes: fixedRun.receipt.sourceBytes, owner: fixedRun.receipt.owner, endpoint: fixedRun.receipt.endpoint, containerId: fixedRun.receipt.containerId, exitCode: fixedRun.receipt.exitCode, cleanup: fixedRun.receipt.cleanup, observedOutput: fixedRun.observation?.output } }));
    expect(fixedRun.error).toBeUndefined();
    expect(fixedRun.receipt.cleanup).toBe("confirmed");
    expect(fixedRun.receipt.owner.labels["agentx.nonce"]).toBe(fixedRun.receipt.owner.nonce);
    expect(fixedRun.receipt.owner.labels["agentx.source"]).toBe(fixedRun.receipt.sourceDigest);
    expect(fixedRun.receipt.endpoint).toBe("unix:///Users/abhishekgarg/.colima/default/docker.sock");
    expect(fixedRun.receipt.exitCode, JSON.stringify(fixedRun.receipt)).toBe(0);
    expect(fixedRun.observation?.output).toEqual({ exportedRows: ["a1", "a2"] });
  });

  it("runs real candidate code with bounded JSON while poisoning env and probing denied capabilities", async () => {
    const previous = process.env.HOST_POISON_MARKER;
    process.env.HOST_POISON_MARKER = "host-poison-must-not-cross";
    const source = `
import { writeFile, readFile, access } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { constants } from 'node:fs';
export default async (input) => {
  await writeFile('/tmp/contained-write', 'tmpfs-ok');
  const tmpfs = await readFile('/tmp/contained-write', 'utf8');
  let sourceWriteDenied = false;
  try { await writeFile('/candidate/should-not-write', 'x'); } catch { sourceWriteDenied = true; }
  let dockerSocketAbsent = false;
  try { await access('/var/run/docker.sock'); } catch { dockerSocketAbsent = true; }
  let supervisorSocketAbsent = false;
  try { await access('/Users/abhishekgarg/.colima/default/docker.sock'); } catch { supervisorSocketAbsent = true; }
  let dnsDenied = false;
  try { await Promise.race([lookup('example.com'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200))]); } catch { dnsDenied = true; }
  let metadataDenied = false;
  try { await Promise.race([fetch('http://169.254.169.254/latest/meta-data/', { signal: AbortSignal.timeout(1000) }), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200))]); } catch { metadataDenied = true; }
  let directIpDenied = false;
  try { await Promise.race([fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(1000) }), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200))]); } catch { directIpDenied = true; }
  let modelDenied = false;
  try { await Promise.race([fetch('https://api.openai.com/v1/models', { signal: AbortSignal.timeout(1000) }), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1200))]); } catch { modelDenied = true; }
  let hostPathAbsent = false;
  try { await access('/Users/abhishekgarg'); } catch { hostPathAbsent = true; }
  return { request: input, tmpfs, sourceWriteDenied, dockerSocketAbsent, supervisorSocketAbsent, dnsDenied, metadataDenied, directIpDenied, modelDenied, hostPathAbsent, poisonAbsent: process.env.HOST_POISON_MARKER === undefined, proxyEmpty: process.env.HTTP_PROXY === '' && process.env.HTTPS_PROXY === '', nodeOptionsEmpty: process.env.NODE_OPTIONS === undefined || process.env.NODE_OPTIONS === '' };
};
`;
    try {
      const result = await runContainedCandidate(packet(new TextEncoder().encode(source)), { requestId: "containment-1", input: { list: [1, { ok: true }] } });
      expect(result.error).toBeUndefined();
      expect(result.receipt.cleanup).toBe("confirmed");
      expect(result.observation?.requestId).toBe("containment-1");
      expect(result.observation?.output).toMatchObject({ request: { list: [1, { ok: true }] }, tmpfs: "tmpfs-ok", sourceWriteDenied: true, dockerSocketAbsent: true, supervisorSocketAbsent: true, dnsDenied: true, metadataDenied: true, directIpDenied: true, modelDenied: true, hostPathAbsent: true, poisonAbsent: true, proxyEmpty: true, nodeOptionsEmpty: true });
    } finally {
      if (previous === undefined) delete process.env.HOST_POISON_MARKER;
      else process.env.HOST_POISON_MARKER = previous;
    }
  });

  it("preserves timeout cancellation and reaps the exact owned container", async () => {
    const controller = new AbortController();
    const candidate = new TextEncoder().encode("export default () => { while (true) {} };\n");
    const pending = runContainedCandidate(packet(candidate), { requestId: "cancel-1", input: null }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 500);
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.receipt.aborted).toBe(true);
    expect(result.receipt.containerId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.cleanup).toBe("confirmed");
    expect(result.observation).toBeNull();
  });

  it("rejects an oversized candidate response without returning a parsed observation", async () => {
    const candidate = new TextEncoder().encode("export default () => 'x'.repeat(300000);\n");
    const result = await runContainedCandidate(packet(candidate), { requestId: "flood-1", input: null });
    expect(result.error).toBeUndefined();
    expect(result.receipt.cleanup).toBe("confirmed");
    expect(result.observation).toBeNull();
    expect(result.receipt.exitCode).not.toBe(0);
  });

  it("refuses candidate-written stdout frames that conflict with the fixed response", async () => {
    const candidate = new TextEncoder().encode("console.log('unsolicited'); export default () => ({ ok: true });\n");
    const result = await runContainedCandidate(packet(candidate), { requestId: "extra-frame-1", input: null });
    expect(result.error).toMatch(/unsolicited protocol frame/i);
    expect(result.receipt.cleanup).toBe("confirmed");
    expect(result.observation).toBeNull();
  });
});
