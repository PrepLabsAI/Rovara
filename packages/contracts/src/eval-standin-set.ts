// Eval stand-ins, L4-E56: the SET file the worker writes and the stand-in helper container reads, and the SUMMARY the helper prints for the worker. Modelled on general-fakes-set.ts (same binding rules):
//
//   - the set names the company (workspace) and the task (operation) it was made for and is pinned by a digest; the helper is started with the same three values and refuses any other;
//   - it holds the PLAN (what the contract finder found for each outside host), the repository's recorded answers (cassettes), the answers the round's book already holds (so the second side of a comparison gets the
//     first side's bytes) and the per-run certificate authority (certificate AND key: the helper mints a certificate for each name a client asks for; the key never leaves the helper's own read-only mount and is never mounted
//     into the eval box);
//   - the summary repeats all three binding values, carries the counts, the answers made during the run (for the worker's book) and the names of the new connections, and the worker refuses a summary that does not match.
// Pure, no network. The helper imports this file through the narrow entry `eval-standin-helper-entry.ts`.
import { EVAL_TELEMETRY_NAMES_MAX, isEvalTelemetryId } from "./eval-telemetry-hosts.js";
import { z } from "zod";
import { sha256HexOfBytes } from "./general-fakes-set.js";
import {
  EVAL_STAND_IN_BODY_MAX_BYTES, EVAL_STAND_IN_BOOK_MAX_ENTRIES, EVAL_STAND_IN_CLASSES, EVAL_STAND_IN_COUNT_MAX, EVAL_STAND_IN_MAX_RECORDED,
  isEvalStandInHostName, reviveEvalStandInPlan, serializeEvalStandInPlan,
  type EvalStandInBookEntry, type EvalStandInCounts, type EvalStandInPlan,
} from "./eval-standin-engine.js";

/** Fixed places inside the helper's container: the worker mounts the run directory read-only at `EVAL_STAND_IN_RUN_DIR`; the helper keeps its own summary on a tmpfs. */
export const EVAL_STAND_IN_RUN_DIR = "/rovara/standin";
export const EVAL_STAND_IN_SET_PATH = `${EVAL_STAND_IN_RUN_DIR}/set.json`;
export const EVAL_STAND_IN_LEDGER_DIR = "/rovara/ledger";
export const EVAL_STAND_IN_SUMMARY_PATH = `${EVAL_STAND_IN_LEDGER_DIR}/summary.json`;
/** The plain and the TLS port the helper serves: the standard ones, because a vendor URL names no other. The helper binds them as a non-root user with no capability through one namespaced sysctl on its own container (net.ipv4.ip_unprivileged_port_start=0, see eval-standin-hosted.ts). */
export const EVAL_STAND_IN_HTTP_PORT = 80;
export const EVAL_STAND_IN_TLS_PORT = 443;
export const EVAL_STAND_IN_SET_MAX_BYTES = 12 * 1024 * 1024;
export const EVAL_STAND_IN_SUMMARY_MAX_BYTES = 4 * 1024 * 1024;
export const EVAL_STAND_IN_GAP_NAMES_MAX = 16;
export const EVAL_STAND_IN_NEW_HOSTS_MAX = 16;

const DIGEST = /^[a-f0-9]{64}$/u;
const PEM_CERT = /^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]{100,4000}\n-----END CERTIFICATE-----\n?$/u;
const PEM_KEY = /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]{100,4000}\n-----END PRIVATE KEY-----\n?$/u;
const KEY = z.string().regex(DIGEST);
const Status = z.number().int().min(200).max(599);
const AnswerBody = z.string().max(EVAL_STAND_IN_BODY_MAX_BYTES);
const BookEntrySchema = z.object({ key: KEY, status: Status, contentType: z.string().min(1).max(128), body: AnswerBody, cls: z.enum(EVAL_STAND_IN_CLASSES) }).strict();
const RecordedSchema = z.object({
  method: z.enum(["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"]), host: z.string().min(1).max(253), path: z.string().min(1).max(1_024), query: z.string().max(1_024),
  status: Status, contentType: z.string().min(1).max(128), body: AnswerBody,
}).strict().refine((entry) => isEvalStandInHostName(entry.host) && entry.path.startsWith("/"), "a recorded answer");
export type EvalStandInRecorded = z.infer<typeof RecordedSchema>;

