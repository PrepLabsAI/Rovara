# Spec 048 Phase 2: Order and Early Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every decision comes first and the long build runs unattended: the account is shown and
checked before any setting is asked, the settings are one screen (four fields plus a collapsed
Advanced section), every answer that can fail late is checked before anything is created, the plan
is a plain summary with "Create AgentX" and "Change answers", the GitHub app is made before the
build, the Slack visit is one form of four values, developer sign-in is turned on with the Slack
connection without a second approval, alerts are subscribed as soon as their topic exists, the
release download shows on the page, and the terminal path asks in the same order.

**Architecture:**
- **The run order lives in the journey model.** `journey.ts` gains `INSTALL_STEP_ORDER` (the order
  the steps run in); `initSteps` follows it, and the GitHub app moves to "Your choices".
  `INIT_STEP_IDS` (the progress schema's own list) does not change, so every recorded install still
  reads (a done step is skipped by id, never by position).
- **One settings form, two front ends.** `settings-form.ts` (new) builds the settings as
  `FormField`s: four default-path fields, then fields marked `section: "advanced"`. On the page
  `askForm` shows them as one screen with a "Recommended settings" summary and a collapsed
  "Advanced settings" section; in the terminal `askForm` asks the four fields, then one
  "Change the advanced settings?" question. `collectInitAnswers` turns the values into
  `InitAnswers` and asks follow-up questions only for the Advanced choices that need them (your own
  OIDC, OpenRouter, another model id, a webhook).
- **Checks in two passes, both before anything is created.** `checkAccount` (EC2 vCPU quota,
  Elastic IPs, Amazon Bedrock in the region) runs right after the region; `checkPrerequisites`
  with `skipAccount` runs after the settings and adds `clashChecks` (install name already used,
  GitHub owner exists and its type, app name length and clash). On the page a failure offers
  "Change answers", "Check again" and "Stop for now".
- **A plan is data, not text.** `planSummary` (plan.ts) returns a `WizardPlan` (sections, a
  three-column cost table, the full resource list for "Show every resource"); the page renders it
  and the full text still goes to the log file. On the page the plan's buttons are "Create AgentX"
  and "Change answers"; Change answers re-asks the settings with every answer kept.
- **The human parts before and after the build only.** The GitHub app step runs before
  `access`; a half-made app is recorded before its key is stored, so a resume can finish or replace
  it. The Slack step asks all four values on one form and stores the sign-in client values with the
  bot values, so the developer sign-in step that follows asks nothing and applies its change with
  no question.
- **The page is up first.** The wizard starts before the release download; the download and any
  sign-in code a child process prints (`aws sso login`) are cards on the page.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Vitest 5, zod 4. One new dependency
pending owner confirmation: `@aws-sdk/client-iam` at `3.1134.0`, the pin every other AWS SDK client
in `packages/cli/package.json` uses (Ruling 4). The page stays plain HTML, CSS and an ES module held
as text in `page.ts` (spec 040).

**Spec:** [../spec.md](../spec.md), the binding authority. This plan delivers the spec's Phases
row 2: FR-009, FR-015, FR-018, FR-020 to FR-022, FR-025, FR-028 to FR-036, FR-038, FR-065 and
FR-072, with their success criteria SC-009 (each FR-065 item reported before anything is created)
and SC-015 (the `--yes` tests pass; the no-UI path asks in the same order and runs the same early
checks). Owner approval of the spec, with all five open choices accepted: PR #231 comment of
2026-10-01. Design proposal and owner decisions: the guided install design, section 10
(decisions 1, 2 and 5 bind this phase: no separate sign-in approval, budget plus 20% for the whole
account with tag scope in Advanced, the no-UI path in the same order without pickers).

**Builds on:** phase 1 (`specs/048-guided-install/plans/phase-1-page-shell.md`, merged) and its
implementation, branch `feat/048-phase1-page-shell`. Every interface this plan consumes is phase
1's as implemented there: `STEP_PLAN`, `journeyOf`, `CARD_PHASES`, `FormField`, `askForm`,
`QuestionHelp`, `questionHelp`, `WizardQuestion`, `WizardField`, `WizardCard`, `WizardHub`,
`retryOnPage`, `failureScreen`, `askFailureAction`, `operatorStop`, `markOperatorStop`,
`releaseImageChecks`, `defaultAppName`, `estimateMonthlyCost`, `suggestedBudgetUsd`, `budgetWhy`,
`modelPriceLabel`, `PAGE_CLASSES`, `WIZARD_CSS`, `stateEntries` and `lintCopy`.

**Branch:** `feat/048b-order-and-checks`, cut from `origin/mainline` **only after phase 1's PR has
merged into mainline**. One PR against `mainline` (no stacking: never branch from
`feat/048-phase1-page-shell`, never target it).

## Global Constraints

- **Start only after phase 1 merges.** Before Task 1: `git fetch origin`, confirm
  `git log origin/mainline --oneline | grep "048 FR-081"` shows phase 1's last commit, then cut the
  branch from `origin/mainline`. If phase 1's review renamed anything this plan names in "Builds on",
  use the merged name and say so in the PR description; never re-create a phase 1 name.
- **Recorded installs still resume.** `INIT_STEP_IDS` keeps its ids and its order. `InitAnswersSchema`
  and `InstallProgressSchema` only gain optional fields. A done step is skipped wherever it now
  stands in the run order.
- **The terminal path and `--yes` keep every flag and its meaning** (FR-072, SC-015). They change only
  where this spec changes the install everywhere, and each change is deliberate and listed:
  1. the questions come in the page's order: the account, then your email, GitHub owner, install
     name and app name, then "Change the advanced settings?" (No takes every recommended value);
  2. the Slack Client ID and Client Secret are asked with the Signing Secret and the Bot User OAuth
     Token, in Slack's order, in the Slack app step;
  3. developer sign-in asks no "Apply this change?" and no client values (the plan said so);
  4. the admin user's email comes from the settings, not a question at the end;
  5. alerts go to your email unless you choose otherwise (FR-025), so `--yes --admin-email x` with
     no alert flag now sends alerts to x instead of refusing (Ruling 9);
  6. the GitHub owner's type is looked up on GitHub, and asked only when GitHub cannot say;
  7. the Slack app name is no longer its own question: one name names both apps (FR-020), and
     `--slack-app-name` still sets the Slack one.
  Every existing `--yes` test passes with its argv unchanged; an expected value changes only for
  these seven, with the new exact value.
- **Exact names (later phases depend on them):** `INSTALL_STEP_ORDER`, `SETTINGS_TITLE`,
  `SETTINGS_FIELD`, `SIGN_IN_GROUP`, `settingsFields`, `recommendedSummary`,
  `WORKER_MODEL_CHOICES`, `ADVANCED_QUESTION`, `FormOptions`, `checkAccount`, `clashChecks`,
  `checkWithChangeOnPage`, `planSummary`, `WizardPlan`, `PlanAction`, `SLACK_VALUES_TITLE`,
  `slackValuesFields`, `subscribeAlertsEarly`, `githubAppSlug`, `readWithProgress`, `releaseCard`,
  `childActionWatcher`, `awsSignInCard`, the hub method `setInstallName`, the card ids
  `"account-checks"`, `"release"` and `"aws-signin"`, and the progress field `githubPending`.
- **Never print a secret.** The Bot User OAuth Token, Signing Secret, Client Secret, GitHub private
  key, OpenRouter key and alert webhook never reach the hub state, a card, a log line, the log file,
  the terminal, an error message, progress or answers. A refused secret field comes back empty.
- **Security rules of spec 040 hold:** loopback only, the session token, origin checks, secrets never
  echoed. The session token never reaches the log file (FR-071).
- **Copy:** plain words from the glossary (FR-080); Slack's own labels as Slack writes them (Client
  ID, Client Secret, Signing Secret, Bot User OAuth Token, Basic Information, OAuth & Permissions,
  Event Subscriptions). Page text never tells the user to pass a flag, run a command or read the
  terminal outside "Stop for now", the lost connection notice and the ready screen (FR-081). **No em
  dashes** in any page text, terminal line, doc, test name, fixture or commit message.
- **Look:** every new screen uses the design system's tokens and classes (`design.ts`); a new class
  is added to `PAGE_CLASSES` and styled there; no inline style, no external asset.
- **Do not touch** `infra/` or any CloudFormation template. The legacy and named template snapshots
  (`tests/contract/__snapshots__/*.snap`) stay byte-identical.
- **Tests:** never `vitest -u`; no assertion removed or weakened. An existing assertion whose
  expected value this phase changes is replaced by the new exact value (never by `toContain` of a
  fragment where `toBe` or `toEqual` stood, never by a looser count).
- **Typecheck ratchet:** `npm run typecheck:all` must not report more errors than the baseline.
- **The gate**, on Node 22: `npm run typecheck:all && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH` (or any
    Node 22.19 or later on PATH).
  - While iterating on one task, run only its test files with `npx vitest run <files>`.
- **No AWS, GitHub or Slack calls from tests.** Every new dependency (`accountAlias`,
  `GitHubApi.owner`, `GitHubApi.appBySlug`, `PrerequisiteChecks.bedrockAvailable`) is injected and
  faked.
- **PRs:** one PR to `mainline`, never stacked, never force-pushed.
- **Build process:** the owner approves this plan, then picks the execution method.

## Review Focus

