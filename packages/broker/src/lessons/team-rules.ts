// Team rules (lessons phase 4, owner decision 2026-11-17): a "How we work" rule that lives INSIDE Rovara, made from a proven lesson that a person made permanent, and scoped to the lesson's code area. It is the default
// graduation target. There is no repository file: the rules are ONE row per company and project in Rovara's own store, and a step reads them as part of its standing instructions (`core/instructions/step-block.ts`),
// under the heading "How we work", each rule stating where it applies.
//
// The row (`TEAMRULES#<project>` under the company's own partition; nothing here reads another company's or project's):
//   set   `{ revision, rules: [{ id, text, paths, repos, stages, fromLesson, createdAt, retired? }] }`: every rule inline, so a reader that can only `get` (the dispatcher) finds them with ONE read.
// Rules:
//   - the text is one paragraph made by `ruleParagraph` from the lesson's own words (no model), cleaned again here; a text that asks for a capability change (more tools, domains, budget, approvals) is refused: a rule is
//     advice, it grants nothing;
//   - `paths` are the lesson's own path globs (at most 20, plain relative globs: no `..`, no leading slash, no control characters); a rule with none applies to the whole project and says so;
//   - a rule never names a person (the ledger records who made it), so erasing a person leaves no trace here beyond the words themselves;
//   - at most `TEAM_RULES_MAX` live rules per project (a rule is read by every step, so the count is a budget); retiring one frees its place and keeps its row for history;
//   - writes are conditional on the revision that was read (a lost race is a conflict, never a lost rule), and one lesson makes one rule (a retry returns the rule it already made);
//   - reads fail closed: a row that is not shaped like this is "unreadable", never read as "no rules".
import { companyScoped, when, type DocumentKey, type DocumentStore, type OrgId, type StoredDocument } from "@agentx/contracts";
import { createHash } from "node:crypto";
import type { StandingLayer } from "../core/instructions/standing-block.js";
import { cleanForLearning, globToRegExp, requestsCapabilityChange } from "./guards.js";
import type { RulePublisher } from "./ports.js";

