// "How we work" in Rovara Code: reading `.rovara/playbook.yaml`. Pure: text in, a checked playbook (or the problems) out. Nothing here reads a file or a repository.
//
// The file is data from a repository, so it is read the way a meta repo's config is: bounded in size before it is read, YAML aliases capped, merge keys and duplicate keys refused, only the core
// schema's plain values, and a parse failure is a fixed sentence (a YAML error can quote the file). Its texts are made inert (hidden characters out) and bounded, and the overlay it makes goes
// through the same guards Cloud puts on a project's process layer: no new order of stages, no skills, no rules for the pull request stage.
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  HOW_WE_WORK_UNUSED_STAGE_NOTE,
  PLAYBOOK_FILE_MAX_BYTES,
  PLAYBOOK_RULE_TEXT_MAX,
  PLAYBOOK_STAGE_IDS,
  PLAYBOOK_UNUSED_STAGES,
  PlaybookFileSchema,
  RecipeOverlaySchema,
  canonicalJson,
  type DesignReviewSetting,
  type PlaybookFile,
  type PlaybookParse,
  type PlaybookProblem,
  type PlaybookStageId,
  type PlaybookText,
  type RecipeOverlay,
} from "@agentx/contracts";
import { inertRuleText } from "./inert-rule-text.js";
import { requireNoNewPullRequestInstructionsForProcess } from "./process-pull-request.js";
import { requireNoSequenceForProcess } from "./process-sequence.js";
import { requireNoSkillsForProcess } from "./process-skills.js";

const YAML_MAX_ALIASES = 10;
const MESSAGE_MAX = 200;
const PROCESS_LAYER = { purpose: "process" } as const;

export const PLAYBOOK_NOT_YAML = "the file is not valid YAML";
export const PLAYBOOK_TAG_MESSAGE = "the file uses a YAML tag; only plain text, lists and maps are read";
export const PLAYBOOK_APPROVER_MESSAGE = "only maintainers can approve a high-risk design here; naming people or a group is a Cloud setting";
export const PLAYBOOK_TOO_LONG_MESSAGE = `must be at most ${PLAYBOOK_RULE_TEXT_MAX.toLocaleString("en-US")} characters`;

const problem = (path: string, message: string): PlaybookProblem => ({ path, message: Array.from(message).slice(0, MESSAGE_MAX).join("") });

/** The words a zod issue is shown in: its path and its message, bounded. A message can carry a key name of the file, never a value. */
function problemsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): PlaybookProblem[] {
  return issues.slice(0, 20).map((issue) => problem(issue.path.length === 0 ? "(file)" : issue.path.map(String).join("."), issue.message));
}

/** A text as written: a block, or a list of lines joined with newlines. */
const joined = (text: PlaybookText): string => (typeof text === "string" ? text : text.join("\n"));

/** The stages the file wrote text for, as (id, text) in the order of the stages. */
function stageTexts(file: PlaybookFile): Array<[PlaybookStageId, string]> {
  const out: Array<[PlaybookStageId, string]> = [];
  for (const id of PLAYBOOK_STAGE_IDS) {
    const instructions = file.stages?.[id]?.instructions;
    if (instructions !== undefined && joined(instructions) !== "") out.push([id, joined(instructions)]);
  }
  return out;
}

/**
 * The file's text as a playbook. The texts come back inert and bounded, in the same shape they were written (a list stays a list only as a joined block: `rules` and each stage's `instructions` are
 * strings from here on). `designReview`, when present, is the strict setting Cloud stores.
 */
export function parsePlaybookText(text: string): PlaybookParse {
  if (new TextEncoder().encode(text).byteLength > PLAYBOOK_FILE_MAX_BYTES) return { ok: false, problems: [problem("(file)", `the file is larger than ${String(PLAYBOOK_FILE_MAX_BYTES)} bytes`)] };
  let value: unknown;
  try {
    const document = parseDocument(text, { merge: false, uniqueKeys: true, version: "1.2", schema: "core", prettyErrors: false });
    // Where the first fault is (a line number, nothing the file said): a person fixing a file needs it, and it quotes nothing.
    const offset = document.errors[0]?.pos?.[0];
    const line = offset === undefined ? undefined : text.slice(0, offset).split("\n").length;
    if (document.errors.length > 0) return { ok: false, problems: [problem("(file)", typeof line === "number" ? `${PLAYBOOK_NOT_YAML} (line ${String(line)})` : PLAYBOOK_NOT_YAML)] };
    // A tag Rovara does not read (`!foo`, a custom type) is a warning, not an error, and would read as plain text: a strict reader refuses it.
    if (document.warnings.length > 0) return { ok: false, problems: [problem("(file)", PLAYBOOK_TAG_MESSAGE)] };
    value = document.toJS({ maxAliasCount: YAML_MAX_ALIASES });
  } catch {
    return { ok: false, problems: [problem("(file)", PLAYBOOK_NOT_YAML)] };
  }
  if (value === null || value === undefined) return { ok: false, problems: [problem("(file)", "the file is empty; it starts with `version: 1`")] };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    // A stage that reads no rules is refused in words, not as an unknown key.
    const stages = (value as Record<string, unknown>)["stages"];
    if (typeof stages === "object" && stages !== null && !Array.isArray(stages)) {
      const unused = PLAYBOOK_UNUSED_STAGES.filter((id) => Object.hasOwn(stages, id));
      if (unused.length > 0) return { ok: false, problems: unused.map((id) => problem(`stages.${id}`, HOW_WE_WORK_UNUSED_STAGE_NOTE)) };
    }
  }
  const parsed = PlaybookFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, problems: problemsOf(parsed.error.issues) };
  return inertPlaybook(parsed.data);
}