1. **The Client Secret pasted into the Signing Secret field** (both are 32 lowercase hexadecimal
   characters, and they sit next to each other on Slack's Basic Information page). Expected: the
   form is refused on the field before anything is stored, both secret fields come back empty,
   and neither value is in any state, card or log line. Pinned in Task 12 ("the same value in Client
   Secret and Signing Secret is refused and nothing is stored").
2. **"Change answers" after changing the GitHub owner, with the app name left empty.** Expected: the
   second plan names the new owner's default app name for both apps, every other answer is kept,
   and nothing has been created. Pinned in Task 9 ("Change answers keeps every answer and
   recomputes an app name the user never typed").
3. **GitHub cannot be reached or is rate limited during the owner check** (an office proxy, HTTP
   403). Expected: the check says AgentX could not check the owner and offers Check again; it never
   says the owner does not exist, and the owner's type falls back to its question. Pinned in Task 7
   ("an unreachable GitHub is could not check, never no such owner").
4. **An install whose progress has `access` and `core` done but no GitHub app** (started by a CLI
   that ran the old order). Expected: the resume runs the GitHub step next, skips `access` and
   `core`, and deploys nothing again. Pinned in Task 1 ("a resume of the old order runs the GitHub
   step next and deploys nothing twice").
5. **A release download whose response has no content-length** (a chunked or proxied response).
   Expected: the page shows megabytes received, never "NaN%" or a bar past 100%. Pinned in Task 14
   ("no content-length shows megabytes, never NaN or more than 100").

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/init/ui/journey.ts` | `INSTALL_STEP_ORDER`; the GitHub app in Your choices; developer sign-in needs nobody; new card phases |
| `packages/cli/src/init/commands.ts` | The run order: page first, release, profile, account, region, account checks, settings, answer checks, plan (with Change answers), steps |
| `packages/cli/src/init/prompts.ts` | `FormField` gains choices, section, group; `FormOptions`; the terminal's `askForm` with `ADVANCED_QUESTION` |
| `packages/cli/src/init/ui/protocol.ts` | `WizardField` choices, section, group, link, default; `WizardQuestion.summary` and `submitLabel`; `WizardPlan`; `WizardCard.waitUntil`; new card ids |
| `packages/cli/src/init/ui/prompter.ts` | The page's form: choice checks, initial values, cross-field checks, summary, field links |
| `packages/cli/src/init/ui/page.ts`, `ui/design.ts` | The settings screen (Recommended box, collapsed Advanced, grouped fields, selects), the plan view, countdowns |
| `packages/cli/src/init/settings-form.ts` (new) | The settings as form fields, in order, and the Recommended summary |
| `packages/cli/src/init/answers.ts` | `collectInitAnswers` from the settings values; follow-ups; `WORKER_MODEL_CHOICES`; kept values |
| `packages/cli/src/init/install-state.ts` | Optional `adminEmail`, `signinMethods` answers; optional `githubPending` progress |
| `packages/cli/src/init/aws-account.ts` | The account card before the region, with the alias |
| `packages/cli/src/init/prerequisites.ts` | `checkAccount`; `bedrockAvailable`; `checkPrerequisites` gains `skipAccount` and `extraChecks` |
| `packages/cli/src/init/clash-checks.ts` (new) | Install name used, GitHub owner exists and its type, app name length and clash |
| `packages/cli/src/init/retry.ts` | `checkWithChangeOnPage`: Change answers, Check again, Stop for now |
| `packages/cli/src/init/plan.ts` | `planSummary`, `confirmInstallPlan` returning `PlanAction` |
| `packages/cli/src/init/github-app.ts` | `GitHubApi.owner`, `appBySlug`, `githubAppSlug`; the half-made app on resume |
| `packages/cli/src/setup/alerts.ts`, `init/deploy-steps.ts` | `subscribeAlertsEarly` after the AgentX service deploys |
| `packages/cli/src/init/slack-app.ts` | One form of four values; client values stored with the bot values; approval waits on the page |
| `packages/cli/src/init/signin-step.ts` | Methods from the answers; no question |
| `packages/cli/src/init/release-fetch.ts` | `readWithProgress`; `fetchRelease` reports progress |
| `packages/cli/src/init/ui/child-actions.ts` (new) | `childActionWatcher`: an AWS sign-in address or code a child process prints |
| `packages/cli/src/init/ui/cards.ts` | `accountChecksCard`, `releaseCard`, `awsSignInCard`; account card alias; Slack and GitHub card words |
| `packages/cli/src/init/ui/question-copy.ts` | Page words for every new question, the Advanced settings and the follow-ups |
| `packages/cli/src/init/ui/state.ts`, `ui/index.ts` | `setInstallName`; plan as `WizardPlan` |
| `tests/support/init-fakes.ts`, `tests/support/init-ui-harness.ts`, `tests/support/copy-lint.ts` | Fakes for the new seams; `settingsScript`; scripts in the new order; plan and field linting |
| `tests/contract/init-settings-form.test.ts`, `init-clash-checks.test.ts`, `init-ui-child-actions.test.ts`, `init-ui-order.test.ts` (new) | Tests for the new modules and the order |
| `docs/install.md` | The install page section: the new order, the settings screen, the one Slack visit |

## Interfaces Later Phases Rely On

- **Phase 3 (recovery):** adds failure kinds to `failureScreen` and actions to `askFailureAction`
  and `checkWithChangeOnPage` ("Change the model", "Change the region", "Change the worker image",
  "Open the Bedrock model catalog"); reuses `SETTINGS_FIELD` and `CollectedAnswers.settings` to
  reopen one field; replaces the `waitUntil` countdown's end with "Still there? Keep waiting".
- **Phase 4 (pickers and progress):** fills the build rows from `INSTALL_STEP_ORDER`'s build steps;
  adds the notification beside `pageTitle`; reads `answers.adminEmail` for the admin sign-in card
  and the channel invite.

---

### Task 1: The run order: the GitHub app before the build, developer sign-in needs nobody (FR-031, FR-032, FR-035)

**Files:**
- Modify: `packages/cli/src/init/ui/journey.ts` (`INSTALL_STEP_ORDER`; `STEP_PLAN["github-app"]`, `STEP_PLAN["developer-signin"]`; `CARD_PHASES`; `stepsIn`, `needsYouMinutes`)
- Modify: `packages/cli/src/init/commands.ts:184-203` (`initSteps`)
- Test: `tests/contract/init-ui-journey.test.ts`, `tests/contract/init-steps.test.ts`

**Interfaces:**
- Consumes: phase 1's `STEP_PLAN`, `journeyOf`, `INIT_STEP_IDS`.
- Produces: `INSTALL_STEP_ORDER: readonly InitStepId[]`, in this order: `prerequisites`, `github-app`,
  `access`, `core`, `control-plane`, `slack-app`, `slack-service`, `developer-signin`, `admin-user`,
  `first-project`, `connectors`, `alerts`, `e2e`. `initSteps(...)` returns its steps in this order.
  `STEP_PLAN["github-app"].phase === "your-choices"`; `STEP_PLAN["developer-signin"].needsYou === false`.

The GitHub app needs no stack: `github-app.ts` stores its key with `context.secrets.create` (Secrets
Manager under the caller's own credentials, the account's default key), and `deploy/parameters.ts`
reads the app only for the control-plane stack. So it moves before `access` with no setup of its own
(FR-032's "short setup" is none; say so in the PR description).

- [ ] **Step 1: Write the failing tests**

In `tests/contract/init-ui-journey.test.ts`, the helper builds steps in the run order:

```ts
import { initSteps } from "../../packages/cli/src/init/commands.js";
import { fakeGitHubApi, fakeSlackApi } from "../support/init-fakes.js";
// ...
import {
  INSTALL_STEP_ORDER, JOURNEY_PHASE_IDS, journeyOf, needsYouMinutes, PHASE_TITLES, phaseSeconds, READY_LINE, stageLine, STEP_PLAN, stoppedLine,
  terminalStepLine, totalMinutes, usualText, welcomeLines, type JourneyStepView,
} from "../../packages/cli/src/init/ui/journey.js";

const pending = (): JourneyStepView[] => INSTALL_STEP_ORDER.map((id) => ({ id, status: "pending" as const }));
```

Add:

```ts
describe("spec 048 phase 2: the run order", () => {
  it("FR-031: runs the GitHub app before the build, and lists every step once", () => {
    expect(INSTALL_STEP_ORDER).toEqual([
      "prerequisites", "github-app", "access", "core", "control-plane", "slack-app", "slack-service", "developer-signin",
      "admin-user", "first-project", "connectors", "alerts", "e2e",
    ]);
    expect([...INSTALL_STEP_ORDER].sort()).toEqual([...INIT_STEP_IDS].sort());
    expect(initSteps({ github: fakeGitHubApi(), slack: fakeSlackApi() }).map((step) => step.id)).toEqual([...INSTALL_STEP_ORDER]);
  });

  it("FR-031 and FR-032: the GitHub app is part of Your choices", () => {
    expect(STEP_PLAN["github-app"].phase).toBe("your-choices");
    expect(terminalStepLine("github-app")).toBe("[2/5] Your choices: Create the GitHub app. Waiting for you in the browser.");
  });

  it("FR-035 and SC-006: once the build starts, only Connect Slack and Finish need the user", () => {
    const fromBuild = INSTALL_STEP_ORDER.slice(INSTALL_STEP_ORDER.indexOf("access"));
    for (const id of fromBuild) {
      if (STEP_PLAN[id].needsYou) expect({ id, phase: STEP_PLAN[id].phase }).toMatchObject({ phase: expect.stringMatching(/^(connect-slack|finish)$/) as unknown });
    }
    expect(fromBuild.filter((id) => STEP_PLAN[id].phase === "build").every((id) => !STEP_PLAN[id].needsYou)).toBe(true);
  });

  it("FR-030: turning on developer sign-in asks nothing of the user", () => {
    expect(STEP_PLAN["developer-signin"].needsYou).toBe(false);
    expect(terminalStepLine("developer-signin")).toBe("[4/5] Connect Slack: Turn on developer sign-in (about 2 minutes)");
  });
});
```

Replace phase 1's exact values that this order changes (each with its new exact value):

```ts
  it("gives every step a phase, a plain title and a usual time", () => {
    expect(INSTALL_STEP_ORDER.map((id) => STEP_PLAN[id].title)).toEqual([
      "Check your account and choices", "Create the GitHub app", "Set up AWS permissions", "Build the network and sign-in",
      "Start the AgentX service", "Create the Slack app", "Start the Slack connection", "Turn on developer sign-in",
      "Sign in to AgentX", "Set up your first project", "Connect your issue trackers", "Turn on alerts", "Get a first reply in Slack",
    ]);
    for (const id of INSTALL_STEP_ORDER) expect(STEP_PLAN[id].usualSeconds).toBeGreaterThan(0);
  });

  it("adds the phases up to the total, and says how long the user is needed", () => {
    expect(JOURNEY_PHASE_IDS.reduce((sum, id) => sum + phaseSeconds(id), 0)).toBe(2610);
    expect(phaseSeconds("your-choices")).toBe(450);
    expect(phaseSeconds("build")).toBe(1080);
    expect(totalMinutes()).toBe(44);
    expect(needsYouMinutes()).toBe(23);
    expect(usualText(780)).toBe("usually 13 minutes");
    expect(usualText(30)).toBe("usually under a minute");
  });
```

In "follows the running step", the GitHub app is now done before `access`:

```ts
      steps: withStatus({
        prerequisites: { id: "prerequisites", status: "done" }, "github-app": { id: "github-app", status: "done" },
        access: { id: "access", status: "done" }, core: { id: "core", status: "running", startedAtMs: T - 60_000 },
      }),
    // ...
    // core has 180 of its 240 seconds left, then control-plane (780), then Connect Slack (540) and
    // Finish (420): 1920 seconds.
    expect(view.timeLeftText).toBe("About 32 minutes left");
```

In the welcome test, three lines change:

```ts
      "Your choices: about 8 minutes.",
      "Build in AWS: about 18 minutes.",
      // ...
      "In all, about 44 minutes. You are needed for about 23 of them, and this page tells you when.",
```

(`withStatus` and the `done` list in "shows Stopped" keep `INIT_STEP_IDS` where only the set matters;
the helper `pending` switches to `INSTALL_STEP_ORDER` because `journeyOf` reads the steps in the
order it is given.)

In `tests/contract/init-steps.test.ts` add (Review Focus 4):

```ts
  it("spec 048 phase 2: a resume of the old order runs the GitHub step next and deploys nothing twice", async () => {
    const store = new MemoryParameterStore();
    await writeInstallProgress(store, {
      ...emptyProgress("staging", 0),
      steps: { prerequisites: { status: "done", at: "2026-10-01T00:00:00.000Z" }, access: { status: "done", at: "2026-10-01T00:00:00.000Z" }, core: { status: "done", at: "2026-10-01T00:00:00.000Z" } },
    });
    const ran: string[] = [];
    const step = (id: InitStepId): InitStep<null> => ({ id, title: id, run: async () => { ran.push(id); return { status: "done" }; } });
    const result = await runInitSteps({
      env: "staging", region: "us-east-1", store, holder: HOLDER, context: null, now: () => 1,
      steps: INSTALL_STEP_ORDER.slice(0, 5).map(step),
    });
    expect(ran).toEqual(["github-app", "control-plane"]);
    expect(result).toMatchObject({ status: "complete", skipped: ["prerequisites", "access", "core"] });
  });
```

(Imports: `INSTALL_STEP_ORDER` from `ui/journey.js`; `emptyProgress`, `writeInstallProgress`, `type
InitStepId` from `install-state.js`; `MemoryParameterStore`; `HOLDER` from `init-fakes.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts tests/contract/init-steps.test.ts`
Expected: FAIL: `INSTALL_STEP_ORDER` is not exported; `initSteps` still runs `access` before `github-app`.

- [ ] **Step 3: Write minimal implementation**

In `journey.ts`:

```ts
/** Spec 048 FR-031 and FR-032: the order the steps run in. The GitHub app comes before the long
 * build. INIT_STEP_IDS keeps its own order: it is the progress schema's list, and a done step is
 * skipped by its id wherever it now stands. */
export const INSTALL_STEP_ORDER: readonly InitStepId[] = [
  "prerequisites", "github-app", "access", "core", "control-plane", "slack-app", "slack-service", "developer-signin",
  "admin-user", "first-project", "connectors", "alerts", "e2e",
];

export const STEP_PLAN: Readonly<Record<InitStepId, StepPlan>> = {
  prerequisites: { phase: "your-choices", title: "Check your account and choices", usualSeconds: 30, needsYou: false },
  "github-app": { phase: "your-choices", title: "Create the GitHub app", usualSeconds: 120, needsYou: true },
  access: { phase: "build", title: "Set up AWS permissions", usualSeconds: 60, needsYou: false },
  core: { phase: "build", title: "Build the network and sign-in", usualSeconds: 240, needsYou: false },
  "control-plane": { phase: "build", title: "Start the AgentX service", usualSeconds: 780, needsYou: false },
  "slack-app": { phase: "connect-slack", title: "Create the Slack app", usualSeconds: 240, needsYou: true },
  "slack-service": { phase: "connect-slack", title: "Start the Slack connection", usualSeconds: 180, needsYou: true },
  // FR-030: part of the confirmed plan; it asks nothing (Task 13).
  "developer-signin": { phase: "connect-slack", title: "Turn on developer sign-in", usualSeconds: 120, needsYou: false },
  "admin-user": { phase: "finish", title: "Sign in to AgentX", usualSeconds: 120, needsYou: true },
  "first-project": { phase: "finish", title: "Set up your first project", usualSeconds: 120, needsYou: true },
  connectors: { phase: "finish", title: "Connect your issue trackers", usualSeconds: 60, needsYou: true },
  alerts: { phase: "finish", title: "Turn on alerts", usualSeconds: 60, needsYou: true },
  e2e: { phase: "finish", title: "Get a first reply in Slack", usualSeconds: 60, needsYou: true },
};

const stepsIn = (phase: JourneyPhaseId): InitStepId[] => INSTALL_STEP_ORDER.filter((id) => STEP_PLAN[id].phase === phase);

export function needsYouMinutes(): number {
  const seconds = JOURNEY_PHASE_IDS.reduce((sum, id) => sum + beforeSteps(id), 0)
    + INSTALL_STEP_ORDER.filter((id) => STEP_PLAN[id].needsYou).reduce((sum, id) => sum + STEP_PLAN[id].usualSeconds, 0);
  return toMinutes(seconds);
}
```

and in `CARD_PHASES`, `github: "your-choices"`. The prerequisites card's title follows the step
(`ui/cards.ts` `prerequisitesCard`: `title: STEP_PLAN.prerequisites.title`, so both read "Check your
account and choices").

In `commands.ts`, `initSteps` returns:

```ts
  return [
    { id: "prerequisites", title: STEP_PLAN.prerequisites.title, async run(context) { if (!context.prerequisitesPassed) await context.runPrerequisites(); return { status: "done" }; } },
    githubAppStep(input.github),
    accessStep(),
    deployStep({ id: "core", title: STEP_PLAN.core.title }),
    deployStep({ id: "control-plane", title: STEP_PLAN["control-plane"].title }),
    slackAppStep(input.slack),
    deployStep({ id: "slack-service", title: STEP_PLAN["slack-service"].title, after: verifySlackUrls }),
    developerSignInStep({ slack: input.slack }),
    ...finishSteps(),
  ];
```

- [ ] **Step 4: Update the other expectations of the old order, with new exact values**

`grep -rn '"Check your AWS account"\|github.*build\|--stop-after", "core"\|stop-after core' tests` lists
them. A card or step titled "Check your AWS account" for the prerequisites step becomes "Check your
account and choices"; a test that expected the GitHub card under Build in AWS expects Your choices;
a `--stop-after core` run now also ran `github-app` (its expected `ran` list gains `"github-app"`
before `"access"`). A hub or rail test that lists step ids in order lists them in
`INSTALL_STEP_ORDER`.

- [ ] **Step 5: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts tests/contract/init-steps.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-ui-hub.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init tests
git commit -m "feat(init): create the GitHub app before the build; developer sign-in asks nothing (048 FR-031, FR-032, FR-035)"
```

---

### Task 2: Form fields that are choices, grouped, linked and prefilled (FR-012 for FR-020, FR-021, FR-022, FR-033)

**Files:**
- Modify: `packages/cli/src/init/prompts.ts` (`FormField`, `QuestionHelp`, `FormOptions`, `Prompter.form`, `askForm`, `ADVANCED_QUESTION`)
- Modify: `packages/cli/src/init/ui/protocol.ts` (`WizardField`, `WizardQuestion`)
- Modify: `packages/cli/src/init/ui/prompter.ts` (`form`)
- Test: `tests/contract/init-ui-form.test.ts`, `tests/contract/init-prompts.test.ts`

**Interfaces:**
- Consumes: phase 1's `askForm`, `browserPrompter`, `questionHelp`, `pageHint`, `isShowableLink`, `NEW_TAB_NOTE`.
- Produces:
  - `FormField` gains `choices?: ReadonlyArray<{ value: string; label: string }>`, `section?: "advanced"`, `group?: string`.
  - `QuestionHelp` gains `submitLabel?: string` (a form's forward button) and `linkLabel?: string` (a field's link).
  - `interface FormOptions { help?: QuestionHelp; values?: Readonly<Record<string, string>>; summary?: readonly string[]; crossCheck?: (values: Readonly<Record<string, string>>) => Record<string, string> | undefined }`.
  - `Prompter.form?(title: string, fields: readonly FormField[], options: FormOptions): Promise<Record<string, string>>`; `askForm(prompter, title, fields, options?: FormOptions)`.
  - `ADVANCED_QUESTION = "Change the advanced settings?"` (terminal only).
  - `WizardField` gains `choices?: WizardChoice[]`, `defaultValue?: string`, `section?: "advanced"`, `group?: string`, `link?: WizardLink`; `WizardQuestion` gains `summary?: string[]`, `submitLabel?: string`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-ui-form.test.ts`:

```ts
describe("spec 048 phase 2: richer forms", () => {
  const engine: FormField = { name: "engine", question: "Deploy engine", flag: "--engine", defaultValue: "templates", section: "advanced", choices: [{ value: "templates", label: "Published templates" }, { value: "cdk", label: "From source" }] };
  const email: FormField = { name: "email", question: "Your email", flag: "--admin-email" };
  const signing: FormField = { name: "signing", question: "Signing Secret", flag: "--slack-signing-secret", secret: true };
  const client: FormField = { name: "client", question: "Client Secret", flag: "--slack-client-secret", secret: true };

  it("a choice field takes its default when left empty, and refuses a value it does not list", async () => {
    const hub = createWizardHub("staging");
    const asked = browserPrompter(hub).form?.("Your settings", [email, engine], {}) ?? Promise.reject(new Error("no form"));
    const first = hub.state().question;
    expect(first?.fields?.[1]).toMatchObject({ name: "engine", section: "advanced", defaultValue: "templates", choices: engine.choices });
    expect(hub.answer(first?.id ?? "", JSON.stringify({ email: "a@example.com", engine: "terraform" }))).toBe("Check the field marked below.");
    const second = hub.state().question;
    expect(second?.fields?.find((field) => field.name === "engine")?.error).toBe("choose one of the options");
    expect(second?.fields?.find((field) => field.name === "email")?.value).toBe("a@example.com");
    expect(hub.answer(second?.id ?? "", JSON.stringify({ email: "a@example.com", engine: "" }))).toBeUndefined();
    await expect(asked).resolves.toEqual({ email: "a@example.com", engine: "templates" });
  });

  it("starts from the values it is given, but never prefills a secret", () => {
    const hub = createWizardHub("staging");
    void browserPrompter(hub).form?.("Your Slack app's values", [email, signing], { values: { email: "kept@example.com", signing: "a".repeat(32) } });
    const fields = hub.state().question?.fields ?? [];
    expect(fields.find((field) => field.name === "email")?.value).toBe("kept@example.com");
    expect(fields.find((field) => field.name === "signing")).not.toHaveProperty("value");
    expect(JSON.stringify(hub.snapshot())).not.toContain("a".repeat(32));
  });

  it("a cross-field refusal marks the field, keeps plain values, and empties every secret", () => {
    const hub = createWizardHub("staging");
    const same = "f".repeat(32);
    void browserPrompter(hub).form?.("Your Slack app's values", [email, client, signing], {
      crossCheck: (values) => (values.client === values.signing ? { signing: "This is the Client Secret again. Copy the Signing Secret, just below it." } : undefined),
    });
    const id = hub.state().question?.id ?? "";
    expect(hub.answer(id, JSON.stringify({ email: "a@example.com", client: same, signing: same }))).toBe("Check the field marked below.");
    const fields = hub.state().question?.fields ?? [];
    expect(fields.find((field) => field.name === "signing")?.error).toBe("This is the Client Secret again. Copy the Signing Secret, just below it.");
    expect(fields.find((field) => field.name === "email")?.value).toBe("a@example.com");
    expect(JSON.stringify(hub.snapshot())).not.toContain(same);
  });

  it("carries the summary, the forward button's label, the group and a field's link", () => {
    const hub = createWizardHub("staging");
    void browserPrompter(hub).form?.("Your settings", [{ ...engine, group: "How people sign in", help: { learnMoreUrl: "https://api.slack.com/apps", linkLabel: "Open your Slack apps" } }], {
      summary: ["Models: Claude Sonnet 4.6 on Amazon Bedrock."], help: { submitLabel: "Review the plan" },
    });
    const question = hub.state().question;
    expect(question?.summary).toEqual(["Models: Claude Sonnet 4.6 on Amazon Bedrock."]);
    expect(question?.submitLabel).toBe("Review the plan");
    expect(question?.fields?.[0]).toMatchObject({ group: "How people sign in", link: { url: "https://api.slack.com/apps", label: "Open your Slack apps", note: NEW_TAB_NOTE } });
  });
});
```

Add to `tests/contract/init-prompts.test.ts`:

```ts
describe("spec 048 FR-072: a form in the terminal", () => {
  const fields: FormField[] = [
    { name: "email", question: "Your email", flag: "--admin-email" },
    { name: "engine", question: "Deploy engine", flag: "--engine", defaultValue: "templates", section: "advanced", choices: [{ value: "templates", label: "templates" }, { value: "cdk", label: "cdk" }] },
    { name: "budget", question: "Monthly budget", flag: "--budget", defaultValue: "", section: "advanced" },
  ];

  it("asks the default-path fields, then whether to change the advanced ones; No takes their defaults", async () => {
    const prompter = scriptedPrompter(["a@example.com", false]);
    await expect(askForm(prompter, "Your settings", fields)).resolves.toEqual({ email: "a@example.com", engine: "templates", budget: "" });
    expect(prompter.asked).toEqual(["Your email", ADVANCED_QUESTION]);
  });

  it("Yes asks every advanced field, a choice through choose", async () => {
    const prompter = scriptedPrompter(["a@example.com", true, "cdk", "250"]);
    await expect(askForm(prompter, "Your settings", fields)).resolves.toEqual({ email: "a@example.com", engine: "cdk", budget: "250" });
    expect(prompter.asked).toEqual(["Your email", ADVANCED_QUESTION, "Deploy engine", "Monthly budget"]);
  });

  it("--yes answers every field with its default and still refuses a field with none", async () => {
    await expect(askForm(unattendedPrompter(), "Your settings", fields.slice(1))).resolves.toEqual({ engine: "templates", budget: "" });
    await expect(askForm(unattendedPrompter(), "Your settings", fields)).rejects.toThrow("Your email needs an answer; with --yes, pass --admin-email");
  });

  it("stops on a cross-field refusal, as a refused value does", async () => {
    const same: FormField[] = [{ name: "a", question: "A", flag: "--a" }, { name: "b", question: "B", flag: "--b" }];
    await expect(askForm(scriptedPrompter(["x", "x"]), "Pair", same, { crossCheck: () => ({ b: "B must differ from A" }) })).rejects.toThrow("B must differ from A");
  });
});
```

(`scriptedPrompter`'s `choose` returns the scripted value, `""` taking the default; check
`tests/support/init-fakes.ts` before relying on it. Imports: `askForm`, `ADVANCED_QUESTION`,
`unattendedPrompter`, `type FormField` from `prompts.js`; `NEW_TAB_NOTE` from `ui/state.js`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-form.test.ts tests/contract/init-prompts.test.ts`
Expected: FAIL: `ADVANCED_QUESTION` is not exported; a choice field's value is not checked; no summary.

- [ ] **Step 3: Write minimal implementation**

In `prompts.ts`:

```ts
export interface QuestionHelp {
  // ...phase 1's fields...
  /** form: the forward button's verb, for example "Review the plan" (FR-011). */
  submitLabel?: string;
  /** A field's link label, when `learnMoreUrl` names the page that holds its value (FR-033). */
  linkLabel?: string;
}

/** Spec 048 FR-012: one value of a form. `question` and `flag` are what the terminal asks. */
export interface FormField {
  name: string;
  question: string;
  flag: string;
  defaultValue?: string;
  secret?: boolean;
  validate?: (value: string) => string | undefined;
  help?: QuestionHelp;
  /** FR-021: a choice field. Empty means `defaultValue` (or the first choice). */
  choices?: ReadonlyArray<{ value: string; label: string }>;
  /** FR-021: under "Advanced settings". The page collapses these; the terminal asks them only after
   * ADVANCED_QUESTION. */
  section?: "advanced";
  /** FR-022: a heading several fields share, such as "How people sign in". */
  group?: string;
}

export interface FormOptions {
  help?: QuestionHelp;
  /** Values to start from (Change answers keeps every answer). A secret field is never prefilled. */
  values?: Readonly<Record<string, string>>;
  /** FR-020: the "Recommended settings" lines shown above the fields. */
  summary?: readonly string[];
  /** A check across fields, after each field passes its own: field name to message, or undefined. */
  crossCheck?: (values: Readonly<Record<string, string>>) => Record<string, string> | undefined;
}

export interface Prompter {
  // ...ask, choose, confirm, secret as in phase 1...
  form?(title: string, fields: readonly FormField[], options: FormOptions): Promise<Record<string, string>>;
}

/** FR-072 (Ruling 6): the terminal's one question in front of the Advanced settings. */
export const ADVANCED_QUESTION = "Change the advanced settings?";

const fieldDefault = (field: FormField): string => field.defaultValue ?? field.choices?.[0]?.value ?? "";

async function askField(prompter: Prompter, field: FormField, start: string | undefined): Promise<string> {
  const help = field.help === undefined ? {} : { help: field.help };
  if (field.choices !== undefined) {
    return prompter.choose<string>(field.question, field.choices, { flag: field.flag, defaultValue: start ?? fieldDefault(field), ...help });
  }
  const validate = field.validate === undefined ? {} : { validate: field.validate };
  if (field.secret === true) return prompter.secret(field.question, { flag: field.flag, ...validate, ...help });
  const defaultValue = start ?? field.defaultValue;
  return prompter.ask(field.question, { flag: field.flag, ...(defaultValue === undefined ? {} : { defaultValue }), ...validate, ...help });
}

/** The page's one form, or, with no form on this prompter (the terminal and --yes), the same
 * questions in order: the default-path fields, then ADVANCED_QUESTION, then the advanced ones only
 * on yes. --yes answers yes to every confirm, so it reaches every field and takes its default. */
export async function askForm(prompter: Prompter, title: string, fields: readonly FormField[], options: FormOptions = {}): Promise<Record<string, string>> {
  if (prompter.form !== undefined) return prompter.form(title, fields, options);
  const values: Record<string, string> = {};
  const start = (field: FormField) => (field.secret === true ? undefined : options.values?.[field.name]);
  for (const field of fields.filter((each) => each.section !== "advanced")) values[field.name] = await askField(prompter, field, start(field));
  const advanced = fields.filter((each) => each.section === "advanced");
  const change = advanced.length > 0 && (await prompter.confirm(ADVANCED_QUESTION, { defaultValue: false }));
  for (const field of advanced) values[field.name] = change ? await askField(prompter, field, start(field)) : (start(field) ?? fieldDefault(field));
  const problems = options.crossCheck?.(values);
  const first = problems === undefined ? undefined : Object.values(problems)[0];
  if (first !== undefined) throw agentXError("CONFIG_INVALID", first);
  return values;
}
```

In `protocol.ts`:

```ts
export interface WizardField {
  name: string; label: string; why?: string; example?: string; hint?: string; masked?: boolean; value?: string; error?: string;
  /** A choice field's options and the one an empty answer means. */
  choices?: WizardChoice[];
  defaultValue?: string;
  section?: "advanced";
  group?: string;
  /** Where the value can be copied from (FR-033). */
  link?: WizardLink;
}

export interface WizardQuestion {
  // ...phase 1's fields...
  /** form: "Recommended settings" lines (FR-020). */
  summary?: string[];
  /** form: the forward button's label; "Continue" when absent. */
  submitLabel?: string;
}
```

In `ui/prompter.ts`, `form` becomes:

```ts
    async form(title, fields, options) {
      const help = questionHelp({ kind: "form", text: title, ...(options.help === undefined ? {} : { given: options.help }) });
      const fieldHelp = (field: FormField) => questionHelp({ kind: field.choices !== undefined ? "choose" : field.secret === true ? "secret" : "ask", text: field.question, flag: field.flag, ...(field.help === undefined ? {} : { given: field.help }) });
      const toField = (field: FormField, kept?: string, error?: string): WizardField => {
        const words = fieldHelp(field);
        const hint = field.secret === true || field.choices !== undefined ? undefined : pageHint(field.defaultValue, words);
        const link = words.learnMoreUrl !== undefined && isShowableLink(words.learnMoreUrl)
          ? { url: words.learnMoreUrl, label: words.linkLabel ?? "Learn more", note: NEW_TAB_NOTE } : undefined;
        return {
          name: field.name, label: words.label ?? field.question,
          ...(words.why === undefined ? {} : { why: words.why }),
          ...(words.example === undefined ? {} : { example: words.example }),
          ...(hint === undefined ? {} : { hint }),
          ...(field.secret === true ? { masked: true } : {}),
          ...(field.choices === undefined ? {} : {
            choices: field.choices.map((choice) => ({ value: choice.value, label: words.choiceLabels?.[choice.value] ?? choice.label })),
            defaultValue: field.defaultValue ?? field.choices[0]?.value ?? "",
          }),
          ...(field.section === undefined ? {} : { section: field.section }),
          ...(field.group === undefined ? {} : { group: field.group }),
          ...(link === undefined ? {} : { link }),
          // FR-012: only a plain value is ever sent back to the page, never a secret.
          ...(field.secret !== true && kept !== undefined ? { value: kept } : {}),
          ...(error === undefined ? {} : { error }),
        };
      };
      const plainStart = Object.fromEntries(fields.filter((field) => field.secret !== true && options.values?.[field.name] !== undefined).map((field) => [field.name, options.values?.[field.name] ?? ""]));
      const question = (kept: Record<string, string> = plainStart, errors: Record<string, string> = {}): NewQuestion => ({
        kind: "form", text: title, ...pageFields(help),
        ...(options.summary === undefined ? {} : { summary: [...options.summary] }),
        ...(help.submitLabel === undefined ? {} : { submitLabel: help.submitLabel }),
        fields: fields.map((field) => toField(field, kept[field.name], errors[field.name])),
      });
      const choiceCheck = (field: FormField): AnswerCheck => (raw) => {
        const value = raw.trim() === "" ? field.defaultValue ?? field.choices?.[0]?.value ?? "" : raw.trim();
        return field.choices?.some((choice) => choice.value === value) === true ? { value } : { error: "choose one of the options" };
      };
      const raw = await hub.ask(question(), (posted) => {
        let parsed: unknown;
        try { parsed = JSON.parse(posted); } catch { return { error: "the form could not be read; try again" }; }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "the form could not be read; try again" };
        const given = parsed as Record<string, unknown>;
        const values: Record<string, string> = {};
        const errors: Record<string, string> = {};
        for (const field of fields) {
          const value = typeof given[field.name] === "string" ? (given[field.name] as string) : "";
          const check = field.choices !== undefined ? choiceCheck(field)
            : field.secret === true ? secretCheck(field.question, false, field.validate)
              : askCheck({ ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }), ...(field.validate === undefined ? {} : { validate: field.validate }) });
          const result = check(value);
          if ("error" in result) errors[field.name] = result.error;
          else values[field.name] = result.value;
        }
        if (Object.keys(errors).length === 0) Object.assign(errors, options.crossCheck?.(values) ?? {});
        const refused = Object.keys(errors).length;
        if (refused === 0) return { value: JSON.stringify(values) };
        const kept = Object.fromEntries(fields.filter((field) => field.secret !== true && values[field.name] !== undefined).map((field) => [field.name, values[field.name] ?? ""]));
        return { error: refused === 1 ? "Check the field marked below." : `Check the ${refused} fields marked below.`, retry: question(kept, errors) };
      });
      return JSON.parse(raw) as Record<string, string>;
    },
```

(Imports: `isShowableLink`, `NEW_TAB_NOTE` from `./state.js`; `type FormField` from `../prompts.js`.
`askCheck` with a `defaultValue` of `""` returns `""` for an empty field, which is how an optional
text field such as the budget says "use the computed default".)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-form.test.ts tests/contract/init-prompts.test.ts tests/contract/init-ui-prompter.test.ts`
Expected: PASS (phase 1's form tests still pass: a field with no `choices`, `section` or `group` is
built exactly as before).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/prompts.ts packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/prompter.ts tests/contract/init-ui-form.test.ts tests/contract/init-prompts.test.ts
git commit -m "feat(init): form fields can be choices, grouped, advanced, linked and prefilled (048 FR-012, FR-021)"
```

---

### Task 3: The page draws the settings screen (FR-008, FR-020, FR-021, FR-022)

**Files:**
- Modify: `packages/cli/src/init/ui/page.ts` (`buildForm`, `sendButton`)
- Modify: `packages/cli/src/init/ui/design.ts` (`PAGE_CLASSES`, `WIZARD_CSS`: `recommended`, `advanced`, `group`, `field-link`, select styling)
- Test: `tests/contract/init-ui-page.test.ts`, `tests/contract/init-ui-design.test.ts`

**Interfaces:**
- Consumes: Task 2's `WizardField` (`choices`, `defaultValue`, `section`, `group`, `link`) and `WizardQuestion` (`summary`, `submitLabel`).
- Produces: the page classes `recommended`, `advanced`, `group`, `field-link`, added to `PAGE_CLASSES`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-ui-page.test.ts`:

```ts
describe("spec 048 phase 2: the settings screen", () => {
  it("FR-020: shows the Recommended settings above the fields", () => {
    expect(WIZARD_JS).toContain('el("h3", "", "Recommended settings")');
    expect(WIZARD_JS).toContain("question.summary");
  });

  it("FR-021: puts advanced fields in a collapsed Advanced settings section, opened when one of them is refused", () => {
    expect(WIZARD_JS).toContain('el("details", "advanced")');
    expect(WIZARD_JS).toContain('el("summary", "", "Advanced settings")');
    expect(WIZARD_JS).toContain('(question.fields ?? []).some((each) => each.section === "advanced" && each.error)');
  });

  it("FR-022: groups fields under one heading with a fieldset and legend", () => {
    expect(WIZARD_JS).toContain('el("fieldset", "group")');
    expect(WIZARD_JS).toContain('el("legend", "", field.group)');
  });

  it("FR-008: a choice field is a labelled select that starts on its default", () => {
    expect(WIZARD_JS).toContain('el("select")');
    expect(WIZARD_JS).toContain("input.value = field.value || field.defaultValue || \"\";");
    expect(WIZARD_JS).toContain("label.htmlFor = id;");
  });

  it("FR-011 and FR-037: the forward button carries the form's verb, and a field's link opens in a new tab", () => {
    expect(WIZARD_JS).toContain('sendButton(() => {');
    expect(WIZARD_JS).toContain('question.submitLabel ?? "Continue"');
    expect(WIZARD_JS).toContain('el("a", "field-link", field.link.label)');
  });

  it("every new text the page module holds passes the copy-lint", () => {
    const entries: CopyEntry[] = quotedStrings(WIZARD_JS).map((text) => ({ where: "page module", text, context: "page" }));
    expect(lintCopy(entries)).toEqual([]);
  });
});
```

In `tests/contract/init-ui-design.test.ts`, extend phase 1's "every class the page uses is styled"
check (it reads `PAGE_CLASSES`) by adding the four names to its expected list:

```ts
    for (const name of ["recommended", "advanced", "group", "field-link"]) {
      expect(PAGE_CLASSES).toContain(name);
      expect(WIZARD_CSS).toMatch(new RegExp(`\\.${name}[\\s{.,:]`));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-page.test.ts tests/contract/init-ui-design.test.ts`
Expected: FAIL: the module has no Recommended settings box, no Advanced section, no select.

- [ ] **Step 3: Write minimal implementation**

In `page.ts`'s module text, `sendButton` takes the label, and `buildForm` becomes:

```js
function sendButton(onSend, label) {
  const row = el("div", "buttons");
  const send = el("button", "primary", label ?? "Continue");
  send.type = "button";
  send.addEventListener("click", onSend);
  row.append(send);
  return row;
}

function fieldInput(field, id) {
  if (field.choices) {
    const input = el("select");
    input.id = id;
    for (const choice of field.choices) {
      const option = el("option", "", choice.label);
      option.value = choice.value;
      input.append(option);
    }
    input.value = field.value || field.defaultValue || "";
    return input;
  }
  const input = el("input");
  input.id = id;
  input.type = field.masked ? "password" : "text";
  if (field.masked) hideFromPasswordManagers(input);
  if (field.value && !field.masked) input.value = field.value;
  return input;
}

function buildForm(question, body) {
  if (question.summary && question.summary.length > 0) {
    const box = el("div", "recommended");
    box.append(el("h3", "", "Recommended settings"));
    const list = el("ul");
    for (const line of question.summary) list.append(el("li", "", line));
    box.append(list);
    body.append(box);
  }
  const inputs = [];
  const groups = new Map();
  let advanced = null;
  for (const field of question.fields ?? []) {
    let holder = body;
    if (field.section === "advanced") {
      if (!advanced) {
        advanced = el("details", "advanced");
        advanced.append(el("summary", "", "Advanced settings"));
        advanced.open = (question.fields ?? []).some((each) => each.section === "advanced" && each.error);
        body.append(advanced);
      }
      holder = advanced;
    }
    if (field.group) {
      const key = (field.section ?? "") + "/" + field.group;
      if (!groups.has(key)) {
        const set = el("fieldset", "group");
        set.append(el("legend", "", field.group));
        holder.append(set);
        groups.set(key, set);
      }
      holder = groups.get(key);
    }
    const id = "field-" + field.name;
    const wrap = el("div", "field");
    const label = el("label", "field-label", field.label);
    label.htmlFor = id;
    const input = fieldInput(field, id);
    const notes = [];
    for (const [suffix, text, className] of [["why", field.why, "hint"], ["example", field.example ? "For example: " + field.example : undefined, "hint"], ["hint", field.hint, "hint"], ["error", field.error, "error"]]) {
      if (!text) continue;
      const note = el("p", className, text);
      note.id = id + "-" + suffix;
      notes.push(note);
    }
    if (field.link) {
      const line = el("p", "hint");
      const anchor = el("a", "field-link", field.link.label);
      anchor.href = field.link.url;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      line.append(anchor, " " + (field.link.note ?? ""));
      line.id = id + "-link";
      notes.push(line);
    }
    if (field.error) input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", notes.map((note) => note.id).join(" "));
    wrap.append(label, input, ...notes);
    holder.append(wrap);
    inputs.push([field, input]);
  }
  body.append(sendButton(() => {
    const values = Object.fromEntries(inputs.map(([field, input]) => [field.name, input.value]));
    if (!sending) for (const [field, input] of inputs) if (field.masked) input.value = "";
    submit(question.id, JSON.stringify(values));
  }, question.submitLabel ?? "Continue"));
}
```

(Phase 1's Q4 assertion, `if (field.value && !field.masked) input.value = field.value;`, still holds
inside `fieldInput`.)

In `design.ts`, add the four names to `PAGE_CLASSES` and these rules to `WIZARD_CSS`, tokens only:

```css
.recommended { background: var(--accent-soft); border-radius: 10px; padding: var(--space-4) var(--space-5); margin: 0 0 var(--space-5); }
.recommended h3 { font-size: var(--text-lg); margin: 0 0 var(--space-2); }
.recommended ul { margin: 0; padding-left: var(--space-5); }
.advanced { border-top: 1px solid var(--border); margin-top: var(--space-5); padding-top: var(--space-4); }
.advanced > summary { cursor: pointer; font-weight: 600; min-height: 44px; display: flex; align-items: center; }
.group { border: 1px solid var(--border); border-radius: 10px; padding: var(--space-3) var(--space-4); margin: var(--space-4) 0; }
.group legend { font-weight: 600; padding: 0 var(--space-2); }
.field select { min-height: 44px; width: 100%; border: 1px solid var(--field-border); border-radius: 6px; background: var(--surface); color: var(--text); padding: 0 var(--space-3); font: inherit; }
.field select:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.field-link { color: var(--accent); }
```

- [ ] **Step 4: Run tests to verify they pass, then look at it**

Run: `npx vitest run tests/contract/init-ui-page.test.ts tests/contract/init-ui-design.test.ts`
Expected: PASS.

Then start a faked page run (`npx vitest run tests/contract/init-ui-cli.test.ts -t "FR-020"` once
Task 6 exists, or the phase 1 mockup with a form question) and check in a browser, light and dark,
at 20rem wide: the Recommended box is readable, Advanced settings is closed, a select has a visible
focus ring. This step is a look, not a test.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/page.ts packages/cli/src/init/ui/design.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-design.test.ts
git commit -m "feat(init): the page draws a settings screen with Recommended settings and a collapsed Advanced section (048 FR-020, FR-021, FR-022)"
```

---

### Task 4: The account first, then the region, then the account checks (FR-015, FR-018)

**Files:**
- Modify: `packages/cli/src/init/aws-account.ts` (`resolveCaller`: no region needed, an alias; new `realAccountAlias`)
- Modify: `packages/cli/src/init/prerequisites.ts` (`PrerequisiteChecks.bedrockAvailable`; new `checkAccount`; `checkPrerequisites` gains `skipAccount`; `awsPrerequisiteChecks.bedrockAvailable`)
- Modify: `packages/cli/src/init/ui/cards.ts` (`awsCard`, `rootUserCard` without a region, with the alias; new `accountChecksCard`)
- Modify: `packages/cli/src/init/ui/protocol.ts` (`CardId` gains `"account-checks"`), `ui/journey.ts` (`CARD_PHASES["account-checks"] = "get-started"`)
- Modify: `packages/cli/src/init/ui/question-copy.ts` (the account checks' retry question)
- Modify: `packages/cli/src/init/commands.ts:554-630` (profile, caller, region, account checks, in that order); `InitCliDependencies.accountAlias`
- Modify: `packages/cli/package.json` (`@aws-sdk/client-iam` `3.1134.0`, Ruling 4), `package-lock.json` (by `npm install`)
- Test: `tests/contract/init-aws-account.test.ts`, `tests/contract/init-prerequisites.test.ts`, `tests/contract/init-ui-cli.test.ts`, `tests/contract/init-cli.test.ts`

**Interfaces:**
- Consumes: phase 1's `resolveCaller`, `retryOnPage`, `PrerequisiteCheck`, `CheckAudience`.
- Produces:
  - `resolveCaller(input: { identity; prompter; runner; surface?; profile?; write?; region?: string; alias?: () => Promise<string | undefined> })`.
  - `realAccountAlias(region: string): Promise<string | undefined>` (never throws).
  - `PrerequisiteChecks.bedrockAvailable?(): Promise<boolean>` (optional: a checks object without it skips the check).
  - `checkAccount(input: { region: string; checks: PrerequisiteChecks; write: (line: string) => void; audience?: CheckAudience; onCheck?: (check: PrerequisiteCheck) => void }): Promise<void>`, throwing `init cannot start; nothing was created:` with every account problem.
  - `checkPrerequisites(..., skipAccount?: boolean)`: true leaves out the EC2 vCPU quota and Elastic IPs (already checked).
  - `accountChecksCard(input: { status: "running" | "ok" | "failed"; checks: readonly PrerequisiteCheck[] }): WizardCard` with id `"account-checks"`, title "Check your AWS account".
  - `InitCliDependencies.accountAlias?: () => Promise<string | undefined>`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-prerequisites.test.ts`:

```ts
describe("spec 048 FR-018: the account checks", () => {
  it("collects every account problem together, before any setting is asked", async () => {
    const found: PrerequisiteCheck[] = [];
    await expect(checkAccount({
      region: "us-east-1", write: () => undefined, onCheck: (check) => found.push(check),
      checks: passingChecks({ ec2Quota: async () => 0, elasticIps: async () => ({ quota: 5, allocated: 5 }) }),
    })).rejects.toThrow(/^CONFIG_INVALID: init cannot start; nothing was created:\n- EC2 Standard on-demand vCPU quota in us-east-1 must be at least 1[\s\S]*\n- this environment needs 2 Elastic IPs/);
    expect(found.map((check) => [check.label, check.ok])).toEqual([["EC2 vCPU quota", false], ["Elastic IPs", false]]);
  });

  it("says in page words when Amazon Bedrock is not in the region", async () => {
    const found: PrerequisiteCheck[] = [];
    await expect(checkAccount({
      region: "ap-east-2", write: () => undefined, audience: "page", onCheck: (check) => found.push(check),
      checks: { ...passingChecks(), bedrockAvailable: async () => false },
    })).rejects.toThrow("nothing was created");
    expect(found.at(-1)).toEqual({ label: "Amazon Bedrock", ok: false, detail: "Amazon Bedrock is not available in ap-east-2. Stop for now and start again in a region that has it." });
  });

  it("passes with a check for each, and skips Amazon Bedrock when the checks cannot look", async () => {
    const found: PrerequisiteCheck[] = [];
    await checkAccount({ region: "us-east-1", write: () => undefined, checks: passingChecks(), onCheck: (check) => found.push(check) });
    expect(found.map((check) => check.label)).toEqual(["EC2 vCPU quota", "Elastic IPs"]);
  });

  it("skipAccount leaves the quota and Elastic IPs out of the later checks", async () => {
    const unexpected = async (): Promise<never> => { throw new Error("test setup: the account was already checked"); };
    const found: PrerequisiteCheck[] = [];
    await checkPrerequisites({
      answers: sampleAnswers(), release: coveringRelease(), caller: { account: "123456789012", arn: HOLDER }, prompter: scriptedPrompter([]), write: () => undefined,
      checks: passingChecks({ ec2Quota: unexpected, elasticIps: unexpected }), skipAccount: true, onCheck: (check) => found.push(check),
    });
    expect(found.map((check) => check.label)).not.toContain("EC2 vCPU quota");
  });
});
```

(`coveringRelease` is the release double this file's other `checkPrerequisites` tests already
build; reuse it under its existing name.)

Add to `tests/contract/init-aws-account.test.ts`:

```ts
  it("spec 048 FR-015: shows the account, its alias and who is signed in, before any region is chosen", async () => {
    const cards: WizardCard[] = [];
    const caller = await resolveCaller({
      identity: () => ({ get: async () => ({ account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/dev" }) }),
      prompter: scriptedPrompter([]), runner: neverRuns, surface: { card: (card) => cards.push(card) }, alias: async () => "acme-prod",
    });
    expect(caller.account).toBe("123456789012");
    expect(cards.at(-1)?.lines).toEqual([
      "AgentX installs into AWS account 123456789012 (acme-prod).",
      "You are signed in as Admin (dev).",
      DEDICATED_ACCOUNT_NOTE,
    ]);
  });
```

(`neverRuns` is this file's runner double that throws if called; use the existing one. "You are
signed in as Admin (dev)." is whatever phase 1's `signedInAs` returns for that ARN: copy the exact
value from phase 1's own awsCard test in this file.)

In `tests/contract/init-ui-cli.test.ts`, replace phase 1's two quota tests ("Check the prerequisites
again?" with `quotaReads`, and "saying no to checking again creates nothing") with:

```ts
  it("FR-015 and FR-018: the account checks come before the first setting, and run again after a fix", async () => {
    const h = await harness();
    let quotaReads = 0;
    const checks = passingChecks({ ec2Quota: async () => { quotaReads += 1; return quotaReads === 1 ? 0 : 32; } });
    const operator = fakeWizardOperator([true, ...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, checks })).toBe(0);
    await operator.settled();
    expect(operator.asked[0]).toBe("Check your AWS account again?");
    const cards = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "account-checks") ?? []);
    expect(cards.find((card) => card.status === "failed")?.checks?.map((check) => [check.label, check.ok])).toEqual([["EC2 vCPU quota", false], ["Elastic IPs", true]]);
    expect(cards.at(-1)?.status).toBe("ok");
    // The later checks no longer repeat the account's own.
    const later = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "prerequisites") ?? []).at(-1);
    expect(later?.checks?.map((check) => check.label).slice(0, 3)).toEqual(["Region", "The coding image", "The Slack connection image"]);
    expect(later?.checks?.map((check) => check.label)).not.toContain("EC2 vCPU quota");
  });

  it("FR-018 and SC-009: stopping at the account checks asks no setting and creates nothing", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([false]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, checks: passingChecks({ ec2Quota: async () => 0 }) })).not.toBe(0);
    await operator.settled();
    expect(operator.asked).toEqual(["Check your AWS account again?"]);
    expect(h.printed()).toContain("init cannot start; nothing was created");
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts tests/contract/init-aws-account.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL: `checkAccount` is not exported; the card still names a region; the quota is checked after the settings.

- [ ] **Step 3: Write minimal implementation**

In `prerequisites.ts`, move phase 1's EC2 quota and Elastic IP `try` blocks, unchanged, into one
helper both entry points call, and add Amazon Bedrock:

```ts
export interface PrerequisiteChecks {
  // ...phase 1's methods...
  /** Spec 048 FR-018: false when Amazon Bedrock has no endpoint in the region. Optional: a checks
   * object without it skips the check. */
  bedrockAvailable?(): Promise<boolean>;
}

type Report = { passed: (label: string, line: string) => void; failed: (label: string, problem: string, technical?: string) => void };

async function accountChecks(input: { region: string; checks: PrerequisiteChecks; audience: CheckAudience; bedrock: boolean } & Report): Promise<void> {
  const { region, checks, audience, failed, passed } = input;
  // EC2 vCPU quota: phase 1's try block, moved here unchanged.
  // Elastic IPs: phase 1's try block, moved here unchanged.
  if (input.bedrock && checks.bedrockAvailable !== undefined) {
    try {
      if (await checks.bedrockAvailable()) passed("Amazon Bedrock", `ok Amazon Bedrock answers in ${region}`);
      else failed("Amazon Bedrock", audience === "page"
        ? `Amazon Bedrock is not available in ${region}. Stop for now and start again in a region that has it.`
        : `Amazon Bedrock is not available in ${region}; choose another region with --region`);
    } catch (error) {
      failed("Amazon Bedrock", `could not check Amazon Bedrock in ${region}: ${errorMessage(error)}; check your network`);
    }
  }
}

/** Spec 048 FR-018: what needs only the account and region, right after the region is chosen and
 * before any setting is asked. Every problem is collected and thrown together. */
export async function checkAccount(input: { region: string; checks: PrerequisiteChecks; write: (line: string) => void; audience?: CheckAudience; onCheck?: (check: PrerequisiteCheck) => void }): Promise<void> {
  const problems: string[] = [];
  await accountChecks({
    region: input.region, checks: input.checks, audience: input.audience ?? "terminal", bedrock: true,
    passed: (label, line) => { input.write(line); input.onCheck?.({ label, ok: true, detail: line.replace(/^ok /, "") }); },
    failed: (label, problem, technical) => { problems.push(problem); input.onCheck?.({ label, ok: false, detail: problem, ...(technical === undefined ? {} : { technical }) }); },
  });
  if (problems.length > 0) throw agentXError("CONFIG_INVALID", `init cannot start; nothing was created:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
}
```

`checkPrerequisites` gains `skipAccount?: boolean` and, where phase 1's two blocks stood, calls
`if (input.skipAccount !== true) await accountChecks({ region, checks, audience, bedrock: false, passed, failed });`
(the same position, so the problems' order and every existing message are unchanged; Bedrock is
left to the model checks there, which already name a missing endpoint).

In `awsPrerequisiteChecks`, lift `converse` into a local function so both use it:

```ts
  const converse = (modelId: string) => withDeadline(
    (signal) => bedrock.send(new ConverseCommand({ modelId, messages: [{ role: "user", content: [{ text: "Reply with OK." }] }], inferenceConfig: { maxTokens: 1 } }), { abortSignal: signal }),
    CONVERSE_DEADLINE_MS,
    `${modelId} did not answer a one-token test call in ${input.region} within ${CONVERSE_DEADLINE_MS / 1000}s; check your credentials or network, or try again`,
  ).then(() => undefined);
  return {
    // ...
    converse,
    /** Only a missing endpoint means no Bedrock here; any other refusal is the model checks' to report. */
    async bedrockAvailable() {
      try { await converse(defaultBedrockModel("classifier").modelId); return true; } catch (error) { return !endpointMissing(error); }
    },
```

In `aws-account.ts`:

```ts
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";

/** Spec 048 FR-015: the account's alias, when it has one and the caller may read it. Never throws:
 * an alias is a courtesy on the account card, not a check. */
export async function realAccountAlias(region: string): Promise<string | undefined> {
  try {
    return (await new IAMClient({ region }).send(new ListAccountAliasesCommand({}))).AccountAliases?.[0];
  } catch {
    return undefined;
  }
}
```

`resolveCaller` takes `region?: string` and `alias?: () => Promise<string | undefined>`; before the
root check it reads `const alias = await input.alias?.();` and passes
`{ ...caller, ...(input.region === undefined ? {} : { region: input.region }), ...(alias === undefined ? {} : { alias }), ...(profile === undefined ? {} : { profile: profile.name }) }`
to the cards. In `cards.ts`, `awsCard` and `rootUserCard` take `region?: string; alias?: string`, and
their first line is:

```ts
const whereLine = (input: { account: string; region?: string; alias?: string }): string =>
  `AgentX installs into AWS account ${input.account}${input.alias === undefined ? "" : ` (${input.alias})`}${input.region === undefined ? "" : ` in ${input.region}`}.`;

export function accountChecksCard(input: { status: "running" | "ok" | "failed"; checks: readonly PrerequisiteCheck[] }): WizardCard {
  const lines = input.status === "running"
    ? ["Checking your AWS account and region. Nothing is created yet."]
    : input.status === "ok"
      ? ["Your AWS account and region have what AgentX needs."]
      : ["Nothing has been created. Fix each item marked Not ready, then choose Check again."];
  const technical = input.checks.flatMap((check) => (check.technical === undefined ? [] : [`${check.label}: ${check.technical}`]));
  return {
    id: "account-checks", title: "Check your AWS account", status: input.status, lines,
    checks: input.checks.map((check) => ({ label: check.label, ok: check.ok, detail: check.detail })),
    ...(technical.length === 0 ? {} : { details: technical }),
  };
}
```

In `question-copy.ts`, add:

```ts
  { kind: "confirm", text: /^Check your AWS account again\?$/, help: { label: "Fix the items marked above, then check again", why: "Nothing has been created yet.", yesLabel: "Check again", noLabel: "Stop for now" } },
```

In `commands.ts`, `init()` after the profile pick (phase 1's lines 557-597) becomes, in this order:

```ts
  // FR-015: the account is shown before the region is asked. STS answers in any region, so the
  // caller is read in the region the run already knows, or the AWS configuration's, or us-east-1.
  const identityRegion = options.region ?? bundle?.region ?? configured ?? "us-east-1";
  const surface = session.wizard?.surface;
  const caller = await resolveCaller({
    identity: () => deployDeps.identity ?? stsCallerIdentity(new STSClient({ region: identityRegion })),
    prompter, runner, write,
    alias: deps.accountAlias ?? (() => realAccountAlias(identityRegion)),
    ...(surface === undefined ? {} : { surface }),
    ...(awsProfile === undefined ? {} : { profile: awsProfile }),
  });
  if (options.account !== undefined && options.account !== caller.account) { /* phase 1's refusal, unchanged */ }
  const region = options.region ?? bundle?.region ?? (releaseRegions === undefined
    ? configuredRegion(configured, write)
    : await prompter.choose<string>("AWS region", choices.map((value) => ({ value, label: value })), { flag: "--region", defaultValue: environmentRegion ?? choices[0] ?? "us-east-1" }));
  session.region = region;
  // ...phase 1's bundle-region and release-coverage checks, store, secrets, setPlace, checks, stackStatus, bundle...
  // ...existingSettings, stored, images, and the refusals that read them, unchanged...

  // FR-018: a first run checks the account and region before any setting is asked. On the page a
  // failure is a checklist with Check again; the terminal stops with every problem, as before.
  const runAccountChecks = () => retryOnPage({
    surface, prompter, question: "Check your AWS account again?",
    failed: () => undefined,
    run: async () => {
      const found: PrerequisiteCheck[] = [];
      const show = (status: "running" | "ok" | "failed") => surface?.card(accountChecksCard({ status, checks: found }));
      show("running");
      try {
        await checkAccount({ region, checks, write, audience: surface === undefined ? "terminal" : "page", onCheck: (check) => { found.push(check); show("running"); } });
      } catch (error) {
        if (!found.some((check) => !check.ok)) found.push({ label: "Your AWS account", ok: false, detail: problemText(error) });
        show("failed");
        throw error;
      }
      show("ok");
    },
  });
  if (stored === undefined) await runAccountChecks();
```

Phase 1's later `const surface = session.wizard?.surface;` is removed (it is defined above now).
`runPrerequisites` takes `(options: { skipAccount?: boolean } = {})` and passes
`skipAccount: options.skipAccount === true` to `checkPrerequisites`; the first run calls
`await runPrerequisites({ skipAccount: true })`, and `context.runPrerequisites` stays
`() => runPrerequisites()` (a resume checks everything once more). `InitCliDependencies` gains
`accountAlias?: () => Promise<string | undefined>`, and the shared harnesses
(`tests/support/init-ui-harness.ts`, `init-cli.test.ts`'s own `harness`) set
`accountAlias: async () => undefined` so no test reaches IAM.

Add the dependency: `npm install --workspace @agentx/cli --save-exact @aws-sdk/client-iam@3.1134.0`.

- [ ] **Step 4: Update the other expectations, with new exact values**

`grep -rn "AgentX installs into AWS account" tests` lists the account card's first line: a card shown
before the region now reads `AgentX installs into AWS account 123456789012.` (no "in us-east-1").
`grep -rn "ec2Quota: async () => 0\|elasticIps: async () =>" tests/contract/init-cli.test.ts` lists the
terminal runs whose quota fails: their error text is unchanged, but the settings are no longer asked
first, so a `scriptedPrompter` script for them shrinks to the answers before the account checks
(none, with `--region` given): replace each such script with `[]` and add
`expect(prompter.asked).toEqual([])` where the test holds the prompter.

- [ ] **Step 5: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts tests/contract/init-aws-account.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

```bash
git add packages/cli tests package-lock.json
git commit -m "feat(init): show the account before the region, and check the account before any setting (048 FR-015, FR-018)"
```

---

### Task 5: The install record keeps your email, the developer sign-in choice and a half-made GitHub app

**Files:**
- Modify: `packages/cli/src/init/install-state.ts` (`InitAnswersSchema`, `InstallProgressSchema`)
- Modify: `packages/cli/src/init/steps.ts` (`ProgressPatch` gains `"githubPending"`)
- Test: `tests/contract/init-install-state.test.ts`

**Interfaces:**
- Produces: `InitAnswers.adminEmail?: string` (an email), `InitAnswers.signinMethods?: "slack" | "oidc" | "both"`,
  `InstallProgress.githubPending?: { account: string; appId: string; slug: string }`, and
  `ProgressPatch` accepting `githubPending`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("spec 048 phase 2: the install record", () => {
  it("keeps your email and the developer sign-in choice, and still reads a record without them", async () => {
    const store = new MemoryParameterStore();
    await writeInstallAnswers(store, sampleAnswers({ adminEmail: "alice@example.com", signinMethods: "both" }));
    expect(await readInstallAnswers(store, "staging")).toMatchObject({ adminEmail: "alice@example.com", signinMethods: "both" });
    await writeInstallAnswers(store, sampleAnswers());
    expect(await readInstallAnswers(store, "staging")).not.toHaveProperty("adminEmail");
  });

  it("refuses an email that is not one, and a sign-in choice it does not know", async () => {
    const store = new MemoryParameterStore();
    await expect(writeInstallAnswers(store, sampleAnswers({ adminEmail: "alice" }))).rejects.toThrow("install answers are invalid: adminEmail");
    await expect(writeInstallAnswers(store, { ...sampleAnswers(), signinMethods: "saml" } as unknown as InitAnswers)).rejects.toThrow("install answers are invalid: signinMethods");
  });

  it("FR-032: records a GitHub app made but not yet stored", async () => {
    const store = new MemoryParameterStore();
    await writeInstallProgress(store, { ...emptyProgress("staging", 0), githubPending: { account: "acme", appId: "424242", slug: "agentx-acme-staging" } });
    expect((await readInstallProgress(store, "staging"))?.githubPending).toEqual({ account: "acme", appId: "424242", slug: "agentx-acme-staging" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-install-state.test.ts`
Expected: FAIL: the strict schemas refuse `adminEmail`, `signinMethods` and `githubPending`.

- [ ] **Step 3: Write minimal implementation**

In `InitAnswersSchema`, after `slack`:

```ts
  /** Spec 048 FR-020 and FR-055: your email from the settings, for the admin user and the default alert address. */
  adminEmail: AlertEmailSchema.optional(),
  /** Spec 048 FR-022 and FR-030: how developers sign in, chosen with the settings and turned on with the Slack connection. */
  signinMethods: z.enum(["slack", "oidc", "both"]).optional(),
```

In `InstallProgressSchema`, after `github`:

```ts
  /** Spec 048 FR-032: a GitHub app GitHub has made, recorded before its private key is stored, so a
   * run that stops in between can offer to finish with it or replace it. Read only while `github`
   * is not recorded. */
  githubPending: z.object({ account: z.string().regex(GITHUB_LOGIN_PATTERN), appId: z.string().regex(/^\d+$/), slug: z.string().regex(/^[a-z0-9-]+$/) }).strict().optional(),
```

In `steps.ts`: `export type ProgressPatch = Pick<Partial<InstallProgress>, "github" | "githubPending" | "slack" | "admin" | "project" | "connectors" | "alerts">;`

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-install-state.test.ts tests/contract/init-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/install-state.ts packages/cli/src/init/steps.ts tests/contract/init-install-state.test.ts
git commit -m "feat(init): the install record keeps your email, the developer sign-in choice and a half-made GitHub app (048 FR-020, FR-032)"
```

---

### Task 6: One settings screen: four fields, then Advanced settings (FR-020 to FR-023, FR-025)

**Files:**
- Create: `packages/cli/src/init/settings-form.ts`
- Modify: `packages/cli/src/init/answers.ts` (`collectInitAnswers`, `askPlatformAnswers` becomes `platformFromSettings`; the model choice lists, `GITHUB_APP_NAME_LIMIT` and `budgetProblem` move to `settings-form.ts` and are re-exported here)
- Modify: `packages/cli/src/init/finish-steps.ts:71` (the admin user's email from the answers)
- Modify: `packages/cli/src/init/commands.ts` (`collectInitAnswers` gets `adminEmail`, `signinMethods`, `ownerType`)
- Modify: `packages/cli/src/init/github-app.ts` (`GitHubApi.owner`; `githubRestApi.owner`)
- Modify: `packages/cli/src/init/ui/question-copy.ts` (the form, the install name, the coding model choice, the alert words)
- Modify: `tests/support/init-fakes.ts` (`settingsScript`; `fakeGitHubApi().owner`), `tests/support/init-ui-harness.ts` (`SETTINGS`, `FIRST_RUN`, `FINISH`)
- Create: `tests/contract/init-settings-form.test.ts`
- Test: `tests/contract/init-answers.test.ts`, `tests/contract/init-cli.test.ts`, `tests/contract/init-ui-cli.test.ts`, `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-cost.test.ts`

**Interfaces:**
- Consumes: Task 2's `FormField` and `askForm`; Task 5's `adminEmail` and `signinMethods`; phase 1's `defaultAppName`, `estimateMonthlyCost`, `suggestedBudgetUsd`, `budgetWhy`, `modelPriceLabel`.
- Produces:
  - `SETTINGS_TITLE = "Your settings"`, `SIGN_IN_GROUP = "How people sign in"`.
  - `SETTINGS_FIELD` (the 18 field names below) and `type SettingsFieldName`.
  - `settingsFields(input: { env: string; flags: InitFlags; adminEmail?: string; signinMethods?: "slack" | "oidc" | "both"; fixed: boolean; budgetWhy: string }): FormField[]`.
  - `recommendedSummary(input: { estimateUsd: number; suggestedBudgetUsd: number }): string[]`.
  - `WORKER_MODEL_CHOICES` beside `ORCHESTRATOR_MODEL_CHOICES` and `CLASSIFIER_MODEL_CHOICES` (all now in `settings-form.ts`, re-exported from `answers.ts`).
  - `collectInitAnswers(input: { ...phase 1's; adminEmail?: string; signinMethods?: "slack" | "oidc" | "both"; kept?: Readonly<Record<string, string>>; ownerType?: (login: string) => Promise<"organization" | "user" | undefined> })`; `CollectedAnswers.settings: Record<string, string>` (the form's values, never a secret).
  - `GitHubApi.owner?(login: string): Promise<{ login: string; type: "User" | "Organization" } | undefined>` (undefined: no such owner; throws: GitHub could not say).
  - Test support: `settingsScript(input)` and the harness's `SETTINGS`.

The fields, in order (a field whose flag was typed is left out; `fixed` is an export bundle's resume,
which already decided engine, sign-in, models, boundary and operator):

| Name | Terminal question | Flag | Default | Section |
|---|---|---|---|---|
| `email` | Your email, for your AgentX admin user and alerts | `--admin-email` | none | default path |
| `githubAccount` | GitHub organization or user that will own the AgentX GitHub App | `--github-account` | none | default path |
| `installName` | Install name | `--env` | `--env`'s value | default path |
| `appName` | App name for GitHub and Slack (unique on GitHub) | `--github-app-name` | "" (computed) | default path |
| `engine` | Deploy engine | `--engine` | templates | advanced |
| `identity` | Sign-in | `--identity` | cognito | advanced, How people sign in |
| `signin` | How will developers sign in to AgentX from their AI tools? | `--signin` | slack | advanced, How people sign in |
| `modelProvider` | Model provider | `--model-provider` | amazon-bedrock | advanced |
| `orchestratorModel` | Orchestrator model | `--orchestrator-model` | Claude Sonnet 4.6 | advanced |
| `classifierModel` | Action-gate classifier model | `--classifier-model` | Amazon Nova Lite | advanced |
| `workerModel` | Worker model | `--worker-model` | Claude Sonnet 4.6 | advanced |
| `permissionBoundary` | Permission boundary policy ARN (Enter for AgentX's default boundary) | `--permission-boundary` | "" | advanced |
| `operatorPrincipal` | IAM principal allowed to assume the AgentX operator role (Enter for this account) | `--operator-principal` | "" | advanced |
| `budget` | Monthly AWS budget for this environment, in US dollars (0 for none) | `--budget` | "" (the estimate plus 20%) | advanced |
| `budgetScope` | Which costs should the budget count? | `--budget-scope` | account | advanced |
| `appPostedMessages` | Answer mentions people post through other apps with their own Slack token? | `--slack-app-posted-messages` | accept | advanced |
| `alertKind` | Where should AgentX send alerts? | `ALERT_FLAG` | email | advanced |
| `alertEmail` | Alert email address | `ALERT_FLAG` | "" (your email) | advanced |

(The terminal texts that phase 1 kept are kept word for word, so phase 1's page copy entries still
match them by flag. The two "Enter for" texts are terminal-only: the page shows their copy label.)

- [ ] **Step 1: Write the failing tests**

Create `tests/contract/init-settings-form.test.ts`:

```ts
// Spec 048 FR-020 to FR-023 and FR-025: the settings as one form.
import { describe, expect, it } from "vitest";
import { collectInitAnswers, DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL, defaultAppName } from "../../packages/cli/src/init/answers.js";
import { estimateMonthlyCost, PRICE_NOT_ON_FILE, suggestedBudgetUsd } from "../../packages/cli/src/init/cost.js";
import { recommendedSummary, SETTINGS_FIELD, settingsFields, SIGN_IN_GROUP, WORKER_MODEL_CHOICES } from "../../packages/cli/src/init/settings-form.js";
import { scriptedPrompter, settingsScript } from "../support/init-fakes.js";

const defaults = { orchestrator: DEFAULT_ORCHESTRATOR_MODEL, classifier: DEFAULT_CLASSIFIER_MODEL, worker: DEFAULT_WORKER_MODEL };
const base = { region: "us-east-1", account: "123456789012", releaseVersion: "1.2.3", processEnv: {}, now: () => 0 };

describe("the settings form", () => {
  it("FR-020: asks four things on the default path, and puts every other setting under Advanced", () => {
    const fields = settingsFields({ env: "production", flags: {}, fixed: false, budgetWhy: "" });
    expect(fields.filter((field) => field.section !== "advanced").map((field) => field.name)).toEqual(["email", "githubAccount", "installName", "appName"]);
    expect(fields.filter((field) => field.section === "advanced").map((field) => field.name)).toEqual([
      "engine", "identity", "signin", "modelProvider", "orchestratorModel", "classifierModel", "workerModel",
      "permissionBoundary", "operatorPrincipal", "budget", "budgetScope", "appPostedMessages", "alertKind", "alertEmail",
    ]);
    expect(fields.find((field) => field.name === "installName")?.defaultValue).toBe("production");
  });

  it("FR-021: no Advanced setting is required: each has a choice default or accepts an empty answer", () => {
    for (const field of settingsFields({ env: "production", flags: {}, fixed: false, budgetWhy: "" }).filter((each) => each.section === "advanced")) {
      const optional = field.choices !== undefined ? field.defaultValue !== undefined : field.defaultValue === "" && field.validate?.("") === undefined;
      expect({ field: field.name, optional }).toEqual({ field: field.name, optional: true });
    }
  });

  it("FR-022: asks how the admin and developers sign in under one heading", () => {
    const grouped = settingsFields({ env: "production", flags: {}, fixed: false, budgetWhy: "" }).filter((field) => field.group === SIGN_IN_GROUP);
    expect(grouped.map((field) => field.name)).toEqual(["identity", "signin"]);
  });

  it("leaves out every field a typed flag already answers, and the platform fields for a bundle", () => {
    const names = (flags: Parameters<typeof settingsFields>[0]["flags"], fixed = false) => settingsFields({ env: "staging", flags, fixed, budgetWhy: "" }).map((field) => field.name);
    expect(names({ githubAccount: "acme", engine: "cdk", budget: "300" })).not.toEqual(expect.arrayContaining(["githubAccount", "engine", "budget"]));
    expect(names({ alerts: false })).not.toContain("alertKind");
    expect(names({ modelProvider: "openrouter" })).not.toContain("orchestratorModel");
    expect(names({}, true)).not.toEqual(expect.arrayContaining(["engine", "identity", "installName", "orchestratorModel", "permissionBoundary"]));
  });

  it("FR-020: says the recommended settings in plain words", () => {
    expect(recommendedSummary({ estimateUsd: 211.4, suggestedBudgetUsd: 260 })).toEqual([
      "Models: Claude Sonnet 4.6 on Amazon Bedrock for the main and coding models, Amazon Nova Lite for the safety check.",
      "Sign-in: AgentX's own sign-in for you, Sign in with Slack for developers.",
      "Budget alert: $260 a month for the whole account (the estimate is about $211.40).",
      "Alerts go to: your email.",
    ]);
  });

  it("FR-021 and FR-082: offers the coding model as a choice, every choice priced", () => {
    expect(WORKER_MODEL_CHOICES.map((choice) => choice.value)).toEqual([DEFAULT_WORKER_MODEL, "amazon.nova-pro-v1:0"]);
    for (const choice of WORKER_MODEL_CHOICES) expect(choice.label).not.toContain(PRICE_NOT_ON_FILE);
  });
});

describe("answers from the settings", () => {
  it("FR-020, FR-023 and FR-025: the default path gives the recommended install, alerts to your email", async () => {
    const prompter = scriptedPrompter(settingsScript({ email: "alice@example.com", owner: "acme" }));
    const { answers, settings } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter, ownerType: async () => "organization" });
    expect(answers).toMatchObject({
      env: "staging", engine: "templates", identity: { mode: "cognito" }, models: defaults,
      alert: { kind: "email", address: "alice@example.com" }, adminEmail: "alice@example.com", signinMethods: "slack",
      budget: { monthlyUsd: suggestedBudgetUsd(estimateMonthlyCost(defaults)), scope: "account" },
      github: { account: "acme", accountType: "organization", appName: defaultAppName({ owner: "acme", env: "staging" }) },
      slack: { appName: defaultAppName({ owner: "acme", env: "staging" }), appPostedMessages: "accept" },
    });
    expect(prompter.asked).toEqual([
      "Your email, for your AgentX admin user and alerts", "GitHub organization or user that will own the AgentX GitHub App", "Install name",
      "App name for GitHub and Slack (unique on GitHub)", "Change the advanced settings?",
    ]);
    expect(settings).toMatchObject({ email: "alice@example.com", githubAccount: "acme" });
  });

  it("FR-020: asks the owner's type only when GitHub cannot say", async () => {
    const asked = scriptedPrompter([...settingsScript({ owner: "acme" }), "user"]);
    const { answers } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter: asked, ownerType: async () => undefined });
    expect(asked.asked.at(-1)).toBe("Is acme an organization or a personal account?");
    expect(answers.github.accountType).toBe("user");
  });

  it("FR-023: a budget left empty is the estimate of the models chosen, plus 20%", async () => {
    const glm = "zai.glm-4.7";
    const prompter = scriptedPrompter(settingsScript({ owner: "acme", advanced: { orchestratorModel: glm } }));
    const { answers } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter, ownerType: async () => "organization" });
    expect(answers.budget?.monthlyUsd).toBe(suggestedBudgetUsd(estimateMonthlyCost({ ...defaults, orchestrator: glm })));
  });

  it("FR-025: alerts turned off in Advanced say what is given up", async () => {
    const prompter = scriptedPrompter(settingsScript({ owner: "acme", advanced: { alertKind: "none" } }));
    const { answers, notes } = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter, ownerType: async () => "organization" });
    expect(answers.alert).toEqual({ kind: "none" });
    expect(notes.some((note) => /nobody is told when AgentX fails/.test(note))).toBe(true);
  });

  it("a typed app name names both apps; another install name moves the default", async () => {
    const typed = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter: scriptedPrompter(settingsScript({ owner: "acme", appName: "Our AgentX" })), ownerType: async () => "organization" });
    expect([typed.answers.github.appName, typed.answers.slack.appName]).toEqual(["Our AgentX", "Our AgentX"]);
    const moved = await collectInitAnswers({ ...base, env: "staging", flags: {}, prompter: scriptedPrompter(settingsScript({ owner: "acme", installName: "prod" })), ownerType: async () => "organization" });
    expect(moved.answers.env).toBe("prod");
    expect(moved.answers.github.appName).toBe("AgentX acme (prod)");
  });
});
```

Add to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("FR-020 and FR-021: a first install asks one settings form, and no Advanced setting is needed to reach the plan", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const form = operator.states.map((state) => state.question).find((question) => question?.kind === "form" && question.text === "Your settings");
    expect(form?.fields?.filter((field) => field.section !== "advanced").map((field) => field.label)).toEqual(["Your email", "GitHub owner", "Install name", "App name"]);
    expect(form?.summary).toEqual(recommendedSummary({ estimateUsd: estimateMonthlyCost(DEFAULTS).totalUsd, suggestedBudgetUsd: FIRST_RUN_BUDGET_USD }));
    expect(form?.submitLabel).toBe("Review the plan");
    // The settings form posted only email, owner and the alert address; every other value is a default.
    const answers = JSON.parse(h.store.values.get(installAnswersParameterName("staging")) ?? "{}") as InitAnswers;
    expect(answers).toMatchObject({ engine: "templates", identity: { mode: "cognito" }, adminEmail: ADMIN_EMAIL, signinMethods: "slack", budget: { monthlyUsd: FIRST_RUN_BUDGET_USD, scope: "account" } });
  });
```

(`DEFAULTS` is the three default model ids; the harness already builds them for
`FIRST_RUN_BUDGET_USD`, export them as `DEFAULTS` there.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-settings-form.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL: `settings-form.js` does not exist.

- [ ] **Step 3: Write `settings-form.ts`**

```ts
// packages/cli/src/init/settings-form.ts
// Spec 048 FR-020 to FR-023 and FR-025: the settings as one form. Four fields on the default path
// (your email, the GitHub owner, the install name, the app name for both apps), then every other
// setting under Advanced settings, each with its recommended value. A field whose flag was typed is
// left out: the flag answers it. The page shows the form as one screen; the terminal asks the four,
// then ADVANCED_QUESTION (prompts.ts askForm).
import { DEFAULT_BEDROCK_MODELS } from "@agentx/model-runtime/config";
import { ENVIRONMENT_PLACEHOLDER, EnvironmentNameSchema } from "@agentx/contracts";
import { AlertEmailSchema, GITHUB_LOGIN_PATTERN, MAX_BUDGET_USD } from "../deploy/answer-schemas.js";
import type { InitFlags } from "./answers.js";
import { modelName, modelPriceLabel, money } from "./cost.js";
import type { FormField } from "./prompts.js";
import { ALERT_FLAG } from "./ui/question-copy.js";

export const SETTINGS_TITLE = "Your settings";
export const SIGN_IN_GROUP = "How people sign in";
export const GITHUB_APP_NAME_LIMIT = 34;
export const SLACK_APP_NAME_LIMIT = 35;

export const SETTINGS_FIELD = {
  email: "email", githubAccount: "githubAccount", installName: "installName", appName: "appName",
  engine: "engine", identity: "identity", signin: "signin", modelProvider: "modelProvider",
  orchestratorModel: "orchestratorModel", classifierModel: "classifierModel", workerModel: "workerModel",
  permissionBoundary: "permissionBoundary", operatorPrincipal: "operatorPrincipal",
  budget: "budget", budgetScope: "budgetScope", appPostedMessages: "appPostedMessages", alertKind: "alertKind", alertEmail: "alertEmail",
} as const;
export type SettingsFieldName = (typeof SETTINGS_FIELD)[keyof typeof SETTINGS_FIELD];

const GLM = "zai.glm-4.7";
const HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const NOVA_PRO = "amazon.nova-pro-v1:0";
const DEFAULT = DEFAULT_BEDROCK_MODELS;

export const ORCHESTRATOR_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT.orchestrator, label: `Claude Sonnet 4.6 (recommended; ${modelPriceLabel("orchestrator", DEFAULT.orchestrator)})` },
  { value: GLM, label: `GLM 4.7 (lower cost; ${modelPriceLabel("orchestrator", GLM)})` },
];
export const CLASSIFIER_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT.classifier, label: `Amazon Nova Lite (recommended; ${modelPriceLabel("classifier", DEFAULT.classifier)})` },
  { value: HAIKU, label: `Claude Haiku 4.5 (${modelPriceLabel("classifier", HAIKU)}; needs a one-time Anthropic form in Bedrock)` },
];
/** FR-021: the coding model is a choice too. */
export const WORKER_MODEL_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: DEFAULT.worker, label: `Claude Sonnet 4.6 (recommended; ${modelPriceLabel("worker", DEFAULT.worker)})` },
  { value: NOVA_PRO, label: `Amazon Nova Pro (lower cost; ${modelPriceLabel("worker", NOVA_PRO)})` },
];
const OTHER_MODEL = { value: "other", label: "Another Bedrock model id" };

