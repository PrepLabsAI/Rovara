// Test services where the fakes are kept, reviewed and handed out. A fake is a FixtureSet v2, pinned by the digest of its canonical JSON.
//
// What this module guarantees, all of it fail closed:
//   - Behind `tx`: with the switch off every function answers `disabled` and touches neither port, so nothing is stored, listed, signed or readable. There is no route here: the callers that exist
//     once the switch is on (the setup agent's recorder, the review card, the task plan) call these functions.
//   - Org-scoped: a set lives under `private/<org>/fixtures/<digest>` and has the store id `fxs:<org>:<digest>`. The org comes from the CALLER's session, never from the id: a store id naming another
//     org, a digest only another org holds and a digest nobody holds all answer the same `not_found`, so the store is not a way to learn what another company has recorded. The same digest in two orgs is two objects.
//   - Never public: the object port writes with the install's KMS key and no public access (that is the adapter's contract); this module only ever asks for a 15-minute signed read of ONE key.
//   - Reviewed before it is used: a submitted set is parsed (v2, 2,000 entries, 4 MiB, every entry under its own hash), scanned for personal data, credentials and production names with the org's deny list, and
//     stored `pending`. Only an approval makes it deliverable; a scan finding stops the submission, so a set with a finding is never stored at all.
//   - Delivered by digest: `deliver` mints a 15-minute read URL for an APPROVED set and re-reads the stored bytes first, so a stored object that no longer hashes to its digest is never handed out. The worker
//     checks the digest again after it downloads (`worker/src/fixture-fetch.ts`).
//   - Approving is one decision on one set; a decided set cannot be decided again, and a set cannot be approved by the digest of a different one. An approved set can be WITHDRAWN (and is then no longer
//     delivered); a rejected or withdrawn set stays so.
//   - The scan sees everything a person or a recorder wrote: every string value, every object key (a schema's property names) and every number (an enum, a minimum, a maximum), not only strings. It runs at
//     submit, and AGAIN, with the org's deny list as it is NOW, at approve, at deliver and at readApproved: a production name added to the list after a set was stored stops it from being approved or handed out.
//   - A stored object that no longer hashes to its digest is repaired by the next submit of the same bytes: the submitted bytes replace it with a conditional write (only if the object is still the one that was
//     read), so one bad write does not leave a set stuck for good.
//
// What a CALLER must guarantee (this module cannot see the session; it checks that the caller said so, and which of these it can check it does):
//   - `approve`, `reject` and `withdraw` take a `VerifiedFixtureDecision`, which only `verifiedFixtureDecision` mints, and only for a MAINTAINER of the org. A bare actor string, an object written by hand, a spread
//     copy, a structured clone or a copy of its symbol is refused (`unauthorised`): the module keeps the decisions it minted in a private WeakSet and accepts nothing else. The route that calls
//     `verifiedFixtureDecision` has checked the session's role.
//   - A decision is for ONE action on ONE digest (`action` and `digest` are given when it is minted) and is single-use: the first decision that passes those checks removes it, so pressing twice, or reusing it
//     for another action or another set, is refused.
//   - The org comes from the SESSION, never from the request: the decision carries the session's org and a decision for another org is refused.
//   - A HIGH set (the first recorded with a test account, or one the environment backs with `schema_synth`) is approved only with a fresh sign-in: the decision carries `signedInAt`, the time the person last signed in
//     (the confirmation page's re-check, read from the session, never from the request), and approve answers `fresh_sign_in_required` unless that was within FRESH_SIGN_IN_MINUTES (10) of the moment of use.
//   - `recordedFrom` is set by the recorder that made the set (its own code, from how it ran), and `schemaSynth` comes from the environment's backing (`schema_synth`); neither is ever read from a request.
//
// A known window: `deliver` hands out a signed read good for 15 minutes. The row is read again after the URL is signed and a set withdrawn in the meantime is refused, but a URL already handed out stays good
// until it expires (up to FIXTURE_READ_URL_SECONDS); withdrawing stops new URLs, it cannot recall one. The worker pins the digest, so what such a URL returns is still exactly the approved bytes.
import { createHash } from "node:crypto";
import {
  AGENTX_NAME_PATTERN,
  FIXTURE_SET_MAX_BYTES,
  FixtureSetSchema,
  OrgIdSchema,
  canonicalJson,
  fixtureSetDigest,
  type FixtureSet,
  type TestEnvProdDeny,
} from "@agentx/contracts";
import type { DecisionItem } from "../decisions/project.js";
import { scanText, type DataGuardFindingKind } from "@agentx/verifier";
import { plainLine } from "../decisions/text.js";

