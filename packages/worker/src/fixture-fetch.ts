// Test services TS24 (design test-services.md 7.4): the worker's side of fixture delivery. The broker hands it a 15-minute signed read URL and the DIGEST the task plan pinned; this module downloads the set and
// refuses it unless the bytes are exactly that set. The broker has checked the stored object too, but the worker does not trust the path between: a stale, swapped or truncated object is refused here.
//   - the address must be https (the one exception is a loopback address, for the tests that run it against a local server); a redirect is never followed, so a signed address cannot send the worker elsewhere;
//   - the download is bounded: more than 4 MiB (the contract's limit) stops it, and so does a time limit;
//   - the bytes must hash (SHA-256) to the pinned digest, parse as a FixtureSet v2 (every entry under its own hash) and the parsed set must have the same digest; any of these failing is `digest_mismatch`
//     or `unreadable`, and nothing from the download is kept or returned.
// It starts nothing and writes nothing: the caller (the service runner) hands the checked set to the fake server, which checks the digest once more before it serves.
import { createHash } from "node:crypto";
import { FIXTURE_SET_MAX_BYTES, FixtureSetSchema, fixtureSetDigest, type FixtureSet } from "@rovara-code/contracts";

export const FIXTURE_FETCH_TIMEOUT_MS = 20_000;
const DIGEST = /^[a-f0-9]{64}$/u;

export type FixtureFetchRefusal = "bad_digest" | "bad_url" | "http_error" | "redirect" | "too_large" | "timeout" | "unreadable" | "digest_mismatch";
export class FixtureFetchRefused extends Error {
  constructor(readonly reason: FixtureFetchRefusal) {
    super(`fixture set refused: ${reason}`);
    this.name = "FixtureFetchRefused";
  }
}

export interface FixtureFetchInput {
  /** The signed read URL the broker minted. */
  url: string;
  /** The digest the task plan pinned. */
  expectedDigest: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /**
   * Test only: also accept `http://` to a loopback address (a local server in a test). Production leaves this off and the delivery URL must be https; the option is never read from a task, a plan or the
   * environment, and a caller that sets it is a test.
   */
  testOnlyAllowLoopbackHttp?: boolean;
  timeoutMs?: number;
}

const isLoopbackHost = (hostname: string): boolean => hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "localhost";

/** The set behind a delivery URL, checked against the pinned digest. Throws `FixtureFetchRefused`. */
export async function fetchFixtureSet(input: FixtureFetchInput): Promise<FixtureSet> {
  if (!DIGEST.test(input.expectedDigest)) throw new FixtureFetchRefused("bad_digest");
  let url: URL;
  try { url = new URL(input.url); } catch { throw new FixtureFetchRefused("bad_url"); }
  if (!(url.protocol === "https:" || (input.testOnlyAllowLoopbackHttp === true && url.protocol === "http:" && isLoopbackHost(url.hostname))) || url.username !== "" || url.password !== "") throw new FixtureFetchRefused("bad_url");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? FIXTURE_FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await (input.fetchImpl ?? fetch)(url, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: "application/json" } });
    } catch {
      throw new FixtureFetchRefused(controller.signal.aborted ? "timeout" : "http_error");
    }
    if (response.status >= 300 && response.status < 400) throw new FixtureFetchRefused("redirect");
    if (response.type === "opaqueredirect") throw new FixtureFetchRefused("redirect");
    if (response.status !== 200 || response.body === null) throw new FixtureFetchRefused("http_error");
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > FIXTURE_SET_MAX_BYTES) throw new FixtureFetchRefused("too_large");
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    // The time limit holds whatever the body stream does: a read that never returns is cut by the same deadline.
    const deadline = new Promise<never>((_resolve, reject) => { controller.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true }); });
    deadline.catch(() => undefined);
    try {
      for (;;) {
        const read: Promise<{ done: boolean; value?: Uint8Array | undefined }> = reader.read();
        const { done, value } = await Promise.race([read, deadline]);
        if (done || value === undefined) break;
        size += value.length;
        if (size > FIXTURE_SET_MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new FixtureFetchRefused("too_large"); }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof FixtureFetchRefused) throw error;
      void reader.cancel().catch(() => undefined);
      throw new FixtureFetchRefused(controller.signal.aborted ? "timeout" : "http_error");
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== input.expectedDigest) throw new FixtureFetchRefused("digest_mismatch");
    let set: FixtureSet;
    try { set = FixtureSetSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { throw new FixtureFetchRefused("unreadable"); }
    // The bytes hashed right, but the set they parse to must be the pinned one too (a non-canonical spelling of another set would not be).
    if (fixtureSetDigest(set) !== input.expectedDigest) throw new FixtureFetchRefused("digest_mismatch");
    return set;
  } finally {
    clearTimeout(timer);
  }
}
