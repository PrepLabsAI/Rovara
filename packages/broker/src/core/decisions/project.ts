// Decision cards (Decisions D1): the projector. PURE: pending items in, cards out. A card is a projection of an item that exists today (a workflow gate, an approval, a spend request, a
// question, an autofix ask), never a new state machine. It reads no store and no clock, so the same items and locks always give the same cards. The rules it enforces on every card:
//   - the tier comes from `riskTierOf` alone (deterministic, never lowered, never below the kind's floor);
//   - low: Approve is one tap. medium: the card says the evidence must be opened first (the server enforces it, routes.ts). high: NO approve action, only "Open" (the card on its task page, or the confirmation page);
//   - an approve is a POST to this server's own card route and every link is a same-origin relative path (an item with an unsafe open path is dropped, never shown);
//   - nothing is bulk: one card has at most one approve, and there is no field or route that approves several;
//   - a standing rule may have answered a card, never a high one (the rule is ignored and the card stays pending);
//   - a Full-path requirements and design pair is ONE card with two tabs that still records two approvals (owner Q1).
// Anything an item says in words (a title, a question, a path) is flattened to plain text and cut; fixed words come from this file.
import {
  CI_STATE_WORDS, DECISION_LABELS, DECISION_REJECT_REASONS, decisionFocusPath, DESIGN_SOURCE_ONLY_LABEL, DecisionCardIdSchema, DecisionCardSchema, DecisionPlanChoicesSchema, DecisionTabsSchema, decisionFriction, canonicalJson,
  type CardAction, type DecisionPlanChoices, type DecisionCard, type DecisionKind, type DecisionDetailGroup, type DecisionRejectReason, type DecisionRisk, type DecisionTab, type DecisionTabId, type EvidenceChip,
} from "@agentx/contracts";
import { DECISION_SPEND_LOW_MAX_USD, riskTierOf, type DecisionLocks, type TierInputs, type TierResult } from "./risk-tier.js";
import { reviewCoverage, type DesignCardFacts } from "./design-facts.js";
import { cardDigest } from "./digest.js";
import { isSafeRelativePath, plainLine } from "./text.js";

/** What the card's digest covers of an item's version: its content version and, when the source bound the card to a revision, that revision too (a plan that moved on with the same document is another card). */
const versionOf = (item: ItemBase): string => (item.binding === undefined ? item.contentVersion : `${item.contentVersion}@${String(item.binding.revision)}`);

const SUBJECT_ID = /^[A-Za-z0-9_-]{1,150}$/u;

/** What every pending item carries. */
export interface ItemBase {
  /** The item's own id (an approval id, a task id and document version, ...), `[A-Za-z0-9_-]{1,150}`. */
  subjectId: string;
  taskId?: string | undefined;
  /** The project's name. */
  project: string;
  /** A person's or a plan's words: shown as plain text, cut. */
  title: string;
  createdAt: string;
  expiresAt?: string | undefined;
  /** Where the full page for this decision is: a path under `/app/` or `/v1/app/`. */
  openPath: string;
  /**
   * The confirmation page that asks for a FRESH sign-in (`/v1/app/approve/<id>`). A high-risk card opens it instead of `openPath`. A source that has no such page for the decision leaves it out: the
   * card still opens its page but the projection lists it in `unconfirmed`, and no surface claims a fresh sign-in for it.
   */
  confirmPath?: string | undefined;
  /**
   * What version of the thing decided on this item is: the plan or document version, the pull request head SHA with the risk digest, the approval record's version. REQUIRED. It goes into the card's
   * digest, so a revised plan or a new push (same title, same counts) makes an earlier "evidence opened" worthless.
   */
  contentVersion: string;
  /** What a decision on this item is bound to, read when the source drew the card: the revision the task waits at and the digest of the document. The approval gate checks both against the stored state again. */
  binding?: { revision: number; artifactDigest: string } | undefined;
  /** Evidence lines that are not on the card's front (names, not counts): shown in the panel a medium card makes the person open. */
  details?: ReadonlyArray<{ title: string; lines: readonly string[] }> | undefined;
  /** Set when a standing rule answered the item (a high card ignores it). */
  answeredByRule?: { ruleId: string; at: string } | undefined;
  /** Set when the item is no longer waiting (history); such a card has no actions. */
  outcome?: "approved" | "rejected" | "expired" | "cancelled" | undefined;
}

export interface Cost { lowUsd?: number | undefined; highUsd: number; minutes?: { low: number; high: number } | undefined }
export interface ProofCounts { proven: number; passed: number; failed: number; notTested: number }

