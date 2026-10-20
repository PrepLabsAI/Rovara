import { WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, canonicalJson, type E2EApplicationSelectionRecord } from "@agentx/contracts";

/**
 * A dispatch of an approved application round that must not happen, with the plain reason the owner sees. It is terminal for that dispatch: the
 * workflow is blocked with the reason and the dispatch is not retried. Retrying the checks does not help when the selection changed: the runtime rows are
 * compared exactly (Ruling AL), and a row that was only requalified is not the approved one, so the remedy is to approve the plan again against the rows that
 * are there now. A dispatch that merely could not read what it needs is not this: it fails like any other and is retried within its budget.
 */
export class ApplicationDispatchRefusal extends Error {}

const ROUND_REFUSAL_REASON_MAX_CHARS = 380;
const shortLine = (reason: string, max: number) => {
  const line = reason.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
};

/**
 * The plan itself can no longer be run as written (portable criteria, web and API targets together, a target with no source-owned identity), which only a corrected plan
 * fixes. Dispatch sends the task back to plan review (Request changes is the owner's way on) instead of blocking it where nothing the owner can press would help.
 */
export class ApplicationPlanDefect extends ApplicationDispatchRefusal {
  constructor(readonly reason: string) { super(`${WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX}${shortLine(reason, 330)}`); }
}

/**
 * A refusal caused by the registered runtime's state (no READY row of the plan's kind, a row that expires before the round could end, no installed host). No code change
 * fixes it: the block text asks for an administrator to qualify the runtime again and then for a retry, which approves the plan again against the new row.
 */
export function applicationRuntimeRefusal(reason: string): ApplicationDispatchRefusal {
  return new ApplicationDispatchRefusal(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}${shortLine(reason, 250)}`);
}
/**
 * A refusal to dispatch an application round whose inputs are not usable (the candidate's build source, its manifest, the runtime inputs or the plan itself). The
 * block text begins with `WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX`, so the owner is offered the action that fixes it (sending the task back to coding), and ends with
 * that remedy; the workflow keeps only the first 500 characters of a block reason, so the reason is kept short enough for both to fit.
 */
export function applicationRoundRefusal(reason: string): ApplicationDispatchRefusal {
  const line = reason.replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim();
  const short = line.length > ROUND_REFUSAL_REASON_MAX_CHARS ? `${line.slice(0, ROUND_REFUSAL_REASON_MAX_CHARS - 3)}...` : line;
  return new ApplicationDispatchRefusal(`${WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX}${short} Send the task back to coding, or close it.`);
}

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
