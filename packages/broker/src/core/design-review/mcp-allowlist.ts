// Design review stage: which MCP items may go into a reviewer packet, and the call that fetches each one.
//
// Section 8 of a design is written by the planner (a model, with untrusted text in front of it). It can NAME an item; it can never choose the tool or the arguments that fetch it, and it can never
// bring people's chat into a packet. The call is derived here, in code, from the project's own list of configured read-only context sources (the same list the context-tools route checks):
//   - the source must exist and be allowed for the PLAN_CRITIQUE stage;
//   - it must not be a chat or messaging system (Slack, Teams, Discord and the like), and its tool must not be a thread, channel, history, conversation or message tool: the task's Slack thread and
//     people's messages are never in a packet;
//   - it must not be the task's own request thread (the issue the task came from, and its comments): that is the planner's conversation by another door;
//   - the tool is one the admin ticked with the `read` role (a lookup of one item), never `search` or `status`;
//   - the arguments are built by code from the item ref alone.
// The route then applies its own checks again (stage permission, the ticked tool, argument rules, the stage's allowance) when the call is made.
import { ContextSourceIdSchema, type ContextSource, type ContextSourceTool } from "@agentx/contracts";
import { presentedToolName } from "../../context-sources/present.js";

/** Systems whose items are people talking to each other. A packet never carries them, whatever the admin ticked. Matched against `ContextSource.system`. */
export const PACKET_CHAT_SYSTEMS: readonly string[] = ["slack", "teams", "msteams", "discord", "mattermost", "zulip", "chat", "gchat", "googlechat", "telegram", "whatsapp", "irc", "matrix", "intercom", "zendesk"];
/** A tool whose name says it reads a conversation. Refused even on a source that is not marked as a chat system. */
const CHAT_TOOL_NAME = /(thread|conversation|channel|history|message|chat|mention|inbox)/iu;
/** A source label or id that says the same (a source with no `system` set). */
const CHAT_SOURCE_NAME = /(slack|discord|mattermost)/iu;

export const PACKET_MCP_REFUSALS = ["not_allowed", "conversation"] as const;
export type PacketMcpRefusal = (typeof PACKET_MCP_REFUSALS)[number];

export type PacketMcpCall = { ok: true; sourceId: string; tool: string; arguments: Record<string, unknown> } | { ok: false; reason: PacketMcpRefusal };

/** An item of the task's own origin thread: the Linear, Jira or GitHub issue the task came from. It is named by its source and ref; its comments are refs that continue it (`ABC-1#c5`, `org/repo#12/comments/3`). */
export interface PacketOriginItem { sourceId: string; itemRef: string }

const foldRef = (value: string): string => value.normalize("NFKC").trim().toLowerCase();

/**
 * Whether `ref` is the task's own request thread or one of its parts: the same source and the same item, or an item whose ref CONTINUES the origin's after a non-alphanumeric character (a comment, an
 * anchor, a sub-path). `ABC-12` does not continue `ABC-1`. The comparison is folded (NFKC, case, spaces), and a ref that cannot be told apart is refused, never allowed.
 */
export function isOriginItem(origin: readonly PacketOriginItem[] | undefined, ref: { sourceId: string; itemRef: string }): boolean {
  if (origin === undefined) return false;
  const sourceId = foldRef(ref.sourceId);
  const itemRef = foldRef(ref.itemRef).replace(/^#/u, "");
  return origin.some((entry) => {
    if (foldRef(entry.sourceId) !== sourceId) return false;
    const base = foldRef(entry.itemRef).replace(/^#/u, "");
    if (base === "") return true;
    return itemRef === base || (itemRef.startsWith(base) && !/[a-z0-9]/u.test(itemRef.charAt(base.length)));
  });
}

export interface PacketMcpOptions {
  /** The task's own request thread (M6): such an item is refused as a conversation, whatever source or tool it comes from. */
  origin?: readonly PacketOriginItem[];
  /** The arguments that fetch one item, built from the ref by code. Default: `{ id: itemRef }`. */
  argumentsFor?: (input: { source: ContextSource; tool: ContextSourceTool; itemRef: string }) => Record<string, unknown> | undefined;
}

/** `sourceId:itemRef` (the form a packet shows and a citation uses). `undefined` when the text is not that shape. */
export function parseMcpItemRef(ref: string): { sourceId: string; itemRef: string } | undefined {
  const at = ref.indexOf(":");
  if (at <= 0) return undefined;
  const sourceId = ref.slice(0, at);
  const itemRef = ref.slice(at + 1);
  if (!ContextSourceIdSchema.safeParse(sourceId).success || itemRef === "" || itemRef.length > 200 || /[\p{Cc}\p{Cf}"<>\\]/u.test(itemRef)) return undefined;
  return { sourceId, itemRef };
}

const isChatSource = (source: ContextSource): boolean =>
  (source.system !== undefined && PACKET_CHAT_SYSTEMS.includes(source.system.toLowerCase())) || CHAT_SOURCE_NAME.test(source.label) || CHAT_SOURCE_NAME.test(source.sourceId);

/**
 * The call that fetches one section 8 MCP item for a packet, or the fixed reason it is refused. `configured` is the project's list of context sources, read by the broker (never from the design).
 * Refusals: `not_allowed` (no such source, not allowed in PLAN_CRITIQUE, no ticked `read` tool, an unusable ref) and `conversation` (a chat system or a conversation tool).
 */
export function packetMcpCall(configured: readonly ContextSource[], ref: { sourceId: string; itemRef: string }, options: PacketMcpOptions = {}): PacketMcpCall {
  const source = configured.find((candidate) => candidate.sourceId === ref.sourceId);
  if (source === undefined || !source.stages.includes("PLAN_CRITIQUE")) return { ok: false, reason: "not_allowed" };
  if (isChatSource(source)) return { ok: false, reason: "conversation" };
  if (isOriginItem(options.origin, ref)) return { ok: false, reason: "conversation" };
  if (ref.itemRef === "" || ref.itemRef.length > 200 || /[\p{Cc}\p{Cf}]/u.test(ref.itemRef)) return { ok: false, reason: "not_allowed" };
  // Deterministic: the first ticked read tool by upstream name.
  const readTools = source.tools.filter((tool) => tool.role === "read").sort((a, b) => (a.upstreamName < b.upstreamName ? -1 : a.upstreamName > b.upstreamName ? 1 : 0));
  const tool = readTools[0];
  if (tool === undefined) return { ok: false, reason: "not_allowed" };
  if (CHAT_TOOL_NAME.test(tool.upstreamName)) return { ok: false, reason: "conversation" };
  const args = (options.argumentsFor ?? (({ itemRef }) => ({ id: itemRef })))({ source, tool, itemRef: ref.itemRef });
  if (args === undefined) return { ok: false, reason: "not_allowed" };
  return { ok: true, sourceId: source.sourceId, tool: presentedToolName(source.sourceId, tool.upstreamName), arguments: args };
}
