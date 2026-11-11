// What the owner's page does with context sources and registered MCP servers, as plain operations over `settings.ts` and `mcp-servers.ts`. The page (core/local-pages) is the only caller:
// adding a source, ticking a tool and approving a server are the owner's acts on a page they opened (decision 66), so no route a token can reach calls these. Reads for tools are separate.
//
// A body is never echoed back in an error: it can carry a secret by mistake.
import { z } from "zod";
import { ContextSourceServerSchema, agentXError, type ContextSourcesDocument, type OrgId } from "@agentx/contracts";
import { drainControllerEvents, serverActivities, type ServerActivity } from "./controller-events.js";
import { listMcpServers, stdioAvailable, type McpServerDependencies } from "./mcp-servers.js";
import { annotationVerdict, confirmSourceChange, nameSuggestsWrite, proposeSourceChange, readContextSources, rejectSourceChange, toolSchemaHash, type ContextSourceChange, type SettingsActor, type SettingsDependencies } from "./settings.js";

export interface ContextSourceOwnerDependencies extends SettingsDependencies {
  /** Called before every listing of a server's tools (a call out to the server); false refuses it. Counted in this process (the style of `probeLimiter`). Absent: no limit. */
  discoverAllowed?: ((orgId: OrgId) => boolean) | undefined;
}

const DiscoverBodySchema = z.object({ server: ContextSourceServerSchema }).strict();
const ChangeBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), source: z.unknown() }).strict(),
  z.object({ kind: z.literal("remove"), sourceId: z.string().min(1).max(32) }).strict(),
]);

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw agentXError("CONFIG_INVALID", `${issue === undefined || issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue?.code === "unrecognized_keys" ? "has a field this form does not take" : issue?.message ?? "is not valid"}`);
}

/** Whether a tool's input schema takes an address: such a tool is only used with an address on the source's own host (routes.ts). */
export function schemaTakesAddress(schema: Record<string, unknown>): boolean {
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null) return false;
  return Object.entries(properties as Record<string, unknown>).some(([name, value]) => {
    const format = typeof value === "object" && value !== null ? (value as { format?: unknown }).format : undefined;
    return format === "uri" || format === "url" || /(^|_|-)(url|uri|href|link|endpoint|webhook)s?($|_|-)/iu.test(name);
  });
}

/** A project's sources and the changes waiting. */
export function sourcesOf(deps: ContextSourceOwnerDependencies, actor: SettingsActor, project: string): Promise<{ document: ContextSourcesDocument; pending: ContextSourceChange[] }> {
  return readContextSources(deps, actor, project);
}

export interface DiscoveredToolView { name: string; description: string; schemaHash: string; annotation: ReturnType<typeof annotationVerdict>; nameSuggestsChange: boolean; takesAddress: boolean }

/** The tools a connection or an approved server offers, with what Rovara checks on each (for the owner to tick). */
export async function discoverSourceTools(deps: ContextSourceOwnerDependencies, actor: SettingsActor, body: unknown): Promise<DiscoveredToolView[]> {
  const parsed = parse(DiscoverBodySchema, body);
  if (deps.discoverAllowed !== undefined && !deps.discoverAllowed(actor.orgId)) throw agentXError("TOO_MANY_REQUESTS", "Too many tool listings just now. Wait a few minutes and try again.");
  let tools;
  try { tools = await deps.env.discoverTools(actor.orgId, parsed.server); } catch { throw agentXError("RUNTIME_UNAVAILABLE", "Rovara could not list that server's tools right now; try again"); }
  return tools.slice(0, 200).map((tool) => ({
    name: tool.name, description: (tool.description ?? "").slice(0, 300), schemaHash: toolSchemaHash(tool), annotation: annotationVerdict(tool),
    nameSuggestsChange: nameSuggestsWrite(tool.name), takesAddress: schemaTakesAddress(tool.inputSchema),
  }));
}

/** Proposes adding, changing or removing a source. Nothing is applied until it is confirmed. */
export function proposeSource(deps: ContextSourceOwnerDependencies, actor: SettingsActor, project: string, body: unknown): Promise<ContextSourceChange> {
  return proposeSourceChange(deps, actor, project, parse(ChangeBodySchema, body));
}

export const confirmSource = confirmSourceChange;
export const rejectSource = rejectSourceChange;

/** Nothing about where a token is stored leaves the broker: only that the server has one. */
function withoutSecretVersion<T extends { secretVersion?: string | undefined }>(entry: T): Omit<T, "secretVersion"> {
  const { secretVersion: _version, ...rest } = entry;
  void _version;
  return rest;
}

/** Every registered server, what it offers, and (where a host runs package servers) what the host did lately. */
export async function serversOf(deps: McpServerDependencies, actor: { orgId: OrgId; developerId: string; orgRole: string }): Promise<{ servers: Array<ReturnType<typeof withoutSecretVersion<Awaited<ReturnType<typeof listMcpServers>>[number]>>>; stdioAvailable: boolean; activity: Record<string, ServerActivity> }> {
  const servers = await listMcpServers(deps, actor);
  // The host's events: new ones are recorded and applied first (bounded, never throws), then the newest are summarised for the card. No host, no activity.
  let activity: Record<string, ServerActivity> = {};
  if (deps.controllerEvents !== undefined && servers.some((server) => server.transport.kind === "stdio")) {
    await drainControllerEvents({ events: deps.controllerEvents.store, servers: deps.store, audit: deps.controllerEvents.audit, now: deps.now }, actor.orgId);
    activity = serverActivities(await deps.controllerEvents.store.recent(actor.orgId, 200).catch(() => []), deps.now());
  }
  return { servers: (await listMcpServers(deps, actor)).map(withoutSecretVersion), stdioAvailable: stdioAvailable(deps), activity };
}
