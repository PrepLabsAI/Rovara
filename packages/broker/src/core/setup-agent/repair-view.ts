// L4-U5: the project's "Setup needs repair" card as the web page reads it (the same fixed words the chat thread, the ticket and the admins' notice carry). A read only; it asks nothing of a model and starts nothing.
//
// The card exists while the project's setup is broken and no newer setup has been approved since (`readSetupRepairCard`, whose rows are the project's own: company and project in every key). Who may act is the caller's
// standing (`canManage`, read live by the route): a person who does not manage the project reads the card and its words, and gets NO action. Which action fits is the project's own state: a checked fix waiting for
// approval (`fixReady`) offers "Approve new setup", anything else "Fix setup". The action only POINTS at the page's existing flows (the setup run, the approval); nothing is started or approved here.
import { setupDriftWords } from "@agentx/contracts";
import type { TaskFlowDeps } from "../task-flow/deps.js";
import { readSetupApply, type SetupApplyDeps } from "./apply.js";
import { readSetupRepairCard } from "./recheck.js";
import { SETUP_REPAIR_WORDS, inertSetupStep, setupRepairCardOf } from "./recheck-rows.js";

export interface SetupRepairView {
  title: typeof SETUP_REPAIR_WORDS.title;
  /** The card's sentence (the failing step is the check's own redacted line). */
  body: string;
  /** What changed in the code since the setup was approved, in fixed words ("dependency files"); absent when it could not be told. */
  changed?: string;
  at: string;
  /** A fix was drafted and its check passed: it waits for a person's approval. */
  fixReady: boolean;
  /** Empty for a person who may not act. */
  actions: Array<{ id: "fix_setup" | "approve_new_setup"; label: string }>;
}

/** A checked candidate waits for approval only while it was drafted from the setup that is current now (a candidate of an older revision is not this card's fix). Never throws. */
async function fixReadyOf(deps: Pick<SetupApplyDeps, "store" | "companyId" | "now"> & { flow: TaskFlowDeps }, project: string): Promise<boolean> {
  try {
    const apply = await readSetupApply(deps, project);
    const latest = await deps.flow.projects.latest(project);
    return apply !== undefined && apply.state === "checking" && apply.checkState.status === "ready" && latest !== undefined && apply.baseRevision === latest.definition.revision;
  } catch {
    return false;
  }
}

/** What the admins' notice reads at delivery (`AttentionDeliveryDependencies.upkeep.setupRead`): the open card's re-check key, the failing step and whether a checked fix waits. Undefined when the setup is no longer broken. */
export async function readSetupBrokenNotice(deps: Pick<SetupApplyDeps, "store" | "companyId" | "now"> & { flow: TaskFlowDeps }, project: string): Promise<{ key: string; failedStep: string; fixReady: boolean } | undefined> {
  const card = await readSetupRepairCard(deps.flow, project);
  return card === undefined ? undefined : { key: card.key, failedStep: card.failedStep, fixReady: await fixReadyOf(deps, project) };
}

export async function setupRepairViewOf(
  deps: Pick<SetupApplyDeps, "store" | "companyId" | "now"> & { flow: TaskFlowDeps },
  project: string, input: { canManage: boolean },
): Promise<SetupRepairView | undefined> {
  const card = await readSetupRepairCard(deps.flow, project);
  if (card === undefined) return undefined;
  const fixReady = await fixReadyOf(deps, project);
  const own = setupRepairCardOf(inertSetupStep(card.failedStep));
  const classes = setupDriftWords(card.classes);
  return {
    title: own.title, body: own.body, ...(card.classes.length === 0 ? {} : { changed: classes }), at: card.at, fixReady,
    actions: input.canManage ? [{ id: fixReady ? "approve_new_setup" : "fix_setup", label: fixReady ? SETUP_REPAIR_WORDS.approveNewSetup : SETUP_REPAIR_WORDS.fixSetup }] : [],
  };
}
