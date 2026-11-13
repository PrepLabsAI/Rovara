// Shared fakes for the lessons tests. No AWS, no network: every port of packages/core/src/lessons/ports.ts has an in-memory stand-in.
import type { AccessCheckPort } from "../../../packages/core/src/lessons/access-port.js";
import type { TaskVisibilityPort } from "../../../packages/core/src/lessons/access-port.js";
import { withLessonAudiences, type LessonTaskAudience } from "../../../packages/core/src/lessons/task-audience.js";
import type { CounterDeps } from "../../../packages/core/src/lessons/counters.js";
import type { LessonDraft } from "../../../packages/core/src/lessons/reflect.js";
import type {
  AlertSink, ApproverDirectory, CitationVerifier, CorrectionJudge, LearningSpend, LessonAuditEvent, LessonAuditSink, LessonEmbedder, LessonVectors, PipelineModel, RulePublisher, StoredLessonVector,
} from "../../../packages/core/src/lessons/ports.js";
import type { LearningSettings, LearningSettingsReader } from "../../../packages/core/src/lessons/policy.js";
import type { ReflectSubject, EvidenceSpan } from "../../../packages/core/src/lessons/reflect-input.js";
import { InMemoryLessonStore } from "../../../packages/core/src/lessons/store.js";
import type { Lesson } from "../../../packages/core/src/lessons/types.js";
import type { CodeFacts } from "../../../packages/core/src/lessons/ports.js";
import { pathsToVerify, type VerifiedMaterial } from "../../../packages/core/src/lessons/render.js";
import type { PresetChange, PresetDeps } from "../../../packages/core/src/lessons/preset-setting.js";
import { classifyTier as realClassifyTier, type TierContext, type TierInput } from "../../../packages/core/src/lessons/tier.js";

import { setAutoApplyGate, setLearnedLessonsGate } from "../../../packages/core/src/lessons/policy.js";
// The learning tests exercise the model paths and the automatic path, so both gates are open here; the gates' own tests close them (clamp-auto.test.ts, outcomes-collect-while-off.test.ts).
setAutoApplyGate(() => true);
setLearnedLessonsGate(() => true);

/** The lesson vectors of an install with no embedder: nothing is stored and nothing is found. */
export const NO_VECTORS: LessonVectors = { get: async () => new Map(), put: async () => undefined, remove: async () => undefined };
/** The outcome judge of an install with no usable model: it cannot rate, so no harmful mark is ever made. */
export const REFUSING_JUDGE: CorrectionJudge = { rate: async () => { throw new Error("no model"); }, usable: async () => false };

export const WS = "org_aaaaaaaaaaaaaaaaaaaa";
export const PROJECT = "proj-1";
export const KEY = { workspaceId: WS, project: PROJECT };
export const BASE = "abcdef0123456789abcdef0123456789abcdef01";
export const MERGED = "1234567890abcdef1234567890abcdef12345678";

export class Clock { constructor(public t = 1_800_000_000_000) {} now = (): number => this.t; advance(ms: number): void { this.t += ms; } }

/** A bag-of-words embedder: the same words give the same direction, so cosine similarity tracks word overlap. It has the shape of the lessons' embedder (spec, dimension, embedMany). */
export const embedder: LessonEmbedder & { fail: boolean; calls: number; spec: string } = {
  fail: false,
  calls: 0,
  spec: "test-bow-256",
  dimension: 256,
  async embed(text: string): Promise<number[]> {
    this.calls += 1;
    if (this.fail) throw new Error("embed down");
    const v = new Array<number>(256).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9_]+/gu) ?? []) {
      let h = 2166136261;
      for (const c of word) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
      v[h % 256]! += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  },
  async embedMany(texts: readonly string[]): Promise<number[][]> { return Promise.all(texts.map((t) => this.embed(t))); },
};

