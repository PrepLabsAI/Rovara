// Quick size (SWITCH-TO-FULL, SF-1a): does a Quick plan look bigger than Quick? Pure code, never a model: no store, no clock, no model call. It reads the plan's own file list, the plan's setup changes and Understand's closed
// reason codes (never its free note), and answers with CODES. Words come from one table (`QUICK_SIZE_WORDS`, contracts/task-words.ts); nothing here writes a sentence.
//
// The one test for every code: would writing the requirements and a design first change the outcome of this task? Yes for a database change, a permission or infrastructure change, a change spread over many files, a new
// service the code talks to, or a request about money, sign-in, personal data, the data model or several repositories. (Owner O1: the offer is about DESIGN, not about any risk; O2: more than 15 files.)
//   STRONG (one is enough):  data_change, infra_change, many_files, new_service, design_reading.
//   MEDIUM (two different):  mid_size, sensitive_area, interface_file.
//   DISPLAY ONLY (a line shown under an offer something else caused; never counted): build_file, env_file, git_settings_file, package_source_setting, setup_small, instruction_file, hook_file.
// Not used at all: the plan's length, the tier's broad sensitive-word list, `confusable_path`, a step count, the expected cost, untested claims. CI and code-owner files are in no list (they are only counted, `counts.ciFiles`).
// A path code fires only on a COUNTED file (`countedFilesOf`: no documents, locks, vendored or generated files, tests or test data); the display-only lines read every planned path that is not a test.
import {
  DESIGN_REVIEW_HIGH_RISK_REASONS, QUICK_SIZE_ITEMS_MAX, QUICK_SIZE_REASONS_MAX, QUICK_SIZE_RECORDING_VERSION, QUICK_SIZE_TEXT_MAX,
  type DesignReason, type PlanDocument, type PlanSetupChangeItem, type QuickSizeClass, type QuickSizeCounts, type QuickSizeReason, type QuickSizeRecord, type WorkflowSnapshot,
} from "@agentx/contracts";
import { countedFilesOf, isEnvFilePath, isGitSettingsPath, isPackageSourcePath, isTestOrFixturePath, moduleCountOf } from "./change-tier.js";
import { planCitedPaths, planFiles, planText, planWorkPaths, pathsIn } from "./plan-facts.js";
import { QUICK_FILES_MEDIUM, QUICK_FILES_STRONG, isBuildFilePath, isDataChangePath, isInfraChangePath } from "./risk-tier.js";
import { isApiShapePath, isCiFilePath, isHookPath, isInstructionPath, normalizedTierPath } from "./sensitive-list.js";
import { isAccessOrMoneyPath } from "./sensitive-paths.js";
import { plainLine } from "./text.js";

export interface QuickSizeInput {
  /** The files the plan names (`planFiles`), or none. */
  paths: readonly string[];
  /** The plan's setup changes (kind, and the service for a dependency or a mock). */
  setupChanges: ReadonlyArray<{ kind: string; service?: string }>;
  /** Understand's reading of the need for a design: closed codes only. Undefined: no reading. */
  design?: { needed: boolean; reasons: readonly DesignReason[] } | undefined;
  /** A person chose Skip for the design review (never true at a Quick plan today: Skip exists only after a review is on, and that makes the path Full; read for that case anyway, S6). */
  designSkipped: boolean;
  /** The design review cannot run for this task (the project's setting is `never`, the company has it off, or the stage is not installed): `design_reading` is then a line, not a reason (owner O4). */
  designReviewOff: boolean;
  /** The setting could not be read (`designReviewOff` is then true too, so nothing is offered from the reading): recorded apart from a project that turned the review off. */
  settingUnread?: boolean | undefined;
  /** The plan could not be read (a Markdown plan, a missing file): no offer, and the record says why. */
  unread?: boolean | undefined;
  /** How the plan names its files, for the two checks before the rules are frozen (counted in `counts.citedOnly` and `counts.textOnly`). */
  claimPaths?: readonly string[] | undefined;
  workPaths?: readonly string[] | undefined;
  textPaths?: readonly string[] | undefined;
}

export interface QuickSizeResult {
  class: QuickSizeClass;
  triggered: boolean;
  unread: boolean;
  designReviewOff: boolean;
  settingUnread: boolean;
  counts: QuickSizeCounts;
  reasons: QuickSizeReason[];
}

/** The domain endings a URL pasted into a plan's text is recognised by (`docs.aws.amazon.com/iam/...`). Not a list of every domain: a first folder that is not one of these is read as a folder. */
const HOST_ENDING = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|co|ai|gov|edu|info|cloud|us|uk|de|eu|me|tv|ly|sh|xyz)\//u;