const ENGINE_CHOICES = [
  { value: "templates", label: "templates: published CloudFormation templates, no CDK setup (recommended)" },
  { value: "cdk", label: "cdk: deploy from AgentX's CDK code at the release tag" },
];
const IDENTITY_CHOICES = [
  { value: "cognito", label: "Create a Cognito user pool for AgentX (recommended)" },
  { value: "oidc", label: "Use your own OIDC provider" },
];
const SIGNIN_CHOICES = [
  { value: "slack", label: "Sign in with Slack (recommended)" },
  { value: "oidc", label: "Your company's sign-in (OIDC)" },
  { value: "both", label: "Both" },
];
const PROVIDER_CHOICES = [{ value: "amazon-bedrock", label: "Amazon Bedrock (recommended)" }, { value: "openrouter", label: "OpenRouter" }];
const BUDGET_SCOPE_CHOICES = [
  { value: "account", label: "The whole account (recommended)" },
  { value: "tag", label: "Only this environment's (tagged agentx:env; the tag must be activated in Billing)" },
];
const POSTED_CHOICES = [{ value: "accept", label: "Yes (accept)" }, { value: "ignore", label: "No, only mentions typed in Slack (ignore)" }];
const ALERT_CHOICES = [
  { value: "email", label: "An email address" },
  { value: "webhook", label: "A PagerDuty or Opsgenie integration address (kept secret)" },
  { value: "none", label: "Nowhere for now" },
];

