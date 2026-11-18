// L4-EVC (DEC 254zzz20 D5, D6, D8): what the setup flow's ONE eval card shows, in plain dollars, read from the broker's own records. Pure reads: no model, no write, no spend. The hosted route serves it and
// Cloud draws it; every sentence comes from `eval-cost.ts`, so the page never works out a figure of its own. No call counts, tokens or micro-dollar words reach the text; the whole-number figures a
// person's yes must echo (`seen`) travel as data, never as words.
import type { DocumentStore, OrgId, Principal } from "@agentx/contracts";
import { developerIdOf } from "../sessions/create.js";
import type { SessionMembers } from "../sessions/access.js";
import { dollarRangeOf, dollarsOf, evalApprovalSentence, evalAsksAgainWords } from "./eval-cost.js";
import { evalEstimateOf, evalProposalDollars, readEvalDiscovery } from "./eval-discovery.js";
import { evalHealthState } from "./eval-health-request.js";
import { readEvalSpendItem, readEvalSpendRecord, roleFor } from "./eval-spend.js";

export interface EvalCardDeps {
  store: DocumentStore;
  companyId: OrgId;
  members?: SessionMembers | undefined;
  /** The host's monthly cap source (the bound reservation adapter's). Absent or no answer: no card can be offered for an unconfirmed eval. */
  monthlyCap?: ((scope: { company: string; project: string }) => Promise<number | undefined>) | undefined;
}

export interface EvalCardSuiteView {
  selection: string;
  files: string[];
  cases: number;
  /** "Running your evals on each AI change will cost about $A-$B per PR, at most $X a month. Approve?" */
  sentence: string;
  perPr: string;
  monthly: string;
  /** What the person's yes echoes back (`seen`): the dollars as whole numbers, held against the broker's own at the confirm. */
  seen: { perCheckHighMicros: number; monthlyCapMicros: number };
  /** D6, a best-effort preview by dollars alone (the confirm decides with the model, judge and command too): an approved eval stands and this set stays inside it, or grew past it. */
  versusApproved?: { within: boolean; words: string };
}

export interface EvalCardView {
  /** `none`: no eval found. `propose`: a report nobody confirmed (the card). `waiting`: confirmed, its spend waits. `approved`. `renew`: approved by someone who may no longer approve. `rejected`. */
  state: "none" | "propose" | "waiting" | "approved" | "renew" | "rejected";
  /** Whether THIS person may confirm and approve the eval's spend (a company owner or admin, or a maintainer of the project; read live). */
  canApprove: boolean;
  /** The run whose report the card is about, and the digest the confirm is bound to (the report the person saw). */
  report?: { taskId: string; reportDigest: string };
  suites: EvalCardSuiteView[];
  spend?: { state: "waiting" | "approved" | "rejected" | "approval needs renewing"; perPr?: string; monthly?: string; needsApproval?: string; carried?: boolean; setupRevision?: number; approval?: { requestId: string; revision: number; artifactDigest: string } };
  /** D5: the opt-in health run, offered only once the spend is approved. `seenCostMicros` is what a yes echoes. */
  health?: { state: "none" | "requested" | "finished"; label: string; cost: string; seenCostMicros: number };
  /** Why no card can be offered (the install has no eval budget). */
  unavailable?: string;
}

/** The whole card for a project, as `principal` sees it. Reads only this company's own rows; an unreadable one reads as absent. */
export async function readEvalCard(deps: EvalCardDeps, project: string, principal: Principal): Promise<EvalCardView> {
  const members = deps.members === undefined ? {} : { members: deps.members };
  const role = principal.companyId === deps.companyId ? await roleFor(members, project, { companyId: deps.companyId, developerId: developerIdOf(principal), principal }) : undefined;
  let monthlyCap: number | undefined;
  try { const cap = deps.monthlyCap === undefined ? undefined : await deps.monthlyCap({ company: deps.companyId, project }); monthlyCap = typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0 ? cap : undefined; } catch { monthlyCap = undefined; }
  const table = { store: deps.store, companyId: deps.companyId, ...members, ...(monthlyCap === undefined ? {} : { monthlyCapMicros: monthlyCap }) };
  const [item, record, found] = await Promise.all([readEvalSpendItem(table, project), readEvalSpendRecord(table, project), readEvalDiscovery({ store: deps.store, companyId: deps.companyId }, project)]);
  // An approval counts for the preview only while its approver still may approve (the item's own live reading) and it carries the dollars the person saw.
  const standing = item?.state === "approved" && record?.state === "approved" && record.plan.dollars !== undefined ? record.plan : undefined;
  const suites: EvalCardSuiteView[] = [];
  if (found?.state === "reported" && monthlyCap !== undefined) {
    for (const suite of found.report.suites) {
      const dollars = evalProposalDollars(suite.questions.length, suite, monthlyCap);
      if (dollars === undefined) continue;
      const { estimate } = evalEstimateOf(suite.questions.length, suite);
      const within = standing !== undefined && standing.dollars !== undefined && dollars.perCheckHighMicros <= standing.dollars.perCheckHighMicros && estimate.calls <= standing.budget.maximum.calls && estimate.costMicros <= standing.budget.maximum.costMicros;
      suites.push({ selection: suite.selection, files: [...new Set(suite.questions.map(q => q.path))], cases: suite.questions.length, sentence: evalApprovalSentence(dollars), perPr: dollarRangeOf(dollars.perCheckLowMicros, dollars.perCheckHighMicros), monthly: dollarsOf(dollars.monthlyCapMicros),
        seen: { perCheckHighMicros: dollars.perCheckHighMicros, monthlyCapMicros: dollars.monthlyCapMicros },
        ...(standing?.dollars === undefined ? {} : { versusApproved: within ? { within: true, words: "Still inside what you approved: no new approval needed" } : { within: false, words: evalAsksAgainWords({ reason: "grew", approvedHighMicros: standing.dollars.perCheckHighMicros }) } }) });
    }
  }
  const state: EvalCardView["state"] = found?.state === "reported" ? "propose"
    : item === undefined ? (found === undefined ? "none" : "waiting")
      : item.state === "waiting" ? "waiting" : item.state === "approved" ? "approved" : item.state === "rejected" ? "rejected" : "renew";
  const card = item?.card;
  const health = item?.state === "approved" && card !== undefined && record !== undefined
    ? { state: await evalHealthState(table, project), label: card.healthRun.label, cost: card.healthRun.cost, seenCostMicros: record.plan.estimate.costMicros }
    : undefined;
  return {
    state, canApprove: role !== undefined, ...(found === undefined ? {} : { report: { taskId: found.taskId, reportDigest: found.reportDigest } }), suites,
    ...(item === undefined ? {} : { spend: { state: item.state,
      ...(card === undefined ? {} : { perPr: card.perPr, monthly: card.monthly, ...(card.needsApproval === undefined ? {} : { needsApproval: card.needsApproval }), ...(card.carried === true ? { carried: true } : {}), ...(card.setupRevision === undefined ? {} : { setupRevision: card.setupRevision }) }),
      ...(item.approval === undefined ? {} : { approval: { requestId: item.approval.requestId, revision: item.approval.revision, artifactDigest: item.approval.artifactDigest } }) } }),
    ...(health === undefined ? {} : { health }),
    ...(monthlyCap === undefined && state !== "approved" ? { unavailable: "This install has no eval budget, so an eval can't be approved here yet." } : {}),
  };
}