/** An embedder that finds every text exactly as close as every other (cosine 1): what a small model does with a synonym swap or a close paraphrase. Real cosines are not controlled by the word-bag `embedder` above. */
export const closeEmbedder: LessonEmbedder = {
  dimension: 4, spec: "test-close-4",
  async embed() { return [1, 0, 0, 0]; },
  async embedMany(texts: readonly string[]) { return texts.map(() => [1, 0, 0, 0]); },
};

/** In-memory lesson vectors with the port's semantics: a vector of another spec is a miss, a removal takes every spec. */
export class MemoryVectors implements LessonVectors {
  rows = new Map<string, { id: string; spec: string; hash: string; vector: readonly number[] }>();
  fail = false;
  private k(ws: string, p: string, id: string): string { return `${ws}\u0001${p}\u0001${id}`; }
  async get(ws: string, p: string, spec: string, ids: readonly string[]): Promise<Map<string, StoredLessonVector>> {
    if (this.fail) throw new Error("vectors down");
    const out = new Map<string, StoredLessonVector>();
    for (const id of ids) { const row = this.rows.get(this.k(ws, p, id)); if (row !== undefined && row.spec === spec) out.set(id, { hash: row.hash, vector: row.vector }); }
    return out;
  }
  async put(ws: string, p: string, spec: string, id: string, stored: StoredLessonVector): Promise<void> {
    if (this.fail) throw new Error("vectors down");
    this.rows.set(this.k(ws, p, id), { id, spec, hash: stored.hash, vector: stored.vector });
  }
  async remove(ws: string, p: string, id: string): Promise<void> { this.rows.delete(this.k(ws, p, id)); }
  /** Older tests count vectors by id only: a vector of the test spec whose text hash matches nothing (the ranking treats it as stale and embeds the lesson again). */
  async upsert(ws: string, p: string, id: string, vector: readonly number[], _meta?: { status: string }): Promise<void> { void _meta; await this.put(ws, p, embedder.spec, id, { hash: "stale", vector }); }
}

export class ScriptedModel implements PipelineModel {
  calls: Array<Record<string, unknown>> = [];
  constructor(public replies: Array<string | Error | { text: string; costUsd: number }> = []) {}
  async complete(request: Parameters<PipelineModel["complete"]>[0]): Promise<{ text: string; costUsd: number; model: string }> {
    this.calls.push({ ...request });
    const next = this.replies.shift();
    if (next === undefined) throw new Error("no scripted reply");
    if (next instanceof Error) throw next;
    return typeof next === "string" ? { text: next, costUsd: 0.01, model: "test-model" } : { ...next, model: "test-model" };
  }
}

export class Spend implements LearningSpend {
  /** The estimates `admit` was asked about, in order. */
  asked: number[] = [];
  admitted = true;
  async admit(_workspaceId?: string, estimateUsd?: number): Promise<boolean> { if (estimateUsd !== undefined) this.asked.push(estimateUsd); return this.admitted; }
}

export class Audit implements LessonAuditSink {
  events: LessonAuditEvent[] = [];
  async emit(event: LessonAuditEvent, _options?: { required?: boolean }): Promise<void> { void _options; this.events.push(event); }
  actions(): string[] { return this.events.map((e) => e.action); }
}
export class Alerts implements AlertSink { sent: string[] = []; async alert(_w: string, _p: string, code: string): Promise<void> { this.sent.push(code); } }

// The older tests exercise the person-approval machinery (corroboration, cold start, tiers), so their settings are the Regulated preset (no lesson goes live on trial) in mode On (the project default is Suggest; a test of that says `mode: undefined`). The trial tests say `preset: "standard"`.
export const settings = (value: LearningSettings = {}): LearningSettingsReader => ({ read: async () => ({ preset: "regulated", mode: "On", ...value }) });
/** Settings for a test of the AUTO path: the pilot default is "one" (a person approves), so a test of automatic go-live says so explicitly. */
export const autoSettings = (value: LearningSettings = {}): LearningSettingsReader => settings({ tier0Approval: "auto", ...value });

