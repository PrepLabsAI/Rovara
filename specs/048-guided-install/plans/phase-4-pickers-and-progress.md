# Spec 048 Phase 4: Pickers and Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Build in AWS phase shows real progress, a wait tells you by notification instead of
only a tab title, the time estimates are measured rather than guessed, and the Finish phase asks for
the first project on one screen: its repository, its name, its setup and test commands, whether
AgentX should create its Slack channel (and if not, a searchable picker), and its issue trackers as
checkboxes - closing the live check's clearest "I can't answer this from the page" gap, the blank
channel box.

**Architecture:**
- **The channel question needs two new Slack bot scopes and four new Slack calls.** `channels:manage`
  and `groups:write` join the manifest (fixed at install time, so this phase adds them whether or not
  the install ever answers Yes). `SlackChannelApi` gains `create` (a channel, public or private),
  `invite` (one user into it), `list` (every channel the picker needs, reusing the pagination `find`
  already has), and a small `SlackUsersApi` sibling for `findByEmail` and a plain-text `search` the
  member-search fallback uses when the installer's email is not in the workspace.
- **One form replaces three separate questions.** `addProject`'s remaining ask (the project name),
  `addChannel`'s ask (today a bare channel name) and `connectorsStep`'s three sequential confirms
  become one `FormField[]` built by a new `project-form.ts`, on the same `askForm` machinery phase 2
  built for settings: the page shows it as one screen, the terminal asks the same fields in order.
  Two small, new things the form needs that settings never did: a checkbox field (`multi`, for the
  issue trackers, "Skip for now" is simply none checked) and a field shown only when another field has
  a particular value (`showWhen`, so the channel's name-and-visibility fields appear only after "Yes,
  create it" and the picker appears only after "No"). The repository is still chosen first, outside
  the form (its answer decides the project name's and the commands' defaults), exactly as today.
- **Creating a channel reuses the install's own invite pattern.** The install already waits for the
  bot to be invited to a private channel it cannot see (`addChannel`'s polling loop, the
  `channelCard`'s "waiting" stage, a copy-button invite command); the No path's picker, when it names
  a private channel the bot is not in, shows that same card up front rather than after a plain text
  box, and the Yes path's own new channel needs no such wait at all (the bot is the one creating it).
  Finding the installer to invite is email first (`users:read.email`, already in the manifest), a
  plain-text member search when that fails (FR-051's own fallback).
- **Build progress is read from CloudFormation, not invented.** `DeployEvent` carries no per-resource
  count today (a "changes" event only says how many changes a stack's change set has). A lightweight
  poller, run alongside each deploy step while it is `"deploying"`, counts resources whose status
  ends `_COMPLETE` against the "changes" event's own count, and a new `WizardCard` row (one per
  `DeployPart`, not one per `InitStepId` - `core` deploys two stacks and gets two rows) shows it.
- **A notification is one more thing a card-free state transition can do.** The welcome screen's new
  "Notify me when AgentX needs me" button asks the browser's permission once; the client already
  recomputes `waitingOnYou` on every state push, so firing `new Notification(...)` is a one-line
  addition exactly where the tab title already changes, not a new state machine.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Vitest 5, zod 4. No new dependency. The
page stays plain HTML, CSS and an ES module held as text in `page.ts` (spec 040).

**Spec:** [../spec.md](../spec.md), the binding authority. This plan delivers the spec's Phases row
4: FR-002 (measured numbers), FR-007, FR-050 to FR-053, FR-055 to FR-057, and FR-005's notification,
with SC-005 (at most 4 values copied by hand, unaffected by this phase but checked again here since
the channel step is where the invite command is one of them).

**Builds on:** phases 1 to 3 (`specs/048-guided-install/plans/phase-1-page-shell.md`,
`phase-2-order-and-checks.md`, `phase-3-recovery.md`), merged into `mainline` before this phase's
branch is cut. Every interface this plan consumes is phase 2's and phase 3's as implemented there:
`INSTALL_STEP_ORDER`, `STEP_PLAN`, `SETTINGS_FIELD`, `FormField` with `choices`/`section`/`group`/
`link`, `FormOptions`, `askForm`, `WizardField`, `WizardQuestion.summary`/`submitLabel`,
`checkWithChangeOnPage`, `retryOnPage`, `waitWithCheckIn`, `ANSWER_DEPENDS_ON`, `canChangeAnswer`,
`WizardCard.waitLabel`, `WizardState.continueCommand`, `DEPLOY_STEP_PARTS`, `StackStatusReader`. If
an earlier phase's review renamed anything this plan names here, use the merged name and say so in
the PR description; never re-create an earlier phase's name under its old spelling.

**Branch:** `feat/048-phase4-pickers-and-progress`, cut from `origin/mainline` **only after phase 3's
PR has merged into mainline**. One PR against `mainline` (no stacking).

## Global Constraints

- **Start only after phase 3 merges.** Before Task 1: `git fetch origin`, confirm
  `git log origin/mainline --oneline | grep "048 FR-063"` (or whatever commit phase 3's review
  renamed it to) shows phase 3's work, then cut the branch from `origin/mainline`.
- **Recorded installs still resume.** `INIT_STEP_IDS` and `INSTALL_STEP_ORDER` keep their order.
  `InstallProgressSchema`'s `project` object gains only optional fields (none here - this phase does
  not change what is recorded about a project, only how it is asked for and what Slack API calls
  back it).
- **The Slack manifest change needs a reinstall note, not a silent scope bump.** Slack fixes a bot's
  scopes at install time; an app installed before this phase ships has neither `channels:manage` nor
  `groups:write` until it is reinstalled. This phase's docs task says so; the channel step itself
  only ever asks for the two new scopes on a fresh install (an existing install's Slack app secret is
  never touched by this phase).
- **The terminal path and `--yes` keep every flag and its meaning**, with the deliberate, listed
  changes FR-072 and Ruling 1 below spell out: the project screen's fields are asked in the page's
  order (repository, then name, setup command, test command, "create the channel?", its name and
  visibility or the picker answer, then the connector checkboxes as one comma-separated flag exactly
  as `--connectors` already is); every existing `--yes` test that passes `--channel <name>` keeps
  working (Ruling 1 says how).
- **Exact names (nothing later depends on them - this is the last of the four phases):**
  `SlackChannelApi.create`, `SlackChannelApi.invite`, `SlackChannelApi.list`, `SlackUsersApi`,
  `project-form.ts`'s `PROJECT_FORM_FIELD`, `projectFormFields`, `FormField.multi`,
  `FormField.showWhen`, `resourceCounts` on `StackStatusReader`, `buildProgressCard`.
- **Never print a secret.** No new secret is introduced in this phase; the bot token already in scope
  for every new Slack call is the same one `addChannel` already uses, never logged or echoed.
- **Security rules of spec 040 hold:** loopback only, the session token, origin checks, secrets never
  echoed.
- **Copy:** plain words from the glossary (FR-080); no internal words, no em dashes. Page text never
  tells the user to pass a flag, run a command or read the terminal outside "Stop for now", the lost
  connection notice and the ready screen (FR-081); the channel invite command (`/invite @<bot
  handle>`) is Slack's own command, typed into Slack, not the AgentX CLI, so it is not one of those
  exceptions and is not refused by the copy-lint either (confirm this against `lintCopy`'s actual
  rule before relying on it - see Task 9).
- **Look:** every new screen element uses the design system's tokens and classes (`design.ts`); a new
  class (the checkbox field, the search box, the progress row) is added to `PAGE_CLASSES` and styled
  there; no inline style, no external asset.
- **Do not touch** `infra/` or any CloudFormation template, except reading the identity stack's
  Cognito message configuration to quote its real sender and subject in Task 11 - reading only, no
  edit.
- **Tests:** never `vitest -u`; no assertion removed or weakened.
- **Typecheck ratchet:** `npm run typecheck:all` must not report more errors than the baseline.
- **The gate**, on Node 22: `npm run typecheck:all && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH` (or any
    Node 22.19 or later on PATH).
  - While iterating on one task, run only its test files with `npx vitest run <files>`.
- **No AWS, GitHub or Slack calls from tests.** Every new dependency (`SlackChannelApi.create`/
  `invite`/`list`, `SlackUsersApi`, the CloudFormation resource-count read) is injected and faked.
- **PRs:** one PR to `mainline`, never stacked, never force-pushed.
- **Commits:** each commit's trailer names the model that wrote it
  (`Co-Authored-By: <model> <noreply@anthropic.com>`); no em dashes anywhere a commit touches.
- **Build process:** the owner approves this plan, then picks the execution method. Implementers and
  reviewers run on Sonnet; only the final whole-branch review runs on Opus.

## Review Focus

1. **Creating a channel whose name is already taken.** Expected: the page says so and offers to use
   that channel or pick another name (FR-051's own edge case), never a raw Slack error. Pinned in
   Task 8 ("a taken channel name offers to use it or pick another").
2. **The installer's email is not in the workspace.** Expected: the page falls back to a plain member
   search rather than silently skipping the invite or failing the whole step. Pinned in Task 8 ("an
   email Slack does not know falls back to a member search").
3. **A private channel named in the No-path picker that the bot is not a member of.** Expected: the
   invite command and copy button show before the operator is asked to continue, not after a
   generic wait, and detecting the join does not re-ask anything. Pinned in Task 9 ("a private
   channel the bot is not in shows the invite command before you continue").
4. **A no-UI run that still only passes `--channel <name>`**, the only flag that existed before this
   phase. Expected: it behaves exactly as it does today (asks nothing else about the channel,
   searches for that name, waits for the bot). Pinned in Task 10 ("an unchanged `--channel` flag
   keeps today's behavior").
5. **A stack whose change set has zero changes** (a resume that reaches an already-current stack).
   Expected: its progress row shows done at 0 of 0, never a divide-by-zero percentage or a row stuck
   at "0 of 0" forever. Pinned in Task 3 ("a no-changes stack's row reads done, not stuck at zero").

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/init/ui/journey.ts` | `STEP_PLAN`'s `usualSeconds` replaced with measured values |
| `packages/cli/src/init/ui/page.ts` | The notification button and its firing; the build progress rows; the checkbox field and `showWhen`; the picker's search box |
| `packages/cli/src/init/ui/protocol.ts` | `WizardField.multi`, `WizardField.showWhen`; a build-progress shape on `WizardStep` or a dedicated card (Task 3 decides) |
| `packages/cli/src/init/prompts.ts` | `FormField.multi`, `FormField.showWhen` |
| `packages/cli/src/init/slack-app.ts` | `SLACK_BOT_SCOPES` gains `channels:manage`, `groups:write` |
| `packages/cli/src/setup/channel-add.ts` | `SlackChannelApi.create`, `.invite`, `.list`; shared pagination extracted from `find` |
| `packages/cli/src/setup/slack-users.ts` (new) | `SlackUsersApi`: `findByEmail`, `search` |
| `packages/cli/src/setup/services.ts` | `SetupServices.slackUsers` |
| `packages/cli/src/init/project-form.ts` (new) | `PROJECT_FORM_FIELD`, `projectFormFields`, the one-screen form |
| `packages/cli/src/init/finish-steps.ts` | `firstProjectStep` and `connectorsStep` merge into one step driven by the new form; `adminCard`'s and `replyCard`'s small copy additions |
| `packages/cli/src/init/ui/cards.ts` | `channelCard` gains the Yes-path "created" stage and the No-path "picker" stage's invite-up-front case; `adminCard` names the expected email; `replyCard` names the app too |
| `packages/cli/src/init/ui/question-copy.ts` | Copy for every new question this phase asks |
| `packages/cli/src/init/deploy-steps.ts` | The resource-count poller alongside `deployStep`'s own deploy call |
| `packages/cli/src/init/context.ts` | `StackStatusReader.resourceCounts?` |
| `packages/cli/src/init/commands.ts` | Wires `cloudFormationStatusReader`'s real `resourceCounts`; wires the welcome screen's notification flag through to the hub (nothing to compute server-side beyond what already exists) |
| `docs/install.md` | The project and channel section; measured times note |
| `tests/contract/init-ui-journey.test.ts`, `init-ui-page.test.ts`, `init-slack-app.test.ts`, `init-channel-add.test.ts` (or extend `init-finish-steps.test.ts` - check which file already covers `channel-add.ts` before creating a duplicate), `init-slack-users.test.ts` (new), `init-project-form.test.ts` (new), `init-finish-steps.test.ts`, `init-ui-cards.test.ts`, `init-deploy-steps.test.ts`, `init-ui-copy-lint.test.ts` | Tests for every module above |

## Interfaces Later Phases Rely On

None: this is the last of the four phases. After this phase merges, the spec's own next step is one
live end-to-end check (SC-005 to SC-008, SC-010, SC-013, SC-014, SC-016) and an update to specs 040
and 015, not another phase plan.

---

### Task 1: Measured time estimates replace the first guesses (FR-002)

**Files:**
- Modify: `packages/cli/src/init/ui/journey.ts` (`STEP_PLAN`'s `usualSeconds`)
- Test: `tests/contract/init-ui-journey.test.ts`

**Interfaces:**
- Consumes: phase 2's `STEP_PLAN: Readonly<Record<InitStepId, StepPlan>>`.
- Produces: the same shape, new numbers.

- [ ] **Step 1: Write the failing test**

```ts
it("spec 048 FR-002: every usual time comes from a measured run, not a guess", () => {
  // Two clean runs' measured seconds, rounded up to the next 10 seconds (plain, readable numbers).
  // Replace each placeholder below with the real pair of timings once two clean runs exist; this
  // test is the record of what was measured, not a tautology against the implementation.
  const measured: Record<InitStepId, [number, number]> = {
    prerequisites: [28, 31], "github-app": [95, 142], access: [41, 58], core: [201, 267],
    "control-plane": [612, 734], "slack-app": [187, 239], "slack-service": [96, 158],
    "developer-signin": [58, 71], "admin-user": [84, 119], "first-project": [93, 131],
    connectors: [22, 41], alerts: [38, 52], e2e: [19, 33],
  };
  for (const [id, [low, high]] of Object.entries(measured) as Array<[InitStepId, [number, number]]>) {
    expect(STEP_PLAN[id].usualSeconds).toBeGreaterThanOrEqual(Math.round(low / 10) * 10);
    expect(STEP_PLAN[id].usualSeconds).toBeLessThanOrEqual(Math.round(high / 10) * 10 + 10);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts`
Expected: FAIL (or PASS by coincidence against phase 1's placeholder numbers - if so, this step still
confirms the test shape is right before Step 3 changes the numbers for real).

- [ ] **Step 3: Run two clean installs and record their times**

This step has no code of its own: run `agentx init` twice against a clean AWS account (or use the
CI's own install smoke test's timing output, if one logs step durations already - check
`tests/contract/init-cli.test.ts` and any integration job in `.github/workflows/ci.yml` before
assuming none exists), note each step's wall-clock seconds, and replace Step 1's placeholder
`measured` table with the real numbers before implementing.

- [ ] **Step 4: Write the implementation**

In `journey.ts`'s `STEP_PLAN`, replace each `usualSeconds` with the measured pair's higher value,
rounded up to the next 10 seconds (so a step that finishes early never reads "taking longer than
usual" on a borderline run), updating the doc comment above `STEP_PLAN` from "First estimates from
the live run of 2026-10-01" to "Measured on two clean runs, `<date>` (FR-002)".

- [ ] **Step 5: Update every other test whose expected total or per-phase time Task 1 changes**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts tests/contract/init-ui-hub.test.ts tests/contract/init-cli.test.ts` and read each failure; every expected total minutes, phase seconds, or
"About N minutes left" string this task's new numbers change gets its new exact value (never a
looser match in its place).

- [ ] **Step 6: Run the suite, then commit**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts tests/contract/init-ui-hub.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init/ui/journey.ts tests/contract/init-ui-journey.test.ts
git commit -m "feat(init): time estimates come from two measured clean runs, not the first guess (048 FR-002)"
```

---

### Task 2: "Notify me when AgentX needs me" (FR-005)

**Files:**
- Modify: `packages/cli/src/init/ui/page.ts` (the welcome screen's button; the notification fire)
- Modify: `packages/cli/src/init/ui/design.ts` (any new class the button needs, if `PAGE_CLASSES` does not already cover it)
- Test: `tests/contract/init-ui-page.test.ts`

**Interfaces:**
- Consumes: the existing `render(state)` function's `waitingOnYou`/`pageTitle` logic (the tab-title
  change this phase's notification rides beside).
- Produces: nothing new exported from TypeScript - this is entirely inside the `WIZARD_JS` string.

- [ ] **Step 1: Write the failing tests**

```ts
it("FR-005: the welcome screen offers to notify, asks permission once, and never on a page that denied it", () => {
  expect(WIZARD_JS).toContain('"Notify me when AgentX needs me"');
  expect(WIZARD_JS).toContain("Notification.requestPermission");
});

it("FR-005: fires only on the transition into waiting, after an unattended wait, never on every render", () => {
  expect(WIZARD_JS).toContain("new Notification(");
  // The transition guard: a previous render's waitingOnYou was false and this one's is true.
  expect(WIZARD_JS).toMatch(/wasWaiting\s*=\s*false/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-page.test.ts`
Expected: FAIL: no such button or notification code exists yet.

- [ ] **Step 3: Write minimal implementation**

In `wizardHtml`'s welcome section, add a button:

```html
<button type="button" id="notify-me" class="button">Notify me when AgentX needs me</button>
```

In the client module:

```js
let notifyWanted = false;
let wasWaiting = false;
const notifyButton = byId("notify-me");
if (notifyButton) {
  if (typeof Notification === "undefined") notifyButton.disabled = true;
  notifyButton.addEventListener("click", async () => {
    const permission = typeof Notification === "undefined" ? "denied" : await Notification.requestPermission();
    notifyWanted = permission === "granted";
    notifyButton.textContent = notifyWanted ? "You will be notified" : "Notifications are off";
    notifyButton.disabled = true;
  });
}
```

In `render(state)`, after the existing `pageTitle`/`waitingOnYou` handling:

```js
  if (state.waitingOnYou && !wasWaiting && notifyWanted && typeof Notification !== "undefined" && Notification.permission === "granted") {
    new Notification("AgentX needs you", { body: state.question ? (state.question.label ?? state.question.text) : "Open the installer to continue." });
  }
  wasWaiting = state.waitingOnYou;
```

(`wasWaiting` starts `false` so the very first render, before anything has run, never fires one; the
guard is the transition itself, matching FR-005's "after an unattended wait" - a wait that was
already showing when the tab regained focus does not re-fire on every subsequent state push, only on
the edge.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/page.ts tests/contract/init-ui-page.test.ts
git commit -m "feat(init): a browser notification fires when the run starts waiting on you (048 FR-005)"
```

---

### Task 3: Real build progress, one row per deploy part (FR-007)

**Files:**
- Modify: `packages/cli/src/init/context.ts` (`StackStatusReader.resourceCounts?`)
- Modify: `packages/cli/src/init/deploy-steps.ts` (the poller)
- Modify: `packages/cli/src/init/ui/cards.ts` (`buildProgressCard`)
- Modify: `packages/cli/src/init/ui/page.ts` (renders the new card's rows; "You can leave now" line)
- Test: `tests/contract/init-deploy-steps.test.ts`, `tests/contract/init-ui-cards.test.ts`

**Interfaces:**
- Consumes: `DEPLOY_STEP_PARTS`, `DeployEvent` (its `"changes"` event's `changes.length` as the
  expected count), `StackStatusReader`.
- Produces:
  ```ts
  // context.ts
  export interface StackStatusReader {
    status(stackName: string): Promise<string | undefined>;
    parameters?(stackName: string): Promise<Record<string, string> | undefined>;
    /** Spec 048 FR-007: resources this stack's latest update has finished, out of `total` (the most
     * recent change set's size). undefined total means no change set has been seen yet (nothing to
     * count against). */
    resourceCounts?(stackName: string): Promise<{ done: number; total: number } | undefined>;
  }
  ```
  ```ts
  // ui/cards.ts
  export interface BuildProgressRow { part: string; title: string; status: "pending" | "deploying" | "done"; startedAt?: string; usualSeconds: number; resourcesDone?: number; resourcesTotal?: number }
  export function buildProgressCard(rows: readonly BuildProgressRow[]): WizardCard;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-deploy-steps.test.ts
it("spec 048 FR-007: polls resource counts while deploying, and shows done at 0 of 0 for a no-changes stack", async () => {
  const reads: Array<{ done: number; total: number } | undefined> = [{ done: 3, total: 10 }, { done: 10, total: 10 }];
  const reader = {
    status: async () => undefined,
    resourceCounts: async () => reads.shift(),
  };
  const context = initContext({ stackStatus: reader });
  const rows: BuildProgressRow[] = [];
  context.surface = { card: (card) => { if (card.id === "build-progress") rows.push(...(card.rows ?? [])); } };
  const step = deployStep({ id: "core", title: "Build the network and sign-in" });
  await step.run(context, progressHandle());
  const foundation = rows.find((row) => row.part === "foundation");
  expect(foundation?.resourcesDone).toBe(10);
  expect(foundation?.resourcesTotal).toBe(10);
});

it("a stack with no change set yet (a no-changes event) shows done, not a stuck 0 of 0", async () => {
  // Drive a deployer that emits "no-changes" instead of "changes", then "deployed"; assert the
  // row for that stack reads status "done" with resourcesTotal 0 and resourcesDone 0, and the
  // page's percentage math (Task 3 Step 3 below) treats 0 of 0 as 100%, not NaN.
});
```

```ts
// tests/contract/init-ui-cards.test.ts
it("one row per deploy part, with elapsed, usual and resources done", () => {
  const card = buildProgressCard([
    { part: "foundation", title: "Network", status: "deploying", startedAt: "2026-10-02T00:00:00.000Z", usualSeconds: 240, resourcesDone: 3, resourcesTotal: 10 },
    { part: "identity", title: "Sign-in", status: "pending", usualSeconds: 60 },
  ]);
  expect(card.rows).toHaveLength(2);
  expect(card.rows?.[0]).toMatchObject({ part: "foundation", resourcesDone: 3, resourcesTotal: 10 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-deploy-steps.test.ts tests/contract/init-ui-cards.test.ts`
Expected: FAIL: `resourceCounts`, `buildProgressCard` and `WizardCard.rows` do not exist.

- [ ] **Step 3: Write minimal implementation**

In `protocol.ts`, `WizardCard` gains `rows?: BuildProgressRow[]` (or a dedicated `WizardState.build`
array, if a card feels like the wrong carrier once written - decide based on how `renderPanelCards`
already treats `cards`, and keep the one that needs the least special-casing there).

In `ui/cards.ts`:

```ts
export interface BuildProgressRow { part: string; title: string; status: "pending" | "deploying" | "done"; startedAt?: string; usualSeconds: number; resourcesDone?: number; resourcesTotal?: number }

export function buildProgressCard(rows: readonly BuildProgressRow[]): WizardCard {
  return { id: "build-progress", title: "Build in AWS", status: "running", lines: ["You can leave now. AgentX tells you when it needs you next."], rows: [...rows] };
}
```

In `deploy-steps.ts`'s `deployStep`, alongside `deployEnvironment`'s call, start a poller per part
(cleared once the whole step settles):

```ts
      const totals = new Map<string, number>();
      const onDeployEvent = (event: DeployEvent) => {
        if (event.kind === "changes") totals.set(event.stackName, event.changes.length);
        if (event.kind === "no-changes") totals.set(event.stackName, 0);
        context.write(progressLine(event));
      };
      let polling = true;
      const poll = async () => {
        while (polling) {
          const rows = await Promise.all(parts.map(async (part): Promise<BuildProgressRow> => {
            const stackName = environmentStackName(env, part);
            const total = totals.get(stackName);
            const counts = total === undefined || total === 0 ? undefined : await context.stackStatus.resourceCounts?.(stackName);
            return {
              part, title: DEPLOY_PART_TITLES[part] ?? part, status: total === undefined ? "pending" : "deploying",
              usualSeconds: STEP_PLAN[input.id].usualSeconds,
              ...(total === undefined ? {} : { resourcesTotal: total, resourcesDone: total === 0 ? 0 : (counts?.done ?? 0) }),
            };
          }));
          context.surface?.card(buildProgressCard(rows));
          if (!polling) break;
          await context.sleep(5000);
        }
      };
      const pollPromise = poll();
```

(`DEPLOY_PART_TITLES` is a small new lookup from `DeployPart` to a plain name, e.g. `foundation` ->
"The network", `identity` -> "Sign-in", `control-plane` -> "The AgentX service", `runtime` -> "The
coding machines" - reuse `STEP_PLAN`'s own titles where a part maps one-to-one to a step, and add new
ones only for a part with no step of its own.) Stop the poller (`polling = false; await pollPromise;`)
in a `finally` once `deployEnvironment` settles, and mark every row for this step's parts `"done"`
with `resourcesDone` equal to `resourcesTotal` (or `0`/`0` for a part whose total was `0`) in one
final `buildProgressCard` call.

In `commands.ts`'s `cloudFormationStatusReader`, add:

```ts
    async resourceCounts(stackName) {
      try {
        const resources = (await client.send(new DescribeStackResourcesCommand({ StackName: stackName }))).StackResources ?? [];
        return { done: resources.filter((resource) => (resource.ResourceStatus ?? "").endsWith("_COMPLETE")).length, total: resources.length };
      } catch {
        return undefined;
      }
    },
```

(`DescribeStackResourcesCommand` from `@aws-sdk/client-cloudformation`, already a dependency; a
failed read is swallowed, not thrown, since a progress row with stale or missing counts is far better
than a build step failing over a progress poll.)

In `page.ts`'s client module, `renderCard` (or a small sibling function) draws `card.rows` as one line
per row: `title + ": " + (status === "done" ? "Done" : resourcesTotal ? resourcesDone + " of " + resourcesTotal + " resources" : "Starting") + " (usually " + ... + ")"`, guarding the percentage math
so `resourcesTotal === 0` reads "Done" rather than computing `0/0`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-deploy-steps.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/context.ts packages/cli/src/init/deploy-steps.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/page.ts packages/cli/src/init/commands.ts tests/contract/init-deploy-steps.test.ts tests/contract/init-ui-cards.test.ts
git commit -m "feat(init): the Build in AWS phase shows one row per part, with resources done (048 FR-007)"
```

---

### Task 4: The channel scopes join the manifest (FR-053)

**Files:**
- Modify: `packages/cli/src/init/slack-app.ts` (`SLACK_BOT_SCOPES`)
- Test: `tests/contract/init-slack-app.test.ts`

**Interfaces:**
- Consumes/Produces: `SLACK_BOT_SCOPES: readonly string[]`, widened.

- [ ] **Step 1: Write the failing test**

```ts
it("spec 048 FR-053: the manifest always asks for the channel-creation scopes", () => {
  expect(SLACK_BOT_SCOPES).toContain("channels:manage");
  expect(SLACK_BOT_SCOPES).toContain("groups:write");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-slack-app.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
export const SLACK_BOT_SCOPES: readonly string[] = [
  "app_mentions:read", "channels:join", "channels:manage", "channels:read", "chat:write", "groups:read", "groups:write", "im:write", "users:read", "users:read.email",
];
```

Update the comment above it to name FR-053 and the two new scopes' purpose (creating public and
private channels).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-slack-app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/slack-app.ts tests/contract/init-slack-app.test.ts
git commit -m "feat(init): the Slack manifest always asks for channels:manage and groups:write (048 FR-053)"
```

---

### Task 5: `SlackChannelApi` gains create, invite and list; a `SlackUsersApi` for the invite (FR-051)

**Files:**
- Modify: `packages/cli/src/setup/channel-add.ts` (`create`, `invite`, `list`; `find` reuses the new
  shared pagination)
- Create: `packages/cli/src/setup/slack-users.ts`
- Modify: `packages/cli/src/setup/services.ts` (`SetupServices.slackUsers`)
- Modify: `packages/cli/src/init/commands.ts` (`realSetupServices` builds it)
- Test: `tests/contract/init-channel-add.test.ts` (check for an existing test file covering
  `channel-add.ts` first - likely `init-finish-steps.test.ts` already exercises `addChannel`; add
  these cases there if so, rather than creating a duplicate file), `tests/contract/init-slack-users.test.ts` (new)

**Interfaces:**
- Consumes: the existing `SlackChannelApi.find`'s pagination, `call()`'s error handling.
- Produces:
  ```ts
  export interface SlackChannelApi {
    find(token: string, name: string): Promise<SlackChannel | undefined>;
    /** Spec 048 FR-052: every public channel, and every private one the bot is already in. */
    list(token: string): Promise<SlackChannel[]>;
    join(token: string, channelId: string): Promise<void>;
    /** Spec 048 FR-051: conversations.create. Throws SlackNameTakenError on name_taken. */
    create(token: string, name: string, isPrivate: boolean): Promise<SlackChannel>;
    /** Spec 048 FR-051: conversations.invite, one user. */
    invite(token: string, channelId: string, userId: string): Promise<void>;
  }
  export class SlackNameTakenError extends AgentXError { constructor(name: string) { /* ... */ } }
  ```
  ```ts
  // slack-users.ts
  export interface SlackUser { id: string; name: string; realName?: string; email?: string }
  export interface SlackUsersApi {
    /** users.lookupByEmail. undefined when Slack has no member with that address. */
    findByEmail(token: string, email: string): Promise<SlackUser | undefined>;
    /** users.list, filtered client-side (Slack's Web API has no name search) by a case-insensitive
     * substring of name or realName; every page, same limits as SlackChannelApi.list. */
    search(token: string, query: string): Promise<SlackUser[]>;
  }
  export function slackUsersApi(fetchImplementation: typeof fetch): SlackUsersApi;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("spec 048 phase 4: creating, inviting and listing Slack channels (FR-051, FR-052)", () => {
  it("create makes a channel and returns it; a taken name throws SlackNameTakenError", async () => {
    const fetchImpl = jsonFetch({ "conversations.create": { ok: false, error: "name_taken" } });
    const api = slackChannelApi(fetchImpl);
    await expect(api.create("token", "payments", false)).rejects.toBeInstanceOf(SlackNameTakenError);
  });

  it("create succeeds and returns the new channel's id, name and visibility", async () => {
    const fetchImpl = jsonFetch({ "conversations.create": { ok: true, channel: { id: "C1", name: "payments", is_private: false } } });
    const api = slackChannelApi(fetchImpl);
    await expect(api.create("token", "payments", false)).resolves.toEqual({ id: "C1", name: "payments", isPrivate: false, isMember: true });
  });

  it("invite calls conversations.invite with the one user", async () => {
    const calls: string[] = [];
    const fetchImpl = jsonFetch({ "conversations.invite": { ok: true } }, calls);
    await slackChannelApi(fetchImpl).invite("token", "C1", "U1");
    expect(calls[0]).toContain("conversations.invite");
  });

  it("list returns every public channel and every private one the bot is in, across pages", async () => {
    const fetchImpl = jsonFetch({
      "conversations.list": { ok: true, channels: [{ id: "C1", name: "general", is_private: false, is_member: true }, { id: "G1", name: "secret", is_private: true, is_member: true }] },
    });
    await expect(slackChannelApi(fetchImpl).list("token")).resolves.toEqual([
      { id: "C1", name: "general", isPrivate: false, isMember: true },
      { id: "G1", name: "secret", isPrivate: true, isMember: true },
    ]);
  });
});
```

```ts
// tests/contract/init-slack-users.test.ts
describe("spec 048 phase 4: finding the installer by email or by a plain search (FR-051)", () => {
  it("findByEmail returns the member, or undefined when Slack has none", async () => {
    const api = slackUsersApi(jsonFetch({ "users.lookupByEmail": { ok: true, user: { id: "U1", name: "alice", real_name: "Alice A", profile: { email: "alice@example.com" } } } }));
    await expect(api.findByEmail("token", "alice@example.com")).resolves.toEqual({ id: "U1", name: "alice", realName: "Alice A", email: "alice@example.com" });
    const none = slackUsersApi(jsonFetch({ "users.lookupByEmail": { ok: false, error: "users_not_found" } }));
    await expect(none.findByEmail("token", "nobody@example.com")).resolves.toBeUndefined();
  });

  it("search filters users.list by a case-insensitive substring of name or real name", async () => {
    const api = slackUsersApi(jsonFetch({ "users.list": { ok: true, members: [{ id: "U1", name: "alice", real_name: "Alice Anderson" }, { id: "U2", name: "bob", real_name: "Bob Baker" }] } }));
    await expect(api.search("token", "ali")).resolves.toEqual([{ id: "U1", name: "alice", realName: "Alice Anderson" }]);
  });
});
```

(`jsonFetch` is a small new test helper - a `typeof fetch` that answers each Slack method name with
the given body and records the URL called; write it once in `tests/support/` if no equivalent exists,
reusing `slackIngressFetch`'s shape in `init-fakes.ts` as a model.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-channel-add.test.ts tests/contract/init-slack-users.test.ts`
Expected: FAIL: none of the new methods exist.

- [ ] **Step 3: Write minimal implementation**

In `channel-add.ts`, extract the pagination `find` already has into a shared `listAll`:

```ts
async function listAll(call: (method: string, token: string, params: Record<string, string>) => Promise<Record<string, unknown>>, token: string): Promise<SlackChannel[]> {
  const found: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const body = await call("conversations.list", token, { types: "public_channel,private_channel", exclude_archived: "true", limit: String(LIST_PAGE_SIZE), ...(cursor === "" ? {} : { cursor }) });
    const channels = (Array.isArray(body.channels) ? body.channels : []) as Array<{ id: string; name: string; is_private?: boolean; is_member?: boolean }>;
    found.push(...channels.map((channel) => ({ id: channel.id, name: channel.name, isPrivate: channel.is_private === true, isMember: channel.is_member === true })));
    cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
    if (cursor === "") return found;
  }
  throw agentXError("CONFIG_INVALID", `the workspace has more than ${MAX_LIST_PAGES * LIST_PAGE_SIZE} channels to list; search by name instead`);
}
```

`find` becomes `(await listAll(call, token)).find((channel) => channel.name === name)` (keep its
existing early-return-per-page shape only if a profiling concern argues for it; correctness-first
here, since a workspace needing 50 pages of channels is already an extreme case `find`'s own comment
acknowledges).

```ts
export class SlackNameTakenError extends AgentXError {
  constructor(readonly name: string) { super("CONFIG_INVALID", `a channel named #${name} already exists`, errorStatus("CONFIG_INVALID")); }
}

// in slackChannelApi's returned object:
    list: (token) => listAll(call, token),
    async create(token, name, isPrivate) {
      try {
        const body = await call("conversations.create", token, { name, is_private: String(isPrivate) });
        const channel = body.channel as { id: string; name: string; is_private?: boolean };
        return { id: channel.id, name: channel.name, isPrivate: channel.is_private === true, isMember: true };
      } catch (error) {
        if (error instanceof AgentXError && /name_taken/.test(error.message)) throw new SlackNameTakenError(name);
        throw error;
      }
    },
    async invite(token, channelId, userId) {
      await call("conversations.invite", token, { channel: channelId, users: userId });
    },
```

`slack-users.ts`:

```ts
export function slackUsersApi(fetchImplementation: typeof fetch): SlackUsersApi {
  const call = /* same shape as channel-add.ts's call(); consider lifting it to a tiny shared
   * slack-web-call.ts both files import, rather than copying it a third time */;
  return {
    async findByEmail(token, email) {
      try {
        const body = await call("users.lookupByEmail", token, { email });
        const user = body.user as { id: string; name: string; real_name?: string; profile?: { email?: string } };
        return { id: user.id, name: user.name, ...(user.real_name === undefined ? {} : { realName: user.real_name }), ...(user.profile?.email === undefined ? {} : { email: user.profile.email }) };
      } catch (error) {
        if (error instanceof AgentXError && /users_not_found/.test(error.message)) return undefined;
        throw error;
      }
    },
    async search(token, query) {
      const needle = query.trim().toLowerCase();
      const found: SlackUser[] = [];
      let cursor = "";
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const body = await call("users.list", token, { limit: String(LIST_PAGE_SIZE), ...(cursor === "" ? {} : { cursor }) });
        const members = (Array.isArray(body.members) ? body.members : []) as Array<{ id: string; name: string; real_name?: string; deleted?: boolean; is_bot?: boolean }>;
        for (const member of members) {
          if (member.deleted === true || member.is_bot === true) continue;
          if (member.name.toLowerCase().includes(needle) || (member.real_name ?? "").toLowerCase().includes(needle)) {
            found.push({ id: member.id, name: member.name, ...(member.real_name === undefined ? {} : { realName: member.real_name }) });
          }
        }
        cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
        if (cursor === "") break;
      }
      return found;
    },
  };
}
```

(Decide in this step, not left for later, whether `call()` is worth lifting into one shared module
`channel-add.ts` and `slack-users.ts` both import - two independent, nearly identical private
functions is the kind of duplication the "File Structure" decomposition guidance warns against;
prefer one `slack-web-call.ts` with the shared `call` and both rate-limit types, and have both files
import it.)

In `services.ts`:

```ts
export interface SetupServices {
  // ...existing fields...
  /** Task (phase 4): finding the installer by email or name for the channel invite. */
  slackUsers: SlackUsersApi;
}
```

In `commands.ts`'s `realSetupServices`:

```ts
    slackUsers: slackUsersApi(input.fetch),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-channel-add.test.ts tests/contract/init-slack-users.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup/channel-add.ts packages/cli/src/setup/slack-users.ts packages/cli/src/setup/services.ts packages/cli/src/init/commands.ts tests/contract/init-channel-add.test.ts tests/contract/init-slack-users.test.ts
git commit -m "feat(setup): create and invite into a Slack channel, list channels, find a member by email or name (048 FR-051, FR-052)"
```

---

### Task 6: A form field can be a checkbox group, and shown only when another field answers a certain way (FR-050)

**Files:**
- Modify: `packages/cli/src/init/prompts.ts` (`FormField.multi`, `FormField.showWhen`; `askForm`'s terminal fallback)
- Modify: `packages/cli/src/init/ui/protocol.ts` (`WizardField.multi`, `WizardField.showWhen`)
- Modify: `packages/cli/src/init/ui/prompter.ts` (`form` builds and checks a `multi` field)
- Modify: `packages/cli/src/init/ui/page.ts` (renders checkboxes; shows/hides a field on change)
- Test: `tests/contract/init-ui-form.test.ts`, `tests/contract/init-prompts.test.ts`

**Interfaces:**
- Consumes: phase 2's `FormField`, `askForm`, `WizardField`.
- Produces: `FormField` gains `multi?: boolean` (its `choices` become checkboxes; the submitted value
  is a comma-joined list of checked values, `""` meaning none checked) and `showWhen?: { field:
  string; equals: string }` (the page hides the field, and does not require it, until the named
  field's current value equals `equals`; the terminal simply skips asking a field whose `showWhen`
  is not met, same rule).

- [ ] **Step 1: Write the failing tests**

```ts
describe("spec 048 phase 4: a checkbox field, and a field shown only conditionally (FR-050)", () => {
  const connectors: FormField = { name: "connectors", question: "Issue trackers", flag: "--connectors", multi: true, choices: [{ value: "linear", label: "Linear" }, { value: "jira", label: "Jira" }, { value: "asana", label: "Asana" }] };
  const mode: FormField = { name: "channelMode", question: "Create the channel?", flag: "--channel-mode", choices: [{ value: "create", label: "Yes" }, { value: "pick", label: "No" }] };
  const channelName: FormField = { name: "channelName", question: "Channel name", flag: "--channel", showWhen: { field: "channelMode", equals: "create" } };

  it("a checked set of checkboxes submits as a comma-joined value, none checked submits empty", async () => {
    const hub = createWizardHub("staging");
    const asked = browserPrompter(hub).form?.("Project", [connectors], {}) ?? Promise.reject(new Error("no form"));
    const id = hub.state().question?.id ?? "";
    expect(hub.answer(id, JSON.stringify({ connectors: "linear,asana" }))).toBeUndefined();
    await expect(asked).resolves.toEqual({ connectors: "linear,asana" });
  });

  it("a field with showWhen is not required until the named field matches, on the page and in the terminal", async () => {
    const hub = createWizardHub("staging");
    void browserPrompter(hub).form?.("Project", [mode, channelName], {});
    const question = hub.state().question;
    expect(question?.fields?.find((field) => field.name === "channelName")).toMatchObject({ showWhen: { field: "channelMode", equals: "create" } });

    const prompter = scriptedPrompter(["pick"]); // channelMode answered "pick"; channelName must not be asked
    await expect(askForm(prompter, "Project", [mode, channelName])).resolves.toEqual({ channelMode: "pick", channelName: "" });
    expect(prompter.asked).toEqual(["Create the channel?"]);
  });
});
```

```ts
it("spec 048 phase 4: WIZARD_JS renders checkboxes for a multi field and toggles showWhen fields on change", () => {
  expect(WIZARD_JS).toContain('field.multi');
  expect(WIZARD_JS).toContain("showWhen");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-form.test.ts tests/contract/init-prompts.test.ts`
Expected: FAIL: `multi` and `showWhen` do not exist.

- [ ] **Step 3: Write minimal implementation**

In `prompts.ts`'s `FormField`:

```ts
  /** FR-050: checkboxes instead of one choice; the value submitted is every checked value, joined
   * by commas, or "" when none are checked. */
  multi?: boolean;
  /** FR-050: shown (and required) only once `field` (another field in the same form) equals this
   * value; otherwise hidden on the page and skipped in the terminal, and answered "" whichever way. */
  showWhen?: { field: string; equals: string };
```

`askForm`'s terminal fallback skips a field whose `showWhen` is not met by the values collected so
far:

```ts
  const met = (field: FormField) => field.showWhen === undefined || values[field.showWhen.field] === field.showWhen.equals;
  // ...inside each of the two existing loops (default-path and advanced), wrap the per-field work:
  for (const field of fields.filter((each) => each.section !== "advanced")) {
    values[field.name] = met(field) ? await askField(prompter, field, start(field)) : "";
  }
```

(Apply the identical `met(field)` guard to the advanced loop.)

In `protocol.ts`, `WizardField` gains the same two fields, typed identically.

In `ui/prompter.ts`'s `form`, `toField` passes `multi`/`showWhen` through unchanged (both are plain
data, not something that needs translating), and the posted-value check for a `multi` field accepts
any comma-joined subset of its `choices`' values rather than exactly one:

```ts
      const multiCheck = (field: FormField): AnswerCheck => (raw) => {
        const picked = raw === "" ? [] : raw.split(",");
        return picked.every((value) => field.choices?.some((choice) => choice.value === value)) ? { value: raw } : { error: "choose from the options" };
      };
```

(Wire it into the existing per-field `check` selection alongside `choiceCheck`/`secretCheck`/
`askCheck`, keyed on `field.multi === true`.)

In `page.ts`'s client module, `fieldInput`/`buildForm` render a `multi` field as a stack of checkbox
`<input type="checkbox">` elements (one `<label>` per choice, matching the existing `.choices` class
already styled for radios) whose combined `input.value` getter joins the checked ones; and a field
with `showWhen` starts hidden (or shown) based on the named field's current value and every
`change`/`input` listener on that named field re-evaluates every dependent field's visibility (a
small, generic pass over `question.fields` after any field's value changes, not a bespoke handler per
field name).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-form.test.ts tests/contract/init-prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/prompts.ts packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/prompter.ts packages/cli/src/init/ui/page.ts tests/contract/init-ui-form.test.ts tests/contract/init-prompts.test.ts
git commit -m "feat(init): a form field can be checkboxes, or shown only when another field answers a certain way (048 FR-050)"
```

---

### Task 7: The project screen's fields, as one form (FR-050)

**Files:**
- Create: `packages/cli/src/init/project-form.ts`
- Test: `tests/contract/init-project-form.test.ts` (new)

**Interfaces:**
- Consumes: Task 6's `FormField.multi`/`showWhen`; `project-files.ts`'s `proposeCommands`.
- Produces:
  ```ts
  export const PROJECT_FORM_TITLE = "Your first project";
  export const PROJECT_FORM_FIELD = {
    name: "name", setupCommand: "setupCommand", testCommand: "testCommand",
    channelMode: "channelMode", channelName: "channelName", channelVisibility: "channelVisibility", channelPicked: "channelPicked", channelOther: "channelOther",
    connectors: "connectors",
  } as const;
  export function projectFormFields(input: { defaultName: string; proposedSetup?: string; proposedTest?: string; channelChoices: ReadonlyArray<{ value: string; label: string }> }): FormField[];
  ```

- [ ] **Step 1: Write the failing test**

```ts
describe("spec 048 FR-050: the project screen's fields, in the page's order", () => {
  it("lists every field this screen needs, with the channel fields conditional on channelMode", () => {
    const fields = projectFormFields({ defaultName: "payments-api", proposedSetup: "npm ci", proposedTest: "npm test", channelChoices: [{ value: "general", label: "#general" }] });
    expect(fields.map((field) => field.name)).toEqual([
      PROJECT_FORM_FIELD.name, PROJECT_FORM_FIELD.setupCommand, PROJECT_FORM_FIELD.testCommand,
      PROJECT_FORM_FIELD.channelMode, PROJECT_FORM_FIELD.channelName, PROJECT_FORM_FIELD.channelVisibility,
      PROJECT_FORM_FIELD.channelPicked, PROJECT_FORM_FIELD.channelOther, PROJECT_FORM_FIELD.connectors,
    ]);
    const channelName = fields.find((field) => field.name === PROJECT_FORM_FIELD.channelName);
    expect(channelName?.showWhen).toEqual({ field: PROJECT_FORM_FIELD.channelMode, equals: "create" });
    const channelPicked = fields.find((field) => field.name === PROJECT_FORM_FIELD.channelPicked);
    expect(channelPicked?.showWhen).toEqual({ field: PROJECT_FORM_FIELD.channelMode, equals: "pick" });
    const connectors = fields.find((field) => field.name === PROJECT_FORM_FIELD.connectors);
    expect(connectors?.multi).toBe(true);
    expect(connectors?.help?.hint ?? connectors?.hint).toMatch(/Skip for now/i);
  });

  it("prefills the name from the repository, and the commands from what was detected", () => {
    const fields = projectFormFields({ defaultName: "payments-api", proposedSetup: "npm ci", proposedTest: "npm test", channelChoices: [] });
    expect(fields.find((field) => field.name === PROJECT_FORM_FIELD.name)?.defaultValue).toBe("payments-api");
    expect(fields.find((field) => field.name === PROJECT_FORM_FIELD.setupCommand)?.defaultValue).toBe("npm ci");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-project-form.test.ts`
Expected: FAIL: `project-form.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { FormField } from "./prompts.js";

export const PROJECT_FORM_TITLE = "Your first project";
export const PROJECT_FORM_FIELD = {
  name: "name", setupCommand: "setupCommand", testCommand: "testCommand",
  channelMode: "channelMode", channelName: "channelName", channelVisibility: "channelVisibility",
  channelPicked: "channelPicked", channelOther: "channelOther", connectors: "connectors",
} as const;

const CHANNEL_MODE_CHOICES = [{ value: "create", label: "Yes, create it" }, { value: "pick", label: "No, use an existing one" }];
const VISIBILITY_CHOICES = [{ value: "public", label: "Public" }, { value: "private", label: "Private" }];

export function projectFormFields(input: {
  defaultName: string; proposedSetup?: string; proposedTest?: string; channelChoices: ReadonlyArray<{ value: string; label: string }>;
}): FormField[] {
  const onCreate = { field: PROJECT_FORM_FIELD.channelMode, equals: "create" };
  const onPick = { field: PROJECT_FORM_FIELD.channelMode, equals: "pick" };
  return [
    { name: PROJECT_FORM_FIELD.name, question: "Project name", flag: "--project-name", defaultValue: input.defaultName },
    { name: PROJECT_FORM_FIELD.setupCommand, question: "Setup command", flag: "--setup-command", defaultValue: input.proposedSetup ?? "" },
    { name: PROJECT_FORM_FIELD.testCommand, question: "Test command", flag: "--test-command", defaultValue: input.proposedTest ?? "" },
    { name: PROJECT_FORM_FIELD.channelMode, question: "Should AgentX create the channel for you?", flag: "--channel-create", defaultValue: "create", choices: CHANNEL_MODE_CHOICES },
    { name: PROJECT_FORM_FIELD.channelName, question: "Channel name", flag: "--channel", defaultValue: input.defaultName, showWhen: onCreate },
    { name: PROJECT_FORM_FIELD.channelVisibility, question: "Public or private?", flag: "--channel-visibility", defaultValue: "public", choices: VISIBILITY_CHOICES, showWhen: onCreate },
    { name: PROJECT_FORM_FIELD.channelPicked, question: "Which channel?", flag: "--channel", choices: [...input.channelChoices, { value: "other", label: "A channel not listed" }], showWhen: onPick },
    { name: PROJECT_FORM_FIELD.channelOther, question: "Channel name", flag: "--channel", defaultValue: "", showWhen: { field: PROJECT_FORM_FIELD.channelPicked, equals: "other" } },
    { name: PROJECT_FORM_FIELD.connectors, question: "Issue trackers", flag: "--connectors", multi: true, defaultValue: "", choices: [{ value: "linear", label: "Linear" }, { value: "jira", label: "Jira" }, { value: "asana", label: "Asana" }], help: { hint: "Optional. Skip for now and connect one later." } },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-project-form.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/project-form.ts tests/contract/init-project-form.test.ts
git commit -m "feat(init): the project screen's fields, as one form (048 FR-050)"
```

---

### Task 8: The channel's Yes path: create, and invite the installer (FR-051)

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts` (the merged first-project-and-channel step's Yes branch)
- Modify: `packages/cli/src/init/ui/cards.ts` (`channelCard`'s new "created"/"name-taken"/"find-yourself" stages)
- Modify: `packages/cli/src/init/ui/question-copy.ts`
- Test: `tests/contract/init-finish-steps.test.ts`

**Interfaces:**
- Consumes: Task 5's `SlackChannelApi.create`/`.invite`, `SlackUsersApi.findByEmail`/`.search`;
  Task 7's `projectFormFields`.
- Produces: a new `addOrPickChannel` function in `finish-steps.ts` (or kept in `channel-add.ts` -
  decide based on which module already owns `AdminSession`/`Prompter` wiring for this kind of call;
  `channel-add.ts` is the more consistent home, since `addChannel` already lives there) replacing
  `addChannel`'s single ask with the Yes/No branches this task and Task 9 build.

- [ ] **Step 1: Write the failing tests**

```ts
describe("spec 048 phase 4: creating a channel and inviting the installer (FR-051)", () => {
  it("creates the channel, and invites the installer found by email", async () => {
    const created: Array<[string, boolean]> = [];
    const invited: string[] = [];
    const slackChannels: SlackChannelApi = { ...fakeSlackChannelApi(), create: async (_t, name, isPrivate) => { created.push([name, isPrivate]); return { id: "C1", name, isPrivate, isMember: true }; }, invite: async (_t, _c, userId) => { invited.push(userId); } };
    const slackUsers: SlackUsersApi = { findByEmail: async () => ({ id: "U1", name: "alice" }), search: async () => [] };
    const result = await addOrPickChannel({
      mode: "create", name: "payments", isPrivate: false, installerEmail: "alice@example.com",
      botToken: "xoxb", teamId: "T1", botUserId: "UBOT", services: { slackChannels, slackUsers }, prompter: scriptedPrompter([]), write: () => undefined,
    });
    expect(created).toEqual([["payments", false]]);
    expect(invited).toEqual(["U1"]);
    expect(result).toEqual({ channelId: "C1", channelName: "payments" });
  });

  it("falls back to a member search when the installer's email is not in the workspace", async () => {
    const slackUsers: SlackUsersApi = { findByEmail: async () => undefined, search: async (_t, query) => (query === "alice" ? [{ id: "U9", name: "alice2" }] : []) };
    const invited: string[] = [];
    const slackChannels: SlackChannelApi = { ...fakeSlackChannelApi(), create: async (_t, name) => ({ id: "C1", name, isPrivate: false, isMember: true }), invite: async (_t, _c, userId) => { invited.push(userId); } };
    const prompter = scriptedPrompter(["alice", "U9"]); // the search term, then the chosen candidate
    await addOrPickChannel({ mode: "create", name: "payments", isPrivate: false, installerEmail: "alice@example.com", botToken: "xoxb", teamId: "T1", botUserId: "UBOT", services: { slackChannels, slackUsers }, prompter, write: () => undefined });
    expect(invited).toEqual(["U9"]);
  });

  it("a taken channel name offers to use it or pick another (Review Focus 1)", async () => {
    const slackChannels: SlackChannelApi = { ...fakeSlackChannelApi(), create: async (_t, name) => { throw new SlackNameTakenError(name); }, find: async (_t, name) => ({ id: "C2", name, isPrivate: false, isMember: true }) };
    const prompter = scriptedPrompter(["use"]);
    const result = await addOrPickChannel({ mode: "create", name: "payments", isPrivate: false, installerEmail: "alice@example.com", botToken: "xoxb", teamId: "T1", botUserId: "UBOT", services: { slackChannels, slackUsers: fakeSlackUsersApi() }, prompter, write: () => undefined });
    expect(result).toEqual({ channelId: "C2", channelName: "payments" });
  });
});
```

(`fakeSlackChannelApi`/`fakeSlackUsersApi` are small new fakes in `tests/support/init-fakes.ts`,
each method throwing "test setup: not expected" by default so an override makes each test's intent
explicit.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts`
Expected: FAIL: `addOrPickChannel` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `channel-add.ts` (or `finish-steps.ts` - settle the home in this step and keep it consistent with
Task 9, which extends the same function):

```ts
export async function addOrPickChannel(input: {
  mode: "create"; name: string; isPrivate: boolean; installerEmail: string;
  botToken: string; teamId: string; botUserId: string;
  services: Pick<SetupServices, "slackChannels" | "slackUsers">; prompter: Prompter; write: (line: string) => void;
}): Promise<{ channelId: string; channelName: string }> {
  const name = channelName(input.name);
  let created: SlackChannel;
  try {
    created = await input.services.slackChannels.create(input.botToken, name, input.isPrivate);
  } catch (error) {
    if (!(error instanceof SlackNameTakenError)) throw error;
    const choice = await input.prompter.choose<"use" | "rename">(`#${name} already exists. Use it, or pick another name?`, [{ value: "use", label: "Use it" }, { value: "rename", label: "Pick another name" }], { flag: "--channel", defaultValue: "use" });
    if (choice === "rename") throw agentXError("CONFIG_INVALID", `#${name} is taken; choose another name with --channel`);
    const existing = await input.services.slackChannels.find(input.botToken, name);
    if (existing === undefined) throw agentXError("CONFIG_INVALID", `#${name} is taken, but AgentX cannot see it; ask a workspace admin to add the bot, then run agentx init again`);
    created = existing;
  }
  const user = await input.services.slackUsers.findByEmail(input.botToken, input.installerEmail)
    ?? await findYourselfBySearch(input.services.slackUsers, input.botToken, input.prompter);
  if (user !== undefined) await input.services.slackChannels.invite(input.botToken, created.id, user.id);
  else input.write(`Could not find you in this workspace to invite; join #${created.name} yourself.`);
  return { channelId: created.id, channelName: created.name };
}

async function findYourselfBySearch(api: SlackUsersApi, token: string, prompter: Prompter): Promise<SlackUser | undefined> {
  const query = await prompter.ask("Type part of your name or email to find yourself in this workspace", { flag: "--installer-search" });
  const matches = await api.search(token, query);
  if (matches.length === 0) return undefined;
  const choice = await prompter.choose<string>("Which one is you?", [...matches.map((match) => ({ value: match.id, label: match.realName ?? match.name })), { value: "none", label: "None of these" }], { flag: "--installer-user-id", defaultValue: matches[0]?.id ?? "none" });
  return choice === "none" ? undefined : matches.find((match) => match.id === choice);
}
```

In `ui/cards.ts`'s `ChannelCardInput`, add a `"created"` stage (status "ok", lines naming the channel
and whether the installer was invited or needs to join themselves), used by `firstProjectStep`'s
caller once `addOrPickChannel` returns.

In `question-copy.ts`, add entries for the new confirm/choose questions above (the taken-name choice,
the member-search ask and choose), each in plain words the page shows.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup/channel-add.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/ui/question-copy.ts tests/contract/init-finish-steps.test.ts
git commit -m "feat(init): creating a channel invites the installer, found by email or a plain search (048 FR-051)"
```

---

### Task 9: The channel's No path: a searchable picker, and the invite command up front for a private one (FR-052)

**Files:**
- Modify: `packages/cli/src/setup/channel-add.ts` (`addOrPickChannel`'s `"pick"` mode)
- Modify: `packages/cli/src/init/ui/page.ts` (the picker's search box)
- Modify: `packages/cli/src/init/ui/cards.ts` (the invite-up-front card, reusing `channelCard`'s
  existing "waiting" stage)
- Test: `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-ui-page.test.ts`

**Interfaces:**
- Consumes: Task 5's `SlackChannelApi.list`; Task 8's `addOrPickChannel`, `channelCard`.
- Produces: `addOrPickChannel`'s input gains a `{ mode: "pick"; picked: string }` variant.

- [ ] **Step 1: Write the failing tests**

```ts
it("spec 048 phase 4: picking an existing, already-joined channel needs no wait", async () => {
  const slackChannels: SlackChannelApi = { ...fakeSlackChannelApi(), find: async (_t, name) => ({ id: "C1", name, isPrivate: false, isMember: true }) };
  const result = await addOrPickChannel({ mode: "pick", picked: "general", botToken: "xoxb", teamId: "T1", botUserId: "UBOT", services: { slackChannels, slackUsers: fakeSlackUsersApi() }, prompter: scriptedPrompter([]), write: () => undefined });
  expect(result).toEqual({ channelId: "C1", channelName: "general" });
});

it("Review Focus 3: a private channel the bot is not in shows the invite command before you continue", async () => {
  const seen: ChannelCardInput[] = [];
  let calls = 0;
  const slackChannels: SlackChannelApi = { ...fakeSlackChannelApi(), find: async (_t, name) => { calls += 1; return calls < 2 ? undefined : { id: "G1", name, isPrivate: true, isMember: true }; } };
  const result = await addOrPickChannel({
    mode: "pick", picked: "secret", botToken: "xoxb", teamId: "T1", botUserId: "UBOT",
    services: { slackChannels, slackUsers: fakeSlackUsersApi() }, prompter: scriptedPrompter([]), write: () => undefined, sleep: async () => undefined, now: () => 0,
    onWaiting: (card) => seen.push(card),
  });
  expect(seen[0]).toMatchObject({ stage: "waiting", channelName: "secret" });
  expect(result).toEqual({ channelId: "G1", channelName: "secret" });
});
```

```ts
it("spec 048 FR-052: the channel picker filters as you type", () => {
  expect(WIZARD_JS).toContain("search-box");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-ui-page.test.ts`
Expected: FAIL: `addOrPickChannel` has no `"pick"` mode; the client has no search box.

- [ ] **Step 3: Write minimal implementation**

In `addOrPickChannel`, branch on `input.mode`:

```ts
export async function addOrPickChannel(input: AddOrPickChannelInput): Promise<{ channelId: string; channelName: string }> {
  if (input.mode === "create") { /* Task 8's body */ }
  const name = channelName(input.picked);
  const existing = await input.services.slackChannels.find(input.botToken, name);
  if (existing !== undefined) return { channelId: existing.id, channelName: existing.name };
  // Not visible yet: reuse addChannel's own wait-and-poll loop (FR-052's invite-up-front case is the
  // same wait, just reached from the picker instead of a bare text field).
  return waitForChannel({ ...input, name });
}
```

(`waitForChannel` is `addChannel`'s existing polling body, factored out so both the legacy bare-name
path - kept for `--channel <name>` under `--yes`, Review Focus 4 - and this picker path share it
rather than duplicating the loop. `onWaiting` fires immediately on the first not-found poll, which is
already how `addChannel` behaves today, satisfying "shown before you continue.")

In `project-form.ts`'s `projectFormFields`, the `channelChoices` passed in come from
`SlackChannelApi.list`, called once before building the form (public channels and private ones the
bot is in, per FR-052), with "A channel not listed" already appended by Task 7.

In `page.ts`'s client module, the picker's `choose` rendering gains a text `<input class="search-box">` above the radio list when `question.fields` (or the standalone `choose` question, whichever
carries the channel picker - confirm against how Task 7's form embeds it) has more than, say, 8
choices; its `input` listener hides every `<label>` whose visible text does not include the typed
substring (case-insensitive), pure client-side filtering of nodes already rendered.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-ui-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the copy-lint still passes with the invite command**

Run: `npx vitest run tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS - the `/invite @<handle>` command is Slack's own syntax, typed into Slack, which
`lintCopy`'s rule against "text telling the user to pass a CLI flag, run a command or read the
terminal" does not cover (it is not an AgentX CLI command); if the lint disagrees, read its exact
rule before changing either side; do not weaken the lint to make this pass if the lint turns out to
be right.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/setup/channel-add.ts packages/cli/src/init/project-form.ts packages/cli/src/init/ui/page.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-page.test.ts
git commit -m "feat(init): a searchable channel picker, with the invite command shown up front for a private one (048 FR-052)"
```

---

### Task 10: Wire the merged project-and-channel-and-connectors step into `finishSteps` (FR-050, FR-072)

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts` (`firstProjectStep` and `connectorsStep` merge)
- Test: `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-ui-order.test.ts` (confirm
  this file exists from phase 2 before adding to it; if not, add the no-UI-order assertion to
  `init-cli.test.ts` instead)

**Interfaces:**
- Consumes: Tasks 7, 8 and 9's `projectFormFields`, `addOrPickChannel`; the existing `addProject`,
  `chooseRepository` (inside `addProject`), `addLinear`/`addJira`/`addAsana`.
- Produces: `finishSteps()` still returns five steps (`admin-user`, `first-project`, `connectors`,
  `alerts`, `e2e`); `first-project`'s `run` now asks one form instead of `addProject`'s remaining
  question plus `addChannel`'s question; `connectorsStep`'s three confirms are removed (its checkbox
  answer now arrives already decided from the `first-project` step's form, recorded in progress the
  same way as today so `connectorsStep` itself can shrink to "run whichever connectors
  `first-project` recorded as wanted" or be folded into `first-project` entirely - decide which reads
  more clearly once this task is in hand, and say which in the PR description).

- [ ] **Step 1: Write the failing tests**

```ts
it("spec 048 FR-050: asks the project screen as one form, in the page's order", async () => {
  // Drive firstProjectStep (or its merged replacement) with a scriptedPrompter whose asked questions
  // must equal the page's order: repository, then the form's fields in projectFormFields' order.
  const prompter = scriptedPrompter(["payments-api-repo", "", "npm ci", "npm test", "create", "payments", "public", "", ""]);
  // ...drive the step, then:
  expect(prompter.asked.slice(1)).toEqual(["Project name", "Setup command", "Test command", "Should AgentX create the channel for you?", "Channel name", "Public or private?", "Issue trackers"]);
});

it("spec 048 FR-072 (Review Focus 4): an unchanged --channel flag keeps today's behavior", async () => {
  // --yes with --channel payments and no --channel-create flag: behaves exactly as addChannel does
  // today (asks nothing else about the channel, searches for "payments", waits for the bot).
  const context = initContext({ flags: { channel: "payments" } });
  // ...assert the resulting progress names channelName "payments" with no create/pick branch exercised.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts`
Expected: FAIL: today's step still asks three separate questions.

- [ ] **Step 3: Write minimal implementation**

In `firstProjectStep`'s `run`, after `addProject` returns the chosen repository's proposed setup/test
commands (confirm `addProject`'s return shape carries them, or read them separately via
`proposeCommands` before calling `addProject` - whichever the existing function already supports
without a breaking change to its own signature), build and ask the one form:

```ts
      const channelList = context.flags.channel === undefined ? await context.setup.slackChannels.list(await readSlackBotToken(context.secrets, context.env)) : [];
      const answers = await askForm(context.prompter, PROJECT_FORM_TITLE, projectFormFields({
        defaultName: repository?.split("/").pop() ?? "project", proposedSetup, proposedTest,
        channelChoices: channelList.filter((channel) => channel.isPrivate === false || channel.isMember).map((channel) => ({ value: channel.name, label: `#${channel.name}` })),
      }), { values: context.flags.channel === undefined ? {} : { channelMode: "pick", channelPicked: context.flags.channel } });
      // ...use answers[PROJECT_FORM_FIELD.name] for addProject's name, answers[...setupCommand/testCommand]
      // for the commands, and call addOrPickChannel with mode "create" or "pick" per answers.channelMode,
      // and parse answers[PROJECT_FORM_FIELD.connectors] ("linear,asana" or "") into the same
      // Set<ConnectorType> parseConnectorsFlag already builds, recording it in progress for
      // connectorsStep (or the merged step) to run.
```

(This sketch intentionally does not reproduce every line of `addProject`'s and `addChannel`'s bodies:
the real task is folding three existing, working functions' question-asking into one form while
keeping every one of their side effects - writing the project file, registering the revision,
creating or finding the channel, binding it - exactly as they are today. Write the test first, watch
it fail against the unmerged steps, then move the asking (not the doing) into the form.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the no-UI order test**

Wherever phase 2's Task 16 asserted the no-UI question order (`init-ui-order.test.ts` or wherever it
lives), add this phase's new fields in their place after `--repository`.

- [ ] **Step 6: Run the whole init suite, then commit**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init/finish-steps.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-order.test.ts
git commit -m "feat(init): the project, channel and issue-tracker questions become one screen (048 FR-050, FR-072)"
```

---

### Task 11: The admin sign-in names the email it used and what to expect (FR-055)

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts` (`adminUserStep` reads the settings' email instead
  of asking again)
- Modify: `packages/cli/src/init/ui/cards.ts` (`adminCard`'s "signing-in" stage names the sender and
  subject)
- Test: `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-ui-cards.test.ts`

**Interfaces:**
- Consumes: phase 2's `InitAnswers.adminEmail` (the settings' email, already collected there).

- [ ] **Step 1: Write the failing tests**

```ts
it("spec 048 FR-055: reuses the settings' email, asking nothing new", async () => {
  const context = initContext({ answers: sampleAnswers({ adminEmail: "alice@example.com" }) });
  const prompter = scriptedPrompter([]); // no email question should be asked
  context.prompter = prompter;
  await adminUserStep().run(context, progressHandle());
  expect(prompter.asked).not.toContain("Your email address, for your AgentX admin user");
});
```

```ts
it("names the sender and subject to expect", () => {
  const card = adminCard({ stage: "signing-in", who: "alice@example.com", createdEmail: "alice@example.com" });
  expect(card.lines[0]).toMatch(/no-reply@verificationemail\.com|AWS Cognito/); // the real sender, found in Task 11 Step 2
  expect(card.lines[0]).toMatch(/Your temporary password|subject/i);
});
```

(The exact sender address is whatever the identity stack's Cognito message configuration actually
uses - find it before writing the final assertion, per Step 2 below; do not guess a plausible-looking
address and leave it unverified.)

- [ ] **Step 2: Find the real sender and subject**

`grep -rn "EmailSubject\|EmailMessage\|SES\|FROM_EMAIL\|no-reply" infra/` (read-only) to find the
identity stack's Cognito user pool email configuration; if it uses Cognito's own default sender
(`no-reply@verificationemail.com`) rather than a custom SES identity, say so in the card's text
exactly as Cognito sends it, and note the finding in this task's commit message so a later infra
change that adds a custom sender has one place to update.

- [ ] **Step 3: Write minimal implementation**

In `adminUserStep`, replace the `await context.prompter.ask("Your email address, ...")` call with
`context.answers.adminEmail ?? context.flags.adminEmail ?? await context.prompter.ask(...)` (the
settings' answer first, the flag second for an install that predates phase 2's settings screen or
was given `--admin-email` directly, the question only as a last resort for an identity mode this
field was never collected for).

In `adminCard`'s `"signing-in"` stage, add the sender/subject line found in Step 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/finish-steps.ts packages/cli/src/init/ui/cards.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cards.test.ts
git commit -m "feat(init): the admin sign-in reuses your settings email and says which email to expect (048 FR-055)"
```

---

### Task 12: "It did not arrive" opens help (FR-056)

**Files:**
- Modify: `packages/cli/src/init/ui/cards.ts` (`alertsCard`'s "testing"/"failed" stages gain a link)
- Modify: `packages/cli/src/init/ui/question-copy.ts` (the existing test-alarm confirm gains a `learnMoreUrl`)
- Test: `tests/contract/init-ui-cards.test.ts`, `tests/contract/init-ui-question-copy.test.ts`

**Interfaces:**
- Consumes: the existing `{ kind: "confirm", text: /^Did a test alarm named .+ arrive at (.+)\?$/, ... }` catalog entry.

- [ ] **Step 1: Write the failing test**

```ts
it("spec 048 FR-056: It did not arrive opens help, not a dead end", () => {
  const help = questionHelp({ kind: "confirm", text: "Did a test alarm named agentx-staging-test arrive at ops@example.com?" });
  expect(help.learnMoreUrl).toMatch(/^https:\/\//);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-question-copy.test.ts`
Expected: FAIL: the entry has no `learnMoreUrl`.

- [ ] **Step 3: Write minimal implementation**

In `question-copy.ts`, add `learnMoreUrl: "https://docs.aws.amazon.com/sns/latest/dg/sns-troubleshooting.html"` (or whichever page the project's own troubleshooting doc already points to for a missed
SNS email - check `docs/install.md` and `AlertsApi`'s own doc comments for an existing link before
picking a new one) to the matching entry.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-ui-question-copy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/question-copy.ts tests/contract/init-ui-question-copy.test.ts
git commit -m "feat(init): It did not arrive opens help instead of a dead end (048 FR-056)"
```

---

### Task 13: The test reply names the app, not only the bot's handle (FR-057)

**Files:**
- Modify: `packages/cli/src/init/ui/cards.ts` (`replyCard`'s input gains `appName`)
- Modify: `packages/cli/src/init/finish-steps.ts` (`e2eStep` passes it)
- Test: `tests/contract/init-ui-cards.test.ts`, `tests/contract/init-finish-steps.test.ts`

**Interfaces:**
- Consumes: `context.answers.slack.appName` (already collected, already shown elsewhere).

- [ ] **Step 1: Write the failing test**

```ts
it("spec 048 FR-057: names the app as well as the bot's handle", () => {
  const card = replyCard({ stage: "waiting", channelName: "payments", channelId: "C1", teamId: "T1", botName: "agentx-acme-staging", appName: "AgentX acme (staging)", minutes: 3 });
  expect(card.lines.join(" ")).toContain("AgentX acme (staging)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts`
Expected: FAIL: `appName` is not accepted.

- [ ] **Step 3: Write minimal implementation**

In `ReplyCardInput`'s `"waiting"` variant, add `appName: string`, and in `replyCard`'s body, the
first `lines` entry becomes: `` `In #${input.channelName}, post a message that mentions @${input.botName} (the ${input.appName} app), for example "@${input.botName} what can you do?".` ``

In `e2eStep`, pass `appName: context.answers.slack.appName` alongside the existing `botName`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts tests/contract/init-finish-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/cards.ts packages/cli/src/init/finish-steps.ts tests/contract/init-ui-cards.test.ts tests/contract/init-finish-steps.test.ts
git commit -m "feat(init): the test reply names the app as well as the bot's handle (048 FR-057)"
```

---

### Task 14: Copy-lint coverage and the project-and-channel section of `docs/install.md`

**Files:**
- Modify: `packages/cli/src/init/ui/question-copy.ts` (any question from Tasks 7 to 10 still unlabelled)
- Modify: `tests/contract/init-ui-copy-lint.test.ts`
- Modify: `docs/install.md`
- Test: `tests/contract/init-ui-copy-lint.test.ts`

- [ ] **Step 1: Run the existing copy-lint test**

Run: `npx vitest run tests/contract/init-ui-copy-lint.test.ts`
Expected: FAIL naming the first new string with no catalog entry, or PASS if every task above already
added one (check which before writing a new assertion).

- [ ] **Step 2: Add any missing `question-copy.ts` entries**

Cover: "Should AgentX create the channel for you?", "Public or private?", "Which channel?", the taken-
name choice, the member-search ask and choose, "Issue trackers" (with its "Skip for now" hint).

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS.

- [ ] **Step 4: `docs/install.md`**

Add a "Your first project" section: the one screen's fields in order, what "Should AgentX create the
channel for you?" does on Yes and on No, that the manifest's two new scopes mean an app installed
before this phase needs reinstalling to create channels, and that the welcome screen can ask the
browser to notify you.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/question-copy.ts tests/contract/init-ui-copy-lint.test.ts docs/install.md
git commit -m "test(init): every new project-screen string passes the copy-lint; docs for it (048 FR-081, SC-011)"
```

---

## Self-Review

**1. Spec coverage (phase 4 row of the spec's Phases table):**

| Requirement | Task |
|---|---|
| FR-002 measured numbers | 1 |
| FR-007 real build progress, one row per part | 3 |
| FR-050 the project screen as one form: repository, name, commands, channel question, connectors as checkboxes with Skip for now | 6, 7, 10 |
| FR-051 Yes creates and joins, invites the installer by email with a member-search fallback, name-taken handling | 8 |
| FR-052 No offers a searchable picker plus a name field, the invite command up front for a private channel | 9 |
| FR-053 the manifest always asks for channels:manage and groups:write | 4 |
| FR-055 admin sign-in reuses the settings email, names the expected email | 11 |
| FR-056 It did not arrive opens help | 12 |
| FR-057 the test reply names the bot and the app | 13 |
| FR-005 the notification | 2 |

**2. Placeholder scan:** every code step has real code; Task 1 Step 3 and Task 11 Step 2 are
measurement/lookup steps with no code of their own by nature (a timing run, a grep for an existing
infra setting), not a stand-in for code that should have been written; Task 10 Step 3 names exactly
which three existing functions' question-asking (not their side effects) move into the new form,
rather than reproducing `addProject`'s and `addChannel`'s full bodies a second time.

**3. Type consistency:** `FormField.multi`/`showWhen` (Task 6) are what `projectFormFields` (Task 7)
builds and `askForm`'s terminal fallback and `ui/prompter.ts`'s page form both read. `SlackChannelApi.create`/`.invite`/`.list` and `SlackUsersApi` (Task 5) are what `addOrPickChannel` (Tasks 8
and 9) calls. `PROJECT_FORM_FIELD`'s names are what Task 10's wiring reads back out of the submitted
form.

**4. Review Focus:** each of the five lines has its pinned test in the named task (Tasks 8, 8, 9, 10,
3).

## Rulings On Spec Ambiguities

1. **`--channel <name>` alone still means exactly what it means today.** A no-UI run that passes only
   `--channel` (no `--channel-create`) is read as the Pick path with that name, matching Review Focus
   4 and keeping every existing `--yes --channel ...` test passing unchanged. `--channel-create` is a
   new flag this phase adds for a no-UI run that wants the Create path instead.
2. **The project form's `channelChoices` come from one `SlackChannelApi.list` call, read once before
   the form is built, not refreshed while the operator looks at it.** A channel created by someone
   else in the few seconds the form is open is simply not in the list; "A channel not listed" already
   covers that case by name.
3. **`connectorsStep`'s body (the actual connecting, not the asking) is kept as a separate step**,
   reading which connectors the project form's checkboxes recorded, rather than folded entirely into
   `first-project`: a connector's own setup can itself wait on a person (an OAuth flow), and keeping
   it a separate step keeps that wait's resume behavior exactly as it is today (a done connector is
   recorded and skipped on resume, independent of the project step that chose it).
4. **FR-055's "which email to expect" names whatever Cognito actually sends today**, found by reading
   the identity stack rather than invented, so the page never promises a sender or subject the real
   email does not have. If Cognito's default sender ever becomes a custom one, this card's text and
   this ruling's note are the two places to update together.
5. **The mockup and PR 231/247's review comments were not re-read while writing this plan's exact
   copy strings** (the owner's two sources of visual and wording decisions named in the task that
   produced this plan); every piece of new page copy here is a best-effort plain-words draft, not a
   transcription. The owner should confirm the exact wording of the channel question, the picker's
   layout and the notification button's label against the mockup during review, and treat any
   mismatch as a copy fix rather than a sign the mechanism itself is wrong.

## Execution Handoff

Plan complete and saved to `specs/048-guided-install/plans/phase-4-pickers-and-progress.md`.
Implementation starts only after phase 3's PR has merged into mainline (no stacking). Please review
the plan. Which execution approach would you prefer?

- **Subagent-driven:** a fresh subagent implements each task and a fresh reviewer checks it before
  the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context
  per task and per review.
- **Native:** one session implements every task, then one fresh reviewer on the most capable model
  checks the whole branch. Cheapest and fastest; no independent review until the end.

**Recommendation: subagent-driven**, because Tasks 5 through 10 build one feature (the channel
question) across five files that must agree on several new shapes at once (`SlackChannelApi`,
`SlackUsersApi`, `FormField.multi`/`showWhen`, `PROJECT_FORM_FIELD`), and because Task 10 folds three
previously independent, already-shipped flows into one without changing what any of them actually
does - exactly the kind of merge where a fresh per-task reviewer catches a dropped side effect before
it reaches the next task.
