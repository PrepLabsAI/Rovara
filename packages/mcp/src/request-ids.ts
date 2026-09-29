// Task 15 fix round 1: a request ID for a call that left request_id out. An AI tool that retries a
// call (after its own timeout, for example) sends the same content again; it must reach AgentX with
// the same requestId, so AgentX answers the first request instead of starting a second task.
import { createHash } from "node:crypto";

/** How long an identical call counts as a retry of the first. */
export const REQUEST_ID_WINDOW_MS = 15 * 60_000;
/** A bound on memory for a long session; the oldest entries go first. */
const MOST_ENTRIES = 1_000;

/**
 * Remembers, per call content, the request ID made for it, for 15 minutes from the first call.
 * The ID itself is fresh (not the hash), so the same instructions sent on purpose after the
 * window reach AgentX as new work, even if AgentX still remembers the first request.
 */
export class RequestIdMemory {
  private readonly entries = new Map<string, { id: string; at: number; group?: string }>();

  constructor(private readonly windowMs = REQUEST_ID_WINDOW_MS) {}

  /**
   * `content` is everything that makes the call what it is: the tool, its target and its text.
   * `group` names the calls that forgetGroup() drops together, such as every share of one task.
   */
  idFor(content: readonly unknown[], now: number, make: () => string, group?: string): string {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.windowMs) this.entries.delete(key);
    }
    const key = keyOf(content);
    const known = this.entries.get(key);
    if (known !== undefined) return known.id;
    const id = make();
    this.entries.set(key, { id, at: now, ...(group === undefined ? {} : { group }) });
    while (this.entries.size > MOST_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return id;
  }

  /** Forgets the ID remembered for `content`, so the next identical call is new work. */
  forget(content: readonly unknown[]): void {
    this.entries.delete(keyOf(content));
  }

  /** Forgets every ID remembered in `group` except the one for `keep`, whatever their content. */
  forgetGroup(group: string, keep: readonly unknown[]): void {
    const kept = keyOf(keep);
    for (const [key, entry] of this.entries) {
      if (entry.group === group && key !== kept) this.entries.delete(key);
    }
  }
}

function keyOf(content: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}