/** The checked file with its texts inert and bounded, or the problems (a text over the limit, a design review approver this install does not have). */
export function inertPlaybook(file: PlaybookFile): PlaybookParse {
  const problems: PlaybookProblem[] = [];
  const clean = (text: PlaybookText | undefined, path: string): string | undefined => {
    if (text === undefined) return undefined;
    const inert = inertRuleText(joined(text));
    if (Array.from(inert).length > PLAYBOOK_RULE_TEXT_MAX) {
      problems.push(problem(path, PLAYBOOK_TOO_LONG_MESSAGE));
      return undefined;
    }
    return inert;
  };
  const rules = clean(file.rules, "rules");
  const stages: Partial<Record<PlaybookStageId, { instructions?: string }>> = {};
  for (const id of PLAYBOOK_STAGE_IDS) {
    const stage = file.stages?.[id];
    if (stage === undefined) continue;
    const instructions = clean(stage.instructions, `stages.${id}.instructions`);
    stages[id] = instructions === undefined ? {} : { instructions };
  }
  if (file.designReview !== undefined && file.designReview.highRiskApprover.kind !== "maintainers") problems.push(problem("designReview.highRiskApprover", PLAYBOOK_APPROVER_MESSAGE));
  if (problems.length > 0) return { ok: false, problems };
  const out: PlaybookFile = {
    version: file.version,
    ...(rules === undefined || rules === "" ? {} : { rules }),
    ...(Object.keys(stages).length === 0 ? {} : { stages }),
    ...(file.designReview === undefined ? {} : { designReview: file.designReview }),
  };
  // Empty texts (a rule of hidden characters only) are left out, so a file of them reads as no rules, and a stage with nothing in it is not kept.
  const kept = stageTexts(out);
  if (kept.length === 0) delete out.stages;
  else out.stages = Object.fromEntries(kept.map(([id, text]) => [id, { instructions: text }]));
  return { ok: true, file: out };
}

/**
 * The project's process layer the file stands for: the overlay Cloud stores for a project's process, with the project-wide rules as `instructions` and each stage's text as that step's
 * `instructions`. The guards Cloud puts on a process layer are run over it (the file's schema already refuses these; this is the same rule, checked again where the overlay is made).
 */
export function overlayOfPlaybook(file: PlaybookFile): RecipeOverlay {
  const overlay: RecipeOverlay = {
    ...(file.rules === undefined || joined(file.rules) === "" ? {} : { instructions: joined(file.rules) }),
    ...(stageTexts(file).length === 0 ? {} : { steps: Object.fromEntries(stageTexts(file).map(([id, text]) => [id, { instructions: text }])) }),
  };
  requireNoSequenceForProcess(PROCESS_LAYER, overlay);
  requireNoSkillsForProcess(PROCESS_LAYER, overlay);
  requireNoNewPullRequestInstructionsForProcess(PROCESS_LAYER, overlay);
  // The recipe's own limit on the size of a text (in bytes) is the last gate.
  return RecipeOverlaySchema.parse(overlay);
}

/** What the file says that matters, in one canonical text: a digest of it is the playbook's identity, so a comment or a change of white space is no change. */
export function playbookDigest(file: PlaybookFile): string {
  const rules = file.rules === undefined ? undefined : joined(file.rules);
  const stages = stageTexts(file).length === 0 ? undefined : Object.fromEntries(stageTexts(file));
  return createHash("sha256").update(canonicalJson({ version: file.version, rules: rules ?? null, stages: stages ?? null, designReview: file.designReview ?? null })).digest("hex");
}

/** The design review setting the file carries, if any. */
export const designReviewOfPlaybook = (file: PlaybookFile): DesignReviewSetting | undefined => file.designReview;

/** A file with nothing to say is the same as no file. */
export function playbookIsEmpty(file: PlaybookFile): boolean {
  return file.rules === undefined && file.stages === undefined && file.designReview === undefined;
}
