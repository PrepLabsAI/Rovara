# Spec 048 Phase 3: Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every failure is fixed on the page: the page action fits the kind of failure (try again,
change the one answer that caused it, go fix it elsewhere and check again, or clean up a stuck
stack), an answer can be changed in place once a step has already run but only when no finished step
depends on it (and a resumed no-UI run follows the same rule for its flags), a stopped install's page
reopens at the same address when `agentx init` runs again, a wait that reaches its limit asks "Still
there? Keep waiting" instead of ending the run, and a lost connection says so and offers the command
to continue. Added by owner decision after this plan's first review (2026-10-02): the channel
create-or-not question moves to settings, before the Slack app is created, so the Slack app manifest
can carry the channel-creating scopes only when the answer is Yes.

**Architecture:**
- **A failure is tagged with its recovery action where it is found.** `checkPrerequisites` and
  `clashChecks` already collect every failed check as a `PrerequisiteCheck`; each one gains an
  optional `action` naming which specific thing fixes it (`change-model`, `change-region`,
  `change-image`, `anthropic-form`). `checkWithChangeOnPage` reads the first failed check's `action`
  and offers that instead of the blunt "Change answers" it offers today; the three-button menu stays
  the fallback for a check with no action tagged.
- **An answer's lock is a lookup, not a flag on the answer itself.** A new table,
  `ANSWER_DEPENDS_ON`, says which `InitStepId`s a settings field is baked into once they are done
  (the install name into `access`, the GitHub owner into `github-app`, the models and both images
  into `control-plane`, the Slack app name into `slack-app`). `canChangeAnswer(field, doneSteps)`
  reads it; the same table backs both the page's "Change `<answer>`" action after a deploy-step
  failure and a no-UI resume's flags (`assertResumeFlagsMatch` becomes `reconcileResumeFlags`, which
  accepts an unlocked flag instead of refusing it).
- **A kind tag rides on the thrown error, the same way `markOperatorStop` already does.** A deploy
  step's failure is marked with `markRecoverableFailure(error, action)` at the point it is thrown (a
  model or region problem already carries one from Task 1's tagging; a stack stuck in
  `ROLLBACK_COMPLETE` is tagged `cleanup` here). `askFailureAction` reads the tag and offers the
  matching button; a failure with no tag keeps today's try-again-or-stop menu.
- **A wait only asks when someone is watching the page.** `retryOnPage` and `checkWithChangeOnPage`
  already gate every question on `context.surface !== undefined`; the new `onTimeout` callback on the
  GitHub App wait (`ManifestHost`) and the Slack Request URL probe (`probeSlackUrls`) follows the
  same rule, so an unattended or terminal run keeps today's hard deadline exactly as it is, and only
  the page asks "Still there? Keep waiting" and extends the same wait in place.
- **The wizard's address survives a restart.** A small per-environment file under `services.home`
  (next to the log file) holds the last port and session token `agentx init` used for this
  environment; the next run tries to rebind that same port with that same token before falling back
  to a fresh one, so a browser tab left open (its `EventSource` already retries on its own) usually
  reconnects without the operator doing anything. The client's existing `error` listener, which today
  only reacts to a terminal `EventSource` state, gains a timer: once the connection has been down for
  a while it shows the continue command (a new `continueCommand` field the hub fills in once the
  environment and region are known) with a copy button, the only new case of FR-061's "a command only
  here" rule.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Vitest 5, zod 4. No new dependency. The
page stays plain HTML, CSS and an ES module held as text in `page.ts` (spec 040).

**Spec:** [../spec.md](../spec.md), the binding authority. This plan delivers the spec's Phases row
3: FR-061 to FR-064, FR-066 and FR-067, with SC-004 (every failure recoverable on the page) and the
resume half of SC-010 (a stopped install resumes in the same tab at the same address; the live timed
part of SC-010 is checked in the final live end-to-end check after phase 4, not by this plan's tests).
Task 14 additionally delivers part of FR-051 and FR-053, moved here from phase 4's row by owner
decision (2026-10-02; see Decisions in the spec, owner decisions 8 and 9). Owner approval of the
spec, with all five open choices accepted: PR #231 comment of 2026-10-01. Owner review of phase 2's
plan: PR #247. Design proposal: the guided install design, section 5 ("Recovery model") and section
10's decisions; section 5's page actions by kind of failure, the changed-answer rule, same-tab
resume (port and token saved in the user's own config dir) and the countdown behavior are this
plan's direct source. Owner decision of 2026-10-02 on the header's "Stopped" word during a failure
(already merged to mainline, `journey.ts`) is assumed, not redone.

**Already covered elsewhere (checked 2026-10-02 against open issues and the two in-flight lanes; do
not duplicate):** issues #215 (Slack approval message shows tool names/character counts) and #217
(an expired Slack confirmation keeps live buttons) are Slack task-message issues, covered by lane B,
branch `fix/slack-messages-215-219`, in flight; #222 (the ready screen's unpublished package name and
raw Slack markup) is CLOSED, fixed by phase 1's `readyCard`/`readyText`, merged; #235 (Ctrl-C under
`--no-ui` printing `INTERNAL_ERROR`) is covered by lane C, branch `fix/cli-setup-218-235`, in flight.
None of the four touches a file this plan modifies (see File Structure); none is duplicated here.

**Builds on:** phase 1 (`specs/048-guided-install/plans/phase-1-page-shell.md`, merged) and phase 2
(`specs/048-guided-install/plans/phase-2-order-and-checks.md`), merged into `mainline` before this
phase's branch is cut. Every interface this plan consumes is phase 2's as implemented there:
`INSTALL_STEP_ORDER`, `STEP_PLAN`, `checkWithChangeOnPage`, `clashChecks`, `PrerequisiteCheck`,
`checkAccount`, `SETTINGS_FIELD`, `SettingsFieldName`, `settingsFields`, `CollectedAnswers.settings`,
`collectInitAnswers`, `RESUME_CHECKS`, `assertResumeFlagsMatch`, `resumeMismatch`,
`normalizeResumeValue`, plus phase 1's `askFailureAction`, `failureScreen`, `isRetryableStep`,
`retryOnPage`, `markOperatorStop`, `isOperatorStop`, `WizardCard`, `WizardField`, `createWizardHub`,
`startWizardServer`, `startInstallWizard`, `pageClosedReminder`, `questionHelp`, `PAGE_CLASSES`,
`WIZARD_CSS`, `lintCopy`. If phase 2's review renamed anything this plan names here, use the merged
name and say so in the PR description; never re-create a phase 2 name under its old spelling.

**Branch:** `feat/048-phase3-recovery`, cut from `origin/mainline` **only after phase 2's PR has
merged into mainline**. One PR against `mainline` (no stacking: never branch from
`feat/048b-order-and-checks`/`feat/048-phase2-order-and-checks` or any other phase branch, never
target one).

## Global Constraints

