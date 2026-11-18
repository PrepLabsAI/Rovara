// L4-EVC (DEC 254zzz20 D5, D6, D8): what the setup flow's ONE eval card shows, in plain dollars, read from the broker's own records. Pure reads: no model, no write, no spend. The hosted route serves it and
// Cloud draws it; every sentence comes from `eval-cost.ts`, so the page never works out a figure of its own. No call counts, tokens or micro-dollar words reach the text; the whole-number figures a
// person's yes must echo (`seen`) travel as data, never as words.
import { EVAL_OUTPUT_UNREADABLE_MESSAGE, evalOutputNeedsWrapper, type DocumentStore, type EvalOutputShape, type EvalWrapperCard, type OrgId, type Principal } from "@agentx/contracts";
import { developerIdOf } from "../sessions/create.js";
import type { SessionMembers } from "../sessions/access.js";
import { dollarRangeOf, dollarsUpOf, evalApprovalSentence, evalAsksAgainWords } from "./eval-cost.js";
import { evalCommandFingerprintOf, evalProductRowLabel } from "@agentx/contracts";
import { evalEstimateOf, evalProposalDollars, readEvalDiscovery } from "./eval-discovery.js";
import { evalHealthNotRunWords } from "@agentx/contracts";
import { readEvalHealthView, type EvalHealthResultSummary } from "./eval-health-request.js";
import { readEvalSpendItem, readEvalSpendRecord, roleFor } from "./eval-spend.js";
import { listEvalWrapperFiles, needsOf, wrapperFileFor } from "./eval-wrapper.js";
import { readEvalWrapperCards } from "./eval-wrapper-card.js";

export interface EvalCardDeps {
  store: DocumentStore;
  companyId: OrgId;
  members?: SessionMembers | undefined;
  /** The host's monthly cap source (the bound reservation adapter's). Absent or no answer: no card can be offered for an unconfirmed eval. */
  monthlyCap?: ((scope: { company: string; project: string }) => Promise<number | undefined>) | undefined;
  /** L4-T3: whether the project's own AI provider is connected (the bound adapter's, the model gateway's own key check). Absent or no answer: "connected" is unknown and the card says neither. */
  providerConnected?: ((scope: { company: string; project: string }) => Promise<boolean | undefined>) | undefined;
  /** D5: whether this install has a health runner that reads the person's yes. False or absent: the card offers no health button (a button nothing answers would be a lie). */
  healthRuns?: boolean | undefined;
  /** The host's clock (milliseconds), for the health check's age and window. Absent: the stored row is read as it is. */
  now?: (() => number) | undefined;
}

export interface EvalCardSuiteView {
  selection: string;
  /** L4-T3: the AI provider this suite's evals call, as a person knows it ("Google Gemini", "Vertex AI"), from what discovery found. Absent for a row this install cannot name. */
  provider?: string;
  files: string[];
  cases: number;
  /** "Running your evals on each AI change will cost about $A-$B per PR, at most $X a month. Approve?" */
  sentence: string;
  perPr: string;
  monthly: string;
  /** L4-EVW4: false when Rovara cannot read this eval's results as they are and no wrapper file is on the default branch yet: the eval cannot be approved until it is, and `needsFile` says why. */
  readable: boolean;
  needsFile?: string;
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
  /** L4-EVW4 (DEC 254zzz43): ONE card per eval whose results Rovara cannot read as they are: the file (path and text, for everyone to view and copy), where it stands, and what this person may do about it. */
  wrappers: EvalWrapperCard[];
  /** L4-T3 (G2): the AI provider the evals call (the approved item's, else the first suite's) and whether the company's own connection to it stands right now. `connected` is absent when this install cannot tell. */
  provider?: string;
  connected?: boolean;
  spend?: { state: "waiting" | "approved" | "rejected" | "approval needs renewing"; perPr?: string; monthly?: string; needsApproval?: string; carried?: boolean; setupRevision?: number; approval?: { requestId: string; revision: number; artifactDigest: string } };
  /** D5: the opt-in health run, offered only once the spend is approved. `seenCostMicros` is what a yes echoes. */
  health?: { state: "none" | "requested" | "running" | "finished" | "not_run"; label: string; cost: string; seenCostMicros: number;
    /** L4-EVH: why it did not run (fixed words), or how the run went. */
    words?: string; result?: EvalHealthResultSummary };
  /** Why no card can be offered (the install has no eval budget). */
  unavailable?: string;
}