export const emailProblem = (value: string): string | undefined => (AlertEmailSchema.safeParse(value).success ? undefined : "must be an email address");
const loginProblem = (value: string): string | undefined => (GITHUB_LOGIN_PATTERN.test(value) ? undefined : "must be a GitHub organization or user name");
/** The --env rules of main.ts, on the field: the same schema and the same reserved name. */
export function installNameProblem(value: string): string | undefined {
  if (!EnvironmentNameSchema.safeParse(value).success) return "use lowercase letters, numbers and hyphens, at most 20 characters";
  return value === ENVIRONMENT_PLACEHOLDER ? "that name is reserved; choose another" : undefined;
}
const appNameProblem = (value: string): string | undefined => (value === "" || value.length <= GITHUB_APP_NAME_LIMIT ? undefined : `must be at most ${GITHUB_APP_NAME_LIMIT} characters`);
/** FR-047's budget answer (moved from answers.ts, unchanged). */
export const budgetProblem = (value: string): string | undefined =>
  (/^(0|[1-9][0-9]{0,6})$/.test(value) && Number(value) <= MAX_BUDGET_USD) ? undefined : `must be a whole number of US dollars from 1 to ${MAX_BUDGET_USD}, or 0 for no budget`;
const optionalArn = (pattern: RegExp, what: string) => (value: string): string | undefined => (value === "" || pattern.test(value) ? undefined : `must be ${what}`);
const orEmpty = (check: (value: string) => string | undefined) => (value: string): string | undefined => (value === "" ? undefined : check(value));

export interface SettingsFieldsInput {
  env: string;
  flags: InitFlags;
  /** --admin-email (a finishing-step flag), which answers `email`. */
  adminEmail?: string;
  /** --signin (a developer sign-in flag), which answers `signin`. */
  signinMethods?: "slack" | "oidc" | "both";
  /** An export bundle's resume: engine, sign-in, models, boundary, operator and the name are decided. */
  fixed: boolean;
  /** The budget field's why line (cost.ts budgetWhy of the recommended models). */
  budgetWhy: string;
}

export function settingsFields(input: SettingsFieldsInput): FormField[] {
  const { flags } = input;
  const fields: FormField[] = [];
  const unless = (answered: unknown, field: FormField) => { if (answered === undefined) fields.push(field); };
  const advanced = (field: FormField): FormField => ({ ...field, section: "advanced" });
  const alertAnswered = flags.alerts === false || flags.alertEmail !== undefined || flags.alertWebhook !== undefined ? true : undefined;
  const fixed = input.fixed ? true : undefined;

  unless(input.adminEmail ?? flags.alertEmail, { name: SETTINGS_FIELD.email, question: "Your email, for your AgentX admin user and alerts", flag: "--admin-email", validate: emailProblem });
  unless(flags.githubAccount, { name: SETTINGS_FIELD.githubAccount, question: "GitHub organization or user that will own the AgentX GitHub App", flag: "--github-account", validate: loginProblem });
  unless(fixed, { name: SETTINGS_FIELD.installName, question: "Install name", flag: "--env", defaultValue: input.env, validate: installNameProblem });
  unless(flags.githubAppName, { name: SETTINGS_FIELD.appName, question: "App name for GitHub and Slack (unique on GitHub)", flag: "--github-app-name", defaultValue: "", validate: appNameProblem });

  unless(fixed ?? flags.engine, advanced({ name: SETTINGS_FIELD.engine, question: "Deploy engine", flag: "--engine", defaultValue: "templates", choices: ENGINE_CHOICES }));
  unless(fixed ?? flags.identity, advanced({ name: SETTINGS_FIELD.identity, group: SIGN_IN_GROUP, question: "Sign-in", flag: "--identity", defaultValue: "cognito", choices: IDENTITY_CHOICES }));
  unless(input.signinMethods, advanced({ name: SETTINGS_FIELD.signin, group: SIGN_IN_GROUP, question: "How will developers sign in to AgentX from their AI tools?", flag: "--signin", defaultValue: "slack", choices: SIGNIN_CHOICES }));
  const providerPinned = [flags.modelProvider, flags.orchestratorProvider, flags.classifierProvider, flags.workerProvider, flags.orchestratorModel, flags.classifierModel, flags.workerModel]
    .some((value) => value !== undefined) ? true : undefined;
  unless(fixed ?? providerPinned, advanced({ name: SETTINGS_FIELD.modelProvider, question: "Model provider", flag: "--model-provider", defaultValue: "amazon-bedrock", choices: PROVIDER_CHOICES }));
  const bedrockChoices = flags.modelProvider === undefined || flags.modelProvider === "amazon-bedrock";
  if (bedrockChoices) {
    unless(fixed ?? flags.orchestratorModel ?? flags.orchestratorProvider, advanced({ name: SETTINGS_FIELD.orchestratorModel, question: "Orchestrator model", flag: "--orchestrator-model", defaultValue: DEFAULT.orchestrator, choices: [...ORCHESTRATOR_MODEL_CHOICES, OTHER_MODEL] }));
    unless(fixed ?? flags.classifierModel ?? flags.classifierProvider, advanced({ name: SETTINGS_FIELD.classifierModel, question: "Action-gate classifier model", flag: "--classifier-model", defaultValue: DEFAULT.classifier, choices: [...CLASSIFIER_MODEL_CHOICES, OTHER_MODEL] }));
    unless(fixed ?? flags.workerModel ?? flags.workerProvider, advanced({ name: SETTINGS_FIELD.workerModel, question: "Worker model", flag: "--worker-model", defaultValue: DEFAULT.worker, choices: [...WORKER_MODEL_CHOICES, OTHER_MODEL] }));
  }
  unless(fixed ?? flags.permissionBoundary, advanced({ name: SETTINGS_FIELD.permissionBoundary, question: "Permission boundary policy ARN (Enter for AgentX's default boundary)", flag: "--permission-boundary", defaultValue: "", validate: optionalArn(/^arn:aws[a-z-]*:iam::\d{12}:policy\/.+$/, "an IAM policy ARN") }));
  unless(fixed ?? flags.operatorPrincipal, advanced({ name: SETTINGS_FIELD.operatorPrincipal, question: "IAM principal allowed to assume the AgentX operator role (Enter for this account)", flag: "--operator-principal", defaultValue: "", validate: optionalArn(/^arn:aws[a-z-]*:(iam|sts)::\d{12}:.+$/, "an IAM principal ARN") }));
  unless(flags.budget, advanced({
    name: SETTINGS_FIELD.budget, question: "Monthly AWS budget for this environment, in US dollars (0 for none)", flag: "--budget", defaultValue: "",
    validate: orEmpty(budgetProblem), help: { why: input.budgetWhy, hint: "Optional. Leave empty to use the estimate plus 20%." },
  }));
  unless(flags.budgetScope, advanced({ name: SETTINGS_FIELD.budgetScope, question: "Which costs should the budget count?", flag: "--budget-scope", defaultValue: "account", choices: BUDGET_SCOPE_CHOICES }));
  unless(flags.slackAppPostedMessages, advanced({ name: SETTINGS_FIELD.appPostedMessages, question: "Answer mentions people post through other apps with their own Slack token?", flag: "--slack-app-posted-messages", defaultValue: "accept", choices: POSTED_CHOICES }));
  unless(alertAnswered, advanced({ name: SETTINGS_FIELD.alertKind, question: "Where should AgentX send alerts?", flag: ALERT_FLAG, defaultValue: "email", choices: ALERT_CHOICES }));
  unless(alertAnswered, advanced({ name: SETTINGS_FIELD.alertEmail, question: "Alert email address", flag: ALERT_FLAG, defaultValue: "", validate: orEmpty(emailProblem), help: { hint: "Optional. Leave empty to use your email." } }));
  return fields;
}

/** FR-020: the "Recommended settings" box, in plain words. */
export function recommendedSummary(input: { estimateUsd: number; suggestedBudgetUsd: number }): string[] {
  return [
    `Models: ${modelName(DEFAULT.orchestrator)} on Amazon Bedrock for the main and coding models, ${modelName(DEFAULT.classifier)} for the safety check.`,
    "Sign-in: AgentX's own sign-in for you, Sign in with Slack for developers.",
    `Budget alert: $${input.suggestedBudgetUsd} a month for the whole account (the estimate is about ${money(input.estimateUsd)}).`,
    "Alerts go to: your email.",
  ];
}
```

(Check `DEFAULT_BEDROCK_MODELS.worker` is `"us.anthropic.claude-sonnet-4-6"` before relying on the
label: phase 1's `DEFAULT_WORKER_MODEL` reads it. `installNameProblem`'s message must describe
`EnvironmentNameSchema` exactly; read `packages/contracts` for its pattern and length and correct the
words if they differ.)

- [ ] **Step 4: Rewrite `collectInitAnswers` on the form**

In `answers.ts` the questions phase 1 asked one by one now come from the form's values; only the
follow-ups ask. Re-export what moved: `export { CLASSIFIER_MODEL_CHOICES, GITHUB_APP_NAME_LIMIT, ORCHESTRATOR_MODEL_CHOICES, WORKER_MODEL_CHOICES } from "./settings-form.js";`.

```ts
export interface CollectedAnswers {
  answers: InitAnswers;
  alertWebhook?: string;
  openRouterKey?: string;
  openRouterProviders?: string[];
  notes: string[];
  /** Spec 048 FR-029: the settings form's own values (never a secret), so Change answers starts from them. */
  settings: Record<string, string>;
}

export async function collectInitAnswers(input: {
  env: string; region: string; account: string; releaseVersion: string;
  flags: InitFlags; prompter: Prompter; processEnv: NodeJS.ProcessEnv; now: () => number;
  readFile?: (path: string) => Promise<string>;
  fixed?: BundleAnswers;
  /** --admin-email and --signin, from their own steps' flags: each answers one setting. */
  adminEmail?: string;
  signinMethods?: "slack" | "oidc" | "both";
  /** Change answers: the settings to start from (FR-029). */
  kept?: Readonly<Record<string, string>>;
  /** FR-020: the owner's type, from GitHub; undefined when GitHub cannot say, and then it is asked. */
  ownerType?: (login: string) => Promise<"organization" | "user" | undefined>;
}): Promise<CollectedAnswers> {
  const { flags, prompter } = input;
  const notes: string[] = [];
  const workerImage = digestFlag(flags.workerImage, "--worker-image");
  const slackImage = digestFlag(flags.slackImage, "--slack-image");
  const recommended = estimateMonthlyCost({ orchestrator: DEFAULT_ORCHESTRATOR_MODEL, classifier: DEFAULT_CLASSIFIER_MODEL, worker: DEFAULT_WORKER_MODEL });
  const fields = settingsFields({
    env: input.env, flags, fixed: input.fixed !== undefined, budgetWhy: budgetWhy(recommended),
    ...(input.adminEmail === undefined ? {} : { adminEmail: input.adminEmail }),
    ...(input.signinMethods === undefined ? {} : { signinMethods: input.signinMethods }),
  });
  const values = fields.length === 0 ? {} : await askForm(prompter, SETTINGS_TITLE, fields, {
    summary: recommendedSummary({ estimateUsd: recommended.totalUsd, suggestedBudgetUsd: suggestedBudgetUsd(recommended) }),
    ...(input.kept === undefined ? {} : { values: input.kept }),
  });
  const typed = (name: SettingsFieldName): string | undefined => (values[name] === undefined || values[name] === "" ? undefined : values[name]);
  const env = input.fixed?.env ?? typed(SETTINGS_FIELD.installName) ?? input.env;
  const email = input.adminEmail ?? typed(SETTINGS_FIELD.email) ?? flags.alertEmail;

  let platform: PlatformAnswers;
  let openRouterKey: string | undefined;
  let openRouterProviders: string[] | undefined;
  if (input.fixed === undefined) {
    ({ platform, openRouterKey, openRouterProviders } = await platformFromSettings({ ...input, env }, values));
  } else {
    // phase 1's bundle branch, unchanged
  }
  if (platform.models.orchestrator === GLM) notes.push(GLM_NOTE);
  if (platform.models.classifier === HAIKU) notes.push(HAIKU_NOTE);

  let alert: InitAnswers["alert"] | undefined;
  let alertWebhook: string | undefined;
  const readWebhook = async (source: SecretSource) => checkAlertWebhook(await secretFromSource({
    what: "alert webhook address", flag: "--alert-webhook", source, processEnv: input.processEnv, prompter,
    ...(input.readFile === undefined ? {} : { readFile: input.readFile }),
  }));
  if (flags.alerts === false) {
    alert = { kind: "none" };
  } else if (flags.alertEmail !== undefined) {
    if (emailProblem(flags.alertEmail) !== undefined) throw agentXError("CONFIG_INVALID", `--alert-email ${flags.alertEmail} is not an email address`);
    alert = { kind: "email", address: flags.alertEmail };
  } else if (flags.alertWebhook !== undefined) {
    alertWebhook = await readWebhook(flags.alertWebhook);
  } else {
    const kind = values[SETTINGS_FIELD.alertKind] ?? "email";
    if (kind === "webhook") alertWebhook = await readWebhook({});
    else if (kind === "none") alert = { kind: "none" };
    else {
      // FR-025: alerts are on by default, to your email.
      const address = typed(SETTINGS_FIELD.alertEmail) ?? email;
      if (address === undefined) throw agentXError("CONFIG_INVALID", "alerts need an email address; pass --alert-email <address>, or --no-alerts");
      alert = { kind: "email", address };
    }
  }
  if (alertWebhook !== undefined) alert = { kind: "webhook", display: webhookDisplay(alertWebhook), secretName: alertWebhookSecretName(env) };
  if (alert === undefined) throw new Error("unreachable: every alert branch sets alert");
  if (alert.kind === "none") notes.push(NO_ALERTS_NOTE);

  // FR-023: an empty budget is the estimate of the models actually chosen, plus 20%.
  const estimate = estimateMonthlyCost(platform.models);
  const rawBudget = flags.budget ?? typed(SETTINGS_FIELD.budget) ?? String(suggestedBudgetUsd(estimate));
  const budgetIssue = budgetProblem(rawBudget);
  if (budgetIssue !== undefined) throw agentXError("CONFIG_INVALID", `--budget ${budgetIssue}`);
  let budget: InitAnswers["budget"];
  if (Number(rawBudget) > 0) {
    const scope = flags.budgetScope ?? (values[SETTINGS_FIELD.budgetScope] === "tag" ? "tag" : "account");
    budget = { monthlyUsd: Number(rawBudget), scope };
    if (scope === "tag") notes.push(BUDGET_TAG_NOTE);
  }

  const githubAccount = flags.githubAccount ?? typed(SETTINGS_FIELD.githubAccount) ?? "";
  if (!GITHUB_LOGIN_PATTERN.test(githubAccount)) throw agentXError("CONFIG_INVALID", `--github-account ${githubAccount} is not a GitHub organization or user name`);
  const accountType = flags.githubAccountType ?? (await input.ownerType?.(githubAccount)) ?? (await prompter.choose<"organization" | "user">(`Is ${githubAccount} an organization or a personal account?`, [
    { value: "organization", label: "An organization" },
    { value: "user", label: "A personal account" },
  ], { flag: "--github-account-type", defaultValue: "organization" }));
  // FR-020 and FR-026: one name for both apps; empty is the default pattern for this owner and name.
  const appName = flags.githubAppName ?? typed(SETTINGS_FIELD.appName) ?? defaultAppName({ owner: githubAccount, env });
  const slackAppName = flags.slackAppName ?? appName;
  const appPostedMessages = flags.slackAppPostedMessages ?? (values[SETTINGS_FIELD.appPostedMessages] === "ignore" ? "ignore" : "accept");
  const signinValue = values[SETTINGS_FIELD.signin];
  const signinMethods = input.signinMethods ?? (signinValue === "oidc" || signinValue === "both" ? signinValue : "slack");

  const answers: InitAnswers = {
    schemaVersion: 1,
    env, region: input.region, account: input.account, engine: platform.engine, releaseVersion: input.releaseVersion,
    identity: platform.identity, models: platform.models,
    ...(platform.permissionsBoundaryArn === undefined ? {} : { permissionsBoundaryArn: platform.permissionsBoundaryArn }),
    ...(platform.operatorPrincipalArn === undefined ? {} : { operatorPrincipalArn: platform.operatorPrincipalArn }),
    ...(workerImage === undefined && slackImage === undefined ? {} : { images: { ...(workerImage === undefined ? {} : { worker: workerImage }), ...(slackImage === undefined ? {} : { slack: slackImage }) } }),
    alert,
    ...(budget === undefined ? {} : { budget }),
    github: { account: githubAccount, accountType, appName },
    slack: { appName: slackAppName, appPostedMessages },
    ...(email === undefined ? {} : { adminEmail: email }),
    signinMethods,
    createdAt: new Date(input.now()).toISOString(),
  };
  return {
    answers, notes, settings: { ...values },
    ...(alertWebhook === undefined ? {} : { alertWebhook }),
    ...(openRouterKey === undefined ? {} : { openRouterKey, ...(openRouterProviders === undefined ? {} : { openRouterProviders }) }),
  };
}
```

`platformFromSettings(input, values)` is phase 1's `askPlatformAnswers` with each asked value read
from `values` first:

```ts
  const engine = flags.engine ?? (values[SETTINGS_FIELD.engine] === "cdk" ? "cdk" : "templates");
  const identityMode = flags.identity ?? (values[SETTINGS_FIELD.identity] === "oidc" ? "oidc" : "cognito");
  // the OIDC follow-ups (issuer, audience, client id, admin claim, admin values): phase 1's asks, unchanged
  const allProvider = flags.modelProvider ?? (providerFlagGiven || modelFlagGiven ? "amazon-bedrock" : values[SETTINGS_FIELD.modelProvider] ?? "amazon-bedrock");
  /** A Bedrock model from the form: its value, its default when empty, or a follow-up for "other". */
  const fromForm = async (name: SettingsFieldName, question: string, flag: string, fallback: string): Promise<string> => {
    const picked = values[name];
    if (picked === "other") return prompter.ask(`${question} id`, { flag });
    return picked === undefined || picked === "" ? fallback : picked;
  };
  const orchestrator = providers.orchestrator === "openrouter"
    ? flags.orchestratorModel ?? await prompter.ask("OpenRouter orchestrator model id", { flag: "--orchestrator-model" })
    : flags.orchestratorModel ?? await fromForm(SETTINGS_FIELD.orchestratorModel, "Orchestrator model", "--orchestrator-model", DEFAULT_ORCHESTRATOR_MODEL);
  const classifier = providers.classifier === "openrouter"
    ? flags.classifierModel ?? await prompter.ask("OpenRouter classifier model id", { flag: "--classifier-model" })
    : flags.classifierModel ?? await fromForm(SETTINGS_FIELD.classifierModel, "Action-gate classifier model", "--classifier-model", DEFAULT_CLASSIFIER_MODEL);
  const worker = providers.worker === "openrouter"
    ? flags.workerModel ?? await prompter.ask("OpenRouter worker model id", { flag: "--worker-model" })
    : flags.workerModel ?? await fromForm(SETTINGS_FIELD.workerModel, "Worker model", "--worker-model", DEFAULT_WORKER_MODEL);
  // the OpenRouter key, providers and ModelsAnswersSchema checks: phase 1's, unchanged
  const boundary = flags.permissionBoundary ?? values[SETTINGS_FIELD.permissionBoundary] ?? "";
  const operator = flags.operatorPrincipal ?? values[SETTINGS_FIELD.operatorPrincipal] ?? "";
```

(`input.env` passed in is the install name from the form, so the stand-in OpenRouter ARN names the
right environment.)

In `finish-steps.ts`, the admin user's email: `recorded?.username ?? context.flags.adminEmail ?? context.answers.adminEmail ?? await context.prompter.ask(...)`
(phase 1's question stays, for an install recorded before this phase that has no `adminEmail`).

In `commands.ts`, the call passes the three new inputs:

```ts
    collected = await collectInitAnswers({
      env, region, account: caller.account, releaseVersion: release.manifest.version, flags: options.flags, prompter, processEnv, now,
      ...(bundle === undefined ? {} : { fixed: bundle }),
      ...(options.finishFlags.adminEmail === undefined ? {} : { adminEmail: options.finishFlags.adminEmail }),
      ...(options.signinFlags?.methods === undefined ? {} : { signinMethods: options.signinFlags.methods }),
      ownerType: async (login) => {
        try {
          const owner = await github.owner?.(login);
          return owner === undefined ? undefined : owner.type === "Organization" ? "organization" : "user";
        } catch {
          return undefined; // GitHub could not say: the type is asked (Review Focus 3)
        }
      },
    });
