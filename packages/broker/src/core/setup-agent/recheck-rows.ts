// L4-DR: the stored rows, keys, fixed words and the quiet evidence line of the setup re-check. Light on purpose (contracts and keys only): the task page's read imports it, and the re-check itself (recheck.ts) does not.
import { setupDriftWords, type DocumentKey, type DocumentStore, type OrgId, type SetupDriftClass } from "@agentx/contracts";
import type { SetupCheckMark } from "./check.js";
import { setupPartition } from "./keys.js";

export const RECHECK_STATES = ["running", "passed", "tests_failing", "unclear", "broken"] as const;
export type RecheckState = (typeof RECHECK_STATES)[number];

export const recheckRowKey = (orgId: OrgId, project: string, key: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: `RECHECK#${key}` });
export const recheckCurrentKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: "RECHECK_CURRENT" });
export const driftTaskKey = (orgId: OrgId, project: string, taskId: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: `DRIFT_TASK#${taskId}` });
export const repairNoticeKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: "REPAIR_NOTICE" });

// ---- the words (fixed; the only repository text is the check's own redacted failing step)

/** The quiet line on the task page while the re-check runs (design 3b). */
export const SETUP_CHECKING_WORDS = "Checking setup again. Your code changed since setup was approved.";
const afterWords = (classes: readonly SetupDriftClass[]): string => (classes.length === 0 ? "Setup re-checked" : `Setup re-checked after ${setupDriftWords(classes)} changed`);
/** The one evidence line of a re-check that found the setup working. */
export const setupStillWorksWords = (classes: readonly SetupDriftClass[]): string => `${afterWords(classes)}: still works.`;
export const setupTestsFailingWords = (classes: readonly SetupDriftClass[]): string => `${afterWords(classes)}: the setup works; some tests were already failing.`;
/** DEC 254zzl: the quiet note when the re-check could not run or could not finish (the cap is used, a machine failed, the check never answered): the task started and goes on all the same. */
export const setupNotRecheckedWords = (classes: readonly SetupDriftClass[]): string => (classes.length === 0 ? "Couldn't re-check setup." : `Couldn't re-check setup after ${setupDriftWords(classes)} changed.`);
/** DEC 254zzl: with the company's system runs off, the free check still compares (it only reads names) and says so quietly; nothing is started, and the task starts all the same. A person starts "Re-check setup". */
export const setupMayBeOutOfDateWords = (classes: readonly SetupDriftClass[]): string => (classes.length === 0 ? "Setup may be out of date." : `Setup may be out of date after ${setupDriftWords(classes)} changed.`);
/** What the requester is told when the task pauses before Build (design 3c), with the check's failing step. */
export const setupBrokenTaskWords = (failedStep: string): string =>
  `I can't build this yet. This project's setup stopped working after recent code changes (${failedStep}). I've asked the project's admins to approve a fix. Retry this step once the setup is fixed.`;

/**
 * L4-U5: the fixed words every surface shares (the web card, the chat thread, the ticket, the admins' notice). Slack and Linear carry the same sentences as the web and never a dollar figure: what a fix costs is said
 * on the web page only, where the person presses the button.
 */
export const SETUP_REPAIR_WORDS = { title: "Setup needs repair", fixSetup: "Fix setup", approveNewSetup: "Approve new setup", recheckSetup: "Re-check setup", openSetup: "Setup page" } as const;
/** What the project's admins are told when its setup broke (once per project and re-check): the card's sentence and the one action that fits (`fixReady`: a checked fix waits for approval). No cost, no repository text beyond the check's own failing step. */
export const setupAdminNoticeWords = (failedStep: string, fixReady = false): string =>
  `${SETUP_REPAIR_WORDS.title}. The project's setup stopped working after recent code changes (${inertSetupStep(failedStep)}). Rovara cannot build on this project until it is fixed. ${fixReady ? SETUP_REPAIR_WORDS.approveNewSetup : SETUP_REPAIR_WORDS.fixSetup} on the setup page.`;

