// Spec 025 FR-028, A15: which admin tools the server offers, and a guard that answers a direct call
// to a hidden one with FR-049's code. The SDK sends notifications/tools/list_changed itself when a
// registered tool is enabled or disabled while connected.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { ADMIN_SIGN_IN_STEP } from "./admin-client.js";
import { ToolError } from "./errors.js";

/** `admin` is undefined when the admin tools are offered, else why they are not. */
export interface AdminOffer { admin: ToolError | undefined }
interface Switchable { enable(): void; disable(): void; enabled: boolean }

/** Why the admin tools are hidden before any check has answered, or when none can be made. */
export const NOT_OFFERED = new ToolError("ADMIN_REQUIRED", "this computer holds no unexpired admin sign-in for AgentX", ADMIN_SIGN_IN_STEP);

export class ToolOffer {
  private current: AdminOffer = { admin: NOT_OFFERED };
  private running: Promise<void> | undefined;
  /** A refresh asked for during a read: that read may predate what changed, so one more follows. */
  private again = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: { tools: Map<string, Switchable>; read(): Promise<AdminOffer>; log?(entry: Record<string, unknown>): void }) {}

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
      do {
        this.again = false;
        await this.readOnce();
      } while (this.again);
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async readOnce(): Promise<void> {
    try {
      this.current = await this.options.read();
    } catch (error) {
      // The error's name only: its message could hold anything.
      this.options.log?.({ event: "offer.check_failed", error: error instanceof Error ? error.name : "unknown" });
      return;
    }
    const offered = this.current.admin === undefined;
    for (const tool of this.options.tools.values()) {
      if (offered && !tool.enabled) tool.enable();
      if (!offered && tool.enabled) tool.disable();
    }
  }

  /** Why a hidden admin tool is refused, or undefined for any other tool. */
  refusal(name: string): ToolError | undefined {
    const tool = this.options.tools.get(name);
    if (tool === undefined || tool.enabled) return undefined;
    // A refused call is also a good moment to look again.
    void this.refresh();
    return this.current.admin ?? NOT_OFFERED;
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
 */
export function guardTransport(inner: Transport, refusal: (name: string) => ToolError | undefined, answer: (error: ToolError) => Record<string, unknown>): Transport {
  const guarded: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    ...(inner.setProtocolVersion === undefined ? {} : { setProtocolVersion: (version: string) => inner.setProtocolVersion?.(version) }),
  };
  Object.defineProperty(guarded, "sessionId", { get: () => inner.sessionId, enumerable: true });
  const closed = inner.onclose;
  inner.onclose = () => { closed?.(); guarded.onclose?.(); };
  const failed = inner.onerror;
  inner.onerror = (error) => { failed?.(error); guarded.onerror?.(error); };
  const earlier = inner.onmessage;
  inner.onmessage = (message, extra) => {
    // An earlier onmessage is an observer of every inbound message, a refused tools/call included.
    earlier?.(message, extra);
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
  return guarded;
}
