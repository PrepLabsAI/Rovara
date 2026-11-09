// What a round's fake servers say they were asked (test services, slice 3). While a round's fakes still run, the worker reads each one's ledger SUMMARY with one fixed `docker exec` of the fake's own program
// (`fake-helper.js --summarize`, fake-helper.ts), after proving the container is running before and after the read: a fake that stopped cannot have recorded every call made to it, so nothing is counted from it. The summary is
// one short JSON line; anything else is "unreadable". The port this builds is `FakeUsagePort` of service-usage-record.ts, which makes the buckets; nothing the program under test sent is read here (the ledger's paths and hosts
// are parsed inside the fake's container and never leave it).
import { FAKE_HELPER_ENTRY, FAKE_FIXTURE_TARGET, FAKE_LEDGER_TARGET } from "./service-helpers.js";
import { parseFakeLedgerSummary, type FakeLedgerSummary } from "./fake-helper.js";
import type { ServiceSession } from "./service-runner.js";
import type { DockerCli } from "./swebench/containers.js";

const NODE = "/usr/local/bin/node";

/** What a fake's summary read gives: the dependency's id and its summary, or undefined for a summary that could not be read. The port is bound to the round's own fakes, while they still run (service-usage-record.ts takes it as `fakes`). */
export type FakeUsagePort = (signal: AbortSignal) => Promise<ReadonlyArray<{ id: string; summary: FakeLedgerSummary | undefined }>>;
const CONTAINER_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const CALL_TIMEOUT_MS = 10_000;

export interface RoundFake {
  /** The dependency's id in the plan. */
  id: string;
  /** The digest of the set the fake serves. */
  digest: string;
}

/** The `docker exec` arguments of one summary: every value is a container name the launcher made, a digest or an address of the run's slot. */
export function fakeSummaryArgs(container: string, digest: string, caller: string): string[] {
  if (!CONTAINER_NAME.test(container) || !DIGEST.test(digest) || !IPV4.test(caller)) throw new RangeError("a fake summary");
  return ["exec", container, NODE, FAKE_HELPER_ENTRY, "--summarize", "--ledger", FAKE_LEDGER_TARGET, "--fixture", FAKE_FIXTURE_TARGET, "--digest", digest, "--caller", caller];
}

async function running(docker: DockerCli, container: string, signal: AbortSignal): Promise<boolean> {
  const state = await docker.run(["inspect", "--format", "{{.State.Status}}", container], { timeoutMs: CALL_TIMEOUT_MS, signal }).catch(() => undefined);
  return state !== undefined && state.exitCode === 0 && state.stdout.trim() === "running";
}

/** One fake's summary, or undefined when it could not be read or cannot be trusted. Never throws. */
export async function readFakeSummary(docker: DockerCli, container: string, digest: string, caller: string, signal: AbortSignal): Promise<FakeLedgerSummary | undefined> {
  try {
    if (!(await running(docker, container, signal))) return undefined;
    const read = await docker.run(fakeSummaryArgs(container, digest, caller), { timeoutMs: CALL_TIMEOUT_MS, signal });
    if (read.exitCode !== 0 || read.timedOut === true) return undefined;
    const summary = parseFakeLedgerSummary(read.stdout);
    // The helper was running when the read began and when it ended: the ledger it wrote is the whole of what it was asked.
    return summary !== undefined && (await running(docker, container, signal)) ? summary : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The port for a round: one summary per fake of the round, each for the check sandbox's address (the only caller a round's fake answers). A fake the session has no helper for is unreadable.
 */
export function fakeUsagePort(docker: DockerCli, session: Pick<ServiceSession, "helpers" | "network">, fakes: readonly RoundFake[]): FakeUsagePort {
  return async (signal) => {
    const rows: Array<{ id: string; summary: FakeLedgerSummary | undefined }> = [];
    for (const fake of fakes) {
      const helper = session.helpers.find((candidate) => candidate.id === fake.id);
      rows.push({ id: fake.id, summary: helper === undefined || signal.aborted ? undefined : await readFakeSummary(docker, helper.container, fake.digest, session.network.checkSandboxIp, signal) });
    }
    return rows;
  };
}