export type DecisionItem =
  | (ItemBase & {
    kind: "approve_plan"; path: "quick" | "full"; files: readonly string[]; claims: number; untestedClaims: number; cost?: Cost | undefined; tooBig?: boolean | undefined;
    /** Slice 2: the run limit approving sets (`proposedUsd`) and the one the task has now (`currentUsd`, absent: none). The card shows it and, when it raises the limit, asks for a tick. */
    runLimit?: { currentUsd?: number | undefined; proposedUsd: number } | undefined;
    /** Slice 2 review fix: the files or the checks could not be read from the plan. The card shows neither chip and is at least medium (risk-tier). */
    unread?: boolean | undefined;
    /** OWNER DECISION 7: the plan's questions, optional checks and open comments, decided on the card (plan-cards.ts). */
    choices?: DecisionPlanChoices | undefined;
  })
  | (ItemBase & { kind: "approve_requirements"; claims: number; /** OWNER DECISION 7: the requirements' questions and open comments. */ choices?: DecisionPlanChoices | undefined })
  | (ItemBase & {
    kind: "approve_design"; files: readonly string[];
    /** The design went through design review (DR9, `design-review/card-source.ts`): the tier reads its reasons and touches, and the card shows the reviewers, blockers, disagreements and cost. Absent: the older card. */
    review?: DesignCardFacts | undefined;
    /** Slice 2 review fix: false for a person who sees the card but is not the task's owner (a maintainer, the design approver): the workflow decision sends a document back for its owner only, so they get no Request changes. */
    changesAllowed?: boolean | undefined;
    /** OWNER DECISION 7: a design WITHOUT design review (plan-cards.ts): its questions and open comments. A reviewed design never carries them. */
    choices?: DecisionPlanChoices | undefined;
  })
  | (ItemBase & { kind: "merge"; sessionId?: string | undefined; /** The head of each pull request the person is shown; the press is refused if any moved. Required: a merge card without it is not pressed. */ heads?: ReadonlyArray<{ repositoryId: string; number: number; headSha: string }> | undefined; /** The pull requests a press would merge and the branch each goes into, for the "Merge #N into <branch>?" question; read from tracking, never from model text. */ targets?: ReadonlyArray<{ repositoryId: string; number: number; baseBranch: string }> | undefined; prRisk: DecisionRisk; prReasons: readonly string[]; proof: ProofCounts; reviewVerdict: "approved" | "concerns" | "none"; ci: "passing" | "failing" | "pending" | "none" | "unreadable"; securityFindingsHigh: number; fullSuitePending: boolean })
  | (ItemBase & {
    kind: "answer_question"; question: string; index: number; of: number;
    /** A batch of design questions in ONE card (DR9, 3.7): how many. The questions themselves are the item's `details`, one group each. */
    batch?: { count: number } | undefined;
  })
  | (ItemBase & { kind: "choose_checks"; defaultLabels: readonly string[] })
  | (ItemBase & { kind: "approve_dependency"; packages: number; newInstallScripts: boolean })
  | (ItemBase & { kind: "approve_e2e_plan"; scenarios: number; usesAiNavigation: boolean })
  | (ItemBase & { kind: "review_feedback"; comments: number; touchesSensitivePaths: boolean })
  | (ItemBase & { kind: "autofix_ask"; reasonWords: string; attempts: number })
  | (ItemBase & { kind: "approve_setting"; settingLabel: string; secondPerson: boolean })
  | (ItemBase & {
    kind: "approve_spend"; amountUsd: number; scopeLabel: string;
    /**
     * A design review's cost gate (DR8, `design-review/spend-card.ts`): the card says why it asks and lists the choices as `choose` actions (each a POST of this server). Absent: the ordinary spend request.
     * `estimateUsd` is absent for "cost unavailable" (no catalog price: never a guess). `choices` is what the cost gate allowed, already filtered by the skip rules for this person; an empty list opens the page.
     */
    design?: { why: "over_cap" | "cost_unavailable"; capUsd: number; estimateUsd?: number | undefined; choices: ReadonlyArray<{ label: string; href: string }> } | undefined;
  })
  | (ItemBase & { kind: "approve_test_env"; risk: DecisionRisk; riskReasons: readonly string[]; tier: string; /** The revision of the approved environment the person looked at (0: none yet): the approval is bound to it. */ expectedRevision: number })
  | (ItemBase & { kind: "confirm_env_change"; what: "accounts" | "selection" | "environment" })
  /** Wire lane D (MD-1): a task's spec is on hold (people changed the spec pull request, or it could not be made); the owner chooses on the task page. `message` is the broker's fixed sentence. */
  | (ItemBase & { kind: "spec_choice"; message: string })
  /** Second review (lane cr-settings): the model that gives the second opinion stopped qualifying. `message` is the broker's fixed sentence; the card only opens the settings page. */
  | (ItemBase & { kind: "second_review_notice"; message: string })
  /** Slice 3b: an outside approval (`apr_`, `spr_`); its evidence is the confirmation page's own view (the item's `details`). Always high: decided on its card with a recent sign-in. */
  | (ItemBase & { kind: "approve_request"; prefix: "apr" | "spr" })
  /**
   * Setup and test health (SH17): the project's test environment kept `taskCount` tasks' checks from giving a verdict. `cause` is the auto-fix code that names the fault (a fixed word), `step` the failing step
   * in the card's words, `blockedResult` the fixed result label. `knownFailingTests` is how many tests "Mark as known failing" would add (0: the card has no such action). All of it is the broker's own record,
   * never a worker's, a model's or a repository's words.
   */
  | (ItemBase & { kind: "fix_setup"; cause: string; step: string; taskCount: number; knownFailingTests: number; unconfirmedFailing: number })
  /**
   * Test services (TS24): a fake (fixture set) for one dependency, pinned by `contentVersion` (its digest). Counts and fixed words only; the sample pairs, schema, ignored paths and faults are the item's `details`, the
   * broker's own redacted summary (`test-env/fixture-store.ts`). `schemaSynth` and `firstFromTestAccount` raise the card to high (no Approve, a full page with a fresh sign-in).
   */
  | (ItemBase & { kind: "approve_fixture_set"; dependency: string; origin: "recorded" | "written" | "imported"; entries: number; faults: number; scanClean: boolean; schemaSynth: boolean; firstFromTestAccount: boolean })
  /**
   * SH12: a website the setup run needs, one card per host per project. `host` is a plain DNS name the broker checked; `from` is the repository file and line that led to it and `journalN` the setup command
   * that hit it: both are shown quoted and marked "from the repository", never read as instructions. `staffStep` is true where Rovara staff also approve the website (Cloud).
   */
  | (ItemBase & { kind: "setup_host"; host: string; from?: { path: string; line: number } | undefined; journalN?: number | undefined; staffStep: boolean; /** The name has a punycode (`xn--`) label: it may look like another name. */ international?: boolean | undefined; /** A person's own command hit this website: who typed it, as a label (never a name). */ typedBy?: string | undefined; /** SH30: the company already approved this host in a recipe the project's setup used. A mark; the press still decides. */ companyApproved?: true | undefined });

export interface ProjectOptions {
  /** A company's locks: raise a kind's tier, never lower it. */
  locks?: DecisionLocks | undefined;
  /** Show a Full-path requirements and design pair as one card with two tabs (owner Q1: yes). Default true. */
  pairFullCards?: boolean | undefined;
}

