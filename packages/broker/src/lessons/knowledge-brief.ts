// Lead 4 L4-AK2: the broker's side of the knowledge briefing and the pull set. At a step's delivery it builds `knowledgeContext` (contracts `knowledge-context.ts`) from
//   - the lessons the loader already chose for the push (their scope, so the worker can tell which area each one covers),
//   - the pull set: approved, visible, SCOPED, stable-or-person-approved lessons of THIS project, read through `selectLessons` (the one read path), up to KNOWLEDGE_PULL_MAX_UNITS and KNOWLEDGE_PULL_MAX_BYTES,
//   - measured facts and skill names from two optional ports (the only measured source today is the base's known-flaky list; the team's own skills are lane 4a), and
//   - the "more" line: where else knowledge exists, by area, with counts.
// Only what the stage may carry is built (`KNOWLEDGE_STAGE_PARTS`): Plan check and Review get a fixed set and no look-up. Nothing is stored or queued as text; the delivery record keeps ids only.
// Never throws into the dispatch: a failure here is no knowledgeContext, and the step runs with the lessons block alone.
import {
  KNOWLEDGE_FACTS_MAX, KNOWLEDGE_MORE_AREAS_MAX, KNOWLEDGE_PULL_MAX_BYTES, KNOWLEDGE_PULL_MAX_UNITS, KNOWLEDGE_SKILLS_MAX, KNOWLEDGE_STAGE_PARTS, KnowledgeContextSchema, cleanLessonText, knowledgeUnitId,
  type KnowledgeContext, type KnowledgeDeliveryRecord, type KnowledgeFact, type KnowledgeSkillName, type KnowledgeUnit, type LessonStage,
} from "@agentx/contracts";
import { safeScopeLabel } from "./render.js";
import { hasPersonApproval } from "./repo-eligibility.js";
import type { Lesson } from "./types.js";

/** Measured facts for a step (the base's known-flaky tests, a repeated CI cause): code counted them, nobody wrote them. Absent: no facts. Never throws into the dispatch. */
export type KnowledgeFactsPort = (input: { companyId: string; project: string; stage: LessonStage; files: readonly string[]; repos: readonly string[] }) => Promise<readonly KnowledgeFact[]>;
/** The skill names the team made, for the stage (lane 4a). Absent: none. */
export type KnowledgeSkillsPort = (input: { companyId: string; project: string; stage: LessonStage; files: readonly string[]; repos: readonly string[] }) => Promise<readonly KnowledgeSkillName[]>;
export interface KnowledgeSources { facts?: KnowledgeFactsPort | undefined; skills?: KnowledgeSkillsPort | undefined }

const oneLine = (text: string, max: number): string => cleanLessonText(text, max).replace(/\s*[\n\u2028\u2029]\s*/gu, " ");

/** Only stable or person-approved lessons are in the look-up: its "team-approved" label must be true (a lesson live on trial with no person behind it stays in the push only, as today). */
export const pullable = (lesson: Pick<Lesson, "trial" | "approvals" | "scope">): boolean =>
  lesson.trial?.state !== "trial" && (lesson.trial?.state === "stable" || hasPersonApproval(lesson)) && isScoped(lesson);
/** Scoped by repository or path. A lesson with no scope competes for the push only (it must pass the fit floor there). */
export const isScoped = (lesson: Pick<Lesson, "scope">): boolean => (lesson.scope.repos?.length ?? 0) > 0 || (lesson.scope.paths?.length ?? 0) > 0;

/** One lesson as a unit of the pull set. The statement is the title, the why the description, the detail the body (the same words the briefing shows). */
export function unitOfLesson(lesson: Lesson): KnowledgeUnit {
  return {
    kind: "lesson", id: lesson.id, version: lesson.version, subtype: lesson.type,
    statement: oneLine(lesson.title, 80) || "(untitled)", why: oneLine(lesson.description, 160), detail: oneLine(lesson.body, 600), scopeLabel: safeScopeLabel(lesson.scope),
    repos: [...(lesson.scope.repos ?? [])].slice(0, 10), paths: [...(lesson.scope.paths ?? [])].slice(0, 20),
    trust: "team_approved",
  };
}

