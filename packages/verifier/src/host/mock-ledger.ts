import { z } from "zod";
import type { E2EApiMockFixture } from "@agentx/contracts";
import { SINKHOLE_ORIGIN_REF } from "../application-mocks.js";
import { MOCK_LEDGER_MAX_LINES, MOCK_UNMOCKED_RESPONSE_DIGEST, MOCK_UNMOCKED_STATUS, mockRequestDigest, mockResponseDigest, type MockLedgerLine } from "../executor/mock-server.js";

/** The origin name of the sinkhole every declared origin without an approved mock points at. */
export const SINKHOLE_ORIGIN = SINKHOLE_ORIGIN_REF;
/** The most consumption rows, and the most unmocked-call rows, one case carries in its frame. */
export const MOCK_ROWS_PER_CASE = 100;

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const lineSchema = z.object({ requestId: z.string().min(1).max(200), method: z.string().min(1).max(16), path: z.string().max(512), inputValue: z.string().max(128).nullable(),
  variantId: z.enum(["success", "refusal", "invalid-data"]).nullable(), status: z.number().int().min(100).max(599), requestSha256: sha, responseSha256: sha,
  remoteAddress: z.string().min(1).max(64),
  observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => new Date(value).toISOString() === value) }).strict();

export type ConsumptionLine = Readonly<{ kind: "consumption"; line: MockLedgerLine & { variantId: "success" | "refusal" | "invalid-data" }; variant: Readonly<{ status: number; body: unknown }> }>;
/** `reason` is set when a line that matches the fixture is not a consumption because the caller was not the application container. */
export type UnmatchedLine = Readonly<{ kind: "unmatched"; line: MockLedgerLine; reason?: "foreign-caller" }>;
export type ParsedMockLedger = Readonly<{ origin: string; componentId: string | null; inputField: string | null; lines: readonly (ConsumptionLine | UnmatchedLine)[]; malformed: number; overflowed: boolean }>;

/**
 * Reads one origin's ledger. The mock container wrote it, but it is read as input from a container the candidate talks to: a line counts as a consumption only when every
 * field agrees with the approved fixture's variant, and a line that does not parse or agree is counted malformed, which the binding treats as an unmocked call.
 * The sinkhole has no fixture, so none of its lines can be a consumption.
 */
export function parseMockLedger(input: Readonly<{ origin: string; componentId: string | null; fixture: E2EApiMockFixture | null; bytes: Uint8Array;
  /** The application container's address on the run network. A line that matches the fixture counts as a consumption only when it came from this address; with none known, none does. */
  appAddress: string | null;
  /** True when the ledger file was longer than what `bytes` holds: the rest was never read, which is an overflow. */ truncated?: boolean }>): ParsedMockLedger {
  const text = new TextDecoder("utf-8").decode(input.bytes);
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  const lines: (ConsumptionLine | UnmatchedLine)[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let overflowed = input.truncated === true;
  rows.forEach((row, index) => {
    if (index >= MOCK_LEDGER_MAX_LINES) { overflowed = true; return; }
    let parsed: z.infer<typeof lineSchema>;
    try { parsed = lineSchema.parse(JSON.parse(row)); } catch { malformed += 1; return; }
    if (seen.has(parsed.requestId) || mockRequestDigest(parsed) !== parsed.requestSha256) { malformed += 1; return; }
    seen.add(parsed.requestId);
    const line: MockLedgerLine = parsed;
    if (parsed.variantId === null) {
      if (parsed.status !== MOCK_UNMOCKED_STATUS || parsed.responseSha256 !== MOCK_UNMOCKED_RESPONSE_DIGEST) { malformed += 1; return; }
      lines.push({ kind: "unmatched", line });
      return;
    }
    const variant = input.fixture?.variants.find((candidate) => candidate.id === parsed.variantId);
    if (!input.fixture || !variant || parsed.method !== input.fixture.method || parsed.path !== input.fixture.path || parsed.inputValue !== variant.inputValue
      || parsed.status !== variant.status || parsed.responseSha256 !== mockResponseDigest({ status: variant.status, body: variant.body ?? null })) { malformed += 1; return; }
    // The page of the candidate, the executor or any other container may reach a mock too: what they ask is never evidence that the application did.
    if (input.appAddress === null || parsed.remoteAddress !== input.appAddress) { lines.push({ kind: "unmatched", line, reason: "foreign-caller" }); return; }
    lines.push({ kind: "consumption", line: { ...line, variantId: parsed.variantId }, variant: { status: variant.status, body: variant.body ?? null } });
  });
  return Object.freeze({ origin: input.origin, componentId: input.componentId, inputField: input.fixture?.inputField ?? null, lines: Object.freeze(lines), malformed, overflowed });
}

/** The most percent-decoding passes a recorded field gets before it is checked for a credential: enough for layered encoding, bounded so a hostile value cannot loop. */
const MAX_PERCENT_DECODE_PASSES = 4;
const hexValue = (byte: number): number => (byte >= 0x30 && byte <= 0x39 ? byte - 0x30 : byte >= 0x41 && byte <= 0x46 ? byte - 0x37 : byte >= 0x61 && byte <= 0x66 ? byte - 0x57 : -1);
/** One pass of form decoding over bytes that never throws: a valid `%XX` becomes its byte, any other `%` stays as it is, and `+` becomes a space. */
function percentDecodeTolerant(bytes: Buffer): Buffer {
  const out: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte === 0x25 && index + 2 < bytes.length && hexValue(bytes[index + 1]!) >= 0 && hexValue(bytes[index + 2]!) >= 0) {
      out.push(hexValue(bytes[index + 1]!) * 16 + hexValue(bytes[index + 2]!)); index += 2;
    } else out.push(byte === 0x2b ? 0x20 : byte);
  }
  return Buffer.from(out);
}