/** Whether an eval's results are readable: its output is one Rovara reads as it is, or its own wrapper file is on the default branch (present, as offered or edited; see `wrapperFileFor`). */
function readableThroughFile(files: Parameters<typeof wrapperFileFor>[0], needs: ReturnType<typeof needsOf>, suite: { output?: EvalOutputShape | undefined; selection: string }): boolean {
  if (!evalOutputNeedsWrapper(suite.output)) return true;
  const need = needs.find((entry) => entry.selection === suite.selection);
  return need !== undefined && wrapperFileFor(files, { repository: need.suite.repository, selection: need.selection, firstOfFile: need.firstOfFile }, need.language) !== undefined;
}

/** The whole card for a project, as `principal` sees it. Reads only this company's own rows; an unreadable one reads as absent. */
export async function readEvalCard(deps: EvalCardDeps, project: string, principal: Principal): Promise<EvalCardView> {
  const members = deps.members === undefined ? {} : { members: deps.members };
  const role = principal.companyId === deps.companyId ? await roleFor(members, project, { companyId: deps.companyId, developerId: developerIdOf(principal), principal }) : undefined;
  let monthlyCap: number | undefined;
  try { const cap = deps.monthlyCap === undefined ? undefined : await deps.monthlyCap({ company: deps.companyId, project }); monthlyCap = typeof cap === "number" && Number.isSafeInteger(cap) && cap > 0 ? cap : undefined; } catch { monthlyCap = undefined; }
  const table = { store: deps.store, companyId: deps.companyId, ...members, ...(monthlyCap === undefined ? {} : { monthlyCapMicros: monthlyCap }) };
  const [item, record, found, connection] = await Promise.all([readEvalSpendItem(table, project), readEvalSpendRecord(table, project), readEvalDiscovery({ store: deps.store, companyId: deps.companyId }, project),
    (async () => { try { const answer = deps.providerConnected === undefined ? undefined : await deps.providerConnected({ company: deps.companyId, project }); return typeof answer === "boolean" ? answer : undefined; } catch { return undefined; } })()]);
  // An approval counts for the preview only while its approver still may approve (the item's own live reading) and it carries the dollars the person saw.
  const standing = item?.state === "approved" && record?.state === "approved" && record.plan.dollars !== undefined ? record.plan : undefined;
  const suites: EvalCardSuiteView[] = [];
  const files = await listEvalWrapperFiles({ store: deps.store, companyId: deps.companyId }, project);
  const needs = found === undefined ? [] : needsOf(found.report);
  if (found?.state === "reported" && monthlyCap !== undefined) {
    for (const suite of found.report.suites) {
      const dollars = evalProposalDollars(suite.questions.length, suite, monthlyCap);
      if (dollars === undefined) continue;
      const { estimate } = evalEstimateOf(suite.questions.length, suite);
      // "Inside" is said only for the approved suite itself, with the same model, version, row and command (what a card can see without reading files); a different suite or envelope reads as changed. The judge is
      // checked at the confirm, so the words say the cost is inside and that a changed model, judge or command asks again.
      const sameSuite = standing !== undefined && suite.selection === standing.selection && suite.model === standing.inputs.model && suite.modelVersion === standing.inputs.modelVersion
        && suite.catalogRowId === standing.inputs.catalogRowId && evalCommandFingerprintOf(suite.command, suite.report) === standing.inputs.commandFingerprint;
      const within = sameSuite && standing?.dollars !== undefined && dollars.perCheckHighMicros <= standing.dollars.perCheckHighMicros && estimate.calls <= standing.budget.maximum.calls && estimate.costMicros <= standing.budget.maximum.costMicros;
      const provider = evalProductRowLabel(suite.catalogRowId);
      suites.push({ selection: suite.selection, ...(provider === undefined ? {} : { provider }), files: [...new Set(suite.questions.map(q => q.path))], cases: suite.questions.length, sentence: evalApprovalSentence(dollars), perPr: dollarRangeOf(dollars.perCheckLowMicros, dollars.perCheckHighMicros), monthly: dollarsUpOf(dollars.monthlyCapMicros),
        ...(readableThroughFile(files, needs, suite) ? { readable: true } : { readable: false, needsFile: EVAL_OUTPUT_UNREADABLE_MESSAGE }),
        seen: { perCheckHighMicros: dollars.perCheckHighMicros, monthlyCapMicros: dollars.monthlyCapMicros },
        ...(standing?.dollars === undefined ? {} : { versusApproved: within ? { within: true, words: "Inside the approved cost. A change to the model, judge or command asks again." } : { within: false, words: evalAsksAgainWords({ reason: sameSuite ? "grew" : "changed", approvedHighMicros: standing.dollars.perCheckHighMicros }) } }) });
    }
  }
  const state: EvalCardView["state"] = found?.state === "reported" ? "propose"
    : item === undefined ? (found === undefined ? "none" : "waiting")
      : item.state === "waiting" ? "waiting" : item.state === "approved" ? "approved" : item.state === "rejected" ? "rejected" : "renew";
  // The provider of the item that stands (its approved row), else of the first suite the card shows. Said only while there is an eval to run (not for none or rejected).
  const provider = state === "none" || state === "rejected" ? undefined : (record !== undefined && item !== undefined ? evalProductRowLabel(record.plan.inputs.catalogRowId) : undefined) ?? suites.find(s => s.provider !== undefined)?.provider;
  const card = item?.card;
  const wrappers = await readEvalWrapperCards({ store: deps.store, companyId: deps.companyId }, project, found === undefined ? undefined : { reportDigest: found.reportDigest, report: found.report }, role !== undefined);
  const health = deps.healthRuns === true && role !== undefined && item?.state === "approved" && card !== undefined && record !== undefined
    ? await (async () => {
      const view = await readEvalHealthView({ ...table, ...(deps.now === undefined ? {} : { now: deps.now }) }, project);
      return { state: view.state, label: card.healthRun.label, cost: card.healthRun.cost, seenCostMicros: record.plan.estimate.costMicros,
        ...(view.reason === undefined ? {} : { words: evalHealthNotRunWords(view.reason) }), ...(view.result === undefined ? {} : { result: view.result }) };
    })()
    : undefined;
  return {
    state, canApprove: role !== undefined, wrappers, ...(provider === undefined ? {} : { provider, ...(connection === undefined ? {} : { connected: connection }) }),
    ...(found === undefined ? {} : { report: { taskId: found.taskId, reportDigest: found.reportDigest } }), suites,
    ...(item === undefined ? {} : { spend: { state: item.state,
      ...(card === undefined ? {} : { perPr: card.perPr, monthly: card.monthly, ...(card.needsApproval === undefined ? {} : { needsApproval: card.needsApproval }), ...(card.carried === true ? { carried: true } : {}), ...(card.setupRevision === undefined ? {} : { setupRevision: card.setupRevision }) }),
      ...(item.approval === undefined ? {} : { approval: { requestId: item.approval.requestId, revision: item.approval.revision, artifactDigest: item.approval.artifactDigest } }) } }),
    ...(health === undefined ? {} : { health }),
    ...(monthlyCap === undefined && state !== "approved" ? { unavailable: "This install has no eval budget, so an eval can't be approved here yet." } : {}),
  };
}