/** The card and the item behind it (or, for a tab, the document's own card and item), so the performer acts on the right thing and records the right kind. */
export interface Subject { card: DecisionCard; item: DecisionItem }

export interface Projection {
  cards: DecisionCard[];
  /** The tabs of the cards that have them, by card id. */
  tabs: Record<string, DecisionTab[]>;
  /** For a card with tabs: each document's own card and item. */
  tabSubjects: Record<string, Record<DecisionTabId, Subject>>;
  /** The card's own item (for a card with tabs: the requirements'). */
  subjects: Record<string, Subject>;
  /** The evidence detail of each card, by card id. */
  details: Record<string, DecisionDetailGroup[]>;
  /** The digest of what is shown now, by card id: card, tabs, details and content versions. */
  digests: Record<string, string>;
  /** OWNER DECISION 7: the choices of the requirements and coding plan cards that have any, by card id (in the digest: a new comment or question is a changed card). */
  choices: Record<string, DecisionPlanChoices>;
  /** High-risk cards whose source gave no confirmation page: no fresh sign-in is claimed or enforced for them (owner decision pending). */
  unconfirmed: string[];
  /** Items left out because they could not become a safe card (a bad id or path, a missing input), counted, never described. */
  dropped: number;
}

/** The card routes this server mounts (decisions/routes.ts). The id's colon is encoded, so it is one path segment. */
export const DECISION_ROUTE_BASE = "/v1/app/decisions";
/** `<kind>/<subject>` as two path segments (the contract allows no colon or percent-escape in a path). */
export const decisionCardPath = (cardId: string): string => `${DECISION_ROUTE_BASE}/${cardId.replace(":", "/")}`;

/** The documents a person approves or sends back (slice 2): their cards carry Request changes in place of "Not now". */
const DOCUMENT_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>(["approve_plan", "approve_requirements", "approve_design"]);

const APPROVABLE: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  "approve_plan", "approve_requirements", "approve_design", "merge", "approve_dependency", "approve_e2e_plan", "review_feedback", "autofix_ask",
  "approve_spend", "approve_test_env", "confirm_env_change", "setup_host", "approve_fixture_set",
]);

const usd = (value: number): string => `$${value.toFixed(2)}`;
const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;
const chip = (kind: EvidenceChip["kind"], label: string, value: string, state: EvidenceChip["state"]): EvidenceChip => ({ kind, label: plainLine(label, 60), value: plainLine(value, 80), state });

function costText(cost: Cost | undefined): string | undefined {
  if (cost === undefined) return undefined;
  const money = cost.lowUsd === undefined || cost.lowUsd === cost.highUsd ? `about ${usd(cost.highUsd)}` : `about ${usd(cost.lowUsd)} to ${usd(cost.highUsd)}`;
  return cost.minutes === undefined ? money : `${money}, ${String(cost.minutes.low)} to ${String(cost.minutes.high)} minutes`;
}

