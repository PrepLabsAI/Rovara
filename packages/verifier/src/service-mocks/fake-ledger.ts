// The fake server's ledger, read back (test services TS23, design 4.4 and 7.4). The fake wrote it, but it is read as input from a container the candidate talks to, with System B's rules:
//   - it is trusted only if the helper was still running when the round ended: one that stopped cannot have recorded every call made to it, so nothing is counted from it;
//   - only calls from the run's sandbox address count; a call from any other address is listed as foreign and never counted as the app's;
//   - a line that does not parse, repeats a request id, or disagrees with itself (or with the pinned set, when the set is given) is malformed; a ledger with a malformed line is not trusted;
//   - a ledger that reached its bound is not trusted either: the last line says so, and what came after it was never written.
import { z } from "zod";
import type { FixtureSet } from "@rovara-code/contracts";
import { carriesCredential, MOCK_LEDGER_WITHHELD } from "../host/mock-ledger.js";
import { CORE_LEDGER_MAX_LINES } from "./fake-core.js";
import { FAKE_LEDGER_OUTCOMES, FAKE_UNMOCKED_BODY, FAKE_UNMOCKED_STATUS, fakeResponseDigest, type FakeLedgerOutcome } from "./fake-server.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const lineSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    method: z.string().min(1).max(16),
    path: z.string().max(512),
    outcome: z.enum(FAKE_LEDGER_OUTCOMES),
    host: z.string().max(253).nullable(),
    entryHash: sha.nullable(),
    fault: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u).nullable(),
    requestSha256: sha,
    responseSha256: sha,
    status: z.number().int().min(0).max(599),
    remoteAddress: z.string().min(1).max(64),
    observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => new Date(value).toISOString() === value),
  })
  .strict();
export type FakeLedgerLine = z.infer<typeof lineSchema>;

const UNMOCKED_DIGEST = fakeResponseDigest({ status: FAKE_UNMOCKED_STATUS, contentType: "application/json", body: FAKE_UNMOCKED_BODY });
/** Outcomes that are always the fixed 599 answer and name no entry. */
const FIXED_599: ReadonlySet<FakeLedgerOutcome> = new Set(["sinkhole", "foreign-caller", "overflow", "refused", "unparsed", "dropped"]);

export type FakeLedgerCounts = { matched: number; additions: number; synthesized: number; unmatched: number; faults: number; sinkholed: number };
export type ParsedFakeLedger = Readonly<{
  /** True only when the helper was still running at the end, no line is malformed and the bound was not reached. */
  trusted: boolean;
  trustProblem: "helper-stopped" | "malformed" | "overflow" | null;
  lines: readonly FakeLedgerLine[];
  malformed: number;
  overflowed: boolean;
  /** What the application's own calls came to; all zero when the helper had stopped. */
  counted: FakeLedgerCounts;
  /** Calls from an address that is not the application's (listed, never counted). */
  foreign: number;
  /** The hosts the application's unmatched and sinkholed calls were for, in the order first seen: "your tests called <host>". */
  unexpectedHosts: readonly string[];
}>;