/** Where the person goes: the setup page's link when the host has one (a plain https address), else the words that say to open it in Rovara. The same on every surface. */
export const setupPageWords = (url?: string): string => (url === undefined ? "Open the project's setup page in Rovara." : `${SETUP_REPAIR_WORDS.openSetup}: ${url}`);
/** A plain https address with no sign-in data (the only kind that goes into a chat or a ticket), or undefined. */
export function plainSetupLink(link: string | undefined): string | undefined {
  if (link === undefined) return undefined;
  try {
    const url = new URL(link);
    return url.protocol === "https:" && url.username === "" && url.password === "" && link.length <= 2000 && !/[\s<>\p{Cc}]/u.test(link) ? url.toString() : undefined;
  } catch { return undefined; }
}
/** The check's failing step made safe for a chat or a ticket (it is repository text): no controls, no mention, link or markup characters (`@ < > ` [ ] * _ ~ # | !` and `//`), one line, cut. Plain steps such as `setup step 0 (npm ci) failed: exit 1` are unchanged. */
export const inertSetupStep = (step: string): string => step.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/[@<>`[\]*_~#|!]/gu, "").replace(/:\/\//gu, ": ").replace(/\/\/+/gu, "/").replace(/\s+/gu, " ").trim().slice(0, 200);
/** What the requester reads in the chat thread and on the ticket when their task paused before Build: the task page's own sentence, then where to go. One message, no buttons, no cost. */
export const setupPausedMessage = (failedStep: string, setupUrl?: string): string => `${setupBrokenTaskWords(inertSetupStep(failedStep))}\n${setupPageWords(plainSetupLink(setupUrl))}`;

export interface SetupRepairCard {
  title: "Setup needs repair";
  body: string;
  /** Who may act: a project maintainer approves a low or medium fix, a company admin a high one (L4-D). */
  actions: ReadonlyArray<{ id: "fix_setup" | "edit_commands"; label: string }>;
}
/** The admin card of a project whose setup is broken (design 3c, "no fix yet"): the failing step and the two ways out. Both start a NEW setup candidate that a person approves. */
export const setupRepairCardOf = (failedStep: string): SetupRepairCard => ({
  title: "Setup needs repair",
  body: `The project's setup stopped working after recent code changes (${failedStep}). Rovara cannot build on this project until it is fixed.`,
  actions: [{ id: "fix_setup", label: "Fix setup (uses your AI)" }, { id: "edit_commands", label: "Edit commands myself" }],
});

// ---- the stored rows

export interface RecheckRow {
  entityType: "SETUP_RECHECK"; orgId: OrgId; project: string; key: string;
  /** The project revision the re-check ran for. */
  setupRevision: number;
  commits: Record<string, string>;
  /** What changed, as fixed classes (empty when it could not be told). */
  classes: SetupDriftClass[];
  state: RecheckState;
  attempt: 1 | 2;
  check: SetupCheckMark;
  startedAt: string; decidedAt?: string;
  /** When the first attempt's failure was first seen (the retry waits from then). */
  failedSeenAt?: string;
  /** The check's own failing step (redacted, one line, cut), kept when the result was broken. */
  failedStep?: string;
}
export interface DriftTaskRow { entityType: "SETUP_DRIFT_TASK"; orgId: OrgId; project: string; taskId: string; recheckKey: string; state: "pending" | "released"; at: string; releasedAt?: string;
  /** The re-check could not be started at all (the cap is used): nothing to wait on, and the task page says so quietly. */
  noRecheck?: { classes: SetupDriftClass[]; /** `off`: the company's system runs are off, so nothing was started on purpose. */ reason?: "off" } }
export interface RepairNoticeRow { entityType: "SETUP_REPAIR_NOTICE"; orgId: OrgId; project: string; key: string; failedStep: string; classes: SetupDriftClass[]; at: string }

export const isRow = (row: Record<string, unknown> | undefined, orgId: OrgId, project: string, type: string): boolean => row !== undefined && row["entityType"] === type && row["orgId"] === orgId && row["project"] === project;

// ---- the evidence line

