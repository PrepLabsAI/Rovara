import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { CONTAINED_IMAGE, CONTAINED_SOCKET, buildCreateArgs, isOwnedContainer } from "./container-envelope.js";
import { FIXED_CANDIDATE_BOOTSTRAP } from "./fixed-candidate-bootstrap.js";

export { CONTAINED_IMAGE, CONTAINED_SOCKET, buildCreateArgs, isOwnedContainer } from "./container-envelope.js";
const MAX_INPUT_BYTES = 65_536;
const MAX_PROTOCOL_BYTES = 262_144;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_DURATION_MS = 60_000;
const MAX_CLEANUP_MS = 60_000;
const DOCKER = "/opt/homebrew/bin/docker";
const CLIENT_PATH = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

type ExportFile = Readonly<{ path: string; bytes: Uint8Array; sha256: string }>;
export type CandidateExportPacket = Readonly<{ schemaVersion: 1; entry: string; files: readonly ExportFile[] }>;
export type CandidateRequest = Readonly<{ requestId: string; input: unknown }>;
export type CandidateObservation = Readonly<{
  requestId: string;
  output: unknown;
  stdoutBytes: number;
  stdoutSha256: string;
  stderrBytes: number;
  stderrSha256: string;
}>;
export type ContainerReceipt = Readonly<{
  plannedName: string;
  containerId: string | null;
  image: string;
  sourceDigest: string;
  sourceBytes: number;
  owner: Readonly<{ nonce: string; labels: Readonly<Record<string, string>> }>;
  endpoint: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  cleanup: "confirmed" | "pending" | "failed";
  diagnostic?: string;
}>;
export type ContainedExecution = Readonly<{ observation: CandidateObservation | null; receipt: ContainerReceipt; error?: string }>;

type Owner = { nonce: string; sourceDigest: string };
type DockerInspect = { Id: string; Config?: { Image?: string; User?: string; Env?: string[]; Labels?: Record<string, string>; OpenStdin?: boolean; Tty?: boolean; Entrypoint?: string[]; Cmd?: string[] }; HostConfig?: { NetworkMode?: string; ReadonlyRootfs?: boolean; Privileged?: boolean; PidMode?: string; IpcMode?: string; UTSMode?: string; PortBindings?: Record<string, unknown> | null; Devices?: unknown[]; CapAdd?: string[]; CapDrop?: string[]; SecurityOpt?: string[]; PidsLimit?: number; NanoCpus?: number; Memory?: number; MemorySwap?: number; Tmpfs?: Record<string, string>; Binds?: string[]; Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> }; Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> };