/** How long a signed read of a fake is good for (design 7.4). */
export const FIXTURE_READ_URL_SECONDS = 15 * 60;
export const FIXTURE_SAMPLE_PAIRS = 3;
const SAMPLE_CHARS = 300;
const DIGEST = /^[a-f0-9]{64}$/u;
const STORE_ID = /^fxs:(org_[0-9a-z]{20}):([a-z][a-z0-9-]{0,62}):([a-f0-9]{64})$/u;
/** A project's name, as every project name is (`AGENTX_NAME_PATTERN`). A set belongs to ONE project of an org (H1): the project is part of its row key, its store id and its object key. */
export const isFixtureProject = (project: unknown): project is string => typeof project === "string" && AGENTX_NAME_PATTERN.test(project);

/** The id of a stored set: its org, its project and its digest. Two orgs, or two projects, never share an id. */
export const fixtureStoreId = (orgId: string, project: string, digest: string): string => `fxs:${orgId}:${project}:${digest}`;
export function parseFixtureStoreId(storeId: string): { orgId: string; project: string; digest: string } | undefined {
  const found = STORE_ID.exec(storeId);
  return found === null ? undefined : { orgId: found[1]!, project: found[2]!, digest: found[3]! };
}

/** The object key of a set. `prefix` is `private` on Public Cloud (the Rovara bucket, one prefix per org); the Enterprise install gives its own bucket and key prefix to the adapter instead. Under the org's prefix the project comes first, so one project's sets never share a key with another's. */
export const fixtureObjectKey = (orgId: string, project: string, digest: string, prefix = "private"): string => `${prefix}/${orgId}/fixtures/${project}/${digest}`;

const DIGEST_TEXT = /^[a-f0-9]{64}$/u;
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const SCAN_LIMIT = 4 * 1024 * 1024;
/** Deeper than any set the schema accepts (its own schema nodes are bounded); a value nested past this is refused, not walked. */
export const FIXTURE_TEXT_MAX_DEPTH = 64;

/**
 * Everything a set says, one piece per line: every string value, every object key (a schema's property names, a map's keys) and every number turned into its digits (an enum, a minimum, a maximum, a status, a delay).
 * Only a digest (64 hex) and an exact ISO instant are skipped as text. `evidenceFindings` reads string values only, which let a card number in `minimum` or an email as a property name through.
 */
export function fixtureTexts(value: unknown, out: string[] = [], depth = 0): string[] {
  // Fail closed: a set nested deeper than any real one is not walked to the bottom, it is refused (the caller turns the throw into a finding).
  if (depth > FIXTURE_TEXT_MAX_DEPTH) throw new RangeError("fixture set nested too deep to scan");
  if (typeof value === "string") { if (!DIGEST_TEXT.test(value) && !TIMESTAMP_TEXT.test(value)) out.push(value); }
  else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) fixtureTexts(item, out, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { if (!DIGEST_TEXT.test(key)) out.push(key); fixtureTexts(item, out, depth + 1); }
  }
  return out;
}

/** The kinds of finding in a set (personal data, credentials, card numbers, the org's production names); `[]` is clean. A set too large or too deep to scan, or a scan that throws, is a finding. */
export function fixtureSetFindings(set: unknown, deny: TestEnvProdDeny): DataGuardFindingKind[] {
  try {
    const text = fixtureTexts(set).join("\n").normalize("NFKC");
    if (Buffer.byteLength(text, "utf8") > SCAN_LIMIT) return ["secret"];
    return scanText(text, deny);
  } catch { return ["secret"]; }
}

declare const verifiedBrand: unique symbol;
const BRAND = Symbol("verified-fixture-decision");
/** The decisions this module minted and that have not been used. Nothing else is a decision: a copy of an object (spread, clone, its symbol copied over) is a different object and is not in the set. */
const MINTED = new WeakSet<object>();
/** How recent the person's sign-in must be for a high set: minutes before the moment of use. */
export const FRESH_SIGN_IN_MINUTES = 10;
export type FixtureDecisionAction = "approve" | "reject" | "withdraw";
/** What a decision on a set needs: made only by `verifiedFixtureDecision`, from a session the caller has already checked. One action, one digest, one use. */
export interface VerifiedFixtureDecision {
  readonly [verifiedBrand]: true;
  readonly orgId: string;
  /** The project in the route the decision was made for (H1): a decision on a set of another project is refused. */
  readonly project: string;
  readonly actor: string;
  readonly action: FixtureDecisionAction;
  readonly digest: string;
  /** When the person last signed in (the session's, not the request's); undefined when not known. */
  readonly signedInAt: Date | undefined;
  readonly schemaSynth: boolean;
}
/**
 * Mints a decision for a maintainer's session, for one action on one digest; anything else gets `undefined`. `role`, `orgId` and `signedInAt` are the SESSION's (never the request's); `schemaSynth` is the
 * environment backing's, not the request's.
 */
