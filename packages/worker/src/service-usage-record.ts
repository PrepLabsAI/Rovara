// The usage record of a run's test services (test services, slice 1, s1-sealed T1; design test-services.md 8.1 and 12; deferred check TS-SEAL-1). What the worker reports after a round: for each dependency whether it was
// started and answers, how long it took and how many times it was put back; and what the program tried to reach that nobody listed, as a registrable domain and a count.
//
// WHY UNKNOWN NAMES ARE REDUCED (TS-SEAL-1): the sealed name server records every name the program asked for, and the program chooses that text. The run's connection variables hold secrets (a per-run password), so a
// program that read one can ask for `<password>.attacker.test`, and the name server stores it lower-cased. A person reading the record, or the evidence pack that carries it, must never see that name. This module
// therefore NEVER passes a name on. For each recorded name it:
//   1. withholds the name when the case-insensitive service redactor changes it, or changes it once its separators (`.`, `-`, `_`) are removed or it is upper-cased: a secret split over labels is still a secret, and the
//      part of it that falls in the registrable domain would show;
//   2. otherwise keeps only the registrable domain (the public suffix plus one label, `registrableDomain` of the contracts' public suffix list), and withholds that too when the redactor changes it, when it is not a host
//      the contract accepts (`hostProblem`), or when it looks like a key in either case (`looksLikeSecretValue`);
//   3. adds the counts up per registrable domain and keeps at most USAGE_UNKNOWN_DOMAINS_MAX of them, most asked first. Everything else (single-label names, withheld names, the rest over the cap, the name server's own
//      `dropped` and `unrecorded` counts) is added to `otherCount`, which names nothing.
//   4. reports every count as a COARSE BUCKET (`bucketCount`: 1, 2-5, 6-20, 21+, each shown as its lower bound, so "2" reads "2 to 5"), and orders the domains by bucket and then by name. A program that picks how often it
//      asks for a name could otherwise carry about 30 bits in each of 50 counts, and in the order of the list.
// Residual, accepted for a per-run database password (TS-SEAL-1 bandwidth, DEFERRED-CHECKS): a program can still encode a value in the LABEL under a registrable domain that no redaction spelling covers (hex, base32,
// reversed, split): about 5 bits a character, up to 63 characters a domain, 50 domains, so about 2 KB, plus about 2 bits a bucketed count (about 13 bytes); and anything it prints, which reaches the check's output
// tail (64 KiB a check) through the same spelling-based redactor. That is why this record, and the sealed round's output, must NEVER be fed back to the agent or a model (the tests guard the agent-facing modules),
// and why a long-lived secret (a test account's key) must not enter a sealed round on this design: see check-round-runners.ts.
//
// SLICE 2, THE EMULATOR'S LEDGER (one port, `ServiceUsageRecordInput.emulator`): the same rules apply to what Rovara local AWS's request ledger says. The service keys come from the emulator's fixed set and the operation names are the
// program's own words (a request the emulator cannot name is `METHOD /path`; an `Action=` is whatever was sent), so a name is shown only if it has the shape of a service key or an operation name AND the case-insensitive
// redactor leaves it alone in every spelling `isShowable` tries; every other call is counted in `otherCalls` / `otherUnsupported` and named nowhere. Counts are coarse buckets (`bucketCount`), lists are ordered by bucket and then
// by name, and the lists are capped. A ledger that cannot be read is `ledger: "unreadable"` with nothing else, never "no calls". Residual (as for the names above, accepted and declared): an operation name that passes the shape
// check can still carry a value the redactor's spellings do not cover, up to ~64 characters in each of 30 names; that is why this record is never fed back to the agent or a model.
//
// SLICE 3, THE FAKES' LEDGERS (one port, `ServiceUsageRecordInput.fakes`): each fake server of the round keeps a request ledger, and a summary of it (`FakeLedgerSummary`, fake-helper.ts) is read while the fake still runs. What the record keeps of it is a row
// of five counts per fake (matched, unmatched, made-up, armed faults, calls from an address that is not the check sandbox), each a coarse bucket (`bucketCount`), and NOTHING the program sent: no path, no host, no header, no
// body. A fake whose ledger cannot be read, was not trusted (a malformed line, a ledger past its bound), or whose summary is past its limits is `ledger: "unreadable"` with nothing counted, never "no calls"; the broker
// reads that as "could not be checked" and fails the usage step.
//
// The record is the broker contract's `TestServicesUsageRecord` (contracts/src/test-services-usage.ts, s1-broker T1); the tests parse every record this module builds with `TestServicesUsageRecordSchema`.
import {
  AwsOperationNameSchema, AwsServiceKeySchema, TEST_SERVICES_AWS_USAGE_LIMITS, TEST_SERVICES_USAGE_LIMITS, TEST_SERVICES_USAGE_SCHEMA_VERSION, TestServicesAwsUsageSchema, hostProblem, looksLikeSecretValue, registrableDomain,
  type TestServicesAwsUsage, type TestServicesDependencyUsage, type TestServicesFakeUsage, type TestServicesStartFailure, type TestServicesUsageRecord,
} from "@agentx/contracts";
import { readSealedDnsRecord, type SealedDnsRecord } from "./check-sandbox.js";
import { EmulatorControlError } from "./emulator-control.js";
import { EmulatorLedgerError, type EmulatorLedger, type EmulatorLedgerPort } from "./emulator-ledger.js";
import type { FakeUsagePort } from "./fake-usage.js";
import type { ServiceRedactor } from "./service-env.js";
import type { ResetOutcome, ServiceSession } from "./service-runner.js";
import type { DockerCli } from "./swebench/containers.js";

