// The one-screen plan: a pure function of a parsed plan document and the run estimate. No model call, no clock, no storage: the same plan
// gives the same screen every time. Text that came from a plan is flattened to one line and cut at a word; nothing here is markup.
import {
  PLAN_ONE_SCREEN_APPROACH_MAX, PLAN_ONE_SCREEN_FILES_MAX, PLAN_ONE_SCREEN_MAX_CHARS, PLAN_ONE_SCREEN_RISKS_MAX, PLAN_PROOF_WORDS, PlanOneScreenSchema, formatMinutes,
  type PlanClaim, type PlanDocument, type PlanOneScreen, type PlanOneScreenProofKind, type RunEstimate,
} from "@agentx/contracts";

/** The characters the cost line may take, reserved when the plan is measured (the estimate is not part of the plan). */
const COST_LINE_RESERVE = 70;
const PROBLEM_MAX = 240;
const CLAIM_MAX = 160;
const RISK_MAX = 120;
const FILE_MAX = 80;
const PROOF_CLAIM_MAX = 120;
const HEADINGS = ["Problem", "Approach", "Files that change", "Biggest risks", "Cost and time", "How we'll know"];

const flat = (value: string): string => value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();

/** At most `max` characters, cut at a word with an ellipsis. */
export function cutWords(value: string, max: number): string {
  const text = flat(value);
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > max / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

function firstSentence(value: string): string {
  const text = flat(value);
  const end = /[.!?](?=\s|$)/u.exec(text);
  return end === null ? text : text.slice(0, end.index + 1);
}

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

/** The cost and time line of an estimate, or undefined when there is none. */
export function costLine(estimate: RunEstimate | undefined): string | undefined {
  if (estimate === undefined) return undefined;
  const usd = (value: number) => `$${value.toFixed(2)}`;
  const cost = estimate.lowUsd === estimate.highUsd ? `about ${usd(estimate.lowUsd)}` : `about ${usd(estimate.lowUsd)} to ${usd(estimate.highUsd)}`;
  return estimate.minutes === undefined ? cost : `${cost}, ${formatMinutes(estimate.minutes.low, estimate.minutes.high)}`;
}

/** The text the person reads, with section headings; its length is what the cap counts. */
export function planOneScreenText(view: Pick<PlanOneScreen, "problem" | "approach" | "files" | "filesMore" | "risks" | "cost" | "proof">): string {
  const more = view.filesMore > 0 ? [`and ${String(view.filesMore)} more`] : [];
  return [
    `${HEADINGS[0]}: ${view.problem}`,
    `${HEADINGS[1]}:`, ...view.approach.map((line) => `- ${line}`),
    `${HEADINGS[2]}: ${[...view.files, ...more].join(", ") || "none named"}`,
    ...(view.risks.length === 0 ? [] : [`${HEADINGS[3]}:`, ...view.risks.map((line) => `- ${line}`)]),
    ...(view.cost === undefined ? [] : [`${HEADINGS[4]}: ${view.cost}`]),
    `${HEADINGS[5]}:`, ...view.proof.map((entry) => `- ${entry.claim}: ${PLAN_PROOF_WORDS[entry.how]}`),
  ].join("\n");
}

const lengthOf = (text: string): number => [...text].length;

/** What the plan would take on screen with nothing cut: every top-level claim, every file and risk, at the fields' own widths, plus room for the cost line. */
export function planFullCharacters(plan: PlanDocument): number {
  const files = planFiles(plan);
  const whole = {
    problem: `${flat(plan.title)}: ${firstSentence(plan.why[0]?.text ?? "")}`,
    approach: plan.claims.map((claim) => flat(claim.text)),
    files,
    risks: plan.risks.map(flat),
    proof: plan.claims.map((claim) => ({ claim: flat(claim.text), how: proofKind(plan, claim) })),
  };
  return lengthOf(planOneScreenText({ ...whole, filesMore: 0 })) + COST_LINE_RESERVE;
}

/** Whether the plan is more than fits on one screen. */
export const planIsTooBig = (plan: PlanDocument): boolean => planFullCharacters(plan) > PLAN_ONE_SCREEN_MAX_CHARS;

type Draft = Omit<PlanOneScreen, "characters" | "fullCharacters" | "tooBig">;
const measure = (draft: Draft): number => lengthOf(planOneScreenText(draft));

/** The plan on one screen, always at most `PLAN_ONE_SCREEN_MAX_CHARS` characters. */
export function planOneScreen(plan: PlanDocument, estimate?: RunEstimate): PlanOneScreen {
  const allFiles = planFiles(plan);
  const top = plan.claims.slice(0, PLAN_ONE_SCREEN_APPROACH_MAX);
  const cost = costLine(estimate);
  const files = allFiles.slice(0, PLAN_ONE_SCREEN_FILES_MAX).map((path) => cutWords(path, FILE_MAX));
  let draft: Draft = {
    problem: cutWords(`${plan.title}: ${firstSentence(plan.why[0]?.text ?? "")}`, PROBLEM_MAX),
    approach: top.map((claim) => cutWords(claim.text, CLAIM_MAX)),
    files,
    filesMore: allFiles.length - files.length,
    risks: plan.risks.slice(0, PLAN_ONE_SCREEN_RISKS_MAX).map((risk) => cutWords(risk, RISK_MAX)),
    ...(cost === undefined ? {} : { cost }),
    proof: top.map((claim) => ({ claim: cutWords(claim.text, PROOF_CLAIM_MAX), how: proofKind(plan, claim) })),
  };
  // Shrink in a fixed order until it fits: fewer files, fewer risks, shorter claims, fewer claims. The problem and the cost stay as long as they can.
  const steps: Array<(view: Draft) => Draft> = [
    (view) => keepFiles(view, 4), (view) => keepFiles(view, 2), (view) => ({ ...view, risks: view.risks.slice(0, 2) }), (view) => ({ ...view, risks: view.risks.slice(0, 1) }),
    (view) => shorten(view, 100), (view) => shorten(view, 70), (view) => keepClaims(view, 3), (view) => keepClaims(view, 2), (view) => keepClaims(view, 1),
    (view) => keepFiles({ ...view, risks: [] }, 0), (view) => ({ ...view, problem: cutWords(view.problem, 120) }), (view) => ({ ...view, problem: cutWords(view.problem, 60), approach: view.approach.map((line) => cutWords(line, 40)), proof: view.proof.map((entry) => ({ ...entry, claim: cutWords(entry.claim, 40) })) }),
  ];
  for (const step of steps) {
    if (measure(draft) <= PLAN_ONE_SCREEN_MAX_CHARS) break;
    draft = step(draft);
  }
  const fullCharacters = planFullCharacters(plan);
  // Fails closed: the schema refuses a screen over the cap, so a bug here can never show one.
  return PlanOneScreenSchema.parse({ ...draft, characters: measure(draft), fullCharacters, tooBig: fullCharacters > PLAN_ONE_SCREEN_MAX_CHARS });
}

const keepFiles = (view: Draft, keep: number): Draft => (view.files.length <= keep ? view : { ...view, filesMore: view.filesMore + view.files.length - keep, files: view.files.slice(0, keep) });
const shorten = (view: Draft, max: number): Draft => ({ ...view, approach: view.approach.map((line) => cutWords(line, max)), proof: view.proof.map((entry) => ({ ...entry, claim: cutWords(entry.claim, max) })) });
const keepClaims = (view: Draft, keep: number): Draft => ({ ...view, approach: view.approach.slice(0, keep), proof: view.proof.slice(0, keep) });
