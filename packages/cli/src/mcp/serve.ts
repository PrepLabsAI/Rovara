// Spec 025 FR-026: `agentx mcp`, a stdio MCP server for the developer signed in on this computer.
// stdout carries only MCP messages; logs go to stderr and never hold a token.
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { compatibilityChecker, createAgentXMcpServer, httpControlPlaneClient, type ControlPlaneClient } from "@agentx/mcp";
import { developerAccessToken, type DeveloperSessionDeps } from "../developer/session.js";
import { CLI_VERSION } from "../version.js";

export interface McpServeDeps extends DeveloperSessionDeps {
  env?: string;
  adminSignedIn(env: string | undefined): Promise<boolean>;
  stderr: { write(text: string): unknown };
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
}

/** Resolves after `ms`, or at once when the tool call is cancelled. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Each call reads the developer's current tokens, refreshing under 25a's lock (R19 of 25a). `force`
 * (AgentX refused the last access token) asks for a refresh even of a token that looks valid.
 */
export function developerControlPlaneClient(deps: McpServeDeps): ControlPlaneClient {
  return httpControlPlaneClient({
    fetch: deps.fetch,
    session: async (options) => {
      const session = await developerAccessToken(deps, deps.env, { force: options?.force === true });
      return { baseUrl: session.entry.url, accessToken: session.accessToken, signInCommand: `npx @charterarc/agentx login ${session.entry.url}` };
    },
  });
}

/** One log line on stderr, as JSON. Callers pass codes and names only, never a message or a token. */
function stderrLog(deps: Pick<McpServeDeps, "stderr">) {
  return (entry: Record<string, unknown>) => {
    deps.stderr.write(`${JSON.stringify({ component: "agentx-mcp", ...entry })}\n`);
  };
}

export function agentxMcpServer(deps: McpServeDeps): McpServer {
  const client = developerControlPlaneClient(deps);
  const now = (): number => (deps.clock === undefined ? Date.now() : deps.clock.now());
  // One checker for the server's life, outside the per-call context, so its 10-minute cache holds.
  const compatibility = compatibilityChecker(client, { now });
  const log = stderrLog(deps);
  return createAgentXMcpServer({
    version: CLI_VERSION,
    log,
    context: (clientName) => ({
      client,
      clientName,
      serverVersion: CLI_VERSION,
      adminSignedIn: () => deps.adminSignedIn(deps.env),
      compatibility,
      now,
      sleep: (ms: number, signal: AbortSignal) => (deps.clock === undefined ? abortableSleep(ms, signal) : deps.clock.sleep(ms, signal)),
      newRequestId: randomUUID,
    }),
  });
}

/**
 * Serves MCP on stdin and stdout until the client closes stdin, stdout breaks, or `shutdown` fires
 * (SIGTERM). Closing the server cancels any tool call still running, so a wait ends at once.
 */
export async function runMcpServer(deps: McpServeDeps & { stdin: Readable; stdout: Writable; shutdown?: AbortSignal }): Promise<void> {
  const log = stderrLog(deps);
  const server = agentxMcpServer(deps);
  // The error's name only: a parse error's message can quote what the client sent.
  server.server.onerror = (error) => log({ event: "protocol.error", error: error.name });
  const transport = new StdioServerTransport(deps.stdin, deps.stdout);
  let finish: (reason: string) => void = () => undefined;
  const closed = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const onEnd = () => finish("stdin closed");
  const onStdoutError = () => finish("stdout closed");
  const onShutdown = () => finish("shutdown");
  transport.onclose = () => finish("transport closed");
  deps.stdin.once("end", onEnd);
  deps.stdout.on("error", onStdoutError);
  if (deps.shutdown?.aborted === true) onShutdown();
  deps.shutdown?.addEventListener("abort", onShutdown, { once: true });
  try {
    await server.connect(transport);
    log({ event: "server.started", version: CLI_VERSION });
    const reason = await closed;
    log({ event: "server.stopping", reason });
    await server.close();
  } finally {
    deps.stdin.off("end", onEnd);
    deps.stdout.off("error", onStdoutError);
    deps.shutdown?.removeEventListener("abort", onShutdown);
  }
}
