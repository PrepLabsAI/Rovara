// Decision journey slice 2 (review fix): the coding plan card's facts and tier, read from the plan document itself, never assumed. ONE function for the card (plan-cards.ts), the workflow decision
// (decide.ts: who may approve, from where) and the Slack message (the notifier), so a plan is the same tier wherever it is decided.
//   structured   files: the code its claims cite, the paths its work items name, and every path its text names (claims, risks, decisions, work items), plus the files the design under review names;
//                untested claims: top-level claims no check or scenario proves. A plan that names no file at all is "unread": what it changes is not stated.
//   Markdown     files: the paths its text names (for the infrastructure rule); which checks prove it is not stated, so the plan is unread.
//   unreadable   no files, no proof: unread.
// Unread means at least medium and no files or proof chip on the card.
// KNOWN LIMIT: "a check proves this claim" is what the PLAN asserts (its `checks.proves` and `scenarioProves`); nothing here runs the check, so a plan can claim proof it does not have and look less
// risky. The backstop is the merge card, whose tier comes from the pull request's actual changed files and the checks that really ran.
import type { DecisionRisk, PlanDocument, WorkflowSnapshot } from "@agentx/contracts";
import type { LoadedDocument } from "../../developer/plan-document-reader.js";
import { raiseRisk } from "@agentx/contracts";
import { pathsIn, planFiles, planUntestedClaims } from "./plan-facts.js";
import { riskTierOf } from "./risk-tier.js";

export interface PlanFacts {
  files: string[];
  untestedClaims: number;
  /** The files or the checks that prove the plan could not be read from it: no such chips, and the tier is at least medium. */
  unread: boolean;
}

/** Every bit of a plan's own text that may name a path: claims (and their children), risks, decisions and their options, and work items. */
function planText(plan: PlanDocument): string {
  const claims = (list: PlanDocument["claims"]): string[] => list.flatMap((claim) => [claim.text, ...(claim.children === undefined ? [] : claims(claim.children))]);
  return [
    ...claims(plan.claims), ...plan.risks, ...plan.notChanging,
    ...plan.decisions.flatMap((decision) => [decision.question, ...decision.options.flatMap((option) => [option.label, option.consequence])]),
    ...(plan.workBreakdown?.items ?? []).flatMap((item) => [item.title, item.description]),
  ].join("\n");
}

/** The files the design under review names (its repositories and services are not files; its findings' sections are not either), when the workflow carries one. */
function designFiles(workflow: Pick<WorkflowSnapshot, "designReview"> | undefined): string[] {
  const rounds = workflow?.designReview?.rounds ?? [];
  return rounds.flatMap((round) => round.findings.flatMap((finding) => finding.citations.flatMap((citation) => (citation.kind === "code" ? [citation.path] : []))));
}

export function planFactsOf(loaded: LoadedDocument | undefined, workflow?: Pick<WorkflowSnapshot, "designReview">): PlanFacts {
  if (loaded === undefined) return { files: [], untestedClaims: 0, unread: true };
  if (loaded.format === "structured") {
    const files = [...new Set([...planFiles(loaded.plan), ...pathsIn(planText(loaded.plan)), ...designFiles(workflow)])];
    return { files, untestedClaims: planUntestedClaims(loaded.plan), unread: files.length === 0 };
  }
  return { files: [...new Set([...pathsIn(loaded.markdown), ...designFiles(workflow)])], untestedClaims: 0, unread: true };
}

/** The coding plan card's tier for these facts and the plan's expected cost (the high end), with no company lock (none is stored yet). */
export function planRiskOf(facts: PlanFacts, costHighUsd: number | undefined): DecisionRisk {
  return riskTierOf("approve_plan", { plan: { files: facts.files, untestedClaims: facts.untestedClaims, unread: facts.unread, ...(costHighUsd === undefined ? {} : { costHighUsd }) } }).risk;
}