/** What each kind says in the card: the fixed question, what happens next, and the evidence chips. Only counts and fixed words, plus plain text of the item's own title or question. */
function wordsOf(item: DecisionItem): { question: string; next: string; costUsd?: number; minutes?: number; evidence: EvidenceChip[]; why: string } {
  switch (item.kind) {
    case "approve_plan": {
      const money = costText(item.cost);
      return {
        question: item.path === "full" ? "Approve this coding plan?" : "Approve this plan and start the build?",
        next: `${money === undefined ? "Rovara builds the change and opens a pull request" : `Builds in ${item.cost?.minutes === undefined ? "a few minutes" : `${String(item.cost.minutes.low)} to ${String(item.cost.minutes.high)} minutes`}, ${money}, and opens a pull request`}.`,
        ...(item.cost === undefined ? {} : { costUsd: item.cost.highUsd }),
        ...(item.cost?.minutes === undefined ? {} : { minutes: item.cost.minutes.high }),
        // A plan whose files or checks could not be read shows neither chip: never "0 files" or "every claim has a check" for something unknown.
        evidence: [
          ...(item.unread === true ? [] : [
            chip("other", "Files", plural(item.files.length, "file", "files"), item.files.length > 25 ? "warning" : "good"),
            chip("test_proof", "Planned proof", item.untestedClaims === 0 ? "every claim has a check" : `${plural(item.untestedClaims, "claim", "claims")} with none`, item.untestedClaims === 0 ? "good" : "warning"),
          ]),
          ...(item.tooBig === true ? [chip("other", "Size", "too big for one screen", "warning")] : []),
        ],
        why: item.unread === true ? "The plan does not say what it changes or how it is proved; read it before you approve." : item.untestedClaims === 0 ? "Every claim in the plan has a planned check." : "Some claims have no planned check; look before you approve.",
      };
    }
    case "approve_requirements":
      return { question: "Approve these requirements?", next: "Rovara moves on to the design.", evidence: [chip("other", "Requirements", plural(item.claims, "claim", "claims"), "unknown")], why: "Requirements are the cheapest place to catch a wrong turn." };
    case "approve_design": {
      const review = item.review;
      if (review === undefined) return { question: "Approve this design?", next: "Rovara writes the coding plan from it.", evidence: [chip("other", "Files named", plural(item.files.length, "file", "files"), "unknown")], why: "The design fixes the approach before any code is written." };
      const coverage = reviewCoverage(review.reviewers);
      return {
        question: "Approve this design?",
        next: "Rovara writes the coding plan from it.",
        evidence: [
          chip("review", "Reviewers", coverage === "none" ? "did not run" : `${String(review.reviewers.verified)}/${String(review.reviewers.planned)} verified`, coverage === "all" ? "good" : coverage === "partial" ? "warning" : "bad"),
          chip("review", "Open blockers", String(review.blockers.length), review.blockers.length === 0 ? "good" : "bad"),
          chip("review", "Disagreements", String(review.disagreements.length), review.disagreements.length === 0 ? "good" : "warning"),
          ...(review.costUsd === undefined ? [] : [chip("cost", "Cost", usd(review.costUsd), "unknown")]),
          chip("other", "Files named", plural(item.files.length, "file", "files"), "unknown"),
        ],
        why: review.blockers.length > 0 ? "A blocker is still open: approving needs a one-line reason." : coverage === "all" ? "Fresh-context reviewers read it and no blocker is open." : "Design review did not fully run: look before you approve.",
      };
    }
    case "merge": {
      const proof = item.proof;
      const failing = proof.failed > 0 || item.ci === "failing";
      return {
        question: "Merge this pull request?",
        next: "The pull request is merged into the base branch.",
        evidence: [
          chip("test_proof", "Proof", `${String(proof.proven + proof.passed)} proven or passed, ${String(proof.failed)} failed, ${String(proof.notTested)} not tested`, proof.failed > 0 ? "bad" : proof.notTested > 0 ? "warning" : "good"),
          chip("review", "Review", item.reviewVerdict === "approved" ? "no concerns" : item.reviewVerdict === "concerns" ? "concerns raised" : "not reviewed", item.reviewVerdict === "approved" ? "good" : item.reviewVerdict === "concerns" ? "warning" : "unknown"),
          chip("checks", "CI", item.ci === "none" || item.ci === "unreadable" ? CI_STATE_WORDS[item.ci] : item.ci, item.ci === "passing" ? "good" : item.ci === "failing" ? "bad" : item.ci === "none" || item.ci === "unreadable" ? "warning" : "unknown"),
          chip("risk", "Risk", item.prRisk, item.prRisk === "low" ? "good" : item.prRisk === "medium" ? "warning" : "bad"),
          ...(item.fullSuitePending ? [chip("checks", "Full suite", "still running", "warning")] : []),
        ],
        why: failing ? "Something failed: open it and look first."
          : item.ci === "none" || item.ci === "unreadable" ? `${CI_STATE_WORDS[item.ci]}, so no CI checked this code: look at the change yourself before you merge.`
          : "The checks passed and the review has no open concerns.",
      };
    }
    case "answer_question":
      if (item.batch !== undefined) return { question: plainLine(item.question, 160), next: "Rovara goes on with your answers.", evidence: [chip("other", "Questions", String(item.batch.count), "unknown")], why: "Rovara asks instead of guessing; every question has a recommended answer." };
      return { question: plainLine(item.question, 160), next: "Rovara goes on with your answer.", evidence: [chip("other", "Question", `${String(item.index)} of ${String(item.of)}`, "unknown")], why: "Rovara asks instead of guessing." };
    case "choose_checks":
      return { question: "Which optional checks should run?", next: "The chosen checks run with the build.", evidence: [chip("checks", "Default", plural(item.defaultLabels.length, "check", "checks"), "unknown")], why: "The project's default choice is pre-selected." };
    case "approve_dependency":
      return {
        question: "Allow these new packages?", next: "The packages are added to the change.",
        evidence: [chip("other", "Packages", plural(item.packages, "package", "packages"), "warning"), chip("risk", "Install scripts", item.newInstallScripts ? "a new package runs one" : "none new", item.newInstallScripts ? "bad" : "good")],
        why: item.newInstallScripts ? "A new package runs code when it installs." : "No new package runs an install script.",
      };
    case "approve_e2e_plan":
      return { question: "Approve this browser and API test plan?", next: "The scenarios run against the changed app.", evidence: [chip("test_proof", "Scenarios", plural(item.scenarios, "scenario", "scenarios"), "unknown"), chip("other", "AI navigation", item.usesAiNavigation ? "used" : "not used", item.usesAiNavigation ? "warning" : "good")], why: "These scenarios decide what the app is tested for." };
    case "review_feedback":
      return { question: "Act on this review feedback?", next: "Rovara makes the fix on the same pull request.", evidence: [chip("review", "Comments", plural(item.comments, "comment", "comments"), "unknown")], why: "The fix stays on the same pull request." };
    case "autofix_ask":
      return { question: "Let Rovara try to fix this?", next: "Rovara tries one more fix and re-runs the checks.", evidence: [chip("checks", "Attempts so far", String(item.attempts), item.attempts > 0 ? "warning" : "unknown"), chip("other", "Why asking", plainLine(item.reasonWords, 80), "warning")], why: "Rovara already tried and wants your go-ahead." };
    case "approve_setting":
      return { question: plainLine(`Change this setting: ${item.settingLabel}?`, 160), next: "Rovara works less safely until the setting is changed back.", evidence: [chip("risk", "Effect", "less safe", "bad")], why: "A less-safe setting needs a full look." };
    case "approve_spend":
      if (item.design !== undefined) {
        const unpriced = item.design.why === "cost_unavailable";
        return {
          question: unpriced ? "Run the design review without a price?" : "The design review costs more than the limit. What now?",
          next: unpriced ? `The price of the chosen model is not known, so the cost cannot be shown. Nothing runs until you choose. If you run it, Rovara stops it as soon as the measured spend reaches ${usd(item.design.capUsd)}.` : `The design review is estimated at ${usd(item.design.estimateUsd ?? item.amountUsd)}; the limit is ${usd(item.design.capUsd)}. Nothing runs until you choose.`,
          ...(unpriced || item.design.estimateUsd === undefined ? {} : { costUsd: item.design.estimateUsd }),
          evidence: [
            chip("cost", "Estimate", unpriced ? "Cost unavailable" : usd(item.design.estimateUsd ?? item.amountUsd), unpriced ? "unknown" : "warning"),
            chip("cost", "Limit for this task", usd(item.design.capUsd), "unknown"),
          ],
          why: unpriced ? "Without a price, Rovara asks before it spends." : "Rovara never steps the reviewers down to save money; you decide.",
        };
      }
      return { question: plainLine(`Raise the limit for ${item.scopeLabel}?`, 160), next: `The limit goes up by ${usd(item.amountUsd)}.`, costUsd: item.amountUsd, evidence: [chip("cost", "Amount", usd(item.amountUsd), item.amountUsd > DECISION_SPEND_LOW_MAX_USD ? "warning" : "good")], why: "The task is paused until the limit is raised." };
    case "approve_test_env":
      return { question: "Approve this test setup?", next: "Tasks in this project use it from now on.", evidence: [chip("environment", "Tier", item.tier, item.risk === "high" ? "warning" : "unknown"), chip("risk", "Risk", item.risk, item.risk === "high" ? "bad" : "warning")], why: "Rovara booted the app and proved the setup." };
    case "spec_choice":
      return { question: plainLine(item.message, 160), next: "You choose on the task page; the code pull requests wait until you do.", evidence: [], why: "Only the task owner can choose." };
    case "approve_request":
      return { question: item.prefix === "spr" ? "Approve this spend request?" : "Approve what the agent asks?", next: "Approving does what it asks now; Decline stops it.", evidence: [], why: "You are one of the people who may decide this; it needs a recent sign-in." };
    case "second_review_notice":
      return { question: plainLine(item.message, 160), next: "Choose another model on the settings page, or wait until it qualifies again. Tasks are not stopped.", evidence: [], why: "Only a company admin can choose the model." };
    case "fix_setup":
      return {
        question: "Fix the test setup?",
        next: item.taskCount === 0 ? "The nightly run found this. Open the setup to fix it; the next night checks it again." : item.taskCount === 1 ? "One task waits on this. Open the setup to fix it; the task's checks run again after." : `${String(item.taskCount)} tasks wait on this. Open the setup to fix it; their checks run again after.`,
        evidence: [
          chip("environment", "Result", "Blocked by environment", "warning"),
          chip("environment", "Failing step", item.step, "bad"),
          ...(item.taskCount === 0 ? [] : [chip("checks", "Tasks affected", String(item.taskCount), item.taskCount > 1 ? "warning" : "unknown")]),
          // "Failing before this change" only for tests the nightly baseline confirms; the other failing tests of those checks are said apart, never as older.
          ...(item.knownFailingTests > 0 ? [chip("test_proof", "Failing before this change", plural(item.knownFailingTests, "test", "tests") + ", confirmed by the nightly run", "warning")] : []),
          ...(item.unconfirmedFailing > 0 ? [chip("test_proof", "Failing in checks that failed before", plural(item.unconfirmedFailing, "more test", "more tests") + ", not confirmed older", "bad")] : []),
        ],
        why: "The code did not fail: the test setup could not give a verdict.",
      };
    case "setup_host":
      return {
        question: plainLine(`Let the setup of this project reach ${item.host}?`, 160),
        next: item.staffStep ? "The website is added to this project's list; Rovara staff then approve it before it works." : "The website is added to this project's list, and setup tries again.",
        evidence: [
          chip("environment", "Website", item.host, "warning"),
          ...(item.international === true ? [chip("risk", "Name", "international name", "warning")] : []),
          ...(item.companyApproved === true ? [chip("environment", "Your company", item.staffStep ? "Approved in a company recipe; Rovara staff still approve it" : "Approved in a company recipe", "good")] : []),
          ...(item.from === undefined ? [] : [chip("other", "From the repository", `${item.from.path}:${String(item.from.line)}`, "unknown")]),
          ...(item.journalN === undefined ? [] : [chip("checks", "Setup command", `#${String(item.journalN)} was blocked`, "unknown")]),
          ...(item.typedBy === undefined ? [] : [chip("other", "Typed by", item.typedBy, "warning")]),
        ],
        why: "A setup command could not reach this website. Allow it only if you know what it is.",
      };
    case "approve_fixture_set":
      return {
        question: plainLine(`Use these ${item.origin === "written" ? "written" : item.origin === "imported" ? "imported" : "recorded"} answers for ${item.dependency}?`, 160),
        next: "Tasks in this project get these answers in place of the real service, exactly as pinned; a request with no answer fails the check.",
        evidence: [
          chip("environment", "Answers", plural(item.entries, "answer", "answers"), "unknown"),
          chip("environment", "Faults", plural(item.faults, "named fault", "named faults"), "unknown"),
          chip("risk", "Personal-data scan", item.scanClean ? "clean" : "found something", item.scanClean ? "good" : "bad"),
          ...(item.schemaSynth ? [chip("risk", "Unrecorded requests", "answered from the schema", "warning")] : []),
        ],
        why: item.scanClean ? "Check that the sample answers are test data before you approve." : "The scan found something in the answers: do not approve.",
      };
    case "confirm_env_change":
      return { question: "Accept this change to the test setup?", next: "The running task continues on the new setup.", evidence: [chip("environment", "Changed", item.what, "warning")], why: "The setup changed while the task was running." };
  }
}

