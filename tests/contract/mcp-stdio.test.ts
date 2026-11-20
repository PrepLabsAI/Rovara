// Spec 025 FR-026: the built CLI's `agentx mcp`, spoken to over real stdio. stdout carries only MCP
// messages, at startup, on errors and at shutdown; logs go to stderr; no token appears in either.
// It needs the built CLI (npm run build, or typecheck, which also emits it).
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { toolError as parseToolError } from "./../support/mcp-tool-error.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(repoRoot, "packages", "cli", "dist", "main.js");

function toolError(result: Awaited<ReturnType<Client["callTool"]>>) {
  return parseToolError(CallToolResultSchema.parse(result));
}

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing; run npm run build first`);
});

interface FakeControlPlane { url: string; issuer: string; requests: Array<{ method: string; path: string; authorization: string | undefined }>; close(): Promise<void> }

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
      expect(tools).toHaveLength(52); // Batch b18 (rule D): + team_propose (#1034).
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

});
