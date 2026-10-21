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
  observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine((value) => new Date(value).toISOString() === value) }).strict();

export type ConsumptionLine = Readonly<{ kind: "consumption"; line: MockLedgerLine & { variantId: "success" | "refusal" | "invalid-data" }; variant: Readonly<{ status: number; body: unknown }> }>;
export type UnmatchedLine = Readonly<{ kind: "unmatched"; line: MockLedgerLine }>;
export type ParsedMockLedger = Readonly<{ origin: string; componentId: string | null; inputField: string | null; lines: readonly (ConsumptionLine | UnmatchedLine)[]; malformed: number; overflowed: boolean }>;

/**
 * Reads one origin's ledger. The mock container wrote it, but it is read as input from a container the candidate talks to: a line counts as a consumption only when every
 * field agrees with the approved fixture's variant, and a line that does not parse or agree is counted malformed, which the binding treats as an unmocked call.
 * The sinkhole has no fixture, so none of its lines can be a consumption.
 */
export function parseMockLedger(input: Readonly<{ origin: string; componentId: string | null; fixture: E2EApiMockFixture | null; bytes: Uint8Array;
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
    lines.push({ kind: "consumption", line: { ...line, variantId: parsed.variantId }, variant: { status: variant.status, body: variant.body ?? null } });
  });
  return Object.freeze({ origin: input.origin, componentId: input.componentId, inputField: input.fixture?.inputField ?? null, lines: Object.freeze(lines), malformed, overflowed });
}

export type CaseWindow = Readonly<{ caseId: string; startMs: number; endMs: number }>;
export type BoundConsumption = Readonly<{ origin: string; componentId: string; inputField: string; line: ConsumptionLine["line"]; variant: ConsumptionLine["variant"] }>;
export type BoundUnmocked = Readonly<{ origin: string; kind: "unmatched" | "malformed" | "ledger-overflow"; requestId: string; method: string; path: string; observedAt: string }>;
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
      const row: BoundUnmocked = { origin: ledger.origin, kind: "unmatched", requestId: entry.line.requestId, method: entry.line.method, path: entry.line.path, observedAt: entry.line.observedAt };
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
