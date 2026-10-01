// Spec 025 FR-028, A15: which admin tools the server offers, and a guard that answers a direct call
// to a hidden one with FR-049's code. The SDK sends notifications/tools/list_changed itself when a
// registered tool is enabled or disabled while connected; the server debounces it, so one refresh
// that switches many tools sends one (issue 203).
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ADMIN_SIGN_IN_STEP } from "./admin-client.js";
import { ToolError, UPGRADE_AGENTX_STEP } from "./errors.js";

/**
 * `admin` is undefined when the admin read tools are offered, else why they are not. Spec 025
 * FR-028, FR-041: `audit` (agentx_admin_changes) and `changes` (the change tools) are offered only
 * when named and undefined, so an offer that names only `admin` (25d's) offers neither.
 */
export interface AdminOffer { admin: ToolError | undefined; audit?: ToolError | undefined; changes?: ToolError | undefined }
export type AdminToolGroup = "admin" | "audit" | "changes";
interface Switchable { enable(): void; disable(): void; enabled: boolean }
/** A tool the offer switches; a bare one is in the admin group. */
type OfferedTool = Switchable | { tool: Switchable; group: AdminToolGroup };
const entryOf = (entry: OfferedTool): { tool: Switchable; group: AdminToolGroup } => ("group" in entry ? entry : { tool: entry, group: "admin" });

/**
 * Issue 203: how long the first tools/list waits for the first offer check, so a client that lists
 * once (Codex) sees the admin tools. The check is a sign-in read and one or two HTTPS round trips,
 * well under a second normally; 5 seconds covers a slow network and stays well inside Codex's
 * 10-second MCP startup timeout. A slower check is answered with what is known, and its result
 * announced with list_changed when it lands.
 */
export const FIRST_LIST_WAIT_MS = 5_000;
/**
 * Issue 203 review: the longest one offer read may take. A read that never settled kept every later
 * recheck from running; one past this counts as a failed check, and the next recheck tries again.
 */
export const OFFER_READ_TIMEOUT_MS = 15_000;

/** Why the admin tools are hidden before any check has answered, or when none can be made. */
export const NOT_OFFERED = new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP);
/** Why agentx_admin_changes and the change tools are hidden when the offer does not name their group. */
const NO_CHANGE_TOOLS = new ToolError("UPGRADE_REQUIRED", "this AgentX has no admin change tools yet", UPGRADE_AGENTX_STEP);

/** A group is offered only when named and undefined; while the admin group is refused, all are, for its reason. */
function refusalOf(offer: AdminOffer, group: AdminToolGroup): ToolError | undefined {
  if (offer.admin !== undefined) return offer.admin;
  if (group === "admin") return undefined;
  return group in offer ? offer[group] : NO_CHANGE_TOOLS;
}

export class ToolOffer {
  private current: AdminOffer = { admin: NOT_OFFERED };
  private running: Promise<void> | undefined;
  /** A refresh asked for during a read: that read may predate what changed, so one more follows. */
  private again = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Resolves when the first read has answered or failed (issue 203). */
  private readonly firstRead: Promise<void>;
  private firstReadDone = false;
  private markFirstRead: () => void = () => undefined;

  constructor(private readonly options: { tools: Map<string, OfferedTool>; read(): Promise<AdminOffer>; log?(entry: Record<string, unknown>): void; readTimeoutMs?: number }) {
    this.firstRead = new Promise<void>((resolve) => {
      this.markFirstRead = () => {
        this.firstReadDone = true;
        resolve();
      };
    });
  }

