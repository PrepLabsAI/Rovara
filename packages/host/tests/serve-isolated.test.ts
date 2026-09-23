import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { startIsolatedHost, type IsolatedHostConfig } from "../src/serve-isolated.js";
import { IsolatedFixtureRuntime, resolveIsolatedRuntimeConfig } from "../src/isolated/runtime.js";
import { readTarEntries } from "../src/isolated/tar.js";

const run = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function source(): Promise<string> {
  const root = await scratch("agentx-serve-source-");
  await run("git", ["-C", root, "init", "--quiet", "--initial-branch=main"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src/tasks.py"), "def visible(tasks):\n    return tasks\n");
  await run("git", ["-C", root, "add", "."]);
  await run("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=f@example.test", "commit", "-qm", "base"]);
  return root;
}

function config(state: string, sourceRepository: string): IsolatedHostConfig {
  return {
    stateDirectory: state,
    sourceRepository,
    project: { name: "charterarc-local", repositoryName: "app", repositoryUrl: "https://git.invalid/s/app.git", defaultBranch: "main" },
    workspaceId: "4f1c2b8e-6d3a-4e5f-9a7b-0c1d2e3f4a5b",
    conversationId: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
    fixture: { mode: "correct", edits: [{ path: "src/tasks.py", correct: "x\n", defective: "y\n" }] },
    route: {
      routeVersion: "mock-fixture@v1", policyDigest: `sha256:${"b".repeat(64)}`, dataClass: "synthetic-fixture",
      modelAllowlist: ["mock/deterministic-v1"], priceVersion: "fixture-prices@2026-09-22",
      microunitsPerInputByte: 2, microunitsPerOutputByte: 8, outputCapBytes: 1024,
    },
    budget: { maxMicrounits: 1_000_000, maxCalls: 4, ttlMs: 600_000 },
    // No container is created by these tests: nothing is drained.
    runtime: { docker: "/nonexistent/docker" },
  };
}

function call(url: string, ca: string, method: string, path: string, bearer?: string, body?: unknown) {
  const target = new URL(path, url);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const outgoing = httpsRequest({
      method, host: target.hostname, port: target.port, path: target.pathname, ca, servername: "127.0.0.1",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    outgoing.once("error", reject);
    if (body !== undefined) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

describe("isolated host process entry", () => {
  it("serves only authenticated callers over process-scoped TLS and reopens the same state", async () => {
    const state = await scratch("agentx-serve-state-");
    const repo = await source();
    const first = await startIsolatedHost(config(state, repo));
    const ca = await readFile(first.certificatePath, "utf8");
    const bearer = (await readFile(first.bearerPath, "utf8")).trim();
    try {
      expect(first.url.startsWith("https://127.0.0.1:")).toBe(true);
      expect((await stat(first.bearerPath)).mode & 0o077).toBe(0);
      const refused = await call(first.url, ca, "GET", `/v1/workspaces/${first.workspaceId}/requests/${randomUUID()}`);
      expect(refused.status).toBe(401);
      const forged = await call(first.url, ca, "GET", `/v1/workspaces/${first.workspaceId}/requests/${randomUUID()}`, "0".repeat(64));
      expect(forged.status).toBe(401);
      const accepted = await call(first.url, ca, "POST", `/v1/workspaces/${first.workspaceId}/tasks`, bearer, {
        requestId: randomUUID(), conversationId: first.conversationId, prompt: "line one\n\n  line two\r\n",
        candidate: { jobId: randomUUID(), attempt: 1, repository: "app", baseCommit: first.baseCommit },
      });
      expect(accepted.status).toBe(202);
      expect(first.operations.pendingOutbox()).toHaveLength(1);
      expect(first.operations.pendingOutbox()[0]!.invocation.payload.prompt).toBe("line one\n\n  line two\r\n");
    } finally {
      await first.close();
    }

    // Same state directory: same bearer, same workspace, the queued work still there.
    const second = await startIsolatedHost(config(state, repo));
    try {
      expect((await readFile(second.bearerPath, "utf8")).trim()).toBe(bearer);
      expect(second.workspaceId).toBe(first.workspaceId);
      expect(second.baseCommit).toBe(first.baseCommit);
      expect(second.operations.pendingOutbox()).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});

describe("isolated host ownership", () => {
  it("refuses a second live host on the same state directory", async () => {
    const state = await scratch("agentx-serve-lock-");
    const repo = await source();
    const first = await startIsolatedHost(config(state, repo));
    try {
      await expect(startIsolatedHost(config(state, repo))).rejects.toThrow(/owns this state directory/);
    } finally {
      await first.close();
    }
    const again = await startIsolatedHost(config(state, repo));
    await again.close();
  });
});

describe("isolated payload", () => {
  it("REGRESSION never carries host AppleDouble metadata into the worker workspace", async () => {
    const workspace = await scratch("agentx-payload-ws-");
    await mkdir(join(workspace, "repo/app"), { recursive: true });
    const file = join(workspace, "repo/app/tasks.py");
    await writeFile(file, "x\n");
    // An extended attribute is what makes macOS tar emit a `._tasks.py` member.
    await run("xattr", ["-w", "com.charterarc.test", "1", file]).catch(() => undefined);
    const staging = await scratch("agentx-payload-stage-");
    await writeFile(join(staging, "invocation.json"), "{}");
    await writeFile(join(staging, "edits.json"), "[]");
    const runtime = new IsolatedFixtureRuntime(resolveIsolatedRuntimeConfig({}));
    const payload = await (runtime as unknown as {
      buildPayload(staging: string, workspace: string): Promise<Buffer>;
    }).buildPayload(staging, workspace);
    const names = [...readTarEntries(payload).keys()];
    expect(names.some((name) => name.endsWith("tasks.py"))).toBe(true);
    expect(names.filter((name) => name.split("/").some((part) => part.startsWith("._")))).toEqual([]);
  });
});