export type ServiceUsageRecord = TestServicesUsageRecord;
export type DependencyUsageRecord = TestServicesDependencyUsage;
export type UsageFailure = TestServicesStartFailure;
type UnknownCalls = TestServicesUsageRecord["unknownCalls"];

const USAGE_LIMITS = TEST_SERVICES_USAGE_LIMITS;
/** The most registrable domains one record names. */
export const USAGE_UNKNOWN_DOMAINS_MAX = USAGE_LIMITS.unknownDomains;
/** The longest wait for one dependency's health question when the record is built. */
export const USAGE_HEALTH_LIMIT_MS = 5_000;
/** The longest wait for the emulator's ledger when the record is built (one control call). */
export const USAGE_LEDGER_LIMIT_MS = 15_000;

export interface ServiceUsageRecordInput {
  /** The dependency ids the task's plan named, in order (at most USAGE_LIMITS.dependencies are recorded). One with no helper in the session is `started: false`. */
  planned: readonly string[];
  /** The run's session. Absent when the run's start failed: then nothing is `started`. */
  session?: Pick<ServiceSession, "helpers" | "probe">;
  /** Milliseconds each dependency took to start, by id, or one number for the whole start. Absent: 0. */
  startMs?: ReadonlyMap<string, number> | number;
  /** Successful resets by id (`countResets` gives them). Absent: 0. */
  resetCounts?: ReadonlyMap<string, number>;
  /** What the caller knows went wrong, by id (a seed that failed, an image that did not pull). Used for a dependency that is not healthy, and for a healthy one only when it is `seed_failed` or `reset_failed`. */
  failures?: ReadonlyMap<string, TestServicesStartFailure>;
  /** The sealed name server's record, as `readSealedDnsRecord` returned it, or where to read it. Absent: the round had no sealed name server, so no names. */
  dns?: SealedDnsRecord | { docker: DockerCli; dnsHelperName: string };
  /** The run's redactor (`createServiceRedactor(helperSecretValues(...))`). Required: a record is never built without one. */
  redactor: ServiceRedactor;
  healthLimitMs?: number;
  /**
   * Slice 2, the ONE port for Rovara local AWS's request ledger (`emulatorLedgerPort(target)` of emulator-ledger.ts, bound to the round's own emulator while it still runs). Present only when the run started an emulator. A port
   * that throws or never answers within the health limit gives `aws: { ledger: "unreadable" }`; absent, the record has no `aws` field at all (slice 1's record, byte for byte).
   */
  emulator?: EmulatorLedgerPort;
  /** The longest the ledger port may take. Default USAGE_LEDGER_LIMIT_MS. */
  ledgerLimitMs?: number;
  /**
   * Slice 3, the ONE port for the round's fake servers: reads each fake's ledger summary, bound to the round's own fakes while they still run. Present only when the run started a fake. A summary that is missing (undefined), or a
   * port that throws or never answers within the ledger limit, gives `ledger: "unreadable"` for that fake; absent, the record has no `fakes` field at all (the earlier slices' record, byte for byte).
   */
  fakes?: FakeUsagePort;
}