/** Reads one fake's ledger. `fixtureSet`, when given, is the set the fake was pinned to: a line that says it answered an entry must agree with that entry. */
export function parseFakeLedger(input: Readonly<{ bytes: Uint8Array; truncated?: boolean; appAddress: string | null; helperStillRunning: boolean; fixtureSet?: FixtureSet }>): ParsedFakeLedger {
  const rows = new TextDecoder("utf-8").decode(input.bytes).split("\n");
  if (rows.at(-1) === "") rows.pop();
  const lines: FakeLedgerLine[] = [];
  const seen = new Set<string>();
  const entries = input.fixtureSet === undefined ? null : new Map(input.fixtureSet.entries.map((entry) => [entry.requestHash, entry]));
  let malformed = 0;
  let overflowed = input.truncated === true;
  rows.forEach((row, index) => {
    if (index >= CORE_LEDGER_MAX_LINES) { overflowed = true; return; }
    let line: FakeLedgerLine;
    try { line = lineSchema.parse(JSON.parse(row)); } catch { malformed += 1; return; }
    if (seen.has(line.requestId)) { malformed += 1; return; }
    seen.add(line.requestId);
    const answered = line.outcome === "matched" || line.outcome === "addition";
    const consistent = answered
      ? line.entryHash !== null && line.fault === null && (line.outcome === "addition" || entries === null || checks(entries.get(line.entryHash), line))
      : line.entryHash === null && (line.outcome === "fault") === (line.fault !== null) && (!FIXED_599.has(line.outcome) || (line.status === FAKE_UNMOCKED_STATUS && line.responseSha256 === UNMOCKED_DIGEST));
    if (!consistent) { malformed += 1; return; }
    if (line.outcome === "overflow") overflowed = true;
    lines.push(line);
  });
  const own = (line: FakeLedgerLine): boolean => input.appAddress !== null && line.remoteAddress === input.appAddress;
  const counted: FakeLedgerCounts = { matched: 0, additions: 0, synthesized: 0, unmatched: 0, faults: 0, sinkholed: 0 };
  const unexpectedHosts: string[] = [];
  let foreign = 0;
  if (input.helperStillRunning) {
    for (const line of lines) {
      if (line.outcome === "foreign-caller" || !own(line)) { foreign += 1; continue; }
      if (line.outcome === "matched") counted.matched += 1;
      else if (line.outcome === "addition") counted.additions += 1;
      else if (line.outcome === "synthesized") counted.synthesized += 1;
      else if (line.outcome === "fault") counted.faults += 1;
      else {
        if (line.outcome === "sinkhole") counted.sinkholed += 1; else counted.unmatched += 1;
        if (line.host !== null && !unexpectedHosts.includes(line.host)) unexpectedHosts.push(line.host);
      }
    }
  } else {
    foreign = lines.filter((line) => !own(line)).length;
  }
  const trustProblem = !input.helperStillRunning ? "helper-stopped" : malformed > 0 ? "malformed" : overflowed ? "overflow" : null;
  return Object.freeze({ trusted: trustProblem === null, trustProblem, lines: Object.freeze(lines), malformed, overflowed, counted, foreign, unexpectedHosts: Object.freeze(unexpectedHosts) });
}

/** A line that says it answered an entry agrees with the entry: same status, same content hash. */
function checks(entry: FixtureSet["entries"][number] | undefined, line: FakeLedgerLine): boolean {
  return entry !== undefined && line.status === entry.response.status && line.responseSha256 === fakeResponseDigest({ status: entry.response.status, contentType: entry.response.contentType, body: entry.response.body });
}

/**
 * Keeps run credentials out of what the fake recorded: the method, path and host of a line that carries one (as recorded, or after tolerant percent-decoding) are replaced by a marker. The call itself
 * is never dropped or recounted. Substring matching, so not a guarantee (see `withholdMockLedgerCredentials`).
 */
export function withholdFakeLedgerCredentials(ledger: ParsedFakeLedger, containsCredential: (bytes: Uint8Array) => boolean): ParsedFakeLedger {
  const lines = ledger.lines.map((line): FakeLedgerLine => {
    const path = carriesCredential(line.path, containsCredential);
    const host = carriesCredential(line.host, containsCredential);
    const method = carriesCredential(line.method, containsCredential);
    if (!path && !host && !method) return line;
    return { ...line, method: method ? MOCK_LEDGER_WITHHELD : line.method, path: path ? MOCK_LEDGER_WITHHELD : line.path, host: host ? MOCK_LEDGER_WITHHELD : line.host };
  });
  const unexpectedHosts = ledger.unexpectedHosts.map((host) => (carriesCredential(host, containsCredential) ? MOCK_LEDGER_WITHHELD : host));
  return Object.freeze({ ...ledger, lines: Object.freeze(lines), unexpectedHosts: Object.freeze([...new Set(unexpectedHosts)]) });
}
