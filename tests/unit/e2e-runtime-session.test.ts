import { createConnection } from "node:net";
import { chmod, mkdtemp, rm, symlink, unlink, lstat, readlink } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createE2EWorkerSession } from "../../packages/verifier/src/runtime-session.js";

const exchange = (path: string, frame: unknown) => new Promise<string>((resolve, reject) => {
  const socket = createConnection(path);
  const chunks: Buffer[] = [];
  socket.once("error", reject);
  socket.once("connect", () => socket.end(`${JSON.stringify(frame)}\n`));
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});
const parsed = async (path: string, frame: unknown): Promise<Record<string, unknown>> => JSON.parse(await exchange(path, frame)) as Record<string, unknown>;

describe("private E2E worker session", () => {
  it("issues per-worker credentials, serializes owned cases, and rejects foreign, duplicate, and replay requests", async () => {
    const directory = await mkdtemp("/tmp/e2es-");
    await chmod(directory, 0o700);
    const launchCapability = "a".repeat(64);
    const workerA = "1".repeat(24);
    const workerB = "2".repeat(24);
    const cases = new Map([
      ["case-a", { payload: { caseId: "case-a", input: { a: 1 } } }],
      ["case-b", { payload: { caseId: "case-b", input: { b: 2 } } }],
    ]);
    const active = { value: 0, max: 0 };
    let calls = 0;
    const session = await createE2EWorkerSession({ directory, capability: launchCapability, expectedByCase: cases, handle: async (payload) => {
      calls += 1;
      active.value += 1;
      active.max = Math.max(active.max, active.value);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active.value -= 1;
      return payload;
    } });
    try {
      const register = (workerId: string) => parsed(session.socketPath, { schemaVersion: "trusted-worker-observation/v1", kind: "register", capability: launchCapability, workerId });
      const registrationA = await register(workerA);
      const registrationB = await register(workerB);
      const tokenA = registrationA.value as { workerToken: string };
      const tokenB = registrationB.value as { workerToken: string };
      expect(registrationA).toMatchObject({ schemaVersion: "trusted-worker-response/v1", ok: true });
      expect(registrationB).toMatchObject({ schemaVersion: "trusted-worker-response/v1", ok: true });
      expect(tokenA.workerToken).not.toBe(tokenB.workerToken);

      const request = (workerId: string, workerToken: string, sequence: number, payload: unknown) => ({ schemaVersion: "trusted-worker-observation/v1", workerId, workerToken, sequence, payload });
      const [responseA, responseB] = await Promise.all([
        parsed(session.socketPath, request(workerA, tokenA.workerToken, 1, cases.get("case-a")!.payload)),
        parsed(session.socketPath, request(workerB, tokenB.workerToken, 1, cases.get("case-b")!.payload)),
      ]);
      expect(responseA).toMatchObject({ ok: true, value: { caseId: "case-a" } });
      expect(responseB).toMatchObject({ ok: true, value: { caseId: "case-b" } });
      expect(active.max).toBe(1);

      const foreign = await parsed(session.socketPath, request("3".repeat(24), tokenA.workerToken, 1, cases.get("case-a")!.payload));
      const duplicateCase = await parsed(session.socketPath, request(workerA, tokenA.workerToken, 2, cases.get("case-a")!.payload));
      const replay = await parsed(session.socketPath, request(workerA, tokenA.workerToken, 1, cases.get("case-a")!.payload));
      const badLaunch = await parsed(session.socketPath, { schemaVersion: "trusted-worker-observation/v1", kind: "register", capability: "b".repeat(64), workerId: "4".repeat(24) });
      expect(foreign).toMatchObject({ ok: false });
      expect(duplicateCase).toMatchObject({ ok: false });
      expect(replay).toMatchObject({ ok: false });
      expect(badLaunch).toMatchObject({ ok: false });
      expect(calls).toBe(2);
      expect(session.readback()).toMatchObject({ socket: true, mode: 0o600, requestCount: 2, registeredWorkers: 2 });
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("quarantines a connected request after owned socket path substitution", async () => {
    const directory = await mkdtemp("/tmp/e2es-substitute-");
    await chmod(directory, 0o700);
    const token = "c".repeat(64);
    const session = await createE2EWorkerSession({ directory, capability: token, expectedByCase: new Map([["case", { payload: { caseId: "case" } }]]), handle: async (payload) => payload });
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(session.socketPath);
        const chunks: Buffer[] = [];
        socket.once("error", reject);
        socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        socket.once("connect", () => {
          void (async () => {
            await unlink(session.socketPath);
            await symlink("/dev/null", session.socketPath);
            socket.end(`${JSON.stringify({ schemaVersion: "trusted-worker-observation/v1", kind: "register", capability: token, workerId: "9".repeat(24) })}\n`);
          })().catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
        });
        socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      expect(JSON.parse(raw)).toMatchObject({ schemaVersion: "trusted-worker-response/v1", ok: false });
      expect(session.readback().requestCount).toBe(0);
      const firstClose = session.close();
      const secondClose = session.close();
      expect(firstClose).toBe(secondClose);
      expect(await firstClose).toBe(false);
      expect(session.readback().closed).toBe(true);
      expect(session.readback().socket).toBe(false);
      expect(session.readback()).toMatchObject({ serverListening: true, cleanupConfirmed: false });
      expect((await lstat(session.socketPath)).isSymbolicLink()).toBe(true);
      expect(await readlink(session.socketPath)).toBe("/dev/null");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("closes the owned socket at the absolute deadline and confirms path absence", async () => {
    const directory = await mkdtemp("/tmp/e2es-expiry-");
    await chmod(directory, 0o700);
    const controller = new AbortController();
    const token = "d".repeat(64);
    const session = await createE2EWorkerSession({ directory, capability: token, expectedByCase: new Map([["case", { payload: { caseId: "case" } }]]), handle: async (payload) => payload, signal: controller.signal, deadlineAt: Date.now() + 30 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(session.readback()).toMatchObject({ socket: false, closed: true });
      await expect(parsed(session.socketPath, { schemaVersion: "trusted-worker-observation/v1", kind: "register", capability: token, workerId: "a".repeat(24) })).rejects.toThrow();
      expect(await session.close()).toBe(true);
      expect(session.readback()).toMatchObject({ requestCount: 0, registeredWorkers: 0 });
      expect(session.readback().socket).toBe(false);
    } finally { await session.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it("destroys an owned partial client on close and coalesces concurrent close completion", async () => {
    const directory = await mkdtemp("/tmp/e2es-partial-");
    await chmod(directory, 0o700);
    const session = await createE2EWorkerSession({ directory, capability: "e".repeat(64), expectedByCase: new Map([["case", { payload: { caseId: "case" } }]]), handle: async (payload) => payload });
    const socket = createConnection(session.socketPath);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write('{"partial":');
    const firstClose = session.close();
    const secondClose = session.close();
    expect(firstClose).toBe(secondClose);
    expect(await firstClose).toBe(true);
    expect(session.readback()).toMatchObject({ socket: false, closed: true });
    await rm(directory, { recursive: true, force: true });
  });

  it("contains an abrupt disconnect while an observation is active", async () => {
    const directory = await mkdtemp("/tmp/e2es-abrupt-");
    await chmod(directory, 0o700);
    let started!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const token = "f".repeat(64);
    const session = await createE2EWorkerSession({ directory, capability: token, expectedByCase: new Map([["case", { payload: { caseId: "case" } }]]), handle: async (payload) => { started(); await gate; return payload; } });
    try {
      const registration = await parsed(session.socketPath, { schemaVersion: "trusted-worker-observation/v1", kind: "register", capability: token, workerId: "b".repeat(24) });
      const workerToken = (registration.value as { workerToken: string }).workerToken;
      expect(typeof workerToken).toBe("string");
      const socket = createConnection(session.socketPath);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      socket.end(`${JSON.stringify({ schemaVersion: "trusted-worker-observation/v1", workerId: "b".repeat(24), workerToken, sequence: 1, payload: { caseId: "case" } })}\n`);
      await began;
      socket.destroy();
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(session.readback().requestCount).toBe(1);
      expect(await session.close()).toBe(true);
      expect(session.readback().cleanupConfirmed).toBe(true);
    } finally { release(); await session.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
