import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest, type WorkerServerState } from "../../packages/worker/src/server.js";

const roots: string[] = [];
const states: WorkerServerState[] = [];
afterEach(async () => {
  await vi.waitFor(() => { for (const state of states) expect(state.activeOperations.size).toBe(0); });
  states.splice(0);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-high-water-fence-"));
  roots.push(root);
  const journal = new OperationJournal(root);
  const workspaceId = randomUUID();
  const writes = join(root, "unpublished.txt");
  const state = createWorkerServerState(journal, {
    execute: async (invocation) => {
      if (invocation.kind === "task") await appendFile(writes, "unpublished bytes\n");
      return { safeToClose: true, repositories: [] };
    },
    steer: async () => { await appendFile(writes, "steered\n"); return {}; },
    peek: async () => ({}),
  });
  states.push(state);
  const send = (invocation: WorkerInvocation) => handleWorkerRequest(request(invocation), state);
  const close = async () => {
    expect((await send(invocation("close", workspaceId, 9))).status).toBe(200);
    await vi.waitFor(() => expect(state.activeOperations.size).toBe(0));
  };
  return { root, journal, state, workspaceId, writes, send, close };
}

function invocation(kind: "close" | "task", workspaceId: string, fence: number): WorkerInvocation {
  const base = { protocolVersion: 1 as const, workspaceId, operationId: randomUUID(), fence, projectRevision: 1, callbackCapability: "c".repeat(64) };
  return kind === "close" ? { ...base, kind, payload: {} } : { ...base, kind, payload: { conversationId: randomUUID(), prompt: "Write the fixture" } };
}

function request(value: WorkerInvocation): Request {
  return new Request("http://worker/invocations", { method: "POST", body: JSON.stringify(value) });
}

async function diskSnapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of Object.entries(await diskSnapshot(path))) result[`${entry.name}/${name}`] = value;
    } else result[entry.name] = await readFile(path, "utf8");
  }
  return result;
}

