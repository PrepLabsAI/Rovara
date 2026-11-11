// TEST SUPPORT. The hosted product serves the registered-server operations as HTTP routes; Code serves them on the owner's local page. These tests drive the same operations through this route-shaped
// adapter, so the operations keep the cases they were written against. The routes behind "MCP servers" (owner or admin only):
//   GET    /v1/app/org/mcp-servers                    every server, with what it offers
//   POST   /v1/app/org/mcp-servers                    add one: paste an address (or a stdio package); Rovara tests it and shows what it offers (nothing is allowed yet)
//   POST   /v1/app/org/mcp-servers/{id}/approve       approve it, which adds it to the allow-list
//   POST   /v1/app/org/mcp-servers/{id}/disable       take it out of the allow-list
//   POST   /v1/app/org/mcp-servers/{id}/review        a paused server (its tools changed): what it offers now against what was approved. Changes nothing
//   POST   /v1/app/org/mcp-servers/{id}/reapprove     approve the tools shown by `review` ({toolsHash}): one click; the pinned install is unchanged
//   DELETE /v1/app/org/mcp-servers/{id}               remove a disabled or waiting entry
import { z } from "zod";
import { agentXError } from "@agentx/contracts";
import { drainControllerEvents, serverActivities } from "../../packages/broker/src/context-sources/controller-events.js";

export interface AgentCaller { orgId: string; developerId: string; orgRole: string }
export interface AdaptedHttpRequest { method: string; path: string; headers: Record<string, string>; requestId: string; body?: string }
export class StatusReply { constructor(readonly statusCode: number, readonly body: object) {} }
import { approveMcpServer, disableMcpServer, listMcpServers, proposeMcpServer, reapprovePausedMcpServer, removeMcpServer, reviewPausedMcpServer, stdioAvailable, type McpServerDependencies } from "../../packages/broker/src/context-sources/mcp-servers.js";

export const MCP_SERVERS_PATH = /^\/v1\/app\/org\/mcp-servers(?:\/(mcp[a-z0-9]{6,24})(?:\/(approve|disable|review|reapprove))?)?$/;

/** Nothing about where a token is stored leaves the broker: only that the server has one. */
function withoutSecretVersion<T extends { secretVersion?: string | undefined }>(entry: T): Omit<T, "secretVersion"> {
  const { secretVersion: _version, ...rest } = entry;
  void _version;
  return rest;
}

const notThere = () => agentXError("NOT_FOUND", "route not found");

const ReapproveBodySchema = z.object({ toolsHash: z.string().max(100) }).strict();
const AddBodySchema = z.object({ label: z.string().max(200), transport: z.unknown(), secret: z.string().min(1).max(4_096).optional(), secrets: z.record(z.string().max(64), z.string().max(4_096)).optional() }).strict();

function jsonBody(request: AdaptedHttpRequest): unknown {
  if (request.body === undefined || request.body === "") return {};
  try { return JSON.parse(request.body) as unknown; } catch { throw agentXError("CONFIG_INVALID", "the request body is not JSON"); }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the tests still pass the address the hosted routes were given; the path is read from the request
export async function routeMcpServers(deps: McpServerDependencies, caller: AgentCaller, request: AdaptedHttpRequest, ..._ignored: unknown[]): Promise<unknown> {
  const match = MCP_SERVERS_PATH.exec(request.path.split("?")[0] ?? request.path);
  if (match === null) throw notThere();
  const actor = { orgId: caller.orgId, developerId: caller.developerId, orgRole: caller.orgRole };
  const [, serverId, action] = match;
  if (serverId === undefined) {
    if (request.method === "GET") {
      const servers = await listMcpServers(deps, actor);
      // The controller's events: new ones are recorded and applied first (bounded, never throws), then the newest are summarised for the card. No controller, no activity.
      let activity: ReturnType<typeof serverActivities> = {};
      if (deps.controllerEvents !== undefined && servers.some((server) => server.transport.kind === "stdio")) {
        await drainControllerEvents({ events: deps.controllerEvents.store, servers: deps.store, audit: deps.controllerEvents.audit, now: deps.now }, actor.orgId);
        activity = serverActivities(await deps.controllerEvents.store.recent(actor.orgId, 200).catch(() => []), deps.now());
      }
      const listed = (await listMcpServers(deps, actor)).map(withoutSecretVersion);
      return { servers: listed, stdioAvailable: stdioAvailable(deps), ...(Object.keys(activity).length === 0 ? {} : { activity }) };
    }
    if (request.method !== "POST") throw notThere();
    const parsed = AddBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // A field the caller made up is not repeated back: a body can carry a token by mistake.
      throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue?.code === "unrecognized_keys" ? "has a field this route does not take" : issue?.message ?? "is not valid"}`);
    }
    const entry = await proposeMcpServer(deps, actor, parsed.data);
    return new StatusReply(202, { status: "NEEDS_APPROVAL", server: withoutSecretVersion(entry) });
  }
  if (action === undefined) {
    if (request.method !== "DELETE") throw notThere();
    await removeMcpServer(deps, actor, serverId);
    return { status: "REMOVED" };
  }
  if (request.method !== "POST") throw notThere();
  if (action === "review") { const reviewed = await reviewPausedMcpServer(deps, actor, serverId); return { server: withoutSecretVersion(reviewed.server), offers: reviewed.offers, toolsHash: reviewed.toolsHash, diff: reviewed.diff }; }
  if (action === "reapprove") {
    const parsed = ReapproveBodySchema.safeParse(jsonBody(request));
    if (!parsed.success) throw agentXError("CONFIG_INVALID", "toolsHash: name the tools you were shown");
    return { server: withoutSecretVersion(await reapprovePausedMcpServer(deps, actor, serverId, parsed.data.toolsHash)) };
  }
  if (action === "approve") return { server: withoutSecretVersion(await approveMcpServer(deps, actor, serverId)) };
  await disableMcpServer(deps, actor, serverId);
  return { status: "DISABLED" };
}