function tierInputsOf(item: DecisionItem): TierInputs {
  switch (item.kind) {
    case "approve_plan": return { plan: { files: item.files, untestedClaims: item.untestedClaims, costHighUsd: item.cost?.highUsd, ...(item.unread === true ? { unread: true } : {}) } };
    case "approve_design": return { design: { files: item.files, ...(item.review === undefined ? {} : { review: item.review }) } };
    case "merge": return { merge: { prRisk: item.prRisk, prReasons: item.prReasons, failedChecks: item.proof.failed, untestedClaims: item.proof.notTested, securityFindingsHigh: item.securityFindingsHigh, fullSuitePending: item.fullSuitePending, ciFailing: item.ci === "failing" } };
    case "approve_dependency": return { dependency: { newInstallScripts: item.newInstallScripts } };
    case "review_feedback": return { feedback: { touchesSensitivePaths: item.touchesSensitivePaths } };
    case "approve_setting": return { setting: { secondPerson: item.secondPerson } };
    case "approve_spend": return { spend: { amountUsd: item.amountUsd } };
    case "approve_test_env": return { testEnv: { risk: item.risk, reasons: item.riskReasons } };
    case "fix_setup": return { fixSetup: { knownFailingTests: item.knownFailingTests } };
    case "approve_fixture_set": return { fixtureSet: { schemaSynth: item.schemaSynth, firstFromTestAccount: item.firstFromTestAccount, scanClean: item.scanClean } };
    default: return {};
  }
}