/** The states a task's setup evidence can be in. `not_rechecked`: the check could not run or finish; `may_be_out_of_date`: the company's automatic runs are off, so nothing was started. */
/** What the evidence reads: the company's store and the company (a read only). */
export interface EvidenceReader { store: Pick<DocumentStore, "get">; companyId: OrgId }
export type SetupEvidenceState = RecheckState | "not_rechecked" | "may_be_out_of_date";
export interface SetupEvidence {
  state: SetupEvidenceState;
  line: string;
  /** The result gives less reason to trust the task's tests (the check could not be made or finished): the PR and the chat message say so. A pass, a running check and failing tests do not (the PR's Testing section already names those). */
  lowersTrust: boolean;
  /** The re-check this evidence is about (absent when none was started). Used to tell a chat once per re-check. */
  recheckKey?: string;
  failedStep?: string;
}

/**
 * What a re-check says about one task: the one line and its state, or nothing for a task that had no drift (no link) or a re-check that could not be told. Never throws; a fault is no evidence.
 */
export async function setupEvidenceOf(deps: EvidenceReader, project: string, taskId: string): Promise<SetupEvidence | undefined> {
  try {
    const orgId = deps.companyId;
    const link = await deps.store.get(driftTaskKey(orgId, project, taskId));
    if (!isRow(link, orgId, project, "SETUP_DRIFT_TASK") || link?.["taskId"] !== taskId || typeof link?.["recheckKey"] !== "string") return undefined;
    const noRecheck = (link as { noRecheck?: { classes?: unknown } }).noRecheck;
    if (noRecheck !== undefined) {
      const classes = Array.isArray(noRecheck.classes) ? (noRecheck.classes as SetupDriftClass[]) : [];
      return (noRecheck as { reason?: unknown }).reason === "off"
        ? { state: "may_be_out_of_date", line: setupMayBeOutOfDateWords(classes), lowersTrust: true }
        : { state: "not_rechecked", line: setupNotRecheckedWords(classes), lowersTrust: true };
    }
    const stored = await deps.store.get(recheckRowKey(orgId, project, link["recheckKey"]));
    if (!isRow(stored, orgId, project, "SETUP_RECHECK")) return undefined;
    const row = stored as unknown as RecheckRow;
    const base = { recheckKey: row.key };
    switch (row.state) {
      case "running": return { ...base, state: "running", line: SETUP_CHECKING_WORDS, lowersTrust: false };
      case "passed": return { ...base, state: "passed", line: setupStillWorksWords(row.classes), lowersTrust: false };
      case "tests_failing": return { ...base, state: "tests_failing", line: setupTestsFailingWords(row.classes), lowersTrust: false };
      case "broken": return { ...base, state: "broken", line: setupBrokenTaskWords(row.failedStep ?? "setup"), lowersTrust: false, failedStep: row.failedStep ?? "setup" };
      case "unclear": return { ...base, state: "unclear", line: setupNotRecheckedWords(row.classes), lowersTrust: true };
    }
  } catch {
    return undefined;
  }
}

/**
 * The one quiet line a task shows when a re-check ran for it: "Checking setup again..." while it runs, "Setup re-checked after X changed: still works." once it passed, and nothing for a task that had no
 * drift (no link) or a re-check that could not be told. Never throws; a fault is no line.
 */
export async function setupRecheckLineOf(deps: EvidenceReader, project: string, taskId: string): Promise<string | undefined> {
  return (await setupEvidenceOf(deps, project, taskId))?.line;
}

/** The evidence line only when it lowers trust (the chat message and the ticket comment carry it; a pass never posts there). */
export async function setupTrustLineOf(deps: EvidenceReader, project: string, taskId: string): Promise<string | undefined> {
  const evidence = await setupEvidenceOf(deps, project, taskId);
  return evidence?.lowersTrust === true ? evidence.line : undefined;
}

/** The line a pull request carries about the setup (a finished re-check or the note that none could be made); nothing while it runs or after a break (a broken setup never opens a pull request). */
export async function setupPullRequestLineOf(deps: EvidenceReader, project: string, taskId: string): Promise<string | undefined> {
  const evidence = await setupEvidenceOf(deps, project, taskId);
  return evidence === undefined || evidence.state === "running" || evidence.state === "broken" ? undefined : evidence.line;
}
