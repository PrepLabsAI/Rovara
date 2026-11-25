// Quick size (SWITCH-TO-FULL, SF-1a): the record of how big a Quick plan looked when it was written. Code wrote it once, at plan write, from the plan's own files, its setup changes and Understand's closed reasons; it
// is stored beside the plan on the task row (`task.quickSize`), never inside the workflow (the workflow's snapshot schemas are strict, and an older release would refuse a new member).
// Version 0 only RECORDS: no surface offers anything from it. A later version (1) turns the buttons on; the record says which version wrote it.
//
// Reads are tolerant (arch rule 8): `readQuickSize` takes what is stored member by member, ignores what it does not know, drops a reason it cannot read and never throws. A record that is absent, or has no class or no
// plan digest, is "no record", which every caller reads as "nothing to offer"; nothing here falls back to computing the answer again (arch rule 9).

import { DESIGN_REASONS, type DesignReason } from "./design-review.js";
import { designReasonPhrase } from "./design-review-words.js";
import { QUICK_SIZE_UNKNOWN_WORD, QUICK_SIZE_WORDS } from "./task-words.js";

/** One strong reason is enough to offer Full. */
export const QUICK_SIZE_STRONG_CODES = ["data_change", "infra_change", "many_files", "new_service", "design_reading"] as const;
/** Two different medium reasons together offer Full; one alone never does. */
export const QUICK_SIZE_MEDIUM_CODES = ["mid_size", "sensitive_area", "interface_file"] as const;
/** Lines shown under an offer something else caused. They never count, alone or together. */
export const QUICK_SIZE_DISPLAY_CODES = ["build_file", "env_file", "git_settings_file", "package_source_setting", "setup_small", "instruction_file", "hook_file"] as const;
export const QUICK_SIZE_CODES = [...QUICK_SIZE_STRONG_CODES, ...QUICK_SIZE_MEDIUM_CODES, ...QUICK_SIZE_DISPLAY_CODES] as const;
export type QuickSizeCode = (typeof QUICK_SIZE_CODES)[number];
export const isQuickSizeCode = (value: unknown): value is QuickSizeCode => typeof value === "string" && (QUICK_SIZE_CODES as readonly string[]).includes(value);

/** What made the plan an offer: one strong reason, a pair of different medium reasons, or nothing. */
export const QUICK_SIZE_CLASSES = ["strong", "pair", "none"] as const;
export type QuickSizeClass = (typeof QUICK_SIZE_CLASSES)[number];

/** The version the first build writes: recorded, never offers. */
export const QUICK_SIZE_RECORDING_VERSION = 0;
/** The first version that offers (written when the buttons ship). */
export const QUICK_SIZE_OFFERING_VERSION = 1;

export const QUICK_SIZE_REASONS_MAX = 16;
/** Paths (or names) kept with one reason; `total` says how many there were. */
export const QUICK_SIZE_ITEMS_MAX = 3;
export const QUICK_SIZE_TEXT_MAX = 200;

export interface QuickSizeReason {
  code: string;
  /** Up to `QUICK_SIZE_ITEMS_MAX` planned paths that caused the reason (plan text, flattened to one line). */
  paths?: string[];
  /** Names that complete the sentence: the outside services of `new_service`, the design reason codes of `design_reading`. */
  names?: string[];
  /** How many paths or names there were in all, when more than were kept. */
  total?: number;
}

export interface QuickSizeCounts {
  /** Code files counted (no documents, locks, vendored or generated files, tests). */
  counted: number;
  /** Distinct paths the plan names, counted or not. */
  named: number;
  /** Modules of the counted files. */
  modules: number;
  /** Counted paths only claim evidence names (the plan may only READ them as proof): the check before the rules are frozen. */
  citedOnly?: number;
  /** Counted paths only the plan's prose names, which the plan's file list does not hold: the other check before the freeze. */
  textOnly?: number;
  /** Planned CI and code-owner files (`.github/workflows`, `CODEOWNERS`, ...): in no list, so they neither offer nor show; counted here so the owner can decide with data. */
  ciFiles?: number;
}

/** What a person's "Keep Quick" left on the record (written by the action, SF-2): the codes it was kept against. A revised plan's record carries it over, so a later plan write cannot erase it. */
export interface QuickSizeKept { codes: string[]; by: string; at: string; requestId: string }

