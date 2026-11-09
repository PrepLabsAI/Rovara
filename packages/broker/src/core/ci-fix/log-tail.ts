// Rovara Code (Plan 6 Task 15): the end of a CI job's log, as a model may be told it. What comes back is untrusted text: the caller redacts it and labels it before it reaches a model.
// Reading a log from the host (GitHub's redirect to its log storage, the allowed hosts, the bounded stream) belongs to the host's adapter, not to the core (decision 51).
import { CI_LOG_BYTES_MAX, CI_LOG_TAIL_LINES } from "@agentx/contracts";

/** The last `CI_LOG_TAIL_LINES` lines of `text`, and no more than `CI_LOG_BYTES_MAX` bytes, starting at a line (a cut-off first line is dropped). */
export function logTail(text: string, options: { lines?: number; bytes?: number } = {}): string {
  const lines = options.lines ?? CI_LOG_TAIL_LINES;
  const bytes = options.bytes ?? CI_LOG_BYTES_MAX;
  const all = text.replace(/\r\n?/gu, "\n").split("\n");
  if (all.at(-1) === "") all.pop();
  let kept = all.slice(-lines);
  // Whole lines from the end, as many as fit in the byte limit; the one that does not fit is cut at its end (its beginning is what is lost) so a single long line still shows its last part.
  let total = 0;
  let from = kept.length;
  while (from > 0) {
    const size = Buffer.byteLength(kept[from - 1]!, "utf8") + 1;
    if (total + size > bytes) break;
    total += size;
    from -= 1;
  }
  if (from === kept.length && kept.length > 0) {
    const last = Buffer.from(kept.at(-1)!, "utf8");
    return new TextDecoder("utf-8").decode(last.subarray(Math.max(0, last.length - bytes))).replace(/^�+/u, "");
  }
  kept = kept.slice(from);
  return kept.join("\n");
}