export function verifiedFixtureDecision(session: {
  orgId: string; project: string; actor: string; role: string; action: FixtureDecisionAction; digest: string; signedInAt: Date | undefined; schemaSynth: boolean;
}): VerifiedFixtureDecision | undefined {
  if (session.role !== "maintainer" || !OrgIdSchema.safeParse(session.orgId).success || !isFixtureProject(session.project) || session.actor.trim() === "" || !DIGEST.test(session.digest)) return undefined;
  if (session.action !== "approve" && session.action !== "reject" && session.action !== "withdraw") return undefined;
  const decision = { orgId: session.orgId, project: session.project, actor: session.actor, action: session.action, digest: session.digest, signedInAt: session.signedInAt === undefined ? undefined : new Date(session.signedInAt.getTime()), schemaSynth: session.schemaSynth };
  // The brand is not enumerable, so it is not copied by a spread; the WeakSet is what is trusted.
  Object.defineProperty(decision, BRAND, { value: true, enumerable: false });
  Object.freeze(decision);
  MINTED.add(decision);
  return decision as unknown as VerifiedFixtureDecision;
}
/** The decision, if it is one this module minted, is unused, and is for exactly this org, project, action and digest; it is used up by the call that gets it. Anything else: undefined, and nothing is used up. */
function useDecision(decision: unknown, orgId: string, project: string, action: FixtureDecisionAction, digest: string): VerifiedFixtureDecision | undefined {
  if (typeof decision !== "object" || decision === null || !MINTED.has(decision)) return undefined;
  const found = decision as VerifiedFixtureDecision;
  if (found.orgId !== orgId || found.project !== project || found.action !== action || found.digest !== digest) return undefined;
  return MINTED.delete(decision) ? found : undefined;
}
const signedInRecently = (signedInAt: Date | undefined, at: Date): boolean => {
  if (signedInAt === undefined) return false;
  const age = at.getTime() - signedInAt.getTime();
  return age >= -60_000 && age <= FRESH_SIGN_IN_MINUTES * 60_000;
};

export type FixtureOrigin = FixtureSet["origin"];
/** Where the answers came from: a synthetic run, the company's own test account, or written by hand. A first recording from a test account raises the review card to high. */
export type FixtureRecordedFrom = "synthetic" | "test_account" | "written";

export interface FixtureRecord {
  storeId: string;
  orgId: string;
  /** The project the set was submitted for (H1). All authority over the set (read, decide, deliver, name in a plan) is that project's. */
  project: string;
  digest: string;
  dependencyId: string;
  family: string;
  protocol: FixtureSet["dependency"]["protocol"];
  origin: FixtureOrigin;
  revision: number;
  entries: number;
  faults: number;
  bytes: number;
  recordedFrom: FixtureRecordedFrom;
  /** True when no approved set of this dependency was recorded from a test account in this project before this one. */
  firstFromTestAccount: boolean;
  scanClean: boolean;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  submittedBy: string;
  submittedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  withdrawnBy?: string;
  withdrawnAt?: string;
  /** Compare-and-set counter of the row. */
  version: number;
}