```

(`github` is the `deps.github ?? githubRestApi(fetchImplementation)` value `initSteps` already gets;
hold it in a `const github` above the `initSteps` call and pass it to both.)

In `github-app.ts`:

```ts
export interface GitHubApi {
  // ...phase 1's methods...
  /** Spec 048 FR-020 and FR-028: a public lookup of an owner. undefined: GitHub has no such owner.
   * Throws when GitHub could not answer (network, rate limit). Optional: a client without it skips. */
  owner?(login: string): Promise<{ login: string; type: "User" | "Organization" } | undefined>;
}

// in githubRestApi, beside `call`:
  const lookup = async (what: string, path: string): Promise<unknown> => {
    const response = await fetchImplementation(`${API}${path}`, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agentx-cli" } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub ${what} failed with HTTP ${response.status}`);
    return response.json();
  };
  // ...
    async owner(login) {
      const found = (await lookup("owner lookup", `/users/${encodeURIComponent(login)}`)) as { login?: string; type?: string } | undefined;
      return found === undefined ? undefined : { login: found.login ?? login, type: found.type === "Organization" ? "Organization" : "User" };
    },
```

In `question-copy.ts`, add (and change the two existing alert entries as shown):

```ts
  { kind: "form", text: /^Your settings$/, help: { label: "Your settings", why: "Answer these four. Everything else has a recommended value you can change under Advanced settings.", submitLabel: "Review the plan" } },
  { kind: "ask", flag: "--env", help: { label: "Install name", why: "Names this install in AWS, GitHub and Slack, so one account can hold more than one.", example: "production" } },
  { kind: "choose", flag: "--worker-model", help: { label: "Coding model", why: "The coding model writes and tests code in your repositories." } },
  { kind: "choose", text: /^Is .+ an organization or a personal account\?$/, flag: "--github-account-type", help: { label: "Is it an organization or a personal account?", why: "GitHub could not tell AgentX, and keeps apps in a different place for each.", choiceLabels: { organization: "An organization", user: "A personal account" } } },
  // phase 1's ALERT_FLAG choose entry, with FR-025's sentence on what turning alerts off gives up:
  { kind: "choose", flag: ALERT_FLAG, help: { label: "Where should AgentX send alerts?", why: "AgentX tells you here when something stops working.", choiceLabels: { email: "An email address (recommended)", webhook: "A PagerDuty or Opsgenie address (kept secret)", none: "Nowhere for now. Nobody is told when AgentX stops working." } } },
  // phase 1's ALERT_FLAG ask entry, with the hint the field now carries:
  { kind: "ask", flag: ALERT_FLAG, help: { label: "Alert email address", why: "AWS sends a confirmation email here first. Confirm it to start getting alerts.", example: "ops@example.com", hint: "Optional. Leave empty to use your email." } },
```

and change three existing entries' words: `--admin-email`'s why to "AgentX makes your admin sign-in
with it, and sends alerts here unless you choose otherwise."; `--github-app-name`'s label stays
"App name" with hint "Optional. Leave empty to use AgentX, your GitHub owner and the install name.";
`--budget`'s label stays, with no hint of its own (the field's help carries it).

- [ ] **Step 5: Scripts in the new order**

In `tests/support/init-fakes.ts`, `fakeGitHubApi` gains (its local `owner` keeps its name):

```ts
    async owner(login) { return login.toLowerCase() === owner.login.toLowerCase() ? { login: owner.login, type: owner.type === "User" ? "User" : "Organization" } : undefined; },
```

and add:

```ts
/** Spec 048 phase 2: a terminal run's settings answers, in the form's own order. Without `advanced`
 * the run says no to "Change the advanced settings?"; with it, yes, and these values (every other
 * advanced field takes its default). */
export function settingsScript(input: {
  email?: string; owner?: string; installName?: string; appName?: string;
  advanced?: Partial<Record<SettingsFieldName, string>>; flags?: InitFlags; env?: string; adminEmail?: string; fixed?: boolean;
} = {}): ScriptedAnswer[] {
  const fields = settingsFields({ env: input.env ?? "staging", flags: input.flags ?? {}, fixed: input.fixed === true, budgetWhy: "", ...(input.adminEmail === undefined ? {} : { adminEmail: input.adminEmail }) });
  const basic: Record<string, string> = { email: input.email ?? "ops@example.com", githubAccount: input.owner ?? "acme", installName: input.installName ?? "", appName: input.appName ?? "" };
  const answers: ScriptedAnswer[] = fields.filter((field) => field.section !== "advanced").map((field) => basic[field.name] ?? "");
  const advanced = fields.filter((field) => field.section === "advanced");
  if (advanced.length === 0) return answers;
  if (input.advanced === undefined) return [...answers, false];
  return [...answers, true, ...advanced.map((field) => input.advanced?.[field.name as SettingsFieldName] ?? "")];
}
```

In `tests/support/init-ui-harness.ts`, the page posts the settings as one form; the finishing steps
no longer ask the admin email:

```ts
/** The settings form: your email (the admin user), the owner, and alerts to the ops address. */
export const SETTINGS = JSON.stringify({ email: ADMIN_EMAIL, githubAccount: "acme", alertEmail: "ops@example.com" });
export const FIRST_RUN = [SETTINGS, true];
export const FINISH = ["acme/payments-api", "", true, "payments", false, false, false, true];
```

In `tests/contract/init-cli.test.ts`:
`const FIRST_RUN = [...settingsScript({ email: ADMIN_EMAIL, owner: "acme", advanced: { alertEmail: "ops@example.com" } }), true];`
and its `FINISH` drops its leading `ADMIN_EMAIL` the same way.

Then go through every `collectInitAnswers` and `scriptedPrompter([...])` script of a first run in
`tests/contract/init-answers.test.ts`, `init-cli.test.ts`, `init-ui-cli.test.ts`,
`init-plan.test.ts` and `init-signin-step.test.ts` (`grep -n 'scriptedPrompter(\[""' tests/contract`):
each positional script becomes `settingsScript({ ... })` with the same answers by name (for example
phase 1's `["", "", "", "", "", "", "", "", "", "ops@example.com", "", "", "acme", ...]` is
`settingsScript({ owner: "acme", advanced: { alertEmail: "ops@example.com" } })`; a script that chose
GLM is `advanced: { orchestratorModel: "zai.glm-4.7" }`; one that answered the Slack app name
question separately now passes `--slack-app-name` or expects the one shared name). Every expected
value stays as it was, except the seven deliberate changes in Global Constraints; an
`asked` list is replaced by the new exact list of questions.

- [ ] **Step 6: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-settings-form.test.ts tests/contract/init-answers.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-plan.test.ts tests/contract/init-cost.test.ts tests/contract/init-ui-question-copy.test.ts tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init tests
git commit -m "feat(init): one settings screen of four fields, with every other setting under Advanced (048 FR-020 to FR-023, FR-025)"
```

---

### Task 7: Every answer that can fail late is checked before anything is created (FR-028, FR-065, SC-009)

**Files:**
- Create: `packages/cli/src/init/clash-checks.ts`
- Modify: `packages/cli/src/init/github-app.ts` (`GitHubApi.appBySlug`, `githubAppSlug`, `githubRestApi.appBySlug`)
- Modify: `packages/cli/src/init/prerequisites.ts` (`checkPrerequisites` gains `extraChecks`)
- Modify: `packages/cli/src/init/retry.ts` (`checkWithChangeOnPage`)
- Modify: `packages/cli/src/init/commands.ts` (the first run's checks pass `extraChecks`; a loop back to the settings on Change answers)
- Modify: `packages/cli/src/init/ui/question-copy.ts` (the three actions)
- Modify: `tests/support/init-fakes.ts` (`fakeGitHubApi().appBySlug`)
- Create: `tests/contract/init-clash-checks.test.ts`
- Test: `tests/contract/init-retry.test.ts`, `tests/contract/init-ui-cli.test.ts`, `tests/contract/init-cli.test.ts`

**Interfaces:**
- Consumes: Task 6's `GitHubApi.owner`, `GITHUB_APP_NAME_LIMIT`, `SLACK_APP_NAME_LIMIT`, `CollectedAnswers.settings`, `collectInitAnswers({ kept })`; Task 4's `skipAccount`.
- Produces:
  - `GitHubApi.appBySlug?(slug: string): Promise<{ owner: { login: string } } | undefined>`; `githubAppSlug(name: string): string`.
  - `clashChecks(input: { answers: InitAnswers; stackStatus: StackStatusReader; github: GitHubApi; audience: CheckAudience; installUsed: (env: string) => Promise<boolean> }): Promise<PrerequisiteCheck[]>`, labels `"Install name"`, `"GitHub owner"`, `"App name"`, in that order.
  - `checkPrerequisites(..., extraChecks?: () => Promise<readonly PrerequisiteCheck[]>)`, run right after the image checks.
  - `checkWithChangeOnPage(input: { surface; prompter; question: string; run: () => Promise<void>; failed: (problem: string) => void }): Promise<"passed" | "change">`.

The FR-065 list and where each item is checked, all before anything is created:

| FR-065 item | Checked by | When |
|---|---|---|
| region support | `checkPrerequisites` (phase 1, templates engine) | after the settings |
| EC2 vCPU quota, Elastic IPs, Amazon Bedrock in the region | `checkAccount` (Task 4) | right after the region |
| model access, the Anthropic first-use form | `checkPrerequisites` (phase 1's model checks) | after the settings |
| the release's image references | `checkPrerequisites` (phase 1's `releaseImageChecks`) | after the settings |
| name lengths | the settings field (`appNameProblem`, `installNameProblem`) and `clashChecks` "App name" (a flag's value) | on the field, and after the settings |
| clashing stacks or installs, clashing apps | `clashChecks` "Install name" and "App name" | after the settings |
| the GitHub owner | `clashChecks` "GitHub owner" | after the settings |
| the budget value, the email address | the settings field validators, and the flag checks in `collectInitAnswers` | on the field |

- [ ] **Step 1: Write the failing tests**

Create `tests/contract/init-clash-checks.test.ts`:

```ts
// Spec 048 FR-028 and FR-065: the install name, the GitHub owner and the app name, checked before
// anything is created.
import { describe, expect, it } from "vitest";
import { environmentStackName } from "@agentx/contracts";
import { clashChecks } from "../../packages/cli/src/init/clash-checks.js";
import { githubAppSlug } from "../../packages/cli/src/init/github-app.js";
import { fakeGitHubApi, sampleAnswers } from "../support/init-fakes.js";

const nothing = { status: async () => undefined };
const free = async () => false;

describe("clash checks", () => {
  it("passes a free name, an existing owner of the right type and a free app name", async () => {
    const checks = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: fakeGitHubApi(), audience: "page", installUsed: free });
    expect(checks.map((check) => [check.label, check.ok])).toEqual([["Install name", true], ["GitHub owner", true], ["App name", true]]);
  });

  it("refuses an install name that already has a stack here, naming the stacks only in the details", async () => {
    const stack = environmentStackName("staging", "access");
    const [name] = await clashChecks({ answers: sampleAnswers(), stackStatus: { status: async (each) => (each === stack ? "CREATE_COMPLETE" : undefined) }, github: fakeGitHubApi(), audience: "page", installUsed: free });
    expect(name).toEqual({ label: "Install name", ok: false, detail: "This AWS account and region already have an AgentX install named staging. Choose another install name.", technical: stack });
  });

  it("refuses an owner GitHub does not have, and the wrong owner type", async () => {
    const missing = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: { ...fakeGitHubApi(), owner: async () => undefined }, audience: "page", installUsed: free });
    expect(missing[1]).toEqual({ label: "GitHub owner", ok: false, detail: "GitHub has no organization or user named acme. Check the spelling." });
    const wrongType = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: fakeGitHubApi({ ownerType: "User" }), audience: "page", installUsed: free });
    expect(wrongType[1]).toEqual({ label: "GitHub owner", ok: false, detail: "acme is a personal GitHub account, not an organization. Change the answer." });
  });

  it("Review Focus 3: an unreachable GitHub is could not check, never no such owner", async () => {
    const offline = { ...fakeGitHubApi(), owner: async () => { throw new Error("GitHub owner lookup failed with HTTP 403"); } };
    const [, owner] = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: offline, audience: "page", installUsed: free });
    expect(owner).toEqual({ label: "GitHub owner", ok: false, detail: "AgentX could not reach GitHub to check acme. Check your network, then check again.", technical: "GitHub owner lookup failed with HTTP 403" });
    expect(owner?.detail).not.toMatch(/has no organization/);
  });

  it("refuses an app name too long for GitHub or Slack, and one GitHub already has", async () => {
    const long = sampleAnswers({ github: { account: "acme", accountType: "organization", appName: "x".repeat(35) } });
    expect((await clashChecks({ answers: long, stackStatus: nothing, github: fakeGitHubApi(), audience: "page", installUsed: free }))[2]?.ok).toBe(false);
    const taken = await clashChecks({ answers: sampleAnswers(), stackStatus: nothing, github: { ...fakeGitHubApi(), appBySlug: async () => ({ owner: { login: "someone-else" } }) }, audience: "page", installUsed: free });
    expect(taken[2]).toEqual({ label: "App name", ok: false, detail: "GitHub already has an app named AgentX acme (staging). Choose another app name.", technical: "agentx-acme-staging" });
  });

  it("names the slug as GitHub makes it", () => {
    expect(githubAppSlug("AgentX acme (staging)")).toBe("agentx-acme-staging");
    expect(githubAppSlug("Our  AgentX!")).toBe("our-agentx");
  });
});
```

Add to `tests/contract/init-retry.test.ts`:

```ts
describe("spec 048 FR-028: a failed check on the page offers Change answers", () => {
  it("returns change, runs again on Check again, and stops on Stop for now", async () => {
    let runs = 0;
    const failing = async () => { runs += 1; throw new Error("GitHub has no organization or user named acmee"); };
    const surface = { card: () => undefined };
    await expect(checkWithChangeOnPage({ surface, prompter: scriptedPrompter(["change"]), question: "Your answers need a change. What next?", run: failing, failed: () => undefined })).resolves.toBe("change");
    await expect(checkWithChangeOnPage({ surface, prompter: scriptedPrompter(["retry", "stop"]), question: "Your answers need a change. What next?", run: failing, failed: () => undefined })).rejects.toSatisfy(isOperatorStop);
    expect(runs).toBe(3);
  });

  it("without a page throws the first failure, asking nothing", async () => {
    const prompter = scriptedPrompter([]);
    await expect(checkWithChangeOnPage({ surface: undefined, prompter, question: "q", run: async () => { throw new Error("no"); }, failed: () => undefined })).rejects.toThrow("no");
    expect(prompter.asked).toEqual([]);
  });
});
```

Add to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("FR-028: an answer check that fails offers Change answers, and the settings come back with every answer kept", async () => {
    const h = await harness();
    const github = { ...fakeGitHubApi(), owner: async (login: string) => (login === "acme" ? { login: "acme", type: "Organization" as const } : undefined) };
    const wrong = JSON.stringify({ email: ADMIN_EMAIL, githubAccount: "acmee", alertEmail: "ops@example.com" });
    const operator = fakeWizardOperator([wrong, "organization", "change", SETTINGS, true, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, github })).toBe(0);
    await operator.settled();
    const forms = operator.states.map((state) => state.question).filter((question) => question?.kind === "form" && question.text === "Your settings");
    const second = forms.find((question) => question?.fields?.find((field) => field.name === "githubAccount")?.value === "acmee");
    expect(second?.fields?.find((field) => field.name === "email")?.value).toBe(ADMIN_EMAIL);
    const failed = operator.states.flatMap((state) => state.cards ?? []).find((card) => card.id === "prerequisites" && card.status === "failed");
    expect(failed?.checks?.find((check) => check.label === "GitHub owner")?.detail).toBe("GitHub has no organization or user named acmee. Check the spelling.");
    expect(h.github.conversions).toHaveLength(1); // the app was made once, after the fix
  });
```

(The `"organization"` answer is the owner type question: GitHub has no `acmee`, so it cannot say.)

Add to `tests/contract/init-cli.test.ts` (SC-009, one row per FR-065 item checked after the
settings; the account items are Task 4's, the image item is phase 1's own test):

```ts
  const YES = ["--yes", "--admin-email", ADMIN_EMAIL, "--alert-email", "ops@example.com", "--github-account", "acme", "--channel", "payments"];
  it.each<[string, string[], Partial<InitCliDependencies>, string]>([
    ["model access and the Anthropic form", [], { checks: passingChecks({ converse: async () => { throw Object.assign(new Error("Model use case details have not been submitted for this account"), { name: "ResourceNotFoundException" }); } }) }, "one-time usage form"],
    ["a name too long", ["--github-app-name", "x".repeat(35)], {}, "app name"],
    ["a clashing stack", [], { stackStatus: { status: async (name) => (name === environmentStackName("staging", "access") ? "CREATE_COMPLETE" : undefined) } }, "already has stacks or settings"],
    ["the GitHub owner", [], { github: { ...fakeGitHubApi(), owner: async () => undefined } }, "GitHub has no organization or user named acme"],
    ["the budget value", ["--budget", "12abc"], {}, "--budget must be a whole number"],
    ["the email address", ["--alert-email", "not-an-email"], {}, "is not an email address"],
  ])("SC-009: %s is reported before anything is created", async (_item, argv, overrides, words) => {
    const h = await harness();
    expect(await h.run([...YES, ...argv], overrides)).not.toBe(0);
    expect(h.printed()).toContain(words);
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(h.github.conversions).toEqual([]);
  });
```

(Commander keeps the last `--alert-email`, so the email row overrides `YES`'s. Check how this file's
own `harness().run` passes overrides and use that form.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-clash-checks.test.ts tests/contract/init-retry.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: FAIL: `clash-checks.js` does not exist; `checkWithChangeOnPage` is not exported.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/init/clash-checks.ts`:

```ts
// packages/cli/src/init/clash-checks.ts
// Spec 048 FR-028 and FR-065: the answer checks beyond AWS's own: the install name is not used here
// already, the GitHub owner exists and is the kind the answers say, and the app name fits both
// platforms and is free on GitHub. Each is a PrerequisiteCheck for the checklist; nothing is
// created, and a GitHub that cannot answer is "could not check", never a wrong answer.
import { environmentStackName } from "@agentx/contracts";
import { installOrder } from "../deploy/parameters.js";
import type { StackStatusReader } from "./context.js";
import { githubAppSlug, type GitHubApi } from "./github-app.js";
import type { InitAnswers } from "./install-state.js";
import type { CheckAudience, PrerequisiteCheck } from "./prerequisites.js";
import { GITHUB_APP_NAME_LIMIT, SLACK_APP_NAME_LIMIT } from "./settings-form.js";

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const kindWord = (type: "organization" | "user"): string => (type === "organization" ? "an organization" : "a personal account");

export async function clashChecks(input: { answers: InitAnswers; stackStatus: StackStatusReader; github: GitHubApi; audience: CheckAudience; installUsed: (env: string) => Promise<boolean> }): Promise<PrerequisiteCheck[]> {
  const { answers } = input;
  const page = input.audience === "page";
  const checks: PrerequisiteCheck[] = [];

  const stacks = installOrder(answers.identity.mode).map((part) => environmentStackName(answers.env, part));
  const existing: string[] = [];
  for (const stack of stacks) if ((await input.stackStatus.status(stack)) !== undefined) existing.push(stack);
  if (existing.length > 0 || (await input.installUsed(answers.env))) {
    checks.push({
      label: "Install name", ok: false,
      detail: page
        ? `This AWS account and region already have an AgentX install named ${answers.env}. Choose another install name.`
        : `environment ${answers.env} already has stacks or settings in this account and region; choose another --env`,
      ...(existing.length === 0 ? {} : { technical: existing.join(", ") }),
    });
  } else {
    checks.push({ label: "Install name", ok: true, detail: `${answers.env} is free in this account and region` });
  }

  const owner = answers.github.account;
  if (input.github.owner !== undefined) {
    try {
      const found = await input.github.owner(owner);
      if (found === undefined) {
        checks.push({ label: "GitHub owner", ok: false, detail: page ? `GitHub has no organization or user named ${owner}. Check the spelling.` : `GitHub has no organization or user named ${owner}; check --github-account` });
      } else {
        const actual = found.type === "Organization" ? "organization" : "user";
        checks.push(actual === answers.github.accountType
          ? { label: "GitHub owner", ok: true, detail: `${owner} is ${kindWord(actual)} on GitHub` }
          : {
            label: "GitHub owner", ok: false,
            detail: page
              ? `${owner} is ${actual === "user" ? "a personal GitHub account" : "a GitHub organization"}, not ${kindWord(answers.github.accountType)}. Change the answer.`
              : `${owner} is ${kindWord(actual)} on GitHub, not ${kindWord(answers.github.accountType)}; check --github-account-type`,
          });
      }
    } catch (error) {
      checks.push({
        label: "GitHub owner", ok: false,
        detail: page ? `AgentX could not reach GitHub to check ${owner}. Check your network, then check again.` : `could not check the GitHub owner ${owner} (${reason(error)}); check your network and run agentx init again`,
        ...(page ? { technical: reason(error) } : {}),
      });
    }
  }

  const { appName } = answers.github;
  if (appName.length > GITHUB_APP_NAME_LIMIT || answers.slack.appName.length > SLACK_APP_NAME_LIMIT) {
    checks.push({ label: "App name", ok: false, detail: page ? `The app name is longer than GitHub's ${GITHUB_APP_NAME_LIMIT} characters or Slack's ${SLACK_APP_NAME_LIMIT}. Choose a shorter app name.` : `the app name must be at most ${GITHUB_APP_NAME_LIMIT} characters for GitHub and ${SLACK_APP_NAME_LIMIT} for Slack; check --github-app-name and --slack-app-name` });
  } else if (input.github.appBySlug !== undefined) {
    const slug = githubAppSlug(appName);
    try {
      const app = await input.github.appBySlug(slug);
      checks.push(app === undefined
        ? { label: "App name", ok: true, detail: `${appName} is free on GitHub` }
        : { label: "App name", ok: false, detail: page ? `GitHub already has an app named ${appName}. Choose another app name.` : `GitHub already has an app named ${appName}; choose another with --github-app-name`, technical: slug });
    } catch (error) {
      checks.push({ label: "App name", ok: false, detail: page ? `AgentX could not reach GitHub to check the app name. Check your network, then check again.` : `could not check the app name on GitHub (${reason(error)}); check your network and run agentx init again` });
    }
  } else {
    checks.push({ label: "App name", ok: true, detail: `${appName} fits GitHub and Slack` });
  }
  return checks;
}
```

In `github-app.ts`:

```ts
/** Spec 048 FR-028: the slug GitHub makes from an app's name (lower case, runs of anything else to
 * one hyphen), which is how a taken name is found. */
export function githubAppSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// GitHubApi:
  /** Best effort (Ruling 8): GitHub shows a private app by its slug only to its owner, so undefined
   * means "not visible", not "free". Optional: a client without it skips the check. */
  appBySlug?(slug: string): Promise<{ owner: { login: string } } | undefined>;

// githubRestApi, beside owner:
    async appBySlug(slug) {
      const found = (await lookup("app lookup", `/apps/${encodeURIComponent(slug)}`)) as { owner?: { login?: string } } | undefined;
      return found === undefined ? undefined : { owner: { login: found.owner?.login ?? "" } };
    },
```

and `fakeGitHubApi` gains `async appBySlug() { return undefined; },`.

In `prerequisites.ts`, `checkPrerequisites` gains
`extraChecks?: () => Promise<readonly PrerequisiteCheck[]>` and, right after the image checks:

```ts
  // Spec 048 FR-028: the install name, the GitHub owner and the app name (clash-checks.ts).
  if (input.extraChecks !== undefined) {
    for (const check of await input.extraChecks()) {
      if (check.ok) input.onCheck?.(check);
      else failed(check.label, check.detail, check.technical);
    }
  }
```

In `retry.ts`:

```ts
/** Spec 048 FR-028 (and FR-061's first action): a check of the answers that fails on the page offers
 * Change answers (the settings come back with every answer kept), Check again, or Stop for now.
 * Without a page it throws the failure, asking nothing, as before. */
export async function checkWithChangeOnPage(input: {
  surface: InstallSurface | undefined; prompter: Prompter; question: string; run: () => Promise<void>; failed: (problem: string) => void;
}): Promise<"passed" | "change"> {
  for (;;) {
    try {
      await input.run();
      return "passed";
    } catch (error) {
      if (input.surface === undefined) throw error;
      input.failed(problemText(error));
      const next = await input.prompter.choose<"change" | "retry" | "stop">(input.question, [
        { value: "change", label: "Change answers" },
        { value: "retry", label: "Check again" },
        { value: "stop", label: "Stop for now" },
      ], { flag: "--on-check-failure", defaultValue: "change" });
      if (next === "change") return "change";
      if (next === "stop") throw markOperatorStop(error);
    }
  }
}
```

In `question-copy.ts`:

```ts
  { kind: "choose", flag: "--on-check-failure", help: { label: "Fix what is marked above", why: "Nothing has been created yet. Change an answer, or fix it elsewhere and check again.", buttons: true, choiceLabels: { change: "Change answers", retry: "Check again", stop: "Stop for now" } } },
```

In `commands.ts`, the first run's checks run `clashChecks` too, and a Change answers goes back to the
settings with what was typed:

```ts
  const answerChecks = () => clashChecks({
    answers: finalAnswersRef.current, stackStatus, github, audience: surface === undefined ? "terminal" : "page",
    installUsed: async (name) => (await readEnvironmentSettings(store, name)) !== undefined || (await readInstallAnswers(store, name)) !== undefined,
  });
  // runPrerequisites gains `extraChecks` beside `skipAccount`, passed through to checkPrerequisites.

  if (stored === undefined) {
    let kept: Record<string, string> | undefined;
    for (;;) {
      collected = await collectInitAnswers({ /* Task 6's input */ ...(kept === undefined ? {} : { kept }) });
      kept = collected.settings;
      answers = collected.answers;
      finalAnswersRef.current = answers;
      const checked = await checkWithChangeOnPage({
        surface, prompter, question: "Your answers need a change. What next?", failed: () => undefined,
        run: () => runPrerequisites({ skipAccount: true, extraChecks: answerChecks }),
      });
      if (checked === "change") continue;
      break;
    }
  }
```

(`runPrerequisites` builds its checklist from `finalAnswersRef.current`, a `{ current: InitAnswers }`
holder, because the answers can now change between runs of the checks; phase 1's `const finalAnswers`
becomes `finalAnswersRef.current` wherever it was read. The page's Check again inside
`runPrerequisites` keeps phase 1's `retryOnPage`; that retry is now the `retry` choice here, so
`runPrerequisites` for the first run passes `surface: undefined` to its own `retryOnPage`, which then
throws straight to `checkWithChangeOnPage`.)

- [ ] **Step 4: Update the expectations of the checklist, with new exact values**

`grep -rn '"Prerequisites"\|check.label' tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
lists the checklist assertions. On a first run the checklist gains, after the image checks,
`"Install name"`, `"GitHub owner"` and `"App name"`; a test listing labels lists them in that place.
The page's retry question after a failed first-run check is now `"Your answers need a change. What
next?"` with the answer `"retry"` where phase 1's scripts answered `true` to "Check the prerequisites
again?"; a resume keeps phase 1's question.

- [ ] **Step 5: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-clash-checks.test.ts tests/contract/init-retry.test.ts tests/contract/init-prerequisites.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts tests/contract/init-github-app.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init tests
git commit -m "feat(init): check the install name, the GitHub owner and the app name before anything is created (048 FR-028, FR-065, SC-009)"
```

---

### Task 8: The plan in plain words, with Create AgentX and Change answers (FR-029, FR-030)

**Files:**
- Modify: `packages/cli/src/init/plan.ts` (`planSummary`; `confirmInstallPlan` returns `PlanAction`)
- Modify: `packages/cli/src/init/ui/protocol.ts` (`WizardPlan`; `WizardState.plan` becomes `WizardPlan`)
- Modify: `packages/cli/src/init/ui/state.ts`, `ui/index.ts` (`showPlan(plan: WizardPlan)`, `plan(plan: WizardPlan)`)
- Modify: `packages/cli/src/init/ui/page.ts` (the plan view), `ui/design.ts` (`plan-table`)
- Modify: `packages/cli/src/init/ui/question-copy.ts` (the plan's two buttons)
- Modify: `packages/cli/src/init/commands.ts` (the plan text to the log file; the summary to the page)
- Modify: `tests/support/copy-lint.ts` (`stateEntries` walks the plan's parts), `tests/support/init-ui-harness.ts` (`FIRST_RUN`'s last answer)
- Test: `tests/contract/init-plan.test.ts`, `tests/contract/init-ui-page.test.ts`, `tests/contract/init-ui-cli.test.ts`

**Interfaces:**
- Consumes: phase 1's `installPlanText`, `estimateMonthlyCost`, `money`, `count`, `notCounted`, `STATED_USAGE`, `PRICES_CHECKED`, `modelName`; Task 1's `phaseSeconds`; Task 5's `signinMethods`.
- Produces:
  - `interface WizardPlan { intro: string; sections: Array<{ title: string; lines: string[] }>; cost: { rows: Array<{ item: string; monthly: string; basis: string }>; total: string; usage: string }; resources: string[] }`.
  - `planSummary(answers: InitAnswers, estimate: CostEstimate, notes: readonly string[], extras?: PlanExtras): WizardPlan`.
  - `type PlanAction = "create" | "change"`; `confirmInstallPlan(input: { ...phase 1's; page: boolean; show?: (plan: WizardPlan) => void }): Promise<PlanAction>`: the page asks the two buttons; the terminal keeps phase 1's confirm (no is a stop, never "change").

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-plan.test.ts`:

```ts
describe("spec 048 FR-029: the plan as a plain summary", () => {
  const answers = sampleAnswers({ adminEmail: "alice@example.com", signinMethods: "slack", budget: { monthlyUsd: 260, scope: "account" } });
  const plan = planSummary(answers, estimateMonthlyCost(answers.models), []);

  it("says what is created in AWS, GitHub and Slack by name, how long the build takes, and how to remove it", () => {
    expect(plan.sections.map((section) => section.title)).toEqual(["In AWS", "In GitHub", "In Slack", "Budget and alerts", "To remove it later"]);
    expect(plan.sections[0]?.lines).toEqual([
      "The network and sign-in, the AgentX service and the Slack connection, in AWS account 123456789012 (us-east-1).",
      "Building them takes about 18 minutes, and you can leave while it runs.",
    ]);
    expect(plan.sections[1]?.lines).toEqual(["An app named \"AgentX acme (staging)\" owned by acme. It can read code and open pull requests in the repositories you choose."]);
    expect(plan.sections[4]?.lines).toEqual(["The ready screen gives you the command that removes everything, the coding machines' disks too."]);
  });

  it("FR-030: says developer sign-in is turned on with the Slack connection, with no second approval", () => {
    expect(plan.sections[2]?.lines).toEqual([
      "An app named \"AgentX acme (staging)\" in the Slack workspace you choose.",
      "Developers sign in to AgentX with Slack. It is turned on with the Slack connection, with no separate approval.",
    ]);
  });

  it("FR-023 and FR-025: names the budget and the alert address", () => {
    expect(plan.sections[3]?.lines).toEqual([
      "A budget alert at $260 a month for the whole account.",
      "Alerts go to ops@example.com. AWS sends a confirmation email there while the build runs.",
    ]);
  });

  it("has a three-column cost table with its usage stated once, and every line priced or marked", () => {
    expect(plan.cost.rows.length).toBe(estimateMonthlyCost(answers.models).lines.length);
    for (const row of plan.cost.rows) expect(row.monthly).toMatch(/^(\$\d+\.\d{2}|not priced)$/);
    expect(plan.cost.usage).toBe(`At ${count(STATED_USAGE.turnsPerMonth)} turns, ${count(STATED_USAGE.workerSessionsPerMonth)} coding sessions and ${STATED_USAGE.workerInstanceHoursPerMonth} machine-hours a month, at us-east-1 list prices of ${PRICES_CHECKED}. Your bill will differ.`);
  });

  it("keeps stacks, roles and secret paths for Show every resource only", () => {
    expect(plan.resources.some((line) => line.includes(environmentStackName("staging", "control-plane")))).toBe(true);
    expect(JSON.stringify(plan.sections)).not.toMatch(/agentx-staging-|arn:aws|AWS::/);
  });

  it("on the page asks Create AgentX or Change answers; in the terminal keeps its confirm", async () => {
    const page = scriptedPrompter(["change"]);
    await expect(confirmInstallPlan({ answers, notes: [], prompter: page, write: () => undefined, page: true })).resolves.toBe("change");
    const terminal = scriptedPrompter([true]);
    await expect(confirmInstallPlan({ answers, notes: [], prompter: terminal, write: () => undefined, page: false })).resolves.toBe("create");
    expect(terminal.asked).toEqual(["Create all of this?"]);
  });
});
```

Add to `tests/contract/init-ui-page.test.ts`:

```ts
  it("FR-029: shows the plan as sections and a cost table, with every resource behind a link", () => {
    expect(WIZARD_JS).toContain('el("table", "plan-table")');
    expect(WIZARD_JS).toContain('for (const heading of ["Item", "Monthly", "Basis"])');
    expect(WIZARD_JS).toContain('el("summary", "", "Show every resource")');
  });
```

and replace phase 1's `<details id="plan"...><summary>View the plan</summary><pre id="plan-body">`
expectation with `<details id="plan"...><summary>View the plan</summary><div id="plan-body">`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-plan.test.ts tests/contract/init-ui-page.test.ts`
Expected: FAIL: `planSummary` is not exported; the plan is still a `<pre>`.

- [ ] **Step 3: Write minimal implementation**

In `protocol.ts`:

```ts
/** Spec 048 FR-029: the plan as the page shows it. `resources` is "Show every resource". */
export interface WizardPlan {
  intro: string;
  sections: Array<{ title: string; lines: string[] }>;
  cost: { rows: Array<{ item: string; monthly: string; basis: string }>; total: string; usage: string };
  resources: string[];
}
// WizardState: `plan?: WizardPlan;` replaces phase 1's `plan?: string`.
```

In `plan.ts`:

```ts
export type PlanAction = "create" | "change";

const BUILD_PARTS = "The network and sign-in, the AgentX service and the Slack connection";

/** FR-029 and FR-030: what the plan says, in plain words. The full text (installPlanText) still
 * goes to the log file; its stack, role and secret lines are "Show every resource". */
export function planSummary(answers: InitAnswers, estimate: CostEstimate, notes: readonly string[], extras: PlanExtras = {}): WizardPlan {
  const signin = answers.signinMethods ?? "slack";
  const signinWords = signin === "slack" ? "with Slack" : signin === "oidc" ? "with your company sign-in" : "with Slack or your company sign-in";
  const alerts = answers.alert.kind === "email"
    ? `Alerts go to ${answers.alert.address}. AWS sends a confirmation email there while the build runs.`
    : answers.alert.kind === "webhook"
      ? `Alerts go to ${answers.alert.display}. It is subscribed while the build runs.`
      : "Alerts go nowhere for now. Nobody is told when AgentX stops working.";
  const missing = notCounted(estimate);
  const full = installPlanText(answers, estimate, notes, extras).split("\n");
  return {
    intro: "Here is what AgentX will create. Nothing is created until you press Create AgentX.",
    sections: [
      { title: "In AWS", lines: [`${BUILD_PARTS}, in AWS account ${answers.account} (${answers.region}).`, `Building them takes ${minutesText(Math.ceil(phaseSeconds("build") / 60))}, and you can leave while it runs.`] },
      { title: "In GitHub", lines: [`An app named "${answers.github.appName}" owned by ${answers.github.account}. It can read code and open pull requests in the repositories you choose.`] },
      { title: "In Slack", lines: [`An app named "${answers.slack.appName}" in the Slack workspace you choose.`, `Developers sign in to AgentX ${signinWords}. It is turned on with the Slack connection, with no separate approval.`] },
      { title: "Budget and alerts", lines: [answers.budget === undefined ? "No budget alert." : answers.budget.scope === "tag"
        ? `A budget alert at $${answers.budget.monthlyUsd} a month for AgentX's own costs, counted once someone with billing rights turns on its billing tag (up to a day later).`
        : `A budget alert at $${answers.budget.monthlyUsd} a month for the whole account.`, alerts] },
      { title: "To remove it later", lines: ["The ready screen gives you the command that removes everything, the coding machines' disks too."] },
    ],
    cost: {
      rows: estimate.lines.map((line) => ({ item: line.item, monthly: line.usd === undefined ? "not priced" : money(line.usd), basis: line.basis })),
      total: `About ${money(estimate.totalUsd)} a month${missing.length === 0 ? "" : `, not counting ${missing.join(" and ")}, whose price is not on file`}.`,
      usage: `At ${count(STATED_USAGE.turnsPerMonth)} turns, ${count(STATED_USAGE.workerSessionsPerMonth)} coding sessions and ${STATED_USAGE.workerInstanceHoursPerMonth} machine-hours a month, at us-east-1 list prices of ${PRICES_CHECKED}. Your bill will differ.`,
    },
    resources: full.filter((line) => line.startsWith("- Stacks") || line.startsWith("- IAM roles") || line.startsWith("- Secrets") || line.startsWith("- Settings")).map((line) => line.slice(2)),
  };
}