export function directory(over: Partial<Awaited<ReturnType<ApproverDirectory["eligibility"]>>> = {}): ApproverDirectory & { value: Awaited<ReturnType<ApproverDirectory["eligibility"]>> } {
  const value = { complete: true, membershipVersion: 1, ownerIds: ["owner"], eligibleIds: ["owner", "ann", "bob"], lastEligibleLossAtMs: null, ...over };
  return { value, eligibility: async () => value, // As the production directory answers (`lessons/directory.ts#identity`): the reader's developer id rides on the identity, so a person is judged by the live task check as that person, never as nobody in particular.
  identity: async (_workspaceId, developerId) => ({ principals: [], groups: [], developerId }) };
}

export const facts = (): FakeFacts => defaultFacts;
export const verifier = (result: "valid" | "moved" | "stale" | "unknown" = "valid"): CitationVerifier & { calls: number } => ({
  calls: 0,
  async verify() { this.calls += 1; return result === "moved" ? { result, startLine: 20, endLine: 30 } : { result }; },
});

export class Publisher implements RulePublisher {
  published: Array<{ paragraph: string; lessonId: string }> = [];
  async publish(input: { paragraph: string; lessonId: string }): Promise<{ ruleId: string }> { this.published.push(input); return { ruleId: `rule-${this.published.length}` }; }
}

export class Judge implements CorrectionJudge {
  calls = 0;
  /** The lesson of each rating asked for, in order. */
  lessons: string[] = [];
  constructor(public answer: "caused" | "contradicts" | "unrelated" | "same_ignored" | Error = "unrelated") {}
  async rate(input?: { lesson: { id: string } }): Promise<"caused" | "contradicts" | "unrelated" | "same_ignored"> { this.calls += 1; if (input !== undefined) this.lessons.push(input.lesson.id); if (this.answer instanceof Error) throw this.answer; return this.answer; }
}

export const codeCite = (over: Record<string, unknown> = {}) => ({ kind: "code" as const, repo: "api", path: "src/retry/index.ts", startLine: 12, endLine: 30, anchor: "export function withRetry(", commit: BASE, ...over });

export function draft(over: Partial<LessonDraft> = {}): LessonDraft {
  return {
    type: "fact", title: "Retries use withRetry", description: "HTTP retries in api use withRetry.", body: "HTTP retries in the api service use withRetry from src/retry/index.ts.",
    scope: { repos: ["api"], paths: ["src/**"] }, stages: ["UNDERSTAND", "PLAN", "IMPLEMENT"], citations: [codeCite()],
    provenance: { sourceEvents: ["ev-1"], sourceKinds: ["human_edit"], authors: ["ann"], supportTasks: ["task-1"], sources: ["member:ann"], inputSources: ["member:ann"], measured: false, minTrust: "member", audience: { kind: "project" }, reflectorRun: "run-1", model: "m", memberSignal: true },
    ...over,
  };
}

/** A tier-0-shaped draft whose words are all distinct (so the curator does not merge a run of them) and all repeated from its own cited anchor (so the slot allow-list accepts them). */
export function uniqueDraft(i: number, prov: Partial<LessonDraft["provenance"]> = {}, over: Partial<LessonDraft> = {}): LessonDraft {
  const tokens = Array.from({ length: 6 }, (_, j) => `w${i}x${j}q${i * 31 + j}`);
  defaultFacts.addFile(`src/m${i}/index.ts`);
  defaultFacts.addIdentifiers(...tokens);
  // Two words of the cited code in the thing slot (the most a slot may take); the rest of the distinct words sit in the description, which tier 0 replaces.
  return draft({ title: `Helper ${i}`, description: tokens.join(" "), body: `The ${tokens.slice(0, 2).join(" ")} is in src/m${i}/index.ts.`, citations: [codeCite({ anchor: `const ${tokens.join("_")} = load();` })], provenance: { ...draft().provenance, ...prov }, ...over });
}