/** What replaces a ledger field that carried a run credential. */
export const MOCK_LEDGER_WITHHELD = "[credential]";

/**
 * Keeps run credentials out of what the mocks recorded. The app sees the run's passwords when the executor signs in through its form, and a mock records the method, path and
 * input of every call verbatim, so a hostile app could carry one into the unmocked-call evidence and the display (`http://mock-unbound:8080/<password>`). Each field that the
 * run's credential check matches, as recorded or after any of up to four tolerant percent-decoding passes (so a malformed escape elsewhere, or double encoding, does not
 * hide it), is replaced by a fixed marker. The call itself is never dropped: a line that carried a credential is always an unmatched call (a consumption is never made of
 * withheld text), so its case stays UNKNOWN `unmocked-external-call`.
 *
 * This is substring matching, like the app-log and capture redaction, so it is not a guarantee: a credential split across calls, written in hex, reversed, or in any other
 * reversible encoding (or encoded more than four times) is not recognized. The impact is low because each credential is random, per run, and for a throwaway account.
 */
export function withholdMockLedgerCredentials(ledger: ParsedMockLedger, containsCredential: (bytes: Uint8Array) => boolean): ParsedMockLedger {
  const carries = (value: string | null): boolean => {
    if (value === null || value.length === 0) return false;
    let current: Buffer = Buffer.from(value, "utf8");
    if (containsCredential(current)) return true;
    for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
      const next = percentDecodeTolerant(current);
      if (next.equals(current)) return false;
      if (containsCredential(next)) return true;
      current = next;
    }
    return false;
  };
  const lines = ledger.lines.map((entry): ConsumptionLine | UnmatchedLine => {
    const { line } = entry;
    const method = carries(line.method); const path = carries(line.path); const input = carries(line.inputValue);
    if (!method && !path && !input) return entry;
    const withheld: MockLedgerLine = { ...line, variantId: null, method: method ? MOCK_LEDGER_WITHHELD : line.method, path: path ? MOCK_LEDGER_WITHHELD : line.path,
      inputValue: input ? MOCK_LEDGER_WITHHELD : line.inputValue };
    return Object.freeze(entry.kind === "unmatched" && entry.reason !== undefined ? { kind: "unmatched" as const, line: withheld, reason: entry.reason } : { kind: "unmatched" as const, line: withheld });
  });
  return Object.freeze({ ...ledger, lines: Object.freeze(lines) });
}