describe("workspace high-water fence", () => {
  it("refuses 32 parallel older invocations after close with zero bytes written", async () => {
    const h = await fixture();
    await h.close();
    const before = await diskSnapshot(h.root);
    const responses = await Promise.all(Array.from({ length: 32 }, () => h.send(invocation("task", h.workspaceId, 8))));
    await vi.waitFor(() => expect(h.state.activeOperations.size).toBe(0));
    expect(responses.map((response) => response.status)).toEqual(Array.from({ length: 32 }, () => 409));
    expect(await diskSnapshot(h.root)).toEqual(before);
  });

  it("a current-fence invocation still runs and another workspace remains independent", async () => {
    const h = await fixture();
    await h.close();
    expect((await h.send(invocation("task", h.workspaceId, 9))).status).toBe(200);
    await vi.waitFor(() => expect(h.state.activeOperations.size).toBe(0));
    expect(await readFile(h.writes, "utf8")).toBe("unpublished bytes\n");
    expect((await h.send(invocation("task", randomUUID(), 1))).status).toBe(200);
    await vi.waitFor(() => expect(h.state.activeOperations.size).toBe(0));
    expect(await readFile(h.writes, "utf8")).toBe("unpublished bytes\nunpublished bytes\n");
  });

  it("a replayed old raise never lowers the persisted fence, including across journal instances", async () => {
    const h = await fixture();
    await h.close();
    const before = await diskSnapshot(h.root);
    const reopened = new OperationJournal(h.root);
    await Promise.all([h.journal.raiseFence(h.workspaceId, 4), reopened.raiseFence(h.workspaceId, 6)]);
    expect(await diskSnapshot(h.root)).toEqual(before);
    await expect(reopened.accept(invocation("task", h.workspaceId, 8))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rechecks inside the journal when close wins after admission but before append", async () => {
    const h = await fixture();
    const old = invocation("task", h.workspaceId, 8);
    const accept = h.journal.accept.bind(h.journal);
    let resume!: () => void;
    let reached!: () => void;
    const atAppend = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(h.journal, "accept").mockImplementation(async (value) => {
      if (value.operationId === old.operationId) { reached(); await gate; }
      return accept(value);
    });
    const delayed = h.send(old);
    await atAppend;
    await h.close();
    const before = await diskSnapshot(h.root);
    resume();
    expect((await delayed).status).toBe(409);
    expect(await diskSnapshot(h.root)).toEqual(before);
  });

  it("serializes an append already reading the journal against a concurrent close raise", async () => {
    const h = await fixture();
    const old = invocation("task", h.workspaceId, 8);
    const read = h.journal.get.bind(h.journal);
    let resume!: () => void;
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(h.journal, "get").mockImplementation(async (id) => {
      if (id === old.operationId) { reached(); await gate; }
      return read(id);
    });
    const accepting = h.journal.accept(old);
    await reading;
    const closing = new OperationJournal(h.root).accept(invocation("close", h.workspaceId, 9));
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    resume();
    await accepting;
    await closing;
    await expect(h.journal.accept(invocation("task", h.workspaceId, 8))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("checks admission even for live invocations that do not append to the journal", async () => {
    const h = await fixture();
    await h.close();
    const task = invocation("task", h.workspaceId, 8);
    const steer: WorkerInvocation = { ...task, kind: "steer", payload: { targetOperationId: randomUUID(), messageId: `msg_${"a".repeat(20)}`, step: "IMPLEMENT", authority: "owner_instruction", sender: "person p_abcdef", text: "Write" } };
    const before = await diskSnapshot(h.root);
    expect((await h.send(steer)).status).toBe(409);
    expect(await diskSnapshot(h.root)).toEqual(before);
  });

  it("cancel raises the fence before any destructive executor runs", async () => {
    const h = await fixture();
    const task = invocation("task", h.workspaceId, 12);
    const cancel: WorkerInvocation = { ...task, kind: "cancel", payload: { targetOperationId: randomUUID() } };
    expect((await h.send(cancel)).status).toBe(200);
    await vi.waitFor(() => expect(h.state.activeOperations.size).toBe(0));
    const before = await diskSnapshot(h.root);
    expect((await h.send(invocation("task", h.workspaceId, 11))).status).toBe(409);
    expect(await diskSnapshot(h.root)).toEqual(before);
  });

  it("survives killing the worker process and restarting on the same disk journal", async () => {
    const h = await fixture();
    const childSource = `
      import { appendFile } from 'node:fs/promises';
      import { OperationJournal } from './packages/worker/src/journal.ts';
      import { createWorkerServerState, handleWorkerRequest } from './packages/worker/src/server.ts';
      const journal = new OperationJournal(process.env.FENCE_TEST_ROOT);
      const state = createWorkerServerState(journal, { execute: async (invocation) => {
        if (invocation.kind === 'task') await appendFile(process.env.FENCE_TEST_ROOT + '/unpublished.txt', 'late bytes');
      }});
      process.on('message', async (invocation) => {
        const response = await handleWorkerRequest(new Request('http://worker/invocations', { method: 'POST', body: JSON.stringify(invocation) }), state);
        while (state.activeOperations.size) await new Promise((resolve) => setTimeout(resolve, 1));
        process.send(response.status);
      });
      process.send('ready');
    `;
    const children: ChildProcess[] = [];
    async function start() {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
        cwd: process.cwd(), env: { ...process.env, FENCE_TEST_ROOT: h.root }, stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      children.push(child);
      expect((await once(child, "message"))[0]).toBe("ready");
      return child;
    }
    async function send(child: ChildProcess, value: WorkerInvocation) {
      const reply = once(child, "message");
      child.send(value);
      return (await reply)[0] as number;
    }
    try {
      const first = await start();
      expect(await send(first, invocation("close", h.workspaceId, 9))).toBe(200);
      const exited = once(first, "exit");
      first.kill("SIGKILL");
      await exited;
      const before = await diskSnapshot(h.root);
      const restarted = await start();
      expect(await send(restarted, invocation("task", h.workspaceId, 8))).toBe(409);
      expect(await diskSnapshot(h.root)).toEqual(before);
      expect(await send(restarted, invocation("task", h.workspaceId, 9))).toBe(200);
      expect(await readFile(h.writes, "utf8")).toBe("late bytes");
    } finally {
      await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map(async (child) => {
        const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      }));
    }
  });
});