- **Start only after phase 2 merges.** Before Task 1: `git fetch origin`, confirm
  `git log origin/mainline --oneline | grep "048 FR-028, FR-065, SC-009"` (or whatever commit phase
  2's review renamed it to) shows phase 2's work, then cut the branch from `origin/mainline`.
- **Recorded installs still resume.** `INIT_STEP_IDS` and `INSTALL_STEP_ORDER` keep their order.
  `InitAnswersSchema` and `InstallProgressSchema` only gain optional fields (this phase adds none to
  either; the session file introduced here is a new file, not a schema change). A done step is
  skipped wherever it stands in the run order, exactly as today.
- **The terminal path and `--yes` keep every flag and its meaning**, with one deliberate, listed
  change (FR-072, Ruling 5 of the spec's Decisions): a resume's flag that names an answer no
  finished step depends on is now accepted (and saved) instead of refused; a flag naming an answer a
  finished step depends on is refused with the same message shape `resumeMismatch` already throws,
  naming which step and why. Every existing `--yes` resume test that names a flag matching the
  stored answer is unaffected; a test that today expects a *mismatch* to be refused must still expect
  a refusal if the field it names is locked, and gets a new expectation (the flag is accepted) if the
  field is unlocked under `ANSWER_DEPENDS_ON`.
- **Exact names (later phases depend on them):** `CheckRecoveryAction`, `canChangeAnswer`,
  `ANSWER_DEPENDS_ON`, `markRecoverableFailure`, `recoverableFailureOf`, `reconcileResumeFlags`,
  `waitWithCheckIn`/`onTimeout` (the shape, not necessarily this exact function name; see Task 8),
  `WizardCard.waitLabel`, `WizardState.continueCommand`, the session file's path function
  `sessionFilePath(home, env)`, `SETTINGS_FIELD.createChannel`, `CHANNEL_CREATE_SCOPES` (Task 14).
- **Never print a secret.** The session token is never written to the init log file (FR-071,
  unchanged) and is written to the new session file with the same 0600/0700 permission discipline
  `log-file.ts` already uses; the session file itself is never read aloud in any test assertion that
  also appears in a snapshot or a committed fixture.
- **Security rules of spec 040 hold:** loopback only, the session token, origin checks, secrets never
  echoed. Reusing a port never reuses a *different* run's token: the session file is read only for
  the same `env`, and the token recorded is useless against a server for any other environment.
- **Copy:** plain words from the glossary (FR-080); no internal words, no em dashes, no phase or FR
  numbers outside a comment. Page text never tells the user to pass a flag, run a command or read the
  terminal outside "Stop for now", the lost connection notice and the ready screen (FR-081); the new
  lost-connection command row is the one place this plan adds a second such exception, and it is
  exactly the one FR-081 already allows.
- **Look:** every new screen element uses the design system's tokens and classes (`design.ts`); a new
  class is added to `PAGE_CLASSES` and styled there; no inline style, no external asset.
- **Do not touch** `infra/` or any CloudFormation template. The legacy and named template snapshots
  (`tests/contract/__snapshots__/*.snap`) stay byte-identical.
- **Tests:** never `vitest -u`; no assertion removed or weakened. An existing assertion whose
  expected value this phase changes is replaced by the new exact value.
- **Typecheck ratchet:** `npm run typecheck:all` must not report more errors than the baseline.
- **The gate**, on Node 22: `npm run typecheck:all && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH` (or any
    Node 22.19 or later on PATH).
  - While iterating on one task, run only its test files with `npx vitest run <files>`.
- **No AWS, GitHub or Slack calls from tests.** Every new dependency (the CloudFormation
  `DeleteStack` call Task 6 needs) is injected and faked.
- **PRs:** one PR to `mainline`, never stacked, never force-pushed. CI runs the parallel jobs defined
  in `.github/workflows/ci.yml`; nothing in this plan changes that file.
- **Never rewrite history.** No `git filter-branch`, `rebase`, `commit --amend` or force-push, on this
  branch or any other; a fix after review is always a new commit. No bare `git stash` (the stash stack
  is shared with other worktrees); if one is needed, use `git stash push -u -m "<unique tag>"` and
  restore with `git stash apply`, never `pop`.
- **Commits:** each commit's trailer names the model that wrote it
  (`Co-Authored-By: <model> <noreply@anthropic.com>`); no em dashes anywhere a commit touches.
- **Build process:** the owner approves this plan, then picks the execution method. Implementers and
  reviewers run on Sonnet; only the final whole-branch review runs on Opus.

## Review Focus

1. **A deploy-step failure for an answer a finished step already depends on** (the spec's own
   example: the GitHub owner, after the `github-app` step has created the app). Expected: the page
   never offers "Change the GitHub owner"; it says which step depends on it and why, and offers
   "Start over" naming what that removes. Pinned in Task 7 ("the GitHub owner cannot change once the
   GitHub app exists; Start over names it").
2. **The same locked answer on a no-UI resume**, given as a flag that differs from the stored one.
   Expected: `agentx init --resume --github-account other-org` refuses with the same "which step and
   why" message the page would show, not a generic "does not match" mismatch. Pinned in Task 4 ("a
   locked flag on resume is refused with which step and why, like the page").
3. **Two people (or two terminals) running `agentx init` for the same environment at once**, so the
   second one's attempt to rebind the first's saved port collides. Expected: the second run falls
   back to a fresh port and token without crashing, and prints the new address; it never silently
   reuses the first run's live session. Pinned in Task 11 ("a port already listening falls back to a
   fresh one and a fresh token").
4. **A deploy step failing because its stack is stuck in `ROLLBACK_COMPLETE`** (an earlier run's
   `core` step died mid-create). Expected: "Clean up and try again" is offered only for this kind of
   stuck stack, names the stack it deletes, and the retried step actually recreates it rather than
   failing the same way again. Pinned in Task 6 ("a ROLLBACK_COMPLETE stack is deleted before the
   step runs again, and the retry recreates it").
5. **The GitHub App wait or the Slack Request URL wait reaching its deadline with no one watching the
   page** (`--no-ui`, `--yes`, or an interactive terminal with no `--ui`). Expected: both still throw
   exactly as they do today; no silent infinite wait, and no new question an unattended run could
   get stuck on. Pinned in Task 9 ("the GitHub and Slack waits still give up on time with no
   surface").

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/init/prerequisites.ts` | `PrerequisiteCheck.action`; `CheckRecoveryAction`; tagging in `checkPrerequisites` and `releaseImageChecks` |
| `packages/cli/src/init/clash-checks.ts` | No tagging needed (its checks have no page action beyond Change answers; noted in Task 1) |
| `packages/cli/src/init/retry.ts` | `checkWithChangeOnPage` reads the first failed check's `action`; `markRecoverableFailure`, `recoverableFailureOf` (moved here, beside `markOperatorStop`'s sibling in `stop.ts`, or added to `stop.ts` directly; Task 5 decides and says which) |
| `packages/cli/src/init/answer-dependencies.ts` (new) | `ANSWER_DEPENDS_ON`, `canChangeAnswer`, `lockingStep` |
| `packages/cli/src/init/answers.ts` | `reconcileResumeFlags` replaces `assertResumeFlagsMatch`'s unconditional refusal for an unlocked field |
| `packages/cli/src/init/ui/failure.ts` | `askFailureAction` gains the `change`, `fix-elsewhere` and `cleanup` actions; `failureScreen` shows the right `next` sentence and technical details for each |
| `packages/cli/src/init/cleanup.ts` (new) | Detects a `ROLLBACK_COMPLETE`/`ROLLBACK_FAILED` stack, says what it deletes, deletes it |
| `packages/cli/src/init/context.ts` | `StackStatusReader` gains `delete?(stackName)`; `OpenManifestHost`'s input gains `onTimeout?` |
| `packages/cli/src/init/commands.ts` | `onStepFailure` chooses the right askFailureAction kind from the failure's tag; "Change `<answer>`" reopens one field and reruns only the failed step; session file read/write around `startInstallWizard` |
| `packages/cli/src/init/github-app.ts` | `startManifestListener`'s timer calls `onTimeout` before giving up; `createWithManifest` supplies it only with a surface |
| `packages/cli/src/init/ui/server.ts` | `mountManifest`'s timer gets the same `onTimeout` treatment |
| `packages/cli/src/init/slack-app.ts` | `probeSlackUrls` gains `onTimeout`; `verifySlackUrls` supplies it only with a surface |
| `packages/cli/src/init/settings-form.ts` | (Task 14, owner decision 2026-10-02) `SETTINGS_FIELD`/`settingsFields` gain the `createChannel` question, under Advanced |
| `packages/cli/src/init/slack-app.ts` | (Task 14) `CHANNEL_CREATE_SCOPES`; `slackAppManifest` and `slackAppStep` take the up-front `createChannel` answer instead of always requesting the scopes |
| `packages/cli/src/init/answer-dependencies.ts` | (Task 14) `ANSWER_DEPENDS_ON.createChannel: ["slack-app"]` |
| `packages/cli/src/init/session-file.ts` (new) | `sessionFilePath(home, env)`, `readSession`, `writeSession`, `deleteSession` |
| `packages/cli/src/init/ui/index.ts` | `startInstallWizard` tries a preferred port and token first, falls back on failure |
| `packages/cli/src/init/ui/server.ts` | `startWizardServer` takes `preferredPort`/`preferredToken`, catches `EADDRINUSE` and retries on port 0 with a fresh token |
| `packages/cli/src/init/ui/state.ts` | `WizardHub` gains `setContinueCommand`; `WizardState.continueCommand` |
| `packages/cli/src/init/ui/protocol.ts` | `WizardCard.waitLabel?`; `WizardState.continueCommand?` |
| `packages/cli/src/init/ui/page.ts` | `untilText` reads `card.waitLabel`; the `error` listener tracks how long the connection has been down and shows the continue command |
| `packages/cli/src/init/ui/question-copy.ts` | Copy for every new question this phase asks |
| `packages/cli/src/init/ui/design.ts` | `PAGE_CLASSES`/`WIZARD_CSS` gain the lost-connection banner's class, if any new one is needed |
| `docs/install.md` | The recovery section: what each failure action does, same-address resume |
| `tests/contract/init-prerequisites.test.ts`, `init-retry.test.ts`, `init-answer-dependencies.test.ts` (new), `init-answers.test.ts`, `init-ui-failure.test.ts`, `init-cleanup.test.ts` (new), `init-github-app.test.ts`, `init-slack-app.test.ts`, `init-session-file.test.ts` (new), `init-ui-server.test.ts`, `init-ui-index.test.ts`, `init-ui-page.test.ts`, `init-ui-question-copy.test.ts`, `init-settings-form.test.ts` (Task 14) | Tests for every module above |

## Interfaces Later Phases Rely On

- **Phase 4 (pickers and progress):** reuses the `onTimeout`-with-`surface`-gate pattern from Tasks 8
  and 9 for the three waits FR-064 also names that do not exist yet (admin sign-in, the channel
  invite, the alert confirmation), wiring it in as each of those cards is built or rebuilt. It adds
  its own rows to `ANSWER_DEPENDS_ON` for the project fields it introduces, but not for the channel
  decision: Task 14 (owner decision, 2026-10-02) already added `createChannel`'s own row, since that
  decision now lives in settings, not on phase 4's project form. Phase 4's project form reads the
  already-known `context.answers.settings.createChannel` to decide which channel fields to show; it
  does not ask that question again. It reuses `WizardState.continueCommand` as-is (already correct
  for the ready screen; this phase only adds the field, phase 4 does not need to touch it).

---

### Task 1: Tag a failed prerequisite or image check with its recovery action (FR-066)

**Files:**
- Modify: `packages/cli/src/init/prerequisites.ts` (`PrerequisiteCheck`, `releaseImageChecks`, `checkPrerequisites`'s model-check loop)
- Test: `tests/contract/init-prerequisites.test.ts`

**Interfaces:**
- Consumes: phase 2's `PrerequisiteCheck { label; ok; detail; technical? }`, `modelCheckProblem`, `endpointMissing`, `releaseImageChecks`, `checkPrerequisites`.
- Produces:
  ```ts
  export type ModelRole = "orchestrator" | "classifier" | "worker"; // already exists; unchanged
  export type CheckRecoveryAction =
    | { kind: "change-model"; role: ModelRole }
    | { kind: "change-region" }
    | { kind: "change-image"; which: "worker" | "slack" }
    | { kind: "anthropic-form"; role: ModelRole; modelId: string };
  ```
  `PrerequisiteCheck` gains `action?: CheckRecoveryAction`.

- [ ] **Step 1: Write the failing tests**

```ts
import { releaseImageChecks, checkPrerequisites } from "../../packages/cli/src/init/prerequisites.js";
import { sampleAnswers, passingChecks, scriptedPrompter, HOLDER } from "../support/init-fakes.js";
import { fakeRelease } from "../support/init-fakes.js";

describe("spec 048 phase 3: a failed check names its recovery action (FR-066)", () => {
  it("tags a missing release image with which image to change", () => {
    const [worker, slack] = releaseImageChecks({ version: "1.2.3", images: {}, audience: "page" });
    expect(worker).toMatchObject({ ok: false, action: { kind: "change-image", which: "worker" } });
    expect(slack).toMatchObject({ ok: false, action: { kind: "change-image", which: "slack" } });
  });

  it("tags a missing Bedrock endpoint with change-region", async () => {
    const found: PrerequisiteCheck[] = [];
    const checks = passingChecks({
      converse: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND bedrock-runtime.ap-south-2.amazonaws.com"), { name: "ENOTFOUND", code: "ENOTFOUND" }); },
    });
    await expect(checkPrerequisites({
      answers: sampleAnswers({ region: "ap-south-2" }), release: fakeRelease(), caller: { account: "123456789012", arn: HOLDER },
      checks, prompter: scriptedPrompter([]), write: () => undefined, audience: "page", skipAccount: true,
      onCheck: (check) => found.push(check),
    })).rejects.toThrow();
    expect(found.find((check) => check.label.startsWith("Model"))).toMatchObject({ action: { kind: "change-region" } });
  });

  it("tags the Anthropic one-time usage form with the model and role, and a plain access denial with change-model", async () => {
    const found: PrerequisiteCheck[] = [];
    const checks = passingChecks({
      converse: async (modelId) => {
        if (modelId === sampleAnswers().models.orchestrator) {
          throw Object.assign(new Error("You don't have access to the model. Request access in the Bedrock console for this use case."), { name: "AccessDeniedException" });
        }
        throw Object.assign(new Error("access denied for another reason"), { name: "AccessDeniedException" });
      },
    });
    await expect(checkPrerequisites({
      answers: sampleAnswers(), release: fakeRelease(), caller: { account: "123456789012", arn: HOLDER },
      checks, prompter: scriptedPrompter([]), write: () => undefined, audience: "page", skipAccount: true,
      onCheck: (check) => found.push(check),
    })).rejects.toThrow();
    const orchestrator = found.find((check) => check.label === `Model ${sampleAnswers().models.orchestrator}`);
    expect(orchestrator).toMatchObject({ action: { kind: "anthropic-form", role: "orchestrator", modelId: sampleAnswers().models.orchestrator } });
    const classifier = found.find((check) => check.label === `Model ${sampleAnswers().models.classifier}`);
    expect(classifier).toMatchObject({ action: { kind: "change-model", role: "classifier" } });
  });
});
```

(Note: `passingChecks`'s `converse` fake must be checked for every model role in `sampleAnswers()`,
since orchestrator, classifier and worker are three different model ids, so the fake above
distinguishes by id. Confirm the exact ids against `sampleAnswers()` in
`tests/support/init-fakes.ts` before writing the final assertion; they must match exactly or the
test proves nothing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts`
Expected: FAIL: `action` is undefined on every check.

- [ ] **Step 3: Write minimal implementation**

In `prerequisites.ts`, add the type above, and in `releaseImageChecks`'s failing branch:

```ts
    return { label, ok: false, detail, action: { kind: "change-image", which }, ...(ref === undefined ? {} : { technical: ref }) };
```

In `checkPrerequisites`'s model loop, build the action alongside the message:

```ts
    } catch (error) {
      const action: CheckRecoveryAction = endpointMissing(error) ? { kind: "change-region" }
        : /use case/i.test(errorMessage(error)) ? { kind: "anthropic-form", role, modelId }
          : { kind: "change-model", role };
      failed(`Model ${modelId}`, modelCheckProblem({ modelId, role, region, error, ...(audience === "page" ? { wording: pageWording() } : {}) }), undefined, action);
    }
```

(`failed`'s signature in the shared `reporter()` helper gains a fourth, optional `action` parameter,
threaded into the `PrerequisiteCheck` it builds; every other call to `failed` in this file passes no
fourth argument and is unaffected.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/prerequisites.ts tests/contract/init-prerequisites.test.ts
git commit -m "feat(init): a failed model, region or image check names its own fix (048 FR-066)"
```

---

### Task 2: `checkWithChangeOnPage` offers the tagged action instead of the blunt menu (FR-066)

**Files:**
- Modify: `packages/cli/src/init/retry.ts` (`checkWithChangeOnPage`)
- Modify: `packages/cli/src/init/ui/question-copy.ts` (the new question's copy)
- Test: `tests/contract/init-retry.test.ts`, `tests/contract/init-ui-question-copy.test.ts`

**Interfaces:**
- Consumes: Task 1's `PrerequisiteCheck.action`, `CheckRecoveryAction`.
- Produces: `checkWithChangeOnPage` gains an optional `firstAction?: CheckRecoveryAction` parameter
  (the caller passes the first failed check's `action`, found before calling in); its return type
  widens to `"passed" | "change" | CheckRecoveryAction`, so the caller can tell a blunt "reopen
  everything" from a specific one to run itself.

- [ ] **Step 1: Write the failing test**

```ts
describe("spec 048 phase 3: checkWithChangeOnPage offers the tagged action (FR-066)", () => {
  it("offers Change the worker image instead of Change answers when the failed check names one", async () => {
    const prompter = scriptedPrompter(["change-image"]);
    const result = await checkWithChangeOnPage({
      surface: surface(), prompter, question: "Your answers need a change. What next?",
      firstAction: { kind: "change-image", which: "worker" },
      failed: () => undefined, run: async () => { throw agentXError("CONFIG_INVALID", "image problem"); },
    });
    expect(result).toEqual({ kind: "change-image", which: "worker" });
  });

  it("still offers the blunt three-button menu when nothing is tagged", async () => {
    const prompter = scriptedPrompter(["change"]);
    const result = await checkWithChangeOnPage({
      surface: surface(), prompter, question: "Your answers need a change. What next?",
      failed: () => undefined, run: async () => { throw agentXError("CONFIG_INVALID", "name taken"); },
    });
    expect(result).toBe("change");
  });
});
```

In `init-ui-question-copy.test.ts`, add the catalog entry's expectation: a `choose` question with
flag `--on-check-failure` and a choice whose `value` matches a tagged action's kind reads as its
specific label ("Change the worker image", "Change the model", "Change the region", "Open the
Bedrock model catalog"; Task 3 adds the last one) rather than the generic "Change answers".

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-retry.test.ts tests/contract/init-ui-question-copy.test.ts`
Expected: FAIL: `checkWithChangeOnPage` still offers only change/retry/stop.

- [ ] **Step 3: Write minimal implementation**

In `retry.ts`:

```ts
export async function checkWithChangeOnPage(input: {
  surface: InstallSurface | undefined; prompter: Prompter; question: string; run: () => Promise<void>; failed: (problem: string) => void;
  /** Task 1: the first failed check's own fix, when one check named it. */
  firstAction?: CheckRecoveryAction;
}): Promise<"passed" | "change" | CheckRecoveryAction> {
  for (;;) {
    try {
      await input.run();
      return "passed";
    } catch (error) {
      if (input.surface === undefined) throw error;
      input.failed(problemText(error));
      const specific = input.firstAction;
      const choices = specific === undefined
        ? [{ value: "change" as const, label: "Change answers" }, { value: "retry" as const, label: "Check again" }, { value: "stop" as const, label: "Stop for now" }]
        : [{ value: specific.kind, label: specificActionLabel(specific) }, { value: "retry" as const, label: "Check again" }, { value: "stop" as const, label: "Stop for now" }];
      const next = await input.prompter.choose(input.question, choices, { flag: "--on-check-failure", defaultValue: choices[0]?.value ?? "change" });
      if (next === "retry") continue;
      if (next === "stop") throw markOperatorStop(error);
      return specific ?? "change";
    }
  }
}

function specificActionLabel(action: CheckRecoveryAction): string {
  switch (action.kind) {
    case "change-model": return "Change the model";
    case "change-region": return "Change the region";
    case "change-image": return action.which === "worker" ? "Change the worker image" : "Change the Slack connection image";
    case "anthropic-form": return "Open the Bedrock model catalog";
  }
}
```

(Import `CheckRecoveryAction` from `./prerequisites.js`. The Anthropic-form branch's full three
extra actions ("I submitted it, check again" and "Pick another model" included) are Task 3's; this
step only routes to it, and Task 3 builds what happens once each is chosen.)

In `question-copy.ts`, extend the existing `--on-check-failure` catalog entry (added in phase 2's
Task 7) with `choiceLabels` for the new values, or confirm phase 2 left none to extend (check the
merged entry first; if phase 2's entry already used `buttons: true` with no `choiceLabels`, add
them here rather than duplicating the entry).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-retry.test.ts tests/contract/init-ui-question-copy.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the caller in `commands.ts`**

Where `commands.ts` already calls `checkWithChangeOnPage` (phase 2's Tasks 7 to 9 loop), find the
first failed check among `answerChecks()`'s and `runPrerequisites()`'s results and pass it as
`firstAction`. When the result is a `CheckRecoveryAction` rather than `"change"`, reopen only the one
settings field it names (Task 3 for the Anthropic case; for `change-model`/`change-region`/
`change-image`, a single-field re-ask using `settingsFields()`'s matching `FormField`; the exact
field name comes from `SETTINGS_FIELD.orchestratorModel`/`classifierModel`/`workerModel` by role, or
(for an image) a new, small ad hoc field this task adds since images are not a `SettingsFieldName`
today: `askForm(prompter, "Change the image", [{ name: "image", question: imageQuestionFor(action.which), flag: action.which === "worker" ? "--worker-image" : "--slack-image" }])`, then merge the
single value back into `collected.settings`/`answers.images` and recompute `finalAnswersRef.current`
before looping back to `runPrerequisites`.

- [ ] **Step 6: Run the whole init suite, then commit**

Run: `npx vitest run tests/contract/init-retry.test.ts tests/contract/init-ui-question-copy.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init/retry.ts packages/cli/src/init/commands.ts packages/cli/src/init/ui/question-copy.ts tests/contract/init-retry.test.ts tests/contract/init-ui-question-copy.test.ts
git commit -m "feat(init): a tagged check offers its own fix instead of Change answers (048 FR-066)"
```

---

### Task 3: The Anthropic one-time usage form's own three actions (FR-066)

**Files:**
- Modify: `packages/cli/src/init/retry.ts` (a dedicated branch for `anthropic-form`)
- Modify: `packages/cli/src/init/ui/cards.ts` (a small card or reuse the existing checklist card's link)
- Test: `tests/contract/init-retry.test.ts`

**Interfaces:**
- Consumes: Task 2's `CheckRecoveryAction` (`anthropic-form` variant).
- Produces: `anthropicFormBedrockUrl(region: string): string` (a link to the Bedrock model catalog in
  the chosen region); `checkWithChangeOnPage`'s `anthropic-form` branch offers exactly three choices.

- [ ] **Step 1: Write the failing test**

```ts
it("the Anthropic usage-form failure offers its own three actions, not Change the model", async () => {
  const prompter = scriptedPrompter(["check-again"]);
  const result = await checkWithChangeOnPage({
    surface: surface(), prompter, question: "Your answers need a change. What next?",
    firstAction: { kind: "anthropic-form", role: "orchestrator", modelId: "us.anthropic.claude-sonnet-4-6" },
    failed: () => undefined,
    run: (() => { let calls = 0; return async () => { calls += 1; if (calls === 1) throw agentXError("CONFIG_INVALID", "use case form needed"); }; })(),
  });
  expect(result).toBe("passed");
  expect(prompter.asked).toEqual(["Your answers need a change. What next?"]);
});

it("names the region in the Bedrock model catalog link", () => {
  expect(anthropicFormBedrockUrl("us-east-1")).toBe("https://us-east-1.console.aws.amazon.com/bedrock/home?region=us-east-1#/model-catalog");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-retry.test.ts`
Expected: FAIL: `anthropicFormBedrockUrl` is not exported; the three-action branch does not exist.

- [ ] **Step 3: Write minimal implementation**

In `retry.ts`:

```ts
export function anthropicFormBedrockUrl(region: string): string {
  return `https://${region}.console.aws.amazon.com/bedrock/home?region=${region}#/model-catalog`;
}
```

In `checkWithChangeOnPage`, special-case `anthropic-form` before building `choices`:

```ts
      if (specific?.kind === "anthropic-form") {
        const next = await input.prompter.choose<"catalog" | "check-again" | "pick-another" | "stop">(input.question, [
          { value: "catalog", label: "Open the Bedrock model catalog" },
          { value: "check-again", label: "I submitted it, check again" },
          { value: "pick-another", label: "Pick another model" },
          { value: "stop", label: "Stop for now" },
        ], { flag: "--on-check-failure", defaultValue: "check-again" });
        if (next === "catalog") continue; // the page already showed the link via the card; looping re-asks
        if (next === "check-again") continue;
        if (next === "stop") throw markOperatorStop(error);
        return specific; // "Pick another model" reopens the one model field, same as change-model
      }
```

(`"Open the Bedrock model catalog"` is a link, not an action that ends the loop: the card showing the
failure already carries the link via `input.failed`'s caller; confirm whether `failed(problem)`
needs a sibling that also sets a `WizardCard.link`; if the existing `prerequisitesCard`/
`accountChecksCard` already surfaces a check's `technical`/`action` as a link through a small
addition in `ui/cards.ts` naming `anthropicFormBedrockUrl(region)` when a check's `action.kind ===
"anthropic-form"`, wire it there instead of duplicating link logic in `retry.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/retry.ts packages/cli/src/init/ui/cards.ts tests/contract/init-retry.test.ts
git commit -m "feat(init): the Anthropic usage-form failure offers the Bedrock catalog, check again or pick another model (048 FR-066)"
```

---

### Task 4: Which steps lock which answer, and the same rule for a no-UI resume (FR-062, FR-072)

**Files:**
- Create: `packages/cli/src/init/answer-dependencies.ts`
- Modify: `packages/cli/src/init/answers.ts` (`assertResumeFlagsMatch` becomes `reconcileResumeFlags`)
- Modify: `packages/cli/src/init/commands.ts` (the one call site)
- Test: `tests/contract/init-answer-dependencies.test.ts` (new), `tests/contract/init-answers.test.ts`

**Interfaces:**
- Consumes: phase 2's `SETTINGS_FIELD`, `SettingsFieldName`, `RESUME_CHECKS` (the existing table in
  `answers.ts` that drives `assertResumeFlagsMatch`), `InitStepId`.
- Produces:
  ```ts
  export const ANSWER_DEPENDS_ON: Readonly<Partial<Record<SettingsFieldName, readonly InitStepId[]>>> = {
    installName: ["access"], engine: ["access"], identity: ["access"], permissionBoundary: ["access"], operatorPrincipal: ["access"],
    githubAccount: ["github-app"],
    appName: ["github-app", "slack-app"],
    orchestratorModel: ["control-plane"], classifierModel: ["control-plane"], workerModel: ["control-plane"], modelProvider: ["control-plane"],
  };
  export function lockingStep(field: SettingsFieldName, done: ReadonlySet<InitStepId>): InitStepId | undefined;
  export function canChangeAnswer(field: SettingsFieldName, done: ReadonlySet<InitStepId>): boolean;
  ```
  (`installName` has no literal `SETTINGS_FIELD` step dependency recorded elsewhere yet; this table
  is additive and does not change `SETTINGS_FIELD` itself. A field not listed here can always change,
  which covers budget, alerts, the sign-in choices, the posted-messages choice and every other field
  with no deploy-time footprint.)
  `reconcileResumeFlags(stored: InitAnswers, flags: InitFlags, done: ReadonlySet<InitStepId>):
  InitAnswers` replaces `assertResumeFlagsMatch`'s void return: it still throws for a locked,
  mismatched field (with the step named), and for an unlocked, mismatched field it returns `stored`
  with that field's value replaced by the flag's.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-answer-dependencies.test.ts
import { describe, expect, it } from "vitest";
import { ANSWER_DEPENDS_ON, canChangeAnswer, lockingStep } from "../../packages/cli/src/init/answer-dependencies.js";

describe("spec 048 phase 3: which steps lock which answer (FR-062)", () => {
  it("locks the GitHub owner once the github-app step is done", () => {
    expect(canChangeAnswer("githubAccount", new Set(["prerequisites"]))).toBe(true);
    expect(canChangeAnswer("githubAccount", new Set(["prerequisites", "github-app"]))).toBe(false);
    expect(lockingStep("githubAccount", new Set(["prerequisites", "github-app"]))).toBe("github-app");
  });

  it("locks a model only once control-plane is done, not before", () => {
    expect(canChangeAnswer("workerModel", new Set(["prerequisites", "github-app", "access", "core"]))).toBe(true);
    expect(canChangeAnswer("workerModel", new Set(["prerequisites", "github-app", "access", "core", "control-plane"]))).toBe(false);
  });

  it("never locks a field this table does not name", () => {
    expect(canChangeAnswer("budget", new Set(["prerequisites", "github-app", "access", "core", "control-plane", "slack-app", "slack-service"]))).toBe(true);
  });
});
```

```ts
// in tests/contract/init-answers.test.ts
describe("spec 048 phase 3: a resumed no-UI flag follows the same lock (FR-072)", () => {
  it("accepts an unlocked flag and updates the stored answer", () => {
    const stored = sampleAnswers({ models: { ...sampleAnswers().models, worker: "amazon.nova-pro-v1:0" } });
    const result = reconcileResumeFlags(stored, { workerModel: "us.anthropic.claude-sonnet-4-6" }, new Set(["prerequisites", "github-app", "access", "core"]));
    expect(result.models.worker).toBe("us.anthropic.claude-sonnet-4-6");
  });

  it("refuses a locked flag, naming the step and why", () => {
    const stored = sampleAnswers({ github: { ...sampleAnswers().github, account: "acme" } });
    expect(() => reconcileResumeFlags(stored, { githubAccount: "other-org" }, new Set(["prerequisites", "github-app"])))
      .toThrow("--github-account other-org cannot change: the github-app step already created the GitHub App for acme; Start over to use a different owner");
  });

  it("keeps refusing every mismatch this phase did not list (webhook, admin values, OpenRouter key), exactly as before", () => {
    // unchanged existing assertions from assertResumeFlagsMatch's own tests, renamed to the new function
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-answer-dependencies.test.ts tests/contract/init-answers.test.ts`
Expected: FAIL: `answer-dependencies.js` does not exist; `reconcileResumeFlags` is not exported.

- [ ] **Step 3: Write minimal implementation**

`answer-dependencies.ts` as specified in Interfaces above, with `lockingStep`:

```ts
export function lockingStep(field: SettingsFieldName, done: ReadonlySet<InitStepId>): InitStepId | undefined {
  return (ANSWER_DEPENDS_ON[field] ?? []).find((step) => done.has(step));
}
export function canChangeAnswer(field: SettingsFieldName, done: ReadonlySet<InitStepId>): boolean {
  return lockingStep(field, done) === undefined;
}
```

In `answers.ts`, rename `assertResumeFlagsMatch` to `reconcileResumeFlags` (keep a deprecated
re-export only if something outside this plan's files still imports the old name by the time this
task runs; check with `grep -rn assertResumeFlagsMatch packages tests` first and update every
caller instead of keeping a shim), threading `done` through and, for each `RESUME_CHECKS` entry whose
field is in `ANSWER_DEPENDS_ON` and unlocked, returning the flag's value instead of calling
`resumeMismatch`. `resumeMismatch`'s message for a locked field gains the step name:

```ts
function resumeMismatch(given: string, was: string | undefined, lockedBy?: InitStepId): never {
  const reason = lockedBy === undefined ? `differs from what this install started with (${was ?? "nothing"})`
    : `cannot change: the ${lockedBy} step already used it`;
  throw agentXError("CONFIG_INVALID", `${given} ${reason}; an install's answers cannot change halfway. ${lockedBy === undefined ? "Give the one this install started with, or run agentx init without that flag to keep the stored one" : "Start over to use a different value"}`);
}
```

(Match this message's exact shape to Step 1's test assertion once written; the test is the source of
truth for the final wording, not this sketch; adjust one to match the other before moving on.)

- [ ] **Step 4: Update the one call site in `commands.ts`**

Replace `assertResumeFlagsMatch(answers, options.flags)` (two call sites: the bundle-flags check and
the plain resume check) with `reconcileResumeFlags`, passing the resumed `InstallProgress`'s done
steps (`new Set(Object.entries(progress.steps).filter(([, record]) => record.status === "done").map(([id]) => id))`), and use its returned `InitAnswers` as `initialAnswers` going forward (previously
the stored answers were used unchanged; now a reconciled copy, possibly with one field updated, is
used and re-persisted via the existing `saveAnswers` path before any step runs).

- [ ] **Step 5: Run the suites, then commit**

Run: `npx vitest run tests/contract/init-answer-dependencies.test.ts tests/contract/init-answers.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init/answer-dependencies.ts packages/cli/src/init/answers.ts packages/cli/src/init/commands.ts tests/contract/init-answer-dependencies.test.ts tests/contract/init-answers.test.ts
git commit -m "feat(init): a locked answer refuses by name on resume, on the page and from a flag (048 FR-062, FR-072)"
```

---

### Task 5: A deploy-step failure carries its own recovery kind (FR-061)

**Files:**
- Modify: `packages/cli/src/init/stop.ts` (`markRecoverableFailure`, `recoverableFailureOf`, beside `markOperatorStop`)
- Modify: `packages/cli/src/init/ui/failure.ts` (`FailureAction` widens; `askFailureAction` reads the tag)
- Test: `tests/contract/init-stop.test.ts` (new, or add to an existing stop-adjacent test file; check
  whether `stop.ts` already has one before creating a duplicate), `tests/contract/init-ui-failure.test.ts`

**Interfaces:**
- Consumes: phase 1's `markOperatorStop`/`isOperatorStop` (the `WeakSet` pattern this task mirrors).
- Produces:
  ```ts
  export type RecoverableFailureKind =
    | { kind: "change"; field: SettingsFieldName | "workerImage" | "slackImage" }
    | { kind: "fix-elsewhere"; link: { url: string; label: string } }
    | { kind: "cleanup"; stacks: readonly string[] };
  export function markRecoverableFailure<T>(error: T, info: RecoverableFailureKind): T;
  export function recoverableFailureOf(error: unknown): RecoverableFailureKind | undefined;
  ```
  `FailureAction` (ui/failure.ts) widens from `"retry" | "stop"` to `"retry" | "change" | "fix-elsewhere" | "cleanup" | "stop"`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("spec 048 phase 3: a recoverable failure carries its own kind", () => {
  it("round-trips the kind a step tagged, and reports none for an untagged error", () => {
    const error = markRecoverableFailure(new Error("x"), { kind: "cleanup", stacks: ["agentx-staging-core"] });
    expect(recoverableFailureOf(error)).toEqual({ kind: "cleanup", stacks: ["agentx-staging-core"] });
    expect(recoverableFailureOf(new Error("y"))).toBeUndefined();
  });
});

// tests/contract/init-ui-failure.test.ts
it("offers Change <answer>, I fixed it or Clean up when the failure names one, alongside Try again and Stop for now", async () => {
  const tagged = markRecoverableFailure(new Error("x"), { kind: "fix-elsewhere", link: { url: "https://x", label: "Open x" } });
  const action = await askFailureAction(scriptedPrompter(["fix-elsewhere"]), { retry: true, recoverable: recoverableFailureOf(tagged) });
  expect(action).toBe("fix-elsewhere");
});

it("keeps the plain retry-or-stop menu when nothing is tagged", async () => {
  await expect(askFailureAction(scriptedPrompter(["retry"]), { retry: true })).resolves.toBe("retry");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-failure.test.ts`
Expected: FAIL: `markRecoverableFailure` is not exported; `askFailureAction` takes no `recoverable`.

- [ ] **Step 3: Write minimal implementation**

In `stop.ts`, beside the existing `chosen`/`worded` WeakSets:

```ts
const recoverable = new WeakMap<object, RecoverableFailureKind>();
export function markRecoverableFailure<T>(error: T, info: RecoverableFailureKind): T {
  if (typeof error === "object" && error !== null) recoverable.set(error, info);
  return error;
}
export function recoverableFailureOf(error: unknown): RecoverableFailureKind | undefined {
  return typeof error === "object" && error !== null ? recoverable.get(error) : undefined;
}
```

(`RecoverableFailureKind` itself can live in `stop.ts` or a small shared types file; put it wherever
`FailureAction` already lives so `ui/failure.ts` imports one thing, not two.)

In `ui/failure.ts`, `askFailureAction` gains the `recoverable` input and builds its choice list from
it:

```ts
export async function askFailureAction(prompter: Prompter, input: { retry: boolean; recoverable?: RecoverableFailureKind }): Promise<FailureAction> {
  const extra = input.recoverable === undefined ? [] : [{
    value: input.recoverable.kind as FailureAction,
    label: input.recoverable.kind === "change" ? `Change ${changeFieldLabel(input.recoverable.field)}`
      : input.recoverable.kind === "fix-elsewhere" ? "I fixed it, check again"
        : "Clean up and try again",
  }];
  try {
    return await prompter.choose<FailureAction>("The install stopped. What next?", [
      ...(input.retry ? [{ value: "retry" as const, label: "Try this step again" }] : []),
      ...extra,
      { value: "stop" as const, label: "Stop for now" },
    ], { flag: "--on-failure", defaultValue: input.retry ? "retry" : (extra[0]?.value ?? "stop"), help: { label: "What would you like to do?", why: "Nothing is lost either way.", buttons: true } });
  } catch {
    return "stop";
  }
}
```

(`changeFieldLabel` is a small lookup from a `SettingsFieldName`/`"workerImage"`/`"slackImage"` to its
page words, e.g. `githubAccount` -> `"the GitHub owner"`; reuse `question-copy.ts`'s existing labels
where one already exists rather than writing a second copy of the same words.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-failure.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/stop.ts packages/cli/src/init/ui/failure.ts tests/contract/init-ui-failure.test.ts
git commit -m "feat(init): a failure carries its own recovery kind, and the failure screen offers it (048 FR-061)"
```

---

### Task 6: "Clean up and try again" for a stuck stack (FR-061)

**Files:**
- Create: `packages/cli/src/init/cleanup.ts`
- Modify: `packages/cli/src/init/context.ts` (`StackStatusReader.delete?`)
- Modify: `packages/cli/src/init/deploy-steps.ts` (`deployStep` tags a stuck-stack failure before throwing)
- Test: `tests/contract/init-cleanup.test.ts` (new), `tests/contract/init-deploy-steps.test.ts`

**Interfaces:**
- Consumes: Task 5's `markRecoverableFailure`; `StackStatusReader.status`; `DEPLOY_STEP_PARTS`.
- Produces:
  ```ts
  export const STUCK_STATUSES = ["ROLLBACK_COMPLETE", "ROLLBACK_FAILED", "DELETE_FAILED"] as const;
  export function isStuckStatus(status: string | undefined): boolean;
  export async function cleanUpStuckStacks(input: { reader: StackStatusReader; stackNames: readonly string[]; write: (line: string) => void }): Promise<string[]>; // returns the stacks actually deleted
  ```
  `StackStatusReader` (context.ts) gains `delete?(stackName: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-cleanup.test.ts
import { describe, expect, it } from "vitest";
import { cleanUpStuckStacks, isStuckStatus } from "../../packages/cli/src/init/cleanup.js";

describe("spec 048 phase 3: cleaning up a stuck stack before a retry (FR-061)", () => {
  it("names ROLLBACK_COMPLETE, ROLLBACK_FAILED and DELETE_FAILED as stuck, and nothing else", () => {
    expect(isStuckStatus("ROLLBACK_COMPLETE")).toBe(true);
    expect(isStuckStatus("UPDATE_ROLLBACK_COMPLETE")).toBe(false);
    expect(isStuckStatus("CREATE_COMPLETE")).toBe(false);
    expect(isStuckStatus(undefined)).toBe(false);
  });

  it("deletes only the stuck stacks among those named, and says which", async () => {
    const statuses: Record<string, string | undefined> = { "agentx-staging-foundation": "ROLLBACK_COMPLETE", "agentx-staging-identity": "CREATE_COMPLETE" };
    const deleted: string[] = [];
    const lines: string[] = [];
    const reader = { status: async (name: string) => statuses[name], delete: async (name: string) => { deleted.push(name); } };
    const result = await cleanUpStuckStacks({ reader, stackNames: ["agentx-staging-foundation", "agentx-staging-identity"], write: (line) => lines.push(line) });
    expect(result).toEqual(["agentx-staging-foundation"]);
    expect(deleted).toEqual(["agentx-staging-foundation"]);
    expect(lines).toContain("Deleting agentx-staging-foundation (ROLLBACK_COMPLETE) before trying again");
  });
});
```

```ts
// in tests/contract/init-deploy-steps.test.ts
it("tags a ROLLBACK_COMPLETE stack's failure as cleanup, naming the stuck stacks", async () => {
  const reader = { status: async (name: string) => (name.endsWith("foundation") ? "ROLLBACK_COMPLETE" : undefined) };
  const step = deployStep({ id: "core", title: "Build the network and sign-in" });
  const context = initContext({ stackStatus: reader });
  const error = await step.run(context, progressHandle()).catch((caught: unknown) => caught);
  expect(recoverableFailureOf(error)).toMatchObject({ kind: "cleanup", stacks: ["agentx-staging-foundation"] });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-cleanup.test.ts tests/contract/init-deploy-steps.test.ts`
Expected: FAIL: `cleanup.js` does not exist; `deployStep` throws untagged.

- [ ] **Step 3: Write minimal implementation**

`cleanup.ts`:

```ts
export const STUCK_STATUSES = ["ROLLBACK_COMPLETE", "ROLLBACK_FAILED", "DELETE_FAILED"] as const;
export const isStuckStatus = (status: string | undefined): boolean => STUCK_STATUSES.includes(status as (typeof STUCK_STATUSES)[number]);

export async function cleanUpStuckStacks(input: { reader: StackStatusReader; stackNames: readonly string[]; write: (line: string) => void }): Promise<string[]> {
  const deleted: string[] = [];
  for (const stackName of input.stackNames) {
    const status = await input.reader.status(stackName);
    if (!isStuckStatus(status)) continue;
    input.write(`Deleting ${stackName} (${status}) before trying again`);
    await input.reader.delete?.(stackName);
    deleted.push(stackName);
  }
  return deleted;
}
```

In `deploy-steps.ts`'s `deployStep`, after `waitForIdleStacks` and before `deployEnvironment`, check
each part's stack for a stuck status and, if any is found, throw a tagged, user-facing error instead
of calling `deployEnvironment` (which would fail on CloudFormation's own refusal to update a
`ROLLBACK_COMPLETE` stack anyway, with a far less useful message):

```ts
      const stuck = (await Promise.all(stackNames.map(async (name) => [name, await context.stackStatus.status(name)] as const))).filter(([, status]) => isStuckStatus(status)).map(([name]) => name);
      if (stuck.length > 0) {
        throw markRecoverableFailure(agentXError("CONFIG_INVALID", `${stuck.join(", ")} ${stuck.length === 1 ? "is" : "are"} stuck from an earlier run that did not finish; clean up and try again`), { kind: "cleanup", stacks: stuck });
      }
```

The "Clean up and try again" action, chosen via `askFailureAction`, calls `cleanUpStuckStacks` with
the tagged stacks before the step's own retry (wired in `commands.ts`'s `onStepFailure`, Task 7).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-cleanup.test.ts tests/contract/init-deploy-steps.test.ts`
Expected: PASS.

- [ ] **Step 5: `cloudFormationStatusReader` gets a real `delete`**

In `commands.ts`'s `cloudFormationStatusReader` (context.ts or wherever it is built; confirm which
file owns it before editing), add:

```ts
    async delete(stackName) {
      await client.send(new DeleteStackCommand({ StackName: stackName }));
    },
```

(Import `DeleteStackCommand` from `@aws-sdk/client-cloudformation`, already a dependency.)

- [ ] **Step 6: Run the whole init suite, then commit**

Run: `npx vitest run tests/contract/init-cleanup.test.ts tests/contract/init-deploy-steps.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init/cleanup.ts packages/cli/src/init/context.ts packages/cli/src/init/deploy-steps.ts tests/contract/init-cleanup.test.ts tests/contract/init-deploy-steps.test.ts
git commit -m "feat(init): a stuck stack is deleted before the step runs again, named in the failure (048 FR-061)"
```

---

### Task 7: Wire every recovery kind into `onStepFailure`, and "Change `<answer>`" reopens one field (FR-061, FR-062)

**Files:**
- Modify: `packages/cli/src/init/commands.ts` (`onStepFailure`, the GitHub-owner-style tagging at the point the control-plane and github-app steps fail for an answer reason)
- Test: `tests/contract/init-cli.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5 and 6's `canChangeAnswer`, `lockingStep`, `recoverableFailureOf`,
  `cleanUpStuckStacks`.
- Produces: nothing new exported; this task is the glue.

- [ ] **Step 1: Write the failing tests**

```ts
it("spec 048 FR-062: the GitHub owner cannot change once the GitHub app exists; Start over names it", async () => {
  // Drive a run where the github-app step has finished, then fail a later step with a tag
  // naming githubAccount as the field to change; assert the failure screen's `next` names
  // the github-app step and offers no Change action, only Try again and Stop for now.
  const { result, screens } = await runToFailureWithTag({ field: "githubAccount", doneSteps: ["prerequisites", "github-app", "access"] });
  expect(screens.at(-1)).toMatchObject({ next: expect.stringContaining("the github-app step already created the GitHub App") });
  // askFailureAction is never given a "change" choice for a locked field.
});

it("spec 048 FR-062: an unlocked field's Change action reopens one field and reruns only the failed step", async () => {
  const { ran, finalValue } = await runToFailureWithTag({ field: "workerModel", doneSteps: ["prerequisites", "github-app", "access", "core"], onFieldPrompt: ["us.anthropic.claude-sonnet-4-6"] });
  expect(ran).toEqual(["control-plane"]); // not access or core again
  expect(finalValue).toBe("us.anthropic.claude-sonnet-4-6");
});
```

(`runToFailureWithTag` is a new small test helper in this file or `tests/support/init-ui-harness.ts`,
built from the existing `initContext`/`runInitSteps` fakes already in `init-fakes.ts`; write it to
drive exactly the scenario each test needs, reusing `scriptedPrompter` for the field re-ask.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-cli.test.ts`
Expected: FAIL: today's `onStepFailure` only offers retry or stop.

- [ ] **Step 3: Write minimal implementation**

In `commands.ts`'s `onStepFailure` hook:

```ts
        onStepFailure: async ({ id, title, error }) => {
          const wizard = session.wizard;
          if (wizard === undefined) return "stop";
          if (isOperatorStop(error)) return "stop";
          const recoverable = recoverableFailureOf(error);
          const changeField = recoverable?.kind === "change" ? recoverable.field : undefined;
          const locked = changeField !== undefined && !canChangeAnswer(changeField as SettingsFieldName, doneStepIds());
          wizard.showFailure(failureScreen({
            env, region, stepTitle: title, stepId: id, error, ...(wizard.logPath === undefined ? {} : { logPath: wizard.logPath }),
            ...(locked ? { lockedBy: lockingStep(changeField as SettingsFieldName, doneStepIds()) } : {}),
          }));
          const action = await askFailureAction(activePrompter, {
            retry: isRetryableStep(id),
            ...(recoverable === undefined || locked ? {} : { recoverable }),
          });
          if (action === "retry") { wizard.clearFailure(); return "retry"; }
          if (action === "cleanup" && recoverable?.kind === "cleanup") {
            await cleanUpStuckStacks({ reader: stackStatus, stackNames: recoverable.stacks, write });
            wizard.clearFailure();
            return "retry";
          }
          if (action === "fix-elsewhere" && recoverable?.kind === "fix-elsewhere") {
            wizard.clearFailure();
            return "retry";
          }
          if (action === "change" && changeField !== undefined && !locked) {
            const newValue = await askForm(activePrompter, "Change the answer", [singleField(changeField)]);
            applyChangedAnswer(changeField, newValue[changeField] ?? "");
            wizard.clearFailure();
            return "retry";
          }
          session.failureShown = true;
          return "stop";
        },
```

(`doneStepIds()` reads the current `InstallProgress` the step runner already tracks via its
`ProgressHandle`; `singleField` and `applyChangedAnswer` are small helpers built from Task 2's
single-field re-ask pattern, generalized to any `SettingsFieldName`. `failureScreen` gains an optional
`lockedBy?: InitStepId` input and, when given, its `next` sentence names the step: see Task 5's
`ui/failure.ts` change; add this there if it is not already covered by Task 5's work; confirm before
duplicating.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/commands.ts tests/contract/init-cli.test.ts
git commit -m "feat(init): a deploy failure's recovery action is wired end to end, locked answers refused by name (048 FR-061, FR-062)"
```

---

### Task 8: A shared "ask before giving up" helper for a wait with a deadline (FR-064)

**Files:**
- Modify: `packages/cli/src/init/retry.ts` (`waitWithCheckIn`, or `packages/cli/src/init/context.ts` if it fits better beside `InstallSurface`; put it in `retry.ts`, beside `retryOnPage`, since both share the "only ask with a surface" rule)
- Test: `tests/contract/init-retry.test.ts`

**Interfaces:**
- Consumes: `InstallSurface`, `Prompter`.
- Produces:
  ```ts
  /** Runs `poll()` on an interval until it settles or `deadlineMs` passes; at the deadline, with a
   * surface, asks `question` and extends by another `deadlineMs` on yes. Without a surface, gives up
   * exactly as `deadline()` already would on its own (FR-064's rule only applies on the page). */
  export async function waitWithCheckIn<T>(input: {
    surface: InstallSurface | undefined; prompter: Prompter; now: () => number; sleep: (ms: number) => Promise<void>;
    pollMs: number; deadlineMs: number; question: string;
    poll: () => Promise<T | undefined>;
    giveUp: () => Error;
  }): Promise<T>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe("spec 048 phase 3: waitWithCheckIn asks before giving up, only with a page (FR-064)", () => {
  it("without a surface, gives up at the deadline exactly as before", async () => {
    let clock = 0;
    await expect(waitWithCheckIn({
      surface: undefined, prompter: scriptedPrompter([]), now: () => clock, sleep: async (ms) => { clock += ms; },
      pollMs: 1000, deadlineMs: 3000, question: "Still there?", poll: async () => undefined, giveUp: () => new Error("gave up"),
    })).rejects.toThrow("gave up");
  });

  it("with a surface, asks at the deadline and keeps polling on yes", async () => {
    let clock = 0;
    let polls = 0;
    const result = await waitWithCheckIn({
      surface: surface(), prompter: scriptedPrompter([true]), now: () => clock, sleep: async (ms) => { clock += ms; },
      pollMs: 1000, deadlineMs: 2000, question: "Still there? Keep waiting?",
      poll: async () => { polls += 1; return polls > 3 ? "done" : undefined; }, giveUp: () => new Error("gave up"),
    });
    expect(result).toBe("done");
    expect(polls).toBeGreaterThan(3);
  });

  it("with a surface, gives up when the answer is no", async () => {
    let clock = 0;
    await expect(waitWithCheckIn({
      surface: surface(), prompter: scriptedPrompter([false]), now: () => clock, sleep: async (ms) => { clock += ms; },
      pollMs: 1000, deadlineMs: 2000, question: "Still there?", poll: async () => undefined, giveUp: () => new Error("gave up"),
    })).rejects.toThrow("gave up");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-retry.test.ts`
Expected: FAIL: `waitWithCheckIn` is not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
export async function waitWithCheckIn<T>(input: {
  surface: InstallSurface | undefined; prompter: Prompter; now: () => number; sleep: (ms: number) => Promise<void>;
  pollMs: number; deadlineMs: number; question: string;
  poll: () => Promise<T | undefined>;
  giveUp: () => Error;
}): Promise<T> {
  let deadline = input.now() + input.deadlineMs;
  for (;;) {
    const found = await input.poll();
    if (found !== undefined) return found;
    if (input.now() < deadline) {
      await input.sleep(input.pollMs);
      continue;
    }
    if (input.surface === undefined) throw input.giveUp();
    if (!(await input.prompter.confirm(input.question, { defaultValue: true }))) throw input.giveUp();
    deadline = input.now() + input.deadlineMs;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/retry.ts tests/contract/init-retry.test.ts
git commit -m "feat(init): a wait with a deadline asks to keep waiting instead of ending the run, only on the page (048 FR-064)"
```

---

### Task 9: Apply it to the GitHub App wait and the Slack Request URL wait (FR-064)

**Files:**
- Modify: `packages/cli/src/init/context.ts` (`OpenManifestHost`'s input gains `onTimeout?`)
- Modify: `packages/cli/src/init/github-app.ts` (`startManifestListener`'s timer; `createWithManifest` supplies `onTimeout` and the card's `waitUntil`/`waitLabel`)
- Modify: `packages/cli/src/init/ui/server.ts` (`mountManifest`'s timer gets the same treatment)
- Modify: `packages/cli/src/init/slack-app.ts` (`probeSlackUrls` gains `onTimeout`; `verifySlackUrls` supplies it)
- Modify: `packages/cli/src/init/ui/cards.ts` (the GitHub "create" card gains `waitUntil`)
- Test: `tests/contract/init-github-app.test.ts`, `tests/contract/init-slack-app.test.ts`, `tests/contract/init-ui-server.test.ts`

**Interfaces:**
- Consumes: Task 8's pattern (not its function directly; the GitHub and Slack waits live inside a
  promise/timer this task does not restructure into polling, so each gets its own `onTimeout` rather
  than calling `waitWithCheckIn`; the gate; only ask with a surface; is the same rule, applied by
  hand).
- Produces: `OpenManifestHost`'s input type gains `onTimeout?: () => Promise<boolean>`; `probeSlackUrls`'s input gains the same.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-github-app.test.ts
it("spec 048 FR-064: with onTimeout, asks instead of giving up, and extends on yes", async () => {
  const askedTimes: boolean[] = [];
  const onTimeout = async () => { askedTimes.push(true); return askedTimes.length === 1; }; // yes once, then no
  const listener = await startManifestListener({ state: "s", page: () => "<p></p>", timeoutMs: 50, onTimeout });
  await expect(listener.code).rejects.toThrow(/no GitHub App was created within/);
  expect(askedTimes.length).toBe(2);
  listener.close();
});

it("without onTimeout, still gives up exactly as before", async () => {
  const listener = await startManifestListener({ state: "s", page: () => "<p></p>", timeoutMs: 20 });
  await expect(listener.code).rejects.toThrow(/no GitHub App was created within/);
  listener.close();
});
```

```ts
// tests/contract/init-slack-app.test.ts
it("spec 048 FR-064: with onTimeout, extends the Slack probe's deadline instead of throwing", async () => {
  let clock = 0;
  const fetchImpl = (async () => new Response(null, { status: 401 })) as typeof fetch;
  let asked = 0;
  await expect(probeSlackUrls({
    eventsUrl: "https://x/events", interactivityUrl: "https://x/interactive", signingSecret: "a".repeat(32),
    fetch: fetchImpl, now: () => clock, sleep: async (ms) => { clock += ms; }, write: () => undefined,
    timeoutMs: 1000, pollMs: 100,
    onTimeout: async () => { asked += 1; return asked === 1; },
  })).rejects.toThrow(/still refuses requests/);
  expect(asked).toBe(2);
});
```

(These two tests prove the deadline is reached twice before giving up, once extended and once not,
rather than asserting a specific wall-clock duration.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-github-app.test.ts tests/contract/init-slack-app.test.ts`
Expected: FAIL: neither function accepts `onTimeout`.

- [ ] **Step 3: Write minimal implementation**

In `github-app.ts`'s `startManifestListener`, replace the one-shot timer with a self-resetting one:

```ts
  let timer: NodeJS.Timeout;
  const arm = () => {
    timer = setTimeout(async () => {
      if (input.onTimeout !== undefined && (await input.onTimeout())) { arm(); return; }
      stop();
      rejectCode(agentXError("CONFIG_INVALID", `no GitHub App was created within ${Math.round(input.timeoutMs / 60_000)} minutes; run agentx init again`));
    }, input.timeoutMs);
  };
  arm();
```

(`input: { ...; onTimeout?: () => Promise<boolean> }`; the return object's `close` still clears
whatever `timer` currently holds.) Apply the identical change to `ui/server.ts`'s `mountManifest`.

In `slack-app.ts`'s `probeSlackUrls`, change `retry`'s deadline check:

```ts
  const retry = async (url: string) => {
    if (input.now() >= deadline) {
      if (input.onTimeout !== undefined && (await input.onTimeout())) { deadline = input.now() + timeoutMs; }
      else {
        throw new SlackSignatureRefusedError(`${url} still refuses requests signed with the new signing secret after ${Math.round(timeoutMs / 60_000)} minutes; check that you pasted the Signing Secret, not the Client Secret, and that this computer's clock is correct (Slack refuses signatures older than 5 minutes), then run agentx init again`, url);
      }
    }
    ...
```

(`deadline` was `const`; make it `let` and add `onTimeout?: () => Promise<boolean>` to the input
type.)

In `createWithManifest` (github-app.ts), supply `onTimeout` only with a surface, and give the
"create" card a countdown:

```ts
  const listener = await openHost({
    state, page: ..., timeoutMs: GITHUB_WAIT_MS,
    ...(context.surface === undefined ? {} : { onTimeout: () => context.prompter.confirm("Still there? Keep waiting for GitHub?", { defaultValue: true }) }),
  });
  show({ stage: "create", appName, account, startUrl: listener.startUrl, ...(context.surface === undefined ? {} : { until: new Date(context.now() + GITHUB_WAIT_MS).toISOString() }) });
```

In `ui/cards.ts`'s `githubCard`, the `"create"` stage's input gains `until?: string`, passed through
as `waitUntil: input.until` and `waitLabel: "Still there? Keep waiting."` (Task 10 defines
`waitLabel`'s wiring in `page.ts`; this task only sets the field).

In `verifySlackUrls` (slack-app.ts), supply `onTimeout` the same way, wrapping `probeSlackUrls`'s
call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-github-app.test.ts tests/contract/init-slack-app.test.ts tests/contract/init-ui-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/context.ts packages/cli/src/init/github-app.ts packages/cli/src/init/ui/server.ts packages/cli/src/init/slack-app.ts packages/cli/src/init/ui/cards.ts tests/contract/init-github-app.test.ts tests/contract/init-slack-app.test.ts
git commit -m "feat(init): the GitHub and Slack waits ask to keep waiting instead of ending the run, only on the page (048 FR-064)"
```

---

### Task 10: The countdown's zero-text for a wait that would otherwise end the run (FR-064)

**Files:**
- Modify: `packages/cli/src/init/ui/protocol.ts` (`WizardCard.waitLabel?`)
- Modify: `packages/cli/src/init/ui/page.ts` (`untilText` reads it)
- Test: `tests/contract/init-ui-page.test.ts`

**Interfaces:**
- Consumes: Task 9's `waitUntil`/`waitLabel` on the GitHub "create" card and the Slack
  "waiting-for-secret" card.
- Produces: `WizardCard.waitLabel?: string` (the text `untilText` shows once the countdown reaches
  zero; defaults to `"Still checking."` when absent, exactly as phase 2 left it).

- [ ] **Step 1: Write the failing test**

```ts
it("FR-064: a card tagged with waitLabel shows it at zero instead of Still checking", () => {
  expect(WIZARD_JS).toContain("node.dataset.waitLabel");
  expect(WIZARD_JS).toContain('"Still checking."');
});
```

(A rendered-behavior test belongs in a page-level harness test if one already exercises `untilText`
directly; check `tests/contract/init-ui-page.test.ts` for an existing pattern that evaluates `WIZARD_JS` in a small DOM, and add a case there that sets `dataset.waitLabel` and asserts the zero-text
differs from the default, rather than only grepping the source string above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-page.test.ts`
Expected: FAIL: `untilText` has no `waitLabel` branch.

- [ ] **Step 3: Write minimal implementation**

In `page.ts`'s client module, where `untilText` is built (the `if (card.waitUntil)` block):

```js
  if (card.waitUntil) {
    const left = el("p", "hint");
    left.dataset.until = card.waitUntil;
    left.dataset.waitLabel = card.waitLabel || "Still checking.";
    left.textContent = untilText(left);
    section.append(left);
  }
```

and `untilText`:

```js
function untilText(node) {
  const seconds = Math.max(0, Math.round((Date.parse(node.dataset.until) - Date.now()) / 1000));
  return seconds > 0 ? "About " + clockText(seconds) + " left." : node.dataset.waitLabel;
}
```

In `protocol.ts`, `WizardCard` gains `/** FR-064: the countdown's text once it reaches zero, for a
wait that would otherwise end the run. "Still checking." when absent. */ waitLabel?: string;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-ui-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/page.ts tests/contract/init-ui-page.test.ts
git commit -m "feat(init): a wait that would otherwise end the run reads Still there, Keep waiting at zero (048 FR-064)"
```

---

### Task 11: The wizard's port and token survive a restart (FR-063)

**Files:**
- Create: `packages/cli/src/init/session-file.ts`
- Modify: `packages/cli/src/init/ui/server.ts` (`startWizardServer` takes `preferredPort`/`preferredToken`, falls back on bind failure)
- Modify: `packages/cli/src/init/ui/index.ts` (`startInstallWizard` reads/writes the session file)
- Modify: `packages/cli/src/init/commands.ts` (passes `services.home`/`env` through; deletes the
  session file once the install is truly complete)
- Test: `tests/contract/init-session-file.test.ts` (new), `tests/contract/init-ui-server.test.ts`, `tests/contract/init-ui-index.test.ts` (new, or add to the nearest existing one covering `startInstallWizard`; check for one before creating a duplicate)

**Interfaces:**
- Consumes: phase 1's `startWizardServer`, `startInstallWizard`; `log-file.ts`'s path convention.
- Produces:
  ```ts
  export function sessionFilePath(home: string, env: string): string;
  export function readSession(path: string): Promise<{ port: number; token: string } | undefined>;
  export function writeSession(path: string, session: { port: number; token: string }): Promise<void>;
  export function deleteSession(path: string): Promise<void>;
  ```
  `startWizardServer`'s input gains `preferredPort?: number` (distinct from the existing `port`,
  which tests use to pin an exact bind with no fallback); on `EADDRINUSE` with `preferredPort` given,
  it retries once with `port: 0` and a freshly generated token, and its return value gains `reused:
  boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-session-file.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deleteSession, readSession, sessionFilePath, writeSession } from "../../packages/cli/src/init/session-file.js";

describe("spec 048 phase 3: the wizard's session file (FR-063)", () => {
  let home: string;
  afterEach(async () => { if (home) await rm(home, { recursive: true, force: true }); });

  it("writes and reads back the port and token, mode 0600", async () => {
    home = await mkdtemp(join(tmpdir(), "agentx-session-"));
    const path = sessionFilePath(home, "staging");
    await writeSession(path, { port: 54321, token: "abc" });
    expect(await readSession(path)).toEqual({ port: 54321, token: "abc" });
    const stat = await (await import("node:fs/promises")).stat(path);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("reads undefined when there is nothing saved yet, or the file is unreadable JSON", async () => {
    home = await mkdtemp(join(tmpdir(), "agentx-session-"));
    expect(await readSession(sessionFilePath(home, "staging"))).toBeUndefined();
  });

  it("deletes the file without throwing when there is nothing to delete", async () => {
    home = await mkdtemp(join(tmpdir(), "agentx-session-"));
    await expect(deleteSession(sessionFilePath(home, "staging"))).resolves.toBeUndefined();
  });
});
```

```ts
// in tests/contract/init-ui-server.test.ts
it("spec 048 FR-063: reuses a preferred port and token when it can", async () => {
  const first = await startWizardServer({ token: "abc" });
  const second = await startWizardServer({ preferredPort: first.port, preferredToken: "abc" });
  expect(second.port).toBe(first.port);
  expect(second.token).toBe("abc");
  expect(second.reused).toBe(true);
  await Promise.all([first.close(), second.close()]);
});

it("spec 048 FR-063 (Review Focus 3): falls back to a fresh port and token when the preferred one is taken", async () => {
  const first = await startWizardServer({ token: "abc" });
  const second = await startWizardServer({ preferredPort: first.port, preferredToken: "abc" });
  expect(second.port).not.toBe(first.port);
  expect(second.token).not.toBe("abc");
  expect(second.reused).toBe(false);
  await Promise.all([first.close(), second.close()]);
});
```

(The second test needs `first` still bound; do not close it before starting `second`; so its port
is genuinely taken; this is intentionally the same shape as the first test but without closing
`first` first, proving the fallback by actual collision rather than a mock.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-session-file.test.ts tests/contract/init-ui-server.test.ts`
Expected: FAIL: `session-file.js` does not exist; `startWizardServer` has no `preferredPort`.

- [ ] **Step 3: Write minimal implementation**

`session-file.ts`, mirroring `log-file.ts`'s hardening:

```ts
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function sessionFilePath(home: string, env: string): string {
  return join(home, ".agentx", "sessions", `init-${env}.json`);
}

export async function readSession(path: string): Promise<{ port: number; token: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { port?: unknown; token?: unknown };
    if (typeof parsed.port === "number" && typeof parsed.token === "string") return { port: parsed.port, token: parsed.token };
    return undefined;
  } catch {
    return undefined;
  }
}

export async function writeSession(path: string, session: { port: number; token: string }): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, JSON.stringify(session), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deleteSession(path: string): Promise<void> {
  await rm(path, { force: true });
}
```

In `ui/server.ts`'s `startWizardServer`, change the listen step:

```ts
export async function startWizardServer(input: { hub: WizardHub; port?: number; preferredPort?: number; token?: string; preferredToken?: string }): Promise<WizardServer & { reused: boolean }> {
  let token = input.token ?? input.preferredToken ?? randomBytes(32).toString("base64url");
  // ...
  let reused = input.preferredPort === undefined ? true : true; // see below for the real logic
  await new Promise<void>((resolvePromise, reject) => {
    const tryPort = input.port ?? input.preferredPort ?? 0;
    const onError = (error: NodeJS.ErrnoException) => {
      if (input.preferredPort !== undefined && input.port === undefined && error.code === "EADDRINUSE") {
        server.removeListener("error", onError);
        token = randomBytes(32).toString("base64url");
        reused = false;
        server.listen(0, "127.0.0.1", () => resolvePromise());
        return;
      }
      reject(agentXError("CONFIG_INVALID", `could not open a local port on 127.0.0.1 for the install wizard (${error.code ?? error.name}); check that no firewall or security tool blocks local ports, or run agentx init --no-ui`));
    };
    server.once("error", onError);
    server.listen(tryPort, "127.0.0.1", () => { server.removeListener("error", onError); resolvePromise(); });
  });
  // ... (reused stays true unless the EADDRINUSE branch above ran)
  return { ...existingReturn, reused };
}
```

(Reconcile the sketch above with the function's real control flow; `token` becomes a `let`, and the
fallback path's `server.listen(0, ...)` success callback must still run the rest of the existing
success logic, which today lives after the `await new Promise` block reading `server.address()`; do
not duplicate that logic, restructure so both paths reach the same tail.)

In `ui/index.ts`'s `startInstallWizard`, accept and pass through `preferredPort`/`preferredToken`,
and return `reused` on the `InstallWizard` so `commands.ts` can log it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-session-file.test.ts tests/contract/init-ui-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `commands.ts`**

Before calling `startInstallWizard`, read the session file for `env`; pass its `port`/`token` as
`preferredPort`/`preferredToken`. After the wizard starts, write the session file with whatever port
and token were actually used (reused or fresh). In the success path (the existing `if (complete)`
branch in `runInit`), delete the session file once the ready screen's hold ends; a paused or failed
run's `finally` leaves the file in place so the next run can try to reuse it.

- [ ] **Step 6: Run the init suite, then commit**

Run: `npx vitest run tests/contract/init-session-file.test.ts tests/contract/init-ui-server.test.ts tests/contract/init-ui-index.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

```bash
git add packages/cli/src/init/session-file.ts packages/cli/src/init/ui/server.ts packages/cli/src/init/ui/index.ts packages/cli/src/init/commands.ts tests/contract/init-session-file.test.ts tests/contract/init-ui-server.test.ts
git commit -m "feat(init): the wizard reuses its last port and token when it can, so a left-open tab reconnects (048 FR-063)"
```

---

### Task 12: The lost-connection banner shows the continue command after a while (FR-067)

**Files:**
- Modify: `packages/cli/src/init/ui/state.ts` (`WizardHub.setContinueCommand`, `WizardState.continueCommand`)
- Modify: `packages/cli/src/init/ui/protocol.ts` (`WizardState.continueCommand?`)
- Modify: `packages/cli/src/init/ui/index.ts`/`commands.ts` (calls `setContinueCommand` once env and region are known)
- Modify: `packages/cli/src/init/ui/page.ts` (the `error` listener tracks elapsed time and renders the command)
- Test: `tests/contract/init-ui-hub.test.ts`, `tests/contract/init-ui-page.test.ts`

**Interfaces:**
- Consumes: `cliCommandLine`, `CliInvocation` (already used for every other continue command on the
  page).
- Produces: `WizardHub.setContinueCommand(command: string): void`; `WizardState.continueCommand?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-hub.test.ts
it("spec 048 FR-067: carries the continue command once set", () => {
  const hub = createWizardHub("staging");
  expect(hub.state().continueCommand).toBeUndefined();
  hub.setContinueCommand("agentx --env staging init --region us-east-1");
  expect(hub.state().continueCommand).toBe("agentx --env staging init --region us-east-1");
});
```

```ts
// tests/contract/init-ui-page.test.ts
it("spec 048 FR-067: after a while with no connection, the lost-connection note gets a copy-command row", () => {
  expect(WIZARD_JS).toContain("continueCommand");
  expect(WIZARD_JS).toContain("commandRow({");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-hub.test.ts tests/contract/init-ui-page.test.ts`
Expected: FAIL: `setContinueCommand` is not exported; the client has no such banner.

- [ ] **Step 3: Write minimal implementation**

In `state.ts`, add `continueCommand` to the hub's closed-over state, `setContinueCommand` to the
returned object, and include it in `state()`'s built object the same way `header`/`logPath` already
are. In `protocol.ts`, `WizardState` gains `continueCommand?: string`.

In `commands.ts`, right after `session.wizard?.setPlace({ account, region })` (both env and region
are known there), call `session.wizard?.setContinueCommand?.(cliCommandLine(session.invocation, `--env ${env} init --region ${region}`))`; exposing `setContinueCommand` on `InstallWizard`
(`ui/index.ts`) the same way `setPlace` already is.

In `page.ts`'s client module, replace the `error` listener:

```js
let lostSince = null;
source.addEventListener("error", () => {
  if (installerClosed) return;
  if (lostSince === null) lostSince = Date.now();
  if (Date.now() - lostSince < 20000) return;
  const note = byId("closed-note");
  note.replaceChildren(el("span", "", "Lost the connection to the installer. If it stopped, run this to continue:"));
  if (lastState && lastState.continueCommand) note.append(commandRow({ label: "Continue", command: lastState.continueCommand }));
  show("closed-note", true);
});
source.addEventListener("open", () => { lostSince = null; });
```

(The existing `readyState !== EventSource.CLOSED` guard is removed: it was the reason nothing showed
during a real outage, since `EventSource` stays in `CONNECTING`, not `CLOSED`, while it retries. The
20-second threshold is a plain constant here; if a named export reads better for tests, lift it as
`const LOST_CONNECTION_MS = 20000;` at the top of the module string.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-hub.test.ts tests/contract/init-ui-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/state.ts packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/index.ts packages/cli/src/init/commands.ts packages/cli/src/init/ui/page.ts tests/contract/init-ui-hub.test.ts tests/contract/init-ui-page.test.ts
git commit -m "feat(init): a lost connection shows the continue command after a while, not only silence (048 FR-067)"
```

---

### Task 13: Copy-lint coverage and the recovery section of `docs/install.md`

**Files:**
- Modify: `packages/cli/src/init/ui/question-copy.ts` (every new confirm/choose this phase added, if
  any slipped through earlier tasks without a catalog entry)
- Modify: `tests/contract/init-ui-copy-lint.test.ts` (seeded examples for any pattern this phase could
  newly trip: none expected, since every new string is plain words, but the self-review below checks)
- Modify: `docs/install.md`
- Test: `tests/contract/init-ui-copy-lint.test.ts`

**Interfaces:**
- Consumes: phase 1's `lintCopy`, `quotedStrings` (or however the existing copy-lint test gathers
  page text; read `init-ui-copy-lint.test.ts` first to match its pattern exactly).

- [ ] **Step 1: Write the failing test**

```ts
it("spec 048 phase 3: every new recovery string passes the copy-lint", () => {
  const entries: CopyEntry[] = [
    ...quotedStrings(WIZARD_JS).map((text) => ({ where: "page module", text, context: "page" as const })),
    ...QUESTION_COPY.flatMap((entry) => Object.values(typeof entry.help === "function" ? entry.help({} as RegExpExecArray) : entry.help).filter((value): value is string => typeof value === "string").map((text) => ({ where: "question-copy.ts", text, context: "page" as const }))),
  ];
  expect(lintCopy(entries)).toEqual([]);
});
```

(Match this to however the existing lint test already builds its `entries`; it likely already covers
`WIZARD_JS` and `QUESTION_COPY` in full from phase 1/2's own work, in which case this step only needs
to confirm the existing test still passes with this phase's new strings, and this task's "test" is
running the existing suite rather than writing a new assertion; write a new one only if the current
coverage genuinely misses a source this phase added, such as `changeFieldLabel`'s or
`specificActionLabel`'s strings if they are not already routed through `QUESTION_COPY`.)

- [ ] **Step 2: Run test to verify it fails (or passes already)**

Run: `npx vitest run tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS if every new string already routes through a linted source; FAIL naming the first
offending string otherwise.

- [ ] **Step 3: Fix any flagged string, add missing `question-copy.ts` entries**

Add catalog entries for every new confirm this phase introduced that has no page label yet: "Still
there? Keep waiting?" (the GitHub and Slack waits), "Your answers need a change. What next?" (if
phase 2 left it unlabelled), and the failure screen's own "What next?" choose question, matching
`askFailureAction`'s exact question text.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS.

- [ ] **Step 5: `docs/install.md`**

Add a "Fixing a failure" section: what each action does (Try again, Change the one answer, I fixed it
and check again, Clean up and try again, Start over, Stop for now), that a stopped install reopens at
the same address when you run `agentx init` again, and that a wait which reaches its time limit asks
whether to keep waiting instead of ending the run.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/ui/question-copy.ts tests/contract/init-ui-copy-lint.test.ts docs/install.md
git commit -m "test(init): every new recovery string passes the copy-lint; docs for recovery (048 FR-081, SC-011)"
```

---

### Task 14: The channel create-or-not decision moves to settings, and the Slack manifest's scopes follow it (FR-051, FR-053)

**Owner decision, 2026-10-02 (added after this plan's own review):** the channel create-or-not
question ("Should AgentX create the channel for you?") moves off the channel step and onto the
settings screen, asked before the Slack app is created, so the Slack app manifest can carry the
channel-creating scopes (`channels:manage`, `groups:write`) only when the answer is Yes, never
always. This needs code phase 2 owns (the settings screen, `settings-form.ts`; the Slack manifest
builder, `slack-app.ts`); phase 2's own branch is already in flight and is not touched by this plan,
so this task makes the change here, on top of phase 2's merged work, the same way every other task in
this plan builds on phase 2.

**Files:**
- Modify: `packages/cli/src/init/settings-form.ts` (phase 2's `SETTINGS_FIELD`, `settingsFields`)
- Modify: `packages/cli/src/init/slack-app.ts` (`SLACK_BOT_SCOPES` stays exactly as phase 1 left it;
  a new `CHANNEL_CREATE_SCOPES`; `slackAppManifest` and the one call site that builds the manifest
  from it, inside `slackAppStep`)
- Modify: `packages/cli/src/init/answer-dependencies.ts` (Task 4's `ANSWER_DEPENDS_ON` gains a row)
- Modify: wherever `--create-channel`/`--no-create-channel` are parsed into flags (confirm the exact
  file against the current flag table in `commands.ts`/`cli.ts` first; phase 4's plan already names
  these two flags for the project-form field this task is moving off of, so the flag names are fixed,
  only where they are read changes)
- Test: `tests/contract/init-settings-form.test.ts`, `tests/contract/init-slack-app.test.ts`,
  `tests/contract/init-answer-dependencies.test.ts`

**Interfaces:**
- Consumes: phase 2's `SETTINGS_FIELD`, `SettingsFieldName`, `settingsFields`,
  `CollectedAnswers.settings`; Task 4's `ANSWER_DEPENDS_ON`, `canChangeAnswer`; phase 1's
  `SLACK_BOT_SCOPES`, `SLACK_USER_SCOPES`, `slackAppManifest`.
- Produces:
  ```ts
  // settings-form.ts: SETTINGS_FIELD gains createChannel; settingsFields's Advanced section gains:
  // { name: "createChannel", question: "Should AgentX create the channel for you?",
  //   flag: "--create-channel", defaultValue: "yes", section: "advanced",
  //   choices: [{ value: "yes", label: "Yes, create it" }, { value: "no", label: "No, let me pick one" }],
  //   help: { why: "Slack fixes a bot's scopes when its app is created, so this is asked now, before
  //   the Slack app exists, rather than later at the channel step." } }
  // (an Advanced field with a sane default, same as every other Advanced field FR-021 requires; the
  // default-path's four required fields are unchanged)

  // slack-app.ts
  export const CHANNEL_CREATE_SCOPES: readonly string[]; // ["channels:manage", "groups:write"]
  export function slackAppManifest(input: {
    appName: string; eventsUrl: string; interactivityUrl: string; signInCallbackUrl: string;
    createChannel: boolean;
  }): SlackManifest;

  // answer-dependencies.ts: ANSWER_DEPENDS_ON gains createChannel: ["slack-app"], the same lock
  // appName already has, since both are baked into the manifest the moment the Slack app is created.
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-settings-form.test.ts, added case
it("owner decision 2026-10-02: settings asks the channel create-or-not question under Advanced, defaulting to Yes", () => {
  const fields = settingsFields({ env: "production", flags: {}, fixed: false, budgetWhy: "" });
  const decision = fields.find((field) => field.name === "createChannel");
  expect(decision).toMatchObject({ section: "advanced", defaultValue: "yes", choices: [{ value: "yes" }, { value: "no" }] });
});
```

```ts
// tests/contract/init-slack-app.test.ts, added describe block
describe("spec 048 phase 3, owner decision 2026-10-02: the manifest's channel-creating scopes follow the up-front decision (FR-053)", () => {
  it("includes channels:manage and groups:write only when the installer answered Yes", () => {
    const yes = slackAppManifest({ appName: "agentx-production", eventsUrl: "https://x/events", interactivityUrl: "https://x/interactivity", signInCallbackUrl: "https://x/callback", createChannel: true });
    expect(yes.oauth_config.scopes.bot).toEqual(expect.arrayContaining(["channels:manage", "groups:write"]));
    const no = slackAppManifest({ appName: "agentx-production", eventsUrl: "https://x/events", interactivityUrl: "https://x/interactivity", signInCallbackUrl: "https://x/callback", createChannel: false });
    expect(no.oauth_config.scopes.bot).not.toEqual(expect.arrayContaining(["channels:manage"]));
    expect(no.oauth_config.scopes.bot).not.toEqual(expect.arrayContaining(["groups:write"]));
  });
});
```

```ts
// tests/contract/init-answer-dependencies.test.ts, added case
it("owner decision 2026-10-02: locks the channel create-or-not decision once the Slack app step is done", () => {
  expect(canChangeAnswer("createChannel", new Set(["prerequisites", "github-app", "access", "core"]))).toBe(true);
  expect(canChangeAnswer("createChannel", new Set(["prerequisites", "github-app", "access", "core", "slack-app"]))).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-settings-form.test.ts tests/contract/init-slack-app.test.ts tests/contract/init-answer-dependencies.test.ts`
Expected: FAIL: no `createChannel` settings field; `slackAppManifest` has no `createChannel` input
and always includes the base scopes only; `ANSWER_DEPENDS_ON` has no `createChannel` row.

- [ ] **Step 3: Write minimal implementation**

In `settings-form.ts`, add `createChannel` to `SETTINGS_FIELD` and to `settingsFields`'s Advanced
section (placement among the other Advanced fields is not load-bearing; group it near `appName`
since both describe the Slack app, if the real file's field order makes that easy).

In `slack-app.ts`:

```ts
export const CHANNEL_CREATE_SCOPES: readonly string[] = ["channels:manage", "groups:write"];

export function slackAppManifest(input: { appName: string; eventsUrl: string; interactivityUrl: string; signInCallbackUrl: string; createChannel: boolean }): SlackManifest {
  const botScopes = input.createChannel ? [...SLACK_BOT_SCOPES, ...CHANNEL_CREATE_SCOPES] : [...SLACK_BOT_SCOPES];
  // ...unchanged manifest shape, except:
  // oauth_config: { redirect_urls: [input.signInCallbackUrl], scopes: { bot: botScopes, user: [...SLACK_USER_SCOPES] } },
}
```

Update `slackAppStep`'s one call to `slackAppManifest` to pass
`createChannel: context.answers.settings.createChannel !== "no"` (confirm `context.answers.settings`
is the right path to the stored settings-form values by the time `slackAppStep` runs, against
phase 2's merged `answers.ts`/`context.ts`, before wiring this; the field reads as a plain string,
same as every other `CollectedAnswers.settings` entry, never a secret).

In `answer-dependencies.ts`, add `createChannel: ["slack-app"]` to `ANSWER_DEPENDS_ON`.

Wherever `--create-channel`/`--no-create-channel` are parsed (confirm the exact file first): both
flags set the same `createChannel` flag value ("yes"/"no") the settings form reads, the same way a
boolean pair of flags already works elsewhere in this CLI if one exists, or, if none does yet, the
same way `askForm`'s terminal path already reads a `choices` field's flag value directly (`--create-channel yes`/`--create-channel no`) with `--no-create-channel` as a plain alias for
`--create-channel no`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-settings-form.test.ts tests/contract/init-slack-app.test.ts tests/contract/init-answer-dependencies.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/settings-form.ts packages/cli/src/init/slack-app.ts packages/cli/src/init/answer-dependencies.ts tests/contract/init-settings-form.test.ts tests/contract/init-slack-app.test.ts tests/contract/init-answer-dependencies.test.ts
git commit -m "feat(init): the channel create-or-not question moves to settings, before the Slack app exists, so its manifest scopes can follow the answer (048 FR-051, FR-053, owner decision 2026-10-02)"
```

---

## Self-Review

**1. Spec coverage (phase 3 row of the spec's Phases table):**

| Requirement | Task |
|---|---|
| FR-061 page actions fit the kind of failure: try again (phase 1), change the answer, fix elsewhere, clean up, stop for now | 1, 2, 3, 5, 6, 7 |
| FR-062 an answer changeable only when no finished step depends on it; Start over otherwise | 4, 7 |
| FR-063 same-address resume, the old tab reconnects, a taken address falls back | 11 |
| FR-064 a wait asks "Still there? Keep waiting" at its deadline instead of ending the run | 8, 9, 10 |
| FR-066 model and region failures offer Change the model/region; the Anthropic form offers its own three actions | 1, 2, 3 |
| FR-067 a lost connection tries to reconnect by itself and, after a while, shows the continue command | 12 |
| FR-051 (the create-or-not question, moved to settings), FR-053 (the manifest's scopes follow it): owner decision, 2026-10-02 | 14 |

**2. Placeholder scan:** every code step has real code; three steps are "find the exact current code
first" pointers (Task 2 Step 5, Task 7 Step 3's `doneStepIds()`/`singleField()`/`applyChangedAnswer()`
helpers, Task 9 Step 3's reconciliation of the sketch with `startWizardServer`'s real control flow)
rather than a vague instruction; each names the exact existing function or pattern to extend and the
exact new behavior wanted, because the single call site or helper shape depends on how phase 2's
review actually merged (a plan writer two phases ahead cannot pin a line number that does not exist
yet). This is reuse-and-adapt, not "add appropriate handling."

**3. Type consistency:** `CheckRecoveryAction` (Task 1) is what Task 2's `checkWithChangeOnPage` and
Task 3's Anthropic branch read. `RecoverableFailureKind` (Task 5) is what Task 6's `cleanup` tag and
Task 7's wiring both produce and consume. `SettingsFieldName` (phase 2) is what `ANSWER_DEPENDS_ON`
(Task 4), `reconcileResumeFlags` (Task 4) and `askFailureAction`'s `change` label (Task 5) all key on.
`WizardCard.waitLabel` (Task 10) is what Task 9's GitHub and Slack cards set. `SETTINGS_FIELD.createChannel`
(Task 14) is what Task 14's own `ANSWER_DEPENDS_ON` row and `slackAppManifest`'s new `createChannel`
input both key on, so the one up-front answer, the lock on changing it, and the manifest it shapes
never drift apart.

**4. Review Focus:** each of the five lines has its pinned test in the named task (Tasks 7, 4, 11, 6,
9). Task 14 was added after this plan's own review, by owner decision, so it adds no Review Focus
line of its own; its three tests (settings asks it, the manifest follows it, the lock holds) stand on
their own names.

## Rulings On Spec Ambiguities

1. **"Fix elsewhere, check again" has no deploy-time example in this codebase yet.** Every outside
   fix the spec names (quota, the Anthropic form, Slack admin approval) is caught before anything is
   created, where Task 2 and Task 3 already handle it through `checkWithChangeOnPage`. Task 5's
   `fix-elsewhere` kind on a deploy-step failure is built and tested as a generic mechanism (Task 7's
   wiring), ready for the first real deploy-time case a live run finds, rather than invented here.
2. **A session file, not a resumed port baked into `InstallAnswers`.** FR-063's address is a
   convenience for an open tab, not a fact the install itself depends on; keeping it out of
   `InstallAnswersSchema`/`InstallProgressSchema` means a hand-edited or copied answers file can never
   carry a stale token, and the file can be deleted at any time with no effect beyond losing the
   reconnect convenience.
3. **"Clean up and try again" deletes only the deploy parts the failing step itself owns.** A stack
   belonging to an earlier, already-finished step is never touched even if it were (hypothetically)
   also stuck, because `deployStep`'s stuck-stack check only looks at `DEPLOY_STEP_PARTS[input.id]`.
4. **The GitHub and Slack "Still there?" question reuses `prompter.confirm`, not a new question
   kind.** Both already have a `Prompter` in scope wherever they run; a new `WizardCard`-only
   mechanism would need its own POST route and duplicate everything `confirm` already does.
5. **`--on-check-failure`'s specific values (`change-model`, `change-region`, `change-image`,
   `anthropic-form`) are chosen, not typed by a person**, exactly like phase 2's `--on-check-failure`
   itself: a copy key for `question-copy.ts`, never documented as a real flag, consistent with phase
   2's own Fix round 1 ruling for the same flag.
6. **The channel create-or-not decision (Task 14) is an Advanced settings field, not a fifth
   default-path question.** FR-021 already requires every Advanced setting to have a working default;
   "Yes, create it" is that default, matching the page's own default-path answer and `--yes`'s
   existing behavior, so a newcomer who never opens Advanced still gets a created channel exactly as
   today's default-path user would. Only a person who wants the No path needs to find this field.

## Execution Handoff

Plan complete and saved to `specs/048-guided-install/plans/phase-3-recovery.md`. Implementation
starts only after phase 2's PR has merged into mainline (no stacking). Please review the plan. Which
execution approach would you prefer?

- **Subagent-driven:** a fresh subagent implements each task and a fresh reviewer checks it before
  the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context
  per task and per review.
- **Native:** one session implements every task, then one fresh reviewer on the most capable model
  checks the whole branch. Cheapest and fastest; no independent review until the end.

**Recommendation: subagent-driven**, because several tasks touch the same shared primitive from
different angles (Tasks 1 to 3 build and consume `CheckRecoveryAction` together; Tasks 5 to 7 do the
same for `RecoverableFailureKind`; Task 9 edits three files that must agree on one new callback
shape), and a per-task reviewer is the cheapest way to catch a drifted interface before the next task
builds on it.
