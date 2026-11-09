// Decision cards (Decisions D1): the risk tier of a card, from defined inputs only (design proof-test-env 3.7). Paths, size, money, security findings, untested claims, environment changes
// and the company's locks decide it. No model text sets a tier, and no input can lower one: every rule only raises, a kind never starts below its floor (`DECISION_KIND_FLOOR_RISK`, so an
// approve_setting is high however small it looks) and a company lock raises through `raiseRisk`. The reasons are fixed words and numbers; a path is shown through `plainLine`.
import { DECISION_KIND_FLOOR_RISK, raiseRisk, type DecisionKind, type DecisionRisk } from "@agentx/contracts";
import { DESIGN_AREA_WORDS, DESIGN_TIER_HIGH_CODES, DESIGN_TIER_MEDIUM_CODES, reviewCoverage, type DesignCardFacts } from "./design-facts.js";
import { isSensitivePath } from "./sensitive-paths.js";
import { plainLine } from "./text.js";

/** A plan that touches more files than this, or is expected to cost more than these amounts, is at least medium (then high). Money steps match the approval ladder: a lead decides up to $10, an admin up to $100. */
export const DECISION_PLAN_FILES_MEDIUM = 25;
export const DECISION_PLAN_COST_MEDIUM_USD = 25;
export const DECISION_PLAN_COST_HIGH_USD = 100;
export const DECISION_SPEND_LOW_MAX_USD = 10;
export const DECISION_SPEND_MEDIUM_MAX_USD = 100;

/** The paths that change who may do what, where the code runs or how data is shaped: infrastructure, IAM, migrations. */
const INFRA_PATH = /(^|\/)(infra|infrastructure|terraform|cdk|iam|migrations)(\/|$)|\.(tf|sql)$|(^|\/)(cdk\.json|template\.ya?ml)$|(^|\/)dockerfile$/u;
export const isInfraPath = (path: string): boolean => INFRA_PATH.test(path.replaceAll("\\", "/").replace(/^(?:\.\/)+/u, "").toLowerCase());

export interface TierResult { risk: DecisionRisk; reasons: string[]; /** A high card that also needs a second person (a less-safe setting, a spend over the admin amount). */ secondPerson: boolean }

/** A company's locks: a kind's tier may be raised to at least this, never lowered. */
export type DecisionLocks = Partial<Record<DecisionKind, DecisionRisk>>;

/** What each kind's rules read. Every field is plain data the projector got from a pending item; none is model text. */
export interface TierInputs {
  plan?: { files: readonly string[]; untestedClaims: number; costHighUsd?: number | undefined; /** The files or the checks could not be read from the plan (slice 2 review fix): at least medium. */ unread?: boolean | undefined };
  /**
   * `review` is present when the design went through design review (DR9): the tier then also reads its reasons, its `touches[]`, how the review went and what it found. Absent (a design with no review, or one
   * from before the stage): the older rule, infrastructure or sensitive paths make it medium.
   */
  design?: { files: readonly string[]; review?: DesignCardFacts | undefined };
  merge?: { prRisk: DecisionRisk; prReasons: readonly string[]; failedChecks: number; untestedClaims: number; securityFindingsHigh: number; fullSuitePending: boolean; ciFailing: boolean };
  dependency?: { newInstallScripts: boolean };
  feedback?: { touchesSensitivePaths: boolean };
  setting?: { secondPerson: boolean };
  spend?: { amountUsd: number };
  testEnv?: { risk: DecisionRisk; reasons: readonly string[] };
  fixSetup?: { knownFailingTests: number };
  /** A fake (fixture set) for a dependency (TS24): what raises it from medium to high. */
  fixtureSet?: { schemaSynth: boolean; firstFromTestAccount: boolean; scanClean: boolean };
}

