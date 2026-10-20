import { canonicalJson, type E2EApplicationSelectionRecord } from "@agentx/contracts";

/**
 * A dispatch of an approved application round that must not happen, with the plain reason the owner sees. It is terminal for that dispatch: the
 * workflow is blocked with the reason (the owner can send the task back, retry the checks, or close it) and the dispatch is not retried.
 * A dispatch that merely could not read what it needs is not this: it fails like any other and is retried within its budget.
 */
export class ApplicationDispatchRefusal extends Error {}

type RuntimeRow = E2EApplicationSelectionRecord["runtimeRows"][number];
const rowKey = (row: RuntimeRow) => `${row.kind}:${row.profileId}`;
const describeRow = (row: RuntimeRow) => `${row.kind} runtime ${row.profileId} (generation ${row.generation}, expires ${row.expiresAt})`;

/**
 * Ruling AL, dispatch half. `current` is the selection derived again at dispatch from the approved setup and the rows READY now; `recorded` is what the
 * Owner approved. Dispatch may run only what was approved, so any change refuses and nothing is ever widened: the intent, the executable targets, the
 * exact runtime rows (a row that was replaced, re-qualified, re-bound or is about to expire is not the approved one), and the approvals the derivation
 * rests on. The approval-time plan and bundle digests are never compared: they are derived under the approval's plan identity, which dispatch does not share.
 */
export function applicationSelectionStillCurrent(recorded: E2EApplicationSelectionRecord, current: E2EApplicationSelectionRecord): { ok: true } | { ok: false; reason: string } {
  if (recorded.intentDigest !== current.intentDigest) return { ok: false, reason: "the approved plan's E2E intent is not the one the selection was approved for" };
  if (canonicalJson(recorded.semanticApproval) !== canonicalJson(current.semanticApproval)) return { ok: false, reason: "the plan approval this selection rests on has changed" };
  if (canonicalJson(recorded.setupApproval) !== canonicalJson(current.setupApproval)) return { ok: false, reason: "the setup approval this selection rests on has changed" };
  if (recorded.applicationApprovalBindingDigest !== current.applicationApprovalBindingDigest) return { ok: false, reason: "the approved applications' source, recipe or runtime assignment has changed" };
  if (canonicalJson([...recorded.executableTargetIds].sort()) !== canonicalJson([...current.executableTargetIds].sort())) {
    return { ok: false, reason: "the targets that can run application scenarios are not the ones that were approved" };
  }
  const approved = new Map(recorded.runtimeRows.map((row) => [rowKey(row), row]));
  const now = new Map(current.runtimeRows.map((row) => [rowKey(row), row]));
  for (const [key, row] of approved) {
    const actual = now.get(key);
    if (actual === undefined) return { ok: false, reason: `the approved ${describeRow(row)} is not available now` };
    if (canonicalJson(row) !== canonicalJson(actual)) return { ok: false, reason: `the ${describeRow(actual)} is not the approved ${describeRow(row)}` };
  }
  for (const [key, row] of now) if (!approved.has(key)) return { ok: false, reason: `the ${describeRow(row)} was not part of the approval` };
  return { ok: true };
}