export function subject(spans: EvidenceSpan[], over: Partial<ReflectSubject> = {}): ReflectSubject {
  return {
    kind: "task", id: "task-1", workspaceId: WS, project: PROJECT, repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged",
    initiatorTrust: "member", initiatorId: "initiator-1", steeringTrust: ["member"], intentTrust: "member", links: ["https://github.com/acme/api/pull/7"], spans, ...over,
  };
}

export const memberSpan = (text: string, over: Partial<EvidenceSpan> = {}): EvidenceSpan => ({ kind: "human_edit", text, trust: "member", eventId: "ev-1", authorId: "ann", ...over });

export const candidateJson = (over: Record<string, unknown> = {}) => ({
  type: "convention", title: "Retries use withRetry", description: "The retry helper is called withRetry.", body: "HTTP retries in api use withRetry from src/retry/index.ts.",
  scope: { repos: ["api"], paths: ["src/**"] }, stages: ["IMPLEMENT"], citations: [codeCite()], evidenceSpanIds: ["S1"], ...over,
});
export const reply = (...candidates: unknown[]): string => JSON.stringify({ candidates });

export function newStore(): InMemoryLessonStore { return new InMemoryLessonStore(); }

export type LessonOver = Partial<Lesson>;
export function lessonRecord(over: LessonOver = {}): Lesson {
  const d = draft();
  return {
    id: "les_aaaa1111", version: 1, workspaceId: WS, project: PROJECT, scope: d.scope, type: d.type, stages: d.stages, title: d.title, description: d.description, body: d.body,
    citations: d.citations, citationChecks: [{ index: 0, result: "valid", at: 1 }], provenance: d.provenance, tier: 0, tierReasons: ["cited_fact"], status: "active",
    counters: { loaded: 0, helpful: 0, harmful: 0, citationStale: 0 }, staleAt: [], expiresAt: 1_800_000_000_000 + 90 * 86_400_000, approvals: [{ approvalId: "a", by: "system:auto", at: 1, mode: "auto" }],
    createdAt: 1, updatedAt: 1, ...over,
  };
}
export async function seed(store: InMemoryLessonStore, ...lessons: Lesson[]): Promise<void> {
  for (const lesson of lessons) await store.commit({ workspaceId: lesson.workspaceId, project: lesson.project }, await store.setVersion({ workspaceId: lesson.workspaceId, project: lesson.project }), [lesson], 1);
}

/**
 * The repository as the tests see it: files at the cited commit, the identifiers of the cited code, and the project's repositories. Everything a tier-0 lesson
 * renders must be found here; tests that need more add it (`uniqueDraft` does). Real code reads the base objects instead.
 */
export class FakeFacts implements CodeFacts {
  files = new Set<string>(["src/retry/index.ts", "src/billing/money.ts", "config/sagemaker.py", "docs/pr.md", "src/a.ts", "packages/api/client.ts", "src/lib.ts"]);
  idSet = new Set<string>(["withRetry", "retry", "axios", "buildId", "timeout", "handler", "load"]);
  repos = ["api"];
  addFile(path: string): void { this.files.add(path); }
  addIdentifiers(...ids: string[]): void { for (const id of ids) this.idSet.add(id); }
  exists(path: string): boolean {
    const prefix = path.split(/[*?]/u)[0]!.replace(/\/$/u, "");
    return prefix === "" || [...this.files].some((f) => f === path || f === prefix || f.startsWith(`${prefix}/`));
  }
  async identifiers(): Promise<string[]> { return [...this.idSet]; }
  async pathExists(input: { path: string }): Promise<boolean> { return this.exists(input.path); }
  async repositories(): Promise<string[]> { return this.repos; }
}
export const defaultFacts = new FakeFacts();
/** Verified material the way the settle step builds it, synchronously, for tests that call `classifyTier` directly. */
export function materialFor(lesson: { scope: Lesson["scope"]; citations: readonly Lesson["citations"][number][]; body: string }, facts: FakeFacts = defaultFacts): VerifiedMaterial {
  return { identifiers: new Set(facts.idSet), paths: new Set(pathsToVerify(lesson).filter((p) => facts.exists(p))), repos: new Set((lesson.scope.repos ?? []).filter((r) => facts.repos.includes(r))) };
}
/** `classifyTier` with the default verified material (a lesson whose words and paths exist in the fake repository). */
export function classifyTier(input: TierInput, context?: TierContext, floor?: { tier: 0 | 1 | 2; reasons: readonly string[] }) {
  return realClassifyTier(input.material === undefined ? { ...input, material: materialFor(input) } : input, context, floor);
}