export type CaseWindow = Readonly<{ caseId: string; startMs: number; endMs: number }>;
export type BoundConsumption = Readonly<{ origin: string; componentId: string; inputField: string; line: ConsumptionLine["line"]; variant: ConsumptionLine["variant"] }>;
export type BoundUnmocked = Readonly<{ origin: string; kind: "unmatched" | "foreign-caller" | "malformed" | "ledger-overflow"; requestId: string; method: string; path: string; observedAt: string }>;
export type BoundCase = Readonly<{ consumptions: readonly BoundConsumption[]; unmocked: readonly BoundUnmocked[] }>;

/**
 * Gives each ledger line to the case whose executor action window holds it. A consumption outside every window, or inside two, belongs to no case (it can never make a case
 * pass). A call no mock matched is never dropped: inside a window it belongs to that case, and anywhere else, like a malformed line or an overflowed ledger, to every case.
 */
export function bindMockLedgers(input: Readonly<{ ledgers: readonly ParsedMockLedger[]; windows: readonly CaseWindow[]; caseIds: readonly string[]; fallbackAt?: string }>): Map<string, BoundCase> {
  const consumptions = new Map<string, BoundConsumption[]>(input.caseIds.map((caseId) => [caseId, []]));
  const unmocked = new Map<string, BoundUnmocked[]>(input.caseIds.map((caseId) => [caseId, []]));
  const fallbackAt = input.fallbackAt ?? "1970-01-01T00:00:00.000Z";
  const holders = (instant: number) => {
    const ids = [...new Set(input.windows.filter((window) => instant >= window.startMs && instant <= window.endMs).map((window) => window.caseId))];
    return ids.filter((caseId) => consumptions.has(caseId));
  };
  const everyCase = (row: BoundUnmocked) => { for (const rows of unmocked.values()) rows.push(row); };
  for (const ledger of input.ledgers) {
    for (const entry of ledger.lines) {
      const holding = holders(Date.parse(entry.line.observedAt));
      if (entry.kind === "consumption") {
        if (holding.length === 1 && ledger.componentId !== null && ledger.inputField !== null) {
          consumptions.get(holding[0]!)!.push({ origin: ledger.origin, componentId: ledger.componentId, inputField: ledger.inputField, line: entry.line, variant: entry.variant });
        }
        continue;
      }
      const row: BoundUnmocked = { origin: ledger.origin, kind: entry.reason ?? "unmatched", requestId: entry.line.requestId, method: entry.line.method, path: entry.line.path, observedAt: entry.line.observedAt };
      if (holding.length === 0) everyCase(row); else for (const caseId of holding) unmocked.get(caseId)!.push(row);
    }
    if (ledger.malformed > 0) everyCase({ origin: ledger.origin, kind: "malformed", requestId: `${ledger.origin}-malformed`, method: "UNKNOWN", path: "/", observedAt: fallbackAt });
    if (ledger.overflowed) everyCase({ origin: ledger.origin, kind: "ledger-overflow", requestId: `${ledger.origin}-overflow`, method: "UNKNOWN", path: "/", observedAt: fallbackAt });
  }
  const bound = new Map<string, BoundCase>();
  for (const caseId of input.caseIds) {
    const own = [...consumptions.get(caseId)!].sort((a, b) => a.line.observedAt.localeCompare(b.line.observedAt) || a.line.requestId.localeCompare(b.line.requestId));
    const calls = [...unmocked.get(caseId)!];
    // A frame holds a bounded number of rows; the rows that do not fit are not lost silently, they make the case UNKNOWN like any call no mock matched.
    const kept = own.slice(0, MOCK_ROWS_PER_CASE);
    if (own.length > kept.length) calls.push({ origin: own[MOCK_ROWS_PER_CASE]!.origin, kind: "ledger-overflow", requestId: `${own[MOCK_ROWS_PER_CASE]!.origin}-consumption-overflow-${caseId}`.slice(0, 200),
      method: "UNKNOWN", path: "/", observedAt: fallbackAt });
    bound.set(caseId, Object.freeze({ consumptions: Object.freeze(kept), unmocked: Object.freeze(calls.slice(0, MOCK_ROWS_PER_CASE)) }));
  }
  return bound;
}
