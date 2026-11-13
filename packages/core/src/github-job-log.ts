// Rovara Code (Plan 6 Task 15): reading the end of a GitHub Actions job's log. GitHub answers a log request with a redirect to a short-lived address on its own storage; only an
// address on a host GitHub is known to serve logs from is followed, with no credentials, and the body is read as a stream that keeps only its end, so a log of any size costs
// bounded memory and time. What comes back is untrusted text: the caller redacts it and labels it before it reaches a model.
import type { ReadableStreamDefaultReader } from "node:stream/web";
import { CI_LOG_BYTES_MAX, CI_LOG_TAIL_LINES, agentXError } from "@rovara-code/contracts";

/** The hosts a job log is served from: GitHub's Actions hosts, and the numbered storage accounts of its results service. */
const LOG_HOSTS: readonly RegExp[] = [
  /^(?:[a-z0-9-]+\.)*actions\.githubusercontent\.com$/u,
  // GitHub's results storage accounts are numbered 0 to 19 (confirm at staging); any other number is not GitHub's.
  /^productionresultssa(?:[0-9]|1[0-9])\.blob\.core\.windows\.net$/u,
];

/** Whether Rovara reads a log from this address: https, an allowed host, the default port, and no credentials in it. */
export function isAllowedLogAddress(address: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(address);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.port === "" && parsed.username === "" && parsed.password === "" && LOG_HOSTS.some((pattern) => pattern.test(parsed.hostname));
}

/** The most of a log that is read before it is given up on (what is read last is what is kept). */
export const LOG_DOWNLOAD_BYTES_MAX = 8 * 1024 * 1024;
/** What is kept while reading: more than the tail needs, so a cut line at the front never takes a line the tail wants. */
const KEEP_BYTES = CI_LOG_BYTES_MAX * 2;

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

/** Reads a response body as a stream, keeping only its end; stops after `LOG_DOWNLOAD_BYTES_MAX` bytes. Returns the end as text. */
export async function readLogEnd(response: Response, signal?: AbortSignal): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader() as unknown as ReadableStreamDefaultReader<Uint8Array>;
  let kept: Buffer = Buffer.alloc(0);
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted === true) throw agentXError("RUNTIME_UNAVAILABLE", "reading the log was cancelled");
      const read = await reader.read();
      if (read.done) break;
      const value = read.value;
      total += value.byteLength;
      kept = Buffer.concat([kept, Buffer.from(value)]);
      if (kept.length > KEEP_BYTES) kept = kept.subarray(kept.length - KEEP_BYTES);
      if (total >= LOG_DOWNLOAD_BYTES_MAX) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder("utf-8").decode(kept).replace(/^�+/u, "");
}
