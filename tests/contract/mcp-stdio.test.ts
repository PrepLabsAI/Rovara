// Spec 025 FR-026: the built CLI's `agentx mcp`, spoken to over real stdio. stdout carries only MCP
// messages, at startup, on errors and at shutdown; logs go to stderr; no token appears in either.
// It needs the built CLI (npm run build, or typecheck, which also emits it).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { developerTokenKey, saveDeveloperEnvironment } from "../../packages/cli/src/developer/config.js";
import { toolError } from "./../support/mcp-tool-error.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(repoRoot, "packages", "cli", "dist", "main.js");
const ACCESS_TOKEN = `agxa_fake_${"b".repeat(40)}`;
const REFRESH_TOKEN = `agxr_fake_${"c".repeat(40)}`;
const TASK_ID = "7b0c1a52-5d6e-4f8a-9b1c-2d3e4f5a6b7c";
const DEVELOPER = { id: "d".repeat(64), name: "Maya Chen", provider: "slack", slackUserId: "U0MAYA001" };

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing; run npm run build first`);
});

interface FakeControlPlane { url: string; issuer: string; requests: Array<{ method: string; path: string; authorization: string | undefined }>; close(): Promise<void> }

/** AgentX on a loopback port: the configuration, the developer's projects, and one STARTING task. */
async function fakeControlPlane(): Promise<FakeControlPlane> {
  const requests: FakeControlPlane["requests"] = [];
  const server: Server = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method ?? "GET", path: url.pathname, authorization: request.headers.authorization });
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/v1/auth/.well-known/agentx-configuration") return send(200, { env: "staging", apiVersion: "1.2" });
    if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) return send(401, { error: { code: "AUTH_REQUIRED", message: "sign in again" } });
    if (url.pathname === "/v1/dev/projects") return send(200, { developer: DEVELOPER, projects: [], notices: [] });
    if (url.pathname === `/v1/dev/tasks/${TASK_ID}`) {
      const at = new Date().toISOString();
      return send(200, { task: { taskId: TASK_ID, title: "long", project: "payments", status: "STARTING", startingRevision: 1, client: "Claude Code", shared: false, createdAt: at, updatedAt: at, events: [] } });
    }
    return send(404, { error: { code: "NOT_FOUND", message: "no such route" } });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, issuer: `${url}/v1/auth`, requests,
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}

/**
 * A home signed in to the fake control plane. The system token store is macOS `security` or Linux
 * `secret-tool`; a stand-in for both, first on PATH, answers the planted developer token, so the
 * real keychain is never read.
 */
async function signedInHome(plane: FakeControlPlane): Promise<{ home: string; path: string }> {
  const home = await mkdtemp(join(tmpdir(), "agentx-mcp-stdio-"));
  await saveDeveloperEnvironment(home, "staging", { url: plane.url, issuer: plane.issuer, tokenEndpoint: `${plane.issuer}/token`, revocationEndpoint: `${plane.issuer}/revoke` });
  const tokens = JSON.stringify({ accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN, expiresAt: Date.now() + 3_600_000 });
  const bin = join(home, "fake-bin");
  await mkdir(bin);
  // `security find-generic-password -s <service> -a <key> -w` and `secret-tool lookup service <service> account <key>`: the key is $5.
  const script = [
    "#!/bin/sh",
    'case "$1" in find-generic-password|lookup) ;; *) exit 0 ;; esac',
    `if [ "$5" = '${developerTokenKey(plane.issuer)}' ]; then printf '%s\\n' '${tokens}'; exit 0; fi`,
    'if [ "$1" = lookup ]; then exit 1; fi',
    "exit 44",
    "",
  ].join("\n");
  for (const name of ["security", "secret-tool"]) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  return { home, path: `${bin}:${process.env.PATH ?? ""}` };
}

interface Message { jsonrpc?: unknown; id?: unknown; result?: Record<string, unknown>; error?: unknown; method?: unknown }

/** `node packages/cli/dist/main.js mcp`, with raw stdout kept so every byte on it can be checked. */
function spawnMcp(home: string, path: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI, "mcp"], { env: { HOME: home, PATH: path, TMPDIR: tmpdir() }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let pending = "";
  const waiting = new Map<number, (message: Message) => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    pending += chunk;
    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        continue; // expectOnlyProtocol reports it.
      }
      if (typeof message.id === "number") waiting.get(message.id)?.(message);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once("exit", (code, signal) => done({ code, signal })));
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<Message> => {
    const id = nextId++;
    const answered = new Promise<Message>((done) => waiting.set(id, done));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return answered;
  };
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const initialize = async () => {
    const answer = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.0" } });
    notify("notifications/initialized");
    return answer;
  };
  const callTool = async (name: string, args: Record<string, unknown> = {}) => (await request("tools/call", { name, arguments: args })).result ?? {};
  /** FR-026: every line on stdout is a JSON-RPC 2.0 message, and nothing follows the last one. */
  const expectOnlyProtocol = () => {
    expect(stdout.endsWith("\n")).toBe(true);
    for (const line of stdout.slice(0, -1).split("\n")) {
      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        throw new Error(`stdout carried a line that is not an MCP message: ${line}`);
      }
      expect(message.jsonrpc).toBe("2.0");
    }
  };
  const expectNoToken = () => {
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN]) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
  };
  return { child, request, notify, initialize, callTool, exited, expectOnlyProtocol, expectNoToken, stdout: () => stdout, stderr: () => stderr };
}

const planes: FakeControlPlane[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(planes.splice(0).map((plane) => plane.close()));
});

describe("agentx mcp over stdio (FR-026)", () => {
  it("speaks only MCP on stdout, lists the tools, and answers SIGN_IN_REQUIRED when not signed in", async () => {
    const home = await mkdtemp(join(tmpdir(), "agentx-mcp-stdio-"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: { HOME: home, PATH: process.env.PATH ?? "" }, stderr: "pipe" });
    const errors: unknown[] = [];
    const client = new Client({ name: "claude-code", version: "2.1.0" });
    client.onerror = (error) => errors.push(error);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(15);
      // Ruling F3: the tools were listed first, and the error result still passes the SDK's checks.
      const result = await client.callTool({ name: "agentx_whoami", arguments: {} });
      expect(toolError(result)).toMatchObject({ code: "SIGN_IN_REQUIRED", next_step: "run npx @preplabsai/rovara-code login <your AgentX URL>" });
      // The server did not crash: it answers the next call too.
      expect(toolError(await client.callTool({ name: "agentx_list_projects", arguments: {} }))).toMatchObject({ code: "SIGN_IN_REQUIRED" });
      // Anything on stdout that is not an MCP message would surface here as a client error.
      expect(errors).toEqual([]);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("works signed in against AgentX on a loopback port, keeps stdout to MCP and never shows the token", async () => {
    const plane = await fakeControlPlane();
    planes.push(plane);
    const { home, path } = await signedInHome(plane);
    const mcp = spawnMcp(home, path);
    children.push(mcp.child);

    const initialized = await mcp.initialize();
    expect(initialized.result).toMatchObject({ serverInfo: { name: "agentx" } });
    expect(((await mcp.request("tools/list")).result?.tools as unknown[]).length).toBe(15);

    const whoami = await mcp.callTool("agentx_whoami");
    expect(whoami.isError).not.toBe(true);
    expect(whoami.structuredContent).toMatchObject({ environment: "staging", developer_name: "Maya Chen", sign_in_method: "slack", admin: false, control_plane_api_version: "1.2" });
    expect(plane.requests.filter((entry) => entry.path === "/v1/dev/projects")).toEqual([{ method: "GET", path: "/v1/dev/projects", authorization: `Bearer ${ACCESS_TOKEN}` }]);

    // An error AgentX answers, and a line that is not JSON, both leave stdout clean and the server up.
    const missing = await mcp.callTool("agentx_get_task", { task_id: "00000000-0000-4000-8000-000000000000" });
    expect(missing.isError).toBe(true);
    expect(missing).not.toHaveProperty("structuredContent");
    mcp.child.stdin.write("this is not json\n");
    expect((await mcp.callTool("agentx_list_projects")).structuredContent).toMatchObject({ projects: [] });

    mcp.child.stdin.end();
    expect(await mcp.exited).toEqual({ code: 0, signal: null });
    mcp.expectOnlyProtocol();
    mcp.expectNoToken();
    // Logs go to stderr, as JSON lines.
    expect(mcp.stderr()).toContain('"component":"agentx-mcp"');
    expect(mcp.stderr()).toContain('"event":"server.stopping","reason":"stdin closed"');
  }, 30_000);

  it("shuts down cleanly on SIGTERM, even during a long wait", async () => {
    const plane = await fakeControlPlane();
    planes.push(plane);
    const { home, path } = await signedInHome(plane);
    const mcp = spawnMcp(home, path);
    children.push(mcp.child);
    await mcp.initialize();

    const waiting = mcp.request("tools/call", { name: "agentx_wait_for_task", arguments: { task_id: TASK_ID, wait_seconds: 600 } });
    // The wait has started once AgentX has been asked about the task.
    for (let tries = 0; !plane.requests.some((entry) => entry.path === `/v1/dev/tasks/${TASK_ID}`); tries += 1) {
      if (tries > 200) throw new Error("the wait never asked AgentX about the task");
      await new Promise((done) => setTimeout(done, 25));
    }
    const started = Date.now();
    mcp.child.kill("SIGTERM");
    expect(await mcp.exited).toEqual({ code: 0, signal: null });
    expect(Date.now() - started).toBeLessThan(5_000);
    void waiting;
    mcp.expectOnlyProtocol();
    mcp.expectNoToken();
    expect(mcp.stderr()).toContain('"reason":"shutdown"');
  }, 30_000);
});
