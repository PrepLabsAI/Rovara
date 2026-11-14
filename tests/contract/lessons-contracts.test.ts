import { describe, expect, it } from "vitest";
import {
  LearnedRefsSchema, LearnedSkillSchema, LessonCandidateSchema, LessonSchema, LoadManifestSchema, MemoryInputSchema, MemorySnapshotSchema, ReflectorOutputSchema,
  WorkerInvocationSchema, skillFrontMatterRefusal, type OrgId,
} from "@agentx/contracts";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const code = { kind: "code", repo: "acme/api", path: "src/retry/index.ts", startLine: 12, endLine: 30, anchor: "export function withRetry", commit: "abc1234" };
const lesson = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "les_0123456789abcdef0123", version: 1, workspaceId: ORG, project: "web", scope: { repos: ["acme/api"], paths: ["src/retry/**"] }, type: "fact", stages: ["PLAN", "IMPLEMENT"],
  title: "Use withRetry", description: "Retries go through the shared helper.", body: "Use `withRetry` from src/retry instead of a hand-written loop.", citations: [code],
  provenance: { sourceEvents: ["rec-1"], minTrust: "member", audience: { kind: "project" }, reflectorRun: "run-1", model: "m" }, tier: 0, tierReasons: ["cited fact"], status: "candidate",
  counters: { loaded: 0, helpful: 0, harmful: 0, citationStale: 0 }, expiresAt: 1_800_000_000, approvals: [], ...extra,
});
const ok = (value: unknown) => LessonSchema.safeParse(value).success;

describe("lesson", () => {
  it("accepts a cited member fact at tier 0", () => {
    expect(ok(lesson())).toBe(true);
  });
  it("is strict: no field can grant a tool, a check, an approval, a model or a budget", () => {
    for (const field of ["tools", "grants", "commands", "allowedDomains", "models", "budget", "approvalPolicy", "checks"]) expect(ok(lesson({ [field]: ["x"] })), field).toBe(false);
  });
  it("never accepts an outsider's text", () => {
    expect(ok(lesson({ provenance: { ...(lesson().provenance as object), minTrust: "outsider" }, tier: 1, citations: [] }))).toBe(false);
  });
  it("puts reviewer stages and review checks at tier 2 only", () => {
    expect(ok(lesson({ tier: 1, type: "convention", stages: ["REVIEW"] }))).toBe(false);
    expect(ok(lesson({ tier: 2, type: "convention", stages: ["REVIEW"] }))).toBe(true);
    expect(ok(lesson({ tier: 1, type: "review_check", stages: ["PLAN"] }))).toBe(false);
    expect(ok(lesson({ tier: 0, type: "fact", stages: ["PLAN_CRITIQUE"] }))).toBe(false);
  });
  it("limits tier 0 to cited facts from trusted sources for the build stages", () => {
    expect(ok(lesson({ type: "convention" }))).toBe(false);
    expect(ok(lesson({ provenance: { ...(lesson().provenance as object), minTrust: "system" } }))).toBe(false);
    expect(ok(lesson({ provenance: { ...(lesson().provenance as object), minTrust: "rovara" } }))).toBe(true);
    expect(ok(lesson({ citations: [] }))).toBe(false);
    expect(ok(lesson({ citations: [{ kind: "task", taskId: "t1" }] }))).toBe(false);
    expect(ok(lesson({ scope: { repos: ["a/b", "c/d"] } }))).toBe(false);
    expect(ok(lesson({ provenance: { ...(lesson().provenance as object), audience: { kind: "restricted", acl: { source: "slack", scope: "slack:T/C", capturedAt: "2026-10-30T10:00:00.000Z", liveCheck: "none" } } } }))).toBe(false);
  });
  it("needs the approvals its tier names before it is active", () => {
    const approval = { approvalId: "ap1", by: "dev-1", at: "2026-10-30T10:00:00.000Z" };
    expect(ok(lesson({ status: "active" }))).toBe(true); // tier 0 auto
    expect(ok(lesson({ tier: 1, type: "convention", status: "active" }))).toBe(false);
    expect(ok(lesson({ tier: 1, type: "convention", status: "active", approvals: [approval] }))).toBe(true);
    expect(ok(lesson({ tier: 2, type: "review_check", stages: ["REVIEW"], status: "active", approvals: [approval] }))).toBe(false);
    expect(ok(lesson({ tier: 2, type: "review_check", stages: ["REVIEW"], status: "active", approvals: [approval, { ...approval, by: "dev-2" }] }))).toBe(true);
    expect(ok(lesson({ tier: 2, type: "review_check", stages: ["REVIEW"], status: "active", approvals: [approval], soleOwnerException: true }))).toBe(true);
    expect(ok(lesson({ tier: 1, type: "convention", status: "active", approvals: [approval], soleOwnerException: true }))).toBe(false);
  });
  it("bounds title, description, body and citation lines", () => {
    expect(ok(lesson({ title: "x".repeat(81) }))).toBe(false);
    expect(ok(lesson({ description: "x".repeat(161) }))).toBe(false);
    expect(ok(lesson({ body: "x".repeat(601) }))).toBe(false);
    expect(ok(lesson({ citations: [{ ...code, endLine: 3 }] }))).toBe(false);
  });
});