export const EvalStandInSetSchema = z.object({
  schemaVersion: z.literal(1),
  workspaceId: z.string().uuid(),
  operationId: z.string().uuid(),
  plan: z.array(z.unknown()).max(32),
  recorded: z.array(RecordedSchema).max(EVAL_STAND_IN_MAX_RECORDED),
  book: z.array(BookEntrySchema).max(EVAL_STAND_IN_BOOK_MAX_ENTRIES),
  /** The run's own certificate authority. Public certificate: also written into the box's checkout. Private key: only here. */
  ca: z.object({ certPem: z.string().regex(PEM_CERT), keyPem: z.string().regex(PEM_KEY) }).strict(),
}).strict();

export interface EvalStandInSetContent {
  readonly workspaceId: string;
  readonly operationId: string;
  readonly plan: EvalStandInPlan;
  readonly recorded: readonly EvalStandInRecorded[];
  readonly book: readonly EvalStandInBookEntry[];
  readonly ca: { readonly certPem: string; readonly keyPem: string };
}
export type ParsedEvalStandInSet = EvalStandInSetContent;

/** The bytes of a set and their digest. Undefined when anything cannot be stored or the set would be past its limit: the caller then starts no helper (the eval runs exactly as it did). */
export function buildEvalStandInSetBytes(input: EvalStandInSetContent): { bytes: Uint8Array; digest: string } | undefined {
  const plan = serializeEvalStandInPlan(input.plan);
  if (plan === undefined) return undefined;
  const set = { schemaVersion: 1 as const, workspaceId: input.workspaceId, operationId: input.operationId, plan, recorded: [...input.recorded], book: input.book.map((entry) => ({ key: entry.key, status: entry.status, contentType: entry.contentType, body: entry.body, cls: entry.cls })), ca: { ...input.ca } };
  if (!EvalStandInSetSchema.safeParse(set).success) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(set));
  if (bytes.length > EVAL_STAND_IN_SET_MAX_BYTES) return undefined;
  return { bytes, digest: sha256HexOfBytes(bytes) };
}