/**
 * A "path" that is really the address of a website: the plan's path reader (`planFiles`) takes `docs.aws.amazon.com/iam/latest/UserGuide/reference.html` out of a sentence as a file, which would be read as an IAM change.
 * Dropped here, before anything is counted or tested (this rule only: the tier's estimate and the plan card read the same list as they did).
 */
export const isHostLikePath = (path: string): boolean => path.includes("://") || HOST_ENDING.test(path.trim().toLowerCase());

const shown = (path: string): string => plainLine(path, QUICK_SIZE_TEXT_MAX);

/** One reason from the paths that caused it: the first few, and how many there were in all. */
function pathReason(code: string, paths: readonly string[]): QuickSizeReason | undefined {
  if (paths.length === 0) return undefined;
  return { code, paths: paths.slice(0, QUICK_SIZE_ITEMS_MAX).map(shown), ...(paths.length > QUICK_SIZE_ITEMS_MAX ? { total: paths.length } : {}) };
}

/** One reason that names things (services, design reason codes). */
function nameReason(code: string, names: readonly string[]): QuickSizeReason | undefined {
  const unique = [...new Set(names.map(shown).filter((name) => name !== ""))];
  if (unique.length === 0) return undefined;
  return { code, names: unique.slice(0, QUICK_SIZE_ITEMS_MAX), ...(unique.length > QUICK_SIZE_ITEMS_MAX ? { total: unique.length } : {}) };
}

const present = (...reasons: Array<QuickSizeReason | undefined>): QuickSizeReason[] => reasons.filter((reason): reason is QuickSizeReason => reason !== undefined);

/** Understand's high-risk reason codes only (a small change or a new API is not a reason); never after a person's Skip. */
const designReasonsOf = (input: QuickSizeInput): DesignReason[] =>
  input.design?.needed === true && !input.designSkipped ? input.design.reasons.filter((reason) => DESIGN_REVIEW_HIGH_RISK_REASONS.includes(reason)) : [];

interface Facts { named: string[]; counted: string[]; notTests: string[]; designReasons: DesignReason[]; designCounts: boolean }

function strongReasons(input: QuickSizeInput, facts: Facts): QuickSizeReason[] {
  const setupServices = input.setupChanges.filter((item) => item.kind === "dependency" || item.kind === "mock").map((item) => item.service ?? "");
  return present(
    pathReason("data_change", facts.counted.filter(isDataChangePath)),
    pathReason("infra_change", facts.counted.filter(isInfraChangePath)),
    facts.counted.length > QUICK_FILES_STRONG ? { code: "many_files" } : undefined,
    // A mock or a dependency is a new outside service; the service's name is plan text, kept as one line. No name: the reason has no sentence, so the kind stands in as the word.
    setupServices.length > 0 ? (nameReason("new_service", setupServices) ?? { code: "new_service", names: ["a new service"] }) : undefined,
    facts.designCounts ? nameReason("design_reading", facts.designReasons) : undefined,
  );
}

/** `mid_size` is the same fact as `many_files` one step down: it is not listed beside it. Each medium code is listed once, so two entries are two different codes. */
const mediumReasons = (facts: Facts): QuickSizeReason[] => present(
  facts.counted.length > QUICK_FILES_MEDIUM && facts.counted.length <= QUICK_FILES_STRONG ? { code: "mid_size" } : undefined,
  // A workflow file named `security.yml` is a CI file (counted only), not sign-in or payment code.
  pathReason("sensitive_area", facts.counted.filter((path) => isAccessOrMoneyPath(path) && !isCiFilePath(path))),
  pathReason("interface_file", facts.counted.filter(isApiShapePath)),
);

const displayReasons = (input: QuickSizeInput, facts: Facts): QuickSizeReason[] => present(
  pathReason("build_file", facts.notTests.filter(isBuildFilePath)),
  pathReason("env_file", facts.notTests.filter(isEnvFilePath)),
  pathReason("git_settings_file", facts.notTests.filter(isGitSettingsPath)),
  pathReason("package_source_setting", facts.notTests.filter(isPackageSourcePath)),
  input.setupChanges.some((item) => item.kind === "command" || item.kind === "variable") ? { code: "setup_small" } : undefined,
  pathReason("instruction_file", facts.notTests.filter(isInstructionPath)),
  pathReason("hook_file", facts.notTests.filter(isHookPath)),
  // Understand's reading where the review cannot run: shown, never counted.
  facts.designReasons.length > 0 && !facts.designCounts ? nameReason("design_reading", facts.designReasons) : undefined,
);