describe("reflector output", () => {
  const candidate = { type: "pitfall", title: "t", description: "d", body: "b", scope: {}, stages: ["PLAN"], citations: [], evidenceSpanIds: ["s1"] };
  it("takes at most three candidates, each naming its evidence", () => {
    expect(ReflectorOutputSchema.safeParse({ candidates: [candidate, candidate, candidate] }).success).toBe(true);
    expect(ReflectorOutputSchema.safeParse({ candidates: [candidate, candidate, candidate, candidate] }).success).toBe(false);
    expect(LessonCandidateSchema.safeParse({ ...candidate, evidenceSpanIds: [] }).success).toBe(false);
  });
  it("refuses a candidate that tries to set its own tier, status or tools", () => {
    for (const field of ["tier", "status", "tools", "approvals"]) expect(LessonCandidateSchema.safeParse({ ...candidate, [field]: 0 }).success, field).toBe(false);
  });
});

describe("learned skill front matter", () => {
  it("refuses tools, grants, commands, domains, models and budgets in front matter, in any case", () => {
    for (const key of ["tools", "allowed-tools", "Grants", "commands", "allowedDomains", "allowed-domains", "model", "budget", "mcp", "hooks", "env"]) {
      expect(skillFrontMatterRefusal(`---\nname: x\n${key}: [a]\n---\nBody`), key).toBe(key.toLowerCase());
    }
  });
  it("sees a quoted key and a front matter that never closes", () => {
    expect(skillFrontMatterRefusal('---\n"tools": [a]\n---\nx')).toBe("tools");
    expect(skillFrontMatterRefusal("---\nname: x\ntools: [a]\nBody with no end")).toBe("tools");
  });
  it("allows a plain skill and a body that merely mentions tools", () => {
    expect(skillFrontMatterRefusal("---\nname: retry\ndescription: how we retry\n---\nUse the tools in src/retry.")).toBeUndefined();
    expect(skillFrontMatterRefusal("No front matter. tools: not a key here")).toBeUndefined();
  });
  const skill = { id: "lsk_0123456789abcdef0123", version: 1, workspaceId: ORG, project: "web", name: "retry-helpers", description: "d", body: "---\nname: retry\n---\nUse withRetry.", fromLessons: ["les_0123456789abcdef0123"], digest: "a".repeat(64), status: "pending", tier: 1, approvals: [] };
  it("parses a skill with no capability fields and refuses one with them", () => {
    expect(LearnedSkillSchema.safeParse(skill).success).toBe(true);
    expect(LearnedSkillSchema.safeParse({ ...skill, body: "---\nallowed-tools: [Bash]\n---\nx" }).success).toBe(false);
    expect(LearnedSkillSchema.safeParse({ ...skill, tools: ["Bash"] }).success).toBe(false);
    expect(LearnedSkillSchema.safeParse({ ...skill, tier: 0 }).success).toBe(false);
    expect(LearnedSkillSchema.safeParse({ ...skill, body: "x".repeat(16_385) }).success).toBe(false);
  });
});

