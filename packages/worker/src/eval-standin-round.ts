// The eval round's stand-in state (L4-E56). ONE `EvalStandInRound` per eval round: both sides of a comparison, every re-ask and the second look share it, so they share the ANSWER BOOK (a request asked on both sides gets the same
// bytes) and the round's certificate authority. It lives in the worker's memory; each sandbox run gives its helper the book as it stands (the set file) and takes back the answers the helper made (its summary).
//
// Also here: reading the repository's OWN recordings (R2) and OpenAPI descriptions out of a checkout for the plan. The files are read the way the project's other report and spec files are: only plain files under the checkout,
// never through a link, within a size cap, parsed as data (JSON or YAML) and never run. A repository handler written as code (MSW) is not read.
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import {
  EVAL_STAND_IN_MAX_RECORDED, EVAL_STAND_IN_RECORDED_MAX_BYTES, EvalAnswerBook, buildOpenApiFake, evalStandInRecordedFromValue, isEvalStandInPlanHost,
  type EvalStandInCounts, type EvalStandInHostPlan, type EvalStandInPlan, type EvalStandInRecorded, type EvalStandInSetContent, type TrustedEvalStandInSummary,
} from "@agentx/contracts";
import { createRunCa, type RunCa } from "./run-ca.js";

export interface EvalStandInRoundInput {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly plan: EvalStandInPlan;
  readonly recorded?: readonly EvalStandInRecorded[];
  /** Test seam: the authority (default: a new one). */
  readonly ca?: RunCa;
}

/** What one sandbox run did to the stand-in: whether it hit a gap (a made-up answer), and the round's counts as they stand. */
export interface EvalStandInRunResult {
  readonly hitGap: boolean;
  readonly counts: EvalStandInCounts;
}

export class EvalStandInRound {
  readonly book = new EvalAnswerBook();
  readonly workspaceId: string;
  readonly operationId: string;
  readonly plan: EvalStandInPlan;
  private readonly recorded: readonly EvalStandInRecorded[];
  private readonly ca: RunCa;
  private served = 0;
  private gapCalls = 0;
  private saturated = false;

  constructor(input: EvalStandInRoundInput) {
    this.workspaceId = input.workspaceId;
    this.operationId = input.operationId;
    this.plan = input.plan;
    this.recorded = (input.recorded ?? []).slice(0, EVAL_STAND_IN_MAX_RECORDED);
    for (const entry of this.recorded) this.book.preloadRecorded(entry);
    this.ca = input.ca ?? createRunCa();
  }

  /** The PUBLIC certificate: the only part of the authority that goes to the box. */
  get certificatePem(): string { return this.ca.certPem; }

  /** The content of the set file for a helper starting now: the plan, the recordings, the answers so far and the authority (certificate and key: for the helper's own read-only mount). */
  setContent(): EvalStandInSetContent {
    return { workspaceId: this.workspaceId, operationId: this.operationId, plan: this.plan, recorded: this.recorded, book: this.book.snapshot(), ca: { certPem: this.ca.certPem, keyPem: this.ca.keyPem } };
  }

  /**
   * Takes back one run's summary. A trusted one adds the answers the helper made to the round's book (never replacing one) and the calls it served to the totals; an untrusted or missing one says nothing, so the run is
   * counted as one that hit a gap (never a claim of "no gap" from a helper that could not be read).
   */
  absorb(summary: TrustedEvalStandInSummary | undefined): EvalStandInRunResult {
    if (summary === undefined || !summary.trusted) { this.saturated = true; return { hitGap: true, counts: this.counts() }; }
    for (const entry of summary.additions) this.book.restore(entry);
    this.served = Math.min(1_000_000, this.served + summary.counts.served);
    this.gapCalls = Math.min(1_000_000, this.gapCalls + summary.counts.gapCalls);
    if (summary.counts.saturated) this.saturated = true;
    // A request the stand-in did not answer (a TLS handshake a client abandoned, a body past the limit) is a sandbox artifact like a made-up answer: the run counts as having hit a gap.
    return { hitGap: summary.counts.gapCalls > 0 || summary.counts.saturated || summary.tlsFailed > 0 || summary.refused > 0, counts: this.counts() };
  }

  /** The round's counts: distinct answers by class from the book, calls from the summaries. */
  counts(): EvalStandInCounts {
    const distinct = this.book.counts();
    return { ...distinct, served: this.served, gapCalls: this.gapCalls, saturated: distinct.saturated || this.saturated };
  }
}

// ---- the repository: recordings and descriptions

