// Knowledge resolver (K1, C5a): the "what the agent loaded" record, built from the resolver's records.
// References only: no rule text, no skill text. Loaded items come first; skipped and available ones follow until the record is full, and the
// counts of what was left out are kept so the panel can say so.
import {
  LOADED_KNOWLEDGE_EVENT_FIELD,
  LoadedKnowledgeManifestSchema,
  MAX_LOADED_KNOWLEDGE_BYTES,
  MAX_LOADED_KNOWLEDGE_ITEMS,
  type LoadedKnowledgeItem,
  type LoadedKnowledgeManifest,
} from "@agentx/contracts";
import { inertContextText } from "../context-text.js";
import type { KnowledgeStage } from "./model.js";
import type { KnowledgeRecord, ResolvedKnowledge } from "./resolve.js";

export interface ManifestRepository {
  name: string;
  /** The commit the repository's rules were read from, when they were read from one. */
  commit?: string;
  readAt: "base" | "working";
}

/** A name or path from a repository as bounded text with no hidden characters. */
const clean = (value: string, max: number): string => inertContextText(value).text.slice(0, max);

/** One record as a manifest item, or undefined when its repository or path is nothing but hidden characters: only that entry is dropped. */
const itemOf = (record: KnowledgeRecord): LoadedKnowledgeItem | undefined => {
  const repo = record.repo === undefined ? undefined : clean(record.repo, 200);
  const path = record.path === undefined ? undefined : clean(record.path, 400);
  if (repo === "" || path === "") return undefined;
  const name = record.name === undefined ? undefined : clean(record.name, 200);
  const patterns = record.patterns?.slice(0, 20).map((pattern) => clean(pattern, 256)).filter((pattern) => pattern !== "");
  return {
    layer: record.layer,
    ...(repo === undefined ? {} : { repo }),
    ...(path === undefined ? {} : { path }),
    scopeDir: clean(record.scopeDir, 400),
    format: record.format.slice(0, 40),
    ...(record.activation === undefined ? {} : { activation: record.activation }),
    ...(patterns === undefined ? {} : { patterns }),
    // A name that was only hidden characters is left off; the entry stays.
    ...(name === undefined || name === "" ? {} : { name }),
    bytes: Math.min(record.bytes, 10_000_000),
    ...(record.digest === undefined ? {} : { digest: record.digest }),
    ...(record.fileDigest === undefined ? {} : { fileDigest: record.fileDigest }),
    ...(record.readAt === undefined ? {} : { readAt: record.readAt }),
    ...(record.locked === true ? { locked: true as const } : {}),
    status: record.status,
    ...(record.why === undefined ? {} : { why: record.why }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
};

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

export function buildLoadedKnowledgeManifest(input: {
  stage: KnowledgeStage;
  resolved: ResolvedKnowledge;
  /** Every record so far, including rules loaded during the run (`MidRunKnowledge.allRecords()`); the resolver's own when absent. */
  records?: readonly KnowledgeRecord[];
  repositories: readonly ManifestRepository[];
  meta?: { name: string; knowledgeCommit: string };
  role?: "CRITIC" | "SECURITY";
  sources?: readonly { label: string; count: number }[];
}): LoadedKnowledgeManifest {
  const all = (input.records ?? input.resolved.records).map(itemOf).filter((item): item is LoadedKnowledgeItem => item !== undefined);
  const rank = (status: LoadedKnowledgeItem["status"]): number => (status === "loaded" ? 0 : status === "skipped" ? 1 : 2);
  const ordered = all.toSorted((left, right) => rank(left.status) - rank(right.status));
  const skills = input.resolved.skills.map((skill) => ({ ...skill, path: clean(skill.path, 400) })).filter((skill) => skill.path !== "");
  const skippedSkills = input.resolved.skippedSkills.slice(0, 128).map((skill) => ({ ...skill, path: clean(skill.path, 400) })).filter((skill) => skill.path !== "");
  const base = {
    schemaVersion: 1 as const,
    stage: input.stage,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.meta === undefined ? {} : { metaRepo: { name: input.meta.name, knowledgeCommit: input.meta.knowledgeCommit } }),
    repos: input.repositories.slice(0, 40).map((repository) => ({ name: repository.name, ...(repository.commit === undefined ? {} : { commit: repository.commit }), readAt: repository.readAt })),
    skills, skippedSkills,
    sources: (input.sources ?? []).slice(0, 50).map((source) => ({ label: source.label.slice(0, 200), count: Math.min(source.count, 1_000) })),
    budget: input.resolved.budget,
  };
  // The record is cut by serialized size, not only by count: a worker event over 64 KiB is dropped whole. Loaded items stay first; what
  // does not fit is counted in `omitted`, and the record says it was cut.
  const build = (count: number): LoadedKnowledgeManifest => {
    const items = ordered.slice(0, count);
    const left = ordered.slice(count);
    const cut = left.length > 0;
    return {
      ...base, ...(cut ? { recordTruncated: true as const } : {}), items,
      omitted: { skipped: left.filter((item) => item.status === "skipped").length, available: left.filter((item) => item.status === "available").length, ...(left.some((item) => item.status === "loaded") ? { loaded: left.filter((item) => item.status === "loaded").length } : {}) },
    };
  };
  let count = Math.min(ordered.length, MAX_LOADED_KNOWLEDGE_ITEMS);
  let manifest = build(count);
  if (jsonBytes(manifest) > MAX_LOADED_KNOWLEDGE_BYTES) {
    // Binary search for the most items that fit (size grows with the count).
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (jsonBytes(build(middle)) <= MAX_LOADED_KNOWLEDGE_BYTES) low = middle; else high = middle - 1;
    }
    count = low;
    manifest = build(count);
    // Even the fixed parts (skills, sources) can be large in theory; drop them last rather than lose the record.
    if (jsonBytes(manifest) > MAX_LOADED_KNOWLEDGE_BYTES) manifest = { ...manifest, skippedSkills: [], sources: [], skills: manifest.skills.slice(0, 8), recordTruncated: true };
  }
  // A record that does not validate is a bug here; the worker reports nothing rather than something the broker will refuse.
  return LoadedKnowledgeManifestSchema.parse(manifest);
}

/** The progress-event payload that carries a record to the control plane. */
export const loadedKnowledgePayload = (manifest: LoadedKnowledgeManifest): Record<string, unknown> => ({ [LOADED_KNOWLEDGE_EVENT_FIELD]: manifest });
