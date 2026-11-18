// L4-EVW4 (DEC 254zzz43): what the setup flow's ONE wrapper card says for each eval whose results Rovara cannot read as they are. Pure reads over records the broker already holds (no host call, no model, no write).
//   "Rovara can't read the results of <eval> yet"   [View the file] · [I'll add it myself] (copy, where to put it, Check now) · [Let Rovara open a pull request] · [Not now]
// Everyone who can see the project may see the file and copy it; only a company owner, admin or project maintainer may open the pull request, set the card aside or approve the test run (`canManage`). Every sentence is fixed
// words; the eval's name, the file's path and its text are the repository's own and are data.
import { EVAL_NOT_READ_LINE, EVAL_WRAPPER_COPY_REASONS, evalWrapperTitleOf, type EvalWrapperCard, type EvalWrapperCopyReason, type EvalWrapperStep, type SetupEvalDiscoveryReport } from "@agentx/contracts";
import { readEvalDiscovery } from "./eval-discovery.js";
import { EVAL_WRAPPER_FAILURE_WORDS, listEvalWrapperFiles, listEvalWrappers, needsOf, readEvalWrapperDismissed, wrapperFileFor, type EvalWrapperDeps, type EvalWrapperFileRecord, type EvalWrapperRecord, type Need } from "./eval-wrapper.js";

/** The sentence of each step. A pull request number is the host's. */
export function evalWrapperLine(step: EvalWrapperStep, pr?: Pick<EvalWrapperRecord, "number" | "state">): string {
  const number = pr?.number === undefined ? "the pull request" : `PR #${pr.number}`;
  switch (step) {
    case "needs_file": return "Rovara needs a small file in your repository to read this eval's results. Add it yourself, or let Rovara open a pull request for it.";
    case "pull_request_open": return pr?.state === "merged" ? `${number} is merged. Rovara is looking for the file on your default branch.` : `Rovara opened ${number} with the file. Review and merge it; Rovara notices it on your default branch by itself.`;
    case "file_found": return "The file is on your default branch. Approve a test run (its cost is shown) so Rovara can check it reads your results.";
    case "file_outdated": return "The file in your repository is from an older Rovara template. Copy the new one over it.";
    case "test_approved": return "The test run is approved. Rovara will check the results it reads.";
    case "readable": return "Rovara can read this eval's results.";
    case "unreadable": return "The test run could not read this eval's results through the file. Check the file, then check again.";
    case "not_offered": return "Rovara could not check a file for this eval, so it is not offering one. If you add your own file at the place Rovara looks, Rovara will find it.";
    case "dismissed": return "Set aside for now. Pull requests will say the eval was not read until it is set up.";
  }
}

const COPY_WORDS: Readonly<Record<EvalWrapperCopyReason, string>> = Object.freeze({
  custom: EVAL_WRAPPER_FAILURE_WORDS.copy_only,
  another_eval: EVAL_WRAPPER_FAILURE_WORDS.another_eval,
  cannot_write: EVAL_WRAPPER_FAILURE_WORDS.refused,
  file_exists: EVAL_WRAPPER_FAILURE_WORDS.file_exists,
  closed: EVAL_WRAPPER_FAILURE_WORDS.closed,
  not_checked: "Rovara has not looked at your repository yet. Check now to see whether the file is there.",
});
void EVAL_WRAPPER_COPY_REASONS;

