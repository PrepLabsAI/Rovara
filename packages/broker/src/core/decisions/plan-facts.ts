// What a plan document names, read from the document itself: the files it cites and the claims nothing proves. Copied from the hosted product's one-screen plan module (only the three readers the decision tiers need; the rest of that module belongs to the task-flow lanes).
import type { PlanClaim, PlanDocument, PlanOneScreenProofKind } from "@agentx/contracts";

const flat = (value: string): string => value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();


/** A path as a plan names it: something with a slash or a known code extension, never a sentence's "e.g.". */
const PATH_TOKEN = /(?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,6}|[\w@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|java|kt|go|rs|rb|cs|cpp|c|h|sql|tf|yaml|yml|json|toml|md|sh|html|css|scss|vue|svelte|swift)\b/gu;

function claimPaths(claims: readonly PlanClaim[]): string[] {
  return claims.flatMap((claim) => [
    ...(claim.evidence ?? []).flatMap((item) => (item.kind === "code" ? [item.path] : [])),
    ...claimPaths(claim.children ?? []),
  ]);
}

/** The files the plan names: code it cites on a claim, then paths its ordered work items mention. Deduplicated in first-seen order. */
export function planFiles(plan: PlanDocument): string[] {
  const fromWork = (plan.workBreakdown?.items ?? []).flatMap((item) => `${item.title} ${item.description}`.match(PATH_TOKEN) ?? []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of [...claimPaths(plan.claims), ...fromWork].map((value) => flat(value).replace(/^\.\//u, ""))) {
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/** The paths a plan's text names (a Markdown plan has no structure to read them from). */
export function pathsIn(text: string): string[] {
  return [...new Set((text.match(PATH_TOKEN) ?? []).map((value) => flat(value).replace(/^\.\//u, "")).filter((path) => path !== ""))];
}
/** How many top-level claims no check or scenario proves ("not planned"): the same reading as the one-screen plan's proof line. */
export function planUntestedClaims(plan: PlanDocument): number {
  return plan.claims.filter((claim) => proofKind(plan, claim) === "not_planned").length;
}
function descendantIds(claim: PlanClaim): string[] {
  return [claim.id, ...(claim.children ?? []).flatMap(descendantIds)];
}

/** How a top-level claim is proved: the strongest kind any check or scenario that names the claim (or a child of it) gives. API and browser scenarios beat a test; none is "not planned". */
function proofKind(plan: PlanDocument, claim: PlanClaim): PlanOneScreenProofKind {
  const ids = new Set(descendantIds(claim));
  const scenarios = plan.e2e?.scenarios ?? [];
  const kinds = new Set<PlanOneScreenProofKind>();
  for (const [scenarioId, proves] of Object.entries(plan.scenarioProves ?? {})) {
    if (!proves.some((id) => ids.has(id))) continue;
    const scenario = scenarios.find((item) => item.scenarioId === scenarioId);
    if (scenario === undefined) continue;
    const steps = (scenario.steps as ReadonlyArray<{ kind: string }>).map((step) => step.kind);
    const browser = steps.some((kind) => kind === "navigate" || kind === "click" || kind === "fill" || kind === "agent");
    kinds.add(browser ? "browser" : "api");
  }
  for (const check of plan.checks?.proposed ?? []) {
    if (!(plan.checks?.proves[check.id] ?? []).some((id) => ids.has(id))) continue;
    const text = `${check.label} ${check.command.executable} ${check.command.args.join(" ")}`;
    kinds.add(/\b(test|tests|pytest|vitest|jest|mocha|unittest|spec)\b/iu.test(text) ? "test" : "check");
  }
  for (const kind of ["browser", "api", "test", "check"] as const) if (kinds.has(kind)) return kind;
  return "not_planned";
}