/** The coarse buckets of a count, as lower bounds: 1, 2 (2-5), 6 (6-20), 21 (21 or more). */
export const USAGE_COUNT_BUCKETS: readonly number[] = [1, 2, 6, 21];
/** The lower bound of the bucket `count` falls in; 0 stays 0. */
export function bucketCount(count: number): number {
  if (!(count >= 1)) return 0;
  return USAGE_COUNT_BUCKETS.reduce((bucket, lower) => (count >= lower ? lower : bucket), 1);
}

const clamp = (value: number | undefined, max: number): number => (value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), max) : 0);

/**
 * True when the text is safe to show: the redactor leaves it alone as it is, with its separators taken out (a secret split over labels), and in upper case (the name server lower-cases what it records, and the
 * contracts' general credential rule, an AWS key id for one, is case-sensitive).
 */
function isShowable(text: string, redactor: ServiceRedactor): boolean {
  const joined = text.replace(/[._-]/gu, "");
  return [text, joined, text.toUpperCase(), joined.toUpperCase()].every((form) => redactor.text(form) === form);
}

/** A registrable domain that may be shown: showable, a host the contract accepts, and not shaped like a key in either case. */
function isShowableDomain(domain: string, redactor: ServiceRedactor): boolean {
  return isShowable(domain, redactor) && hostProblem(domain) === undefined && !looksLikeSecretValue(domain) && !looksLikeSecretValue(domain.toUpperCase());
}

/** The registrable domains of the recorded names with their counts, and how many lookups could not be named (TS-SEAL-1: see the top of the file). */
export function reduceUnknownNames(record: SealedDnsRecord, redactor: ServiceRedactor): UnknownCalls {
  const counts = new Map<string, number>();
  let other = clamp(record.dropped, USAGE_LIMITS.count) + clamp(record.unrecorded, USAGE_LIMITS.count);
  for (const row of record.unknown) {
    const queries = clamp(row.queries, USAGE_LIMITS.count);
    if (queries === 0) continue;
    const name = row.name.toLowerCase();
    const domain = isShowable(name, redactor) ? registrableDomain(name) : undefined;
    if (domain === undefined || !isShowableDomain(domain, redactor)) {
      other += queries;
      continue;
    }
    counts.set(domain, (counts.get(domain) ?? 0) + queries);
  }
  // Bucket first, then order and cut by bucket and name, so neither the order nor the cut carries a raw count.
  const ranked = [...counts].map(([domain, count]) => [domain, bucketCount(count), count] as const).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  for (const [, , count] of ranked.slice(USAGE_UNKNOWN_DOMAINS_MAX)) other += count;
  return {
    domains: ranked.slice(0, USAGE_UNKNOWN_DOMAINS_MAX).map(([domain, bucket]) => ({ domain, count: bucket })),
    otherCount: bucketCount(Math.min(other, USAGE_LIMITS.count)),
  };
}

/**
 * Builds the record. Never throws for a dependency that cannot be asked (it is `healthy: false`) or a name server that cannot be read (no names). Call it while the run's services are still up: the health question
 * and the name server's file are both read now.
 */
export async function buildServiceUsageRecord(input: ServiceUsageRecordInput): Promise<TestServicesUsageRecord> {
  const started = new Set((input.session?.helpers ?? []).map((helper) => helper.id));
  const limit = input.healthLimitMs ?? USAGE_HEALTH_LIMIT_MS;
  const startMsOf = (id: string): number => clamp(typeof input.startMs === "number" ? input.startMs : input.startMs?.get(id), USAGE_LIMITS.startMs);
  const dependencies: TestServicesDependencyUsage[] = [];
  for (const id of input.planned.slice(0, USAGE_LIMITS.dependencies)) {
    const isStarted = started.has(id);
    const healthy = isStarted && input.session !== undefined ? await input.session.probe(id, limit).then((answer) => answer === true, () => false) : false;
    const told = input.failures?.get(id);
    const failure: TestServicesStartFailure | undefined = healthy ? (told === "seed_failed" || told === "reset_failed" ? told : undefined) : told ?? (isStarted ? "not_healthy" : "start_failed");
    dependencies.push({
      id, started: isStarted, healthy,
      startMs: isStarted ? startMsOf(id) : 0,
      resetCount: isStarted ? clamp(input.resetCounts?.get(id), USAGE_LIMITS.resets) : 0,
      ...(failure === undefined ? {} : { failure }),
    });
  }
  const dns = input.dns === undefined ? undefined : "unknown" in input.dns ? input.dns : await readSealedDnsRecord(input.dns.docker, input.dns.dnsHelperName).catch(() => undefined);
  const unknownCalls = dns === undefined ? { domains: [], otherCount: 0 } : reduceUnknownNames(dns, input.redactor);
  const aws = input.emulator === undefined ? undefined : await readAwsUsage(input.emulator, input.redactor, input.ledgerLimitMs ?? USAGE_LEDGER_LIMIT_MS);
  const fakes = input.fakes === undefined ? undefined : await readFakeUsage(input.fakes, input.planned, input.ledgerLimitMs ?? USAGE_LEDGER_LIMIT_MS);
  return { schemaVersion: TEST_SERVICES_USAGE_SCHEMA_VERSION, dependencies, unknownCalls, ...(aws === undefined ? {} : { aws }), ...(fakes === undefined ? {} : { fakes }) };
}

