import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CANDIDATE_RESPONSE_SCOPE, CONTAINED_SOCKET, reconcileOwnedContainers, runContainedCandidate, validateCandidatePacket } from "../../packages/verifier/src/contained-candidate.js";

const DOCKER = "/opt/homebrew/bin/docker";
const NODE = "/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin/node";
const FIXTURE_ENTRY = "café #?.mjs";
const roots: string[] = [];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function writeEvidence(name: string, value: unknown): void {
  const directory = process.env.CONTAINED_FOUNDATION_EVIDENCE_DIR;
  if (!directory) return;
  fs.writeFileSync(join(directory, `${name}.json`), `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
}
function fixtureEvidence(git: { sha: string; tree: string; bytes: Uint8Array; sidecar: Uint8Array }, run: Awaited<ReturnType<typeof runContainedCandidate>>, absent: { status: number | null; stdout: string; stderr: string }): object {
  return {
    candidateCommit: git.sha,
    candidateTree: git.tree,
    exportFiles: [
      { path: FIXTURE_ENTRY, bytes: git.bytes.byteLength, sha256: hash(git.bytes) },
      { path: "fixtures/naïve café.txt", bytes: git.sidecar.byteLength, sha256: hash(git.sidecar) },
    ],
    exportBytes: git.bytes.byteLength + git.sidecar.byteLength,
    sourceDigest: run.receipt.sourceDigest,
    sourceBytes: run.receipt.sourceBytes,
    owner: run.receipt.owner,
    endpoint: run.receipt.endpoint,
    containerId: run.receipt.containerId,
    exitCode: run.receipt.exitCode,
    cleanup: run.receipt.cleanup,
    scope: run.receipt.scope,
    observation: run.observation,
    independentPostCleanupReadback: absent,
  };
}

function packet(source: string, entry = "candidate.mjs") {
  const bytes = new TextEncoder().encode(source);
  const sidecar = new TextEncoder().encode("synthetic sidecar\n");
  return { schemaVersion: 1 as const, entry, files: [
    { path: entry, bytes, sha256: hash(bytes) },
    { path: "fixtures/naïve café.txt", bytes: sidecar, sha256: hash(sidecar) },
  ] };
}
function candidateProcess(expression: string, sideEffect = ""): string {
  return `export default async function(input) { const output = (${expression}); ${sideEffect} return output; }\n`;
}
function fixtureProcess(rows: string[]): string { return candidateProcess(`({ exportedRows: ${JSON.stringify(rows)} })`); }
async function fixtureRepo() {
  const root = await mkdtemp(join(tmpdir(), "agentx-candidate-fixture-"));
  roots.push(root);
  execFileSync("git", ["init", root], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
  execFileSync("git", ["-C", root, "config", "user.name", "Contained Candidate Fixture"], { env: { PATH: "/usr/bin:/bin" } });
  execFileSync("git", ["-C", root, "config", "user.email", "fixture@example.invalid"], { env: { PATH: "/usr/bin:/bin" } });
  const commit = async (rows: string[]) => {
    await writeFile(join(root, FIXTURE_ENTRY), fixtureProcess(rows));
    await mkdir(join(root, "fixtures"), { recursive: true });
    await writeFile(join(root, "fixtures", "naïve café.txt"), "synthetic sidecar\n");
    execFileSync("git", ["-C", root, "add", "--", FIXTURE_ENTRY, "fixtures/naïve café.txt"], { env: { PATH: "/usr/bin:/bin" } });
    execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", "commit", "-m", "candidate process revision"], {
      stdio: "ignore", env: { PATH: "/usr/bin:/bin", GIT_AUTHOR_NAME: "Contained Candidate Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Contained Candidate Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid", GIT_AUTHOR_DATE: "2026-10-12T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-12T00:00:00Z" },
    });
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim();
    const tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim();
    const bytes = new Uint8Array(execFileSync("git", ["-C", root, "show", `${sha}:${FIXTURE_ENTRY}`], { env: { PATH: "/usr/bin:/bin" } }));
    const sidecar = new Uint8Array(execFileSync("git", ["-C", root, "show", `${sha}:fixtures/naïve café.txt`], { env: { PATH: "/usr/bin:/bin" } }));
    return { sha, tree, bytes, sidecar };
  };
  return { commit };
}
async function controlRoot() {
  const root = await mkdtemp(join(tmpdir(), "agentx-docker-control-"));
  roots.push(root);
  await mkdir(join(root, "home"), { mode: 0o700 });
  await mkdir(join(root, "config"), { mode: 0o700 });
  return root;
}
function controlEnv(root: string): NodeJS.ProcessEnv {
  return { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(root, "home"), DOCKER_CONFIG: join(root, "config"), DOCKER_HOST: CONTAINED_SOCKET, LANG: "C.UTF-8" };
}
function dockerInspect(id: string, root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(DOCKER, ["container", "inspect", id], { env: controlEnv(root), encoding: "utf8", timeout: 10_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
async function expectAbsentContainer(id: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const root = await controlRoot();
  const result = dockerInspect(id, root);
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe("[]");
  expect(result.stderr).toMatch(/No such container:/);
  return result;
}
function installFault(mode: "inspect-cleanup" | "rm-cleanup" | "abort-after-create-inspect" | "tamper-before-start" | "extra-file-before-start", controller?: AbortController) {
  const realSpawn = childProcess.spawn;
  const calls: string[][] = [];
  let started = false;
  let postStartInspects = 0;
  let createdInspectDone = false;
  childProcess.spawn = ((file: string, args: readonly string[], options: childProcess.SpawnOptions) => {
    if (file !== DOCKER) return realSpawn(file, [...args], options);
    calls.push([...args]);
    if (mode === "inspect-cleanup" && started && args[0] === "container" && args[1] === "inspect") {
      postStartInspects += 1;
      if (postStartInspects === 2) return realSpawn(NODE, ["-e", "process.stdout.write('[]'); process.stderr.write('synthetic daemon unavailable'); process.exit(1)"], options);
    }
    if (mode === "rm-cleanup" && args[0] === "container" && args[1] === "rm") return realSpawn(NODE, ["-e", "process.stderr.write('synthetic rm unavailable'); process.exit(1)"], options);
    if (args[0] === "start") started = true;
    const child = realSpawn(file, [...args], options);
    if (mode === "abort-after-create-inspect" && args[0] === "container" && args[1] === "inspect" && /^[a-f0-9]{64}$/.test(args[2] ?? "") && !createdInspectDone) {
      createdInspectDone = true;
      child.once("close", () => controller?.abort());
    }
    if (mode === "tamper-before-start" && args[0] === "container" && args[1] === "inspect" && /^[a-f0-9]{64}$/.test(args[2] ?? "") && !createdInspectDone) {
      createdInspectDone = true;
      const candidatePath = join(String(options.cwd ?? process.cwd()), "..", "candidate", "candidate.mjs");
      child.once("close", () => {
        fs.chmodSync(candidatePath, 0o644);
        fs.writeFileSync(candidatePath, "this is no longer the exported candidate\n");
        fs.chmodSync(candidatePath, 0o444);
      });
    }
    if (mode === "extra-file-before-start" && args[0] === "container" && args[1] === "inspect" && /^[a-f0-9]{64}$/.test(args[2] ?? "") && !createdInspectDone) {
      createdInspectDone = true;
      const candidateRoot = join(String(options.cwd ?? process.cwd()), "..", "candidate");
      child.once("close", () => {
        fs.chmodSync(candidateRoot, 0o755);
        fs.writeFileSync(join(candidateRoot, "unregistered.mjs"), "export default () => 'unregistered'\n", { flag: "wx" });
        fs.chmodSync(candidateRoot, 0o555);
      });
    }
    return child;
  }) as typeof childProcess.spawn;
  syncBuiltinESMExports();
  return { calls, restore() { childProcess.spawn = realSpawn; syncBuiltinESMExports(); } };
}

afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

describe("actual pinned Docker candidate-process foundation", () => {
  it("reconciles exact pending owner records without widening to Docker inventory", async () => {
    const pending = await reconcileOwnedContainers();
    expect(pending.every((item) => item.cleanup === "confirmed")).toBe(true);
  });

  it("observes a faulty candidate process and its fresh fixed Git revision by exact export bytes", async () => {
    const repo = await fixtureRepo();
    const faulty = await repo.commit(["a1", "a2", "beta-b1"]);
    const faultPacket = { schemaVersion: 1 as const, entry: FIXTURE_ENTRY, files: [
      { path: FIXTURE_ENTRY, bytes: faulty.bytes, sha256: hash(faulty.bytes) },
      { path: "fixtures/naïve café.txt", bytes: faulty.sidecar, sha256: hash(faulty.sidecar) },
    ] };
    const faultRun = await runContainedCandidate(faultPacket, { requestId: "faulty-1", input: { mode: "export" } });
    const faultyReadback = faultRun.receipt.containerId ? await expectAbsentContainer(faultRun.receipt.containerId) : { status: null, stdout: "", stderr: "no container ID" };
    writeEvidence("candidate-faulty", fixtureEvidence(faulty, faultRun, faultyReadback));
    expect(faultRun.error).toBeUndefined();
    expect(faultRun.receipt.cleanup).toBe("confirmed");
    expect(faultRun.receipt.exitCode).toBe(0);
    expect(faultRun.receipt.scope).toBe(CANDIDATE_RESPONSE_SCOPE);
    expect(faultRun.receipt.owner.labels["agentx.nonce"]).toBe(faultRun.receipt.owner.nonce);
    expect(faultRun.receipt.owner.labels["agentx.source"]).toBe(faultRun.receipt.sourceDigest);
    expect(faultRun.observation?.output).toEqual({ exportedRows: ["a1", "a2", "beta-b1"] });

    const fixed = await repo.commit(["a1", "a2"]);
    expect(fixed.sha).not.toBe(faulty.sha);
    expect(fixed.tree).not.toBe(faulty.tree);
    const fixedPacket = { schemaVersion: 1 as const, entry: FIXTURE_ENTRY, files: [
      { path: FIXTURE_ENTRY, bytes: fixed.bytes, sha256: hash(fixed.bytes) },
      { path: "fixtures/naïve café.txt", bytes: fixed.sidecar, sha256: hash(fixed.sidecar) },
    ] };
    const fixedRun = await runContainedCandidate(fixedPacket, { requestId: "fixed-1", input: { mode: "export" } });
    const fixedReadback = fixedRun.receipt.containerId ? await expectAbsentContainer(fixedRun.receipt.containerId) : { status: null, stdout: "", stderr: "no container ID" };
    writeEvidence("candidate-fixed", fixtureEvidence(fixed, fixedRun, fixedReadback));
    expect(fixedRun.error).toBeUndefined();
    expect(fixedRun.receipt.cleanup).toBe("confirmed");
    expect(fixedRun.receipt.exitCode).toBe(0);
    expect(fixedRun.observation?.output).toEqual({ exportedRows: ["a1", "a2"] });

    const namedSource = "export async function check(input) { return { assertions: [input.left === input.right, input.rows.length === 2] }; }\n";
    const named = await runContainedCandidate({ ...packet(namedSource), exportName: "check" }, { requestId: "named-export", input: { left: 7, right: 7, rows: ["x", "y"] } });
    expect(named.error).toBeUndefined();
    expect(named.receipt.cleanup).toBe("confirmed");
    expect(named.observation?.output).toEqual({ assertions: [true, true] });
    const namedReadback = named.receipt.containerId ? await expectAbsentContainer(named.receipt.containerId) : { status: null, stdout: "", stderr: "no container ID" };
    writeEvidence("candidate-named", { receipt: named.receipt, observation: named.observation, independentPostCleanupReadback: namedReadback });
  });

  it("binds only a fresh post-request process response and treats PASS/proof as data", async () => {
    const forged = candidateProcess("null", "process.stdout.write(JSON.stringify({requestId:'forged-frame',output:{PASS:true,proof:'old-fake'}})+'\\n');");
    const rejected = await runContainedCandidate(packet(forged), { requestId: "logical-forged", input: null });
    expect(rejected.observation).toBeNull();
    expect(rejected.receipt.cleanup).toBe("confirmed");
    expect(rejected.receipt.scope).toBe(CANDIDATE_RESPONSE_SCOPE);
    expect(rejected).not.toHaveProperty("callableCompletion");
    expect(rejected.receipt).not.toHaveProperty("namedCallableProof");

    const extraKeys = candidateProcess("({ PASS: true, proof: 'untrusted app data' })", "process.stdout.write(JSON.stringify({wireId:'0'.repeat(48),output:null,receipt:'forged'})+'\\n');");
    const extra = await runContainedCandidate(packet(extraKeys), { requestId: "logical-extra", input: null });
    expect(extra.observation).toBeNull();
    expect(extra.receipt.cleanup).toBe("confirmed");
    expect(extra.error).toMatch(/response line/i);

    const data = await runContainedCandidate(packet(candidateProcess("({ PASS: true, proof: 'not-authority' })")), { requestId: "logical-data", input: null });
    expect(data.observation?.output).toEqual({ PASS: true, proof: "not-authority" });
    expect(data.observation?.scope).toBe(CANDIDATE_RESPONSE_SCOPE);
    expect(data.observation?.correlation).toBe("fresh-random-wire-id-matched");
    expect(data.receipt).not.toHaveProperty("PASS");
    expect(data.receipt).not.toHaveProperty("proof");
  });

  it("runs bounded JSON with poisoned host env and probes denied capabilities", async () => {
    const previous = process.env.HOST_POISON_MARKER;
    process.env.HOST_POISON_MARKER = "synthetic-poison-must-not-cross";
    const source = `import { writeFile, readFile, access } from 'node:fs/promises'; import { lookup } from 'node:dns/promises'; export default async function(input) { await writeFile('/tmp/contained-write','tmpfs-ok'); const tmpfs=await readFile('/tmp/contained-write','utf8'); let sourceWriteDenied=false; try { await writeFile('/candidate/should-not-write','x'); } catch { sourceWriteDenied=true; } let dockerSocketAbsent=false; try { await access('/var/run/docker.sock'); } catch { dockerSocketAbsent=true; } let supervisorSocketAbsent=false; try { await access('/Users/abhishekgarg/.colima/default/docker.sock'); } catch { supervisorSocketAbsent=true; } let dnsDenied=false; try { await Promise.race([lookup('example.com'),new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),1000))]); } catch { dnsDenied=true; } let metadataDenied=false; try { await fetch('http://169.254.169.254/latest/meta-data/',{signal:AbortSignal.timeout(900)}); } catch { metadataDenied=true; } let directIpDenied=false; try { await fetch('http://1.1.1.1/',{signal:AbortSignal.timeout(900)}); } catch { directIpDenied=true; } let modelDenied=false; try { await fetch('https://api.openai.com/v1/models',{signal:AbortSignal.timeout(900)}); } catch { modelDenied=true; } let hostPathAbsent=false; try { await access('/Users/abhishekgarg'); } catch { hostPathAbsent=true; } return {request:input,tmpfs,sourceWriteDenied,dockerSocketAbsent,supervisorSocketAbsent,dnsDenied,metadataDenied,directIpDenied,modelDenied,hostPathAbsent,poisonAbsent:process.env.HOST_POISON_MARKER===undefined,proxyEmpty:process.env.HTTP_PROXY===''&&process.env.HTTPS_PROXY===''&&process.env.ALL_PROXY==='',nodeOptionsEmpty:process.env.NODE_OPTIONS===''&&process.env.NODE_PATH==='' }; }`;
    try {
      const result = await runContainedCandidate(packet(source), { requestId: "containment-1", input: { list: [1, { ok: true }] } });
      expect(result.error).toBeUndefined();
      expect(result.receipt.cleanup).toBe("confirmed");
      expect(result.observation?.requestId).toBe("containment-1");
      expect(result.observation?.output).toMatchObject({ request: { list: [1, { ok: true }] }, tmpfs: "tmpfs-ok", sourceWriteDenied: true, dockerSocketAbsent: true, supervisorSocketAbsent: true, dnsDenied: true, metadataDenied: true, directIpDenied: true, modelDenied: true, hostPathAbsent: true, poisonAbsent: true, proxyEmpty: true, nodeOptionsEmpty: true });
    } finally { if (previous === undefined) delete process.env.HOST_POISON_MARKER; else process.env.HOST_POISON_MARKER = previous; }
  });

  it("aborts a running candidate process and still confirms exact cleanup", async () => {
    const controller = new AbortController();
    const source = `export default async function() { while (true) {} }`;
    const pending = runContainedCandidate(packet(source), { requestId: "cancel-running", input: null }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 450);
    const result = await pending;
    expect(result.receipt.aborted).toBe(true);
    expect(result.receipt.cleanup).toBe("confirmed");
    expect(result.observation).toBeNull();
    const readback = result.receipt.containerId ? await expectAbsentContainer(result.receipt.containerId) : { status: null, stdout: "", stderr: "no container ID" };
    writeEvidence("cancel-running", { receipt: result.receipt, independentPostCleanupReadback: readback });
  });

  it("rejects an oversized aggregate response and the old import-time forged frame", async () => {
    const flood = candidateProcess("'x'.repeat(200000)", "process.stderr.write('e'.repeat(200000));");
    const result = await runContainedCandidate(packet(flood), { requestId: "aggregate-flood", input: null });
    expect(result.receipt.overflow).toBe(true);
    expect(result.receipt.aggregateBytes).toBeGreaterThan(262_144);
    expect(result.observation).toBeNull();
    expect(result.receipt.cleanup).toBe("confirmed");
  });

  it("rejects response depth 65 while accepting a correctly correlated near-limit request", async () => {
    const near = await runContainedCandidate(packet(candidateProcess("({ length: input.length })")), { requestId: "n".repeat(128), input: "a".repeat(65_534) });
    expect(near.observation?.output).toEqual({ length: 65_534 });
    expect(near.receipt.cleanup).toBe("confirmed");
    const tooDeep = await runContainedCandidate(packet(candidateProcess("{ nested: (() => { let v='leaf'; for(let i=0;i<64;i++)v=[v]; return v; })() }")), { requestId: "depth-over", input: null });
    expect(tooDeep.observation).toBeNull();
    expect(tooDeep.error).toMatch(/depth/i);
    expect(tooDeep.receipt.cleanup).toBe("confirmed");
  });

  it("does not start after cancellation between inspect and process launch", async () => {
    const controller = new AbortController();
    const fault = installFault("abort-after-create-inspect", controller);
    try {
      const result = await runContainedCandidate(packet(candidateProcess("({ executed: true })")), { requestId: "abort-between-inspect-start", input: null }, { signal: controller.signal });
      expect(controller.signal.aborted).toBe(true);
      expect(result.receipt.aborted).toBe(true);
      expect(result.observation).toBeNull();
      expect(fault.calls.some((args) => args[0] === "start")).toBe(false);
      expect(result.receipt.cleanup).toBe("confirmed");
      const readback = result.receipt.containerId ? await expectAbsentContainer(result.receipt.containerId) : { status: null, stdout: "", stderr: "no container ID" };
      writeEvidence("abort-before-start", { receipt: result.receipt, dockerCalls: fault.calls, independentPostCleanupReadback: readback });
    } finally { fault.restore(); }
  });

  it("fault-injected inspect unavailability stays pending until independent exact-owner reconciliation", async () => {
    const root = await controlRoot();
    const fault = installFault("inspect-cleanup");
    const result = await (async () => { try { return await runContainedCandidate(packet(candidateProcess("({ executed: true })")), { requestId: "inspect-fault", input: null }); } finally { fault.restore(); } })();
    expect(result.receipt.cleanup).toBe("pending");
    expect(result.observation).toBeNull();
    expect(result.receipt.containerId).toMatch(/^[a-f0-9]{64}$/);
    const id = result.receipt.containerId;
    if (!id) throw new Error("fault-injected inspect receipt did not retain its exact ID");
    const before = dockerInspect(id, root);
    expect(before.status).toBe(0);
    const actual = JSON.parse(before.stdout) as Array<{ Id: string; State: { Status: string }; Config: { Labels: Record<string, string> } }>;
    expect(actual[0]?.Id).toBe(id);
    expect(actual[0]?.State.Status).toBe("exited");
    expect(actual[0]?.Config.Labels["agentx.owner"]).toBe("contained-candidate-v1");
    expect(actual[0]?.Config.Labels["agentx.nonce"]).toBe(result.receipt.owner.nonce);
    expect(actual[0]?.Config.Labels["agentx.source"]).toBe(result.receipt.sourceDigest);
    const reconciled = await reconcileOwnedContainers();
    expect(reconciled).toContainEqual(expect.objectContaining({ recordRef: result.receipt.recordRef, containerId: id, cleanup: "confirmed" }));
    const after = dockerInspect(id, root);
    expect(after.status).toBe(1);
    expect(after.stdout.trim()).toBe("[]");
    expect(after.stderr).toMatch(/No such container:/);
    writeEvidence("inspect-cleanup-reconcile", { receipt: result.receipt, exactOwnerReadbackBeforeReconcile: before, reconciliation: reconciled, independentReadbackAfterReconcile: after });
  });

  it("fault-injected removal remains pending and reconciliation removes only its owned ID", async () => {
    const root = await controlRoot();
    const fault = installFault("rm-cleanup");
    const result = await (async () => { try { return await runContainedCandidate(packet(candidateProcess("({ executed: true })")), { requestId: "rm-fault", input: null }); } finally { fault.restore(); } })();
    expect(result.receipt.cleanup).toBe("pending");
    expect(result.observation).toBeNull();
    const id = result.receipt.containerId;
    if (!id) throw new Error("fault-injected rm receipt did not retain its exact ID");
    const before = dockerInspect(id, root);
    expect(before.status).toBe(0);
    const actual = JSON.parse(before.stdout) as Array<{ Id: string; Config: { Labels: Record<string, string> } }>;
    expect(actual[0]?.Id).toBe(id);
    expect(actual[0]?.Config.Labels["agentx.owner"]).toBe("contained-candidate-v1");
    expect(actual[0]?.Config.Labels["agentx.nonce"]).toBe(result.receipt.owner.nonce);
    expect(actual[0]?.Config.Labels["agentx.source"]).toBe(result.receipt.sourceDigest);
    const recordPath = join(homedir(), ".local", "state", "agentx", "contained-candidate-v1", `${result.receipt.recordRef}.record.json`);
    const recordBefore = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { workspace: string; workspaceParent?: string };
    expect(fs.existsSync(recordBefore.workspace)).toBe(true);
    const originalCwd = process.cwd();
    const otherCwd = await mkdtemp(join(tmpdir(), "agentx-foundation-recovery-cwd-"));
    let reconciled: Awaited<ReturnType<typeof reconcileOwnedContainers>>;
    try { process.chdir(otherCwd); reconciled = await reconcileOwnedContainers(); }
    finally { process.chdir(originalCwd); await rm(otherCwd, { recursive: true, force: true }); }
    expect(reconciled).toContainEqual(expect.objectContaining({ recordRef: result.receipt.recordRef, containerId: id, cleanup: "confirmed" }));
    expect(fs.existsSync(recordBefore.workspace)).toBe(false);
    const after = dockerInspect(id, root);
    expect(after.status).toBe(1);
    writeEvidence("rm-cleanup-reconcile", { receipt: result.receipt, exactOwnerReadbackBeforeReconcile: before, durableWorkspaceAnchor: recordBefore, reconciliationCwd: otherCwd, reconciliation: reconciled, workspaceAbsentAfterReconcile: !fs.existsSync(recordBefore.workspace), independentReadbackAfterReconcile: after });
  });

  it("durably enrolls a planned workspace before preparation and recovers exact cleanup failure across cwd", async () => {
    const originalMkdir = fsPromises.mkdir;
    const originalRm = fsPromises.rm;
    let workspace: string | undefined;
    let mkdirFaults = 0;
    let rmFaults = 0;
    fsPromises.mkdir = (async (path: unknown, ...args: unknown[]) => {
      if (typeof path === "string" && path.endsWith(`${process.platform === "win32" ? "\\" : "/"}candidate`) && path.includes(".contained-candidate-")) {
        workspace = path.slice(0, -"candidate".length - 1);
        mkdirFaults += 1;
        throw Object.assign(new Error("synthetic preparation EIO"), { code: "EIO" });
      }
      return (originalMkdir as (...values: unknown[]) => Promise<string | undefined>)(path, ...args);
    }) as typeof fsPromises.mkdir;
    fsPromises.rm = (async (path: unknown, ...args: unknown[]) => {
      if (typeof path === "string" && path === workspace) {
        rmFaults += 1;
        throw Object.assign(new Error("synthetic exact workspace cleanup EIO"), { code: "EIO" });
      }
      return (originalRm as (...values: unknown[]) => Promise<void>)(path, ...args);
    });
    syncBuiltinESMExports();
    let result: Awaited<ReturnType<typeof runContainedCandidate>>;
    try { result = await runContainedCandidate(packet(candidateProcess("({ prepared: true })")), { requestId: "prepare-cleanup-fault", input: null }); }
    finally {
      fsPromises.mkdir = originalMkdir;
      fsPromises.rm = originalRm;
      syncBuiltinESMExports();
    }
    expect(mkdirFaults).toBe(1);
    expect(rmFaults).toBe(1);
    expect(result.observation).toBeNull();
    expect(result.receipt.cleanup).toBe("pending");
    expect(result.receipt.containerId).toBeNull();
    if (!workspace) throw new Error("preparation fault did not identify its exact owned workspace");
    expect(fs.existsSync(workspace)).toBe(true);
    const recordPath = join(homedir(), ".local", "state", "agentx", "contained-candidate-v1", `${result.receipt.recordRef}.record.json`);
    expect(fs.existsSync(recordPath)).toBe(true);
    const recordBefore = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { schemaVersion: number; recordRef: string; plannedName: string; workspace: string; workspaceParent: string };
    expect(recordBefore.schemaVersion).toBe(2);
    expect(recordBefore.recordRef).toBe(result.receipt.recordRef);
    expect(recordBefore.workspace).toBe(workspace);
    const originalCwd = process.cwd();
    const otherCwd = await mkdtemp(join(tmpdir(), "agentx-foundation-prepare-recovery-"));
    let reconciled: Awaited<ReturnType<typeof reconcileOwnedContainers>>;
    try { process.chdir(otherCwd); reconciled = await reconcileOwnedContainers(); }
    finally { process.chdir(originalCwd); await rm(otherCwd, { recursive: true, force: true }); }
    expect(reconciled).toContainEqual(expect.objectContaining({ recordRef: result.receipt.recordRef, plannedName: result.receipt.plannedName, cleanup: "confirmed" }));
    expect(fs.existsSync(workspace)).toBe(false);
    expect(fs.existsSync(recordPath)).toBe(false);
    const root = await controlRoot();
    const plannedAbsent = spawnSync(DOCKER, ["container", "inspect", result.receipt.plannedName], { env: controlEnv(root), encoding: "utf8", timeout: 10_000 });
    expect(plannedAbsent.status).toBe(1);
    expect(plannedAbsent.stdout.trim()).toBe("[]");
    expect(plannedAbsent.stderr).toMatch(/No such container:/);
    writeEvidence("preparation-cleanup-recovery", { receipt: result.receipt, exactOwnerRecordBeforeRecovery: recordBefore, exactWorkspaceBeforeRecovery: workspace, preparationFault: "EIO", exactWorkspaceCleanupFault: "EIO", reconciliationCwd: otherCwd, reconciliation: reconciled, workspaceAbsentAfterSourceReconciliation: !fs.existsSync(workspace), durableRecordAbsentAfterSourceReconciliation: !fs.existsSync(recordPath), independentPlannedNameAbsence: { status: plannedAbsent.status, stdout: plannedAbsent.stdout, stderr: plannedAbsent.stderr } });

    let cleanWorkspace: string | undefined;
    const originalMkdirForCleanupControl = fsPromises.mkdir;
    fsPromises.mkdir = (async (path: unknown, ...args: unknown[]) => {
      if (typeof path === "string" && path.endsWith(`${process.platform === "win32" ? "\\" : "/"}candidate`) && path.includes(".contained-candidate-")) {
        cleanWorkspace = path.slice(0, -"candidate".length - 1);
        throw Object.assign(new Error("synthetic preparation EIO with available cleanup"), { code: "EIO" });
      }
      return (originalMkdirForCleanupControl as (...values: unknown[]) => Promise<string | undefined>)(path, ...args);
    }) as typeof fsPromises.mkdir;
    syncBuiltinESMExports();
    let cleanResult: Awaited<ReturnType<typeof runContainedCandidate>>;
    try { cleanResult = await runContainedCandidate(packet(candidateProcess("({ prepared: true })")), { requestId: "prepare-fault-cleanup-available", input: null }); }
    finally { fsPromises.mkdir = originalMkdirForCleanupControl; syncBuiltinESMExports(); }
    expect(cleanResult.observation).toBeNull();
    expect(cleanResult.receipt.cleanup).toBe("confirmed");
    expect(cleanWorkspace).toBeDefined();
    expect(fs.existsSync(cleanWorkspace!)).toBe(false);
    const cleanRecordPath = join(homedir(), ".local", "state", "agentx", "contained-candidate-v1", `${cleanResult.receipt.recordRef}.record.json`);
    const cleanReceiptPath = join(homedir(), ".local", "state", "agentx", "contained-candidate-v1", `${cleanResult.receipt.recordRef}.receipt.json`);
    expect(fs.existsSync(cleanRecordPath)).toBe(false);
    expect(fs.existsSync(cleanReceiptPath)).toBe(true);
    writeEvidence("preparation-cleanup-confirmed", { receipt: cleanResult.receipt, exactWorkspace: cleanWorkspace, workspaceAbsent: !fs.existsSync(cleanWorkspace!), durableRecordAbsent: !fs.existsSync(cleanRecordPath), cleanupReceiptPresent: fs.existsSync(cleanReceiptPath) });
  });

  it("surfaces corrupt owner rows and refuses an anchored workspace symlink without deleting either", async () => {
    const stateRoot = join(homedir(), ".local", "state", "agentx", "contained-candidate-v1");
    const corruptRef = randomBytes(16).toString("hex");
    const symlinkRef = randomBytes(16).toString("hex");
    const corruptPath = join(stateRoot, `${corruptRef}.record.json`);
    const symlinkPath = join(stateRoot, `${symlinkRef}.record.json`);
    const workspace = join(process.cwd(), `.contained-candidate-${symlinkRef}`);
    const target = await mkdtemp(join(tmpdir(), "agentx-foundation-foreign-workspace-"));
    await writeFile(corruptPath, "{}\n", { flag: "wx", mode: 0o600 });
    await writeFile(symlinkPath, JSON.stringify({
      schemaVersion: 2,
      recordRef: symlinkRef,
      plannedName: `agentx-contained-${randomBytes(10).toString("hex")}`,
      nonce: randomBytes(24).toString("hex"),
      sourceDigest: hash(new TextEncoder().encode("synthetic owner row")),
      endpoint: CONTAINED_SOCKET,
      image: "node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9",
      containerId: null,
      cidfile: join(stateRoot, `${symlinkRef}.cid`),
      workspace,
      workspaceParent: process.cwd(),
      requestId: "symlink-owner-control",
      sourceBytes: 0,
      phase: "cleanup-pending",
      cleanup: "pending",
    }), { flag: "wx", mode: 0o600 });
    fs.symlinkSync(target, workspace);
    try {
      const reconciliation = await reconcileOwnedContainers();
      const corruptReceipt = reconciliation.find((item) => item.recordRef === corruptRef);
      const symlinkReceipt = reconciliation.find((item) => item.recordRef === symlinkRef);
      expect(corruptReceipt?.cleanup).toBe("failed");
      expect(corruptReceipt?.diagnostic).toMatch(/invalid/i);
      expect(symlinkReceipt?.cleanup).toBe("failed");
      expect(symlinkReceipt?.diagnostic).toMatch(/workspace changed/i);
      expect(fs.existsSync(corruptPath)).toBe(true);
      expect(fs.existsSync(symlinkPath)).toBe(true);
      expect(fs.lstatSync(workspace).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(target)).toBe(true);
      writeEvidence("invalid-owner-controls", { corruptRecord: { recordRef: corruptRef, retained: fs.existsSync(corruptPath), receipt: corruptReceipt }, symlinkOwnerRecord: { recordRef: symlinkRef, retained: fs.existsSync(symlinkPath), workspaceSymlinkRetained: fs.lstatSync(workspace).isSymbolicLink(), targetRetained: fs.existsSync(target), receipt: symlinkReceipt } });
    } finally {
      fs.unlinkSync(corruptPath);
      fs.unlinkSync(symlinkPath);
      fs.unlinkSync(workspace);
      await rm(target, { recursive: true, force: true });
    }
  });

  it("rejects source tampering before start and removes the exact created container", async () => {
    const fault = installFault("tamper-before-start");
    try {
      const result = await runContainedCandidate(packet(candidateProcess("({ executed: true })")), { requestId: "tamper", input: null });
      expect(result.observation).toBeNull();
      expect(result.error).toMatch(/materialized candidate export changed/i);
      expect(result.receipt.cleanup).toBe("confirmed");
      expect(fault.calls.some((args) => args[0] === "start")).toBe(false);
      const readback = result.receipt.containerId ? await expectAbsentContainer(result.receipt.containerId) : { status: null, stdout: "", stderr: "no container ID" };
      writeEvidence("materialized-tamper", { receipt: result.receipt, dockerCalls: fault.calls, independentPostCleanupReadback: readback });
    } finally { fault.restore(); }

    const extraFault = installFault("extra-file-before-start");
    try {
      const result = await runContainedCandidate(packet(candidateProcess("({ executed: true })")), { requestId: "extra-materialized-file", input: null });
      expect(result.observation).toBeNull();
      expect(result.error).toMatch(/materialized candidate export changed/i);
      expect(result.receipt.cleanup).toBe("confirmed");
      expect(extraFault.calls.some((args) => args[0] === "start")).toBe(false);
      const readback = result.receipt.containerId ? await expectAbsentContainer(result.receipt.containerId) : { status: null, stdout: "", stderr: "no container ID" };
      writeEvidence("unregistered-materialized-file", { receipt: result.receipt, dockerCalls: extraFault.calls, independentPostCleanupReadback: readback });
    } finally { extraFault.restore(); }
  });

  it("rejects reserved credential/control paths and folded aliases before allocation", async () => {
    const invalid = [".env.local", ".GIT/config", ".ssh/id_rsa", ".aws/credentials", ".docker/config.json", ".npmrc", "．env.local"];
    for (const path of invalid) {
      const base = packet(candidateProcess("null"));
      const bytes = new TextEncoder().encode("synthetic marker only");
      expect(() => validateCandidatePacket({ ...base, files: [...base.files, { path, bytes, sha256: hash(bytes) }] })).toThrow(/path/i);
    }
    const base = packet(candidateProcess("null"));
    const a = new TextEncoder().encode("a");
    const b = new TextEncoder().encode("b");
    expect(() => validateCandidatePacket({ ...base, files: [...base.files, { path: "A", bytes: a, sha256: hash(a) }, { path: "a/b", bytes: b, sha256: hash(b) }] })).toThrow(/collision/i);
  });
});
