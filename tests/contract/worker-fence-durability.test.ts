import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type * as FileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";

// Faults target the journal record only; fence IO remains real.
const faults = vi.hoisted(() => ({ recordPath: "", partial: false, sync: false, cleanup: false, wait: undefined as Promise<void> | undefined, reached: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FileSystem>();
  const fail = async (partial: () => Promise<unknown>) => {
    faults.reached?.();
    await faults.wait;
    if (faults.partial) await partial();
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  };
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args);
    if (args[0] === faults.recordPath) {
      const write = file.writeFile.bind(file);
      if (faults.sync) file.sync = async () => { throw Object.assign(new Error("sync failed"), { code: "EIO" }); };
      else file.writeFile = async () => fail(() => write('{"schemaVersion":'));
    }
    return file;
  }, unlink: async (...args: Parameters<typeof fs.unlink>) => {
    if (args[0] === faults.recordPath && faults.cleanup) throw Object.assign(new Error("cleanup failed"), { code: "EIO" });
    return fs.unlink(...args);
  }, writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
    if (args[0] === faults.recordPath) return fail(() => fs.writeFile(args[0], '{"schemaVersion":', args[2]));
    return fs.writeFile(...args);
  } };
});

const roots: string[] = [];
afterEach(async () => {
  faults.recordPath = "";
  faults.partial = false;
  faults.sync = false;
  faults.cleanup = false;
  faults.wait = undefined;
  faults.reached = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-fence-durability-"));
  roots.push(root);
  const journal = new OperationJournal(root);
  const workspaceId = randomUUID();
  const fenceDirectory = join(journal.directory, "fences");
  const fencePath = join(fenceDirectory, `${workspaceId}.json`);
  const task: WorkerInvocation = {
    protocolVersion: 1, workspaceId, operationId: randomUUID(), fence: 8, projectRevision: 1,
    callbackCapability: "c".repeat(64), kind: "task", payload: { conversationId: randomUUID(), prompt: "Write" },
  };
  return { root, journal, workspaceId, fenceDirectory, fencePath, task };
}

describe("durable worker fence boundaries", () => {
  // Removing the smaller-raise guard must admit fence 8 after either ordering.
  it.each(["sequential", "concurrent"] as const)("never lowers a fence on %s smaller raises", async (ordering) => {
    const h = await fixture();
    await h.journal.raiseFence(h.workspaceId, 9);
    const second = new OperationJournal(h.root);
    if (ordering === "sequential") {
      await h.journal.raiseFence(h.workspaceId, 3);
      await second.raiseFence(h.workspaceId, 7);
    } else {
      await Promise.all([h.journal.raiseFence(h.workspaceId, 3), second.raiseFence(h.workspaceId, 7)]);
    }
    expect(await readFile(h.fencePath, "utf8")).toBe("9\n");
    await expect(second.assertFence(h.task)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(second.accept(h.task)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await second.list()).toEqual([]);
  });

  // Separate fence and acceptance writes expose a raised fence on ENOSPC.
  it("does not move the fence when the guarded close journal append fails", async () => {
    const h = await fixture();
    await h.journal.raiseFence(h.workspaceId, 7);
    const close: WorkerInvocation = { ...h.task, kind: "close", fence: 9, payload: {} };
    faults.recordPath = join(h.journal.directory, `${close.operationId}.json`);
    await expect(h.journal.accept(close)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await h.journal.get(close.operationId)).toBeUndefined();
    expect(await readFile(h.fencePath, "utf8")).toBe("7\n");
    await expect(new OperationJournal(h.root).accept({ ...h.task, operationId: randomUUID() })).resolves.toMatchObject({ duplicate: false });
  });

  // A failed write may leave bytes; cleanup must precede exposing the old fence.
  it.each(["close", "cancel"] as const)("removes a partial %s append without leaving an initial fence", async (kind) => {
    const h = await fixture();
    const base = { ...h.task, fence: 9 };
    const invocation: WorkerInvocation = kind === "close" ? { ...base, kind, payload: {} } : { ...base, kind, payload: { targetOperationId: randomUUID() } };
    faults.recordPath = join(h.journal.directory, `${invocation.operationId}.json`);
    faults.partial = true;
    await expect(h.journal.accept(invocation)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await h.journal.get(invocation.operationId)).toBeUndefined();
    await expect(readFile(h.fencePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(new OperationJournal(h.root).accept({ ...h.task, operationId: randomUUID() })).resolves.toMatchObject({ duplicate: false });
  });

  it("removes an unsynced close record before restoring the fence", async () => {
    const h = await fixture();
    await h.journal.raiseFence(h.workspaceId, 7);
    const close: WorkerInvocation = { ...h.task, kind: "close", fence: 9, payload: {} };
    faults.recordPath = join(h.journal.directory, `${close.operationId}.json`);
    faults.sync = true;
    await expect(h.journal.accept(close)).rejects.toMatchObject({ code: "EIO" });
    expect(await h.journal.get(close.operationId)).toBeUndefined();
    expect(await readFile(h.fencePath, "utf8")).toBe("7\n");
  });

  it("keeps the higher barrier when partial-record cleanup fails", async () => {
    const h = await fixture();
    await h.journal.raiseFence(h.workspaceId, 7);
    const close: WorkerInvocation = { ...h.task, kind: "close", fence: 9, payload: {} };
    faults.recordPath = join(h.journal.directory, `${close.operationId}.json`);
    faults.partial = true;
    faults.cleanup = true;
    await expect(h.journal.accept(close)).rejects.toMatchObject({ cause: { code: "EIO" } });
    expect(await readFile(h.fencePath, "utf8")).toBe("9\n");
    await expect(new OperationJournal(h.root).assertFence(h.task)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(new OperationJournal(h.root).accept(h.task)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  // Admission must not observe a provisional fence, and recovery must never undo
  // a larger raise queued by another journal instance.
  it("serializes admission and a larger raise behind failed-append recovery", async () => {
    const h = await fixture();
    await h.journal.raiseFence(h.workspaceId, 7);
    let resume!: () => void;
    const reached = new Promise<void>((resolve) => { faults.reached = resolve; });
    faults.wait = new Promise<void>((resolve) => { resume = resolve; });
    const close: WorkerInvocation = { ...h.task, kind: "close", fence: 9, payload: {} };
    faults.recordPath = join(h.journal.directory, `${close.operationId}.json`);
    const failed = expect(h.journal.accept(close)).rejects.toMatchObject({ code: "ENOSPC" });
    await reached;
    const second = new OperationJournal(h.root);
    let admitted = false;
    const admittedResult = second.assertFence(h.task).then(() => { admitted = true; }, (error: unknown) => error);
    const raised = second.raiseFence(h.workspaceId, 10);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const admittedBeforeRecovery = admitted;
    resume();
    await failed;
    const result = await admittedResult;
    await raised;
    expect(admittedBeforeRecovery).toBe(false);
    expect(result).toBeUndefined();
    expect(await readFile(h.fencePath, "utf8")).toBe("10\n");
    await expect(second.accept(h.task)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await second.list()).toEqual([]);
  });

  // Treating malformed durable state as an absent fence would run this task.
  it.each(["not-json", "9e", "null", "0", "9007199254740992"])("refuses admission and append for corrupt/partial fence %s", async (contents) => {
    const h = await fixture();
    await mkdir(h.fenceDirectory, { recursive: true });
    await writeFile(h.fencePath, contents);
    await expect(h.journal.assertFence(h.task)).rejects.toThrow();
    await expect(h.journal.accept(h.task)).rejects.toThrow();
    const state = createWorkerServerState(h.journal, { execute: async () => { throw new Error("must never execute"); } });
    const response = await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", body: JSON.stringify(h.task) }), state);
    expect(response.status).toBe(400);
    expect(state.activeOperations.size).toBe(0);
    expect(await h.journal.list()).toEqual([]);
    expect(await readFile(h.fencePath, "utf8")).toBe(contents);
  });

  it("refuses an unreadable fence without creating a journal record", async () => {
    const h = await fixture();
    await h.journal.raiseFence(h.workspaceId, 9);
    await chmod(h.fencePath, 0o000);
    try {
      await expect(h.journal.assertFence(h.task)).rejects.toMatchObject({ code: "EACCES" });
      await expect(h.journal.accept(h.task)).rejects.toMatchObject({ code: "EACCES" });
      const state = createWorkerServerState(h.journal, { execute: async () => { throw new Error("must never execute"); } });
      expect((await handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", body: JSON.stringify(h.task) }), state)).status).toBe(400);
      expect(state.activeOperations.size).toBe(0);
      expect(await h.journal.list()).toEqual([]);
    } finally { await chmod(h.fencePath, 0o600); }
  });

  // An in-memory barrier disappears in the replacement process. Kill at the real
  // boundary after the synced raise, before the close's record write begins.
  it("keeps a synced raise after a crash before append and refuses older work in a new process", async () => {
    const h = await fixture();
    const close: WorkerInvocation = { ...h.task, kind: "close", fence: 9, payload: {} };
    const source = `
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const input = JSON.parse(process.env.FENCE_DURABILITY_INVOCATION);
      const root = process.env.FENCE_DURABILITY_ROOT;
      if (process.env.FENCE_DURABILITY_CRASH === '1') {
        const open = fs.open;
        const write = fs.writeFile;
        const beforeRecord = async (args) => {
          if (args[0] === root + '/.agentx/operations/' + input.operationId + '.json') {
            process.send('before-record');
            await new Promise(() => { setInterval(() => {}, 1000); });
          }
        };
        fs.writeFile = async (...args) => { await beforeRecord(args); return write(...args); };
        fs.open = async (...args) => { await beforeRecord(args); return open(...args); };
        syncBuiltinESMExports();
      }
      const { OperationJournal } = await import('./packages/worker/src/journal.ts');
      const journal = new OperationJournal(root);
      if (process.env.FENCE_DURABILITY_CRASH === '1') await journal.accept(input);
      else {
        const { createWorkerServerState, handleWorkerRequest } = await import('./packages/worker/src/server.ts');
        const state = createWorkerServerState(journal, { execute: async () => { await fs.writeFile(root + '/effect.txt', 'late bytes'); } });
        const response = await handleWorkerRequest(new Request('http://worker/invocations', { method: 'POST', body: JSON.stringify(input) }), state);
        while (state.activeOperations.size) await new Promise(resolve => setImmediate(resolve));
        process.send(response.status);
      }
    `;
    const children: ChildProcess[] = [];
    function start(value: WorkerInvocation, crash: boolean) {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
        cwd: process.cwd(), env: { ...process.env, FENCE_DURABILITY_ROOT: h.root, FENCE_DURABILITY_INVOCATION: JSON.stringify(value), FENCE_DURABILITY_CRASH: crash ? "1" : "0" },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);
      return child;
    }
    try {
      const first = start(close, true);
      expect((await once(first, "message", { signal: AbortSignal.timeout(10_000) }))[0]).toBe("before-record");
      expect(await readFile(h.fencePath, "utf8")).toBe("9\n");
      const exited = once(first, "exit");
      first.kill("SIGKILL");
      expect(await exited).toEqual([null, "SIGKILL"]);
      expect(await h.journal.get(close.operationId)).toBeUndefined();
      const restarted = start(h.task, false);
      expect((await once(restarted, "message", { signal: AbortSignal.timeout(10_000) }))[0]).toBe(409);
      expect(await new OperationJournal(h.root).list()).toEqual([]);
      expect(await readdir(h.root)).toEqual([".agentx"]);
      expect(await readdir(h.fenceDirectory)).toEqual([`${h.workspaceId}.json`]);
    } finally {
      await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }));
    }
  }, 30_000);
});