function fail(message: string): never { throw new Error(message); }
function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function pathOk(path: string): boolean {
  if (path.length === 0 || [...path].length > 240 || path.startsWith("/") || path.includes("\\") || path !== path.normalize("NFC") || [...path].some((character) => { const code = character.codePointAt(0)!; return code < 32 || code === 127; })) return false;
  const parts = path.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== ".." && part !== ".git" && part !== ".env");
}
function foldedPath(path: string): string { return path.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ"); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function safeDiagnostic(value: string): string { return [...value].map((character) => { const code = character.charCodeAt(0); return code < 32 || code === 127 ? " " : character; }).join("").slice(0, 1000); }
function depth(value: unknown, level = 0): number {
  if (level > 32) return level;
  if (Array.isArray(value)) { let max = level; for (const item of value as unknown[]) max = Math.max(max, depth(item, level + 1)); return max; }
  if (plain(value)) return Object.values(value).reduce<number>((max, item) => Math.max(max, depth(item, level + 1)), level);
  return level;
}
function containerOwner(nonce: string, sourceDigest: string): Readonly<{ nonce: string; labels: Readonly<Record<string, string>> }> {
  return Object.freeze({ nonce, labels: Object.freeze({ "agentx.owner": "contained-candidate-v1", "agentx.nonce": nonce, "agentx.source": sourceDigest }) });
}

export function validateCandidatePacket(packet: unknown): CandidateExportPacket {
  if (!plain(packet) || !exactKeys(packet, ["schemaVersion", "entry", "files"]) || packet.schemaVersion !== 1 || typeof packet.entry !== "string" || !pathOk(packet.entry) || !packet.entry.endsWith(".mjs") || !Array.isArray(packet.files) || packet.files.length < 1 || packet.files.length > 128) fail("candidate packet shape or entry path is invalid");
  const seen = new Set<string>();
  const foldedPaths = new Set<string>();
  let bytesTotal = 0;
  const files = packet.files.map((item): ExportFile => {
    if (!plain(item) || !exactKeys(item, ["path", "bytes", "sha256"]) || typeof item.path !== "string" || !pathOk(item.path) || !(item.bytes instanceof Uint8Array) || typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) fail("candidate file shape or path is invalid");
    const itemPath = item.path;
    const itemBytes = item.bytes;
    const itemSha = item.sha256;
    if (seen.has(itemPath)) fail("candidate file paths must be unique");
    const folded = foldedPath(itemPath);
    if (foldedPaths.has(folded)) fail("candidate file paths contain a case-fold collision");
    if ([...seen].some((existing) => existing.startsWith(`${itemPath}/`) || itemPath.startsWith(`${existing}/`))) fail("candidate file and directory paths collide");
    seen.add(itemPath);
    foldedPaths.add(folded);
    bytesTotal += itemBytes.byteLength;
    if (bytesTotal > MAX_SOURCE_BYTES) fail("candidate source size exceeds limit");
    if (sha(itemBytes) !== itemSha) fail("candidate file digest mismatch");
    return Object.freeze({ path: itemPath, bytes: Uint8Array.from(itemBytes), sha256: itemSha });
  });
  if (!seen.has(packet.entry)) fail("candidate entry is absent from export packet");
  const digest = sha(new TextEncoder().encode(files.map((file) => `${file.path}\0${file.sha256}\n`).sort().join("")));
  return Object.freeze({ schemaVersion: 1, entry: packet.entry, files: Object.freeze(files), sourceDigest: digest });
}

async function recheckMaterializedExport(packet: CandidateExportPacket & { sourceDigest: string }, sourcePath: string, bootstrapPath: string, expectedBootstrapDigest: string): Promise<void> {
  const sourceRoot = await realpath(sourcePath);
  const sourceEntries: string[] = [];
  const inodes = new Set<string>();
  for (const file of packet.files) {
    const parts = file.path.split("/");
    let parent = sourcePath;
    for (const segment of parts.slice(0, -1)) {
      parent = join(parent, segment);
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o222) !== 0) fail("materialized source directory changed or is writable");
    }
    const filePath = join(parent, parts.at(-1)!);
    const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      const actual = await handle.readFile();
      const resolved = await realpath(filePath);
      const inode = `${stat.dev}:${stat.ino}`;
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o222) !== 0 || !resolved.startsWith(sourceRoot + sep)
        || inodes.has(inode) || actual.byteLength !== file.bytes.byteLength || sha(actual) !== file.sha256 || !actual.equals(Buffer.from(file.bytes))) fail("materialized candidate file differs from immutable export packet or collides with another file");
      inodes.add(inode);
      sourceEntries.push(`${file.path}\0${sha(actual)}\n`);
    } finally { await handle.close(); }
  }
  const actualDigest = sha(new TextEncoder().encode(sourceEntries.sort().join("")));
  if (actualDigest !== packet.sourceDigest) fail("materialized candidate export digest changed");
  const bootstrapHandle = await open(bootstrapPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await bootstrapHandle.stat();
    const bytes = await bootstrapHandle.readFile();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o222) !== 0 || sha(bytes) !== expectedBootstrapDigest || !bytes.equals(Buffer.from(FIXED_CANDIDATE_BOOTSTRAP))) fail("fixed bootstrap changed after materialization");
  } finally { await bootstrapHandle.close(); }
}

export function validateRequest(request: unknown): CandidateRequest {
  if (!plain(request) || !exactKeys(request, ["requestId", "input"]) || typeof request.requestId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(request.requestId)) fail("request envelope is invalid");
  if (depth(request.input) > 32) fail("request input depth exceeds limit");
  let inputJson: string;
  try {
    const serialized = JSON.stringify(request.input);
    if (typeof serialized !== "string") fail("request input is not JSON");
    inputJson = serialized;
    JSON.parse(inputJson);
  } catch {
    fail("request input is not valid JSON");
  }
  if (new TextEncoder().encode(inputJson).byteLength > MAX_INPUT_BYTES) fail("request input size exceeds limit");
  const envelope = JSON.stringify({ requestId: request.requestId, input: JSON.parse(inputJson) as unknown });
  if (new TextEncoder().encode(envelope).byteLength > MAX_PROTOCOL_BYTES) fail("request envelope size exceeds protocol limit");
  return Object.freeze({ requestId: request.requestId, input: JSON.parse(inputJson) as unknown });
}