export interface QuickSizeRecord {
  rulesVersion: number;
  /** The digest of the plan this was worked out for (the waiting document's digest). */
  planDigest: string;
  /** The workflow revision the plan was committed at, when readable. */
  workflowRevision?: number;
  at: string;
  class: QuickSizeClass;
  triggered: boolean;
  /** The plan's files could not be read: no offer, and this says why. */
  unread?: true;
  /** Design review could not run for this task (the project's setting is `never`, or the company has it off): `design_reading` is then a line, not a reason. */
  designReviewOff?: true;
  /** The project's design review setting could not be read when the plan was written (a read failed or ran out of time): `design_reading` is a line this time, and this says the setting was not seen, which is not the same as `never`. */
  settingUnread?: true;
  counts: QuickSizeCounts;
  /** A person kept Quick against these codes. Only the Keep action writes it; the plan write only carries it. */
  kept?: QuickSizeKept;
  /** Strong, then medium, then display-only. */
  reasons: QuickSizeReason[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const wholeNumber = (value: unknown): number | undefined => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const text = (value: unknown, max = QUICK_SIZE_TEXT_MAX): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,39}$/u;

function readReason(value: unknown): QuickSizeReason | undefined {
  if (!isObject(value) || typeof value["code"] !== "string" || !CODE_SHAPE.test(value["code"])) return undefined;
  const items = (member: unknown): string[] | undefined => {
    if (!Array.isArray(member)) return undefined;
    const kept = member.flatMap((item) => { const line = text(item); return line === undefined ? [] : [line]; }).slice(0, QUICK_SIZE_ITEMS_MAX);
    return kept.length === 0 ? undefined : kept;
  };
  const paths = items(value["paths"]);
  const names = items(value["names"]);
  const total = wholeNumber(value["total"]);
  return { code: value["code"], ...(paths === undefined ? {} : { paths }), ...(names === undefined ? {} : { names }), ...(total === undefined ? {} : { total }) };
}

function readCounts(value: unknown): QuickSizeCounts {
  const source = isObject(value) ? value : {};
  const optional = (key: string): { [name: string]: number } => { const number = wholeNumber(source[key]); return number === undefined ? {} : { [key]: number }; };
  return { counted: wholeNumber(source["counted"]) ?? 0, named: wholeNumber(source["named"]) ?? 0, modules: wholeNumber(source["modules"]) ?? 0, ...optional("citedOnly"), ...optional("textOnly"), ...optional("ciFiles") };
}

function readKept(value: unknown): QuickSizeKept | undefined {
  if (!isObject(value) || !Array.isArray(value["codes"])) return undefined;
  const by = text(value["by"]);
  const at = text(value["at"], 64);
  const requestId = text(value["requestId"]);
  if (by === undefined || at === undefined || requestId === undefined) return undefined;
  const codes = value["codes"].filter((code): code is string => typeof code === "string" && CODE_SHAPE.test(code)).slice(0, QUICK_SIZE_REASONS_MAX);
  return { codes, by, at, requestId };
}

/**
 * The record a task row holds under `quickSize`, or undefined (no record: absent, not an object, no known class, no plan digest). Members are read one by one: an unreadable count is zero, an unreadable reason is dropped,
 * a code this release does not know is kept (a newer release's reason is shown with the one generic sentence), and anything else in the record is ignored. Never throws.
 */
export function readQuickSize(value: unknown): QuickSizeRecord | undefined {
  if (!isObject(value)) return undefined;
  const rulesVersion = wholeNumber(value["rulesVersion"]);
  const planDigest = text(value["planDigest"], 128);
  const at = text(value["at"], 64);
  const quickClass = QUICK_SIZE_CLASSES.find((candidate) => candidate === value["class"]);
  if (rulesVersion === undefined || planDigest === undefined || at === undefined || quickClass === undefined) return undefined;
  const reasons = (Array.isArray(value["reasons"]) ? value["reasons"] : []).flatMap((item) => { const reason = readReason(item); return reason === undefined ? [] : [reason]; }).slice(0, QUICK_SIZE_REASONS_MAX);
  const workflowRevision = wholeNumber(value["workflowRevision"]);
  const kept = readKept(value["kept"]);
  return {
    rulesVersion, planDigest, at, class: quickClass, triggered: value["triggered"] === true && quickClass !== "none" && value["unread"] !== true,
    ...(workflowRevision === undefined ? {} : { workflowRevision }), ...(value["unread"] === true ? { unread: true as const } : {}), ...(value["designReviewOff"] === true ? { designReviewOff: true as const } : {}), ...(value["settingUnread"] === true ? { settingUnread: true as const } : {}),
    counts: readCounts(value["counts"]), ...(kept === undefined ? {} : { kept }), reasons,
  };
}

/** "a.ts, b.ts, c.ts and 2 more": at most three paths, then how many were left out. */
const pathsWords = (reason: QuickSizeReason): string => {
  const shown = (reason.paths ?? []).slice(0, QUICK_SIZE_ITEMS_MAX);
  if (shown.length === 0) return "";
  const more = Math.max(0, (reason.total ?? shown.length) - shown.length);
  return `${shown.join(", ")}${more > 0 ? ` and ${String(more)} more` : ""}`;
};

/** The fixed phrases of Understand's closed reasons, joined ("touches money or billing and touches personal data"). A code that is not a design reason is left out. */
const designWords = (names: readonly string[] | undefined): string => {
  const known = (names ?? []).filter((name): name is DesignReason => (DESIGN_REASONS as readonly string[]).includes(name));
  return known.map((name) => designReasonPhrase(name)).join(" and ");
};

/**
 * The sentence for one stored reason. A code the table does not know, or a sentence that cannot be completed (a path-less line for a code that needs paths), is the one generic sentence: a card never shows a hole.
 * The paths and names were flattened to one line when they were stored; a surface still draws them as inert text.
 */
export function quickSizeSentence(reason: QuickSizeReason, counts: Pick<QuickSizeCounts, "counted">): string {
  const template = Object.hasOwn(QUICK_SIZE_WORDS, reason.code) ? QUICK_SIZE_WORDS[reason.code] : undefined;
  if (template === undefined) return QUICK_SIZE_UNKNOWN_WORD;
  const paths = pathsWords(reason);
  const service = (reason.names ?? []).slice(0, QUICK_SIZE_ITEMS_MAX).join(", ");
  const design = designWords(reason.names);
  // A count the record could not give is a hole, not "0 code files".
  if (template.includes("{count}") && counts.counted <= 0) return QUICK_SIZE_UNKNOWN_WORD;
  if ((template.includes("{paths}") && paths === "") || (template.includes("{service}") && service === "") || (template.includes("{design}") && design === "")) return QUICK_SIZE_UNKNOWN_WORD;
  // One pass over the template: plan text such as `{count}` or `$&` is a word here, never a placeholder or a replacement pattern.
  const values: Record<string, string> = { paths, count: String(counts.counted), service, design };
  return template.replace(/\{(paths|count|service|design)\}/gu, (_match, key: string) => values[key] ?? "");
}