/** The content of a set's bytes, or undefined: the bytes must hash to the pinned digest, parse, and be bound to this company and task; the plan is checked again. Anything else is refused as a whole. */
export function parseEvalStandInSetBytes(bytes: Uint8Array, expected: { digest: string; workspaceId: string; operationId: string }): ParsedEvalStandInSet | undefined {
  if (bytes.length === 0 || bytes.length > EVAL_STAND_IN_SET_MAX_BYTES || !DIGEST.test(expected.digest) || sha256HexOfBytes(bytes) !== expected.digest) return undefined;
  let parsed: z.ZodSafeParseResult<z.infer<typeof EvalStandInSetSchema>>;
  try { parsed = EvalStandInSetSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { return undefined; }
  if (!parsed.success || parsed.data.workspaceId !== expected.workspaceId || parsed.data.operationId !== expected.operationId) return undefined;
  const plan = reviveEvalStandInPlan(parsed.data.plan);
  if (plan === undefined) return undefined;
  return { workspaceId: parsed.data.workspaceId, operationId: parsed.data.operationId, plan, recorded: parsed.data.recorded, book: parsed.data.book, ca: parsed.data.ca };
}

// ---- the summary

const Count = z.number().int().min(0).max(EVAL_STAND_IN_COUNT_MAX);
const GapName = z.object({ method: z.string().regex(/^[A-Z]{1,16}$/u), host: z.string().min(1).max(253), path: z.string().max(160), cls: z.enum(["generated", "generated_no_contract", "new_connection"]) }).strict();
export type EvalStandInGapName = z.infer<typeof GapName>;
/**
 * What the helper says it did: counts, the answers it made (for the book), and a few names. `trusted: false` carries nothing (a summary that could not be read says nothing: the worker then treats the run as one that
 * hit gaps). `foreign` are connections from any address but the one box it serves (closed unanswered); `refused` are requests refused before an answer (too large, unparsed). `tlsFailed` are TLS handshakes a client abandoned
 * (most often a client that does not trust the run's certificate authority, or one that pins a certificate: Rovara cannot stand in for those, and the PR says so).
 */
export const EvalStandInSummarySchema = z.discriminatedUnion("trusted", [
  z.object({ schemaVersion: z.literal(1), trusted: z.literal(false) }).strict(),
  z.object({
    schemaVersion: z.literal(1), trusted: z.literal(true),
    workspaceId: z.string().uuid(), operationId: z.string().uuid(), digest: z.string().regex(DIGEST),
    counts: z.object({ recorded: Count, generated: Count, generatedNoContract: Count, newConnections: Count, served: Count, gapCalls: Count, saturated: z.boolean() }).strict(),
    foreign: Count, refused: Count, tlsFailed: Count,
    /** Answers made during this run that the book did not hold: the worker keeps them for the next run of the round. */
    additions: z.array(BookEntrySchema).max(EVAL_STAND_IN_BOOK_MAX_ENTRIES),
    gaps: z.array(GapName).max(EVAL_STAND_IN_GAP_NAMES_MAX),
    newHosts: z.array(z.string().min(1).max(253)).max(EVAL_STAND_IN_NEW_HOSTS_MAX),
    /** L4-EINT: the entries of the FIXED telemetry list the helper answered `OK` (names from that list only; a call to one is never a gap). */
    telemetry: z.array(z.string().refine(isEvalTelemetryId)).max(EVAL_TELEMETRY_NAMES_MAX).optional(),
  }).strict(),
]);
export type EvalStandInSummary = z.infer<typeof EvalStandInSummarySchema>;
export type TrustedEvalStandInSummary = Extract<EvalStandInSummary, { trusted: true }>;
export const UNTRUSTED_EVAL_STAND_IN_SUMMARY: EvalStandInSummary = { schemaVersion: 1, trusted: false };

/** The summary one printed line holds, or undefined (an empty line, extra text, a count past its bound, a field that is not known). */
export function parseEvalStandInSummaryText(text: string): EvalStandInSummary | undefined {
  if (text.length > EVAL_STAND_IN_SUMMARY_MAX_BYTES) return undefined;
  try {
    const lines = text.split("\n").filter((line) => line !== "");
    if (lines.length !== 1) return undefined;
    const parsed = EvalStandInSummarySchema.safeParse(JSON.parse(lines[0]!));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** A path with every long or number-heavy segment replaced by `{id}`: a name for the PR, never a value. */
export function evalStandInPathName(path: string): string {
  return path.split(/[?#]/u)[0]!.split("/").map((segment) => (segment.length > 24 || /\d{4,}/u.test(segment) || /^[0-9a-f-]{16,}$/iu.test(segment) ? "{id}" : segment)).join("/").slice(0, 160);
}

// ---- the result's counts (what the eval check carries: numbers only)

/** What the eval result and its evidence carry for stand-ins: numbers and one flag, no host, path or body. `notCompared` are the questions dropped from both sides because of a gap. */
export const EVAL_STAND_IN_RAN_AGAINST_ENGINES = ["Postgres", "MySQL", "Redis", "MongoDB"] as const;
const RanHost = z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u);
export const EvalStandInResultSchema = z.object({
  recorded: Count, generated: Count, generatedNoContract: Count, newConnections: Count, notCompared: Count, saturated: z.boolean(),
  /** L4-EINT (DEC 254zzz71): the fixed telemetry list's entries answered `OK` (names from that list only). */
  telemetry: z.array(z.string().refine(isEvalTelemetryId)).max(EVAL_TELEMETRY_NAMES_MAX).optional(),
  /** L4-EINT (E9): what the round ran against stand-ins: databases by engine name (a fixed list) and outside hosts by name (planned, in the strict host shape). */
  ranAgainst: z.object({ databases: z.array(z.enum(EVAL_STAND_IN_RAN_AGAINST_ENGINES)).max(8), hosts: z.array(RanHost).max(16) }).strict().optional(),
}).strict();
export type EvalStandInResult = z.infer<typeof EvalStandInResultSchema>;

/** What one sandbox run reports of its stand-ins (the worker's own, never the repository's): whether it hit a gap, the round's counts, the fixed telemetry entries answered, the planned outside hosts and the databases stood in (by engine). */
export interface EvalStandInRunReport {
  readonly hitGap: boolean;
  readonly counts: EvalStandInCounts;
  readonly telemetry?: readonly string[] | undefined;
  readonly hosts?: readonly string[] | undefined;
  readonly databases?: readonly (typeof EVAL_STAND_IN_RAN_AGAINST_ENGINES)[number][] | undefined;
}

/** The engine a started service's port belongs to (the same ports the dry run reads). */
export function evalStandInEngineOfPort(port: number): (typeof EVAL_STAND_IN_RAN_AGAINST_ENGINES)[number] | undefined {
  return port === 5432 ? "Postgres" : port === 3306 ? "MySQL" : port === 6379 ? "Redis" : port === 27017 ? "MongoDB" : undefined;
}

export function evalStandInResultOf(counts: EvalStandInCounts, notCompared: number, extras: { telemetry?: readonly string[]; ranAgainst?: { databases: readonly (typeof EVAL_STAND_IN_RAN_AGAINST_ENGINES)[number][]; hosts: readonly string[] } } = {}): EvalStandInResult {
  const bound = (value: number): number => Math.max(0, Math.min(EVAL_STAND_IN_COUNT_MAX, Math.trunc(Number.isFinite(value) ? value : 0)));
  const telemetry = [...new Set((extras.telemetry ?? []).filter(isEvalTelemetryId))].sort();
  const ranAgainst = extras.ranAgainst === undefined ? undefined : { databases: [...new Set(extras.ranAgainst.databases)].slice(0, 8), hosts: [...new Set(extras.ranAgainst.hosts.filter((host) => RanHost.safeParse(host).success))].slice(0, 16) };
  return { recorded: bound(counts.recorded), generated: bound(counts.generated), generatedNoContract: bound(counts.generatedNoContract), newConnections: bound(counts.newConnections), notCompared: bound(notCompared), saturated: counts.saturated,
    ...(telemetry.length === 0 ? {} : { telemetry }), ...(ranAgainst === undefined || ranAgainst.databases.length + ranAgainst.hosts.length === 0 ? {} : { ranAgainst }) };
}

/** Whether a result has anything worth a line on the PR. */
export const evalStandInHasWords = (result: EvalStandInResult): boolean => result.generated + result.generatedNoContract + result.newConnections + result.notCompared + result.recorded > 0 || (result.telemetry?.length ?? 0) > 0 || result.ranAgainst !== undefined;

const joinNames = (names: readonly string[]): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`);
/**
 * L4-EINT (E9, DEC 254zzz71): the fixed words beside the eval line. "Ran against stand-ins for Postgres and api.tiktok.com." / "3 answers were made up; both runs got the same answers." / "2 questions were not compared: ..." /
 * "Telemetry calls answered with OK: sentry.io." Names are the fixed engine words, planned host names in the strict shape and entries of the fixed telemetry list; numbers are bounded. A line is absent when it has nothing to say.
 */
export function evalStandInLines(result: EvalStandInResult): string[] {
  const lines: string[] = [];
  const ran = [...(result.ranAgainst?.databases ?? []), ...(result.ranAgainst?.hosts ?? [])];
  if (ran.length > 0) lines.push(`Ran against stand-ins for ${joinNames(ran)}.`);
  const made = result.generated + result.generatedNoContract + result.newConnections;
  if (made > 0) lines.push(`${String(made)} ${made === 1 ? "answer was" : "answers were"} made up (${String(result.generated)} from a contract, ${String(result.generatedNoContract)} with none, ${String(result.newConnections)} new ${result.newConnections === 1 ? "connection" : "connections"}). Both runs got the same answers.`);
  if (result.recorded > 0) lines.push(`${String(result.recorded)} ${result.recorded === 1 ? "answer" : "answers"} came from your own recordings.`);
  if (result.notCompared > 0) lines.push(`${String(result.notCompared)} ${result.notCompared === 1 ? "question was" : "questions were"} not compared: ${result.notCompared === 1 ? "it" : "they"} needed an answer the stand-ins had to make up.`);
  const telemetry = (result.telemetry ?? []).filter(isEvalTelemetryId);
  if (telemetry.length > 0) lines.push(`Telemetry calls answered with OK: ${[...telemetry].sort().join(", ")}.`);
  if (result.saturated) lines.push("Counts are lower bounds.");
  return lines;
}

/** The one sentence form of `evalStandInLines` (the result's own notice). */
export function evalStandInLine(result: EvalStandInResult): string {
  return evalStandInLines(result).join(" ");
}