function runProcess(args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; input?: Uint8Array; timeoutMs?: number; signal?: AbortSignal; maxBytes?: number }): Promise<{ stdout: Buffer; stderr: Buffer; code: number; aborted: boolean; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(DOCKER, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let aborted = false;
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1000).unref(); }, options.timeoutMs ?? MAX_DURATION_MS);
    const onAbort = () => { aborted = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1000).unref(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const limit = options.maxBytes ?? MAX_PROTOCOL_BYTES;
    child.stdout.on("data", (chunk: Buffer) => { outBytes += chunk.length; if (outBytes > limit) { child.kill("SIGKILL"); } else stdout.push(Buffer.from(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { errBytes += chunk.length; if (errBytes > limit) { child.kill("SIGKILL"); } else stderr.push(Buffer.from(chunk)); });
    child.on("error", (error) => { if (!done) { done = true; clearTimeout(timer); reject(error); } });
    child.on("close", (code) => {
      if (done) return;
      done = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 125, aborted, timedOut });
    });
    if (options.input) child.stdin.end(options.input); else child.stdin.end();
  });
}

function clientEnv(privateRoot: string): NodeJS.ProcessEnv {
  return { PATH: CLIENT_PATH, HOME: join(privateRoot, "home"), DOCKER_CONFIG: join(privateRoot, "docker-config"), DOCKER_HOST: CONTAINED_SOCKET, LANG: "C.UTF-8" };
}
async function inspectDocker(idOrName: string, env: NodeJS.ProcessEnv, cwd: string): Promise<DockerInspect | null> {
  const result = await runProcess(["container", "inspect", idOrName], { env, cwd, timeoutMs: 10_000, maxBytes: 1_048_576 });
  if (result.code !== 0) return null;
  try { const value: unknown = JSON.parse(result.stdout.toString("utf8")); return Array.isArray(value) && plain(value[0]) ? value[0] as DockerInspect : null; } catch { return null; }
}
function verifyContainer(info: DockerInspect, root: string, source: string, bootstrap: string, entry: string): string[] {
  const cfg = info.Config ?? {};
  const hc = info.HostConfig ?? {};
  const mounts = info.Mounts ?? [];
  const env = cfg?.Env ?? [];
  const expectedEnv = [`AGENTX_ENTRY=/candidate/${entry}`, "HTTP_PROXY=", "HTTPS_PROXY=", "ALL_PROXY=", "NO_PROXY=", "http_proxy=", "https_proxy=", "all_proxy=", "no_proxy=", "NODE_OPTIONS=", "NODE_PATH="];
  const allowedEnvKeys = new Set(["PATH", "NODE_VERSION", "YARN_VERSION", ...expectedEnv.map((item) => item.slice(0, item.indexOf("=")))]);
  const failed: string[] = [];
  if (cfg?.Image !== CONTAINED_IMAGE) failed.push("image");
  if (cfg?.User !== "65532:65532") failed.push("user");
  if (cfg.OpenStdin !== true || cfg.Tty !== false) failed.push("stdio");
  if (JSON.stringify(cfg.Entrypoint) !== JSON.stringify(["node"]) || JSON.stringify(cfg.Cmd) !== JSON.stringify(["/runner/bootstrap.mjs"])) failed.push("command");
  const envKeys = env.map((item) => item.slice(0, item.indexOf("=")));
  if (!expectedEnv.every((v) => env.includes(v)) || env.some((item) => !item.includes("=") || !allowedEnvKeys.has(item.slice(0, item.indexOf("=")))) || new Set(envKeys).size !== envKeys.length) failed.push("env");
  if (hc?.NetworkMode !== "none") failed.push("network");
  if (hc.Privileged !== false || (hc.PidMode ?? "") !== "" || hc.IpcMode !== "private" || (hc.UTSMode ?? "") !== "" || Object.keys(hc.PortBindings ?? {}).length !== 0 || (hc.Devices?.length ?? 0) !== 0 || (hc.CapAdd?.length ?? 0) !== 0) failed.push("host-isolation");
  if (hc.ReadonlyRootfs !== true) failed.push("rootfs");
  if (hc.PidsLimit !== 256 || hc.NanoCpus !== 2_000_000_000 || hc.Memory !== 4_294_967_296 || hc.MemorySwap !== 4_294_967_296) failed.push("resources");
  if (!hc.CapDrop?.includes("ALL")) failed.push("capabilities");
  if (!hc.SecurityOpt?.includes("no-new-privileges:true") || hc.SecurityOpt?.some((value) => value.startsWith("seccomp="))) failed.push("security-options");
  if (mounts.length !== 2 || !mounts.some((m) => m.Source === source && m.Destination === "/candidate" && m.RW === false)) failed.push("candidate-mount");
  if (!mounts.some((m) => m.Source === bootstrap && m.Destination === "/runner/bootstrap.mjs" && m.RW === false)) failed.push("bootstrap-mount");
  if (hc.Tmpfs?.["/tmp"] !== "rw,nosuid,nodev,noexec,size=512m") failed.push("tmpfs");
  if (resolve(root).startsWith(resolve(source) + sep)) failed.push("root-path");
  return failed;
}