export const EVAL_STAND_IN_READ_LIMITS = { files: 200, fileBytes: 1_048_576, totalBytes: 8 * 1_048_576, visited: 5_000, depth: 6 } as const;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "vendor", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", ".cache", "coverage"]);
const RECORDING_DIRECTORIES = new Set(["cassettes", "vcr_cassettes", "recordings", "__recordings__", "wiremock", "mappings", "har", "hars", "nock", "fixtures"]);
const RECORDING_FILE = /(?:\.cassette\.(?:ya?ml|json)|\.har|\.nock\.json)$/iu;
const DATA_FILE = /\.(?:ya?ml|json|har)$/iu;
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`);

async function readSmall(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > EVAL_STAND_IN_READ_LIMITS.fileBytes) return undefined;
    const buffer = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buffer, 0, info.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

/**
 * The repository's own recordings: HAR files, VCR and vcrpy cassettes, nock fixtures and WireMock mappings, found by their conventional place or name (a folder called `cassettes`, `recordings`, `mappings`..., or a
 * `.cassette.*`/`.har` file) under the checkout. `defaultHost`: the one planned host a host-less mapping belongs to (undefined when the plan names none or several). Bounded in files, bytes and entries; a link is never followed;
 * a file that does not parse is skipped. Never throws.
 */
export async function readRepositoryRecordings(checkoutRoot: string, defaultHost: string | undefined): Promise<{ recorded: EvalStandInRecorded[]; files: number; skipped: number }> {
  const recorded: EvalStandInRecorded[] = [];
  let files = 0; let skipped = 0; let visited = 0; let total = 0; let recordedBytes = 0;
  try {
    const root = await realpath(checkoutRoot);
    const walk = async (directory: string, depth: number, inRecordingFolder: boolean): Promise<void> => {
      if (depth > EVAL_STAND_IN_READ_LIMITS.depth) return;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++visited > EVAL_STAND_IN_READ_LIMITS.visited) return;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name)) continue;
          await walk(path, depth + 1, inRecordingFolder || RECORDING_DIRECTORIES.has(entry.name.toLowerCase()));
          continue;
        }
        if (!entry.isFile() || !DATA_FILE.test(entry.name) || !(RECORDING_FILE.test(entry.name) || inRecordingFolder)) continue;
        if (files >= EVAL_STAND_IN_READ_LIMITS.files || recorded.length >= EVAL_STAND_IN_MAX_RECORDED) { skipped += 1; continue; }
        const real = await realpath(path);
        const info = await lstat(real);
        if (!inside(root, real) || !info.isFile() || total + info.size > EVAL_STAND_IN_READ_LIMITS.totalBytes) { skipped += 1; continue; }
        const text = await readSmall(real).catch(() => undefined);
        if (text === undefined) { skipped += 1; continue; }
        total += text.length;
        let value: unknown;
        try { value = parse(text, { maxAliasCount: 20, prettyErrors: false }) as unknown; } catch { skipped += 1; continue; }
        const read = evalStandInRecordedFromValue(value, defaultHost);
        files += 1;
        skipped += read.skipped;
        for (const entry of read.recorded) {
          const size = new TextEncoder().encode(entry.body).length + 128;
          if (recorded.length >= EVAL_STAND_IN_MAX_RECORDED || recordedBytes + size > EVAL_STAND_IN_RECORDED_MAX_BYTES) { skipped += 1; continue; }
          recordedBytes += size;
          recorded.push(entry);
        }
      }
    };
    await walk(root, 0, false);
  } catch { /* what was read stays; the rest says nothing */ }
  return { recorded, files, skipped };
}

/** One outside host and where the contract finder found its description: an OpenAPI file in the checkout (relative path), and the fields the caller reads. */
export interface EvalStandInHostDescriptor {
  readonly host: string;
  readonly specPath?: string | undefined;
  readonly reads?: readonly string[] | undefined;
}

/** The plan for these hosts: each host's OpenAPI description read from the checkout (a file that is missing, outside the checkout, too big, or not OpenAPI 3 is left out: the host is still stood in, by its reads or a minimal answer). */
export async function buildEvalStandInPlan(checkoutRoot: string, hosts: readonly EvalStandInHostDescriptor[]): Promise<EvalStandInPlan> {
  const plan: EvalStandInHostPlan[] = [];
  let root: string | undefined;
  try { root = await realpath(checkoutRoot); } catch { root = undefined; }
  for (const descriptor of hosts) {
    const host = descriptor.host.toLowerCase();
    if (!isEvalStandInPlanHost(host) || plan.some((entry) => entry.host === host)) continue;
    let openapi: EvalStandInHostPlan["openapi"];
    if (root !== undefined && descriptor.specPath !== undefined && !descriptor.specPath.startsWith("/") && !descriptor.specPath.split("/").includes("..")) {
      try {
        const real = await realpath(join(root, descriptor.specPath));
        if (inside(root, real)) {
          const text = await readSmall(real);
          const fake = text === undefined ? undefined : buildOpenApiFake(parse(text, { maxAliasCount: 50, prettyErrors: false }) as unknown, relative(root, real));
          if (fake?.status === "built") openapi = fake;
        }
      } catch { /* the host is still stood in */ }
    }
    plan.push({ host, ...(openapi === undefined ? {} : { openapi }), ...(descriptor.reads === undefined ? {} : { reads: [...descriptor.reads] }) });
  }
  return plan;
}
