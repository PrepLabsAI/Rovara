// Spec 025 FR-026: `agentx mcp`, a stdio MCP server for the developer signed in on this computer.
// stdout carries only MCP messages; logs go to stderr and never hold a token.
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { AdminMeResponse } from "@agentx/contracts";
import {
  ADMIN_AUDIT_TOOLS, ADMIN_CHANGE_TOOLS, ADMIN_READ_TOOLS, NEXT_STEPS, NOT_OFFERED, REQUIRED_CHANGE_ADMIN_MINOR, UPGRADE_AGENTX_STEP, ToolError, adminApiFits,
  compatibilityChecker, createAgentXMcpServer, httpAdminClient, httpControlPlaneClient, type AdminOffer, type AdminSession, type ControlPlaneClient,
} from "@agentx/mcp";
import { developerAccessToken, type DeveloperSessionDeps } from "../developer/session.js";
import { CLI_VERSION } from "../version.js";

export interface McpServeDeps extends DeveloperSessionDeps {
  env?: string;
  adminSignedIn(env: string | undefined): Promise<boolean>;
  /** Spec 025 A14: this computer's unexpired admin sign-in for the environment, or undefined. Never refreshed (Q4). */
  adminSession(env: string | undefined): Promise<AdminSession | undefined>;
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
  // A14: the admin sign-in as stored; an absent or expired one is ADMIN_REQUIRED, never refreshed (Q4).
  const admin = httpAdminClient({
    fetch: deps.fetch,
    session: async () => {
      const session = await deps.adminSession(deps.env);
      if (session === undefined) throw NOT_OFFERED;
      return session;
    },
  });
  // A15 and A1: the admin read tools are offered with an unexpired admin sign-in and an admin API
  // that fits: undefined, or why not. The checker's 10-minute cache holds, so the 30-second check
  // does not read the configuration each time.
  const readsOffer = async (): Promise<ToolError | undefined> => {
    if ((await deps.adminSession(deps.env)) === undefined) return NOT_OFFERED;
    let adminApiVersion: string | undefined;
    try {
      ({ adminApiVersion } = await compatibility());
    } catch (error) {
      // The check needs the developer sign-in: its own answer (SIGN_IN_REQUIRED) says what to do.
      if (error instanceof ToolError) return error;
      throw error;
    }
    const fit = adminApiFits(adminApiVersion);
    if (fit !== "fits") return new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin tools for this CLI yet", fit === "incompatible" ? NEXT_STEPS.UPGRADE_REQUIRED : UPGRADE_AGENTX_STEP);
    return undefined;
  };
  let me: { at: number; value: Promise<AdminMeResponse | undefined> } | undefined;
  /** The admin's Slack link, read at most once a minute (FR-041's "whether the signed-in admin has a Slack link"). */
  const adminMe = (): Promise<AdminMeResponse | undefined> => {
    if (me === undefined || now() - me.at > 60_000) me = { at: now(), value: admin.me().catch(() => undefined) };
    return me.value;
  };
  /** FR-041: the methods the environment allows and this admin can use; the server adds the client's pop-up. */
  const confirmation = async (): Promise<{ elicitation: boolean; slack: boolean }> => {
    const confirm = (await compatibility()).confirm ?? { elicitation: false, slack: false };
    return { elicitation: confirm.elicitation, slack: confirm.slack && (await adminMe())?.slack.linked === true };
  };
  // Spec 025 FR-028, FR-041, Q11: agentx_admin_changes needs admin API 1.1; the change tools also
  // need a confirmation method this session has.
  const adminOffer = async (client: { elicitation: boolean }): Promise<AdminOffer> => {
    const reads = await readsOffer();
    if (reads !== undefined) return { admin: reads, audit: reads, changes: reads };
    if (adminApiFits((await compatibility()).adminApiVersion, REQUIRED_CHANGE_ADMIN_MINOR) !== "fits") {
      const upgrade = new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin change tools yet", UPGRADE_AGENTX_STEP);
      return { admin: undefined, audit: upgrade, changes: upgrade };
    }
    const methods = await confirmation();
    const any = (client.elicitation && methods.elicitation) || methods.slack;
    return { admin: undefined, audit: undefined, changes: any ? undefined : new ToolError("CONFIRMATION_UNAVAILABLE", "no confirmation method is available in this session") };
  };
  return createAgentXMcpServer({
    version: CLI_VERSION,
    log,
    adminTools: ADMIN_READ_TOOLS,
    auditTools: ADMIN_AUDIT_TOOLS,
    changeTools: ADMIN_CHANGE_TOOLS,
    adminOffer,
    context: (clientName, clientVersion) => ({
      client,
      clientName,
      ...(clientVersion === undefined ? {} : { clientVersion }),
      confirmation,
      serverVersion: CLI_VERSION,
      adminSignedIn: () => deps.adminSignedIn(deps.env),
      compatibility,
      admin,
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