/** The area a unit covers, for the "more" line: the folder before the first wildcard of its first path glob, else its repository. */
export function areaLabelOf(unit: Pick<KnowledgeUnit, "repos" | "paths">): string {
  const first = unit.paths[0];
  if (first !== undefined) {
    const cut = first.search(/[*?[{]/u);
    const literal = (cut < 0 ? first : first.slice(0, cut)).replace(/^\.?\//u, "");
    // With a wildcard the literal part is a folder when it ends in a slash (else its last segment is a half-written name); without one the last segment is the file.
    const folder = cut >= 0 && literal.endsWith("/") ? literal.replace(/\/+$/u, "") : literal.split("/").slice(0, -1).join("/");
    if (folder !== "") return `${oneLine(folder, 100)}/`;
  }
  return unit.repos[0] === undefined ? "whole project" : oneLine(unit.repos[0], 100);
}

export interface PullPick { units: KnowledgeUnit[]; leftOut: number }
/** The ranked, visible, pullable lessons as units, within the unit and byte limits; what does not fit is counted, never cut mid-unit. `extraLeftOut` is what the selection itself left out. */
export function pullUnitsOf(ranked: readonly Lesson[], extraLeftOut = 0): PullPick {
  const units: KnowledgeUnit[] = [];
  let bytes = 0;
  let leftOut = extraLeftOut;
  for (const lesson of ranked) {
    if (!pullable(lesson)) continue;
    const unit = unitOfLesson(lesson);
    const size = Buffer.byteLength(JSON.stringify(unit), "utf8") + 1;
    if (units.length >= KNOWLEDGE_PULL_MAX_UNITS || bytes + size > KNOWLEDGE_PULL_MAX_BYTES) { leftOut += 1; continue; }
    units.push(unit);
    bytes += size;
  }
  return { units, leftOut };
}

export interface BuildKnowledgeInput {
  stage: LessonStage;
  /** The lessons chosen for the push, in order (their scope tells the worker which area each covers). */
  pushed: readonly Lesson[];
  /** The look-up's lessons, ranked, already read through the one read path. Ignored in a stage that may not look up. */
  pull?: readonly Lesson[] | undefined;
  /** Eligible lessons the selection left out (its budget). */
  pullLeftOut?: number | undefined;
  facts?: readonly KnowledgeFact[] | undefined;
  skills?: readonly KnowledgeSkillName[] | undefined;
}

/** The knowledgeContext of a step, or undefined when there is nothing beyond the plain lessons block to send. Valid against the contract by construction (checked before it is returned). */
export function buildKnowledgeContext(input: BuildKnowledgeInput): KnowledgeContext | undefined {
  const allowed = KNOWLEDGE_STAGE_PARTS[input.stage];
  const pushedIds = new Set(input.pushed.map((lesson) => lesson.id));
  const pick = allowed.pull ? pullUnitsOf(input.pull ?? [], input.pullLeftOut ?? 0) : { units: [], leftOut: 0 };
  const facts = allowed.facts ? [...(input.facts ?? [])].slice(0, KNOWLEDGE_FACTS_MAX) : [];
  const skills = allowed.skills ? [...(input.skills ?? [])].slice(0, KNOWLEDGE_SKILLS_MAX) : [];
  // Where else knowledge exists: the units in the look-up that the push did not already carry, by area, most first.
  const more = new Map<string, number>();
  if (allowed.more) for (const unit of pick.units) if (!pushedIds.has(unit.id)) more.set(areaLabelOf(unit), (more.get(areaLabelOf(unit)) ?? 0) + 1);
  const areas = [...more.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, KNOWLEDGE_MORE_AREAS_MAX).map(([label, units]) => ({ label, units }));
  const pushedScopes = input.pushed.filter(isScoped).slice(0, 40).map((lesson) => ({ id: knowledgeUnitId("lesson", lesson.id), repos: [...(lesson.scope.repos ?? [])].slice(0, 10), paths: [...(lesson.scope.paths ?? [])].slice(0, 20) }));
  const context: KnowledgeContext = {
    v: 1, stage: input.stage,
    ...(facts.length === 0 ? {} : { facts: facts.map((fact) => ({ ...fact, statement: oneLine(fact.statement, 240) })) }),
    ...(skills.length === 0 ? {} : { skills: [...skills] }),
    ...(!allowed.more || (areas.length === 0 && pick.leftOut === 0) ? {} : { more: { areas, leftOut: pick.leftOut } }),
    ...(pick.units.length === 0 ? {} : { pull: pick }),
    ...(pushedScopes.length === 0 ? {} : { pushedScopes }),
  };
  if (context.facts === undefined && context.skills === undefined && context.more === undefined && context.pull === undefined) return undefined;
  const parsed = KnowledgeContextSchema.safeParse(context);
  return parsed.success ? parsed.data : undefined;
}

/** The ids a delivery gave (pushed and pulled, as shown), for the record that the worker's report is checked against. Ids only. */
export function deliveryRecordOf(input: { taskId: string; project: string; learnedLessonIds: readonly string[]; knowledge: KnowledgeContext }): KnowledgeDeliveryRecord {
  const pushed = [
    ...input.learnedLessonIds.map((id) => knowledgeUnitId("lesson", id)),
    ...(input.knowledge.facts ?? []).map((fact) => knowledgeUnitId("fact", fact.id)),
    ...(input.knowledge.skills ?? []).map((skill) => knowledgeUnitId("skill", skill.id)),
  ];
  const pulled = (input.knowledge.pull?.units ?? []).map((unit) => knowledgeUnitId(unit.kind, unit.id));
  return { v: 1, stage: input.knowledge.stage, taskId: input.taskId, project: input.project, pushed: pushed.slice(0, 40), pulled: pulled.slice(0, KNOWLEDGE_PULL_MAX_UNITS + 40) };
}

/** Paths a correction or failing-check text names, most specific first, for ranking a fix round (never echoed, never stored). */
export function pathsNamedIn(text: string, max = 20): string[] {
  const found = new Set<string>();
  for (const match of cleanLessonText(text, 4000).matchAll(/(?:^|[\s"'`([])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`)\],:;])/gu)) {
    found.add(match[1]!.replace(/^\.\//u, ""));
    if (found.size >= max) break;
  }
  return [...found];
}