/** The object store. The adapter writes with the install's KMS key, versioned, and never public. */
export interface FixtureObjectPort {
  /** Writes the object unless one is there already (same key, same bytes by construction). */
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<"created" | "exists">;
  /** Replaces the object only if it is still exactly `observed` (the adapter uses the version/ETag it read: a conditional write). "changed": someone else wrote since, nothing was written. */
  replaceIfUnchanged(key: string, observed: Uint8Array, bytes: Uint8Array, contentType: string): Promise<"replaced" | "changed">;
  get(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
  /** A signed GET for exactly this key, good for the seconds given. */
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
}
/** The index of stored sets, one row per (org, digest). */
export interface FixtureIndexPort {
  get(orgId: string, project: string, digest: string): Promise<FixtureRecord | undefined>;
  /** False when the row exists. */
  putIfAbsent(record: FixtureRecord): Promise<boolean>;
  /** Replaces the row when its `version` is the expected one; false otherwise. */
  replace(record: FixtureRecord, expectedVersion: number): Promise<boolean>;
  listByDependency(orgId: string, project: string, dependencyId: string): Promise<FixtureRecord[]>;
}

/** The production deny list of ONE project of an org (its approved environment's). */
export type FixtureDenyFor = (orgId: string, project: string) => Promise<TestEnvProdDeny>;

export interface FixtureStoreDependencies {
  /** The `tx` switch, read on every call. */
  enabled(): boolean;
  objects: FixtureObjectPort;
  index: FixtureIndexPort;
  /** The production deny list the caller knows for the PROJECT of the set (hosts, account ids, ARN prefixes). Fail closed: a list that cannot be read is an error, not an empty list. */
  denyFor: FixtureDenyFor;
  now?: () => Date;
  prefix?: string;
}

export type StoreRefusal = "disabled" | "bad_org" | "bad_project" | "bad_digest" | "not_found";
export type SubmitRefusal = StoreRefusal | "invalid" | "too_large" | "data_guard" | "digest_mismatch";
export type DecideRefusal = StoreRefusal | "already_decided" | "digest_mismatch" | "unauthorised" | "fresh_sign_in_required" | "data_guard" | "not_approved";
export type DeliverRefusal = StoreRefusal | "not_approved" | "digest_mismatch" | "data_guard";

/** What the review card shows (design 7.4): counts, the schema, three redacted sample pairs, the scan result, the ignored paths and the faults. Plain text and numbers, cut; nothing the page may follow. */
export interface FixtureReview {
  storeId: string;
  digest: string;
  dependency: FixtureSet["dependency"];
  origin: FixtureOrigin;
  revision: number;
  recordedFrom: FixtureRecordedFrom;
  counts: { entries: number; faults: number; bytes: number };
  schema: { request: string[] | null; response: string[] | null };
  samples: Array<{ method: string; path: string; query: string; requestBody: string; status: number; responseBody: string }>;
  scan: { clean: boolean };
  ignorePaths: string[];
  faults: Array<{ name: string; kind: string; status: number | null; delayMs: number }>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const cut = (text: string): string => plainLine(text, SAMPLE_CHARS);

/** The words of a schema's top level: its type and the names it lists, for the card. Never values. */
function schemaOutline(schema: FixtureSet["requestSchema"]): string[] | null {
  if (schema === undefined) return null;
  const names = Object.keys(schema.properties ?? {}).slice(0, 12).map((name) => plainLine(name, 40));
  return [`type ${schema.type}`, ...(names.length === 0 ? [] : [`fields ${names.join(", ")}`])];
}

/** The review of a set: built only from a set that parsed and is stored, so every sample pair is already scanned clean. */
export function fixtureReviewOf(record: FixtureRecord, set: FixtureSet): FixtureReview {
  return {
    storeId: record.storeId, digest: record.digest, dependency: set.dependency, origin: set.origin, revision: set.revision, recordedFrom: record.recordedFrom,
    counts: { entries: set.entries.length, faults: set.faults.length, bytes: record.bytes },
    schema: { request: schemaOutline(set.requestSchema), response: schemaOutline(set.responseSchema) },
    samples: set.entries.slice(0, FIXTURE_SAMPLE_PAIRS).map((entry) => ({
      method: entry.request.method, path: cut(entry.request.path), query: cut((entry.request.query ?? []).map((pair) => `${pair.name}=${pair.value}`).join("&")),
      requestBody: cut(entry.request.body), status: entry.response.status, responseBody: cut(entry.response.body),
    })),
    scan: { clean: record.scanClean },
    ignorePaths: set.match.ignorePaths.map((path) => plainLine(path, 200)),
    faults: set.faults.map((fault) => ({ name: fault.name, kind: fault.kind, status: fault.status ?? null, delayMs: fault.delayMs })),
  };
}

/** The decision card's item for a review (kind `approve_fixture_set`). `schemaSynth` is a property of how the environment uses the fake (its backing says `schema_synth`), so the caller says it. */
export function fixtureSetCardItem(input: {
  record: FixtureRecord;
  review: FixtureReview;
  project: string;
  /** The page that shows the whole review (a path under `/app/` or `/v1/app/`). */
  openPath: string;
  confirmPath?: string;
  taskId?: string;
  schemaSynth: boolean;
}): Extract<DecisionItem, { kind: "approve_fixture_set" }> {
  const { record, review } = input;
  const sample = (index: number, pair: FixtureReview["samples"][number]): string[] => [
    `Sample ${String(index + 1)}: ${pair.method} ${pair.path}${pair.query === "" ? "" : `?${pair.query}`}`,
    `  asks: ${pair.requestBody === "" ? "(no body)" : pair.requestBody}`,
    `  gets: ${String(pair.status)} ${pair.responseBody === "" ? "(no body)" : pair.responseBody}`,
  ];
  const details = [
    { title: "Sample answers (cut, from the recording)", lines: review.samples.flatMap((pair, index) => sample(index, pair)) },
    { title: "Schema", lines: [`Request: ${review.schema.request?.join("; ") ?? "none"}`, `Answer: ${review.schema.response?.join("; ") ?? "none"}`] },
    { title: "Ignored when matching a request", lines: review.ignorePaths.length === 0 ? ["Nothing is ignored."] : review.ignorePaths },
    { title: "Named faults", lines: review.faults.length === 0 ? ["None."] : review.faults.map((fault) => `${fault.name}: ${fault.kind}${fault.status === null ? "" : ` ${String(fault.status)}`}, after ${String(fault.delayMs)} ms`) },
    { title: "Where it came from", lines: [record.recordedFrom === "test_account" ? "Recorded with the company's test account." : record.recordedFrom === "written" ? "Written by hand." : "Recorded from synthetic inputs.", `Revision ${String(review.revision)}.`] },
  ];
  return {
    kind: "approve_fixture_set", subjectId: record.digest.slice(0, 40), ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    project: input.project, title: `Answers for ${review.dependency.id}`, createdAt: record.submittedAt, openPath: input.openPath, ...(input.confirmPath === undefined ? {} : { confirmPath: input.confirmPath }),
    // The card is bound to the digest: a different set is a different card, and an earlier "evidence opened" is worth nothing for it.
    contentVersion: record.digest, details,
    dependency: review.dependency.id, origin: review.origin, entries: review.counts.entries, faults: review.counts.faults, scanClean: review.scan.clean,
    schemaSynth: input.schemaSynth, firstFromTestAccount: record.firstFromTestAccount,
    ...(record.status === "approved" ? { outcome: "approved" as const } : record.status === "rejected" ? { outcome: "rejected" as const } : {}),
  };
}

export interface FixtureStore {
  submit(orgId: string, project: string, raw: unknown, input: { actor: string; recordedFrom: FixtureRecordedFrom }): Promise<{ ok: true; record: FixtureRecord; created: boolean } | { ok: false; reason: SubmitRefusal }>;
  record(orgId: string, project: string, digest: string): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: StoreRefusal }>;
  review(orgId: string, project: string, digest: string): Promise<{ ok: true; review: FixtureReview; record: FixtureRecord } | { ok: false; reason: StoreRefusal | "digest_mismatch" }>;
  approve(orgId: string, project: string, digest: string, decision: VerifiedFixtureDecision): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: DecideRefusal }>;
  reject(orgId: string, project: string, digest: string, decision: VerifiedFixtureDecision): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: DecideRefusal }>;
  /** Takes an approved set out of delivery for good (`not_approved` for a set that is not approved; a pending one is rejected instead). */
  withdraw(orgId: string, project: string, digest: string, decision: VerifiedFixtureDecision): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: DecideRefusal }>;
  /** The 15-minute read URL for an approved set of THIS org and THIS project. */
  deliver(orgId: string, project: string, digest: string): Promise<{ ok: true; url: string; digest: string; storeId: string; expiresAt: string; bytes: number } | { ok: false; reason: DeliverRefusal }>;
  /** The same, from a store id (the task plan names one): the id's org and project must be the caller's. */
  deliverById(callerOrgId: string, callerProject: string, storeId: string): ReturnType<FixtureStore["deliver"]>;
  /** The approved set itself, with the stored bytes checked against the digest. */
  readApproved(orgId: string, project: string, digest: string): Promise<{ ok: true; set: FixtureSet } | { ok: false; reason: DeliverRefusal }>;
}

