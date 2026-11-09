// Service mocks (E8): the v1 entry point of the mock server. Since test services TS23 it is a thin adapter: the v1 fixture set is checked against its pinned digest, converted to FixtureSet v2
// (`fixtureSetFromV1`), and served by the one fake server (`fake-server.ts`), which holds the sockets, the ledger, the faults and the replay rules this file used to hold. What is kept as it was:
//   - a request with a recording gets the recorded answer; one with none gets 500 and "mock had no recording" (`fail`, the default) or, for a less-safe `schema_synth` mock, a deterministic answer that
//     satisfies the response schema when the request satisfies the request schema. Either is COUNTED;
//   - a named fault (timeout, 5xx, throttle) is armed through the control path, which needs the run's control token, and is used up by the next requests;
//   - the task's additions are served only when the pinned set has no recording, and only after the broker's pin checks out.
// Replaces: serving a v1 set of an HTTP or AWS service by its old hash. A v1 entry of such a service kept no method and path, so it cannot be placed in a v2 set (the converter refuses it, nothing is
// guessed) and is refused here; such a set is recorded again as v2. A SageMaker Runtime set, the only kind with a caller, converts exactly.
// Fail closed and bounded as before: a set that is unreadable or does not hash to its pinned digest is not served; a body over 64 KiB is refused; the server listens on one address (loopback by default).
import {
  fixtureEntry,
  fixtureSetDigest,
  fixtureSetFromV1,
  type FixtureEntry,
  type ServiceMockUsage,
  type TestEnvProdDeny,
} from "@agentx/contracts";
import { verifyAdditionSet } from "./additions.js";
import { FakeServerRefused, startFakeServer } from "./fake-server.js";
import { FixtureSetRefused, loadFixtureSet } from "./fixture-set.js";

export interface ServiceMockOptions {
  /** The fixture set as stored (untrusted until `loadFixtureSet` has checked it against the pinned digest). */
  fixtureSet: unknown;
  /** `mock.fixtureSetRef` of the approved environment. */
  expectedDigest: string;
  unmatched: "fail" | "schema_synth";
  host?: string;
  port?: number;
  /** The task's new answers (owner decision Q9), served only when the pinned set has no recording. They must extend exactly this set (`baseFixtureDigest`). */
  additions?: unknown;
  /** The digest of the additions the BROKER pinned, and the production deny list the additions are scanned against. Both are required with `additions`: an unpinned set is never served. */
  expectedAdditionsDigest?: string;
  deny?: TestEnvProdDeny;
  /** Wait for the recorded latency before answering (off by default: a mock should be quick). */
  replayLatency?: boolean;
  controlToken?: string;
}

/** What the mock reports: the contract's usage plus how many answers came from the task's additions (listed in the evidence by the additions listing). */
export type ServiceMockReport = ServiceMockUsage & { additionsServed: number };

export interface RunningServiceMock {
  url: string;
  /** The token the control paths need; given to the scenario runner, never to the app. */
  controlToken: string;
  usage(): ServiceMockReport;
  close(): Promise<void>;
}

export async function startServiceMock(options: ServiceMockOptions): Promise<RunningServiceMock> {
  const v1 = loadFixtureSet(options.fixtureSet, options.expectedDigest);
  const converted = fixtureSetFromV1(v1);
  if (!converted.ok) throw new FixtureSetRefused(converted.reason === "invalid" ? "unreadable" : "request_lines_unknown");
  const v2 = converted.set;
  const additionEntries: FixtureEntry[] = [];
  if (options.additions !== undefined) {
    if (options.expectedAdditionsDigest === undefined || options.deny === undefined) throw new FixtureSetRefused("additions_unpinned");
    const verified = verifyAdditionSet(v1, options.additions, options.expectedAdditionsDigest, options.deny);
    // A v1 addition kept only its body, so it is placed the one way a SageMaker Runtime request can be, and filed under its v2 hash.
    for (const addition of verified.additions) {
      const { request, response } = addition.entry;
      additionEntries.push(fixtureEntry(v2, { method: "POST", path: `/endpoints/${v1.service.target}/invocations`, contentType: request.contentType, body: request.body },
        { status: response.status, headers: [], contentType: response.contentType, body: response.body, latencyMs: response.latencyMs }));
    }
  }
  let fake;
  try {
    fake = await startFakeServer({
      mode: "replay", fixtureSet: v2, expectedDigest: fixtureSetDigest(v2), unmatched: options.unmatched, bindAddress: options.host ?? "127.0.0.1", port: options.port ?? 0,
      callers: "any", ledgerPath: null, additionEntries,
      ...(options.replayLatency === undefined ? {} : { replayLatency: options.replayLatency }), ...(options.controlToken === undefined ? {} : { controlToken: options.controlToken }),
    });
  } catch (error) {
    if (error instanceof FakeServerRefused && error.reason === "additions_invalid") throw new FixtureSetRefused("additions_unsafe");
    throw error;
  }
  const report = (): ServiceMockReport => {
    const { matched, unmatchedFailed, synthesized, faultsInjected, additionsServed } = fake.usage();
    return { service: v1.service.name, matched, unmatchedFailed, synthesized, faultsInjected, additionsServed };
  };
  return { url: fake.url, controlToken: fake.controlToken, usage: report, close: () => fake.close() };
}
