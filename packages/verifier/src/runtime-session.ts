import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, realpath, chmod, unlink, link, open } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { copyBoundedE2EJsonData, canonicalJson } from "@agentx/contracts";

const MAX_FRAME_BYTES = 262_144;
const MAX_DEPTH = 64;
const CLEANUP_CAP_MS = 60_000;
async function lstatIfPresent(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(path); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
export type E2EWorkerSessionReadback = Readonly<{ socket: boolean; aliasEntryPresent: boolean; privateSentinelPresent: boolean; path: string; privatePath: string; mode: number; inode: number; device: number; sentinelInode: number; sentinelDevice: number; parentDevice: number; parentInode: number; parentUid: number; requestCount: number; registeredWorkers: number; closed: boolean; serverListening: boolean; cleanupConfirmed: boolean }>;
export type E2EWorkerSession = Readonly<{ socketPath: string; readback: () => E2EWorkerSessionReadback; close: () => Promise<boolean> }>;

export async function createE2EWorkerSession(input: Readonly<{
  directory: string;
  capability: string;
  expectedByCase: ReadonlyMap<string, Readonly<{ payload: unknown }>>;
  handle(payload: unknown, signal: AbortSignal): Promise<unknown>;
  signal?: AbortSignal;
  deadlineAt?: number;
}>): Promise<E2EWorkerSession> {
  if (!/^[a-f0-9]{64,}$/.test(input.capability) || input.expectedByCase.size < 1 || input.expectedByCase.size > 64) throw new TypeError("worker session capability or case inventory is invalid");
  const directory = await realpath(resolve(input.directory));
  const dirStat = await lstat(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw new Error("worker session directory must be canonical and private");
  if (typeof process.getuid === "function" && dirStat.uid !== process.getuid()) throw new Error("worker session directory owner is not the current user");
  const deadlineAt = input.deadlineAt ?? Date.now() + 60_000;
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) throw new Error("worker session deadline has elapsed");
  const expected = new Map<string, string>();
  for (const [caseId, item] of input.expectedByCase) {
    if (typeof caseId !== "string" || caseId.length < 1 || caseId.length > 160) throw new TypeError("worker case ID is invalid");
    expected.set(caseId, canonicalJson(copyBoundedE2EJsonData(item.payload, { maxBytes: MAX_FRAME_BYTES, maxDepth: MAX_DEPTH })));
  }
  const bindPath = join(directory, `b-${randomBytes(8).toString("hex")}.sock`);
  const socketPath = join(directory, `w-${randomBytes(8).toString("hex")}.sock`);
  if (Buffer.byteLength(bindPath) > 100 || Buffer.byteLength(socketPath) > 100) throw new Error("owned worker socket path exceeds the platform limit");
  const token = Buffer.from(input.capability, "hex");
  const used = new Set<string>();
  const workers = new Map<string, { token: Buffer; expectedSequence: number }>();
  const queue: Array<{ socket: Socket; payload: unknown }> = [];
  const sockets = new Set<Socket>();
  let processing = false;
  let requestCount = 0;
  let closed = false;
  let cleanupConfirmed = false;
  let closePromise: Promise<boolean> | undefined;
  const socketIdentityRef: { value?: { dev: number; ino: number; uid: number } } = {};
  const sentinelIdentityRef: { value?: { dev: number; ino: number; uid: number } } = {};
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  const send = (socket: Socket, value: unknown) => {
    if (closed || socket.destroyed) return;
    try {
      const bounded = copyBoundedE2EJsonData(value, { maxBytes: MAX_FRAME_BYTES, maxDepth: MAX_DEPTH });
      const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: "trusted-worker-response/v1", ok: true, value: bounded })}\n`, "utf8");
      socket.end(bytes);
    } catch {
      socket.end(`${JSON.stringify({ schemaVersion: "trusted-worker-response/v1", ok: false, error: "observation result unavailable" })}\n`);
    }
  };
  const reject = (socket: Socket, reason: string) => { if (!closed && !socket.destroyed) socket.end(`${JSON.stringify({ schemaVersion: "trusted-worker-response/v1", ok: false, error: reason })}\n`); };
  const drain = async () => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift()!;
        try {
          if (Date.now() >= deadlineAt || controller.signal.aborted) { reject(item.socket, "worker session expired"); continue; }
          const value = await input.handle(item.payload, controller.signal);
          if (closed || Date.now() >= deadlineAt || controller.signal.aborted) reject(item.socket, "worker observation completed outside its admitted window");
          else send(item.socket, value);
        } catch { reject(item.socket, "candidate observation unavailable"); }
      }
    } finally { processing = false; if (queue.length > 0) void drain(); }
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => { sockets.delete(socket); });
    socket.on("close", () => { sockets.delete(socket); });
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (closed || Date.now() >= deadlineAt || controller.signal.aborted) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.byteLength > MAX_FRAME_BYTES) socket.destroy();
    });
    socket.on("end", () => {
      void (async () => {
        if (closed || Date.now() >= deadlineAt || controller.signal.aborted) return reject(socket, "worker session expired");
        const current = await lstatIfPresent(socketPath);
        const socketIdentity = socketIdentityRef.value;
        if (!current?.isSocket() || current.isSymbolicLink() || !socketIdentity || current.dev !== socketIdentity.dev || current.ino !== socketIdentity.ino || current.uid !== socketIdentity.uid || (Number(current.mode) & 0o777) !== 0o600) return reject(socket, "worker session socket identity changed");
        if (!bytes.length || bytes[bytes.length - 1] !== 0x0a || bytes.subarray(0, bytes.length - 1).includes(0x0a)) return reject(socket, "worker frame boundary is invalid");
        let request: unknown;
        try { request = copyBoundedE2EJsonData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - 1))), { maxBytes: MAX_FRAME_BYTES, maxDepth: MAX_DEPTH }); }
        catch { return reject(socket, "worker frame is not bounded UTF-8 JSON"); }
        if (!request || typeof request !== "object" || Array.isArray(request)) return reject(socket, "worker frame fields are invalid");
        const record = request as Record<string, unknown>;
        if (record.schemaVersion !== "trusted-worker-observation/v1" || typeof record.workerId !== "string" || !/^[a-f0-9]{24}$/.test(record.workerId)) return reject(socket, "worker registration identity is invalid");
        if (record.kind === "register" && Object.keys(record).sort().join(",") === "capability,kind,schemaVersion,workerId") {
          const suppliedToken = typeof record.capability === "string" ? Buffer.from(record.capability, "hex") : Buffer.alloc(0);
          if (suppliedToken.byteLength !== token.byteLength || !timingSafeEqual(suppliedToken, token)) return reject(socket, "worker launch capability rejected");
          if (workers.has(record.workerId) || workers.size >= expected.size) return reject(socket, "worker registration is duplicate or exceeds the admitted case bound");
          const workerToken = randomBytes(32);
          workers.set(record.workerId, { token: workerToken, expectedSequence: 1 });
          return send(socket, { workerToken: workerToken.toString("hex") });
        }
        if (Object.keys(record).sort().join(",") !== "payload,schemaVersion,sequence,workerId,workerToken") return reject(socket, "worker request fields are invalid");
        const worker = workers.get(record.workerId);
        if (!worker || typeof record.workerToken !== "string") return reject(socket, "worker session is not supervisor-registered");
        const suppliedToken = Buffer.from(record.workerToken, "hex");
        if (suppliedToken.byteLength !== worker.token.byteLength || !timingSafeEqual(suppliedToken, worker.token)) return reject(socket, "worker session credential rejected");
        if (record.sequence !== worker.expectedSequence || !Number.isSafeInteger(record.sequence)) return reject(socket, "worker sequence is invalid");
        const payload = record.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as Record<string, unknown>).caseId !== "string") return reject(socket, "worker case payload is invalid");
        const caseId = (payload as Record<string, unknown>).caseId as string;
        const admittedPayload = expected.get(caseId);
        if (!admittedPayload || used.has(caseId) || canonicalJson(payload) !== admittedPayload) return reject(socket, "worker request does not match one unused admitted case");
        used.add(caseId);
        worker.expectedSequence += 1;
        requestCount += 1;
        queue.push({ socket, payload });
        void drain();
      })().catch(() => reject(socket, "worker session failed"));
    });
  });
  const ownedDirectory = async () => {
    const parent = await lstatIfPresent(directory);
    return Boolean(parent?.isDirectory() && !parent.isSymbolicLink() && parent.dev === dirStat.dev && parent.ino === dirStat.ino && parent.uid === dirStat.uid && (Number(parent.mode) & 0o777) === 0o700 && await realpath(directory).then((path) => path === directory, () => false));
  };
  const isOwnedSocket = (current: Awaited<ReturnType<typeof lstat>> | undefined) => {
    const identity = socketIdentityRef.value;
    return Boolean(current?.isSocket() && !current.isSymbolicLink() && identity && current.dev === identity.dev && current.ino === identity.ino && current.uid === identity.uid && (Number(current.mode) & 0o777) === 0o600);
  };
  const isOwnedSentinel = (current: Awaited<ReturnType<typeof lstat>> | undefined) => {
    const identity = sentinelIdentityRef.value;
    return Boolean(current?.isFile() && !current.isSymbolicLink() && identity && current.dev === identity.dev && current.ino === identity.ino && current.uid === identity.uid && (Number(current.mode) & 0o777) === 0o600);
  };
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(bindPath, () => { server.removeListener("error", rejectListen); resolveListen(); });
  });
  try {
    await chmod(bindPath, 0o600);
    const created = await lstat(bindPath);
    if (!created.isSocket() || created.isSymbolicLink() || (created.mode & 0o777) !== 0o600 || created.uid !== dirStat.uid) throw new Error("worker session socket did not retain its owned private identity");
    socketIdentityRef.value = { dev: created.dev, ino: created.ino, uid: created.uid };
    if (!await ownedDirectory() || await lstatIfPresent(socketPath) !== undefined) throw new Error("worker alias path is not exclusively available in the owned parent");
    await link(bindPath, socketPath);
    const alias = await lstat(socketPath);
    if (!isOwnedSocket(alias) || alias.nlink !== 2 || !await ownedDirectory()) throw new Error("worker alias did not retain the bound socket identity");
    const currentBind = await lstatIfPresent(bindPath);
    if (!isOwnedSocket(currentBind)) throw new Error("private worker bind entry changed before sentinel creation");
    await unlink(bindPath);
    const sentinelHandle = await open(bindPath, "wx", 0o600);
    try {
      await sentinelHandle.writeFile(`owned-worker-sentinel:${randomBytes(16).toString("hex")}\n`, "utf8");
      const sentinelStat = await sentinelHandle.stat();
      sentinelIdentityRef.value = { dev: sentinelStat.dev, ino: sentinelStat.ino, uid: sentinelStat.uid };
    } finally { await sentinelHandle.close(); }
    const sentinel = await lstat(bindPath);
    if (!isOwnedSentinel(sentinel) || !await ownedDirectory()) throw new Error("private worker sentinel did not retain its exclusive owned identity");
  } catch (error) {
    let parentOwned = false;
    let privateEntry: Awaited<ReturnType<typeof lstat>> | undefined;
    let aliasEntry: Awaited<ReturnType<typeof lstat>> | undefined;
    try { parentOwned = await ownedDirectory(); } catch { /* unknown parent state is not ownership */ }
    try { privateEntry = await lstatIfPresent(bindPath); } catch { /* unknown path state cannot authorize close */ }
    try { aliasEntry = await lstatIfPresent(socketPath); } catch { /* unknown alias state cannot authorize unlink */ }
    if (server.listening && parentOwned && (isOwnedSocket(privateEntry) || isOwnedSentinel(privateEntry))) {
      await new Promise<void>((resolveClose) => { try { server.close(() => resolveClose()); } catch { resolveClose(); } });
    } else server.unref();
    if (parentOwned && isOwnedSocket(aliasEntry)) await unlink(socketPath).catch(() => undefined);
    throw error;
  }
  const created = await lstat(bindPath);
  const socketIdentity = socketIdentityRef.value;
  const sentinelIdentity = sentinelIdentityRef.value;
  if (!socketIdentity || !sentinelIdentity) throw new Error("worker path ownership identities were not enrolled");
  const readback = (): E2EWorkerSessionReadback => {
    const alias = lstatSync(socketPath, { throwIfNoEntry: false });
    const sentinel = lstatSync(bindPath, { throwIfNoEntry: false });
    const ownedPresent = isOwnedSocket(alias);
    return { socket: ownedPresent, aliasEntryPresent: Boolean(alias), privateSentinelPresent: isOwnedSentinel(sentinel), path: socketPath, privatePath: bindPath, mode: created.mode & 0o777, inode: socketIdentity.ino, device: socketIdentity.dev, sentinelInode: sentinelIdentity.ino, sentinelDevice: sentinelIdentity.dev, parentDevice: dirStat.dev, parentInode: dirStat.ino, parentUid: dirStat.uid, requestCount, registeredWorkers: workers.size, closed, serverListening: server.listening, cleanupConfirmed };
  };
  const close = (): Promise<boolean> => {
    if (closePromise) return closePromise;
    closed = true;
    controller.abort(new Error("worker session closed"));
    input.signal?.removeEventListener("abort", onAbort);
    for (const item of queue.splice(0)) item.socket.destroy();
    for (const socket of sockets) socket.destroy();
    closePromise = new Promise<boolean>((resolveClose) => {
      let settled = false;
      const settle = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupConfirmed = confirmed;
        if (!confirmed) server.unref();
        resolveClose(confirmed);
      };
      const timer = setTimeout(() => settle(false), CLEANUP_CAP_MS);
      const finish = async (serverClosed: boolean) => {
        if (settled) return;
        try {
          const parentOwned = await ownedDirectory();
          const aliasEntry = await lstatIfPresent(socketPath);
          if (serverClosed && parentOwned && isOwnedSocket(aliasEntry)) {
            const parentStillOwned = await ownedDirectory();
            const aliasBeforeUnlink = await lstatIfPresent(socketPath);
            if (parentStillOwned && isOwnedSocket(aliasBeforeUnlink)) await unlink(socketPath).catch(() => undefined);
          }
          const parentStillOwned = await ownedDirectory();
          const privateAfterClose = await lstatIfPresent(bindPath);
          const aliasAfterClose = await lstatIfPresent(socketPath);
          settle(serverClosed && parentOwned && parentStillOwned && privateAfterClose === undefined && aliasAfterClose === undefined && sockets.size === 0 && queue.length === 0 && !processing);
        } catch { settle(false); }
      };
      void (async () => {
        if (!await ownedDirectory()) {
          settled = true;
          clearTimeout(timer);
          server.unref();
          resolveClose(false);
          return;
        }
        const beforeClose = await lstatIfPresent(bindPath);
        if (!isOwnedSentinel(beforeClose)) {
          settled = true;
          clearTimeout(timer);
          server.unref();
          resolveClose(false);
          return;
        }
        if (!await ownedDirectory()) {
          settled = true;
          clearTimeout(timer);
          server.unref();
          resolveClose(false);
          return;
        }
        const immediatelyBeforeClose = await lstatIfPresent(bindPath);
        if (!isOwnedSentinel(immediatelyBeforeClose) || !await ownedDirectory()) {
          settled = true;
          clearTimeout(timer);
          server.unref();
          resolveClose(false);
          return;
        }
        try { server.close((error) => { void finish(!error).catch(() => settle(false)); }); }
        catch { void finish(false); }
      })().catch(() => { settled = true; clearTimeout(timer); server.unref(); resolveClose(false); });
    });
    void closePromise.finally(() => { clearTimeout(deadlineTimer); input.signal?.removeEventListener("abort", callerAbortCleanup); });
    return closePromise;
  };
  const deadlineTimer = setTimeout(() => { void close(); }, Math.max(0, deadlineAt - Date.now()));
  const callerAbortCleanup = () => { void close(); };
  input.signal?.addEventListener("abort", callerAbortCleanup, { once: true });
  if (input.signal?.aborted) void close();
  return Object.freeze({ socketPath, readback, close });
}
