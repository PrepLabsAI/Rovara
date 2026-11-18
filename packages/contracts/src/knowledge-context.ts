// Lead 4 L4-AK2: what the broker sends a worker as `knowledgeContext` for one stage (the briefing beyond the lessons, and the bounded pull set for `knowledge_for`), and what the worker reports
// back as `knowledgeUseReport`. Design: agent-knowledge-design.md sections 3 to 5. Both fields are additive and optional: a broker or worker that does not know them ignores them, and an older
// worker is never sent `knowledgeContext` (the feature string below). Strict: a field this build does not know is refused, never ignored. All text in here is the team's notes written from tasks
// and repository text: untrusted DATA. It can grant no tool, check, approval or limit (the schema has no place for one), and the worker cleans every field again before it shows any of it.
import { z } from "zod";
import { LESSON_TYPES, LessonStageSchema, type LessonStage } from "./learned-context.js";

export const KNOWLEDGE_CONTEXT_FEATURE = "task.knowledgeContext.v1" as const;
/** The whole briefing block (lessons, facts, skill names and the "more" line) stays within this many bytes. Facts, then skills, then lessons' tail are cut first; the "more" line goes last. */
export const KNOWLEDGE_BRIEFING_MAX_BYTES = 3584;
export const KNOWLEDGE_FACTS_MAX = 5;
export const KNOWLEDGE_SKILLS_MAX = 8;
export const KNOWLEDGE_MORE_AREAS_MAX = 6;
/** The pull set one step is sent: approved, visible, scoped units of its own project only. */
export const KNOWLEDGE_PULL_MAX_UNITS = 150;
export const KNOWLEDGE_PULL_MAX_BYTES = 64 * 1024;
/** What one `knowledge_for` answer and one step may hold. */
export const KNOWLEDGE_FOR_MAX_UNITS = 10;
export const KNOWLEDGE_FOR_MAX_BYTES = 2048;
export const KNOWLEDGE_FOR_MAX_CALLS = 12;
export const KNOWLEDGE_FOR_TOTAL_BYTES = 8 * 1024;
export const KNOWLEDGE_REPORT_MAX_UNITS = 60;
/** The stages that may look up by tool (Understand, Plan, Build and Fix). Plan check and Review judge a fixed set. */
export const KNOWLEDGE_PULL_STAGES = ["UNDERSTAND", "PLAN", "IMPLEMENT"] as const;
export const knowledgePullStageAllows = (stage: string | undefined): boolean => (KNOWLEDGE_PULL_STAGES as readonly string[]).includes(stage as string);

/** What each stage may carry (design 3.2). The broker builds to this table and the worker cuts the payload to it again. */
export const KNOWLEDGE_STAGE_PARTS: Readonly<Record<LessonStage, { facts: boolean; skills: boolean; more: boolean; pull: boolean }>> = {
  UNDERSTAND: { facts: false, skills: false, more: true, pull: true },
  PLAN: { facts: false, skills: true, more: true, pull: true },
  PLAN_CRITIQUE: { facts: false, skills: false, more: false, pull: false },
  IMPLEMENT: { facts: true, skills: true, more: true, pull: true },
  REVIEW: { facts: true, skills: false, more: false, pull: false },
};

