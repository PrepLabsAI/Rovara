// L4-RD (DEC 254z c, 254zza; setup-upkeep-plan.md decision 1, "if it needs a person"): the stored rows, keys and fixed words of an automatic repair draft. Light on purpose (contracts and keys only), so the route
// and the card import it without the repair itself (repair-draft.ts).
//
// What a repair draft is: when a free re-check finds "setup broken" (recheck.ts) and a person turned upkeep ON with cap room, Rovara starts ONE setup-agent run (the project's customer key, the setup agent's existing
// limits, about $4), stores what it found as a CANDIDATE setup, checks the candidate on a fresh machine, and shows the project's maintainers "Approve new setup". Rovara never approves it: the decision is a person's,
// through the hosted approval gate and its risk-based approvers (L4-D, #899). Nothing in these rows says a setup is approved or makes it so.
//
// Rows, in the project's setup partition (`setupPartition(orgId, project)`), so another company's project of the same name never meets them:
//   REPAIR#<recheckKey>   ONE repair draft per failure (the re-check that found it broken): its state, the run's task, the request ids, why it ended
//   REPAIR_CURRENT        the project's latest repair draft: when it started (the project's cooldown reads this)
import type { DocumentKey, OrgId, SetupDriftClass } from "@agentx/contracts";
import { setupPartition } from "./keys.js";

/** starting: the claim is made and the run is being started. drafting: the setup run is going. checking: the candidate's check is going. ready: the candidate passed its check and waits for a person. approved: a person approved it.
 *  failed: the draft did not work (see `reason`); it is final, one repair per failure. ended: the draft stopped mattering (the project moved on, or a person rejected or discarded it). */
export const REPAIR_STATES = ["starting", "drafting", "checking", "ready", "approved", "failed", "ended"] as const;
export type RepairState = (typeof REPAIR_STATES)[number];
export const REPAIR_REASONS = ["run_failed", "no_usable_fix", "check_failed", "superseded", "decided"] as const;
export type RepairReason = (typeof REPAIR_REASONS)[number];

export const repairRowKey = (orgId: OrgId, project: string, key: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: `REPAIR#${key}` });
export const repairCurrentKey = (orgId: OrgId, project: string): DocumentKey => ({ pk: setupPartition(orgId, project), sk: "REPAIR_CURRENT" });

export interface RepairRow {
  entityType: "SETUP_REPAIR"; orgId: OrgId; project: string;
  /** The re-check this repairs: one repair per key. */
  key: string;
  /** The project revision that broke. A repair for any other revision is over. */
  setupRevision: number;
  /** The setup run's request id and the candidate's request id (both derived from `key`, so a repeat is the same one). */
  runRequestId: string; confirmRequestId: string;
  state: RepairState;
  /** The setup run's task, once it started. */
  taskId?: string;
  reason?: RepairReason;
  /** The run's own stop word when it failed (a fixed word, never text). */
  stop?: string;
  budgetCents: number;
  claimedAt: string; startedAt?: string; decidedAt?: string;
}
export interface RepairCurrentRow { entityType: "SETUP_REPAIR_CURRENT"; orgId: OrgId; project: string; key: string; startedAt: string }

/** The least time between two automatic repair drafts of one project: a failure that comes back with every commit costs one draft at a time, never one per commit. */
export const REPAIR_COOLDOWN_MS = 12 * 3_600_000;
/** A claim whose run never started (a fault between the claim and the start) is given back after this. */
export const REPAIR_START_STALE_MS = 10 * 60_000;
/** The unattended door's time limit for the run: the setup run's own wall clock, and a quarter hour for it to end. */
export const REPAIR_GRACE_MINUTES = 15;

// ---- the words (fixed: the only repository text is the check's own redacted failing step)

export const REPAIR_WORDS = {
  drafting: "Rovara is drafting a fix for the setup. It will ask you to approve it. Nothing changes until you do.",
  failed: {
    run_failed: "Rovara tried to draft a fix but could not finish. Nothing was changed.",
    no_usable_fix: "Rovara drafted a fix but none of it could be used. Nothing was changed.",
    check_failed: "Rovara drafted a fix but it did not pass its check on a fresh machine. Nothing was changed.",
  },
} as const;

/** "$4" for 400 cents, "$1.50" for 150. */
export const dollarsOf = (cents: number): string => `$${cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)}`;
/** The label of the manual way out (upkeep off, the cap used up, or a draft that failed): one click by an admin starts the same setup run. */
export const fixSetupLabel = (budgetCents: number): string => `Fix setup (uses your AI, up to ${dollarsOf(budgetCents)})`;

export type RepairAction = { id: "approve_setup" | "see_changes" | "fix_setup" | "edit_commands"; label: string };
/** The admin card of a broken setup (design 3c): a checked fix to approve, a draft on its way, or the manual way out. */
export interface SetupRepairView {
  title: "Setup needs repair";
  state: "fix_ready" | "drafting" | "no_fix";
  body: string;
  actions: RepairAction[];
  classes: SetupDriftClass[];
  at: string;
  /** The candidate waiting for a person (state `fix_ready`), and how many changes it makes. */
  candidateRevision?: number;
  changes?: number;
  /** Why the last automatic draft did not work, in a fixed word (state `no_fix`). */
  failure?: RepairReason;
}