// ---- the fakes' ledgers

/** What the record says of a fake whose ledger could not be read: nothing, and that it could not be read. */
export const unreadableFakeUsage = (id: string): TestServicesFakeUsage => ({ id, ledger: "unreadable", matched: 0, unmatched: 0, synthesized: 0, faults: 0, foreign: 0 });

/**
 * Reads the fakes' summaries through the port with at most `limitMs` to answer, and reduces each to a row of buckets. Never throws: a port that fails or stays silent makes every fake `unreadable`. Only ids in `planned` get a row
 * (the port is the worker's own, but the record is built from what the PLAN named). At most one row per id; the port answers for every fake of the round (a fake it cannot read is `summary: undefined`).
 */
export async function readFakeUsage(port: FakeUsagePort, planned: readonly string[], limitMs: number): Promise<TestServicesFakeUsage[]> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const silence = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RangeError("silence")); }, Math.max(1, limitMs)); });
  let answers: Awaited<ReturnType<FakeUsagePort>> = [];
  try {
    answers = await Promise.race([port(controller.signal), silence]);
  } catch {
    controller.abort();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const wanted = new Set(planned);
  const rows = new Map<string, TestServicesFakeUsage>();
  for (const answer of answers) {
    if (!wanted.has(answer.id) || rows.has(answer.id)) continue;
    const summary = answer.summary;
    rows.set(answer.id, summary === undefined || !summary.trusted ? unreadableFakeUsage(answer.id) : {
      id: answer.id, ledger: "read", matched: bucketCount(summary.matched), unmatched: bucketCount(summary.unmatched), synthesized: bucketCount(summary.synthesized), faults: bucketCount(summary.faults), foreign: bucketCount(summary.foreign),
    });
  }
  return [...rows.values()];
}

/** Adds two `fakes` rows lists of one run (the rounds' records): counts add (they are lower bounds, so their sums are too), and a ledger unreadable in either round is unreadable. A fake in only one of them is kept as it is. */
export function mergeFakeUsage(earlier: readonly TestServicesFakeUsage[] | undefined, later: readonly TestServicesFakeUsage[] | undefined): TestServicesFakeUsage[] | undefined {
  if (earlier === undefined) return later === undefined ? undefined : [...later];
  if (later === undefined) return [...earlier];
  const max = USAGE_LIMITS.count;
  const merged = new Map<string, TestServicesFakeUsage>(earlier.map((row) => [row.id, row]));
  for (const row of later) {
    const before = merged.get(row.id);
    if (before === undefined) { merged.set(row.id, row); continue; }
    if (before.ledger !== "read" || row.ledger !== "read") { merged.set(row.id, unreadableFakeUsage(row.id)); continue; }
    merged.set(row.id, {
      id: row.id, ledger: "read", matched: Math.min(max, before.matched + row.matched), unmatched: Math.min(max, before.unmatched + row.unmatched), synthesized: Math.min(max, before.synthesized + row.synthesized),
      faults: Math.min(max, before.faults + row.faults), foreign: Math.min(max, before.foreign + row.foreign),
    });
  }
  return [...merged.values()];
}

// ---- the emulator's ledger

/** What the record says when the ledger cannot be read: nothing, and that it could not be read. */
export const UNREADABLE_AWS_USAGE: TestServicesAwsUsage = { ledger: "unreadable", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 };
/** What the record says when the code made so many different calls that the ledger was past its limits: a failure with its own word. */
export const FLOODED_AWS_USAGE: TestServicesAwsUsage = { ledger: "flooded", services: [], unsupportedOperations: [], otherCalls: 0, otherUnsupported: 0 };