export const KNOWLEDGE_KINDS = ["rule", "lesson", "fact", "skill"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
const KIND_LETTER: Readonly<Record<KnowledgeKind, string>> = { rule: "R", lesson: "L", fact: "F", skill: "S" };
/** The id a person and an agent both see: the kind letter, a dash and the stored id. */
export const knowledgeUnitId = (kind: KnowledgeKind, id: string): string => `${KIND_LETTER[kind]}-${id.replace(/[^A-Za-z0-9_-]/gu, "")}`;
export const KNOWLEDGE_TRUST = ["team_rule", "team_approved", "measured"] as const;
export type KnowledgeTrust = (typeof KNOWLEDGE_TRUST)[number];
/** The words the agent sees for each trust level. */
export const KNOWLEDGE_TRUST_WORD: Readonly<Record<KnowledgeTrust, string>> = { team_rule: "team rule", team_approved: "team-approved", measured: "measured" };

const Glob = z.string().min(1).max(200);
/** The id as shown (`L-<id>`), used wherever a unit is named across the wire. */
const ShownId = z.string().regex(/^[RLFS]-[A-Za-z0-9_-]{4,64}$/u);
const StoredId = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u);
export const KnowledgeUnitSchema = z.object({
  kind: z.enum(KNOWLEDGE_KINDS), id: StoredId, version: z.number().int().min(1).optional(),
  subtype: z.enum(LESSON_TYPES).optional(),
  /** One imperative sentence (a lesson's title), or a fact's line. */
  statement: z.string().min(1).max(240), why: z.string().max(160), detail: z.string().max(600).optional(),
  /** A short label of where it applies, built by the broker. */
  scopeLabel: z.string().max(200),
  /** Where it applies, as the stored scope: empty both means the whole project. Used by the worker to match a path, never to grant anything. */
  repos: z.array(z.string().min(1).max(200)).max(10), paths: z.array(Glob).max(20),
  trust: z.enum(KNOWLEDGE_TRUST), proven: z.literal(true).optional(),
  evidence: z.object({ count: z.number().int().min(1).max(1_000_000), windowDays: z.number().int().min(1).max(3650) }).strict().optional(),
}).strict();
export type KnowledgeUnit = z.infer<typeof KnowledgeUnitSchema>;

export const KnowledgeFactSchema = z.object({
  id: StoredId, statement: z.string().min(1).max(240), evidence: z.object({ count: z.number().int().min(1).max(1_000_000), windowDays: z.number().int().min(1).max(3650) }).strict().optional(),
  paths: z.array(Glob).max(20),
}).strict();
export type KnowledgeFact = z.infer<typeof KnowledgeFactSchema>;

export const KnowledgeSkillNameSchema = z.object({
  id: StoredId, name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u), description: z.string().min(1).max(200),
}).strict();
export type KnowledgeSkillName = z.infer<typeof KnowledgeSkillNameSchema>;

export const KnowledgeMoreAreaSchema = z.object({
  /** A folder or path label such as `src/billing/`, as the units' own scope names it. */
  label: z.string().min(1).max(120), units: z.number().int().min(1).max(100_000),
}).strict();

export const KnowledgeContextSchema = z.object({
  v: z.literal(1), stage: LessonStageSchema,
  /** Measured fact lines (Build, Fix and Review only). The lessons stay in `learnedContext`; this adds to them. */
  facts: z.array(KnowledgeFactSchema).max(KNOWLEDGE_FACTS_MAX).optional(),
  /** Skill names the team made (Plan, Build and Fix only). The text is read with `read_skill`. */
  skills: z.array(KnowledgeSkillNameSchema).max(KNOWLEDGE_SKILLS_MAX).optional(),
  /** What else exists and where: the "more" line. `leftOut` is the count of units not in the pull set. */
  more: z.object({ areas: z.array(KnowledgeMoreAreaSchema).max(KNOWLEDGE_MORE_AREAS_MAX), leftOut: z.number().int().min(0).max(1_000_000) }).strict().optional(),
  /** Where each unit pushed in the briefing applies (the lessons' own scope, which `learnedContext` does not carry), so the worker's `areaTouched` check can match it. A pushed unit not named here counts as unscoped. */
  pushedScopes: z.array(z.object({ id: ShownId, repos: z.array(z.string().min(1).max(200)).max(10), paths: z.array(Glob).max(20) }).strict()).max(40).optional(),
  /** The units `knowledge_for` answers from, for Understand, Plan and Build/Fix. This project's own units only. */
  pull: z.object({ units: z.array(KnowledgeUnitSchema).max(KNOWLEDGE_PULL_MAX_UNITS), leftOut: z.number().int().min(0).max(1_000_000) }).strict().optional(),
}).strict();
export type KnowledgeContext = z.infer<typeof KnowledgeContextSchema>;

/**
 * What is STORED at delivery for validating the worker's report: unit ids only (never text), for ONE operation of ONE task. The report may only speak about these ids.
 * The broker writes it where it can write; the dispatcher that cannot leaves it out, and the report is then checked against the project's own lessons instead.
 */
