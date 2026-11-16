// General fakes, slice 2b (owner decision 252a; plan briefs/general-fakes-plan.md, slice 2b): the files and words of the HOSTED fake-helper container. In a hosted task sandbox the fake cannot be a loopback server of the worker
// (the sandbox is another container), so it is a small container from the worker's own image on the run's own network (worker/src/general-fakes-hosted.ts launches it; worker/src/general-fakes-helper.ts is the program).
//
// What lives here, pure and with no network call: the SET the worker writes and the helper reads (the fakes the worker built from the customer's OpenAPI descriptions, in serialized form, bound to ONE company and ONE task and
// pinned by a digest), the SUMMARY the helper prints for the worker (counts of what it answered), and the fixed words. The helper imports this file through the narrow entry `general-fakes-helper-entry.ts`, never the
// package barrel.
//
// Binding (fail closed): the set names the workspace (the company) and the operation (the task) it was made for, the helper is started with the same two ids and the set's digest, and refuses a set whose ids or digest
// differ; the summary repeats all three and the worker refuses a summary that does not match what it started. A set for another company or task is never served and never believed.
import { createHash } from "node:crypto";
import { z } from "zod";
import { GENERAL_FAKES_MAX_SERVICES, GENERAL_FAKE_REASONS, type GeneralFakeReason } from "./general-fakes.js";
import { OPENAPI_FAKE_LIMITS, reviveOpenApiFake, serializeOpenApiFake, type OpenApiFake, type SerializedOpenApiFake } from "./openapi-fake.js";

/** What every answer of a Rovara-made fake carries, as a response header: the answer is "Made by Rovara", never change proof. Also on the fixed "cannot answer" answers. */
export const GENERAL_FAKE_ANSWER_HEADER = "x-rovara-label";
export const GENERAL_FAKE_ANSWER_LABEL = "madeByRovara";
/** The one answer of a call the fake cannot serve (no body of the customer's is echoed). */
export const GENERAL_FAKE_CANNOT_ANSWER_BODY = JSON.stringify({ error: "rovara_fake_cannot_answer" });
/** The port the helper serves on (not privileged: the helper's container takes no sysctl and no capability). */
export const GENERAL_FAKES_HELPER_PORT = 8080;
/** Where the launcher mounts the run's directory (read-only) and the helper's own tmpfs (the summary file). Fixed: the program takes no path argument. */
export const GENERAL_FAKES_RUN_DIR = "/rovara/fakes";
export const GENERAL_FAKES_SET_PATH = `${GENERAL_FAKES_RUN_DIR}/set.json`;
export const GENERAL_FAKES_LEDGER_DIR = "/rovara/ledger";
export const GENERAL_FAKES_SUMMARY_PATH = `${GENERAL_FAKES_LEDGER_DIR}/summary.json`;
/** The most bytes a set file may weigh, and the most calls a summary counts exactly (past it the summary says "saturated" and the worker marks every check). */
export const GENERAL_FAKES_SET_MAX_BYTES = 4 * 1024 * 1024;
export const GENERAL_FAKES_SUMMARY_MAX_COUNT = 100_000;
export const GENERAL_FAKES_SUMMARY_MAX_BYTES = 4 * 1024;

const DIGEST = /^[a-f0-9]{64}$/u;
const NOT_BUILT_REASONS = ["no_spec", "spec_unreadable", "spec_ambiguous"] as const satisfies readonly GeneralFakeReason[];
export type GeneralFakeNotBuiltReason = (typeof NOT_BUILT_REASONS)[number];

const ServiceEntrySchema = z.union([
  z.object({ status: z.literal("built"), fake: z.custom<SerializedOpenApiFake>((value) => reviveOpenApiFake(value) !== undefined, "a fake") }).strict(),
  z.object({ status: z.literal("not_built"), reason: z.enum(NOT_BUILT_REASONS) }).strict(),
]);
export const GeneralFakesSetSchema = z.object({
  schemaVersion: z.literal(1),
  /** The company (the worker's workspace) and the task (the operation) this set was made for. */
  workspaceId: z.string().uuid(),
  operationId: z.string().uuid(),
  /** One entry per configured service, in the order of the setting: entry n answers `/s/<n>`. */
  services: z.array(ServiceEntrySchema).min(1).max(GENERAL_FAKES_MAX_SERVICES),
}).strict();
export type GeneralFakesSet = z.infer<typeof GeneralFakesSetSchema>;

export type GeneralFakeServiceFake = { readonly status: "built"; readonly fake: OpenApiFake } | { readonly status: "not_built"; readonly reason: GeneralFakeReason };