  /**
   * Issue 203: resolves once the first read has answered or failed, or after `waitMs`, whichever is
   * first; it never rejects. Starts that read if none has started yet.
   */
  ready(waitMs: number): Promise<void> {
    if (this.firstReadDone) return Promise.resolve();
    this.begin();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        // Said, so a client that then sees no admin tools leaves a trace in the log.
        this.options.log?.({ event: "offer.first_list_timeout", waitMs });
        resolve();
      }, waitMs);
      timer.unref?.();
    });
    return Promise.race([this.firstRead, bound]).finally(() => clearTimeout(timer));
  }

  /**
   * Starts the first read unless one has started or answered: the first tools/list (through ready)
   * and the client's initialized notification both ask, and one read serves both.
   */
  begin(): void {
    if (!this.firstReadDone && this.running === undefined) void this.refresh();
  }

  /**
   * Reads the offer and switches the tools; one read at a time, and a failed read changes nothing.
   * A refresh asked for during a read queues one more read after it (at most one), and resolves
   * when that read is done.
   */
  refresh(): Promise<void> {
    if (this.running !== undefined) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.readOnce();
        } while (this.again);
      } finally {
        // Cleared in the same step as the loop's last check, so a refresh after it starts a new read
        // (a .finally() on the promise would run a few microtasks later and lose that refresh).
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async readOnce(): Promise<void> {
    try {
      try {
        this.current = await this.readBounded();
      } catch (error) {
        // The error's name only: its message could hold anything.
        this.options.log?.({ event: "offer.check_failed", error: error instanceof Error ? error.name : "unknown" });
        return;
      }
      // Kept synchronous: the SDK's debounce coalesces the list_changed of every switch made in one
      // tick into one notification (issue 203). When the first read switches tools, that one
      // notification goes out just before the held first tools/list is answered; harmless.
      for (const entry of this.options.tools.values()) {
        const { tool, group } = entryOf(entry);
        const offered = refusalOf(this.current, group) === undefined;
        if (offered && !tool.enabled) tool.enable();
        if (!offered && tool.enabled) tool.disable();
      }
    } finally {
      this.markFirstRead();
    }
  }

  /** One read, or a TimeoutError once it takes longer than readTimeoutMs; a late answer is dropped. */
  private async readBounded(): Promise<AdminOffer> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("the admin offer check took too long");
        error.name = "TimeoutError";
        reject(error);
      }, this.options.readTimeoutMs ?? OFFER_READ_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.options.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Why a hidden admin tool is refused, or undefined for any other tool. */
  refusal(name: string): ToolError | undefined {
    const entry = this.options.tools.get(name);
    if (entry === undefined) return undefined;
    const { tool, group } = entryOf(entry);
    if (tool.enabled) return undefined;
    // A refused call is also a good moment to look again.
    void this.refresh();
    return refusalOf(this.current, group) ?? NOT_OFFERED;
  }

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

type CallRequest = { jsonrpc: "2.0"; id: string | number; method: "tools/call"; params: { name: string } };
const isToolCall = (message: JSONRPCMessage): message is CallRequest & JSONRPCMessage =>
  "method" in message && message.method === "tools/call" && "id" in message && typeof (message as { params?: { name?: unknown } }).params?.name === "string";

/**
 * A15: answers a tools/call for a hidden admin tool before the SDK sees it, since the SDK's own
 * answer ("Tool ... disabled") carries no code. Everything else passes through unchanged and in
 * order. Callbacks set on `inner` before (runMcpServer's onclose) are kept and still called first,
 * the way the SDK's own connect keeps them.
 *
 * Issue 203: with `beforeFirstList`, the first tools/list, and every message after it, is held
 * until that promise settles (it must be bounded), then delivered in order, so the first answer
 * reflects the first offer check.
 */
export function guardTransport(
  inner: Transport,
  refusal: (name: string) => ToolError | undefined,
  answer: (error: ToolError) => Record<string, unknown>,
  beforeFirstList?: () => Promise<void>,
): Transport {
  const guarded: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    ...(inner.setProtocolVersion === undefined ? {} : { setProtocolVersion: (version: string) => inner.setProtocolVersion?.(version) }),
  };
  Object.defineProperty(guarded, "sessionId", { get: () => inner.sessionId, enumerable: true });
  type Extra = Parameters<NonNullable<Transport["onmessage"]>>[1];
  /** Messages held behind the first tools/list, in arrival order; undefined when none are held. */
  let held: Array<[JSONRPCMessage, Extra]> | undefined;
  let listSeen = beforeFirstList === undefined;
  const closed = inner.onclose;
  inner.onclose = () => {
    // Nothing held is delivered to a closed connection.
    held = undefined;
    closed?.();
    guarded.onclose?.();
  };
  const failed = inner.onerror;
  inner.onerror = (error) => { failed?.(error); guarded.onerror?.(error); };
  const earlier = inner.onmessage;
  const deliver = (message: JSONRPCMessage, extra: Extra) => {
    if (isToolCall(message)) {
      const refused = refusal(message.params.name);
      if (refused !== undefined) {
        void inner.send({ jsonrpc: "2.0", id: message.id, result: answer(refused) })
          .catch((error: unknown) => guarded.onerror?.(error instanceof Error ? error : new Error("send failed")));
        return;
      }
    }
    guarded.onmessage?.(message, extra);
  };
  inner.onmessage = (message, extra) => {
    // An earlier onmessage is an observer of every inbound message, a refused tools/call included.
    earlier?.(message, extra);
    if (held !== undefined) {
      held.push([message, extra]);
      return;
    }
    if (!listSeen && beforeFirstList !== undefined && "method" in message && message.method === "tools/list" && "id" in message) {
      listSeen = true;
      const queue: Array<[JSONRPCMessage, Extra]> = [[message, extra]];
      held = queue;
      const release = () => {
        // A close meanwhile dropped the queue.
        if (held !== queue) return;
        held = undefined;
        for (const [next, nextExtra] of queue) {
          // A throw here would otherwise be an unhandled rejection and lose the rest of the queue.
          try {
            deliver(next, nextExtra);
          } catch (error) {
            guarded.onerror?.(error instanceof Error ? error : new Error("delivery failed"));
          }
        }
      };
      beforeFirstList().then(release, release);
      return;
    }
    deliver(message, extra);
  };
  return guarded;
}