export const KnowledgeDeliveryRecordSchema = z.object({
  v: z.literal(1), stage: LessonStageSchema, taskId: z.string().min(1).max(100), project: z.string().min(1).max(200),
  pushed: z.array(z.string().max(80)).max(40), pulled: z.array(z.string().max(80)).max(KNOWLEDGE_PULL_MAX_UNITS + 40),
}).strict();
export type KnowledgeDeliveryRecord = z.infer<typeof KnowledgeDeliveryRecordSchema>;

export const KNOWLEDGE_USE_REPORT_FIELD = "knowledgeUseReport";
export const KNOWLEDGE_GIVEN_HOW = ["push", "pull", "auto", "skill_read"] as const;
export const KnowledgeUseReportSchema = z.object({
  v: z.literal(1), stage: LessonStageSchema,
  units: z.array(z.object({
    id: ShownId, kind: z.enum(KNOWLEDGE_KINDS), version: z.number().int().min(1).optional(), given: z.enum(KNOWLEDGE_GIVEN_HOW),
    /** The worker's own check: a file the step changed matches the unit's globs (an unscoped unit: the step changed any file). */
    areaTouched: z.boolean(),
    /** The agent's claim. Absent: the agent made no report. */
    used: z.boolean().optional(), wrong: z.literal(true).optional(),
  }).strict()).max(KNOWLEDGE_REPORT_MAX_UNITS),
  /** Whether `knowledge_report` was called at all. */
  reported: z.boolean(),
}).strict();
export type KnowledgeUseReport = z.infer<typeof KnowledgeUseReportSchema>;

/** The use report in a worker progress payload, or undefined for anything else (a malformed report is dropped whole, never partly used). */
export function knowledgeUseReportOfProgress(payload: unknown): KnowledgeUseReport | undefined {
  if (payload === null || typeof payload !== "object" || !Object.hasOwn(payload, KNOWLEDGE_USE_REPORT_FIELD)) return undefined;
  const parsed = KnowledgeUseReportSchema.safeParse((payload as Record<string, unknown>)[KNOWLEDGE_USE_REPORT_FIELD]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The report cut down to what the delivery record allows: an id the step was not given is removed (the report speaks only about what was delivered for this operation), the stage must be the one delivered, and
 * one unit appears once. Undefined when the stage does not match. Pure.
 */
export function validateKnowledgeUseReport(report: KnowledgeUseReport, delivered: Pick<KnowledgeDeliveryRecord, "stage" | "pushed" | "pulled">): KnowledgeUseReport | undefined {
  if (report.stage !== delivered.stage) return undefined;
  const allowed = new Set([...delivered.pushed, ...delivered.pulled]);
  const seen = new Set<string>();
  const units = report.units.filter((unit) => {
    if (!allowed.has(unit.id) || seen.has(unit.id)) return false;
    seen.add(unit.id);
    // `given: push` must be a pushed id and `given: pull` a pulled one: a unit cannot claim to have been pushed when it was only in the pull set.
    if (unit.given === "push" && !delivered.pushed.includes(unit.id)) return false;
    return true;
  });
  return { ...report, units };
}

/**
 * The 1/k credit SEAM (design 5.4), pure and not yet connected to any counter. Of a clean merge's Build and Fix reports: a lesson or skill is eligible when it was given and the agent said it used it, or when no report
 * was made at all and its area was touched. Each eligible one is owed 1/k. A unit given but unused in an untouched area gets nothing. `wrong` changes no share (it is never an "against": a person decides).
 * Rules and facts are not scored this way. The agent's claim only decides how one credit is SHARED: it can never add credit.
 */
export function knowledgeCreditShares(reports: readonly KnowledgeUseReport[]): Map<string, number> {
  const eligible = new Set<string>();
  for (const report of reports) {
    for (const unit of report.units) {
      if (unit.kind !== "lesson" && unit.kind !== "skill") continue;
      const claimed = report.reported ? unit.used === true : unit.areaTouched;
      if (claimed) eligible.add(unit.id);
    }
  }
  const share = eligible.size === 0 ? 0 : 1 / eligible.size;
  return new Map([...eligible].map((id) => [id, share] as const));
}
