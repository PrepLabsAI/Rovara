// K1 C5a: "what the agent loaded", one record per stage run.
//
// The record is made of references only. It says which rule files, skills and sources a stage used (or found and left out) and why, with the
// SHA-256 of what the agent saw. It never carries rule text, skill text or a quote: the task page fetches the text on demand, through a route
// that checks the viewer can read the repository, and serves it only while it still hashes to the recorded digest.
import { z } from "zod";
import { MAX_META_SKILLS, MetaSkillSkipReasonSchema, MetaSkillSnapshotSchema } from "./knowledge-skills.js";

export const LOADED_KNOWLEDGE_STAGES = ["understand", "plan", "plan_check", "build", "review"] as const;
export const LoadedKnowledgeStageSchema = z.enum(LOADED_KNOWLEDGE_STAGES);
export type LoadedKnowledgeStage = z.infer<typeof LoadedKnowledgeStageSchema>;

/** The most items one record lists: loaded ones first, then what was left out. */
export const MAX_LOADED_KNOWLEDGE_ITEMS = 300;
/**
 * The most bytes a record's JSON may take. A worker event is bounded at 64 KiB and a larger payload is dropped whole, so the record is cut
 * well inside that (the event carries a little more than the record, and credential redaction can lengthen strings).
 */
export const MAX_LOADED_KNOWLEDGE_BYTES = 48 * 1024;

export const LoadedKnowledgeRoleSchema = z.enum(["CRITIC", "SECURITY"]);

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const Label = z.string().min(1).max(200);

export const LoadedKnowledgeWhySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }).strict(),
  z.object({ kind: z.literal("required") }).strict(),
  z.object({ kind: z.literal("matched"), detail: Label }).strict(),
  z.object({ kind: z.literal("named"), detail: Label }).strict(),
  z.object({ kind: z.literal("read_by_tool") }).strict(),
]);

/** The fixed reasons a rule was left out. Text from a file never becomes a reason. */
export const LoadedKnowledgeSkipReasonSchema = z.enum([
  "not_matched", "not_requested", "excluded_stage", "bad_front_matter", "too_large", "over_budget", "not_in_plan_set",
  "unreadable", "symlink", "found_not_run", "duplicate", "overridden",
]);

export const LoadedKnowledgeItemSchema = z.object({
  layer: z.enum(["company", "group", "project", "meta", "repo", "folder"]),
  repo: Label.optional(),
  path: z.string().min(1).max(400).optional(),
  scopeDir: z.string().max(400),
  format: z.string().min(1).max(40),
  activation: z.enum(["always", "fileMatch", "manual", "auto"]).optional(),
  patterns: z.array(z.string().max(256)).max(20).optional(),
  name: Label.optional(),
  bytes: z.number().int().min(0).max(10_000_000),
  /** SHA-256 of what the agent saw. */
  digest: Sha256.optional(),
  /** SHA-256 of the file's bytes as stored at the commit: the task page serves the file only if it still hashes to this. */
  fileDigest: Sha256.optional(),
  readAt: z.enum(["base", "working", "knowledgeCommit"]).optional(),
  locked: z.literal(true).optional(),
  status: z.enum(["loaded", "skipped", "available"]),
  why: LoadedKnowledgeWhySchema.optional(),
  reason: LoadedKnowledgeSkipReasonSchema.optional(),
}).strict();
export type LoadedKnowledgeItem = z.infer<typeof LoadedKnowledgeItemSchema>;

export const LoadedKnowledgeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  stage: LoadedKnowledgeStageSchema,
  /** Review only: which reviewer this record is for (each reviewer has its own session and its own record). */
  role: LoadedKnowledgeRoleSchema.optional(),
  /** Set when the record was cut to fit the event size limit: the lists below are then incomplete, and `omitted` counts what was left out. */
  recordTruncated: z.literal(true).optional(),
  /** The meta repo and the commit every stage read it at. */
  metaRepo: z.object({ name: Label, knowledgeCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u) }).strict().optional(),
  /** The commit each code repository's rules were read from, when they were read from a commit (judging stages). */
  repos: z.array(z.object({ name: Label, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u).optional(), readAt: z.enum(["base", "working"]) }).strict()).max(40),
  items: z.array(LoadedKnowledgeItemSchema).max(MAX_LOADED_KNOWLEDGE_ITEMS),
  /** Items left out of `items` to keep the record small, by status (including loaded items, in the rare case even they do not fit). */
  omitted: z.object({ skipped: z.number().int().min(0), available: z.number().int().min(0), loaded: z.number().int().min(0).optional() }).strict(),
  skills: z.array(MetaSkillSnapshotSchema).max(MAX_META_SKILLS),
  skippedSkills: z.array(z.object({ path: z.string().min(1).max(400), reason: MetaSkillSkipReasonSchema }).strict()).max(MAX_META_SKILLS * 4),
  /** Context sources used (lane E fills this): counts per source label, never items or quotes. */
  sources: z.array(z.object({ label: Label, count: z.number().int().min(0).max(1_000) }).strict()).max(50),
  budget: z.object({
    alwaysOnBytes: z.number().int().min(0), alwaysOnLimitBytes: z.number().int().min(0),
    additionsBytes: z.number().int().min(0), additionsLimitBytes: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }).strict(),
}).strict();
export type LoadedKnowledgeManifest = z.infer<typeof LoadedKnowledgeManifestSchema>;

/** The progress-event field the worker carries a record in: `{ loadedKnowledge: <manifest> }`. */
export const LOADED_KNOWLEDGE_EVENT_FIELD = "loadedKnowledge";

/** The manifest in a worker progress payload, or undefined for anything else (including a malformed one: it is dropped, never partly stored). */
export function loadedKnowledgeOfProgress(payload: unknown): LoadedKnowledgeManifest | undefined {
  if (payload === null || typeof payload !== "object" || !Object.hasOwn(payload, LOADED_KNOWLEDGE_EVENT_FIELD)) return undefined;
  const parsed = LoadedKnowledgeManifestSchema.safeParse((payload as Record<string, unknown>)[LOADED_KNOWLEDGE_EVENT_FIELD]);
  return parsed.success ? parsed.data : undefined;
}

// What the task page reads. `requestId` rides on every answer and is left out by the readers (zod objects drop unknown keys).
export const LoadedKnowledgeStageRecordSchema = z.object({
  stage: LoadedKnowledgeStageSchema,
  operationId: z.string().min(1).max(80),
  recordedAt: z.string().min(1).max(40),
  role: LoadedKnowledgeRoleSchema.optional(),
  manifest: LoadedKnowledgeManifestSchema,
});
export const LoadedKnowledgeResponseReaderSchema = z.object({ stages: z.array(LoadedKnowledgeStageRecordSchema).max(100) });
export type LoadedKnowledgeResponse = z.infer<typeof LoadedKnowledgeResponseReaderSchema>;

export const LoadedKnowledgeTextReaderSchema = z.union([
  z.object({ available: z.literal(true), repo: Label, path: z.string().max(400), commit: z.string().max(64), truncated: z.boolean(), text: z.string().max(70_000) }),
  z.object({ available: z.literal(false), reason: z.enum(["not_kept", "unreadable", "changed"]) }),
]);
export type LoadedKnowledgeText = z.infer<typeof LoadedKnowledgeTextReaderSchema>;