export async function confirmInstallPlan(input: { answers: InitAnswers; notes: readonly string[]; prompter: Prompter; write: (text: string) => void; extras?: PlanExtras; page: boolean; show?: (plan: WizardPlan) => void }): Promise<PlanAction> {
  const estimate = estimateMonthlyCost(input.answers.models);
  input.write(installPlanText(input.answers, estimate, input.notes, input.extras));
  if (input.page) {
    input.show?.(planSummary(input.answers, estimate, input.notes, input.extras));
    // FR-029: Create AgentX is the primary button; Change answers goes back with every answer kept.
    return input.prompter.choose<PlanAction>("Create all of this?", [
      { value: "create", label: "Create AgentX" },
      { value: "change", label: "Change answers" },
    ], { flag: "--plan", defaultValue: "create" });
  }
  if (!(await input.prompter.confirm("Create all of this?", { defaultValue: false }))) throw operatorStop("install declined; nothing was created");
  return "create";
}
```

(Imports: `minutesText`, `phaseSeconds` from `./ui/journey.js`; `type WizardPlan` from `./ui/protocol.js`.
The notes stay in the log file's text only: phase 1's notes name flags, commands and spec phases,
which the copy-lint bans on the page. The summary's own lines say the same things in page words:
alerts off, the tag scope's delay.)

In `question-copy.ts`:

```ts
  { kind: "choose", flag: "--plan", help: { label: "Create AgentX with this plan?", why: "Nothing is created until you press Create AgentX.", buttons: true, choiceLabels: { create: "Create AgentX", change: "Change answers" } } },
```

In `state.ts` and `index.ts`, `showPlan(plan: WizardPlan)` and `plan(plan: WizardPlan)` take the
summary. In `commands.ts` the call becomes:

```ts
    const action = await confirmInstallPlan({
      answers: collected.answers, notes: collected.notes, prompter, page: session.wizard !== undefined,
      write: (text) => session.output.write(text),
      ...(session.wizard === undefined ? {} : { show: (plan: WizardPlan) => session.wizard?.plan(plan) }),
      extras: { /* phase 1's */ },
    });
```

(Until Task 9, `"change"` loops back exactly as a Change answers from the checks does: put the plan
inside Task 7's loop, after the checks, with `if (action === "change") continue;`.)

In `page.ts`, the plan box's body is a `div`, and:

```js
function renderPlan(plan, open) {
  const body = byId("plan-body");
  body.replaceChildren(el("p", "", plan.intro));
  for (const section of plan.sections) {
    body.append(el("h3", "", section.title));
    for (const line of section.lines) body.append(el("p", "", line));
  }
  body.append(el("h3", "", "What it costs"));
  const table = el("table", "plan-table");
  const head = el("tr");
  for (const heading of ["Item", "Monthly", "Basis"]) head.append(el("th", "", heading));
  table.append(head);
  for (const row of plan.cost.rows) {
    const tr = el("tr");
    tr.append(el("td", "", row.item), el("td", "", row.monthly), el("td", "", row.basis));
    table.append(tr);
  }
  body.append(table, el("p", "", plan.cost.total), el("p", "hint", plan.cost.usage));
  const every = el("details");
  every.append(el("summary", "", "Show every resource"));
  for (const line of plan.resources) every.append(el("p", "", line));
  body.append(every);
  byId("plan").open = open;
}
```

and `render` calls `if (state.plan) renderPlan(state.plan, state.steps.every((step) => step.status === "pending"));`
(the plan is open while it is the question, and collapsed behind "View the plan" once the build
starts: FR-004). `design.ts` adds `plan-table` to `PAGE_CLASSES` with a table style from the tokens
(`border-collapse: collapse`, `--border` row lines, `--text-2` for the basis column, a scroll
wrapper so a 20rem window never scrolls the page sideways).

In `tests/support/copy-lint.ts`, `stateEntries` reads the plan's parts: `intro`, every section line
and the cost table as `"page"`, `resources` as `"details"` (they hold stack and secret names).

In `tests/support/init-ui-harness.ts`: `export const FIRST_RUN = [SETTINGS, "create"];`.

- [ ] **Step 4: Update the plan expectations, with new exact values**

`grep -rn "state.plan\|\.plan)" tests/contract` lists the tests that read phase 1's plan text from
the page's state: each reads `plan.sections`, `plan.cost` or `plan.resources` instead, with the
same facts (a test that looked for the budget line in the text looks for it in "Budget and alerts").
The terminal's printed plan (`installPlanText`) does not change; its tests stay as they are.

- [ ] **Step 5: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-plan.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-design.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-ui-copy-lint.test.ts tests/contract/init-ui-hub.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init tests
git commit -m "feat(init): the plan is a plain summary with Create AgentX and Change answers (048 FR-029, FR-030)"
```

---

### Task 9: Change answers keeps every answer, including a new install name (FR-020, FR-029)

**Files:**
- Modify: `packages/cli/src/init/commands.ts` (`env` follows the answers; `session.env`; the header)
- Modify: `packages/cli/src/init/ui/state.ts`, `ui/index.ts` (`setInstallName`)
- Test: `tests/contract/init-ui-cli.test.ts`, `tests/contract/init-ui-hub.test.ts`

**Interfaces:**
- Consumes: Task 7's loop, Task 8's `PlanAction`, Task 6's `CollectedAnswers.settings`.
- Produces: `WizardHub.setInstallName(name: string): void` and `InstallWizard.setInstallName`; after
  the settings, everything `init()` does (the checks, the lock, the steps, the commands on the page)
  uses `answers.env`. The log file keeps the name the run started with (Ruling 5).

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-ui-hub.test.ts`:

```ts
  it("spec 048 FR-020: the header follows a new install name", () => {
    const hub = createWizardHub("production");
    hub.setPlace({ account: "123456789012", region: "us-east-1" });
    hub.setInstallName("staging");
    expect(hub.state().header).toEqual({ installName: "staging", account: "123456789012", region: "us-east-1" });
  });