export function createFixtureStore(deps: FixtureStoreDependencies): FixtureStore {
  const now = deps.now ?? (() => new Date());
  const prefix = deps.prefix ?? "private";
  const keyOf = (orgId: string, project: string, digest: string): string => fixtureObjectKey(orgId, project, digest, prefix);
  const gate = (orgId: string, project: string, digest?: string): StoreRefusal | undefined => {
    if (!deps.enabled()) return "disabled";
    if (!OrgIdSchema.safeParse(orgId).success) return "bad_org";
    if (!isFixtureProject(project)) return "bad_project";
    if (digest !== undefined && !DIGEST.test(digest)) return "bad_digest";
    return undefined;
  };
  /** The row of THIS org and THIS project; a row that says another org or another project (a corrupt index) is not found either (H1). */
  const rowOf = async (orgId: string, project: string, digest: string): Promise<FixtureRecord | undefined> => {
    const row = await deps.index.get(orgId, project, digest);
    return row !== undefined && row.orgId === orgId && row.project === project && row.digest === digest && row.storeId === fixtureStoreId(orgId, project, digest) ? row : undefined;
  };
  /** The stored bytes of a row, parsed, and held against the digest. Undefined: nothing stored; "mismatch": the object is not the set the digest names. */
  const load = async (orgId: string, project: string, digest: string): Promise<{ set: FixtureSet; bytes: number } | "mismatch" | undefined> => {
    const bytes = await deps.objects.get(keyOf(orgId, project, digest), FIXTURE_SET_MAX_BYTES + 1);
    if (bytes === undefined) return undefined;
    if (bytes.length > FIXTURE_SET_MAX_BYTES || sha256(bytes) !== digest) return "mismatch";
    let parsed: FixtureSet;
    try { parsed = FixtureSetSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { return "mismatch"; }
    return fixtureSetDigest(parsed) === digest ? { set: parsed, bytes: bytes.length } : "mismatch";
  };
  /** The current scan of a loaded set, with the deny list of the set's project as it is now. */
  const scanNow = async (orgId: string, project: string, set: FixtureSet): Promise<boolean> => fixtureSetFindings(set, await deps.denyFor(orgId, project)).length === 0;
  const decide = async (orgId: string, project: string, digest: string, decision: VerifiedFixtureDecision, status: "approved" | "rejected" | "withdrawn"): Promise<{ ok: true; record: FixtureRecord } | { ok: false; reason: DecideRefusal }> => {
    const refused = gate(orgId, project, digest);
    if (refused !== undefined) return { ok: false, reason: refused };
    // The decision must be one the module minted and has not seen used, for THIS org (the session's), THIS project (the route's), THIS action and THIS digest, by a maintainer; it is used up here.
    const action: FixtureDecisionAction = status === "approved" ? "approve" : status === "rejected" ? "reject" : "withdraw";
    const verified = useDecision(decision, orgId, project, action, digest);
    if (verified === undefined) return { ok: false, reason: "unauthorised" };
    const row = await rowOf(orgId, project, digest);
    if (row === undefined) return { ok: false, reason: "not_found" };
    if (status === "withdrawn") { if (row.status !== "approved") return { ok: false, reason: "not_approved" }; }
    else if (row.status !== "pending") return { ok: false, reason: "already_decided" };
    if (status === "approved") {
      // High: the first recording from a test account, or an environment that answers the unrecorded from the schema. It is approved only with a fresh sign-in.
      if ((row.firstFromTestAccount || verified.schemaSynth) && !signedInRecently(verified.signedInAt, now())) return { ok: false, reason: "fresh_sign_in_required" };
      // A set that was stored but no longer hashes to its digest, or that is gone, is never approved; and it is scanned again with today's deny list.
      const loaded = await load(orgId, project, digest);
      if (loaded === undefined || !row.scanClean) return { ok: false, reason: "not_found" };
      if (loaded === "mismatch") return { ok: false, reason: "digest_mismatch" };
      if (!(await scanNow(orgId, project, loaded.set))) return { ok: false, reason: "data_guard" };
    }
    const at = now().toISOString();
    const next: FixtureRecord = status === "withdrawn"
      ? { ...row, status, withdrawnBy: plainLine(verified.actor, 120), withdrawnAt: at, version: row.version + 1 }
      : { ...row, status, decidedBy: plainLine(verified.actor, 120), decidedAt: at, version: row.version + 1 };
    return (await deps.index.replace(next, row.version)) ? { ok: true, record: next } : { ok: false, reason: "already_decided" };
  };
  /** Makes sure the object at the key is the submitted bytes: writes it when absent, and replaces one that does not hash to the digest (conditional on it being unchanged since it was read). */
  const ensureObject = async (key: string, bytes: Uint8Array, digest: string): Promise<"ok" | "mismatch"> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((await deps.objects.putIfAbsent(key, bytes, "application/json")) === "created") return "ok";
      const current = await deps.objects.get(key, FIXTURE_SET_MAX_BYTES + 1);
      if (current === undefined) continue;
      if (current.length <= FIXTURE_SET_MAX_BYTES && sha256(current) === digest) return "ok";
      if ((await deps.objects.replaceIfUnchanged(key, current, bytes, "application/json")) === "replaced") return "ok";
    }
    return "mismatch";
  };

  const deliver: FixtureStore["deliver"] = async (orgId, project, digest) => {
    const refused = gate(orgId, project, digest);
    if (refused !== undefined) return { ok: false, reason: refused };
    const row = await rowOf(orgId, project, digest);
    if (row === undefined) return { ok: false, reason: "not_found" };
    if (row.status !== "approved") return { ok: false, reason: "not_approved" };
    const loaded = await load(orgId, project, digest);
    if (loaded === undefined) return { ok: false, reason: "not_found" };
    if (loaded === "mismatch") return { ok: false, reason: "digest_mismatch" };
    if (!(await scanNow(orgId, project, loaded.set))) return { ok: false, reason: "data_guard" };
    const url = await deps.objects.presignGet(keyOf(orgId, project, digest), FIXTURE_READ_URL_SECONDS);
    // Read again after signing: a set withdrawn while the URL was being made is not handed out (the URL is dropped).
    const after = await rowOf(orgId, project, digest);
    if (after === undefined || after.status !== "approved") return { ok: false, reason: "not_approved" };
    return { ok: true, url, digest, storeId: row.storeId, expiresAt: new Date(now().getTime() + FIXTURE_READ_URL_SECONDS * 1000).toISOString(), bytes: loaded.bytes };
  };

  return {
    async submit(orgId, project, raw, input) {
      const refused = gate(orgId, project);
      if (refused !== undefined) return { ok: false, reason: refused };
      const parsed = FixtureSetSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: "invalid" };
      const set = parsed.data;
      const canonical = canonicalJson(set);
      const bytes = new TextEncoder().encode(canonical);
      if (bytes.length > FIXTURE_SET_MAX_BYTES) return { ok: false, reason: "too_large" };
      // The scan covers every string, key and number the set holds (paths, queries, bodies, header values, schema property names, enums and limits), with the org's own deny list; a finding stops the submission and nothing is stored.
      if (!(await scanNow(orgId, project, set))) return { ok: false, reason: "data_guard" };
      const digest = sha256(bytes);
      if (digest !== fixtureSetDigest(set)) return { ok: false, reason: "invalid" };
      const existing = await rowOf(orgId, project, digest);
      if (existing !== undefined) {
        // The row is there: the object is made right if a bad write left it wrong.
        return (await ensureObject(keyOf(orgId, project, digest), bytes, digest)) === "ok" ? { ok: true, record: existing, created: false } : { ok: false, reason: "digest_mismatch" };
      }
      const earlier = input.recordedFrom === "test_account" ? await deps.index.listByDependency(orgId, project, set.dependency.id) : [];
      if ((await ensureObject(keyOf(orgId, project, digest), bytes, digest)) !== "ok") return { ok: false, reason: "digest_mismatch" };
      const record: FixtureRecord = {
        storeId: fixtureStoreId(orgId, project, digest), orgId, project, digest, dependencyId: set.dependency.id, family: set.dependency.family, protocol: set.dependency.protocol, origin: set.origin, revision: set.revision,
        entries: set.entries.length, faults: set.faults.length, bytes: bytes.length, recordedFrom: input.recordedFrom,
        firstFromTestAccount: input.recordedFrom === "test_account" && !earlier.some((other) => other.recordedFrom === "test_account" && other.status === "approved"),
        scanClean: true, status: "pending", submittedBy: plainLine(input.actor, 120), submittedAt: now().toISOString(), version: 1,
      };
      if (!(await deps.index.putIfAbsent(record))) {
        const winner = await rowOf(orgId, project, digest);
        return winner === undefined ? { ok: false, reason: "not_found" } : { ok: true, record: winner, created: false };
      }
      return { ok: true, record, created: true };
    },
    async record(orgId, project, digest) {
      const refused = gate(orgId, project, digest);
      if (refused !== undefined) return { ok: false, reason: refused };
      const row = await rowOf(orgId, project, digest);
      return row === undefined ? { ok: false, reason: "not_found" } : { ok: true, record: row };
    },
    async review(orgId, project, digest) {
      const refused = gate(orgId, project, digest);
      if (refused !== undefined) return { ok: false, reason: refused };
      const row = await rowOf(orgId, project, digest);
      if (row === undefined) return { ok: false, reason: "not_found" };
      const loaded = await load(orgId, project, digest);
      if (loaded === undefined) return { ok: false, reason: "not_found" };
      if (loaded === "mismatch") return { ok: false, reason: "digest_mismatch" };
      return { ok: true, review: fixtureReviewOf(row, loaded.set), record: row };
    },
    approve: (orgId, project, digest, decision) => decide(orgId, project, digest, decision, "approved"),
    reject: (orgId, project, digest, decision) => decide(orgId, project, digest, decision, "rejected"),
    withdraw: (orgId, project, digest, decision) => decide(orgId, project, digest, decision, "withdrawn"),
    deliver,
    async deliverById(callerOrgId, callerProject, storeId) {
      const refused = gate(callerOrgId, callerProject);
      if (refused !== undefined) return { ok: false, reason: refused };
      const parsed = parseFixtureStoreId(storeId);
      // An id that names another org or another project is answered exactly as an id nobody holds.
      if (parsed === undefined || parsed.orgId !== callerOrgId || parsed.project !== callerProject) return { ok: false, reason: "not_found" };
      return deliver(callerOrgId, callerProject, parsed.digest);
    },
    async readApproved(orgId, project, digest) {
      const refused = gate(orgId, project, digest);
      if (refused !== undefined) return { ok: false, reason: refused };
      const row = await rowOf(orgId, project, digest);
      if (row === undefined) return { ok: false, reason: "not_found" };
      if (row.status !== "approved") return { ok: false, reason: "not_approved" };
      const loaded = await load(orgId, project, digest);
      if (loaded === undefined) return { ok: false, reason: "not_found" };
      if (loaded === "mismatch") return { ok: false, reason: "digest_mismatch" };
      return (await scanNow(orgId, project, loaded.set)) ? { ok: true, set: loaded.set } : { ok: false, reason: "data_guard" };
    },
  };
}