async function cleanupOwned(name: string, id: string | null, owner: Owner, env: NodeJS.ProcessEnv, cwd: string): Promise<"confirmed" | "pending" | "failed"> {
  const started = Date.now();
  let info = id ? await inspectDocker(id, env, cwd) : await inspectDocker(name, env, cwd);
  if (!info) return "confirmed";
  if (!isOwnedContainer(info.Config?.Labels, owner) || (id && info.Id !== id)) return "failed";
  await runProcess(["container", "stop", "--time", "10", info.Id], { env, cwd, timeoutMs: 12_000, maxBytes: 4096 }).catch(() => undefined);
  if (Date.now() - started > MAX_CLEANUP_MS) return "pending";
  info = await inspectDocker(info.Id, env, cwd);
  if (!info || !isOwnedContainer(info.Config?.Labels, owner)) return info ? "failed" : "confirmed";
  const removed = await runProcess(["container", "rm", "--force", info.Id], { env, cwd, timeoutMs: MAX_CLEANUP_MS, maxBytes: 4096 }).catch(() => null);
  if (!removed || removed.code !== 0) return "pending";
  return await inspectDocker(info.Id, env, cwd) ? "pending" : "confirmed";
}

export async function runContainedCandidate(packetInput: unknown, requestInput: unknown, options: { signal?: AbortSignal } = {}): Promise<ContainedExecution> {
  const packet = validateCandidatePacket(packetInput) as CandidateExportPacket & { sourceDigest: string };
  const request = validateRequest(requestInput);
  const nonce = randomBytes(24).toString("hex");
  const name = `agentx-contained-${randomBytes(10).toString("hex")}`;
  // Colima shares the project tree with its VM; the macOS system temp folder is not bind-mountable.
  const root = await mkdtemp(join(process.cwd(), ".contained-candidate-"));
  await chmod(root, 0o700);
  const env = clientEnv(root);
  const owner = { nonce, sourceDigest: packet.sourceDigest };
  const ownerReceipt = containerOwner(nonce, packet.sourceDigest);
  const sourceBytes = packet.files.reduce((total, file) => total + file.bytes.byteLength, 0);
  const cidfile = join(root, "container.cid");
  const sourcePath = join(root, "candidate");
  const bootstrapPath = join(root, "bootstrap.mjs");
  const workPath = join(root, "work");
  const sourceDirs = new Set<string>([sourcePath]);
  await Promise.all([mkdir(join(root, "home"), { mode: 0o700 }), mkdir(join(root, "docker-config"), { mode: 0o700 }), mkdir(sourcePath, { mode: 0o700 }), mkdir(workPath, { mode: 0o700 })]);
  for (const file of packet.files) {
    const dest = resolve(sourcePath, file.path);
    if (!dest.startsWith(sourcePath + sep)) throw new Error("candidate path escapes export root");
    const parent = resolve(dest, "..");
    await mkdir(parent, { recursive: true, mode: 0o755 });
    await chmod(parent, 0o755);
    for (let current = parent; current.startsWith(sourcePath + sep); current = resolve(current, "..")) sourceDirs.add(current);
    await writeFile(dest, file.bytes, { mode: 0o444, flag: "wx" });
  }
  for (const directory of [...sourceDirs].sort((left, right) => right.length - left.length)) await chmod(directory, 0o555);
  await writeFile(bootstrapPath, FIXED_CANDIDATE_BOOTSTRAP, { mode: 0o444, flag: "wx" });
  const bootstrapDigest = sha(new TextEncoder().encode(FIXED_CANDIDATE_BOOTSTRAP));
  // Record ownership intent before asking Docker to allocate anything.
  const plan = { name, nonce, sourceDigest: packet.sourceDigest, bootstrapDigest, endpoint: CONTAINED_SOCKET, image: CONTAINED_IMAGE, cidfile };
  await writeFile(join(root, "ownership-plan.json"), JSON.stringify(plan), { mode: 0o400, flag: "wx" });
  let containerId: string | null = null;
  let observation: CandidateObservation | null = null;
  let exitCode: number | null = null;
  let timedOut = false;
  let aborted = false;
  let cleanup: "confirmed" | "pending" | "failed" = "confirmed";
  let diagnostic: string | undefined;
  try {
    const image = await runProcess(["image", "inspect", CONTAINED_IMAGE, "--format", "{{json .}}"], { env, cwd: workPath, timeoutMs: 10_000, maxBytes: 1_048_576 });
    let imageInfo: { RepoDigests?: string[]; Os?: string; Architecture?: string } | null = null;
    try { imageInfo = JSON.parse(image.stdout.toString("utf8")) as { RepoDigests?: string[]; Os?: string; Architecture?: string }; } catch { /* unavailable below */ }
    if (image.code !== 0 || !imageInfo?.RepoDigests?.includes(CONTAINED_IMAGE) || imageInfo.Os !== "linux" || imageInfo.Architecture !== "arm64") throw new Error("pinned local Docker linux/arm64 image is unavailable; execution is unavailable");
    if (options.signal?.aborted) aborted = true;
    if (!aborted) {
      await recheckMaterializedExport(packet, sourcePath, bootstrapPath, bootstrapDigest);
      const created = await runProcess(buildCreateArgs({ name, cidfile, sourcePath, bootstrapPath, sourceDigest: packet.sourceDigest, nonce, entry: packet.entry }), { env, cwd: workPath, timeoutMs: 15_000, ...(options.signal ? { signal: options.signal } : {}), maxBytes: 16_384 });
      aborted ||= created.aborted;
      if (created.code !== 0) throw new Error(`Docker create failed: ${created.stderr.toString("utf8").slice(0, 1000)}`);
      try { containerId = (await readFile(cidfile, "utf8")).trim(); } catch { containerId = created.stdout.toString("utf8").trim(); }
      if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("Docker did not provide an exact container ID");
      const inspect = await inspectDocker(containerId, env, workPath);
      if (!inspect || !isOwnedContainer(inspect.Config?.Labels, owner)) throw new Error("created container ownership could not be confirmed");
      const failedPolicy = verifyContainer(inspect, root, sourcePath, bootstrapPath, packet.entry);
      if (failedPolicy.length) throw new Error(`actual container configuration did not match fixed containment policy: ${failedPolicy.join(",")}`);
      if (!aborted) {
        await recheckMaterializedExport(packet, sourcePath, bootstrapPath, bootstrapDigest);
        const frame = new TextEncoder().encode(JSON.stringify(request));
        const started = await runProcess(["start", "--attach", "--interactive", containerId], { env, cwd: workPath, input: frame, timeoutMs: MAX_DURATION_MS, ...(options.signal ? { signal: options.signal } : {}), maxBytes: MAX_PROTOCOL_BYTES });
        exitCode = started.code; timedOut = started.timedOut; aborted ||= started.aborted;
        if (started.stderr.length) diagnostic = safeDiagnostic(new TextDecoder().decode(started.stderr));
        if (!timedOut && !aborted && started.code === 0 && started.stdout.length > 0) {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const stdoutSha256 = sha(started.stdout);
          const outputText = decoder.decode(started.stdout);
          if (!outputText.endsWith("\n") || outputText.slice(0, -1).includes("\n")) throw new Error("candidate produced an invalid or unsolicited protocol frame");
          const response: unknown = JSON.parse(outputText.slice(0, -1));
          if (!plain(response) || response.requestId !== request.requestId || !Object.hasOwn(response, "output")) throw new Error("candidate response request ID or envelope is invalid");
          const outputDepth = depth(response.output);
          if (outputDepth > 64 || started.stdout.length > MAX_PROTOCOL_BYTES) throw new Error("candidate response exceeds protocol limits");
          observation = Object.freeze({ requestId: request.requestId, output: response.output, stdoutBytes: started.stdout.length, stdoutSha256, stderrBytes: started.stderr.length, stderrSha256: sha(started.stderr) });
        }
      }
    }
  } catch (error) {
    diagnostic = error instanceof Error ? safeDiagnostic(error.message) : "contained candidate execution failed";
  } finally {
    if (containerId || (await inspectDocker(name, env, workPath).catch(() => null))) cleanup = await cleanupOwned(name, containerId, owner, env, workPath).catch(() => "pending");
    for (const directory of sourceDirs) await chmod(directory, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  const receipt = Object.freeze({ plannedName: name, containerId, image: CONTAINED_IMAGE, sourceDigest: packet.sourceDigest, sourceBytes, owner: ownerReceipt, endpoint: CONTAINED_SOCKET, exitCode, timedOut, aborted, cleanup, ...(diagnostic ? { diagnostic } : {}) });
  return Object.freeze({ observation, receipt, ...(diagnostic ? { error: diagnostic } : {}) });
}