```

Add to `tests/contract/init-ui-cli.test.ts` (Review Focus 2):

```ts
  it("FR-029 and Review Focus 2: Change answers keeps every answer and recomputes an app name the user never typed", async () => {
    const h = await harness();
    const github = { ...fakeGitHubApi({ owner: "acme-labs" }), owner: async (login: string) => ({ login, type: "Organization" as const }) };
    const moved = JSON.stringify({ email: ADMIN_EMAIL, githubAccount: "acme-labs", alertEmail: "ops@example.com" });
    const operator = fakeWizardOperator([SETTINGS, "change", moved, "create"], { beforeAnswer: async (question) => { if (question.text === "Create all of this?" && h.store.values.size > 0) throw new Error("test setup: something was saved before Create AgentX"); } });
    // --stop-after prerequisites: the run ends before the GitHub step, which is all this test needs.
    expect(await h.run(["--ui", "--stop-after", "prerequisites"], { openBrowser: operator.open, github })).toBe(0);
    await operator.settled();
    const plans = operator.states.map((state) => state.plan).filter((plan): plan is WizardPlan => plan !== undefined);
    expect(plans[0]?.sections[1]?.lines[0]).toContain("\"AgentX acme (staging)\" owned by acme.");
    expect(plans.at(-1)?.sections[1]?.lines[0]).toContain("\"AgentX acme-labs (staging)\" owned by acme-labs.");
    const second = operator.states.map((state) => state.question).filter((question) => question?.text === "Your settings")[1];
    expect(second?.fields?.find((field) => field.name === "email")?.value).toBe(ADMIN_EMAIL);
    expect(second?.fields?.find((field) => field.name === "alertEmail")?.value).toBe("ops@example.com");
    expect(second?.fields?.find((field) => field.name === "appName")?.value).toBe("");
    const answers = JSON.parse(h.store.values.get(installAnswersParameterName("staging")) ?? "{}") as InitAnswers;
    expect(answers.github).toEqual({ account: "acme-labs", accountType: "organization", appName: "AgentX acme-labs (staging)" });
  });

  it("FR-020: a new install name is the install's name from then on, and a used one is refused", async () => {
    const h = await harness();
    const renamed = JSON.stringify({ email: ADMIN_EMAIL, githubAccount: "acme", installName: "trial", alertEmail: "ops@example.com" });
    const operator = fakeWizardOperator([renamed, "create"]);
    expect(await h.run(["--ui", "--stop-after", "prerequisites"], { openBrowser: operator.open })).toBe(0);
    await operator.settled();
    expect(h.store.values.has(installAnswersParameterName("trial"))).toBe(true);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
    expect(operator.states.at(-1)?.header.installName).toBe("trial");

    const again = await harness();
    await writeInstallAnswers(again.store, sampleAnswers({ env: "trial" }));
    const refused = fakeWizardOperator([renamed, "stop"]);
    expect(await again.run(["--ui"], { openBrowser: refused.open })).not.toBe(0);
    await refused.settled();
    const card = refused.states.flatMap((state) => state.cards ?? []).find((each) => each.id === "prerequisites" && each.status === "failed");
    expect(card?.checks?.find((check) => check.label === "Install name")?.detail).toBe("This AWS account and region already have an AgentX install named trial. Choose another install name.");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-hub.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL: `setInstallName` is not a function; the answers are saved under `staging`.

- [ ] **Step 3: Write minimal implementation**

In `state.ts`: `let installName = env;`, `setPlace` builds `header = { installName, account, region }`,
and:

```ts
    setInstallName(name) { installName = name; header = { ...header, installName: name }; publish(); },
```

(`WizardHub` gains `setInstallName(name: string): void`; `InstallWizard` gains the same, passed
through.) In `commands.ts`:

- `InitSession` gains `env: string`, set to `options.env` at the start of `runInit`; the "Continue
  later with" commands in `runInit` use `session.env`, not `options.env`.
- In `init()`, `const { env } = options;` becomes `let env = options.env;`. After each
  `collectInitAnswers` in the loop: `env = collected.answers.env; session.env = env; session.wizard?.setInstallName(env);`.
- Every use of `env` after the loop already reads the variable (`saveAnswers`, `context`,
  `runInitSteps`, `readyCard`, `resumeScreen` is only on a resume), so nothing else changes. The log
  file opened before the wizard keeps its path (Ruling 5).

The refusal of a used name is Task 7's "Install name" check (`installUsed` reads both the settings
and the install answers of the new name), so a used name comes back as a failed check with Change
answers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-hub.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init tests
git commit -m "feat(init): Change answers keeps every answer, and a new install name is the install's name (048 FR-020, FR-029)"
```

---

### Task 10: A GitHub app made but not stored is found again on resume (FR-032)

**Files:**
- Modify: `packages/cli/src/init/github-app.ts` (`runGitHubAppStep`: record `githubPending` before the key is stored; offer finish or replace on resume)
- Modify: `packages/cli/src/init/ui/cards.ts` (`GitHubCardInput` gains `"recover"`)
- Modify: `packages/cli/src/init/ui/question-copy.ts` (the recovery choice, the "deleted it?" confirm)
- Test: `tests/contract/init-github-app.test.ts`

**Interfaces:**
- Consumes: Task 5's `githubPending`, phase 1's `usePreMadeApp`, `createWithManifest`, `githubCard`.
- Produces: the choice `"Finish with the GitHub app <slug>, or replace it?"` (flag `--github-app-recovery`, values `"finish" | "replace"`), and the card stage `{ stage: "recover"; appName: string; slug: string; settingsUrl: string }`.

GitHub shows an app's private key only once, at the conversion. Finishing with the app means making
a new private key on the app's GitHub page and pasting it (phase 1's made-beforehand path); replacing
it means deleting the app on GitHub first (GitHub app names are unique) and making a new one.

- [ ] **Step 1: Write the failing tests**

```ts
describe("spec 048 FR-032: a GitHub app made but not stored", () => {
  it("is recorded before its key is stored, so a failed store leaves it findable", async () => {
    const { context, progress } = await githubContext({ secrets: memoryInitSecrets({}, { failCreate: true }) });
    await expect(githubAppStep(fakeGitHubApi()).run(context, progress)).rejects.toThrow("could not store the private key");
    expect(progress.current().githubPending).toEqual({ account: "acme", appId: "424242", slug: "agentx-acme-staging" });
    expect(progress.current().github).toBeUndefined();
  });

  it("on resume, Finish takes a new private key for the same app and makes no new app", async () => {
    const api = fakeGitHubApi();
    const { context, progress } = await githubContext({ pending: { account: "acme", appId: "424242", slug: "agentx-acme-staging" }, script: ["finish", TEST_PRIVATE_KEY] });
    await expect(githubAppStep(api).run(context, progress)).resolves.toMatchObject({ status: "done" });
    expect(api.conversions).toEqual([]);
    expect(progress.current().github).toMatchObject({ appId: "424242", slug: "agentx-acme-staging" });
  });

  it("on resume, Replace sends the user to delete the old app, then makes a new one", async () => {
    const api = fakeGitHubApi();
    const cards: WizardCard[] = [];
    const { context, progress } = await githubContext({ pending: { account: "acme", appId: "424242", slug: "agentx-acme-staging" }, script: ["replace", true], cards });
    await expect(githubAppStep(api).run(context, progress)).resolves.toMatchObject({ status: "done" });
    expect(api.conversions).toHaveLength(1);
    const recover = cards.find((card) => card.lines.some((line) => line.includes("cannot show that key again")));
    expect(recover?.link?.url).toBe("https://github.com/organizations/acme/settings/apps/agentx-acme-staging/advanced");
  });
});
```

(`githubContext` is this file's existing builder of an `InitContext` and `ProgressHandle` for the
GitHub step; extend it with `pending` (seeds `githubPending`), `script` (the scripted prompter's
answers) and `cards` (a surface that records cards). `memoryInitSecrets`'s `failCreate` option makes
`create` throw; add it if the fake has no such switch.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-github-app.test.ts`
Expected: FAIL: nothing records `githubPending`; a resume makes a new app.

- [ ] **Step 3: Write minimal implementation**

In `runGitHubAppStep`, right after the owner check and before `context.secrets.create(...)`:

```ts
    // FR-032: recorded before the key is stored. GitHub shows the key only once, so a run that stops
    // between here and the store can still find the app and offer to finish with it or replace it.
    await progress.update({ githubPending: { account, appId: created.appId, slug: created.slug } });
```

and, where phase 1 decides `if (app === undefined) { const created = preMade !== undefined ? ... }`,
the made-but-not-stored case comes first:

```ts
  const pending = progress.current().githubPending;
  let recovering: "finish" | "replace" | undefined;
  if (app === undefined && pending !== undefined && preMade === undefined) {
    const settingsUrl = `${appSettingsUrl({ login: account, type: accountType === "organization" ? "Organization" : "User" }, pending.slug)}/advanced`;
    show({ stage: "recover", appName, slug: pending.slug, settingsUrl });
    recovering = await context.prompter.choose<"finish" | "replace">(`Finish with the GitHub app ${pending.slug}, or replace it?`, [
      { value: "finish", label: "Finish with this app: make a new private key on its GitHub page and paste it" },
      { value: "replace", label: "Replace it: delete it on GitHub, then make a new one" },
    ], { flag: "--github-app-recovery", defaultValue: "finish" });
    if (recovering === "replace" && !(await context.prompter.confirm(`Have you deleted ${pending.slug} on GitHub?`, { defaultValue: true }))) {
      throw operatorStop(`the GitHub app ${pending.slug} is still there; delete it on GitHub, then continue the install`);
    }
  }
  if (app === undefined) {
    const created = preMade !== undefined ? await usePreMadeApp(context, api, preMade.appId)
      : recovering === "finish" && pending !== undefined ? await usePreMadeApp(context, api, pending.appId)
        : await createWithManifest(context, api, show);
    // ...phase 1's owner check, then the githubPending record above, the store, progress.update({ github: app })...
  }
```

(`githubPending` is read only while `github` is not recorded, so it is left in place after a
successful store.) In `cards.ts`:

```ts
    case "recover": return {
      ...base, status: "waiting", ...slug(input.slug),
      lines: [
        `GitHub made "${input.appName}", but the install stopped before its private key was stored, and GitHub cannot show that key again.`,
        "Finish with this app: make a new private key on its GitHub page and paste it here. Nothing is removed.",
        "Replace it: delete the app on its GitHub page first, then AgentX makes a new one. Only the old GitHub app is removed; nothing in AWS is.",
      ],
      link: { url: input.settingsUrl, label: "Open the app on GitHub" },
    };
```

In `question-copy.ts`:

```ts
  { kind: "choose", flag: "--github-app-recovery", help: { label: "Finish with the GitHub app, or replace it?", why: "The card above says what each choice removes.", buttons: true, choiceLabels: { finish: "Finish with this app", replace: "Replace it" } } },
  { kind: "confirm", text: /^Have you deleted .+ on GitHub\?$/, help: { label: "Deleted the old app on GitHub?", why: "GitHub app names are unique, so the new app needs the old one gone first.", yesLabel: "It is deleted", noLabel: "Stop for now" } },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-github-app.test.ts tests/contract/init-ui-github.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init tests/contract/init-github-app.test.ts tests/support
git commit -m "feat(init): a GitHub app made but not stored is found again on resume, to finish or replace (048 FR-032)"
```

---

### Task 11: Alerts are subscribed as soon as their topic exists (FR-025)

**Files:**
- Modify: `packages/cli/src/setup/alerts.ts` (`subscribeAlertsEarly`)
- Modify: `packages/cli/src/init/finish-steps.ts` (`subscribeAlertsAfterDeploy`)
- Modify: `packages/cli/src/init/commands.ts` (`initSteps`: the AgentX service step's `after`)
- Test: `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-ui-cli.test.ts`

**Interfaces:**
- Consumes: phase 1's `alertsTopicArn`, `AlertTarget`, `requireWebhook`, `deployStep({ after })`.
- Produces: `subscribeAlertsEarly(input: { api: AlertsApi; topicArn: string; target: AlertTarget; write: (line: string) => void }): Promise<void>` (subscribes once, never waits) and `subscribeAlertsAfterDeploy(context: InitContext): Promise<void>` (never throws: a failure is a log line, and the alerts step tries again).

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-finish-steps.test.ts`:

```ts
describe("spec 048 FR-025: the alert address is subscribed early", () => {
  it("subscribes once, without waiting for the confirmation", async () => {
    const api = fakeAlerts({ confirmAfterPolls: 1000 });
    const target = { kind: "email" as const, address: "ops@example.com" };
    await subscribeAlertsEarly({ api, topicArn: TOPIC, target, write: () => undefined });
    await subscribeAlertsEarly({ api, topicArn: TOPIC, target, write: () => undefined });
    expect(api.subscribed).toEqual(["email ops@example.com"]);
  });

  it("does nothing for no alerts, and a failure never stops the build", async () => {
    const lines: string[] = [];
    const none = await finishContext({ answers: sampleAnswers({ alert: { kind: "none" } }) });
    await expect(subscribeAlertsAfterDeploy(none.context)).resolves.toBeUndefined();
    const broken = await finishContext({ alerts: { ...fakeAlerts(), subscribe: async () => { throw new Error("SNS is down"); } }, write: (line) => lines.push(line) });
    await expect(subscribeAlertsAfterDeploy(broken.context)).resolves.toBeUndefined();
    expect(lines.at(-1)).toBe("could not subscribe the alert address yet (SNS is down); the alerts step tries again");
  });
});
```

(`TOPIC` and `finishContext` are this file's existing topic ARN and context builder; extend the
builder with `alerts` and `write` overrides if it has none.)

Add to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("FR-025: the alert address is subscribed while the build runs, before the Slack visit", async () => {
    const h = await harness();
    const alerts = fakeAlerts({ confirmAfterPolls: 0, budgetUsd: FIRST_RUN_BUDGET_USD });
    let atSlack: string[] = [];
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH], {
      beforeAnswer: async (question) => { if (question.text === "Is the Slack app installed in your workspace?") atSlack = [...alerts.subscribed]; },
    });
    expect(await h.run(["--ui"], { openBrowser: operator.open, setup: { ...h.setup, alerts } })).toBe(0);
    await operator.settled();
    expect(atSlack).toEqual(["email ops@example.com"]);
    expect(alerts.subscribed).toEqual(["email ops@example.com"]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL: `subscribeAlertsEarly` is not exported; nothing is subscribed before the Finish phase.

- [ ] **Step 3: Write minimal implementation**

In `setup/alerts.ts`:

```ts
/** Spec 048 FR-025: subscribes the address as soon as the topic exists, so the confirmation email is
 * already waiting by the Finish phase. Never waits for the confirmation (ensureSubscribed, in the
 * alerts step, does), and never subscribes an address twice. */
export async function subscribeAlertsEarly(input: { api: AlertsApi; topicArn: string; target: AlertTarget; write: (line: string) => void }): Promise<void> {
  const { target } = input;
  const protocol = target.kind === "email" ? "email" : "https";
  const endpoint = target.kind === "email" ? target.address : target.endpoint;
  const known = (await input.api.subscriptions(input.topicArn)).some((entry) => entry.protocol === protocol && sameEndpoint(entry.endpoint, endpoint, target.kind));
  if (known) return;
  await withoutEndpoint(target, () => input.api.subscribe(input.topicArn, protocol, endpoint));
  input.write(target.kind === "email"
    ? `AWS sent ${target.address} an email from AWS Notifications; confirm it any time before the install ends.`
    : `Subscribed ${target.display} to AgentX's alerts.`);
}
```

In `finish-steps.ts`:

```ts
/** Spec 048 FR-025: the AgentX service step's last act. A failure is a log line, never the build's
 * failure: the alerts step subscribes again (ensureSubscribed is idempotent). */
export async function subscribeAlertsAfterDeploy(context: InitContext): Promise<void> {
  const { alert } = context.answers;
  if (alert.kind === "none") return;
  try {
    const topicArn = await alertsTopicArn({ stackOutputs: context.setup.stackOutputs, stackName: environmentStackName(context.env, "control-plane"), next: "the alerts step tries again" });
    const target: AlertTarget = alert.kind === "email"
      ? { kind: "email", address: alert.address }
      : { kind: "webhook", display: alert.display, endpoint: await requireWebhook(context, alert.secretName) };
    await subscribeAlertsEarly({ api: context.setup.alerts, topicArn, target, write: context.write });
  } catch (error) {
    context.write(`could not subscribe the alert address yet (${problemText(error)}); the alerts step tries again`);
  }
}
```

In `commands.ts`'s `initSteps`:
`deployStep({ id: "control-plane", title: STEP_PLAN["control-plane"].title, after: subscribeAlertsAfterDeploy })`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts tests/contract/init-deploy-steps.test.ts`
Expected: PASS (the alerts step finds the early subscription and does not subscribe again).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup/alerts.ts packages/cli/src/init tests/contract
git commit -m "feat(init): subscribe the alert address as soon as its topic exists (048 FR-025)"
```

---

### Task 12: One Slack visit: four values on one form, and a wait for an admin on the page (FR-033, FR-034, FR-036)

**Files:**
- Modify: `packages/cli/src/init/slack-app.ts` (`SLACK_VALUES_TITLE`, `slackValuesFields`, `collectSlackValues` replaces `collectBot`; the approval wait; the verify countdown; "It still shows an error")
- Modify: `packages/cli/src/signin/collect.ts` (export `hasStoredSlackClient`)
- Modify: `packages/cli/src/init/ui/cards.ts` (`SlackCardInput` "approval" words; `SlackUrlsCardInput` gains `until` and `"not-verified"`)
- Modify: `packages/cli/src/init/ui/protocol.ts` (`WizardCard.waitUntil?: string`), `ui/page.ts` (the countdown)
- Modify: `packages/cli/src/init/ui/question-copy.ts` (the Slack form, its retry, the four fields' links)
- Modify: `tests/support/init-ui-harness.ts`, `tests/contract/init-cli.test.ts` (`SLACK`, `SIGNIN`)
- Test: `tests/contract/init-slack-app.test.ts`, `tests/contract/init-ui-cli.test.ts`, `tests/contract/init-ui-copy-lint.test.ts`, `tests/contract/init-ui-page.test.ts`

**Interfaces:**
- Consumes: Task 2's `askForm` with `crossCheck`, Task 5's `signinMethods`, phase 1's `slackSecretWithBot`, `slackSecretWithSignIn`, `checkSlackBotToken`, `checkSlackSigningSecret`, `slackClientIdProblem`, `checkSlackClientSecret`, `retryOnPage`.
- Produces:
  - `SLACK_VALUES_TITLE = "Your Slack app's values"`.
  - `slackValuesFields(input: { client: boolean; secretFlags: SecretFlags; signinFlags: SigninFlags }): FormField[]`, in Slack's order: `clientId`, `clientSecret`, `signingSecret`, `botToken` (a value given by a flag or file is left out; the client pair only when developers sign in with Slack and none is stored).
  - `WizardCard.waitUntil?: string` (an ISO time the page counts down to).

The four values sit on two Slack pages: Basic Information, App Credentials (Client ID, Client Secret,
Signing Secret, in that order) and OAuth & Permissions (Bot User OAuth Token). The app's own ID is
not known until the token is checked, so each field links to the Slack app list, one click from
both pages (Ruling 3).

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-slack-app.test.ts`:

```ts
describe("spec 048 FR-033: the Slack values on one form", () => {
  const CLIENT_ID = "1111111111.2222222222222";
  const CLIENT_SECRET = "fedcba9876543210fedcba9876543210";

  it("asks the four values in the order Slack shows them, each linked to the Slack apps page", () => {
    const fields = slackValuesFields({ client: true, secretFlags: {}, signinFlags: {} });
    expect(fields.map((field) => field.name)).toEqual(["clientId", "clientSecret", "signingSecret", "botToken"]);
    expect(fields.map((field) => field.secret === true)).toEqual([false, true, true, true]);
    for (const field of fields) expect(field.help).toMatchObject({ learnMoreUrl: "https://api.slack.com/apps", linkLabel: "Open your Slack apps" });
  });

  it("leaves out what a flag gives, and the client pair when developers do not sign in with Slack", () => {
    expect(slackValuesFields({ client: false, secretFlags: { slackBotToken: { file: "/t" } }, signinFlags: {} }).map((field) => field.name)).toEqual(["signingSecret"]);
  });

  it("stores the client pair with the bot values, so developer sign-in asks for nothing", async () => {
    const { context, progress, secrets } = await slackContext({ script: ["installed", JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }), true], page: true });
    await expect(slackAppStep(fakeSlackApi()).run(context, progress)).resolves.toMatchObject({ status: "done" });
    expect(JSON.parse((await secrets.get("agentx/staging/slack")) ?? "{}")).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
  });

  it("Review Focus 1: the same value in Client Secret and Signing Secret is refused and nothing is stored", async () => {
    const hub = createWizardHub("staging");
    const { context, progress, secrets } = await slackContext({ hub });
    const running = slackAppStep(fakeSlackApi()).run(context, progress);
    await answerWhenAsked(hub, "Is the Slack app installed in your workspace?", "installed");
    const form = await questionWhenAsked(hub, SLACK_VALUES_TITLE);
    expect(hub.answer(form.id, JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signingSecret: CLIENT_SECRET, botToken: TEST_BOT_TOKEN }))).toBe("Check the field marked below.");
    const again = hub.state().question;
    expect(again?.fields?.find((field) => field.name === "signingSecret")?.error).toBe("This is the Client Secret again. Copy the Signing Secret, just below it on Basic Information.");
    expect(JSON.stringify(hub.snapshot())).not.toContain(CLIENT_SECRET);
    expect(await secrets.get("agentx/staging/slack")).toBe(JSON.stringify({ botToken: "unset", signingSecret: "placeholder" }));
    hub.close();
    await running.catch(() => undefined);
  });

  it("FR-036 and Ruling 2: on the page an admin approval keeps the run waiting here, and continues once installed", async () => {
    const cards: WizardCard[] = [];
    const { context, progress } = await slackContext({ script: ["approval", "installed", JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }), true], page: true, cards });
    await expect(slackAppStep(fakeSlackApi()).run(context, progress)).resolves.toMatchObject({ status: "done" });
    expect(cards.find((card) => card.status === "waiting" && card.lines[0]?.startsWith("Slack is waiting for a workspace admin"))?.lines).toEqual([
      "Slack is waiting for a workspace admin to approve \"AgentX acme (staging)\".",
      "Your progress is saved. You can leave the installer running, or stop and continue later.",
      "When the app is installed in Slack, choose Installed, continue.",
    ]);
  });

  it("FR-036: without a page an admin approval still ends the run waiting, as before", async () => {
    const { context, progress } = await slackContext({ script: ["approval"], page: false });
    await expect(slackAppStep(fakeSlackApi()).run(context, progress)).resolves.toMatchObject({ status: "waiting" });
  });
});
```

(`slackContext` is this file's builder of the Slack step's context; extend it with `script`, `page`
(a recording surface when true, none when false), `cards`, and `hub` (the page's own prompter on
that hub). `answerWhenAsked` and `questionWhenAsked` wait for the hub to publish a question with that
text; add them beside the builder if the file has no such helpers. The secret starts as the
harness's placeholder `{ botToken: "unset", signingSecret: "placeholder" }`. Check that
`TEST_SIGNING_SECRET` is not the Client Secret above; it must differ.)

Add to `tests/contract/init-ui-page.test.ts`:

```ts
  it("FR-034: counts down to a card's waitUntil", () => {
    expect(WIZARD_JS).toContain("card.waitUntil");
    expect(WIZARD_JS).toContain("node.dataset.until");
  });
```

In `tests/contract/init-ui-copy-lint.test.ts`, phase 1's "a run paused waiting on a Slack admin's
approval" test no longer pauses on the page (Ruling 2). Replace it with the other waiting step, so a
waiting step's message is still linted:

```ts
  it("a run paused waiting on the alert confirmation says no internal word anywhere on the page", async () => {
    const h = await harness();
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000_000, budgetUsd: FIRST_RUN_BUDGET_USD });
    const finish = FINISH.slice(0, -1);
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...finish, false]);
    const code = await h.run(["--ui"], { openBrowser: operator.open, setup: { ...h.setup, alerts } });
    await operator.settled();
    expect(code).toBe(0);
    expect(operator.states.some((state) => state.steps.some((step) => step.status === "waiting" && step.message !== undefined))).toBe(true);
    expect(lintCopy(operator.states.flatMap((state, index) => stateEntries(state, `state ${index}`)))).toEqual([]);
  });
```

(`false` answers "Have you confirmed the subscription?", which ends the alerts step waiting. The
last answer of `FINISH`, "did the test alarm arrive?", is never reached.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-slack-app.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-copy-lint.test.ts`
Expected: FAIL: `slackValuesFields` is not exported; the step asks two secrets one by one.

- [ ] **Step 3: Write minimal implementation**

In `slack-app.ts`:

```ts
export const SLACK_VALUES_TITLE = "Your Slack app's values";
const SLACK_APP_LINK = { learnMoreUrl: SLACK_APPS_URL, linkLabel: "Open your Slack apps" };
const SAME_SECRET = "This is the Client Secret again. Copy the Signing Secret, just below it on Basic Information.";

/** Spec 048 FR-033: the four values, in the order Slack shows them. A value a flag or file gives is
 * left out; the client pair only when developers sign in with Slack and none is stored yet. The
 * terminal asks the same fields one by one (askForm). */
export function slackValuesFields(input: { client: boolean; secretFlags: SecretFlags; signinFlags: SigninFlags }): FormField[] {
  const fields: FormField[] = [];
  if (input.client && input.signinFlags.slackClientId === undefined) {
    fields.push({ name: "clientId", question: "Slack app Client ID (Basic Information, App Credentials)", flag: SIGNIN_FLAG_NAMES.slackClientId, validate: slackClientIdProblem, help: SLACK_APP_LINK });
  }
  if (input.client && input.secretFlags.slackClientSecret === undefined) {
    fields.push({ name: "clientSecret", question: "Slack client secret", flag: SIGNIN_FLAG_NAMES.slackClientSecret, secret: true, validate: fieldCheck(checkSlackClientSecret), help: SLACK_APP_LINK });
  }
  if (input.secretFlags.slackSigningSecret === undefined) {
    fields.push({ name: "signingSecret", question: "Slack signing secret", flag: "--slack-signing-secret", secret: true, validate: fieldCheck(checkSlackSigningSecret), help: SLACK_APP_LINK });
  }
  if (input.secretFlags.slackBotToken === undefined) {
    fields.push({ name: "botToken", question: "Slack bot token", flag: "--slack-bot-token", secret: true, validate: fieldCheck(checkSlackBotToken), help: SLACK_APP_LINK });
  }
  return fields;
}
```

(Each `question` must be the exact text `secretFromSource` asks for that `what` today, so the
terminal's questions do not change: read `secretFromSource` in `prompts.ts` and use its text, for
example `"Slack bot token"` if it asks the `what` itself.)

`collectSlackValues` replaces phase 1's `collectBot`:

```ts
interface SlackValues extends SlackBot { client?: { clientId: string; clientSecret: string } }

async function collectSlackValues(context: InitContext, api: SlackApi, progress: ProgressHandle, show: (card: SlackCardInput) => void, client: boolean): Promise<SlackValues> {
  const common = { processEnv: context.processEnv, prompter: context.prompter };
  const fields = slackValuesFields({ client, secretFlags: context.secretFlags, signinFlags: context.signinFlags });
  const typed = fields.length === 0 ? {} : await askForm(context.prompter, SLACK_VALUES_TITLE, fields, {
    // A same-value paste is the common mix-up: both are 32 hexadecimal characters, side by side.
    crossCheck: (values) => (values.clientSecret !== undefined && values.clientSecret === values.signingSecret ? { signingSecret: SAME_SECRET } : undefined),
  });
  const fromSource = async (name: string, what: string, flag: string, source: SecretSource | undefined, check: (value: string) => string) =>
    check(typed[name] ?? (await secretFromSource({ ...common, what, flag, source: source ?? {}, validate: fieldCheck(check) })));
  const botToken = await fromSource("botToken", "Slack bot token", "--slack-bot-token", context.secretFlags.slackBotToken, checkSlackBotToken);
  const signingSecret = await fromSource("signingSecret", "Slack signing secret", "--slack-signing-secret", context.secretFlags.slackSigningSecret, checkSlackSigningSecret);
  let pair: SlackValues["client"];
  if (client) {
    const clientId = checkSlackClientId(context.signinFlags.slackClientId ?? typed.clientId ?? "");
    const clientSecret = await fromSource("clientSecret", "Slack client secret", SIGNIN_FLAG_NAMES.slackClientSecret, context.secretFlags.slackClientSecret, checkSlackClientSecret);
    if (clientSecret === signingSecret) throw agentXError("CONFIG_INVALID", "the Slack client secret and signing secret are the same value; nothing was saved. Copy each from Basic Information, App Credentials");
    pair = { clientId, clientSecret };
  }
  // phase 1's collectBot body from `const auth = await api.authTest(botToken);` through the
  // "Is this the AgentX bot in the right workspace?" confirm, unchanged, then:
  return { botToken, signingSecret, appId, teamId: auth.team_id, botUserId: auth.user_id, ...(botName === undefined ? {} : { botName }), ...(auth.team === undefined ? {} : { teamName: auth.team }), ...(pair === undefined ? {} : { client: pair }) };
}
```

In `slackAppStep.run`, the installed question becomes a loop on the page, and the store writes the
client pair with the bot values:

```ts
      // FR-036 (Ruling 2): Slack gives no token until the app is installed, so nothing can watch for
      // the approval. On the page the run waits here, progress saved; the terminal ends waiting, as before.
      for (;;) {
        const installed = await context.prompter.choose<"installed" | "approval">("Is the Slack app installed in your workspace?", [
          { value: "installed", label: "Yes: I can copy its Bot User OAuth Token" },
          { value: "approval", label: "Not yet: a workspace admin must approve it first" },
        ], { flag: "--slack-install", defaultValue: "installed" });
        if (installed === "installed") break;
        show({ stage: "approval", appName });
        if (context.surface === undefined) {
          return { status: "waiting", message: `Slack is waiting for a workspace admin to approve "${appName}". Once it is installed, run agentx init --env ${env} --region ${context.answers.region} again; it continues here.` };
        }
      }
      const methods = context.signinFlags.methods ?? context.answers.signinMethods ?? "slack";
      const client = methods !== "oidc" && !(await hasStoredSlackClient(context.secrets, slackSecretName(env)));
      // ...phase 1's retryOnPage around collectSlackValues(context, api, progress, show, client), with
      // its question renamed "Paste the Slack values again?"...
      // FR-030: the client pair is stored with the bot values; it stays unused until developer
      // sign-in is turned on, right after the Slack connection, as the confirmed plan said.
      const before = await context.secrets.get(slackSecretName(env));
      const withBot = slackSecretWithBot(before, { signingSecret: bot.signingSecret, botToken: bot.botToken });
      await context.secrets.put(slackSecretName(env), bot.client === undefined ? withBot : slackSecretWithSignIn(withBot, bot.client));
```

(Export `hasStoredSlackClient` from `signin/collect.ts`, unchanged.)

The verify step's countdown and "It still shows an error", in `verifySlackUrls`:

```ts
        onWaiting: () => show({ stage: "waiting-for-secret", eventsUrl, until: new Date(context.now() + SLACK_PROBE_TIMEOUT_MS).toISOString() }),
      // ...
      failed: (problem) => show(problem.startsWith("Slack has not verified") ? { stage: "not-verified", pageUrl: page } : { stage: "failed", problem, pageUrl: page }),
```

and in `cards.ts`:

```ts
  | { stage: "waiting-for-secret"; eventsUrl: string; until?: string }
  | { stage: "not-verified"; pageUrl: string }
// ...
    case "waiting-for-secret": return {
      ...base, status: "running",
      lines: [`Checking that Slack can reach AgentX at ${input.eventsUrl}.`, "AgentX can take up to 5 minutes to start using the new Signing Secret. Checking again every 15 seconds."],
      ...(input.until === undefined ? {} : { waitUntil: input.until }),
    };
    case "not-verified": return {
      ...base, status: "failed",
      lines: [
        "Slack still shows an error next to the address.",
        "In Event Subscriptions, press Retry next to the address. If it still fails, check that the Signing Secret you pasted is the one on Basic Information, App Credentials, not the Client Secret.",
        "Then choose Check again below.",
      ],
      link: { url: input.pageUrl, label: "Open Event Subscriptions" },
    };
    // and the approval stage:
    case "approval": return {
      ...base, status: "waiting",
      lines: [`Slack is waiting for a workspace admin to approve "${input.appName}".`, "Your progress is saved. You can leave the installer running, or stop and continue later.", "When the app is installed in Slack, choose Installed, continue."],
    };
```

In `protocol.ts`, `WizardCard` gains `/** FR-034: an ISO time the page counts down to. */ waitUntil?: string;`.
In `page.ts`'s `renderCard`, after the lines:

```js
  if (card.waitUntil) {
    const left = el("p", "hint");
    left.dataset.until = card.waitUntil;
    left.textContent = untilText(left);
    section.append(left);
  }
```

with `function untilText(node) { const seconds = Math.max(0, Math.round((Date.parse(node.dataset.until) - Date.now()) / 1000)); return seconds > 0 ? "About " + clockText(seconds) + " left." : "Still checking."; }`
and the page's one-second timer also updates `[data-until]` nodes. (Phase 3 turns "Still checking."
into "Still there? Keep waiting" for the waits that end the run, FR-064.)

In `question-copy.ts`:

```ts
  { kind: "form", text: /^Your Slack app's values$/, help: { label: "Paste four values from your Slack app", why: "Copy each one from the Slack page its hint names. They are saved in AWS Secrets Manager and never shown again.", submitLabel: "Check the values" } },
  { kind: "confirm", text: /^Paste the Slack values again\?$/, help: { label: "Paste the Slack values again?", why: "Nothing was saved. Copy each value from the Slack app you just made.", yesLabel: "Paste them again", noLabel: "Stop for now" } },
```

and the four field entries name their page: `--slack-client-id` why "On Basic Information, under App
Credentials: two numbers joined by a dot.", `--slack-client-secret` why "On Basic Information, under
App Credentials, next to the Client ID. Press Show, then copy it.", `--slack-signing-secret` why "On
Basic Information, under App Credentials, below the Client Secret. Press Show, then copy it.",
`--slack-bot-token` why "On OAuth & Permissions. It starts with xoxb-." (phase 1's examples stay).
Phase 1's entry for "Paste the Slack bot token and signing secret again?" is removed with its
question.

- [ ] **Step 4: Scripts in the new order**

`tests/support/init-ui-harness.ts`:

```ts
export const SLACK_VALUES = JSON.stringify({ clientId: "1111111111.2222222222222", clientSecret: "fedcba9876543210fedcba9876543210", signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN });
export const SLACK = ["installed", SLACK_VALUES, true, true];
// The client pair is stored with the Slack values: developer sign-in asks only its method and its approval until Task 13.
export const SIGNIN = ["", true];
```

`tests/contract/init-cli.test.ts`:
`const SLACK = ["installed", "1111111111.2222222222222", "fedcba9876543210fedcba9876543210", TEST_SIGNING_SECRET, TEST_BOT_TOKEN, true, true];`
and `const SIGNIN = ["", true];`. A test that gave the Slack values by flags (`--slack-bot-token-file`
and the like) keeps its argv; its script loses only the values those flags answer. An `asked` list
that named "Slack app Client ID (Basic Information, App Credentials)" after the Slack service now
names it before the Signing Secret.

- [ ] **Step 5: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-slack-app.test.ts tests/contract/init-signin-step.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-ui-copy-lint.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

```bash
git add packages/cli/src tests
git commit -m "feat(init): one Slack visit with four values on one form, and an admin approval waits on the page (048 FR-033, FR-034, FR-036)"
```

---

### Task 13: Developer sign-in is turned on with the Slack connection, with no second approval (FR-030, FR-035)

**Files:**
- Modify: `packages/cli/src/init/signin-step.ts` (methods from the answers; no confirm question)
- Modify: `tests/support/init-ui-harness.ts`, `tests/contract/init-cli.test.ts` (`SIGNIN = []`)
- Test: `tests/contract/init-signin-step.test.ts`, `tests/contract/init-ui-cli.test.ts`

**Interfaces:**
- Consumes: Task 5's `signinMethods`, Task 12's stored client pair, phase 1's `applySignInChange`.
- Produces: `developerSignInStep` asks nothing on the default path; `"Apply this change?"` is never asked by `agentx init` (`agentx signin enable` keeps its own confirm, untouched).

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-signin-step.test.ts`:

```ts
describe("spec 048 FR-030: developer sign-in is part of the confirmed plan", () => {
  it("turns Slack sign-in on with the stored client values and asks nothing", async () => {
    const prompter = scriptedPrompter([]);
    const { context, progress, cloudFormation } = await signinContext({
      prompter, answers: sampleAnswers({ signinMethods: "slack" }),
      slackSecret: JSON.stringify({ botToken: TEST_BOT_TOKEN, signingSecret: TEST_SIGNING_SECRET, clientId: "1111111111.2222222222222", clientSecret: "fedcba9876543210fedcba9876543210" }),
    });
    await expect(developerSignInStep({ slack: fakeSlackApi() }).run(context, progress)).resolves.toMatchObject({ status: "done", note: "developer sign-in: Slack" });
    expect(prompter.asked).toEqual([]);
    expect(cloudFormation.executed).toHaveLength(1);
  });

  it("follows the methods the settings chose, and the --signin flag over them", async () => {
    const prompter = scriptedPrompter([]);
    const { context } = await signinContext({ prompter, answers: sampleAnswers({ signinMethods: "oidc" }), signinFlags: { methods: "slack" } });
    expect(context.signinFlags.methods ?? context.answers.signinMethods).toBe("slack");
  });
});
```

(`signinContext` is this file's builder; extend it with `answers`, `slackSecret`, `signinFlags`,
and return the fake CloudFormation it uses (`fakeCloudFormation`, whose executed change sets it
records; use its real field name).)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-signin-step.test.ts`
Expected: FAIL: the step asks "How will developers sign in to AgentX from their AI tools?" and "Apply this change?".

- [ ] **Step 3: Write minimal implementation**

In `signin-step.ts`:

```ts
      // Spec 048 FR-022 and FR-030: the methods were chosen with the settings, and turning them on
      // is part of the confirmed plan, so nothing is asked here. --signin still wins.
      const methods = context.signinFlags.methods ?? context.answers.signinMethods ?? "slack";
      // ...phase 1's enableSlackSignIn and enableOidcSignIn calls, unchanged: with the client pair
      // already stored by the Slack app step, enableSlackSignIn asks nothing...
      await applySignInChange({
        // ...phase 1's fields...
        // The plan said developer sign-in is turned on here (FR-030): the change is shown in the log, not asked.
        confirm: async (text) => { context.write(text); return true; },
      });
```

(For an install whose answers have no `signinMethods` (recorded before this phase) the default is
Slack, which is what phase 1's question defaulted to.)

- [ ] **Step 4: Scripts**

`SIGNIN = []` in `tests/support/init-ui-harness.ts` and `tests/contract/init-cli.test.ts`. A test that
answered "Apply this change?" with no tested a choice `agentx init` no longer offers (owner decision 1:
the plan is the approval). Keep the test and its other assertions, and replace the decline with the
new behavior's exact assertions: `expect(prompter.asked).not.toContain("Apply this change?")` and the
sign-in change applied (the fake CloudFormation's executed change set). `agentx signin enable`'s own
tests, which still decline, do not change.

- [ ] **Step 5: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-signin-step.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init/signin-step.ts tests
git commit -m "feat(init): developer sign-in is turned on with the Slack connection, with no second approval (048 FR-030, FR-035)"
```

---

### Task 14: The page opens first and shows the release download (FR-009)

**Files:**
- Modify: `packages/cli/src/init/release-fetch.ts` (`readWithProgress`; `fetchRelease` gains `onProgress`)
- Modify: `packages/cli/src/init/ui/cards.ts` (`releaseCard`), `ui/protocol.ts` (`CardId` gains `"release"`), `ui/journey.ts` (`CARD_PHASES.release = "get-started"`)
- Modify: `packages/cli/src/init/commands.ts:480-542` (the page starts before the release is fetched)
- Test: `tests/contract/init-release-fetch.test.ts`, `tests/contract/init-ui-cards.test.ts`, `tests/contract/init-ui-cli.test.ts`

**Interfaces:**
- Produces: `readWithProgress(response: Response, onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void): Promise<Buffer>`;
  `fetchRelease(input: { ...phase 1's; onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void })`;
  `releaseCard(input: { stage: "downloading"; receivedBytes: number; totalBytes?: number } | { stage: "ready" }): WizardCard` (id `"release"`).

- [ ] **Step 1: Write the failing tests**

Add to `tests/contract/init-release-fetch.test.ts`:

```ts
describe("spec 048 FR-009: the download's progress", () => {
  const streamOf = (chunks: number[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const size of chunks) controller.enqueue(new Uint8Array(size)); controller.close(); } });

  it("reports bytes received against the size", async () => {
    const seen: Array<{ receivedBytes: number; totalBytes?: number }> = [];
    const body = await readWithProgress(new Response(streamOf([400, 600]), { headers: { "content-length": "1000" } }), (progress) => seen.push(progress));
    expect(body.length).toBe(1000);
    expect(seen).toEqual([{ receivedBytes: 400, totalBytes: 1000 }, { receivedBytes: 1000, totalBytes: 1000 }]);
  });

  it("Review Focus 5: no content-length shows megabytes, never NaN or more than 100", async () => {
    const seen: Array<{ receivedBytes: number; totalBytes?: number }> = [];
    await readWithProgress(new Response(streamOf([1_500_000, 1_500_000])), (progress) => seen.push(progress));
    expect(seen.every((progress) => progress.totalBytes === undefined)).toBe(true);
    expect(releaseCard({ stage: "downloading", ...seen.at(-1)! }).lines).toEqual(["Downloading AgentX: 3.0 MB so far."]);
    // A header that undercounts never passes 100%.
    expect(releaseCard({ stage: "downloading", receivedBytes: 5_000_000, totalBytes: 4_000_000 }).lines).toEqual(["Downloading AgentX (about 4.0 MB): 100% done."]);
    for (const line of releaseCard({ stage: "downloading", receivedBytes: 0, totalBytes: 0 }).lines) expect(line).not.toMatch(/NaN|Infinity/);
  });
});
```

Add to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("FR-009: the page is open before the release is fetched, so a failed download is a failure screen", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([]);
    const missing: typeof fetch = async () => new Response("not found", { status: 404 });
    // No --release: the CLI fetches its own published release, which is not there.
    const code = await executeCli(["--env", "staging", "init", "--region", "us-east-1", "--ui"], {
      stdout: { write: () => undefined }, stderr: { write: (text: string) => h.err.push(text) }, environments: { home: h.home },
      init: { ...h.base, releaseVersion: "9.9.9", fetch: missing, openBrowser: operator.open },
    });
    await operator.settled();
    expect(code).not.toBe(0);
    expect(operator.states.some((state) => state.failure?.what.includes("release 9.9.9 was not found"))).toBe(true);
    expect(h.err.join("")).toMatch(/^The AgentX installer is open in your browser: http:\/\/127\.0\.0\.1:/m);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-release-fetch.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL: `readWithProgress` is not exported; the release is fetched before the page exists.

- [ ] **Step 3: Write minimal implementation**

In `release-fetch.ts`:

```ts
/** Spec 048 FR-009: reads a download, saying how much has arrived. With no usable content-length
 * there is no total, and the page shows megabytes received instead of a percentage. */
export async function readWithProgress(response: Response, onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void): Promise<Buffer> {
  if (onProgress === undefined || response.body === null) return Buffer.from(await response.arrayBuffer());
  const header = Number(response.headers.get("content-length") ?? "");
  const totalBytes = Number.isFinite(header) && header > 0 ? header : undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.byteLength;
    onProgress({ receivedBytes, ...(totalBytes === undefined ? {} : { totalBytes }) });
  }
  return Buffer.concat(chunks);
}
```

`download(fetchImplementation, url, version, onProgress?)` ends with
`return readWithProgress(response, onProgress);`, and `fetchRelease` passes its `onProgress` to the
tarball's download only (the manifest is a few kilobytes).

In `cards.ts`:

```ts
const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(1);

/** FR-009: the release download, on the page, with its size and progress. */
export function releaseCard(input: { stage: "downloading"; receivedBytes: number; totalBytes?: number } | { stage: "ready" }): WizardCard {
  const base = { id: "release" as const, title: "Getting AgentX ready" };
  if (input.stage === "ready") return { ...base, status: "ok", lines: ["AgentX is ready to install."] };
  const total = input.totalBytes !== undefined && input.totalBytes > 0 ? input.totalBytes : undefined;
  const line = total === undefined
    ? `Downloading AgentX: ${megabytes(input.receivedBytes)} MB so far.`
    : `Downloading AgentX (about ${megabytes(total)} MB): ${Math.min(100, Math.floor((input.receivedBytes / total) * 100))}% done.`;
  return { ...base, status: "running", lines: [line] };
}
```

In `commands.ts`, move phase 1's `resolveUiMode` block, the log file and `startInstallWizard`
(lines 509-545) above the release block (lines 482-507); none of it reads the release. Then the
release fetch shows its card:

```ts
    let shown = "";
    const onProgress = (progress: { receivedBytes: number; totalBytes?: number }) => {
      const card = releaseCard({ stage: "downloading", ...progress });
      // One card per whole percent (or tenth of a megabyte), not one per network chunk.
      if (card.lines[0] !== shown) { shown = card.lines[0] ?? ""; session.wizard?.surface.card(card); }
    };
    release = await loadRelease(options.releaseDir ?? (await fetchRelease({ version, home: services.home, fetch: fetchImplementation, runner, write, ...(session.wizard === undefined ? {} : { onProgress }) })));
    session.wizard?.surface.card(releaseCard({ stage: "ready" }));
```

(The prerelease refusal and every check that reads the release stay after it, unchanged. A release
given with `--release` shows the ready card at once.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-release-fetch.test.ts tests/contract/init-ui-cards.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS, including phase 1's "without --release, a CLI built from source says to pass
--release" (resolving the page mode reads no AWS).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init tests/contract
git commit -m "feat(init): open the page before the release download, and show the download on it (048 FR-009)"
```

---

### Task 15: What a child process asks of the user appears on the page (FR-038)

**Files:**
- Create: `packages/cli/src/init/ui/child-actions.ts` (`childActionWatcher`)
- Modify: `packages/cli/src/init/ui/cards.ts` (`awsSignInCard`), `ui/protocol.ts` (`CardId` gains `"aws-signin"`), `ui/journey.ts` (`CARD_PHASES["aws-signin"] = "get-started"`)
- Modify: `packages/cli/src/init/commands.ts` (`session.output` feeds the watcher with the page open)
- Modify: `packages/cli/src/init/aws-account.ts` (the sign-in card is marked done when the sign-in returns)
- Create: `tests/contract/init-ui-child-actions.test.ts`

**Interfaces:**
- Produces: `interface ChildAction { url?: string; code?: string }`;
  `childActionWatcher(onAction: (action: ChildAction) => void): { feed(text: string): void }`;
  `awsSignInCard(input: ChildAction & { done?: boolean }): WizardCard` (id `"aws-signin"`).

The AWS CLI's `aws sso login` prints "open the following URL:" then the address, and (device code
flow) "Then enter the code:" then a code such as `ABCD-EFGH`. Only an `https://` address that
`isShowableLink` accepts, and a code of that shape, ever leave the watcher.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-child-actions.test.ts
// Spec 048 FR-038 and SC-002: a sign-in a child process asks for is on the page, not only in the log.
import { describe, expect, it } from "vitest";
import { realCommandRunner } from "../../packages/cli/src/deploy/commands.js";
import { awsSignInCard } from "../../packages/cli/src/init/ui/cards.js";
import { childActionWatcher, type ChildAction } from "../../packages/cli/src/init/ui/child-actions.js";

const DEVICE = [
  "Attempting to automatically open the SSO authorization page in your default browser.",
  "If the browser does not open or you wish to use a different device to authorize this request, open the following URL:",
  "",
  "https://device.sso.us-east-1.amazonaws.com/",
  "",
  "Then enter the code:",
  "",
  "WXYZ-ABCD",
  "",
].join("\n");
const PKCE = "If the browser does not open, open the following URL:\n\nhttps://oidc.us-east-1.amazonaws.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53001%2Foauth%2Fcallback\n";

describe("the child action watcher", () => {
  it("finds the sign-in address and code of aws sso login, across chunk boundaries", () => {
    const seen: ChildAction[] = [];
    const watcher = childActionWatcher((action) => seen.push(action));
    for (let index = 0; index < DEVICE.length; index += 7) watcher.feed(DEVICE.slice(index, index + 7));
    expect(seen.at(-1)).toEqual({ url: "https://device.sso.us-east-1.amazonaws.com/", code: "WXYZ-ABCD" });
  });

  it("finds the address of the newer sign-in, which has no code", () => {
    const seen: ChildAction[] = [];
    childActionWatcher((action) => seen.push(action)).feed(PKCE);
    expect(seen).toEqual([{ url: "https://oidc.us-east-1.amazonaws.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A53001%2Foauth%2Fcallback" }]);
  });

  it("ignores an address no line asked the user to open, and anything that is not https", () => {
    const seen: ChildAction[] = [];
    const watcher = childActionWatcher((action) => seen.push(action));
    watcher.feed("Deploying https://example.com/stack\nopen the following URL:\nhttp://insecure.example.com/\n");
    expect(seen).toEqual([]);
  });

  it("shows a card with the link and the code, and a done card after", () => {
    expect(awsSignInCard({ url: "https://device.sso.us-east-1.amazonaws.com/", code: "WXYZ-ABCD" })).toEqual({
      id: "aws-signin", title: "Sign in to AWS", status: "waiting",
      lines: ["AWS asks you to approve this sign-in in your browser.", "Check that AWS shows this code: WXYZ-ABCD", "This page moves on by itself once you approve it."],
      link: { url: "https://device.sso.us-east-1.amazonaws.com/", label: "Open the AWS sign-in page" },
    });
    expect(awsSignInCard({ done: true })).toMatchObject({ status: "ok", lines: ["You are signed in to AWS."] });
  });

  it("works on a real child process's streamed output, while it is still running", async () => {
    const seen: ChildAction[] = [];
    const watcher = childActionWatcher((action) => seen.push(action));
    const runner = realCommandRunner({ write: (text: string) => { watcher.feed(text); } });
    const script = `process.stderr.write(${JSON.stringify(DEVICE)}); setTimeout(() => {}, 200);`;
    const running = runner.run(process.execPath, ["-e", script], { cwd: process.cwd(), display: "aws sso login" });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    expect(seen.at(-1)?.code).toBe("WXYZ-ABCD");
    await running;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-child-actions.test.ts`
Expected: FAIL: `child-actions.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/init/ui/child-actions.ts
// Spec 048 FR-038: anything the user must act on that a child process prints (an AWS sign-in
// address and code) is shown on the page, not only in the log file. Only an https:// address the
// page may show, after a line that asks the user to open it, and a code of AWS's shape, are passed on.
import { isShowableLink } from "./state.js";

export interface ChildAction { url?: string; code?: string }

const OPEN_LINE = /open the following URL/i;
const CODE_PROMPT = /enter the code/i;
const URL_LINE = /^https:\/\/\S+$/;
const CODE_LINE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

export function childActionWatcher(onAction: (action: ChildAction) => void): { feed(text: string): void } {
  let partial = "";
  let wantUrl = false;
  let wantCode = false;
  const found: ChildAction = {};
  return {
    feed(text) {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (line === "") continue;
        if (OPEN_LINE.test(line)) { wantUrl = true; continue; }
        if (CODE_PROMPT.test(line)) { wantCode = true; continue; }
        if (wantUrl && URL_LINE.test(line) && isShowableLink(line)) { found.url = line; wantUrl = false; onAction({ ...found }); continue; }
        if (wantCode && CODE_LINE.test(line)) { found.code = line; wantCode = false; onAction({ ...found }); continue; }
        wantUrl = false;
        wantCode = false;
      }
    },
  };
}
```

In `cards.ts`:

```ts
/** FR-038: an AWS sign-in a child process started (aws sso login), on the page. */
export function awsSignInCard(input: ChildAction & { done?: boolean }): WizardCard {
  const base = { id: "aws-signin" as const, title: "Sign in to AWS" };
  if (input.done === true) return { ...base, status: "ok", lines: ["You are signed in to AWS."] };
  return {
    ...base, status: "waiting",
    lines: ["AWS asks you to approve this sign-in in your browser.", ...(input.code === undefined ? [] : [`Check that AWS shows this code: ${input.code}`]), "This page moves on by itself once you approve it."],
    ...(input.url === undefined ? {} : { link: { url: input.url, label: "Open the AWS sign-in page" } }),
  };
}
```

In `commands.ts`, `session.output` with the page open writes the log file and feeds a watcher made
when the wizard starts:

```ts
    output: { write: (text: string) => {
      if (session.wizard === undefined) return services.stderr.write(text);
      session.watcher?.feed(text);
      return session.log?.write(text);
    } },
// after startInstallWizard:
    session.watcher = childActionWatcher((action) => wizard.surface.card(awsSignInCard(action)));
```

(`InitSession` gains `watcher?: { feed(text: string): void }`.) In `resolveCaller`, after the
sign-in command returns without error: `surface?.card(awsSignInCard({ done: true }));`, so the waiting
card never holds the tab title on "(Action needed)" after the sign-in.

Before committing, run `aws sso login --help` and, if the installed AWS CLI has it, `aws login --help`,
on a machine that has them: if `aws login` prints its address after a line worded differently from
"open the following URL", add that wording to `OPEN_LINE` with a test built from its real output. This
step is a check of the real tool's words, not a test run.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-child-actions.test.ts tests/contract/init-aws-account.test.ts tests/contract/init-ui-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init tests/contract/init-ui-child-actions.test.ts
git commit -m "feat(init): an AWS sign-in a child process asks for is shown on the page (048 FR-038)"
```

---

### Task 16: The same order without a browser, the whole journey, the docs, then the gate (FR-072, SC-006, SC-015)

**Files:**
- Create: `tests/contract/init-ui-order.test.ts`
- Modify: `tests/contract/init-ui-copy-lint.test.ts` (phase 1's question count, pinned)
- Modify: `docs/install.md` ("The install page" section)
- Test: the whole suite and the gate

**Interfaces:**
- Consumes: every task above; `SETTINGS_TITLE`, `settingsFields`, `SLACK_VALUES_TITLE`, `slackValuesFields`, `ADVANCED_QUESTION`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-order.test.ts
// Spec 048 FR-031, FR-035, FR-072, SC-006 and SC-015: the page and the terminal ask in the same
// order and run the same early checks; once the build starts, only Connect Slack and Finish wait.
import { describe, expect, it } from "vitest";
import { ADMIN_EMAIL } from "../support/setup-fakes.js";
import { passingChecks, scriptedPrompter, settingsScript } from "../support/init-fakes.js";
import { FINISH, FIRST_RUN, harness, SIGNIN, SLACK } from "../support/init-ui-harness.js";
import { fakeWizardOperator } from "../support/wizard-browser.js";
import { ADVANCED_QUESTION } from "../../packages/cli/src/init/prompts.js";
import { SETTINGS_TITLE, settingsFields } from "../../packages/cli/src/init/settings-form.js";
import { SLACK_VALUES_TITLE, slackValuesFields } from "../../packages/cli/src/init/slack-app.js";

const TERMINAL_SLACK = ["installed", "1111111111.2222222222222", "fedcba9876543210fedcba9876543210", "0123456789abcdef0123456789abcdef", "xoxb-test", true, true];

/** The terminal's questions, with each form's own questions folded into the form's title, as the page asks them. */
function folded(asked: readonly string[]): string[] {
  const settings = new Set([...settingsFields({ env: "staging", flags: {}, fixed: false, budgetWhy: "" }).map((field) => field.question), ADVANCED_QUESTION]);
  const slack = new Set(slackValuesFields({ client: true, secretFlags: {}, signinFlags: {} }).map((field) => field.question));
  const out: string[] = [];
  for (const question of asked) {
    const title = settings.has(question) ? SETTINGS_TITLE : slack.has(question) ? SLACK_VALUES_TITLE : question;
    if (out.at(-1) !== title || (title !== SETTINGS_TITLE && title !== SLACK_VALUES_TITLE)) out.push(title);
  }
  return out;
}

describe("the install's order", () => {
  it("FR-072 and SC-015: the terminal asks the same questions in the same order as the page", async () => {
    const page = await harness();
    const { operator } = await page.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const terminal = await harness();
    const prompter = scriptedPrompter([...settingsScript({ email: ADMIN_EMAIL, owner: "acme", advanced: { alertEmail: "ops@example.com" } }), true, ...TERMINAL_SLACK, ...FINISH]);
    expect(await terminal.run(["--no-ui"], { prompter })).toBe(0);
    expect(folded(prompter.asked)).toEqual(operator.asked);
  });

  it("FR-018, FR-028 and FR-072: both run the account checks before the settings, and the answer checks before the plan", async () => {
    for (const mode of ["page", "terminal"] as const) {
      const h = await harness();
      const events: string[] = [];
      const checks = passingChecks({ ec2Quota: async () => { events.push("account"); return 32; }, converse: async () => { events.push("answers"); } });
      const mark = (question: string) => { if (question === SETTINGS_TITLE || question.startsWith("Your email")) events.push("settings"); if (question === "Create all of this?") events.push("plan"); };
      if (mode === "page") {
        const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH], { beforeAnswer: async (question) => mark(question.text) });
        expect(await h.run(["--ui"], { openBrowser: operator.open, checks })).toBe(0);
        await operator.settled();
      } else {
        const inner = scriptedPrompter([...settingsScript({ email: ADMIN_EMAIL, owner: "acme", advanced: { alertEmail: "ops@example.com" } }), true, ...TERMINAL_SLACK, ...FINISH]);
        const prompter = { ...inner, ask: (q: string, o: Parameters<typeof inner.ask>[1]) => { mark(q); return inner.ask(q, o); }, confirm: (q: string, o: Parameters<typeof inner.confirm>[1]) => { mark(q); return inner.confirm(q, o); } };
        expect(await h.run(["--no-ui"], { prompter, checks })).toBe(0);
      }
      const first = (name: string) => events.indexOf(name);
      expect({ mode, order: [first("account"), first("settings"), first("answers"), first("plan")].every((at, index, all) => at >= 0 && (index === 0 || at > (all[index - 1] ?? -1))) }).toEqual({ mode, order: true });
    }
  });

  it("FR-035 and SC-006: once the build starts, the run waits only in Connect Slack and Finish", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const built = operator.states.findIndex((state) => state.steps.some((step) => step.id === "access" && step.status !== "pending"));
    expect(built).toBeGreaterThan(0);
    const waitingAfter = operator.states.slice(built).filter((state) => state.question !== undefined || state.waitingOnYou);
    expect(waitingAfter.length).toBeGreaterThan(0);
    for (const state of waitingAfter) expect(["connect-slack", "finish"]).toContain(state.journey.current);
  });

  it("FR-031: before the build the page asks only the settings and the plan, and the GitHub app is made then", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    const built = operator.states.findIndex((state) => state.steps.some((step) => step.id === "access" && step.status !== "pending"));
    const before = [...new Set(operator.states.slice(0, built).flatMap((state) => (state.question === undefined ? [] : [state.question.text])))];
    expect(before).toEqual([SETTINGS_TITLE, "Create all of this?"]);
    expect(operator.states[built - 1]?.steps.find((step) => step.id === "github-app")?.status).toBe("done");
  });
});
```

(`TERMINAL_SLACK`'s Signing Secret and token must be the harness's `TEST_SIGNING_SECRET` and
`TEST_BOT_TOKEN`: import them from `init-fakes.ts` instead of the literals above if they differ.)

In `tests/contract/init-ui-copy-lint.test.ts`, phase 1's FR-010 test counts the questions of a first
install with `expect(questions.size).toBeGreaterThan(20)`. The settings form and the Slack form now
hold most of them, so the count is pinned exactly instead:

```ts
    // The settings form, the plan, the Slack installed question, the Slack form, the bot check, the
    // Verified check, then the eight finishing questions (repository, project name, commands,
    // channel, three trackers, the test alert).
    expect(questions.size).toBe(14);
```

If the run asks a number other than 14, stop and report which questions differ: do not change the
number to match.

- [ ] **Step 2: Run tests to verify they pass or show what is missing**

Run: `npx vitest run tests/contract/init-ui-order.test.ts tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS once Tasks 1 to 15 are in. A failure names the question or check out of order; fix the
code, never the expected order.

- [ ] **Step 3: Update `docs/install.md`**

In "The install page" (under "With published templates (recommended)"), replace the paragraphs that
walk through the questions with this order, in the doc's own voice:

```markdown
The page walks you through five parts, and tells you when it needs you:

1. **Get started.** The page opens first and shows AgentX downloading. You pick the AWS profile (only
   when you have more than one), see the account you are signed in to, and pick the region. AgentX
   then checks the account: EC2 capacity, Elastic IPs and Amazon Bedrock in that region.
2. **Your choices.** One settings screen: your email, the GitHub owner, the install name and the app
   name. Everything else has a recommended value under Advanced settings. AgentX checks your answers
   (the models, the release's images, the names, the GitHub owner) before anything is created, then
   shows the plan with its cost. Press Create AgentX, or Change answers to go back with every answer
   kept. Then you create and install the GitHub app.
3. **Build in AWS.** About 18 minutes, unattended. You can leave; the alert confirmation email
   arrives during this part.
4. **Connect Slack.** One visit: create the Slack app, then paste its Client ID, Client Secret,
   Signing Secret and Bot User OAuth Token on one form. Developer sign-in is turned on with the
   Slack connection, as the plan said.
5. **Finish.** Your admin sign-in, the first project and channel, alerts, and a first reply.

Without a browser (`--no-ui`, SSH, CI) the terminal asks in the same order and runs the same checks;
it asks the Advanced settings only if you answer yes to "Change the advanced settings?".
```

- [ ] **Step 4: Run the gate**

```bash
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
npm run typecheck:all && npm run lint && npm run build && npm test && npm run infra:synth
```

Expected: every command passes; `typecheck:all` reports no more errors than the baseline;
`git status tests/contract/__snapshots__` shows no change. Then
`grep -rn "$(printf '\342\200\224')" packages/cli/src docs/install.md specs/048-guided-install tests/contract tests/support`
prints nothing (no em dashes).

- [ ] **Step 5: Commit**

```bash
git add tests/contract/init-ui-order.test.ts tests/contract/init-ui-copy-lint.test.ts docs/install.md
git commit -m "test(init): the terminal asks in the page's order with the same early checks; docs for the new order (048 FR-072, SC-006, SC-015)"
```

---

## Self-Review

**1. Spec coverage (phase 2 row of the spec's Phases table):**

| Requirement | Task |
|---|---|
| FR-009 page opens before the release download; download on the page with size and progress | 14 |
| FR-015 profile only when more than one (phase 1), then account ID, alias and who, before the region; region help and CLI default (phase 1) | 4 |
| FR-018 account checks (region support is FR-028's for the templates engine; EC2 vCPU quota, Elastic IPs, Amazon Bedrock) right after the region | 4 |
| FR-020 one settings screen, Recommended summary, the four default-path fields, owner type detected | 2, 3, 6 |
| FR-021 every other setting under Advanced, the worker model a choice, none required | 2, 3, 6 |
| FR-022 admin and developer sign-in under "How people sign in" | 2, 3, 6 |
| FR-025 alerts to your email by default; off in Advanced with its sentence; subscribed as soon as the topic exists | 6, 11 |
| FR-028 answer checks: models and the Anthropic form, images, name lengths, clashing stacks or apps, the GitHub owner | 7 (model and image checks are phase 1's, now run after the settings) |
| FR-029 the plain plan, three-column cost table, Show every resource, Create AgentX and Change answers, nothing created before | 8, 9 |
| FR-030 developer sign-in in the plan, no separate approval | 8, 13 |
| FR-031 the install order | 1, 4, 7, 8, 16 |
| FR-032 GitHub app before the build; a half-made app found on resume | 1, 10 |
| FR-033 one Slack form of four values in Slack's order, links and hints, the bot shown back by name | 12 |
| FR-034 the Request URL note up front (phase 1), the countdown, It shows Verified and It still shows an error | 12 |
| FR-035 after the build starts, waits only in Connect Slack and Finish | 1, 13, 16 |
| FR-036 admin approval: progress saved, the page waits, resume continues at this step | 12 (Ruling 2) |
| FR-038 a child process's sign-in on the page | 15 |
| FR-065 every late failure checked before anything is created; SC-009 a test per item | 4, 7 |
| FR-072 the no-UI path in the same order with the same checks, no pickers; `--yes` keeps working; SC-015 | 2, 6, 12, 16 |

Not in this phase, by the spec's table: FR-061 to FR-064, FR-066, FR-067 (recovery, phase 3: the
countdown here ends in "Still checking.", and an answer change after a failure is phase 3's), FR-002's
measured numbers, FR-007's build rows, FR-050 to FR-057 and FR-005's notification (phase 4). User
Story 4 scenario 1's "Change the worker image" page action is FR-061's (Ruling 7); this phase reports
the image problem before anything is created with "Change answers".

**2. Placeholder scan:** every code step has its code. Four steps are checks rather than code: Task
3's look in a browser, Task 6's reading of `EnvironmentNameSchema` and `DEFAULT_BEDROCK_MODELS.worker`,
Task 12's reading of `secretFromSource`'s question text, and Task 15's reading of the real AWS CLI's
words. Where a task extends a test file's existing builder (`githubContext`, `slackContext`,
`signinContext`, `finishContext`, `coveringRelease`), it names the builder and the options to add.

**3. Type consistency:** `INSTALL_STEP_ORDER` (Task 1) is what `initSteps` and the order tests use.
`FormField`'s `choices`, `section`, `group` and `FormOptions` (Task 2) are what `settingsFields`
(Task 6) and `slackValuesFields` (Task 12) build. `CollectedAnswers.settings` (Task 6) is Task 7's and
Task 9's `kept`. `WizardPlan` (Task 8) is the hub's `showPlan`, the page's `renderPlan` and the
copy-lint's input. `checkWithChangeOnPage` returns `"passed" | "change"` and `confirmInstallPlan`
returns `PlanAction`; both feed the one loop of Tasks 7 to 9. `CardId` gains `"account-checks"`
(Task 4), `"release"` (Task 14) and `"aws-signin"` (Task 15), each with its `CARD_PHASES` entry in the
same task, so `Record<CardId, JourneyPhaseId>` type-checks after every task.

**4. Review Focus:** each of the five lines has its pinned test in the named task (Tasks 12, 9, 7,
1, 14).

## Rulings On Spec Ambiguities

1. **"In the same deploy" means the same step run, with no question.** Developer sign-in's settings
   are parameters of the AgentX service stack (`infra/lib/developer-signin.ts`) and need the Slack
   workspace ID, known only after the Slack visit. So sign-in is a parameters-only update of that
   stack right after the Slack connection deploys, in the same unattended stretch, never a second
   approval (FR-030). Folding the parameters into the Slack stack would change what AgentX deploys,
   which this spec leaves alone.
2. **A Slack admin approval cannot be watched.** Slack issues no token until the app is installed,
   and nothing else says whether an approval happened. On the page the run waits on "Installed,
   continue" with the progress saved and a note that it can be left running; a stop resumes at the
   Slack step. The terminal and `--yes` keep phase 1's "waiting" end. FR-036's "continues by itself"
   needs Slack's manifest API (out of scope).
3. **The Slack field links go to the Slack app list.** The app's own ID, which a direct page link
   needs, is known only once the token is checked; `https://api.slack.com/apps` is one click from both
   pages that hold the values, and each field's hint names the page.
4. **The account alias needs `@aws-sdk/client-iam`** (pinned at `3.1134.0` like the other 16 AWS SDK
   clients). FR-015 says "account alias if any"; dropping the alias instead is the alternative, and
   Task 4 is the only place it changes.
5. **The install name is a settings field.** Changing it moves the install (answers, lock, stacks,
   commands on the page) to the new name; a name that already has an install or stacks here is
   refused by the answer checks with Change answers. The log file keeps the name the run started with,
   because its path was printed before the settings.
6. **The terminal asks the Advanced settings behind one question.** "Change the advanced settings?"
   (no takes every recommended value) keeps the terminal at the page's four questions. `--yes` answers
   yes and takes each default, so its answers do not change.
7. **"Change the worker image" stays phase 3's** (FR-061). Phase 2's answer-check failures offer
   Change answers, Check again and Stop for now; the image check itself runs before anything is
   created.
8. **The GitHub app name clash check is best effort.** GitHub shows an app by its slug only when it is
   public or yours, so the check catches public clashes; a private clash still fails at GitHub's own
   form, as today.
9. **`--yes` with an admin email and no alert flag now sends alerts to that email** (FR-025's
   default), where phase 1 refused for want of `--alert-email`. Every other `--yes` run is unchanged.

## Execution Handoff

Plan complete and saved to `specs/048-guided-install/plans/phase-2-order-and-checks.md`. Implementation
starts only after phase 1's PR has merged into mainline (no stacking). Please review the plan. Which
execution approach would you prefer?

- **Subagent-driven:** a fresh subagent implements each task and a fresh reviewer checks it before
  the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per
  task and per review.
- **Native:** one session implements every task, then one fresh reviewer on the most capable model
  checks the whole branch. Cheapest and fastest; no independent review until the end.

**Recommendation: subagent-driven**, because the 16 tasks build on each other's interfaces (the form
fields of Task 2 carry Tasks 6 and 12; the one settings, checks and plan loop spans Tasks 7 to 9), and
Tasks 6, 12 and 13 rewrite many existing test scripts, where a per-task reviewer is the cheapest way to
catch a weakened assertion before it ships.