function cardOf(need: Need, input: { files: readonly EvalWrapperFileRecord[]; prs: readonly EvalWrapperRecord[]; dismissed: boolean; canManage: boolean }): EvalWrapperCard {
  const file = input.files.find((row) => row.suiteRepository === (need.suite.repository ?? "") && row.language === need.language);
  const pr = input.prs.find((row) => (row.suiteRepository ?? "") === (need.suite.repository ?? "") && row.language === need.language && row.digest === need.digest) ?? input.prs.find((row) => (row.suiteRepository ?? "") === (need.suite.repository ?? "") && row.language === need.language);
  let step: EvalWrapperStep;
  let copyReason: EvalWrapperCopyReason | undefined;
  if (file?.status === "present" && file.match === "outdated") step = "file_outdated";
  else if (file?.status === "present") step = file.test === "readable" ? "readable" : file.test === "unreadable" ? "unreadable" : file.test === "approved" ? "test_approved" : "file_found";
  else if (pr?.state === "open" || pr?.state === "opening" || pr?.state === "merged") step = "pull_request_open";
  else step = need.offered ? "needs_file" : "not_offered";
  // Why the file can only be copied (never opened by Rovara): the order is the most specific first.
  if (file?.status === "other" || (file?.status === "present" && (step === "file_outdated"))) copyReason = "file_exists";
  else if (need.kind === "custom") copyReason = "custom";
  else if (!need.firstOfFile) copyReason = "another_eval";
  else if (pr?.state === "closed" && pr.digest === need.digest) copyReason = "closed";
  else if (pr?.state === "failed" && pr.failure !== undefined && ["host_cannot", "refused", "file_exists", "unreachable"].includes(pr.failure)) copyReason = pr.failure === "file_exists" ? "file_exists" : "cannot_write";
  // A set-aside card stays set aside only while nothing moved: a found file or an open pull request brings it back.
  const dismissed = input.dismissed && (step === "needs_file" || step === "not_offered");
  const shownStep: EvalWrapperStep = dismissed ? "dismissed" : step;
  const canOpen = input.canManage && need.kind === "template" && need.offered && need.firstOfFile && (step === "needs_file") && copyReason === undefined && (pr === undefined || pr.state === "failed" || (pr.state === "closed" && pr.digest !== need.digest));
  return {
    selection: need.selection, ...(need.suite.repository === undefined ? {} : { repository: need.suite.repository }), language: need.language, kind: need.kind, path: need.file.path,
    // A file that was not offered shows no text: only a file that passed the setup run's dry-run is shown, copied or opened.
    content: need.offered ? need.file.content : "",
    ...(need.suite.output?.kind === "custom" ? { summary: need.suite.output.summary } : {}),
    title: evalWrapperTitleOf(need.selection), step: shownStep, line: evalWrapperLine(shownStep, pr), offered: need.offered, canOpenPullRequest: canOpen,
    ...(copyReason === undefined || !need.offered ? {} : { copyOnly: { reason: copyReason, text: COPY_WORDS[copyReason] } }),
    ...(pr === undefined ? {} : { pullRequest: { state: pr.state, ...(pr.number === undefined ? {} : { number: pr.number }), ...(pr.url === undefined || !pr.url.startsWith("https://") ? {} : { url: pr.url }) } }),
    ...(file?.status === "present" && file.match !== undefined ? { fileStatus: file.match } : {}),
    dismissed, ...(file === undefined ? {} : { checkedAt: file.checkedAt }),
  };
}

/** The wrapper cards of a report, as one person sees them (`canManage`: the live owner/admin/maintainer rule, read by the caller). Never throws. */
export async function readEvalWrapperCards(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string, report: { reportDigest: string; report: SetupEvalDiscoveryReport } | undefined, canManage: boolean): Promise<EvalWrapperCard[]> {
  if (report === undefined) return [];
  const needs = needsOf(report.report);
  if (needs.length === 0) return [];
  const [files, prs, dismissedRow] = await Promise.all([listEvalWrapperFiles(deps, project), listEvalWrappers(deps, project), readEvalWrapperDismissed(deps, project)]);
  const dismissed = dismissedRow?.reportDigest === report.reportDigest;
  return needs.map((need) => cardOf(need, { files, prs, dismissed, canManage }));
}

/** Whether a suite's results are readable through a found wrapper file (so the eval may be approved and run through it). */
export const suiteReadableThroughFile = (files: readonly EvalWrapperFileRecord[], need: Pick<Need, "language" | "suite">): boolean => wrapperFileFor(files, need.suite, need.language) !== undefined;

/**
 * The one line a task's pull request carries when the project's eval card was set aside ("Not now") and an eval is still not readable: "Eval not read: setup needed". Read from this company's own rows; a read that fails says
 * nothing (a description never waits on, or fails because of, this). Undefined: say nothing.
 */
export async function evalSetupNeededLine(deps: Pick<EvalWrapperDeps, "store" | "companyId">, project: string): Promise<string | undefined> {
  try {
    const found = await readEvalDiscovery({ store: deps.store, companyId: deps.companyId }, project);
    if (found === undefined) return undefined;
    const cards = await readEvalWrapperCards(deps, project, { reportDigest: found.reportDigest, report: found.report }, false);
    return cards.some((card) => card.step === "dismissed") ? EVAL_NOT_READ_LINE : undefined;
  } catch { return undefined; }
}