export const sha256HexOfBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The bytes of a set for these fakes (JSON, no extra whitespace) and their digest. Undefined when a fake cannot be stored or the set would be past its size limit: the caller then starts no helper. */
export function buildGeneralFakesSetBytes(input: { workspaceId: string; operationId: string; fakes: readonly GeneralFakeServiceFake[] }): { bytes: Uint8Array; digest: string } | undefined {
  const services = input.fakes.map((entry) => {
    if (entry.status === "built") { const fake = serializeOpenApiFake(entry.fake); return fake === undefined ? undefined : { status: "built" as const, fake }; }
    return (NOT_BUILT_REASONS as readonly string[]).includes(entry.reason) ? { status: "not_built" as const, reason: entry.reason as GeneralFakeNotBuiltReason } : undefined;
  });
  if (services.some((entry) => entry === undefined)) return undefined;
  const set = { schemaVersion: 1 as const, workspaceId: input.workspaceId, operationId: input.operationId, services: services as GeneralFakesSet["services"] };
  if (!GeneralFakesSetSchema.safeParse(set).success) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(set));
  if (bytes.length > GENERAL_FAKES_SET_MAX_BYTES) return undefined;
  return { bytes, digest: sha256HexOfBytes(bytes) };
}

/**
 * The fakes of a set's bytes, or undefined. The bytes must hash to `expected.digest` (the digest the worker pinned in the helper's arguments), parse as a set, and be bound to `expected.workspaceId` and
 * `expected.operationId`. Anything else (too big, another digest, another company or task, a fake that does not revive) is refused as a whole.
 */
export function parseGeneralFakesSetBytes(bytes: Uint8Array, expected: { digest: string; workspaceId: string; operationId: string }): GeneralFakeServiceFake[] | undefined {
  if (bytes.length === 0 || bytes.length > GENERAL_FAKES_SET_MAX_BYTES || !DIGEST.test(expected.digest) || sha256HexOfBytes(bytes) !== expected.digest) return undefined;
  let parsed: z.ZodSafeParseResult<GeneralFakesSet>;
  try { parsed = GeneralFakesSetSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { return undefined; }
  if (!parsed.success || parsed.data.workspaceId !== expected.workspaceId || parsed.data.operationId !== expected.operationId) return undefined;
  const fakes: GeneralFakeServiceFake[] = [];
  for (const entry of parsed.data.services) {
    if (entry.status === "not_built") { fakes.push({ status: "not_built", reason: entry.reason }); continue; }
    const fake = reviveOpenApiFake(entry.fake);
    if (fake === undefined) return undefined;
    fakes.push({ status: "built", fake });
  }
  return fakes;
}

// ---- the summary

const Count = z.number().int().min(0).max(GENERAL_FAKES_SUMMARY_MAX_COUNT);
/**
 * What the helper says it did, and nothing else: counts. `trusted: false` carries no counts (a summary that could not be read says nothing). `served` are calls a fake answered; `cannotAnswer` are calls it
 * answered with its fixed "cannot answer"; `foreign` are connections from any address but the one sandbox it serves (closed unanswered); `unrouted` are requests for a path no service answers (a fixed 404); `refused` are requests it refused before answering (too large).
 * `saturated` means a counter reached its limit, so the counts are lower bounds: the worker then marks every check of the round.
 */
export const GeneralFakesSummarySchema = z.discriminatedUnion("trusted", [
  z.object({ schemaVersion: z.literal(1), trusted: z.literal(false) }).strict(),
  z.object({
    schemaVersion: z.literal(1), trusted: z.literal(true),
    workspaceId: z.string().uuid(), operationId: z.string().uuid(), digest: z.string().regex(DIGEST),
    served: Count,
    cannotAnswer: z.object({ no_spec: Count, spec_unreadable: Count, spec_ambiguous: Count, operation_unknown: Count, operation_unsupported: Count }).strict(),
    foreign: Count, unrouted: Count, refused: Count, saturated: z.boolean(),
  }).strict(),
]);
export type GeneralFakesSummary = z.infer<typeof GeneralFakesSummarySchema>;
export type TrustedGeneralFakesSummary = Extract<GeneralFakesSummary, { trusted: true }>;
export const UNTRUSTED_GENERAL_FAKES_SUMMARY: GeneralFakesSummary = { schemaVersion: 1, trusted: false };

/** The reasons a call can be counted under, in the order the worker blames them: `start_failed` is the worker's own and is never in a summary. */
export const GENERAL_FAKES_COUNTED_REASONS = GENERAL_FAKE_REASONS.filter((reason): reason is Exclude<GeneralFakeReason, "start_failed"> => reason !== "start_failed");

/** The summary one printed line holds, or undefined (an empty line, extra text, a count past its bound, a field that is not known). Never "no calls". */
export function parseGeneralFakesSummaryText(text: string): GeneralFakesSummary | undefined {
  if (text.length > GENERAL_FAKES_SUMMARY_MAX_BYTES) return undefined;
  try {
    const lines = text.split("\n").filter((line) => line !== "");
    if (lines.length !== 1) return undefined;
    const parsed = GeneralFakesSummarySchema.safeParse(JSON.parse(lines[0]!));
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

/** The limits a set is held to, for tests and for the helper's own message-free refusals. */
export const GENERAL_FAKES_SET_LIMITS = { bytes: GENERAL_FAKES_SET_MAX_BYTES, services: GENERAL_FAKES_MAX_SERVICES, operations: OPENAPI_FAKE_LIMITS.operations } as const;
