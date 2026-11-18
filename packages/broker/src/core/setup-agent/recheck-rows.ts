// L4-DR: the stored rows, keys, fixed words and the quiet evidence line of the setup re-check. Light on purpose (contracts and keys only): the task page's read imports it, and the re-check itself (recheck.ts) does not.
import { setupDriftWords, type DocumentKey, type OrgId, type SetupDriftClass } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
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

/**
 * The one quiet line a task shows when a re-check ran for it: "Checking setup again..." while it runs, "Setup re-checked after X changed: still works." once it passed, and nothing for a task that had no
 * drift (no link) or a re-check that could not be told. Never throws; a fault is no line.
 */
export async function setupRecheckLineOf(deps: Pick<TaskFlowDeps, "store" | "companyId">, project: string, taskId: string): Promise<string | undefined> {
  try {
    const orgId = deps.companyId;
    const link = await deps.store.get(driftTaskKey(orgId, project, taskId));
    if (!isRow(link, orgId, project, "SETUP_DRIFT_TASK") || link?.["taskId"] !== taskId || typeof link?.["recheckKey"] !== "string") return undefined;
    const noRecheck = (link as { noRecheck?: { classes?: unknown } }).noRecheck;
    if (noRecheck !== undefined) {
      const classes = Array.isArray(noRecheck.classes) ? (noRecheck.classes as SetupDriftClass[]) : [];
      return (noRecheck as { reason?: unknown }).reason === "off" ? setupMayBeOutOfDateWords(classes) : setupNotRecheckedWords(classes);
    }
    const stored = await deps.store.get(recheckRowKey(orgId, project, link["recheckKey"]));
    if (!isRow(stored, orgId, project, "SETUP_RECHECK")) return undefined;
    const row = stored as unknown as RecheckRow;
    switch (row.state) {
      case "running": return SETUP_CHECKING_WORDS;
      case "passed": return setupStillWorksWords(row.classes);
      case "tests_failing": return setupTestsFailingWords(row.classes);
      case "broken": return setupBrokenTaskWords(row.failedStep ?? "setup");
      case "unclear": return setupNotRecheckedWords(row.classes);
    }
  } catch {
    return undefined;
  }
}