function countsOf(input: QuickSizeInput, facts: Facts): QuickSizeCounts {
  const known = new Set(facts.named);
  const claim = new Set(input.claimPaths ?? []);
  const work = new Set(input.workPaths ?? []);
  return {
    counted: facts.counted.length, named: facts.named.length, modules: moduleCountOf(facts.counted),
    ...(input.claimPaths === undefined ? {} : { citedOnly: facts.counted.filter((path) => claim.has(path) && !work.has(path)).length }),
    ...(input.textPaths === undefined ? {} : { textOnly: countedFilesOf(input.textPaths.filter((path) => !isHostLikePath(path))).filter((path) => !known.has(path)).length }),
    ciFiles: facts.notTests.filter((path) => isCiFilePath(path) || /(^|\/)codeowners$/u.test(normalizedTierPath(path))).length,
  };
}

export function quickSizeOf(input: QuickSizeInput): QuickSizeResult {
  const named = [...new Set(input.paths.map((path) => path.trim()).filter((path) => path.length > 0 && !isHostLikePath(path)))];
  if (input.unread === true) {
    return { class: "none", triggered: false, unread: true, designReviewOff: input.designReviewOff && !input.settingUnread && designReasonsOf(input).length > 0, settingUnread: input.settingUnread === true && designReasonsOf(input).length > 0, counts: { counted: 0, named: named.length, modules: 0 }, reasons: [] };
  }
  const designReasons = designReasonsOf(input);
  // A design reading counts only where the review can run: otherwise the person could not get the design review the offer is about (the plan-evidence codes still offer Full without it).
  const facts: Facts = { named, counted: countedFilesOf(named), notTests: named.filter((path) => !isTestOrFixturePath(path)), designReasons, designCounts: designReasons.length > 0 && !input.designReviewOff };
  const strong = strongReasons(input, facts);
  const medium = mediumReasons(facts);
  const quickClass: QuickSizeClass = strong.length > 0 ? "strong" : medium.length >= 2 ? "pair" : "none";
  return {
    class: quickClass, triggered: quickClass !== "none", unread: false, designReviewOff: input.designReviewOff && input.settingUnread !== true && designReasons.length > 0, settingUnread: input.settingUnread === true && designReasons.length > 0,
    counts: countsOf(input, facts), reasons: [...strong, ...medium, ...displayReasons(input, facts)].slice(0, QUICK_SIZE_REASONS_MAX),
  };
}

/** What the rule reads from a structured plan and the workflow it was written in. `designReviewOff` is the caller's (it takes the project's setting). Undefined plan: the plan could not be read. */
export function quickSizeInputOf(input: { plan: PlanDocument | undefined; workflow: Pick<WorkflowSnapshot, "intent" | "designReview">; designReviewOff: boolean; settingUnread?: boolean }): QuickSizeInput {
  const assessment = input.workflow.intent?.assessment;
  const design = assessment?.kind === "ready" ? assessment.design : undefined;
  const common = {
    setupChanges: [] as QuickSizeInput["setupChanges"], design: design === undefined ? undefined : { needed: design.needed, reasons: design.reasons },
    designSkipped: input.workflow.designReview?.decidedBy === "person_skip", designReviewOff: input.designReviewOff, settingUnread: input.settingUnread === true,
  };
  const plan = input.plan;
  if (plan === undefined) return { ...common, paths: [], unread: true };
  const setupChanges = (plan.setupChanges ?? []).map((item: PlanSetupChangeItem) => ({ kind: item.kind, ...(item.kind === "mock" || item.kind === "dependency" ? { service: item.service } : {}) }));
  return {
    ...common, setupChanges, paths: planFiles(plan), unread: false,
    claimPaths: planCitedPaths(plan), workPaths: planWorkPaths(plan), textPaths: pathsIn(planText(plan)),
  };
}

/** The record the task row holds: the result with the plan it is for, when it was written and the version of the rules. */
export function quickSizeRecordOf(result: QuickSizeResult, bound: { planDigest: string; workflowRevision: number; at: string; rulesVersion?: number; kept?: QuickSizeRecord["kept"] }): QuickSizeRecord {
  return {
    rulesVersion: bound.rulesVersion ?? QUICK_SIZE_RECORDING_VERSION, planDigest: bound.planDigest, workflowRevision: bound.workflowRevision, at: bound.at,
    class: result.class, triggered: result.triggered, ...(result.unread ? { unread: true as const } : {}), ...(result.designReviewOff ? { designReviewOff: true as const } : {}), ...(result.settingUnread ? { settingUnread: true as const } : {}),
    counts: result.counts, ...(bound.kept === undefined ? {} : { kept: bound.kept }), reasons: result.reasons,
  };
}