function actionsOf(item: DecisionItem, cardId: string, risk: DecisionRisk): { actions: CardAction[]; recommended: CardAction["kind"] } {
  const base = decisionCardPath(cardId);
  // Slice 2: a document to approve (requirements, a coding plan, a design) can always be sent back with a reason, on its card: never "Not now", which decided nothing.
  const changes: CardAction | undefined = DOCUMENT_KINDS.has(item.kind) && !(item.kind === "approve_design" && item.changesAllowed === false)
    ? { kind: "request_changes", label: DECISION_LABELS.requestChanges, href: `${base}/request-changes`, method: "POST" } : undefined;
  // Every link to a decision lands on its card: a card about a task whose page is its session opens `/app/sessions/<id>?decision=<card id>`, and the task page scrolls to that card and marks it (S1a).
  // A high card with a confirmation page still opens that page (its fresh sign-in); one without opens its card on the task page, where it is decided inline. Never a link to a page that shows the same link.
  const focused = item.taskId === undefined ? item.openPath : decisionFocusPath(item.openPath, cardId);
  const page = isSafeRelativePath(focused) ? focused : item.openPath;
  const open: CardAction = { kind: "open", label: DECISION_LABELS.open, href: risk === "high" ? item.confirmPath ?? page : page, method: "GET" };
  // An outside approval is decided on its card (Approve with a recent sign-in through the high-on-card route, Decline here): it carries Decline as its reject.
  if (item.kind === "approve_request") return { actions: [open, { kind: "reject", label: "Decline", href: `${base}/reject`, method: "POST" }], recommended: "open" };
  // A HIGH design cost card keeps its choices (decided on its task page behind the evidence, each under the decide-grade sign-in); it still opens first, and Slack and Home show only Open.
  if (risk === "high" && item.kind === "approve_spend" && item.design !== undefined) {
    return { actions: [open, ...item.design.choices.slice(0, 3).map((choice): CardAction => ({ kind: "choose", label: plainLine(choice.label, 60), href: choice.href, method: "POST" }))], recommended: "open" };
  }
  if (risk === "high") return { actions: changes === undefined ? [open] : [open, changes], recommended: "open" };
  // A question or a checks choice is answered on its own page: the card only opens it (an answer or a choice is a POST of that page, never a link).
  if (item.kind === "answer_question") return { actions: [{ ...open, label: DECISION_LABELS.answer }], recommended: "open" };
  if (item.kind === "choose_checks") return { actions: [{ ...open, label: "Choose checks" }], recommended: "open" };
  // A held spec is answered on the task page (its buttons are POSTs of that page): the card only opens it.
  if (item.kind === "spec_choice") return { actions: [{ ...open, label: "Choose" }], recommended: "open" };
  // A notice that the second-opinion model stopped qualifying: the card only opens the settings page, where the choice is made and "I've seen it" is pressed.
  if (item.kind === "second_review_notice") return { actions: [{ ...open, label: "Open the settings" }], recommended: "open" };
  // Fix setup: Run setup agent, Fix with agent and Retry task checks are done on the pages the card opens (the setup page and the affected task's page); the card itself only decides the two things that need
  // the server's friction. "Mark as known failing" is the card's one approve (medium: the evidence is opened first, and the tests it marks are the broker's own record, never the request's); "Not now" puts
  // the card away until the cause comes back. Recommended is to look first.
  if (item.kind === "fix_setup") {
    const reject: CardAction = { kind: "reject", label: DECISION_LABELS.notNow, href: `${base}/reject`, method: "POST" };
    const mark: CardAction = { kind: "approve", label: "Mark as known failing", href: `${base}/approve`, method: "POST" };
    return { actions: item.knownFailingTests > 0 ? [{ ...open, label: "Open the setup" }, reject, mark] : [{ ...open, label: "Open the setup" }, reject], recommended: "open" };
  }
  // A design review's cost gate (DR8): the choices the gate allowed are the card's actions. None allowed: the card only opens the page.
  if (item.kind === "approve_spend" && item.design !== undefined) {
    const choices: CardAction[] = item.design.choices.slice(0, 3).map((choice) => ({ kind: "choose", label: plainLine(choice.label, 60), href: choice.href, method: "POST" }));
    return choices.length === 0 ? { actions: [open], recommended: "open" } : { actions: [...choices, open], recommended: "choose" };
  }
  if (!APPROVABLE.has(item.kind)) return { actions: [open], recommended: "open" };
  // A design with an open blocker is never a one-tap approve (owner Q8): the action says a reason goes with it, the approve body takes `reason`, and the handler refuses an approval without one.
  const openBlockers = item.kind === "approve_design" ? item.review?.blockers.length ?? 0 : 0;
  const approve: CardAction = { kind: "approve", label: openBlockers > 0 ? DECISION_LABELS.approveWithReason : item.kind === "merge" ? DECISION_LABELS.merge : DECISION_LABELS.approve, href: `${base}/approve`, method: "POST" };
  // A document is never put off ("Not now" decided nothing): its owner sends it back; anyone else only approves (if they may) or opens it.
  const reject: CardAction | undefined = changes ?? (DOCUMENT_KINDS.has(item.kind) ? undefined : { kind: "reject", label: DECISION_LABELS.notNow, href: `${base}/reject`, method: "POST" });
  // The recommendation follows the evidence: something failed, or a blocker is open, so look first.
  const look = openBlockers > 0 || (item.kind === "merge" && (item.proof.failed > 0 || item.ci === "failing"));
  const present = (actions: Array<CardAction | undefined>): CardAction[] => actions.filter((action): action is CardAction => action !== undefined);
  return look ? { actions: present([open, reject, approve]), recommended: "open" } : { actions: present([approve, reject, open]), recommended: "approve" };
}