class Tally {
  risk: DecisionRisk;
  secondPerson = false;
  readonly reasons: string[] = [];
  constructor(floor: DecisionRisk) { this.risk = floor; }
  raise(to: DecisionRisk, reason: string): void {
    this.risk = raiseRisk(this.risk, to);
    if (this.reasons.length < 5 && !this.reasons.includes(reason)) this.reasons.push(plainLine(reason, 100));
  }
}

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`;
const shownPaths = (paths: readonly string[]) => `${paths.slice(0, 2).map((path) => plainLine(path, 40)).join(", ")}${paths.length > 2 ? ` and ${String(paths.length - 2)} more` : ""}`;

function planRules(tally: Tally, files: readonly string[]): void {
  const infra = files.filter(isInfraPath);
  if (infra.length > 0) tally.raise("high", `Changes infrastructure, IAM or data files: ${shownPaths(infra)}.`);
  const sensitive = files.filter((path) => isSensitivePath(path) && !isInfraPath(path));
  if (sensitive.length > 0) tally.raise("medium", `Touches sensitive paths: ${shownPaths(sensitive)}.`);
  if (files.length > DECISION_PLAN_FILES_MEDIUM) tally.raise("medium", `Changes ${String(files.length)} files, more than ${String(DECISION_PLAN_FILES_MEDIUM)}.`);
}

/**
 * The approve_design rule when the design went through design review (3.8). Every line only raises: the codes (Understand's reasons and the design's own `touches[]`) and the counts are fixed data, and a code
 * that is left out lowers nothing. High: data model, auth, money, personal data, infrastructure, another repository or service, or files on infrastructure/IAM/migration paths. Medium: a new or changed API, a
 * new dependency, sensitive paths, an open blocker or major, or a review that did not run or ran only in part.
 */
function designRules(tally: Tally, files: readonly string[], review: DesignCardFacts): void {
  const codes = [...new Set([...review.reasons, ...review.touches])];
  for (const code of codes) if (DESIGN_TIER_HIGH_CODES.includes(code)) tally.raise("high", `The design ${DESIGN_AREA_WORDS[code]}.`);
  const infra = files.filter(isInfraPath);
  if (infra.length > 0) tally.raise("high", `Changes infrastructure, IAM or data files: ${shownPaths(infra)}.`);
  for (const code of codes) if (DESIGN_TIER_MEDIUM_CODES.includes(code)) tally.raise("medium", `The design ${DESIGN_AREA_WORDS[code]}.`);
  const sensitive = files.filter((path) => isSensitivePath(path) && !isInfraPath(path));
  if (sensitive.length > 0) tally.raise("medium", `Touches sensitive paths: ${shownPaths(sensitive)}.`);
  if (review.blockers.length > 0) tally.raise("medium", `${plural(review.blockers.length, "blocker is", "blockers are")} still open.`);
  if (review.majors > 0) tally.raise("medium", `${plural(review.majors, "major finding is", "major findings are")} still open.`);
  const coverage = reviewCoverage(review.reviewers);
  if (coverage === "none") tally.raise("medium", "Design review did not run.");
  else if (coverage === "partial") tally.raise("medium", "Design review ran only in part.");
}

/**
 * The tier of one decision: the kind's floor, raised by what its inputs say, then by the company's lock for the kind. Always at least the floor and at least the lock.
 * A missing input for a kind that needs one (a merge with no PR risk) is NOT read as low: the caller must pass the inputs or the projector drops the card.
 */
export function riskTierOf(kind: DecisionKind, inputs: TierInputs, locks: DecisionLocks = {}): TierResult {
  const tally = new Tally(DECISION_KIND_FLOOR_RISK[kind]);
  switch (kind) {
    case "approve_plan": {
      const plan = inputs.plan;
      if (plan === undefined) throw new Error("plan inputs missing");
      planRules(tally, plan.files);
      if (plan.untestedClaims > 0) tally.raise("medium", `${plural(plan.untestedClaims, "claim has", "claims have")} no planned proof.`);
      // What a plan changes or how it is proved, when it cannot be read from the plan, is never assumed to be nothing.
      if (plan.unread === true) tally.raise("medium", "The plan's files or the checks that prove it could not be read.");
      if ((plan.costHighUsd ?? 0) > DECISION_PLAN_COST_HIGH_USD) tally.raise("high", `Expected to cost more than $${String(DECISION_PLAN_COST_HIGH_USD)}.`);
      else if ((plan.costHighUsd ?? 0) > DECISION_PLAN_COST_MEDIUM_USD) tally.raise("medium", `Expected to cost more than $${String(DECISION_PLAN_COST_MEDIUM_USD)}.`);
      break;
    }
    case "approve_design": {
      if (inputs.design === undefined) throw new Error("design inputs missing");
      const review = inputs.design.review;
      if (review === undefined) {
        const touches = inputs.design.files.filter((path) => isInfraPath(path) || isSensitivePath(path));
        if (touches.length > 0) tally.raise("medium", `Touches infrastructure, IAM or data: ${shownPaths(touches)}.`);
        break;
      }
      designRules(tally, inputs.design.files, review);
      break;
    }
    case "merge": {
      const merge = inputs.merge;
      if (merge === undefined) throw new Error("merge inputs missing");
      tally.raise(merge.prRisk, merge.prRisk === "low" ? "The pull request is low risk." : `The pull request is ${merge.prRisk} risk.`);
      for (const reason of merge.prReasons.slice(0, 2)) tally.raise(merge.prRisk, reason);
      if (merge.untestedClaims > 0) tally.raise("medium", `${plural(merge.untestedClaims, "requirement was", "requirements were")} not tested.`);
      if (merge.failedChecks > 0) tally.raise("medium", `${plural(merge.failedChecks, "check", "checks")} failed.`);
      if (merge.ciFailing) tally.raise("medium", "CI is failing.");
      if (merge.securityFindingsHigh > 0) tally.raise("high", "The security scan found a high-severity problem.");
      if (merge.fullSuitePending) tally.raise("medium", "The full test suite has not finished yet.");
      break;
    }
    case "approve_dependency":
      if (inputs.dependency?.newInstallScripts === true) tally.raise("high", "A new package runs an install script.");
      break;
    case "review_feedback":
      if (inputs.feedback?.touchesSensitivePaths === true) tally.raise("medium", "The fix would change sensitive paths.");
      break;
    case "approve_setting":
      tally.raise("high", "A setting that makes Rovara less safe.");
      if (inputs.setting?.secondPerson === true) tally.secondPerson = true;
      break;
    case "approve_spend": {
      const amount = inputs.spend?.amountUsd;
      if (amount === undefined || !Number.isFinite(amount) || amount < 0) throw new Error("spend inputs missing");
      if (amount > DECISION_SPEND_MEDIUM_MAX_USD) { tally.raise("high", `Asks for more than $${String(DECISION_SPEND_MEDIUM_MAX_USD)}.`); tally.secondPerson = true; }
      else if (amount > DECISION_SPEND_LOW_MAX_USD) tally.raise("medium", `Asks for more than $${String(DECISION_SPEND_LOW_MAX_USD)}.`);
      break;
    }
    case "approve_test_env":
      if (inputs.testEnv === undefined) throw new Error("test environment inputs missing");
      tally.raise(inputs.testEnv.risk, inputs.testEnv.risk === "high" ? "Adds pre-production access, a shared or preview environment, video or traces, a test account or your own image for a dependency, or a seed command that fills a test database by running your code." : "Sets how tests run for this project.");
      for (const reason of inputs.testEnv.reasons.slice(0, 3)) tally.raise(inputs.testEnv.risk, reason);
      break;
    case "fix_setup":
      if ((inputs.fixSetup?.knownFailingTests ?? 0) > 0) tally.raise("medium", "Marking tests as already failing changes how later results are judged.");
      break;
    case "setup_host":
      tally.raise("medium", "Lets this project's machines reach a new website.");
      break;
    case "approve_fixture_set": {
      const fixture = inputs.fixtureSet;
      if (fixture === undefined) throw new Error("fixture set inputs missing");
      tally.raise("medium", "Tasks will get these recorded answers in place of the real service.");
      if (fixture.schemaSynth) tally.raise("high", "Requests with no recording are answered from the schema.");
      if (fixture.firstFromTestAccount) tally.raise("high", "First recording made with the company's test account.");
      if (!fixture.scanClean) tally.raise("high", "The personal-data scan found something.");
      break;
    }
    default:
      break;
  }
  const locked = locks[kind];
  if (locked !== undefined) tally.raise(locked, "Your company asks for a closer look at this kind of decision.");
  if (tally.risk !== "high") tally.secondPerson = false;
  return { risk: tally.risk, reasons: tally.reasons, secondPerson: tally.secondPerson };
}