/**
 * The ONE rule for "this coding plan is decided on its card, not by an Approve in Slack, a tool or a token": the plan's tier (`planRiskOf`) is medium or high. Answers that tier, or
 * undefined when the plan may be approved anywhere (cards off, or low risk). The server's refusal (`requirePlanApprovalPlace`) and the Slack plan message (which then offers no Approve) both read it, so they cannot drift.
 */
export function planDecidedOnCard(loaded: LoadedDocument | undefined, workflow: Pick<WorkflowSnapshot, "designReview"> | undefined, costHighUsd: number | undefined): "medium" | "high" | undefined {
  const risk = planRiskOf(planFactsOf(loaded, workflow), costHighUsd);
  return risk === "low" ? undefined : risk;
}

/** A path-like token without a file extension (`infra/iam/policy`): the directory rules read it as they read a file's path. */
const SLASH_TOKEN = /(?:[\w@.-]+\/)+[\w@.-]+/gu;
/** Files that are named without a directory or an extension and decide how the code is built, run or reviewed. */
const NAMED_FILE = /(?<![\w./-])(dockerfile|jenkinsfile|codeowners)(?![\w-])/giu;
const MAKEFILE = /(?<![\w./-])makefile(?![\w-])/iu;
/** Words that say a plan or a request touches infrastructure, who may do what, or how data is shaped: read as the infrastructure paths are. */
const INFRA_WORDS = /\b(iam|infrastructure|terraform|cloudformation|migrations?)\b/giu;
/** Words that say it touches sign-in, secrets, money or permissions: read as the sensitive paths are. */
const SENSITIVE_WORDS = /\b(auth|authentication|authorization|oauth|saml|sso|jwt|passwords?|credentials?|secrets?|payments?|billing|permissions?|encryption|crypto)\b/giu;

/**
 * The floor the core computes itself (owner decision c): what ANY of the plan's text or the request names, not only the paths the planner cites as evidence: paths (with or without an
 * extension), known files with no directory (`Dockerfile`, `Jenkinsfile`, `CODEOWNERS`; a `Makefile` is at least medium), words for infrastructure, IAM, migrations, sign-in, secrets, money and
 * permissions, their count, and the cost estimate where there is one, with Cloud's rules for sensitive paths and size. It reads nothing the planner claims about proof, so a plan cannot lower it.
 */
export function planRiskFloor(input: { texts: readonly string[]; costHighUsd?: number | undefined }): DecisionRisk {
  const found = input.texts.flatMap((text) => [...pathsIn(text), ...(text.match(SLASH_TOKEN) ?? [])]);
  const named = input.texts.flatMap((text) => [...text.matchAll(NAMED_FILE)].map((match) => match[1]!.toLowerCase()));
  const infra = input.texts.flatMap((text) => [...text.matchAll(INFRA_WORDS)].map((match) => `infra/${match[1]!.toLowerCase()}`));
  const sensitive = input.texts.flatMap((text) => [...text.matchAll(SENSITIVE_WORDS)].map((match) => `auth/${match[1]!.toLowerCase()}`));
  const files = [...new Set([...found, ...named, ...infra, ...sensitive])];
  const tier = riskTierOf("approve_plan", { plan: { files, untestedClaims: 0, unread: false, ...(input.costHighUsd === undefined ? {} : { costHighUsd: input.costHighUsd }) } }).risk;
  return input.texts.some((text) => MAKEFILE.test(text)) ? raiseRisk(tier, "medium") : tier;
}

/** The tier of the plan waiting for approval: what the planner's own document says, raised (never lowered) to the core's floor. */
export function gradePlanRisk(input: { loaded: LoadedDocument | undefined; workflow: Pick<WorkflowSnapshot, "designReview">; requestText?: string | undefined; costHighUsd?: number | undefined }): DecisionRisk {
  const planner = planRiskOf(planFactsOf(input.loaded, input.workflow), input.costHighUsd);
  const floor = planRiskFloor({ texts: [...(input.loaded === undefined ? [] : [input.loaded.markdown]), ...(input.requestText === undefined ? [] : [input.requestText])], costHighUsd: input.costHighUsd });
  return raiseRisk(planner, floor);
}