const REJECTABLE_REASONS: readonly DecisionRejectReason[] = DECISION_REJECT_REASONS;

/** The card for one item, or undefined when the item cannot become a safe one. */
export function cardOfItem(item: DecisionItem, locks: DecisionLocks = {}): { card: DecisionCard; tier: TierResult } | undefined {
  if (!SUBJECT_ID.test(item.subjectId) || !isSafeRelativePath(item.openPath)) return undefined;
  if (item.confirmPath !== undefined && !(item.confirmPath.startsWith("/v1/app/approve/") && isSafeRelativePath(item.confirmPath))) return undefined;
  if (!/^[^\p{Cc}\p{Cf}]{1,100}$/u.test(item.contentVersion)) return undefined;
  const id = `${item.kind}:${item.subjectId}`;
  if (!DecisionCardIdSchema.safeParse(id).success) return undefined;
  let tier: TierResult;
  try { tier = riskTierOf(item.kind, tierInputsOf(item), locks); } catch { return undefined; }
  const words = wordsOf(item);
  const { risk } = tier;
  const answered = item.answeredByRule !== undefined && risk !== "high" ? item.answeredByRule : undefined;
  const closed = item.outcome !== undefined || answered !== undefined;
  const { actions, recommended } = actionsOf(item, id, risk);
  const status = answered !== undefined ? "answered_by_rule" : item.outcome ?? "pending";
  const candidate = {
    id, kind: item.kind, ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
    project: plainLine(item.project, 100), title: plainLine(item.title, 80),
    question: plainLine(words.question, 160),
    recommended: { action: closed ? "open" : recommended, why: plainLine(words.why, 120) },
    next: { text: plainLine(words.next, 160), ...(words.costUsd === undefined ? {} : { costUsd: words.costUsd }), ...(words.minutes === undefined ? {} : { minutes: words.minutes }) },
    evidence: words.evidence.slice(0, 6),
    risk, riskReasons: tier.reasons,
    friction: decisionFriction(risk, tier.secondPerson),
    actions: closed ? [] : actions,
    ...(item.kind === "approve_plan" && item.runLimit !== undefined && Number.isFinite(item.runLimit.proposedUsd)
      ? { runLimit: { proposedUsd: item.runLimit.proposedUsd, ...(item.runLimit.currentUsd === undefined || !Number.isFinite(item.runLimit.currentUsd) ? {} : { currentUsd: item.runLimit.currentUsd }) } } : {}),
    rejectReasons: closed || !actions.some((action) => action.kind === "reject") ? [] : [...REJECTABLE_REASONS],
    ...(answered === undefined ? {} : { answeredByRule: { ruleId: plainLine(answered.ruleId, 64), at: answered.at } }),
    status, createdAt: item.createdAt, ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }),
  };
  const parsed = DecisionCardSchema.safeParse(candidate);
  return parsed.success ? { card: parsed.data, tier } : undefined;
}

const TAB_TITLES = { requirements: "Requirements", design: "Design" } as const;

const listed = (values: readonly string[], max = 20): string[] => {
  const lines = values.slice(0, max).map((value) => plainLine(value, 200)).filter((line) => line !== "");
  return values.length > max ? [...lines, `and ${String(values.length - max)} more`] : lines;
};

/**
 * The evidence a medium card makes the person open: names, which the front does not carry. From the item's own `details`, the files a plan or design changes and the reasons behind a merge's
 * risk, then the card's risk reasons. A card with none of these gets one line saying why it needs a look, so the panel is never empty.
 */
export function detailsOfItem(item: DecisionItem, card: DecisionCard, tab?: DecisionTabId): DecisionDetailGroup[] {
  const groups: Array<{ title: string; lines: string[] }> = [];
  if (item.kind === "approve_plan" || item.kind === "approve_design") groups.push({ title: "Files that change", lines: listed(item.files) });
  if (item.kind === "merge") groups.push({ title: "Why the pull request has this risk", lines: listed(item.prReasons) });
  // The design review's findings the approver must weigh (DR9): blockers that are still open (approving needs a reason) and the places the planner and a reviewer disagree.
  if (item.kind === "approve_design" && item.review !== undefined) {
    if (item.review.blockers.length > 0) groups.push({ title: "Open blockers", lines: listed(item.review.blockers.map((finding) => `${finding.section}: ${finding.sourceOnly === true ? `(${DESIGN_SOURCE_ONLY_LABEL}) ` : ""}${finding.text}`)) });
    if (item.review.disagreements.length > 0) groups.push({ title: "Disagreements", lines: listed(item.review.disagreements.map((finding) => `${finding.section}: ${finding.text}`)) });
  }
  for (const group of item.details ?? []) groups.push({ title: plainLine(group.title, 60), lines: listed(group.lines) });
  groups.push({ title: "Why this needs a look", lines: card.riskReasons.length > 0 ? listed(card.riskReasons) : ["It is a kind of decision that always gets a look first."] });
  return groups.filter((group) => group.lines.length > 0 && group.title !== "").slice(0, 8).map((group) => ({ ...(tab === undefined ? {} : { tab }), title: group.title, lines: group.lines }));
}