const byBucketThenName = <T extends { bucket: number; name: string }>(a: T, b: T): number => b.bucket - a.bucket || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Reads the ledger through the port with at most `limitMs` to answer, and reduces it. Never throws: a failure, a ledger that does not reduce to a valid record, or silence is `UNREADABLE_AWS_USAGE`; a ledger past its
 * limits (the code flooded it with different calls) is `FLOODED_AWS_USAGE`. The port is handed an AbortSignal that aborts when the time is up, so the control call's container is stopped and removed with it.
 */
async function readAwsUsage(port: EmulatorLedgerPort, redactor: ServiceRedactor, limitMs: number): Promise<TestServicesAwsUsage> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const silence = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RangeError("silence")); }, Math.max(1, limitMs)); });
  try {
    const ledger = await Promise.race([port(controller.signal), silence]);
    const parsed = TestServicesAwsUsageSchema.safeParse(reduceAwsUsage(ledger, redactor));
    return parsed.success ? parsed.data : UNREADABLE_AWS_USAGE;
  } catch (error) {
    controller.abort();
    return (error instanceof EmulatorLedgerError && error.reason === "too_many") || (error instanceof EmulatorControlError && error.reason === "too_large") ? FLOODED_AWS_USAGE : UNREADABLE_AWS_USAGE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Reduces the emulator's ledger to the record's `aws` facts (see the top of the file). A service key shown must be a service key by shape and survive `isShowable`; an operation name is shown only for an UNSUPPORTED operation (the
 * operations that worked are in the service's call count and named nowhere), only with the operation-name shape and `isShowable`. Everything not shown is counted in `otherCalls` / `otherUnsupported`.
 */
export function reduceAwsUsage(ledger: EmulatorLedger, redactor: ServiceRedactor): TestServicesAwsUsage {
  const max = USAGE_LIMITS.count;
  let otherCalls = 0;
  let otherUnsupported = 0;
  const candidates: Array<{ bucket: number; name: string; ledger: EmulatorLedger["services"][number] }> = [];
  const merged = new Map<string, EmulatorLedger["services"][number]>();
  for (const service of ledger.services) {
    if (clamp(service.calls, max) === 0 && clamp(service.unsupported, max) === 0) continue;
    if (!AwsServiceKeySchema.safeParse(service.service).success || !isShowable(service.service, redactor)) {
      otherCalls += clamp(service.calls, max);
      otherUnsupported += clamp(service.unsupported, max);
      continue;
    }
    const before = merged.get(service.service);
    merged.set(service.service, before === undefined ? service : { ...service, calls: before.calls + service.calls, unsupported: before.unsupported + service.unsupported, operations: [...before.operations, ...service.operations] });
  }
  for (const service of merged.values()) candidates.push({ bucket: bucketCount(clamp(service.calls, max)), name: service.service, ledger: service });
  candidates.sort(byBucketThenName);
  const shown = candidates.slice(0, TEST_SERVICES_AWS_USAGE_LIMITS.services);
  for (const { ledger: service } of candidates.slice(TEST_SERVICES_AWS_USAGE_LIMITS.services)) {
    otherCalls += clamp(service.calls, max);
    otherUnsupported += clamp(service.unsupported, max);
  }
  const named = new Map<string, { service: string; operation: string; count: number }>();
  for (const { ledger: service } of shown) {
    let namedHere = 0;
    for (const row of service.operations) {
      const count = clamp(row.unsupported, max);
      if (count === 0) continue;
      if (AwsOperationNameSchema.safeParse(row.operation).success && isShowable(row.operation, redactor)) {
        const key = `${service.service}\0${row.operation}`;
        named.set(key, { service: service.service, operation: row.operation, count: (named.get(key)?.count ?? 0) + count });
        namedHere += count;
      }
    }
    // The service's unsupported calls that no shown operation name accounts for.
    otherUnsupported += Math.max(0, clamp(service.unsupported, max) - namedHere);
  }
  const rankedOps = [...named.values()].map((row) => ({ bucket: bucketCount(row.count), name: `${row.service}\0${row.operation}`, row })).sort(byBucketThenName);
  for (const { row } of rankedOps.slice(TEST_SERVICES_AWS_USAGE_LIMITS.unsupportedOperations)) otherUnsupported += row.count;
  return {
    ledger: "read",
    services: shown.map(({ ledger: service }) => ({ service: service.service, calls: bucketCount(clamp(service.calls, max)), unsupported: bucketCount(clamp(service.unsupported, max)) })).filter((row) => row.calls >= 1),
    unsupportedOperations: rankedOps.slice(0, TEST_SERVICES_AWS_USAGE_LIMITS.unsupportedOperations).map(({ bucket, row }) => ({ service: row.service, operation: row.operation, count: bucket })),
    otherCalls: bucketCount(Math.min(otherCalls, max)),
    otherUnsupported: bucketCount(Math.min(otherUnsupported, max)),
  };
}

/** Adds two `aws` facts of one run (the rounds' records): services and operations sum (counts are lower bounds, so their sums are too), the lists are cut again, and a ledger unreadable in either is unreadable. */
export function mergeAwsUsage(earlier: TestServicesAwsUsage | undefined, later: TestServicesAwsUsage | undefined): TestServicesAwsUsage | undefined {
  if (earlier === undefined) return later;
  if (later === undefined) return earlier;
  if (earlier.ledger === "flooded" || later.ledger === "flooded") return FLOODED_AWS_USAGE;
  if (earlier.ledger === "unreadable" || later.ledger === "unreadable") return UNREADABLE_AWS_USAGE;
  const max = USAGE_LIMITS.count;
  const services = new Map<string, { calls: number; unsupported: number }>();
  for (const row of [...earlier.services, ...later.services]) {
    const before = services.get(row.service);
    services.set(row.service, { calls: Math.min(max, (before?.calls ?? 0) + row.calls), unsupported: Math.min(max, (before?.unsupported ?? 0) + row.unsupported) });
  }
  const operations = new Map<string, { service: string; operation: string; count: number }>();
  for (const row of [...earlier.unsupportedOperations, ...later.unsupportedOperations]) {
    const key = `${row.service}\0${row.operation}`;
    operations.set(key, { ...row, count: Math.min(max, (operations.get(key)?.count ?? 0) + row.count) });
  }
  const rankedServices = [...services].sort((a, b) => b[1].calls - a[1].calls || (a[0] < b[0] ? -1 : 1));
  const rankedOps = [...operations.values()].sort((a, b) => b.count - a.count || (a.service + a.operation < b.service + b.operation ? -1 : 1));
  const overflowCalls = rankedServices.slice(TEST_SERVICES_AWS_USAGE_LIMITS.services).reduce((sum, [, row]) => sum + row.calls, 0);
  const overflowUnsupported = rankedServices.slice(TEST_SERVICES_AWS_USAGE_LIMITS.services).reduce((sum, [, row]) => sum + row.unsupported, 0) + rankedOps.slice(TEST_SERVICES_AWS_USAGE_LIMITS.unsupportedOperations).reduce((sum, row) => sum + row.count, 0);
  return {
    ledger: "read",
    services: rankedServices.slice(0, TEST_SERVICES_AWS_USAGE_LIMITS.services).map(([service, row]) => ({ service, calls: row.calls, unsupported: row.unsupported })),
    unsupportedOperations: rankedOps.slice(0, TEST_SERVICES_AWS_USAGE_LIMITS.unsupportedOperations),
    otherCalls: Math.min(max, earlier.otherCalls + later.otherCalls + overflowCalls),
    otherUnsupported: Math.min(max, earlier.otherUnsupported + later.otherUnsupported + overflowUnsupported),
  };
}

/**
 * Counts the resets a run does: the returned session is the given one with `reset` wrapped, and `resets` holds the successful ones by dependency id. Hand the returned session to `seedRun`, `freshHelpers` and
 * `resetForNextCheck` (service-reset.ts), and `resets` to `buildServiceUsageRecord`. A reset that throws is not counted.
 */
export function countResets<S extends Pick<ServiceSession, "reset">>(session: S): { session: S; resets: ReadonlyMap<string, number> } {
  const resets = new Map<string, number>();
  const counted = Object.create(session, {
    reset: {
      value: async (id: string, signal?: AbortSignal): Promise<ResetOutcome> => {
        const outcome = await session.reset(id, signal);
        resets.set(id, (resets.get(id) ?? 0) + 1);
        return outcome;
      },
    },
  }) as S;
  return { session: counted, resets };
}
