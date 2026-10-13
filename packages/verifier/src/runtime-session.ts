import { randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, realpath, chmod, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { copyBoundedE2EJsonData, canonicalJson } from "@agentx/contracts";

const MAX_FRAME_BYTES = 262_144;
const MAX_DEPTH = 64;
export type E2EWorkerSessionReadback = Readonly<{ socket: boolean; path: string; mode: number; inode: number; device: number; requestCount: number; registeredWorkers: number; closed: boolean }>;
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
  const socketPath = join(directory, `w-${randomBytes(8).toString("hex")}.sock`);
  if (Buffer.byteLength(socketPath) > 100) throw new Error("owned worker socket path exceeds the platform limit");
  const token = Buffer.from(input.capability, "hex");
  const used = new Set<string>();
  const workers = new Map<string, { token: Buffer; expectedSequence: number }>();
  const queue: Array<{ socket: Socket; payload: unknown }> = [];
  let processing = false;
  let requestCount = 0;
  let closed = false;
  const socketIdentityRef: { value?: { dev: number; ino: number; uid: number } } = {};
  const controller = new AbortController();
  const onAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  const send = (socket: Socket, value: unknown) => {
    try {
      const bounded = copyBoundedE2EJsonData(value, { maxBytes: MAX_FRAME_BYTES, maxDepth: MAX_DEPTH });
      const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: "trusted-worker-response/v1", ok: true, value: bounded })}\n`, "utf8");
      socket.end(bytes);
    } catch {
      socket.end(`${JSON.stringify({ schemaVersion: "trusted-worker-response/v1", ok: false, error: "observation result unavailable" })}\n`);
    }
  };
  const reject = (socket: Socket, reason: string) => socket.end(`${JSON.stringify({ schemaVersion: "trusted-worker-response/v1", ok: false, error: reason })}\n`);
  const drain = async () => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const item = queue.shift()!;
        try {
          if (Date.now() >= deadlineAt || controller.signal.aborted) { reject(item.socket, "worker session expired"); continue; }
          const value = await input.handle(item.payload, controller.signal);
          if (Date.now() >= deadlineAt || controller.signal.aborted) reject(item.socket, "worker observation completed outside its admitted window");
          else send(item.socket, value);
        } catch { reject(item.socket, "candidate observation unavailable"); }
      }
    } finally { processing = false; if (queue.length > 0) void drain(); }
  };
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let bytes = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.byteLength > MAX_FRAME_BYTES) socket.destroy();
    });
    socket.on("end", () => {
      void (async () => {
        if (closed || Date.now() >= deadlineAt || controller.signal.aborted) return reject(socket, "worker session expired");
        const current = await lstat(socketPath).catch(() => undefined);
        const socketIdentity = socketIdentityRef.value;
        if (!current?.isSocket() || current.isSymbolicLink() || !socketIdentity || current.dev !== socketIdentity.dev || current.ino !== socketIdentity.ino || current.uid !== socketIdentity.uid || (current.mode & 0o777) !== 0o600) return reject(socket, "worker session socket identity changed");
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
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => { server.removeListener("error", rejectListen); resolveListen(); });
  });
  await chmod(socketPath, 0o600);
  const created = await lstat(socketPath);
  if (!created.isSocket() || created.isSymbolicLink() || (created.mode & 0o777) !== 0o600 || created.uid !== dirStat.uid) {
    await new Promise<void>((done) => server.close(() => done()));
    throw new Error("worker session socket did not retain its owned private identity");
  }
  socketIdentityRef.value = { dev: created.dev, ino: created.ino, uid: created.uid };
  const readback = (): E2EWorkerSessionReadback => ({ socket: !closed, path: socketPath, mode: created.mode & 0o777, inode: created.ino, device: created.dev, requestCount, registeredWorkers: workers.size, closed });
  return Object.freeze({ socketPath, readback, close: async () => {
    if (closed) return true;
    closed = true;
    controller.abort(new Error("worker session closed"));
    input.signal?.removeEventListener("abort", onAbort);
    const closeResult = await new Promise<boolean>((done) => server.close((error) => done(!error)));
    const current = await lstat(socketPath).catch(() => undefined);
    const socketIdentity = socketIdentityRef.value;
    if (current?.isSocket() && socketIdentity && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) await unlink(socketPath);
    const remains = await lstat(socketPath).then(() => true, () => false);
    return closeResult && !remains;
  } });
}