/** An access-check port that lets every place through: for the tests that exercise the lessons themselves, not the access records. */
/** What `recordFeedback` takes: the counter ports plus the record core's access check. */
export type FeedbackDeps = CounterDeps & { access: AccessCheckPort };
/** A task open to the whole project: nobody denied, nobody named, every person asked about is on the roster. `over` changes any part of it. */
export const wideAudience = (over: Partial<LessonTaskAudience> = {}): LessonTaskAudience => ({ project: PROJECT, denied: new Set(), extras: new Set(), orgWide: false, otherProjects: new Set(), onRoster: async () => true, ...over });
/** Every task project-wide: the live check of a lesson's source tasks (`live-visibility.ts`) lets every lesson through, whoever the reader is. */
export const allSharedTasks: TaskVisibilityPort = withLessonAudiences(
  { read: async (_org, ids) => new Map(ids.map((id) => [id, { kind: "shared" as const }])) } satisfies TaskVisibilityPort,
  { read: async (_org, ids) => new Map(ids.map((id) => [id, wideAudience()])) },
);
export const allowAllAccess: AccessCheckPort = { mayRead: async (_org, _viewer, places) => places.map(() => true), taskVisibility: allSharedTasks };

/**
 * In-memory ports for the preset setting (`preset-setting.ts`): the stored preset per scope, its loosening proposals, and an authority that answers from a roster the test can change.
 * `sole` is the company's sole-owner switch (default ON).
 */
export function presetFakes(options: { eligible?: string[]; owners?: string[]; complete?: boolean; lastLossAtMs?: number | null; sole?: boolean } = {}) {
  const rows = new Map<string, "standard" | "regulated">();
  const changes = new Map<string, PresetChange>();
  const key = (s: { kind: string; project?: string }) => `${s.kind}:${s.project ?? ""}`;
  const state = { eligible: options.eligible ?? ["ann", "bob"], owners: options.owners ?? ["ann"], complete: options.complete ?? true, lastLossAtMs: options.lastLossAtMs ?? null, sole: options.sole ?? true, membershipVersion: 1, ids: 0 };
  const audit = new Audit();
  const deps: PresetDeps = {
    settings: { read: async (s) => rows.get(key(s)), write: async (s, v, _meta, from) => { if ((rows.get(key(s)) ?? "standard") !== from) return false; rows.set(key(s), v); return true; } },
    changes: {
      create: async (c) => { if (changes.has(c.id)) return false; changes.set(c.id, { ...c }); return true; },
      get: async (_s, id) => changes.get(id), open: async (s, now) => [...changes.values()].find((c) => c.state === "pending" && c.expiresAt > now && key(c.scope) === key(s)),
      transition: async (_s, id, from, to) => { const c = changes.get(id); if (c === undefined || c.state !== from) return false; c.state = to; return true; },
    },
    audit, now: () => 1_800_000_000_000, newId: () => `chg-${++state.ids}`, soleOwnerLoosening: async () => state.sole,
    authority: { eligibility: async () => ({ complete: state.complete, membershipVersion: state.membershipVersion, ownerIds: state.owners, eligibleIds: state.eligible, lastEligibleLossAtMs: state.lastLossAtMs }) },
  };
  return { deps, rows, changes, audit, state };
}