/** The most live rules one project holds. A rule is read by every step it applies to, so this is a budget, not a convenience. */
export const TEAM_RULES_MAX = 30;
/** One rule: the lesson's title and body as one paragraph (`ruleParagraph`: at most 80 + 600 + 2 characters). */
export const TEAM_RULE_TEXT_MAX = 700;
export const TEAM_RULE_PATHS_MAX = 20;
/** The most all of a project's live rules weigh together as a step reads them (bytes, after the scope sentence is added and angle brackets are escaped): a TOTAL budget, since every step reads them and a block over the standing-instructions limit refuses the step. */
/** How many retired rules the row keeps for history (the oldest are dropped when a rule is added). */
export const TEAM_RULES_RETIRED_KEPT = 30;
export const TEAM_RULES_BYTES_MAX = 32_768;
export const TEAM_RULE_GLOB_MAX = 200;
const STAGES = ["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "REVIEW"] as const;
export type TeamRuleStage = (typeof STAGES)[number];

/** What one rule weighs in a step's prompt: its sentence of scope and its text, escaped as the block escapes them, and a little for the framing. */
export const ruleWeight = (rule: Pick<TeamRule, "text" | "paths" | "repos">): number => Buffer.byteLength(ruleSentence(rule).replace(/</gu, "&lt;").replace(/>/gu, "&gt;"), "utf8") + 64;

/** The rule as a step reads it: where it applies, in words, then the rule. The scope is inside the quoted text, never in a name line. */
export function ruleSentence(rule: Pick<TeamRule, "text" | "paths" | "repos">): string {
  const where = rule.paths.length === 0 ? "the whole project" : rule.paths.slice(0, 5).join(", ") + (rule.paths.length > 5 ? " and more" : "");
  const repos = rule.repos.length === 0 ? "" : ` in ${rule.repos.slice(0, 3).map((repo) => repo.replace(/[^A-Za-z0-9._/@+~-]/gu, "")).join(", ")}`;
  return `Applies to ${where}${repos}. ${rule.text}`;
}

export interface TeamRule {
  id: string;
  text: string;
  /** Where it applies: path globs. Empty: the whole project. */
  paths: string[];
  repos: string[];
  /** The steps that read it (a lesson's own stages). */
  stages: TeamRuleStage[];
  fromLesson: string;
  createdAt: number;
  retired?: true;
}
export interface TeamRuleSet { revision: number; rules: TeamRule[] }

/** The one row's key. */
export const teamRulesKey = (companyId: OrgId, project: string): DocumentKey => ({ pk: companyScoped(companyId, `TEAMRULES#${project}`), sk: "set" });

export class TeamRulesUnreadable extends Error { constructor() { super("the project's team rules cannot be read"); this.name = "TeamRulesUnreadable"; } }

/** A path glob a rule may name: a strict set of characters (letters, digits and . _ - / * ? @ + ~), relative, bounded; no `..`, no leading slash. Nothing that reads as a command, a URL or prose can pass. */
const GLOB_CHARS = /^[A-Za-z0-9._\-/*?@+~]+$/u;
export function validGlob(glob: unknown): glob is string {
  if (typeof glob !== "string" || glob.length === 0 || glob.length > TEAM_RULE_GLOB_MAX || !GLOB_CHARS.test(glob)) return false;
  if (glob.startsWith("/") || glob.split("/").includes("..")) return false;
  return true;
}

/**
 * Whether every file `path` can match also matches `existing`, decided on spelling only and conservatively (a doubt is "no"): the same glob; `**` (everything); or `existing` is a literal directory followed by `/**` and the new
 * path's literal part (before its first wildcard) lies under that directory. A glob with a wildcard anywhere before its last `/**`, or a literal file, contains only itself.
 */
export function pathWithin(path: string, existing: string): boolean {
  if (path === existing || existing === "**") return true;
  const dir = /^([^*?[{]+)\/\*\*$/u.exec(existing)?.[1];
  if (dir === undefined) return false;
  const literal = path.split(/[*?[{]/u)[0] ?? "";
  return literal.startsWith(`${dir}/`);
}
/** Every path lies inside one of the allowed ones. An allowed list that is empty is the whole project: anything lies inside it. */
export const pathsWithin = (paths: readonly string[], allowed: readonly string[] | undefined): boolean => allowed === undefined || allowed.length === 0 || paths.every((path) => allowed.some((glob) => pathWithin(path, glob)));

const str = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.length <= max ? value : undefined);
const strings = (value: unknown, max: number, each: number): string[] | undefined => {
  if (!Array.isArray(value) || value.length > max) return undefined;
  return value.every((entry) => typeof entry === "string" && entry.length <= each) ? (value as string[]) : undefined;
};

function ruleOf(raw: unknown): TeamRule | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const id = str(row["id"], 64), text = str(row["text"], TEAM_RULE_TEXT_MAX), fromLesson = str(row["fromLesson"], 64);
  const paths = strings(row["paths"], TEAM_RULE_PATHS_MAX, TEAM_RULE_GLOB_MAX), repos = strings(row["repos"], 10, 200), stages = strings(row["stages"], STAGES.length, 20);
  const createdAt = row["createdAt"];
  if (id === undefined || !/^[A-Za-z0-9_-]{4,64}$/u.test(id) || text === undefined || text === "" || fromLesson === undefined || paths === undefined || !paths.every(validGlob) || repos === undefined || stages === undefined) return undefined;
  if (!stages.every((stage) => (STAGES as readonly string[]).includes(stage)) || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
  if (row["retired"] !== undefined && row["retired"] !== true) return undefined;
  return { id, text, paths, repos, stages: stages as TeamRuleStage[], fromLesson, createdAt, ...(row["retired"] === true ? { retired: true as const } : {}) };
}

/** The project's rule set (an empty one when there is no row). A row that is not shaped like one throws `TeamRulesUnreadable`: never "no rules". */
export async function readTeamRules(store: Pick<DocumentStore, "get">, companyId: OrgId, project: string): Promise<TeamRuleSet> {
  let row: StoredDocument | undefined;
  try { row = await store.get(teamRulesKey(companyId, project)); } catch { throw new TeamRulesUnreadable(); }
  if (row === undefined) return { revision: 0, rules: [] };
  const revision = row["revision"], list = row["rules"];
  if (row["entityType"] !== "TEAM_RULE_SET" || typeof revision !== "number" || !Number.isInteger(revision) || revision < 1 || !Array.isArray(list) || list.length > TEAM_RULES_MAX * 4) throw new TeamRulesUnreadable();
  const rules: TeamRule[] = [];
  for (const entry of list) {
    const rule = ruleOf(entry);
    if (rule === undefined) throw new TeamRulesUnreadable();
    rules.push(rule);
  }
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new TeamRulesUnreadable();
  return { revision, rules };
}

/** The live rules (not retired). */
export const liveRules = (set: TeamRuleSet): TeamRule[] => set.rules.filter((rule) => rule.retired !== true);

export type AddRuleResult = { ok: true; ruleId: string; already: boolean } | { ok: false; code: "refused_text" | "refused_paths" | "too_many_rules" | "conflict" | "unreadable" };

/** The rule id a lesson makes: stable, so a retry finds the rule it already made. */
export const ruleIdFor = (companyId: string, project: string, lessonId: string): string => `rule_${createHash("sha256").update(`team-rule\u0000${companyId}\u0000${project}\u0000${lessonId}`).digest("hex").slice(0, 16)}`;

export interface NewTeamRule { lessonId: string; paragraph: string; paths?: readonly string[] | undefined; repos?: readonly string[] | undefined; stages?: readonly string[] | undefined }

/** Adds one rule for a lesson, once. One conditional write on the revision that was read. */
export async function addTeamRule(store: Pick<DocumentStore, "get" | "put">, companyId: OrgId, project: string, input: NewTeamRule, now: () => number): Promise<AddRuleResult> {
  const text = cleanForLearning(input.paragraph, TEAM_RULE_TEXT_MAX).replace(/\s+/gu, " ").trim();
  if (text === "" || requestsCapabilityChange(text)) return { ok: false, code: "refused_text" };
  const paths = [...new Set(input.paths ?? [])];
  if (paths.length > TEAM_RULE_PATHS_MAX || !paths.every(validGlob)) return { ok: false, code: "refused_paths" };
  let set: TeamRuleSet;
  try { set = await readTeamRules(store, companyId, project); } catch { return { ok: false, code: "unreadable" }; }
  const id = ruleIdFor(companyId, project, input.lessonId);
  const existing = set.rules.find((rule) => rule.id === id);
  if (existing !== undefined && existing.retired !== true) return { ok: true, ruleId: id, already: true };
  if (existing !== undefined) return { ok: false, code: "conflict" };
  const stages = (input.stages ?? []).filter((stage): stage is TeamRuleStage => (STAGES as readonly string[]).includes(stage));
  const rule: TeamRule = { id, text, paths, repos: [...new Set(input.repos ?? [])].slice(0, 10), stages: stages.length === 0 ? [...STAGES] : [...new Set(stages)], fromLesson: input.lessonId.slice(0, 64), createdAt: now() };
  if (liveRules(set).length >= TEAM_RULES_MAX || liveRules(set).reduce((sum, one) => sum + ruleWeight(one), ruleWeight(rule)) > TEAM_RULES_BYTES_MAX) return { ok: false, code: "too_many_rules" };
  // Retired rows are kept only for history and only the most recent ones: the row stays well inside what a read accepts.
  const kept = [...set.rules.filter((one) => one.retired !== true), ...set.rules.filter((one) => one.retired === true).slice(-TEAM_RULES_RETIRED_KEPT)];
  const next: StoredDocument = { ...teamRulesKey(companyId, project), entityType: "TEAM_RULE_SET", revision: set.revision + 1, rules: [...kept, rule] as unknown as StoredDocument["rules"], updatedAt: now() };
  try {
    const written = await store.put({ item: next, condition: set.revision === 0 ? when.absent() : when.eq("revision", set.revision) });
    return written.applied ? { ok: true, ruleId: id, already: false } : { ok: false, code: "conflict" };
  } catch { return { ok: false, code: "conflict" }; }
}

/** Takes a rule out of use (its row is kept). */
export async function retireTeamRule(store: Pick<DocumentStore, "get" | "put">, companyId: OrgId, project: string, ruleId: string, now: () => number): Promise<{ ok: true } | { ok: false; code: "not_found" | "conflict" | "unreadable" }> {
  let set: TeamRuleSet;
  try { set = await readTeamRules(store, companyId, project); } catch { return { ok: false, code: "unreadable" }; }
  const target = set.rules.find((rule) => rule.id === ruleId && rule.retired !== true);
  if (target === undefined) return { ok: false, code: "not_found" };
  const rules = set.rules.map((rule) => (rule.id === ruleId ? { ...rule, retired: true as const } : rule));
  try {
    const written = await store.put({ item: { ...teamRulesKey(companyId, project), entityType: "TEAM_RULE_SET", revision: set.revision + 1, rules: rules as unknown as StoredDocument["rules"], updatedAt: now() }, condition: when.eq("revision", set.revision) });
    return written.applied ? { ok: true } : { ok: false, code: "conflict" };
  } catch { return { ok: false, code: "conflict" }; }
}

/** Takes out of use every live rule a lesson made (the lesson was withdrawn, purged or its person erased): its row is kept. One conditional write; a lost race tries again. */
export async function retireTeamRulesFromLesson(store: Pick<DocumentStore, "get" | "put">, companyId: OrgId, project: string, lessonId: string, now: () => number): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const set = await readTeamRules(store, companyId, project);
    const hit = set.rules.filter((rule) => rule.fromLesson === lessonId && (rule.retired !== true || rule.text !== "Removed."));
    if (hit.length === 0) return 0;
    // Retired AND blanked: the lesson is gone for good, so its words do not outlive it in this row.
    const rules = set.rules.map((rule) => (rule.fromLesson === lessonId ? { ...rule, text: "Removed.", paths: [], repos: [], retired: true as const } : rule));
    const written = await store.put({ item: { ...teamRulesKey(companyId, project), entityType: "TEAM_RULE_SET", revision: set.revision + 1, rules: rules as unknown as StoredDocument["rules"], updatedAt: now() }, condition: when.eq("revision", set.revision) });
    if (written.applied) return hit.length;
  }
  throw new TeamRulesUnreadable();
}

/** A glob's literal directory prefix (what comes before its first wildcard). */
const prefixOf = (glob: string): string => glob.split(/[*?[{]/u)[0] ?? "";

/** Whether a rule applies to at least one of these files (a rule with no paths applies to every file). */
export function ruleMatchesFiles(rule: Pick<TeamRule, "paths">, files: readonly string[]): boolean {
  if (rule.paths.length === 0) return true;
  return rule.paths.some((glob) => {
    let expression: RegExp;
    try { expression = globToRegExp(glob); } catch { return true; }
    return files.some((file) => expression.test(file));
  });
}
/** The step modes and the lesson stages they read for. */
const MODE_STAGE: Record<string, TeamRuleStage> = { UNDERSTAND: "UNDERSTAND", PLAN: "PLAN", PLAN_CRITIQUE: "PLAN_CRITIQUE", IMPLEMENT: "IMPLEMENT", REVIEW: "REVIEW" };

/**
 * The rules one step is given, as standing-instruction layers: only the live rules for that step's stage, and, when the step names the files it works on, only those whose paths match one of them (a rule with no paths
 * always applies). Each layer says where its rule applies, in words, so a model that is not told the files still reads the scope. A mode with no stage (a check, a setup run) gets none. At most `TEAM_RULES_MAX`.
 */
export function teamRuleLayers(set: TeamRuleSet, input: { mode: string | undefined; files?: readonly string[] | undefined }): StandingLayer[] {
  const stage = input.mode === undefined ? "IMPLEMENT" : MODE_STAGE[input.mode];
  if (stage === undefined) return [];
  return liveRules(set)
    .filter((rule) => rule.stages.includes(stage))
    .filter((rule) => input.files === undefined || ruleMatchesFiles(rule, input.files))
    .slice(0, TEAM_RULES_MAX)
    .map((rule) => ({ agentName: "Team rule", text: ruleSentence(rule) }));
}

/** The source the standing instructions read (`core/instructions/step-block.ts`): THIS company's rules for one project, as layers for one step. A failed read throws (the step is refused, never run without them). */
export function createTeamRulesSource(deps: { store: Pick<DocumentStore, "get">; companyId: OrgId }): { layersFor(input: { project: string; mode: string | undefined; files?: readonly string[] | undefined }): Promise<StandingLayer[]> } {
  return { async layersFor(input) { return teamRuleLayers(await readTeamRules(deps.store, deps.companyId, input.project), input); } };
}

export interface TeamRulePublisherDeps { store: Pick<DocumentStore, "get" | "put">; companyId: OrgId; now: () => number }
export type TeamRulePublishInput = Parameters<RulePublisher["publish"]>[0];

/** The `RulePublisher` the graduation uses: it publishes into THIS company's rule row only (the company comes from the deps, never from the input), and refuses any other company's project. */
export function createTeamRulePublisher(deps: TeamRulePublisherDeps): RulePublisher {
  return {
    async publish(input: TeamRulePublishInput): Promise<{ ruleId: string }> {
      if (input.workspaceId !== deps.companyId) throw new Error("not this company's project");
      const added = await addTeamRule(deps.store, deps.companyId, input.project, { lessonId: input.lessonId, paragraph: input.paragraph, paths: input.paths, repos: input.repos, stages: input.stages }, deps.now);
      if (!added.ok) throw new Error(`the rule was not published: ${added.code}`);
      return { ruleId: added.ruleId };
    },
  };
}

export { prefixOf as globPrefix };