describe("load manifest, memory input, snapshot and learned context", () => {
  it("takes the three memory modes and refuses a snapshot mode with no snapshot", () => {
    expect(MemoryInputSchema.safeParse({ mode: "off" }).success).toBe(true);
    expect(MemoryInputSchema.safeParse({ mode: "live" }).success).toBe(true);
    expect(MemoryInputSchema.safeParse({ mode: "snapshot", snapshotId: "snp_0123456789abcdef0123" }).success).toBe(true);
    expect(MemoryInputSchema.safeParse({ mode: "snapshot" }).success).toBe(false);
    expect(MemoryInputSchema.safeParse({ mode: "off", snapshotId: "snp_0123456789abcdef0123" }).success).toBe(false);
  });
  it("bounds a manifest to 12 lessons and 6 KB", () => {
    const manifest = { workspaceId: ORG, project: "web", taskId: "t1", stage: "PLAN", round: 0, lessonSetVersion: 4, memory: "live", lessons: [], pastTasks: [], recordHits: [], skills: [], bytes: 6_144, at: "2026-10-30T10:00:00.000Z" };
    expect(LoadManifestSchema.safeParse(manifest).success).toBe(true);
    expect(LoadManifestSchema.safeParse({ ...manifest, bytes: 6_145 }).success).toBe(false);
    const entry = { id: "les_0123456789abcdef0123", version: 1, score: 0.5, why: "scope", citation: "valid" };
    expect(LoadManifestSchema.safeParse({ ...manifest, lessons: Array.from({ length: 13 }, () => entry) }).success).toBe(false);
    expect(LoadManifestSchema.safeParse({ ...manifest, lessons: [{ ...entry, citation: "unknown" }] }).success).toBe(false);
  });
  it("holds a snapshot as ids and versions only", () => {
    const snapshot = { snapshotId: "snp_0123456789abcdef0123", workspaceId: ORG, project: "web", createdAt: "2026-10-30T10:00:00.000Z", createdBy: "dev-1", lessonSetVersion: 3, lessons: [{ id: "les_0123456789abcdef0123", version: 2 }], skills: [], embeddingModelId: "amazon.titan-embed-text-v2:0", contentDigest: "b".repeat(64) };
    expect(MemorySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(MemorySnapshotSchema.safeParse({ ...snapshot, lessons: [{ id: "les_0123456789abcdef0123", version: 2, body: "text" }] }).success).toBe(false);
  });
  it("WL-6: the stored/queued form of a stage's lessons holds ids and versions only (no lesson text), strict, and rides on a task invocation", () => {
    const refs = { v: 1, orgId: ORG, project: "web", setVersion: 2, stage: "PLAN", audience: { kind: "shared" }, lessons: [{ id: "les_0123456789abcdef0123", version: 3 }], priorLoaded: [{ id: "les_0123456789abcdef0124" }] };
    expect(LearnedRefsSchema.safeParse(refs).success).toBe(true);
    expect(LearnedRefsSchema.safeParse({ ...refs, audience: { kind: "private", developerId: "d".repeat(64) } }).success).toBe(true);
    expect(LearnedRefsSchema.safeParse({ ...refs, lessons: [{ id: "les_0123456789abcdef0123", version: 3, body: "text" }] }).success).toBe(false);
    expect(LearnedRefsSchema.safeParse({ ...refs, priorLoaded: [{ id: "les_0123456789abcdef0124", title: "text" }] }).success).toBe(false);
    expect(LearnedRefsSchema.safeParse({ ...refs, lessons: Array.from({ length: 13 }, () => ({ id: "les_0123456789abcdef0123", version: 1 })) }).success).toBe(false);
    expect(LearnedRefsSchema.safeParse({ ...refs, extra: 1 }).success).toBe(false);
    const base = {
      protocolVersion: 1, kind: "task", operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1,
      callbackCapability: "c".repeat(32), payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Plan it.", workflowMode: "PLAN" },
    };
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, learnedRefs: refs } }).success).toBe(true);
    expect(WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, learnedRefs: { ...refs, lessons: [{ id: "les_0123456789abcdef0123", version: 3, body: "text" }] } } }).success).toBe(false);
  });
  it("rides on a task invocation as an optional, strict field", () => {
    const base = {
      protocolVersion: 1, kind: "task", operationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1,
      callbackCapability: "c".repeat(32), payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Plan it.", workflowMode: "PLAN" },
    };
    const entry = { id: "les_0123456789abcdef0123", version: 1, type: "pitfall", title: "t", description: "d", body: "b", scopeLabel: "web", citations: [] };
    const send = (learnedContext: unknown) => WorkerInvocationSchema.safeParse({ ...base, payload: { ...base.payload, learnedContext } }).success;
    expect(WorkerInvocationSchema.safeParse(base).success).toBe(true);
    expect(send({ v: 1, setVersion: 2, stage: "PLAN", lessons: [entry] })).toBe(true);
    expect(send({ v: 1, setVersion: 2, stage: "PLAN", lessons: [{ ...entry, tools: ["Bash"] }] })).toBe(false);
    expect(send({ v: 1, setVersion: 2, stage: "PLAN", lessons: [entry], allowedDomains: ["x.com"] })).toBe(false);
  });
});
