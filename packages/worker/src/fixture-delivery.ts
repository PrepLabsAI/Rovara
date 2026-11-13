// Fixture delivery, the worker's side (test services, slice 3; design test-services.md 7.4). A fake serves an approved fixture set that the task's pinned plan names by DIGEST. At the start of each phase that serves one
// (the coding phase, and every sealed round) the worker asks the broker, through the run's own callback capability, for a fresh 15-minute read address of that digest, downloads the set at once, and hands the bytes to the
// fake only if they are exactly the pinned set. A 15-minute address in the plan would have run out before the round began, so none is ever in the plan.
//
// What this module guarantees, each with a test:
//   - It asks for the digest the plan pinned and nothing else, and refuses an answer for another digest, an answer that is not an https address, and one that has already expired (fetchFixtureSet then holds the bytes
//     to the digest: a stale, swapped, truncated or padded object is refused there, and a redirect is never followed).
//   - Every refusal is ONE of a few fixed words (`FixtureDeliveryRefused.reason`). The address, the broker's words and the download's are never in an error, a log or a return: the address is a bearer credential for 15 minutes.
//   - Nothing is kept: the set is returned to the caller, which writes it into the run's own directory for ONE helper and never anywhere the agent can read. This module writes no file, logs nothing and holds nothing
//     after it returns (no cache: a set withdrawn between rounds is not served in the next one).
//   - The set is never a FILE or a value the agent can read: this file and fake-helper.ts may be imported only by the run layer (tests/unit/worker-fixture-source-guards.test.ts). In the coding phase the fake it feeds IS reachable by the agent, by design:
//     the agent's own requests to the fake get the set's recorded answers (that is what a fake is for), so a set's answers are visible to the agent that tests against it. The review that approved the set is the control for that; a sealed round's helper is not the agent's.
import { FixtureSetCallbackReplySchema, type FixtureSet } from "@rovara-code/contracts";
import { FixtureFetchRefused, fetchFixtureSet } from "./fixture-fetch.js";

export type FixtureDeliveryReason = "bad_digest" | "unavailable" | "wrong_answer" | "expired" | "refused";

/** The one error of this module. `message` is a fixed word; the reason is one of five. */
export class FixtureDeliveryRefused extends Error {
  constructor(readonly reason: FixtureDeliveryReason) {
    super(`fixture set not delivered: ${reason}`);
    this.name = "FixtureDeliveryRefused";
  }
}

/** The worker's callback for the run (callback-client.ts `fixtureSet`): the broker's raw answer, unparsed. */
export type FixtureSetCallback = (body: { digest: string }) => Promise<unknown>;
/** Fetches the approved set with this digest, checked. */
export type FixtureDelivery = (digest: string, signal?: AbortSignal) => Promise<FixtureSet>;

const DIGEST = /^[a-f0-9]{64}$/u;

export interface FixtureDeliveryOptions {
  /** Test seams. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  testOnlyAllowLoopbackHttp?: boolean;
}

/** A delivery over the run's callback. */
export function createFixtureDelivery(callback: FixtureSetCallback, options: FixtureDeliveryOptions = {}): FixtureDelivery {
  const now = options.now ?? Date.now;
  return async (digest, signal) => {
    if (!DIGEST.test(digest)) throw new FixtureDeliveryRefused("bad_digest");
    const stopped = (): boolean => signal?.aborted === true;
    if (stopped()) throw new FixtureDeliveryRefused("unavailable");
    let answer: unknown;
    try {
      answer = await callback({ digest });
    } catch {
      // The broker refused (another company's set, a digest outside the plan, a closed task, a withdrawn set: it says nothing about which) or could not be reached.
      throw new FixtureDeliveryRefused("refused");
    }
    // The broker's reply carries its request id beside the answer, as every callback reply does; the answer is the rest.
    const bare = typeof answer === "object" && answer !== null ? Object.fromEntries(Object.entries(answer).filter(([key]) => key !== "requestId")) : answer;
    const parsed = FixtureSetCallbackReplySchema.safeParse(bare);
    if (!parsed.success || parsed.data.digest !== digest) throw new FixtureDeliveryRefused("wrong_answer");
    if (Date.parse(parsed.data.expiresAt) <= now()) throw new FixtureDeliveryRefused("expired");
    if (stopped()) throw new FixtureDeliveryRefused("unavailable");
    try {
      return await fetchFixtureSet({
        url: parsed.data.url, expectedDigest: digest,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.testOnlyAllowLoopbackHttp === true ? { testOnlyAllowLoopbackHttp: true } : {}),
      });
    } catch (error) {
      throw new FixtureDeliveryRefused(error instanceof FixtureFetchRefused && (error.reason === "digest_mismatch" || error.reason === "unreadable") ? "wrong_answer" : "unavailable");
    }
  };
}