/** One card for a task's requirements and design: the requirements card, at the higher of the two tiers, with a tab for each document. Each tab is still its own approval. */
function pairCards(requirements: Subject, design: Subject): { card: DecisionCard; tabs: DecisionTab[] } | undefined {
  const risk = requirements.card.risk === "high" || design.card.risk === "high" ? "high" : requirements.card.risk === "medium" || design.card.risk === "medium" ? "medium" : "low";
  const base = requirements.card;
  const high = risk === "high";
  const actions = base.actions.filter((action) => action.kind === "open" || action.kind === "request_changes" || (action.kind === "approve" && !high) || (action.kind === "reject" && !high)).slice(0, 4);
  const confirm = requirements.item.confirmPath ?? design.item.confirmPath;
  const page = base.actions.find((action) => action.kind === "open")?.href ?? requirements.item.openPath;
  const shown: CardAction[] = high ? [{ kind: "open", label: DECISION_LABELS.open, href: confirm ?? page, method: "GET" }, ...actions.filter((action) => action.kind === "request_changes")] : actions;
  const merged = DecisionCardSchema.safeParse({
    ...base,
    title: plainLine(requirements.item.title, 80),
    question: "Approve the requirements and the design?",
    next: { text: "Each document is approved on its own, requirements first; when both are, Rovara writes the coding plan." },
    evidence: [...requirements.card.evidence.slice(0, 3), ...design.card.evidence.slice(0, 3)],
    risk,
    riskReasons: [...new Set([...requirements.card.riskReasons, ...design.card.riskReasons])].slice(0, 5),
    friction: decisionFriction(risk, false),
    recommended: { action: high ? "open" : "approve", why: "Two approvals, one for each document." },
    actions: shown,
    rejectReasons: high ? [] : base.rejectReasons,
  });
  if (!merged.success) return undefined;
  const tabs = DecisionTabsSchema.safeParse([
    { id: "requirements", title: TAB_TITLES.requirements, summary: plainLine(requirements.card.question, 300), evidence: requirements.card.evidence, approved: false },
    { id: "design", title: TAB_TITLES.design, summary: plainLine(design.card.question, 300), evidence: design.card.evidence, approved: false },
  ]);
  return tabs.success ? { card: merged.data, tabs: tabs.data } : undefined;
}

const RISK_RANK: Record<DecisionRisk, number> = { high: 0, medium: 1, low: 2 };

/**
 * Items in, cards out. High first, then newest first. A Full-path requirements and design pair for one task is merged into one card when `pairFullCards` (the default) and BOTH are waiting (today's
 * Full flow asks for them one after the other, so a pair forms only if the controller drafts the design early: owner Q1 follow-up). The same items and locks always give the same cards, in the
 * same order.
 */
export function projectDecisionCards(items: readonly DecisionItem[], options: ProjectOptions = {}): Projection {
  const locks = options.locks ?? {};
  let dropped = 0;
  const built: Subject[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const result = cardOfItem(item, locks);
    if (result === undefined || seen.has(result.card.id)) { dropped += 1; continue; }
    seen.add(result.card.id);
    built.push({ item, card: result.card });
  }
  const cards: DecisionCard[] = [];
  const tabs: Record<string, DecisionTab[]> = {};
  const tabSubjects: Record<string, Record<DecisionTabId, Subject>> = {};
  const subjects: Record<string, Subject> = {};
  const details: Record<string, DecisionDetailGroup[]> = {};
  const detailsOf = (id: string): DecisionDetailGroup[] => details[id] ?? [];
  const digests: Record<string, string> = {};
  const merged = new Set<string>();
  if (options.pairFullCards !== false) {
    for (const first of built) {
      if (first.item.kind !== "approve_requirements" || first.card.status !== "pending" || first.item.taskId === undefined) continue;
      const second = built.find((other) => other.item.kind === "approve_design" && other.card.status === "pending" && other.item.taskId === first.item.taskId);
      if (second === undefined) continue;
      const pair = pairCards(first, second);
      if (pair === undefined) continue;
      merged.add(first.card.id);
      merged.add(second.card.id);
      cards.push(pair.card);
      tabs[pair.card.id] = pair.tabs;
      tabSubjects[pair.card.id] = { requirements: first, design: second };
      subjects[pair.card.id] = first;
      details[pair.card.id] = [...detailsOfItem(first.item, first.card, "requirements"), ...detailsOfItem(second.item, second.card, "design")].slice(0, 12);
      digests[pair.card.id] = cardDigest(pair.card, pair.tabs, detailsOf(pair.card.id), [versionOf(first.item), versionOf(second.item)]);
    }
  }
  const choices: Record<string, DecisionPlanChoices> = {};
  for (const entry of built) {
    if (merged.has(entry.card.id)) continue;
    cards.push(entry.card);
    subjects[entry.card.id] = entry;
    details[entry.card.id] = detailsOfItem(entry.item, entry.card);
    const chosen = choicesOfItem(entry.item, entry.card);
    if (chosen !== undefined) choices[entry.card.id] = chosen;
    // A card without choices keeps the digest it had; one with choices adds them, so the person approves the questions, checks and comments they were shown.
    digests[entry.card.id] = cardDigest(entry.card, undefined, detailsOf(entry.card.id), chosen === undefined ? [versionOf(entry.item)] : [versionOf(entry.item), canonicalJson(chosen)]);
  }
  cards.sort((a, b) => RISK_RANK[a.risk] - RISK_RANK[b.risk] || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const unconfirmed = cards.filter((card) => card.risk === "high" && card.status === "pending" && !(card.actions.find((action) => action.kind === "open")?.href ?? "").startsWith("/v1/app/approve/")).map((card) => card.id);
  return { cards, tabs, tabSubjects, subjects, details, digests, choices, unconfirmed, dropped };
}

/** A pending requirements or coding plan card's choices, when it has any and they are a valid shape; anything else has none (the person can still approve with AgentX's answers). */
function choicesOfItem(item: DecisionItem, card: DecisionCard): DecisionPlanChoices | undefined {
  if ((item.kind !== "approve_plan" && item.kind !== "approve_requirements" && !(item.kind === "approve_design" && item.review === undefined)) || item.choices === undefined || card.status !== "pending") return undefined;
  const parsed = DecisionPlanChoicesSchema.safeParse(item.choices);
  if (!parsed.success) return undefined;
  const { questions, optionalChecks, openComments } = parsed.data;
  // A design without design review always carries its choices (empty or not): the app reads them as "decided on this card", where its high Approve asks for the decide-grade sign-in.
  if (item.kind === "approve_design") return parsed.data;
  return questions.length === 0 && optionalChecks.length === 0 && openComments.length === 0 ? undefined : parsed.data;
}