/** In-memory ports for tests and the local run. The real adapters (S3 with KMS, and a DynamoDB index) implement the same two interfaces. */
export function createMemoryFixturePorts(options: { signUrl?: (key: string, seconds: number) => string } = {}): { objects: FixtureObjectPort & { dump(): Map<string, Uint8Array> }; index: FixtureIndexPort } {
  const blobs = new Map<string, Uint8Array>();
  const rows = new Map<string, FixtureRecord>();
  const rowKey = (orgId: string, project: string, digest: string): string => `${orgId}/${project}/${digest}`;
  return {
    objects: {
      putIfAbsent: (key, bytes) => { if (blobs.has(key)) return Promise.resolve("exists"); blobs.set(key, bytes); return Promise.resolve("created"); },
      replaceIfUnchanged: (key, observed, bytes) => {
        const current = blobs.get(key);
        if (current === undefined || current.length !== observed.length || !current.every((value, index) => value === observed[index])) return Promise.resolve("changed");
        blobs.set(key, bytes);
        return Promise.resolve("replaced");
      },
      get: (key, maxBytes) => { const found = blobs.get(key); return Promise.resolve(found === undefined ? undefined : found.length > maxBytes ? found.slice(0, maxBytes) : found); },
      presignGet: (key, seconds) => Promise.resolve(options.signUrl?.(key, seconds) ?? `https://fixtures.invalid/${key}?expires=${String(seconds)}`),
      dump: () => blobs,
    },
    index: {
      get: (orgId, project, digest) => Promise.resolve(rows.get(rowKey(orgId, project, digest))),
      putIfAbsent: (record) => { const key = rowKey(record.orgId, record.project, record.digest); if (rows.has(key)) return Promise.resolve(false); rows.set(key, record); return Promise.resolve(true); },
      replace: (record, expectedVersion) => { const key = rowKey(record.orgId, record.project, record.digest); if (rows.get(key)?.version !== expectedVersion) return Promise.resolve(false); rows.set(key, record); return Promise.resolve(true); },
      listByDependency: (orgId, project, dependencyId) => Promise.resolve([...rows.values()].filter((row) => row.orgId === orgId && row.project === project && row.dependencyId === dependencyId)),
    },
  };
}
