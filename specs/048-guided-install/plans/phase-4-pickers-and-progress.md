# Spec 048 Phase 4: Pickers and Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first project is one screen: a repository picker, the project name and commands
prefilled and editable, the channel's remaining fields (a name and public-or-private on Yes, or the
picker on No; the Yes/No decision itself is answered earlier, at settings, before the Slack app is
created: owner decision, 2026-10-02) and the issue trackers as checkboxes with "Skip for now".
Building in AWS shows real progress (resources done out of expected, combined across every stack a
step builds: owner decision, 2026-10-02), and "You can leave now", with time estimates measured from
clean runs rather than guessed. The admin sign-in, alerts and test-reply cards reuse what the
settings already know. The welcome screen can ask for a browser notification, and it fires once,
when the run starts waiting on the user after an unattended stretch.

**Architecture:**
- **The channel's own Yes/No decision is answered at settings, before this screen ever shows
  (owner decision, 2026-10-02, overruling this plan's first design below).** This plan originally
  put the create-or-not question on the project form itself, as a live field (`createChannel`) whose
  answer showed or hid the rest of the channel's fields with `showWhen`. The owner moved that
  question to the settings screen instead (phase 3's Task 14, built on top of phase 2, since Slack
  scopes are fixed the moment the Slack app is created and the project form only renders long after
  that). This phase's project form (Task 3) now reads the already-known answer,
  `context.answers.settings.createChannel`, and includes only the fields that answer calls for:
  `channelName`/`channelVisibility` on Yes (Task 4), or `channelPicked`/`channelNotListed` on No
  (Task 5), never both, and never a live `createChannel` field of its own. FR-050 still asks for the
  whole first project "on one screen"; it is the channel's own Yes/No branch that moved off of it.
  Task 2's `showWhen`/`multiple` capability is unaffected: `multiple` still has its real consumer in
  the trackers field (Task 3), and `showWhen` remains a generic, tested capability this phase does
  not currently have another consumer for, built once in case a later reviewer finds one.
- **The channel's backend already exists for the simple case; this phase widens it.**
  `setup/channel-add.ts`'s `SlackChannelApi` already lists and joins a named channel
  (`channels:read`, `groups:read`, `channels:join`, already in the manifest). This phase adds
  `create`, `list` (the same listing `find` already builds, exposed whole for a picker) and the two
  calls FR-051's invite needs (`users.lookupByEmail`, `conversations.invite`). The manifest's own
  `channels:manage`/`groups:write` scopes (FR-053) are no longer this phase's concern: phase 3's Task
  14 (owner decision, 2026-10-02) already makes the Slack app manifest carry them, or not, following
  the settings answer, before this phase's code ever runs. Finding the installer by the settings
  email reuses `lookupByEmail`; when Slack has no match, the picker reuses `list` as a member search
  instead of guessing.
- **The project form reuses `setup/project-add.ts`'s own logic, not a second copy of it.**
  `chooseRepository`, `proposeCommands` and `addProject`'s existing rules (an unchanged rerun asks
  nothing, a changed rerun is refused with what differs) stay exactly as they are; only how the
  values are asked changes, from five sequential questions to one form. The issue-tracker checkboxes
  set `context.flags.connectors` (the same string `connectorsStep` already parses with
  `parseConnectorsFlag`) before `connectorsStep` runs, so that step is untouched: it already skips
  asking when `flags.connectors` is set.
- **Real progress is a second, read-only poll beside the deploy, not a rewrite of it.** The deployer's
  own event stream (`progressLine`) is terminal/log text today, not structured counts. Rather than
  reshape it, a deploy step that wants a progress row polls `StackStatusReader`'s new
  `resourcesDone(stackName)` (a `DescribeStackResources` count of settled resources) every few seconds
  while `deployEnvironment` runs, racing the two with `Promise.race`-style concurrency the same way
  `waitForIdleStacks` already waits beside the step runner; "expected" comes from counting the
  release's own template JSON (`LoadedRelease.template(region, part)`, already read by every deploy
  step indirectly), never guessed.
- **The admin, alerts and reply cards learn one more fact each; their shape does not change.**
  `adminCard`, `alertsCard` and `replyCard` (spec 040) already say the right things; `adminUserStep`
  only needs to read `context.answers.adminEmail` (phase 2) before asking fresh, and the three
  wait-bearing cards in this phase (`adminCard`'s `"signing-in"`, `channelCard`'s `"waiting"`,
  `alertsCard`'s `"confirm"`/`"waiting"`) gain phase 3's `onTimeout`/`waitUntil`/`waitLabel` treatment
  so their own real deadlines ask "Still there? Keep waiting" instead of ending the run, reusing
  `waitWithCheckIn` directly (all three already poll on an interval, which is exactly its shape).
- **The notification is a client-side permission and a client-side comparison, nothing new on the
  server.** The welcome screen's existing `welcome` text gains one more line and a button;
  `Notification.requestPermission()` runs once, and the client compares the previous `waitingOnYou`
  to the new one on every `state` event, firing a `Notification` only on a false-to-true transition
  that follows at least one unattended `state` update (so the install's own first question, already
  visible the moment the page loads, never fires one for nobody).

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, Vitest 5, zod 4. No new dependency. The
page stays plain HTML, CSS and an ES module held as text in `page.ts` (spec 040).

**Spec:** [../spec.md](../spec.md), the binding authority. This plan delivers the spec's Phases row 4:
FR-002 (measured time estimates), FR-007 (real build progress), FR-050 to FR-053 (the first-project
screen, the channel question, the channel scopes), FR-055 to FR-057 (admin sign-in, alerts, test
reply) and FR-005's notification half (the tab-title half shipped in phase 1). Owner approval of the
spec, with all five open choices accepted: PR #231 comment of 2026-10-01. Design proposal: the guided
install design, section 2 screen notes 5.1 to 5.5 (the first-project screen's exact copy, the alerts
and test-reply screens, the ready screen) and section 10's decision 3 (the channel question's exact
wording and that the scopes are always in the manifest, which `spec.md`'s own "Decided in this spec"
section resolves the same way: always present, requested whichever way the user answers). The
measured-time-estimates column of section 8's dependency table ("rough" in option A, "measured" in
option B) is this plan's Task 10.

**Already covered elsewhere (checked 2026-10-02 against open issues and the two in-flight lanes; do
not duplicate):** issues #215 and #217 (Slack task-approval and confirmation-message copy) are
covered by lane B, branch `fix/slack-messages-215-219`, in flight; #222 (the ready screen's
unpublished package name and raw Slack markup) is CLOSED, fixed by phase 1's `readyCard`/`readyText`,
merged; #235 (Ctrl-C under `--no-ui` printing `INTERNAL_ERROR`) is covered by lane C, branch
`fix/cli-setup-218-235`, in flight. The spec's own Out Of Scope section also excludes #216, #218 to
#220, #221 and #225 from spec 048 entirely (task and admin product issues, and developer sign-in left
behind by teardown). None of these touches a file this plan modifies.

**Builds on:** phase 1 (`specs/048-guided-install/plans/phase-1-page-shell.md`, merged), phase 2
(`specs/048-guided-install/plans/phase-2-order-and-checks.md`) and phase 3
(`specs/048-guided-install/plans/phase-3-recovery.md`), merged into `mainline` before this phase's
branch is cut. Every interface this plan consumes is phase 2's or phase 3's as implemented there:
`SETTINGS_FIELD`, `SettingsFieldName`, `settingsFields`, `FormField`/`FormOptions`, `askForm`,
`CollectedAnswers.settings`, `WizardField`, `WizardQuestion.summary`/`submitLabel`, `PAGE_CLASSES`,
`WIZARD_CSS`, `questionHelp`, `lintCopy`, `stateEntries`, phase 3's `ANSWER_DEPENDS_ON`/
`canChangeAnswer`/`lockingStep` (`answer-dependencies.ts`), `waitWithCheckIn` (`retry.ts`),
`WizardCard.waitUntil`/`waitLabel`, `WizardState.continueCommand`, `markRecoverableFailure`/
`recoverableFailureOf` (`stop.ts`). If a later review renamed anything this plan names here, use the
merged name and say so in the PR description; never re-create an earlier phase's name under its old
spelling.

**Branch:** `feat/048-phase4-pickers-and-progress`, cut from `origin/mainline` **only after phase 3's
PR has merged into mainline**. One PR against `mainline` (no stacking: never branch from
`feat/048-phase3-recovery` or any other phase branch, never target one).

## Global Constraints

- **Start only after phase 3 merges.** Before Task 1: `git fetch origin`, confirm phase 3's
  implementation PR (not its plan PR) shows in `git log origin/mainline --oneline`, then cut the
  branch from `origin/mainline`.
- **Recorded installs still resume.** `INIT_STEP_IDS` and `INSTALL_STEP_ORDER` keep their order and
  ids; this plan adds no new step id. `InstallProgressSchema`'s `project` field gains optional
  sub-fields only (never a breaking change to `channelId`/`channelName`, which already exist).
- **The terminal path and `--yes` keep every flag and its meaning**, with deliberate, listed changes
  (FR-072). The channel's Yes/No decision gets its own flags, `--create-channel`/`--no-create-channel`
  (owner decision, 2026-10-02: read at settings, phase 3's Task 14, not here); its follow-up fields
  keep their flags (`--channel-visibility`, plus the existing `--channel` for a name on either path),
  asked in the same order the page's form would show them when no flag is given. `--yes` with neither
  `--create-channel` nor `--no-create-channel` defaults to "yes" ("Yes, create it"), exactly as a
  first-time user's default answer at settings would. **Owner decision, 2026-10-02 (spec Decisions,
  owner decision 9), resolving what was previously left as "pending owner decision" here:** `--channel
  <name>` means "use it or create it". Unless `--no-create-channel` is also given, passing `--channel
  <name>` counts as answering Yes, so the manifest carries the channel-creating scopes and the channel
  step creates the named channel if it does not exist (inviting the installer) or uses it if it does,
  resolving a taken name automatically (there is no one to ask, so `SlackNameTakenError`'s "Use that
  channel" default applies without a prompt), never stopping. `--no-create-channel` drops those scopes
  and keeps today's plain behavior: use an existing channel named by `--channel`, and if it is not
  found, stop with a clear message to create it and invite the bot (this is `bindPickedChannel`'s
  existing find-or-fail behavior, unchanged). No existing flag's meaning changes beyond this.
- **Exact names (this plan's own contract):** `showWhen` (on `FormField`/`WizardField`), `multiple`
  (on `FormField`/`WizardField`), `PROJECT_FIELD`, `projectFields`, `CHANNEL_DECISION_GROUP`,
  `SlackChannelApi.create`/`.list`/`.lookupByEmail`/`.invite`, `SLACK_BOT_SCOPES` gaining
  `channels:manage`/`groups:write`, `resourcesDone` (on `StackStatusReader`), `expectedResourceCount`,
  `buildProgressCard`, `NOTIFY_LABEL`.
- **Never print a secret.** No change here reads, logs or echoes the Bot User OAuth Token, Signing
  Secret, Client Secret or any connector credential; the installer's own Slack user id (found by
  email) is not a secret and may appear in a card's technical details, never in its plain lines.
- **Security rules of spec 040 hold:** loopback only, the session token, origin checks, secrets never
  echoed.
- **Copy:** plain words from the glossary (FR-080); no internal words, no em dashes, no phase or FR
  numbers outside a comment (FR-081). Page text never tells the user to pass a flag, run a command or
  read the terminal outside "Stop for now", the lost connection notice and the ready screen. The
  up-front invite command (FR-052) is shown with a copy button on the channel picker itself: this is
  not one of FR-081's four allowed places, so its exact text is the command alone
  (`/invite @<bot handle>`), never phrased as an instruction to "run" or "type" it in the terminal;
  `copy-lint.ts`'s existing rules already allow a bare Slack slash-command string outside the
  `"details"`/command contexts because it names no flag and no "run"/"type" verb, but Task 5 pins a
  seeded test proving it, since this is new ground for the lint, not a reuse of an existing allowance.
- **Look:** every new screen element uses the design system's tokens and classes (`design.ts`); a new
  class is added to `PAGE_CLASSES` and styled there; no inline style, no external asset.
- **Do not touch** `infra/` or any CloudFormation template. The legacy and named template snapshots
  (`tests/contract/__snapshots__/*.snap`) stay byte-identical.
- **Tests:** never `vitest -u`; no assertion removed or weakened. An existing assertion whose expected
  value this phase changes (a card's wording, a step's `usualSeconds`) is replaced by the new exact
  value.
- **Typecheck ratchet:** `npm run typecheck:all` must not report more errors than the baseline.
- **The gate**, on Node 22: `npm run typecheck:all && npm run lint && npm run build && npm test && npm run infra:synth`.
  - Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH` (or any
    Node 22.19 or later on PATH).
  - While iterating on one task, run only its test files with `npx vitest run <files>`.
  - CI (`.github/workflows/ci.yml`) runs `checks`, the test shards and the release check in parallel
    jobs; nothing in this plan changes that file.
- **No AWS, GitHub or Slack calls from tests.** Every new dependency (`SlackChannelApi.create`/
  `.list`/`.lookupByEmail`/`.invite`, `StackStatusReader.resourcesDone`, the Notification API) is
  injected and faked; the browser `Notification` constructor is read from `window`/`globalThis` only
  at the point it is used, never imported, so a test DOM with no such global never throws on load.
- **PRs:** one PR to `mainline`, never stacked, never force-pushed.
- **Never rewrite history.** No `git filter-branch`, `rebase`, `commit --amend` or force-push, on this
  branch or any other; a fix after review is always a new commit. No bare `git stash`; if one is
  needed, use `git stash push -u -m "<unique tag>"` and restore with `git stash apply`, never `pop`.
- **Commits:** each commit's trailer names the model that wrote it
  (`Co-Authored-By: <model> <noreply@anthropic.com>`); no em dashes anywhere a commit touches.
- **Build process:** the owner approves this plan, then picks the execution method. Implementers and
  reviewers run on Sonnet; only the final whole-branch review runs on Opus.

## Review Focus

1. **The Yes path's channel name is already taken by an existing channel.** Expected: the page says
   so in plain words and offers "Use that channel instead" (binding the existing one, exactly as the
   No path would) or "Pick another name"; nothing is left half-bound, and choosing "Use that channel"
   never tries to create it a second time. Pinned in Task 4 ("a taken channel name on the Yes path
   offers to use the existing channel or try another name").
2. **The installer's settings email matches no Slack member.** Expected: FR-051's fallback (the
   installer finds themselves in a member search) is offered rather than the step failing outright,
   and the channel is still created and joined even though no invite could be sent yet. Pinned in
   Task 4 ("an email Slack has no member for falls back to a member search, and the channel is still
   usable").
3. **The No path's picker is asked for a channel the bot can see in the list, and also for one typed
   into "not listed" that happens to match a listed one exactly.** Expected: picking from the list
   and typing the same name in "not listed" behave identically (both resolve to the one real channel,
   never two different code paths that could disagree about whether the bot is already in it). Pinned
   in Task 5 ("a typed name matching a listed channel resolves the same way the picker entry would").
4. **A repository whose build files propose no commands at all** (no `package.json`, no `go.mod`, no
   recognized build file). Expected: the form still shows empty, editable setup and test fields with
   the existing "optional, leave empty" hint, never a blank screen or a forced non-empty value. Pinned
   in Task 3 ("a repository with no recognized build file still gets an editable, optional pair of
   command fields").
5. **A deploy step's expected resource count cannot be read** (a release whose template this install's
   engine never reads locally, such as the cdk engine, which synthesizes rather than reading a
   downloaded template). Expected: the row shows elapsed time and "resources starting" without a
   count, never "NaN of undefined" or a crash. Pinned in Task 6 ("no known resource count shows
   elapsed time alone, never NaN").

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/init/ui/protocol.ts` | `WizardField.showWhen`/`.multiple`; `WizardQuestion` unchanged otherwise |
| `packages/cli/src/init/prompts.ts` | `FormField.showWhen`/`.multiple`; `askForm`'s terminal path asks a `showWhen` field only when its condition already holds, and a `multiple` field as a comma list |
| `packages/cli/src/init/ui/prompter.ts`, `ui/page.ts` | The page's form renders `showWhen` groups (hidden until their condition holds) and `multiple` fields as checkboxes |
| `packages/cli/src/init/project-form.ts` (new) | `PROJECT_FIELD`, `CHANNEL_DECISION_GROUP`, `projectFields` |
| `packages/cli/src/init/finish-steps.ts` | `firstProjectStep` asks the one form instead of `addProject`'s sequential questions; sets `context.flags.connectors` from the trackers field; `adminUserStep` reads `context.answers.adminEmail` first |
| `packages/cli/src/setup/project-add.ts` | `addProject` takes already-known values instead of asking them itself where the caller already has them (its own-question fallback stays for every other caller, `agentx project add`) |
| `packages/cli/src/setup/channel-add.ts` | `SlackChannelApi.create`/`.list`/`.lookupByEmail`/`.invite`; `createAndInviteChannel`, `bindPickedChannel` |
| `packages/cli/src/init/slack-app.ts` | Not touched by this phase; `channels:manage`/`groups:write` are phase 3's Task 14 (owner decision, 2026-10-02) |
| `packages/cli/src/init/context.ts` | `StackStatusReader.resourcesDone?` |
| `packages/cli/src/init/deploy-steps.ts` | `expectedResourceCount`, a progress poll beside `deployEnvironment` |
| `packages/cli/src/init/ui/cards.ts` | `buildProgressCard`; `adminCard`/`channelCard`/`alertsCard` gain `waitUntil`/`waitLabel` via phase 3's fields |
| `packages/cli/src/init/ui/journey.ts` | `STEP_PLAN.usualSeconds` replaced with measured values; a comment citing the measurement |
| `packages/cli/src/init/ui/page.ts`, `ui/design.ts` | The build-progress row's layout; the welcome screen's notification button; `PAGE_CLASSES`/`WIZARD_CSS` gain the progress row's class |
| `packages/cli/src/init/ui/state.ts`, `ui/index.ts` | Nothing new; reused as-is |
| `packages/cli/src/init/ui/question-copy.ts` | Copy for every new question this phase asks |
| `docs/install.md` | The first-project screen, the channel question, real progress, measured times |
| `tests/support/init-fakes.ts`, `tests/support/setup-fakes.ts`, `tests/support/init-ui-harness.ts` | `fakeSlackChannels` gains `create`/`list`/`lookupByEmail`/`invite`; a fake `StackStatusReader.resourcesDone`; the harness's `FINISH` script moves to the one-form shape |
| `tests/contract/init-project-form.test.ts` (new), `init-finish-steps.test.ts`, `init-channel-add.test.ts` (new, or add to an existing channel test file if one already exists under another name; check first), `init-deploy-steps.test.ts`, `init-ui-cards.test.ts`, `init-ui-journey.test.ts`, `init-ui-page.test.ts`, `init-ui-prompter.test.ts`, `init-prompts.test.ts`, `init-ui-copy-lint.test.ts`, `init-cli.test.ts`, `init-ui-cli.test.ts` | Tests for every module above |

## Interfaces Later Phases Rely On

None: spec 048 has no phase 5. What follows this phase, per the spec's own plan, is one live
end-to-end check (SC-005 to SC-008, SC-010, SC-013, SC-014, SC-016) and an update to specs 040 and
015 to match what shipped; neither is a code phase this plan hands an interface to.

---

### Task 1: `SlackChannelApi` gains create, list, lookup and invite (FR-051, FR-052)

**Owner decision, 2026-10-02:** this task no longer touches the Slack manifest's scopes.
`channels:manage`/`groups:write` move to phase 3's Task 14, which makes the manifest carry them (or
not) from the up-front settings answer, before the Slack app exists; by the time this task's code
runs, the manifest has already been built one way or the other. This task is now only the
`SlackChannelApi` methods the channel step's Yes and No paths (Tasks 4, 5) call once the bot token
exists.

**Files:**
- Modify: `packages/cli/src/setup/channel-add.ts` (`SlackChannelApi`, `SlackRateLimitedError`'s reused retry helper)
- Test: `tests/contract/init-channel-add.test.ts` (new, or
  extend the existing test file for `channel-add.ts` if one already exists; `grep -rln
  "channel-add" tests/contract` first)

**Interfaces:**
- Consumes: phase 1's `SlackChannelApi { find, join }`, `SlackRateLimitedError`, the `call` helper's
  retry-after handling. No longer consumes `slack-app.ts`'s manifest builder (owner decision,
  2026-10-02): this task does not touch the manifest.
- Produces:
  ```ts
  export interface SlackChannelApi {
    find(token: string, name: string): Promise<SlackChannel | undefined>;
    join(token: string, channelId: string): Promise<void>;
    /** FR-053: conversations.create. Throws a plain, page-safe message on name_taken. */
    create(token: string, name: string, isPrivate: boolean): Promise<SlackChannel>;
    /** FR-052: every channel the bot can see (public, and private ones it is already in), for a picker. */
    list(token: string): Promise<SlackChannel[]>;
    /** FR-051: the Slack user id for an email, or undefined when Slack has no member with it. */
    lookupByEmail(token: string, email: string): Promise<string | undefined>;
    /** FR-051: conversations.invite, for the installer found by lookupByEmail. */
    invite(token: string, channelId: string, userId: string): Promise<void>;
  }
  export class SlackNameTakenError extends AgentXError {}
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-channel-add.test.ts
import { describe, expect, it, vi } from "vitest";
import { SlackNameTakenError, slackChannelApi } from "../../packages/cli/src/setup/channel-add.js";

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("spec 048 phase 4: creating, listing and inviting (FR-051, FR-052, FR-053)", () => {
  it("creates a channel and returns it", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, channel: { id: "C1", name: "payments", is_private: false } }));
    const api = slackChannelApi(fetchImpl as unknown as typeof fetch);
    await expect(api.create("tok", "payments", false)).resolves.toEqual({ id: "C1", name: "payments", isPrivate: false, isMember: true });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("conversations.create");
  });

  it("names SlackNameTakenError on name_taken, carrying no secret", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error: "name_taken" }));
    const api = slackChannelApi(fetchImpl as unknown as typeof fetch);
    await expect(api.create("tok", "payments", false)).rejects.toBeInstanceOf(SlackNameTakenError);
  });

  it("lists every channel the bot can see", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, channels: [{ id: "C1", name: "general", is_private: false, is_member: true }, { id: "G1", name: "payments-private", is_private: true, is_member: true }] }));
    const api = slackChannelApi(fetchImpl as unknown as typeof fetch);
    await expect(api.list("tok")).resolves.toEqual([
      { id: "C1", name: "general", isPrivate: false, isMember: true },
      { id: "G1", name: "payments-private", isPrivate: true, isMember: true },
    ]);
  });

  it("finds a Slack user id by email, and undefined when there is no match", async () => {
    const found = vi.fn(async () => jsonResponse({ ok: true, user: { id: "U1" } }));
    const api1 = slackChannelApi(found as unknown as typeof fetch);
    await expect(api1.lookupByEmail("tok", "a@example.com")).resolves.toBe("U1");
    const missing = vi.fn(async () => jsonResponse({ ok: false, error: "users_not_found" }));
    const api2 = slackChannelApi(missing as unknown as typeof fetch);
    await expect(api2.lookupByEmail("tok", "nobody@example.com")).resolves.toBeUndefined();
  });

  it("invites a user to a channel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const api = slackChannelApi(fetchImpl as unknown as typeof fetch);
    await expect(api.invite("tok", "C1", "U1")).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("conversations.invite");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-channel-add.test.ts`
Expected: FAIL: `create`/`list`/`lookupByEmail`/`invite` are not exported; `SlackNameTakenError` does
not exist.

- [ ] **Step 3: Write minimal implementation**

In `channel-add.ts`, beside `SlackRateLimitedError`:

```ts
/** FR-051 and FR-053: the name is already in use (conversations.create's own refusal); the page
 * offers to bind the existing channel instead, or try another name (Task 4), never a stack trace. */
export class SlackNameTakenError extends AgentXError {
  constructor() { super("CONFIG_INVALID", "a channel with that name already exists", errorStatus("CONFIG_INVALID")); }
}
```

Extend `slackChannelApi`'s returned object (the `call` helper and its error mapping are unchanged;
only `name_taken` from `conversations.create` gets its own error class, read before the generic
`missingScope`/other-error branch):

```ts
    async create(token, name, isPrivate) {
      let body: Record<string, unknown>;
      try {
        body = await call("conversations.create", token, { name, is_private: String(isPrivate) });
      } catch (error) {
        if (error instanceof AgentXError && /name_taken/.test(error.message)) throw new SlackNameTakenError();
        throw error;
      }
      const channel = body.channel as { id: string; name: string; is_private?: boolean };
      return { id: channel.id, name: channel.name, isPrivate: channel.is_private === true, isMember: true };
    },
    async list(token) {
      const found: SlackChannel[] = [];
      let cursor = "";
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const body = await call("conversations.list", token, { types: "public_channel,private_channel", exclude_archived: "true", limit: String(LIST_PAGE_SIZE), ...(cursor === "" ? {} : { cursor }) });
        const channels = (Array.isArray(body.channels) ? body.channels : []) as Array<{ id: string; name: string; is_private?: boolean; is_member?: boolean }>;
        found.push(...channels.map((channel) => ({ id: channel.id, name: channel.name, isPrivate: channel.is_private === true, isMember: channel.is_member === true })));
        cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
        if (cursor === "") return found;
      }
      throw agentXError("CONFIG_INVALID", `the workspace has more than ${MAX_LIST_PAGES * LIST_PAGE_SIZE} channels to list; search by typing a name instead`);
    },
    async lookupByEmail(token, email) {
      try {
        const body = await call("users.lookupByEmail", token, { email });
        return (body.user as { id?: string } | undefined)?.id;
      } catch (error) {
        if (error instanceof AgentXError && /users_not_found/.test(error.message)) return undefined;
        throw error;
      }
    },
    async invite(token, channelId, userId) {
      await call("conversations.invite", token, { channel: channelId, users: userId });
    },
```

(`find`'s own pagination loop and this new `list`'s are near-duplicates; leave both as they are for
this task; a follow-up cleanup that has `find` call `list` once and search the result is a reasonable
simplification but is out of scope here, since it is not required by any FR and would touch a path
this task is not otherwise testing.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-channel-add.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup/channel-add.ts tests/contract/init-channel-add.test.ts
git commit -m "feat(setup): the Slack app can create, list and invite into channels (048 FR-051, FR-052)"
```

---

### Task 2: Two new form capabilities: a field shown only when another one matches, and a field of several boxes at once (FR-050, FR-051, FR-052)

**Files:**
- Modify: `packages/cli/src/init/ui/protocol.ts` (`WizardField.showWhen`, `.multiple`)
- Modify: `packages/cli/src/init/prompts.ts` (`FormField.showWhen`, `.multiple`; `askForm`'s terminal path)
- Modify: `packages/cli/src/init/ui/prompter.ts` (building a `WizardField` carries both through)
- Modify: `packages/cli/src/init/ui/page.ts`, `ui/design.ts` (rendering)
- Test: `tests/contract/init-prompts.test.ts`, `tests/contract/init-ui-form.test.ts`, `tests/contract/init-ui-page.test.ts`, `tests/contract/init-ui-design.test.ts`

**Interfaces:**
- Consumes: phase 2's `FormField`, `WizardField`, `askForm`, `buildForm` (`ui/page.ts`).
- Produces:
  ```ts
  // FormField and WizardField both gain:
  showWhen?: { field: string; equals: string };
  multiple?: boolean; // only meaningful with `choices`: several may be checked, not one
  ```
  A `multiple` field's value, wherever one is read (the page's posted JSON, the terminal's parsed
  answer), is a comma-separated list of the checked values (empty string for none), matching the
  shape `parseConnectorsFlag` (Task 3) already expects.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-prompts.test.ts, added describe block
describe("spec 048 phase 4: a field shown only when another matches, and a multiple-choice field", () => {
  const fields: FormField[] = [
    { name: "createChannel", question: "Create the channel?", flag: "--create-channel", defaultValue: "yes", choices: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
    { name: "channelName", question: "Channel name", flag: "--channel", defaultValue: "payments", showWhen: { field: "createChannel", equals: "yes" } },
    { name: "trackers", question: "Issue trackers", flag: "--connectors", defaultValue: "", choices: [{ value: "linear", label: "Linear" }, { value: "jira", label: "Jira" }], multiple: true },
  ];

  it("the terminal asks a showWhen field only when its condition already holds", async () => {
    const yes = scriptedPrompter(["yes", "payments-2", "linear,jira"]);
    await expect(askForm(yes, "Project", fields)).resolves.toEqual({ createChannel: "yes", channelName: "payments-2", trackers: "linear,jira" });
    expect(yes.asked).toEqual(["Create the channel?", "Channel name", "Issue trackers"]);

    const no = scriptedPrompter(["no", ""]);
    await expect(askForm(no, "Project", fields)).resolves.toEqual({ createChannel: "no", channelName: "payments", trackers: "" });
    expect(no.asked).toEqual(["Create the channel?", "Issue trackers"]);
  });

  it("the terminal asks a multiple field with choose-many semantics: comma-separated, empty means none", async () => {
    const prompter = scriptedPrompter(["yes", "payments", ""]);
    await expect(askForm(prompter, "Project", fields)).resolves.toMatchObject({ trackers: "" });
  });
});
```

```ts
// tests/contract/init-ui-form.test.ts
it("a showWhen field is built with the condition, and a multiple field is built with multiple: true", () => {
  const hub = createWizardHub("staging");
  void browserPrompter(hub).form?.("Project", [
    { name: "createChannel", question: "Create the channel?", flag: "--create-channel", choices: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] },
    { name: "channelName", question: "Channel name", flag: "--channel", showWhen: { field: "createChannel", equals: "yes" } },
    { name: "trackers", question: "Issue trackers", flag: "--connectors", choices: [{ value: "linear", label: "Linear" }], multiple: true },
  ], {});
  const fields = hub.state().question?.fields ?? [];
  expect(fields.find((field) => field.name === "channelName")?.showWhen).toEqual({ field: "createChannel", equals: "yes" });
  expect(fields.find((field) => field.name === "trackers")?.multiple).toBe(true);
});

it("a multiple field's posted value is accepted as a comma list and each value is checked against its choices", () => {
  const hub = createWizardHub("staging");
  void browserPrompter(hub).form?.("Project", [{ name: "trackers", question: "Issue trackers", flag: "--connectors", choices: [{ value: "linear", label: "Linear" }, { value: "jira", label: "Jira" }], multiple: true }], {});
  const id = hub.state().question?.id ?? "";
  expect(hub.answer(id, JSON.stringify({ trackers: "linear,jira" }))).toBeUndefined();
  expect(hub.answer(id, JSON.stringify({ trackers: "linear,not-a-tracker" }))).toBe("Check the field marked below.");
});
```

```ts
// tests/contract/init-ui-page.test.ts
it("FR-050 to FR-052: a showWhen group is hidden client-side until its field matches, and a multiple field renders checkboxes", () => {
  expect(WIZARD_JS).toContain("field.showWhen");
  expect(WIZARD_JS).toContain("field.multiple");
  expect(WIZARD_JS).toContain('input.type = "checkbox"');
});

it("every class the page uses is styled", () => {
  for (const name of ["conditional"]) {
    expect(PAGE_CLASSES).toContain(name);
    expect(WIZARD_CSS).toMatch(new RegExp(`\\.${name}[\\s{.,:]`));
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-prompts.test.ts tests/contract/init-ui-form.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-design.test.ts`
Expected: FAIL: `showWhen`/`multiple` are not recognized fields; the terminal asks every field
regardless; the page has no checkbox rendering.

- [ ] **Step 3: Write minimal implementation**

In `prompts.ts`'s `FormField`:

```ts
  /** FR-050 to FR-052: shown (page) or asked (terminal) only once `field`'s current value equals
   * this exact string. The controlling field must come earlier in the same `fields` array. */
  showWhen?: { field: string; equals: string };
  /** FR-052: with `choices`, several may be checked at once; the value is their comma-joined list
   * (empty string for none), the same shape `parseConnectorsFlag` already reads. */
  multiple?: boolean;
```

`askForm`'s terminal loop, for both the default-path and advanced-section passes, skips a field whose
`showWhen` does not yet match the values collected so far, and takes a `multiple` field through
`prompter.ask` (not `choose`, since several values and free punctuation do not fit `choose`'s one-of
semantics) with a hint listing the choices:

```ts
  const matches = (field: FormField, values: Record<string, string>) => field.showWhen === undefined || values[field.showWhen.field] === field.showWhen.equals;
  // ...inside both existing loops, before awaiting the field's own question:
  if (!matches(field, values)) continue;
  values[field.name] = field.multiple === true
    ? await prompter.ask(field.question, { flag: field.flag, defaultValue: field.defaultValue ?? "", help: { hint: `Comma-separated: ${field.choices?.map((choice) => choice.value).join(", ")}, or empty for none.` } })
    : await askField(prompter, field, start(field));
```

In `protocol.ts`, `WizardField` gains the same two fields (`showWhen?`, `multiple?: boolean`), and in
`ui/prompter.ts`'s `form`'s `toField`, both pass through unchanged from the `FormField`, and the
posted-value check for a `multiple` field splits on commas and checks each against `field.choices`:

```ts
      const checkMultiple = (field: FormField): AnswerCheck => (raw) => {
        const values = raw.split(",").map((value) => value.trim()).filter((value) => value !== "");
        const allowed = new Set(field.choices?.map((choice) => choice.value));
        const bad = values.find((value) => !allowed.has(value));
        return bad === undefined ? { value: values.join(",") } : { error: `"${bad}" is not one of the choices` };
      };
      // ...in the per-field check selection: field.multiple === true ? checkMultiple(field) : field.choices !== undefined ? choiceCheck(field) : ...
```

In `page.ts`'s `WIZARD_JS`, `buildForm` reads `field.showWhen` and `field.multiple`:

```js
function fieldInput(field, id) {
  if (field.multiple) {
    const wrap = el("div", "choices");
    const checked = new Set((field.value || "").split(",").filter(Boolean));
    for (const choice of field.choices || []) {
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.value = choice.value;
      box.checked = checked.has(choice.value);
      box.name = "field-" + field.name;
      label.append(box, el("span", "", choice.label));
      wrap.append(label);
    }
    return wrap;
  }
  // ...existing choices/text branches unchanged...
}

function readValue(field, input) {
  if (field.multiple) return [...input.querySelectorAll("input:checked")].map((box) => box.value).join(",");
  return input.value;
}
```

(`buildForm`'s per-field loop wraps each field whose `showWhen` is set in a container the submit
handler re-checks on every change of the controlling input, toggling `hidden` and skipping a hidden
field's value entirely when the form is submitted; `inputs.push([field, input])` becomes
`inputs.push([field, input, wrap])` so the submit handler can read each field's current visibility.)

`design.ts`: add `"conditional"` to `PAGE_CLASSES`, styled `display: contents;` on the wrapping `div`
when shown, `display: none;` when not (so a hidden group adds no empty gap).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-prompts.test.ts tests/contract/init-ui-form.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-design.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/prompts.ts packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/prompter.ts packages/cli/src/init/ui/page.ts packages/cli/src/init/ui/design.ts tests/contract/init-prompts.test.ts tests/contract/init-ui-form.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-design.test.ts
git commit -m "feat(init): a form field can depend on another, or be several boxes checked at once (048 FR-050 to FR-052)"
```

---

### Task 3: The first project is one form: repository, name, commands and trackers (FR-050)

**Files:**
- Create: `packages/cli/src/init/project-form.ts`
- Modify: `packages/cli/src/init/finish-steps.ts` (`firstProjectStep`)
- Modify: `packages/cli/src/setup/project-add.ts` (`addProject` accepts already-known values)
- Test: `tests/contract/init-project-form.test.ts` (new), `tests/contract/init-finish-steps.test.ts`

**Interfaces:**
- Consumes: Task 2's `showWhen`/`multiple`; phase 2's `askForm`, `FormField`; `setup/project-add.ts`'s
  `chooseRepository` logic (inlined into the form builder, since a form's fields must exist before
  any answer is known, where `chooseRepository` today asks only once a repository is missing),
  `proposeCommands`, `commandLine`; `CONNECTOR_TYPES`, `CONNECTOR_LABELS`.
- Produces:
  ```ts
  export const PROJECT_FIELD = { repository: "repository", projectName: "projectName", setupCommand: "setupCommand", testCommand: "testCommand", trackers: "trackers" } as const;
  export function projectFields(input: {
    repositories: readonly { fullName: string }[];
    proposed: { setup: string; test: string; basis: string[] };
    connected: ReadonlySet<ConnectorType>;
  }): FormField[];
  ```
  `addProject`'s `input` gains optional `already?: { repository?: string; projectName?: string;
  setupCommand?: string; testCommand?: string }`, read before any of its own prompts/flags for the
  same value (the caller that already asked on one form passes them here; a caller with no form,
  `agentx project add`, passes none and keeps today's sequential prompts unchanged).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-project-form.test.ts
import { describe, expect, it } from "vitest";
import { PROJECT_FIELD, projectFields } from "../../packages/cli/src/init/project-form.js";

describe("spec 048 phase 4: the first-project form's fields (FR-050)", () => {
  it("lists the repository, name, commands and trackers in order, with the commands prefilled from what was proposed", () => {
    const fields = projectFields({
      repositories: [{ fullName: "acme/payments-api" }, { fullName: "acme/other" }],
      proposed: { setup: "npm ci", test: "npm test", basis: ["package.json"] },
      connected: new Set(),
    });
    expect(fields.map((field) => field.name)).toEqual([PROJECT_FIELD.repository, PROJECT_FIELD.projectName, PROJECT_FIELD.setupCommand, PROJECT_FIELD.testCommand, PROJECT_FIELD.trackers]);
    expect(fields.find((field) => field.name === PROJECT_FIELD.setupCommand)?.defaultValue).toBe("npm ci");
    expect(fields.find((field) => field.name === PROJECT_FIELD.testCommand)?.defaultValue).toBe("npm test");
    expect(fields.find((field) => field.name === PROJECT_FIELD.trackers)).toMatchObject({ multiple: true, choices: [{ value: "linear" }, { value: "jira" }, { value: "asana" }] });
  });

  it("Review Focus 4: with nothing proposed, the command fields are still editable and optional", () => {
    const fields = projectFields({ repositories: [{ fullName: "acme/payments-api" }], proposed: { setup: "", test: "", basis: [] }, connected: new Set() });
    const setup = fields.find((field) => field.name === PROJECT_FIELD.setupCommand);
    expect(setup?.defaultValue).toBe("");
    expect(setup?.help?.hint ?? "Optional. Leave empty if the project needs none.").toMatch(/optional/i);
  });

  it("leaves out a tracker already connected", () => {
    const fields = projectFields({ repositories: [{ fullName: "acme/payments-api" }], proposed: { setup: "", test: "", basis: [] }, connected: new Set(["linear"]) });
    expect(fields.find((field) => field.name === PROJECT_FIELD.trackers)?.choices).toEqual([{ value: "jira", label: "Jira" }, { value: "asana", label: "Asana" }]);
  });
});
```

```ts
// tests/contract/init-finish-steps.test.ts, added case
it("spec 048 FR-050: the first-project step asks one form and passes its answers straight through, asking nothing twice", async () => {
  const { context, progress } = await finishContext({
    repositories: fakeRepositories({ "acme/payments-api": { files: { "go.mod": "module example.com/pay" } } }),
    script: [JSON.stringify({ repository: "acme/payments-api", projectName: "payments-api", setupCommand: "", testCommand: "go test ./...", trackers: "" })],
  });
  await expect(firstProjectStep().run(context, progress)).resolves.toMatchObject({ status: "done" });
  expect(progress.current().project?.name).toBe("payments-api");
  expect(context.flags.connectors).toBe("");
});
```

(`finishContext` is this file's existing builder of an `InitContext` and `ProgressHandle` for the
finishing steps; add `script` if it does not already script the form's one answer the way other
builders in this codebase script a `scriptedPrompter`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-project-form.test.ts tests/contract/init-finish-steps.test.ts`
Expected: FAIL: `project-form.js` does not exist; `firstProjectStep` still asks five separate
questions.

- [ ] **Step 3: Write minimal implementation**

`project-form.ts`:

```ts
// packages/cli/src/init/project-form.ts
// Spec 048 FR-050: the first project, its repository, name, commands and issue trackers, as one
// form. The repository list and the proposed commands are both already known by the time this is
// built (a live GitHub and repository-files read, done by the caller before the form is shown), so
// this module only shapes them into fields; it reaches no network itself.
import { CONNECTOR_LABELS, CONNECTOR_TYPES, type ConnectorType } from "./install-state.js";
import type { FormField } from "./prompts.js";

export const PROJECT_FIELD = {
  repository: "repository", projectName: "projectName", setupCommand: "setupCommand", testCommand: "testCommand", trackers: "trackers",
} as const;
export type ProjectFieldName = (typeof PROJECT_FIELD)[keyof typeof PROJECT_FIELD];

const projectNameOf = (fullName: string): string => (fullName.split("/")[1] ?? fullName).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "");

export function projectFields(input: {
  repositories: ReadonlyArray<{ fullName: string }>;
  proposed: { setup: string; test: string; basis: readonly string[] };
  connected: ReadonlySet<ConnectorType>;
}): FormField[] {
  const first = input.repositories[0]?.fullName ?? "";
  const why = input.proposed.basis.length === 0 ? undefined : `Found in ${input.proposed.basis.join(", ")}.`;
  return [
    { name: PROJECT_FIELD.repository, question: "Which repository is the first project's?", flag: "--repository", defaultValue: first, choices: input.repositories.map((repo) => ({ value: repo.fullName, label: repo.fullName })) },
    { name: PROJECT_FIELD.projectName, question: "Project name", flag: "--project-name", defaultValue: projectNameOf(first), validate: (value) => (/^[a-z][a-z0-9-]{0,62}$/.test(value) ? undefined : "a project name is 1 to 63 lowercase letters, digits and hyphens, starting with a letter") },
    { name: PROJECT_FIELD.setupCommand, question: "Setup command", flag: "--setup-command", defaultValue: input.proposed.setup, help: { why, hint: "Optional. Leave empty if the project needs none." } },
    { name: PROJECT_FIELD.testCommand, question: "Test command", flag: "--test-command", defaultValue: input.proposed.test, help: { why, hint: "Optional. Leave empty if the project has none." } },
    { name: PROJECT_FIELD.trackers, question: "Issue trackers", flag: "--connectors", defaultValue: "", multiple: true, choices: CONNECTOR_TYPES.filter((type) => !input.connected.has(type)).map((type) => ({ value: type, label: CONNECTOR_LABELS[type] })), help: { hint: "Optional. Skip for now and connect one later with agentx connector add." } },
  ];
}
```

In `project-add.ts`'s `addProject`, accept known values and skip asking for exactly those (every
other rule: the existing-project comparison, the registration, the file write, stays as it is):

```ts
export async function addProject(input: {
  // ...existing fields...
  already?: { repository?: string; projectName?: string; setupCommand?: string; testCommand?: string };
}): Promise<{ name: string; revision: number; file: string }> {
  const already = input.already ?? {};
  // chosenRepository: prefer already.repository over flags.repository over asking.
  const chosenRepository = async () => {
    const wanted = already.repository ?? flags.repository;
    const picked = await chooseRepository(await input.services.repositories.list(input.githubToken), prompter, wanted);
    input.onRepository?.(picked.fullName);
    return picked;
  };
  let name = already.projectName ?? flags.projectName;
  // ...unchanged below this point, except the commands block prefers already.setupCommand/testCommand
  // the same way, skipping both the "Use these commands?" confirm and the individual asks when both
  // are given (an empty string is still "given": it means no command, not "ask me").
}
```

(`chooseRepository`'s `flag` parameter today means "already answered, do not ask"; passing
`already.repository` through the same parameter needs no change to `chooseRepository` itself, only to
which value `addProject` feeds it. Read the full current body of the commands block, lines 239 to 251
of today's file, before editing: the `already` values must short-circuit before the `proposeCommands`
summary is even printed, since the form already showed the proposal and the answer.)

In `finish-steps.ts`'s `firstProjectStep`, build the one form before calling `addProject`:

```ts
      if (project === undefined) {
        // ...installationId/githubToken unchanged...
        const repositories = await context.setup.repositories.list(githubToken);
        const connected = new Set((progress.current().connectors ?? []).map((entry) => entry.type));
        // Proposed commands need one repository's files; ask the form with the first repository's
        // proposal, then re-propose for whichever one the operator actually picks, only if it
        // differs (a form with no live round-trip cannot re-propose mid-fill).
        const firstRepo = repositories[0];
        const proposed = firstRepo === undefined ? { setup: "", test: "", basis: [] } : await proposedCommandsFor(context, githubToken, firstRepo.fullName);
        const answers = await askForm(context.prompter, "Your first project", projectFields({ repositories, proposed, connected }), {});
        let repository: string | undefined;
        const added = await addProject({
          env: context.env, session, githubToken, prompter: context.prompter, write: context.write, services: context.setup, flags: context.flags,
          already: { repository: answers.repository, projectName: answers.projectName, setupCommand: answers.setupCommand, testCommand: answers.testCommand },
          onRepository: (fullName) => { repository = fullName; },
        });
        // FR-050: the trackers field becomes the connectors flag connectorsStep already reads.
        context.flags.connectors = answers.trackers;
        project = { name: added.name, revision: added.revision };
        // ...progress.update, card, shown = true, unchanged...
      }
```

(`proposedCommandsFor` is a small extracted helper from `addProject`'s existing build-files read and
`proposeCommands` call, exported from `project-add.ts` so this step can call it once, before the
form, instead of `addProject` calling it again after. If the operator picks a different repository
than the one the form proposed commands from, the commands shown stay the ones proposed for the
first repository, worded with a line noting that; re-proposing per pick would need a live round trip
the form does not have, and is not required by FR-050, which asks only that commands be "found in"
some repository's files and editable.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-project-form.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-cli.test.ts tests/contract/init-ui-cli.test.ts`
Expected: PASS (update `FINISH`/`FIRST_RUN`-style scripts in `tests/support/init-ui-harness.ts` and
`tests/contract/init-cli.test.ts` from five separate answers to the one form's JSON answer, the same
way phase 2's Task 12 moved the Slack step's script from two questions to one form).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/project-form.ts packages/cli/src/init/finish-steps.ts packages/cli/src/setup/project-add.ts tests/contract/init-project-form.test.ts tests/contract/init-finish-steps.test.ts tests/support/init-ui-harness.ts tests/contract/init-cli.test.ts
git commit -m "feat(init): the first project is one form: repository, name, commands and trackers (048 FR-050)"
```

---

### Task 4: The channel question, Yes path: create, join and invite the installer (FR-051)

**Owner decision, 2026-10-02:** the Yes/No decision itself is no longer asked here. It was answered
earlier, at settings, before the Slack app existed (phase 3's Task 14), specifically so the Slack
manifest could carry the channel-creating scopes only when the answer is Yes. This task's form fields
are the Yes path's remaining questions (a name and public-or-private), included only when
`context.answers.settings.createChannel` already says "yes"; there is no live `createChannel` field
on this form to show or hide them, so they need no `showWhen` of their own.

**Files:**
- Modify: `packages/cli/src/init/project-form.ts` (`CHANNEL_DECISION_GROUP`, the channel fields added to `projectFields`)
- Modify: `packages/cli/src/setup/channel-add.ts` (`createAndInviteChannel`)
- Modify: `packages/cli/src/init/finish-steps.ts` (`firstProjectStep`'s channel branch)
- Modify: `packages/cli/src/init/ui/cards.ts` (`ChannelCardInput` gains a "name taken" stage)
- Test: `tests/contract/init-project-form.test.ts`, `tests/contract/init-channel-add.test.ts`, `tests/contract/init-finish-steps.test.ts`

**Interfaces:**
- Consumes: Task 1's `SlackChannelApi.create`/`.lookupByEmail`/`.invite`, `SlackNameTakenError`;
  phase 2's `answers.adminEmail`; phase 3 Task 14's `context.answers.settings.createChannel`
  (`"yes" | "no"`, already decided before this screen shows).
- Produces:
  ```ts
  export const CHANNEL_DECISION_GROUP = "Project channel";
  export function projectFields(input: {
    repositories: readonly { fullName: string }[];
    proposed: { setup: string; test: string; basis: string[] };
    connected: ReadonlySet<ConnectorType>;
    // Owner decision, 2026-10-02: the already-known settings answer, not a field this form asks.
    channelDecision: "yes" | "no";
  }): FormField[];
  export async function createAndInviteChannel(input: {
    botToken: string; name: string; isPrivate: boolean; installerEmail: string;
    api: Pick<SlackChannelApi, "create" | "lookupByEmail" | "invite" | "join">;
    write: (line: string) => void;
  }): Promise<{ channelId: string; channelName: string; invited: boolean }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-project-form.test.ts, added case
it("owner decision 2026-10-02: on a Yes decision, the project form shows the channel's name and visibility, grouped, with no createChannel field of its own (FR-051)", () => {
  const fields = projectFields({ repositories: [{ fullName: "acme/payments-api" }], proposed: { setup: "", test: "", basis: [] }, connected: new Set(), channelDecision: "yes" });
  expect(fields.find((field) => field.name === "createChannel")).toBeUndefined();
  const name = fields.find((field) => field.name === "channelName");
  expect(name).toMatchObject({ group: CHANNEL_DECISION_GROUP, defaultValue: "payments-api" });
  expect(name?.showWhen).toBeUndefined();
  const visibility = fields.find((field) => field.name === "channelVisibility");
  expect(visibility).toMatchObject({ group: CHANNEL_DECISION_GROUP, choices: [{ value: "public" }, { value: "private" }] });
});

it("owner decision 2026-10-02: on a No decision, the project form has no channelName/channelVisibility fields (Task 5 covers its own picker fields)", () => {
  const fields = projectFields({ repositories: [{ fullName: "acme/payments-api" }], proposed: { setup: "", test: "", basis: [] }, connected: new Set(), channelDecision: "no" });
  expect(fields.find((field) => field.name === "channelName")).toBeUndefined();
  expect(fields.find((field) => field.name === "channelVisibility")).toBeUndefined();
});
```

```ts
// tests/contract/init-channel-add.test.ts, added describe block
describe("spec 048 phase 4: creating and inviting on the Yes path (FR-051)", () => {
  it("creates, joins (already true from create) and invites the installer found by email", async () => {
    const calls: string[] = [];
    const api = {
      create: async (_t: string, name: string, isPrivate: boolean) => { calls.push(`create:${name}:${isPrivate}`); return { id: "C1", name, isPrivate, isMember: true }; },
      lookupByEmail: async (_t: string, email: string) => { calls.push(`lookup:${email}`); return "U1"; },
      invite: async (_t: string, channelId: string, userId: string) => { calls.push(`invite:${channelId}:${userId}`); },
      join: async () => { calls.push("join"); },
    };
    const result = await createAndInviteChannel({ botToken: "x", name: "payments", isPrivate: false, installerEmail: "me@example.com", api, write: () => undefined });
    expect(result).toEqual({ channelId: "C1", channelName: "payments", invited: true });
    expect(calls).toEqual(["create:payments:false", "lookup:me@example.com", "invite:C1:U1"]);
  });

  it("Review Focus 2: no Slack member for the email still creates the channel, invited: false", async () => {
    const api = { create: async () => ({ id: "C1", name: "payments", isPrivate: false, isMember: true }), lookupByEmail: async () => undefined, invite: async () => { throw new Error("must not be called"); }, join: async () => undefined };
    const lines: string[] = [];
    const result = await createAndInviteChannel({ botToken: "x", name: "payments", isPrivate: false, installerEmail: "me@example.com", api, write: (line) => lines.push(line) });
    expect(result).toEqual({ channelId: "C1", channelName: "payments", invited: false });
    expect(lines.some((line) => /could not find you in this workspace by email/i.test(line))).toBe(true);
  });

  it("Review Focus 1: a taken name throws SlackNameTakenError, for the caller to offer Use that channel or Pick another name", async () => {
    const api = { create: async () => { throw new SlackNameTakenError(); }, lookupByEmail: async () => undefined, invite: async () => undefined, join: async () => undefined };
    await expect(createAndInviteChannel({ botToken: "x", name: "payments", isPrivate: false, installerEmail: "me@example.com", api, write: () => undefined })).rejects.toBeInstanceOf(SlackNameTakenError);
  });
});
```

```ts
// tests/contract/init-finish-steps.test.ts, added case
it("spec 048 FR-051: Yes (decided at settings) creates the channel and invites the installer", async () => {
  const { context, progress } = await finishContext({
    script: [JSON.stringify({ repository: "acme/payments-api", projectName: "payments-api", setupCommand: "", testCommand: "", trackers: "", channelName: "payments-api", channelVisibility: "public" })],
    // Owner decision, 2026-10-02: the Yes/No answer comes from settings, not the form's own script.
    settings: { createChannel: "yes" },
    slackChannels: fakeSlackChannels([], { lookupByEmail: async () => "U1" }),
  });
  await expect(firstProjectStep().run(context, progress)).resolves.toMatchObject({ status: "done" });
  expect(progress.current().project?.channelName).toBe("payments-api");
});
```

(`fakeSlackChannels`'s signature gains an optional second argument for `create`/`lookupByEmail`/
`invite` overrides; check its current shape in `tests/support/setup-fakes.ts` and extend it rather
than replace it, so every existing caller with one argument is unaffected. `finishContext`'s
`settings` override must land in `context.answers.settings` exactly the way phase 2's own settings
fixtures already do; confirm the exact fixture shape against `tests/support/init-fakes.ts` before
wiring this, since this plan cannot see phase 2's and phase 3's merged state on it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-project-form.test.ts tests/contract/init-channel-add.test.ts tests/contract/init-finish-steps.test.ts`
Expected: FAIL: `projectFields` does not accept `channelDecision`; no `CHANNEL_DECISION_GROUP`/channel
fields on the form; `createAndInviteChannel` does not exist.

- [ ] **Step 3: Write minimal implementation**

In `project-form.ts`, add to `projectFields`'s returned array, right after `projectName` and before
the command fields (so the channel's own fields sit together, between the project's name and its
commands, matching the design mockup's layout). Owner decision, 2026-10-02: these fields are included
only when `input.channelDecision === "yes"`, and carry no `showWhen` of their own, since there is no
live field on this form left to key one on:

```ts
export const CHANNEL_DECISION_GROUP = "Project channel";
// ...inside projectFields, inserted after PROJECT_FIELD.projectName's entry:
    ...(input.channelDecision === "yes" ? [
      { name: "channelName", question: "Channel name", flag: "--channel", defaultValue: projectNameOf(first), group: CHANNEL_DECISION_GROUP, help: { why: "AgentX answers in this channel for this project." } },
      { name: "channelVisibility", question: "Public or private?", flag: "--channel-visibility", defaultValue: "public", group: CHANNEL_DECISION_GROUP, choices: [{ value: "public", label: "Public" }, { value: "private", label: "Private" }] },
    ] as FormField[] : []),
```

(Task 5 adds the No-path fields the same way, guarded by `input.channelDecision === "no"`, to the
same array, right after this block.)

This task also updates Task 3's `askForm(context.prompter, "Your first project",
projectFields({ repositories, proposed, connected }), {})` call (in `firstProjectStep`, before the
channel branch below) to pass the now-required `channelDecision`:
`projectFields({ repositories, proposed, connected, channelDecision: context.answers.settings.createChannel === "no" ? "no" : "yes" })`.
This is the one place the settings-time answer (phase 3's Task 14) reaches the project form; every
later read of the decision, including the channel branch below, goes through
`context.answers.settings.createChannel` directly rather than through the form's own answers, since
the form no longer carries that field.

In `channel-add.ts`:

```ts
export async function createAndInviteChannel(input: {
  botToken: string; name: string; isPrivate: boolean; installerEmail: string;
  api: Pick<SlackChannelApi, "create" | "lookupByEmail" | "invite" | "join">;
  write: (line: string) => void;
}): Promise<{ channelId: string; channelName: string; invited: boolean }> {
  const channel = await input.api.create(input.botToken, input.name, input.isPrivate);
  const userId = await input.api.lookupByEmail(input.botToken, input.installerEmail);
  if (userId === undefined) {
    input.write(`Created #${input.name}, but AgentX could not find you in this workspace by email (${input.installerEmail}). Invite yourself to #${input.name} in Slack.`);
    return { channelId: channel.id, channelName: channel.name, invited: false };
  }
  await input.api.invite(input.botToken, channel.id, userId);
  return { channelId: channel.id, channelName: channel.name, invited: true };
}
```

In `finish-steps.ts`'s `firstProjectStep`, the channel branch (replacing the plain `addChannel` call;
owner decision, 2026-10-02: the branch now reads `context.answers.settings.createChannel`, the
settings-time answer, not a field this form asked again):

```ts
      if (project.channelId === undefined) {
        const slack = progress.current().slack;
        if (slack === undefined) throw agentXError("CONFIG_INVALID", "install progress has no Slack app facts; the Slack app step must finish first, so run agentx init again");
        const botToken = await readSlackBotToken(context.secrets, context.env);
        let bound: { channelId: string; channelName: string };
        if (context.answers.settings.createChannel !== "no") {
          try {
            const created = await createAndInviteChannel({
              botToken, name: formAnswers.channelName, isPrivate: formAnswers.channelVisibility === "private",
              installerEmail: context.answers.adminEmail ?? context.flags.adminEmail ?? "",
              api: context.setup.slackChannels, write: context.write,
            });
            bound = created;
          } catch (error) {
            if (error instanceof SlackNameTakenError) {
              context.surface?.card(channelCard({ stage: "name-taken", channelName: formAnswers.channelName }));
              const choice = await context.prompter.choose<"use" | "rename">(`#${formAnswers.channelName} already exists. Use it, or pick another name?`, [
                { value: "use", label: "Use that channel" }, { value: "rename", label: "Pick another name" },
              ], { flag: "--channel-name-taken", defaultValue: "use" });
              if (choice === "rename") throw agentXError("CONFIG_INVALID", `#${formAnswers.channelName} already exists; run agentx init again with a different --channel`);
              // "Use that channel": fall back to the No-path bind, which finds it by name (Task 5).
              bound = await bindPickedChannel({ botToken, name: formAnswers.channelName, projectName: project.name, session, services: context.setup, prompter: context.prompter, write: context.write, sleep: context.sleep, now: context.now, onWaiting: (channelName) => context.surface?.card(channelCard({ stage: "waiting", channelName, botName: botNameOf(progress.current(), context.answers.slack.appName) })) });
            } else throw error;
          }
        } else {
          bound = await bindPickedChannel({ /* Task 5 */ });
        }
        project = { ...project, channelId: bound.channelId, channelName: bound.channelName, teamId: slack.teamId };
        await progress.update({ project });
      }
```

(Owner decision, 2026-10-02 (spec Decisions, owner decision 9): `prompter.choose`'s own
`defaultValue: "use"` above already gives a scripted install exactly the "use it or create it"
behavior decided for `--channel`: with no one to ask, the choice resolves to "use" by itself, binding
the existing channel rather than stopping. Confirm `Prompter.choose`'s existing non-interactive
fallback already returns `defaultValue` with no prompt when there is no surface and no matching flag,
against the current `prompts.ts`, before relying on it here; if it does not, this task adds that
fallback rather than inventing a second code path for the scripted case.
`formAnswers` is the same object `askForm` returned in Task 3, held in scope for the whole step;
`session` and `botName` helpers are already in scope above this block, unchanged from today's code.
`bindPickedChannel` is Task 5's; this task may stub it as a thin wrapper over today's `addChannel`
so this task's own tests pass, and Task 5 replaces the stub with the real picker-and-bind logic.)

In `cards.ts`, `ChannelCardInput` gains `| { stage: "name-taken"; channelName: string }`, rendered
with a plain line and no action of its own (the choice is asked right after, not through the card).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-project-form.test.ts tests/contract/init-channel-add.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/project-form.ts packages/cli/src/setup/channel-add.ts packages/cli/src/init/finish-steps.ts packages/cli/src/init/ui/cards.ts tests/contract/init-project-form.test.ts tests/contract/init-channel-add.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cards.test.ts
git commit -m "feat(init): Yes creates the Slack channel, joins it and invites the installer by email (048 FR-051)"
```

---

### Task 5: The channel question, No path: a searchable picker with the invite step up front (FR-052)

**Files:**
- Modify: `packages/cli/src/init/project-form.ts` (the No-path fields)
- Modify: `packages/cli/src/setup/channel-add.ts` (`bindPickedChannel`, replacing Task 4's stub)
- Modify: `packages/cli/src/init/finish-steps.ts` (wires `bindPickedChannel` for real)
- Modify: `packages/cli/src/init/ui/page.ts` (the picker's client-side search filter; the up-front invite note)
- Test: `tests/contract/init-project-form.test.ts`, `tests/contract/init-channel-add.test.ts`, `tests/contract/init-ui-page.test.ts`, `tests/contract/init-ui-copy-lint.test.ts`

**Interfaces:**
- Consumes: Task 1's `SlackChannelApi.list`/`.find`/`.join`; Task 4's `projectFields`'s
  `channelDecision` input. Owner decision, 2026-10-02: no longer consumes Task 2's `showWhen` here,
  since the No-path fields are included outright rather than shown conditionally.
- Produces:
  ```ts
  export async function bindPickedChannel(input: {
    botToken: string; name: string; projectName: string;
    session: AdminSession; services: Pick<SetupServices, "fetch" | "slackChannels">;
    prompter: Prompter; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number;
    botUserId: string;
    onWaiting?: (channelName: string) => void;
  }): Promise<{ channelId: string; channelName: string }>;
  ```
  (This is phase 1's `addChannel`, generalized to take a name already chosen by the form rather than
  asking its own `--channel` question; `addChannel` itself is kept, unchanged, for `agentx channel
  add`'s own prompt-driven use, and `bindPickedChannel` is the shared body both now call.)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-project-form.test.ts, added case
it("owner decision 2026-10-02: on a No decision, the project form shows the picker and a not-listed name field, with no createChannel field and no showWhen (FR-052)", () => {
  const fields = projectFields({ repositories: [{ fullName: "acme/payments-api" }], proposed: { setup: "", test: "", basis: [] }, connected: new Set(), channelDecision: "no" });
  const picked = fields.find((field) => field.name === "channelPicked");
  expect(picked).toMatchObject({ group: CHANNEL_DECISION_GROUP });
  expect(picked?.showWhen).toBeUndefined();
  const notListed = fields.find((field) => field.name === "channelNotListed");
  expect(notListed).toMatchObject({ group: CHANNEL_DECISION_GROUP, help: expect.objectContaining({ hint: expect.stringMatching(/not listed/i) as unknown }) });
  expect(notListed?.showWhen).toBeUndefined();
});
```

```ts
// tests/contract/init-channel-add.test.ts, added describe block
describe("spec 048 phase 4: bindPickedChannel (FR-052)", () => {
  it("Review Focus 3: a typed name matching a listed channel resolves the same way the picker entry would", async () => {
    const api = { find: async (_t: string, name: string) => (name === "payments" ? { id: "C1", name: "payments", isPrivate: false, isMember: true } : undefined), join: async () => undefined, list: async () => [{ id: "C1", name: "payments", isPrivate: false, isMember: true }] };
    const byPicker = await bindPickedChannel({ botToken: "x", name: "payments", projectName: "payments-api", session: fakeSession(), services: setupServices({ slackChannels: api as never }), prompter: scriptedPrompter([]), write: () => undefined, sleep: async () => undefined, now: () => 0, botUserId: "U0BOT" });
    const byTyped = await bindPickedChannel({ botToken: "x", name: "PAYMENTS", projectName: "payments-api", session: fakeSession(), services: setupServices({ slackChannels: api as never }), prompter: scriptedPrompter([]), write: () => undefined, sleep: async () => undefined, now: () => 0, botUserId: "U0BOT" });
    expect(byPicker).toEqual(byTyped);
  });

  it("joins a public channel the bot can see but has not joined, and waits for an invite to a private one", async () => {
    const joined: string[] = [];
    const api = { find: async () => ({ id: "C1", name: "payments", isPrivate: false, isMember: false }), join: async (_t: string, id: string) => { joined.push(id); } };
    const result = await bindPickedChannel({ botToken: "x", name: "payments", projectName: "payments-api", session: fakeSession(), services: setupServices({ slackChannels: api as never }), prompter: scriptedPrompter([]), write: () => undefined, sleep: async () => undefined, now: () => 0, botUserId: "U0BOT" });
    expect(result.channelId).toBe("C1");
    expect(joined).toEqual(["C1"]);
  });
});
```

```ts
// tests/contract/init-ui-page.test.ts
it("FR-052: the picker is a searchable list, and a private, not-yet-joined choice shows the invite command up front", () => {
  expect(WIZARD_JS).toContain("search channels");
  expect(WIZARD_JS).toContain("/invite @");
});
```

In `init-ui-copy-lint.test.ts`, add a seeded example proving the bare `/invite @agentx-production`
string is allowed on the page (not flagged as a terminal instruction), alongside the file's existing
seeded-failure examples for the rules it does enforce:

```ts
it("spec 048 FR-052: a bare Slack invite command is not flagged as a terminal instruction", () => {
  expect(lintCopy([{ where: "channel card", text: "/invite @agentx-production", context: "page" }])).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-project-form.test.ts tests/contract/init-channel-add.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-copy-lint.test.ts`
Expected: FAIL: no No-path fields; `bindPickedChannel` does not exist; the page has no search filter.

- [ ] **Step 3: Write minimal implementation**

In `project-form.ts`, after Task 4's Yes-path block, add the No-path block, guarded the same way
(owner decision, 2026-10-02: included outright when `input.channelDecision === "no"`, no `showWhen`):

```ts
    ...(input.channelDecision === "no" ? [
      { name: "channelPicked", question: "Channel", flag: "--channel", group: CHANNEL_DECISION_GROUP },
      { name: "channelNotListed", question: "Not listed? Type a channel name", flag: "--channel", group: CHANNEL_DECISION_GROUP, defaultValue: "", help: { hint: "Optional. Leave empty to use the one picked above." } },
    ] as FormField[] : []),
```

(`channelPicked`'s `choices` are filled by the caller, the same way `settingsFields` leaves a
caller-filled list to its own builder in phase 2's Task 6; `projectFields`'s signature gains an
optional `channels?: ReadonlyArray<{ value: string; label: string }>` it spreads onto this field's
`choices` when given, and an empty array (no live list available, such as a resumed run before the
Slack app step's token is readable) falls back to showing only the "not listed" field by leaving
`channelPicked`'s `choices` empty, which the page already renders as no options.)

In `channel-add.ts`, extract the shared body `addChannel` already has into `bindPickedChannel`, and
have `addChannel` call it after asking its own `--channel` question:

```ts
export async function bindPickedChannel(input: {
  botToken: string; name: string; projectName: string;
  session: AdminSession; services: Pick<SetupServices, "fetch" | "slackChannels">;
  prompter: Prompter; write: (line: string) => void; sleep: (ms: number) => Promise<void>; now: () => number;
  botUserId: string;
  onWaiting?: (channelName: string) => void;
}): Promise<{ channelId: string; channelName: string }> {
  const name = channelName(input.name);
  // ...the body of today's addChannel from `const deadline = input.now() + FIND_WAIT_MS;` through
  // its return, unchanged line for line...
}

export async function addChannel(input: { /* unchanged */ }): Promise<{ channelId: string; channelName: string }> {
  const typed = input.flags.channel ?? await input.prompter.ask("Which Slack channel should the project use?", {
    flag: "--channel", validate: (value) => (CHANNEL_NAME.test(value.trim()) ? undefined : "a channel name, such as payments"),
  });
  if (!CHANNEL_NAME.test(typed.trim())) throw agentXError("CONFIG_INVALID", "--channel must be a Slack channel name, such as payments");
  const bound = await bindPickedChannel({ ...input, name: typed, botUserId: input.botUserId });
  await bindSlackChannel({ controlPlaneUrl: input.session.controlPlaneUrl, accessToken: input.session.accessToken, teamId: input.teamId, channelId: bound.channelId, projectName: input.projectName }, input.services.fetch);
  input.write(`Bound #${bound.channelName} to project ${input.projectName}.`);
  return bound;
}
```

(Confirm `addChannel`'s exact current parameter names, including `teamId`/`botUserId`, against the
real file before splitting it; the sketch above must keep every existing `addChannel` caller's
behavior identical, including the `bindSlackChannel` call this new `bindPickedChannel` does not make
itself, since `firstProjectStep`'s Yes path (Task 4) also needs to bind, and duplicating
`bindSlackChannel` into both `createAndInviteChannel` and `bindPickedChannel` would call it twice for
the Yes path once Task 4's stub is replaced; call it once, in `firstProjectStep`, after either path
returns a channel, not inside either helper.)

In `finish-steps.ts`, replace Task 4's `bindPickedChannel({ /* Task 5 */ })` stub call with the real
one, passing `formAnswers.channelNotListed || formAnswers.channelPicked` as `name`, and call
`bindSlackChannel` once after either branch, per the note above.

In `page.ts`'s `WIZARD_JS`, the picker's `choices` field (already rendered as a radio group by
`buildQuestion`'s existing `question.kind === "choose"` branch; a form's own choice field reuses the
same markup) gains a plain `<input>` search box above it that filters the visible `<label>`s by
substring, case-insensitively, with placeholder text `"search channels..."`; the invite note
("/invite @<bot handle>" with a copy button) appears right under the "not listed" field whenever its
typed value, or the picked value, does not match a channel the bot is already in (read from
`field.choices`' labels, which Task 6 of this task group, or a `memberOf` map alongside `choices`,
must carry whether each listed channel is one the bot is already in; add that as a per-choice flag
on `WizardChoice` if the existing `{ value, label }` shape cannot say it, matching how `field.value`
already special-cases masked/unmasked rather than inventing a second lookup table).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-project-form.test.ts tests/contract/init-channel-add.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/project-form.ts packages/cli/src/setup/channel-add.ts packages/cli/src/init/finish-steps.ts packages/cli/src/init/ui/page.ts tests/contract/init-project-form.test.ts tests/contract/init-channel-add.test.ts tests/contract/init-ui-page.test.ts tests/contract/init-ui-copy-lint.test.ts
git commit -m "feat(init): No shows a searchable channel picker with the invite step up front (048 FR-052)"
```

---

### Task 6: Real build progress: resources done out of expected, and "You can leave now" (FR-007)

**Files:**
- Modify: `packages/cli/src/init/context.ts` (`StackStatusReader.resourcesDone?`)
- Modify: `packages/cli/src/init/deploy-steps.ts` (`expectedResourceCount`, the progress poll)
- Modify: `packages/cli/src/init/ui/cards.ts` (`buildProgressCard`)
- Modify: `packages/cli/src/init/ui/page.ts`, `ui/design.ts` (the Build in AWS panel's rows)
- Test: `tests/contract/init-deploy-steps.test.ts`, `tests/contract/init-ui-cards.test.ts`, `tests/contract/init-ui-page.test.ts`

**Interfaces:**
- Consumes: `LoadedRelease.template(region, part)` (already read by every deploy step indirectly
  through `prepareDeployment`); `StackStatusReader.status`; `context.sleep`.
- Produces:
  ```ts
  export function expectedResourceCount(template: unknown): number | undefined; // undefined when the
  // template cannot be read as JSON with a Resources object (a source build whose template this
  // engine does not read locally)
  // StackStatusReader gains: resourcesDone?(stackName: string): Promise<number | undefined>;
  export function buildProgressCard(input: {
    stepTitle: string; startedAt: string; usualSeconds: number; now: () => number;
    // Owner decision, 2026-10-02: summed across every part of the step, never only the first.
    resources?: { done: number; expected: number };
    // One entry per part, in `DEPLOY_STEP_PARTS[input.id]` order, so a two-part step's own two
    // stacks each have their last-read status available, even though the combined `resources` line
    // does not break them out.
    parts?: ReadonlyArray<{ part: string; status?: string }>;
  }): WizardCard;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-deploy-steps.test.ts, added describe block
describe("spec 048 FR-007: expectedResourceCount", () => {
  it("counts the template's own Resources", () => {
    expect(expectedResourceCount(JSON.stringify({ Resources: { A: {}, B: {}, C: {} } }))).toBe(3);
  });

  it("returns undefined for an unreadable or resource-less template, never zero as if nothing is expected", () => {
    expect(expectedResourceCount("not json")).toBeUndefined();
    expect(expectedResourceCount(JSON.stringify({}))).toBeUndefined();
  });
});

it("a deploy step polls resourcesDone while it runs and shows a progress card, when the reader has it", async () => {
  const cards: WizardCard[] = [];
  const context = initContext({
    surface: { card: (card) => cards.push(card) },
    stackStatus: { status: async () => "CREATE_IN_PROGRESS", resourcesDone: async () => 2 },
    sleep: async (ms) => undefined,
  });
  await deployStep({ id: "access", title: "Set up AWS permissions" }).run(context, progressHandle());
  expect(cards.some((card) => card.id === "build-progress" && card.lines.some((line) => /2 of/.test(line)))).toBe(true);
});

it("owner decision 2026-10-02: a two-part step (core: foundation, identity) reports resources done and expected summed across both stacks", async () => {
  const cards: WizardCard[] = [];
  const context = initContext({
    surface: { card: (card) => cards.push(card) },
    // foundation's stack already exists and has 2 of its own 2 resources done; identity's stack has
    // not started yet (CloudFormation deploys core's parts one after another), so it does not exist:
    // resourcesDone resolves undefined for it, which the poll must count as zero, not as "unknown".
    stackStatus: {
      status: async (stackName) => (stackName.endsWith("foundation") ? "CREATE_COMPLETE" : undefined),
      resourcesDone: async (stackName) => (stackName.endsWith("foundation") ? 2 : undefined),
    },
    // foundation's template has 2 resources, identity's has 3: expected is 5, not 2.
    release: { template: (_region: string, part: string) => JSON.stringify({ Resources: part === "foundation" ? { A: {}, B: {} } : { C: {}, D: {}, E: {} } }) },
    sleep: async () => undefined,
  });
  await deployStep({ id: "core", title: "Build the network and sign-in" }).run(context, progressHandle());
  const last = cards.filter((card) => card.id === "build-progress").at(-1);
  expect(last?.lines.some((line) => /2 of 5 resources done/.test(line))).toBe(true);
  expect(last?.details).toEqual(expect.arrayContaining([expect.stringContaining("foundation"), expect.stringContaining("identity")]));
});

it("owner decision 2026-10-02: the row finishes only once both of a two-part step's stacks are done, and a failure in the second shows on this step", async () => {
  const cards: WizardCard[] = [];
  const context = initContext({
    surface: { card: (card) => cards.push(card) },
    stackStatus: {
      status: async (stackName) => (stackName.endsWith("foundation") ? "CREATE_COMPLETE" : "CREATE_FAILED"),
      resourcesDone: async (stackName) => (stackName.endsWith("foundation") ? 2 : 0),
    },
    release: { template: (_region: string, part: string) => JSON.stringify({ Resources: part === "foundation" ? { A: {}, B: {} } : { C: {}, D: {}, E: {} } }) },
    sleep: async () => undefined,
  });
  context.deployer.fail.set(environmentStackName(context.env, "identity"), new Error("identity stack failed"));
  await expect(deployStep({ id: "core", title: "Build the network and sign-in" }).run(context, progressHandle())).rejects.toThrow(/identity stack failed/);
  const last = cards.filter((card) => card.id === "build-progress").at(-1);
  expect(last?.lines.some((line) => /2 of 5 resources done/.test(line))).toBe(true);
  expect(last?.details?.some((line) => /identity.*CREATE_FAILED/.test(line))).toBe(true);
});

it("Review Focus 5: no known resource count shows elapsed time alone, never NaN", () => {
  const card = buildProgressCard({ stepTitle: "Build the network and sign-in", startedAt: new Date(0).toISOString(), usualSeconds: 240, now: () => 60_000 });
  expect(card.lines.join(" ")).not.toMatch(/NaN|undefined/);
  expect(card.lines.some((line) => /resources starting/i.test(line))).toBe(true);
});
```

(The two new owner-decision tests use `context.deployer`, `context.env` and the `release.template`
override the way `initContext`'s other callers already do; confirm `scriptedDeployer`'s exact
`.fail: Map<string, Error>` keying against `tests/support/init-fakes.ts` before wiring the second
test, since this plan cannot see that file's state after phases 2 and 3 have landed on it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-deploy-steps.test.ts tests/contract/init-ui-cards.test.ts`
Expected: FAIL: `expectedResourceCount`/`buildProgressCard` are not exported; `deployStep` shows no
progress card; `buildProgressCard` has no `parts` input.

- [ ] **Step 3: Write minimal implementation**

In `deploy-steps.ts`:

```ts
export function expectedResourceCount(templateJson: string): number | undefined {
  try {
    const parsed = JSON.parse(templateJson) as { Resources?: Record<string, unknown> };
    const count = Object.keys(parsed.Resources ?? {}).length;
    return count > 0 ? count : undefined;
  } catch {
    return undefined;
  }
}
```

In `deployStep`'s `run`, start a poll beside (not instead of) the existing `deployEnvironment` call,
stopped the moment it settles. Owner decision, 2026-10-02: the poll reads every part of the step, not
only `parts[0]`, and combines them:

```ts
      const startedAt = new Date(context.now()).toISOString();
      const expectedByPart = context.release.template === undefined ? undefined : parts.map((part) => {
        try { return expectedResourceCount(context.release.template!(answers.region, part)); } catch { return undefined; }
      });
      // A combined total is only shown once every part's own count is known; a single unreadable
      // part (such as a part the cdk engine synthesizes rather than reads as a downloaded template)
      // makes the whole step's total unknown too, same as Review Focus 5 already requires.
      const expected = expectedByPart?.every((count) => count !== undefined) === true
        ? expectedByPart.reduce((sum: number, count) => sum + count!, 0)
        : undefined;
      let stop = false;
      const poll = (async () => {
        while (!stop) {
          const stackNames = parts.map((part) => environmentStackName(env, part));
          const statuses = await Promise.all(stackNames.map((name) => context.stackStatus.status(name).catch(() => undefined)));
          // A part not deployed yet (CloudFormation builds a step's parts one after another) has no
          // stack, so resourcesDone resolves undefined for it; that counts as zero done, not as
          // "unknown", since its own expected count is already known from its template.
          const doneByPart = context.stackStatus.resourcesDone === undefined
            ? undefined
            : await Promise.all(stackNames.map((name) => context.stackStatus.resourcesDone!(name).catch(() => undefined)));
          const done = doneByPart === undefined ? undefined : doneByPart.reduce((sum: number, count) => sum + (count ?? 0), 0);
          context.surface?.card(buildProgressCard({
            stepTitle: input.title, startedAt, usualSeconds: STEP_PLAN[input.id].usualSeconds, now: context.now,
            ...(done === undefined || expected === undefined ? {} : { resources: { done, expected } }),
            parts: parts.map((part, index) => ({ part, status: statuses[index] })),
          }));
          await context.sleep(5_000);
        }
      })();
      try {
        const result = await deployEnvironment({ /* unchanged */ });
        // ...unchanged body...
        return { status: "done" };
      } finally {
        stop = true;
        await poll;
      }
```

(Confirm `LoadedRelease`'s real `template(region, part)` signature and whether it throws or returns
undefined for a part this engine does not template locally, in `deploy/release.ts`, before wiring
this; the `try`/`catch` above assumes it can throw, which is the safer assumption if unconfirmed. A
one-part step, such as `access`, runs this same loop over its single part and behaves exactly as
before: `parts.length === 1` makes the combined total and the per-part detail line the same number
either way.)

In `cards.ts`:

```ts
export function buildProgressCard(input: {
  stepTitle: string; startedAt: string; usualSeconds: number; now: () => number;
  resources?: { done: number; expected: number };
  parts?: ReadonlyArray<{ part: string; status?: string }>;
}): WizardCard {
  const elapsed = Math.max(0, Math.round((input.now() - Date.parse(input.startedAt)) / 1000));
  const resourceLine = input.resources === undefined ? "Resources starting." : `${input.resources.done} of ${input.resources.expected} resources done.`;
  // Owner decision, 2026-10-02: each stack's own last-read status stays available even when the
  // resource line above is the combined one; a one-part step has nothing extra to say here.
  const details = input.parts === undefined || input.parts.length < 2
    ? undefined
    : input.parts.map((part) => `${part.part}: ${part.status ?? "not started yet"}`);
  return {
    id: "build-progress", title: input.stepTitle, status: "running",
    lines: [resourceLine, `Running for ${elapsed} seconds (usually ${Math.round(input.usualSeconds)} seconds). You can leave now; this page tells you when it needs you.`],
    ...(details === undefined ? {} : { details }),
  };
}
```

Add `"build-progress"` to `CardId` (`protocol.ts`) and to `CARD_PHASES` (`journey.ts`, phase
`"build"`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-deploy-steps.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/context.ts packages/cli/src/init/deploy-steps.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/journey.ts tests/contract/init-deploy-steps.test.ts tests/contract/init-ui-cards.test.ts
git commit -m "feat(init): the Build in AWS panel shows real resource progress, not only elapsed time (048 FR-007)"
```

---

### Task 7: `resourcesDone` for the real CloudFormation reader (FR-007)

**Files:**
- Modify: `packages/cli/src/init/context.ts` (`cloudFormationStatusReader`)
- Test: `tests/contract/init-context.test.ts` (new, or extend wherever `cloudFormationStatusReader`
  is already tested; check first)

**Interfaces:**
- Consumes: `@aws-sdk/client-cloudformation`'s `ListStackResourcesCommand`, already a dependency.
- Produces: `cloudFormationStatusReader`'s returned `StackStatusReader` gains `resourcesDone`.

- [ ] **Step 1: Write the failing test**

```ts
it("spec 048 FR-007: counts resources whose own status ends in _COMPLETE", async () => {
  const client = { send: async () => ({ StackResourceSummaries: [{ ResourceStatus: "CREATE_COMPLETE" }, { ResourceStatus: "CREATE_IN_PROGRESS" }, { ResourceStatus: "UPDATE_COMPLETE" }] }) };
  const reader = cloudFormationStatusReader(client as unknown as CloudFormationClient);
  await expect(reader.resourcesDone?.("agentx-staging-core")).resolves.toBe(2);
});

it("returns undefined, never throws, for a stack that does not exist yet", async () => {
  const client = { send: async () => { throw Object.assign(new Error("does not exist"), { name: "ValidationError" }); } };
  const reader = cloudFormationStatusReader(client as unknown as CloudFormationClient);
  await expect(reader.resourcesDone?.("agentx-staging-core")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-context.test.ts`
Expected: FAIL: `resourcesDone` is not defined.

- [ ] **Step 3: Write minimal implementation**

```ts
import { ListStackResourcesCommand } from "@aws-sdk/client-cloudformation";
// in cloudFormationStatusReader's returned object:
    async resourcesDone(stackName) {
      try {
        const response = await client.send(new ListStackResourcesCommand({ StackName: stackName }));
        return (response.StackResourceSummaries ?? []).filter((resource) => (resource.ResourceStatus ?? "").endsWith("_COMPLETE")).length;
      } catch {
        return undefined;
      }
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-context.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/context.ts tests/contract/init-context.test.ts
git commit -m "feat(init): the real stack reader counts finished resources for the build-progress card (048 FR-007)"
```

---

### Task 8: Measured time estimates replace the first guesses (FR-002)

**Files:**
- Modify: `packages/cli/src/init/ui/journey.ts` (`STEP_PLAN`'s `usualSeconds`, `BEFORE_STEPS_SECONDS`)
- Test: `tests/contract/init-ui-journey.test.ts`

**Interfaces:**
- Consumes: nothing new; this task only changes data, not shape.
- Produces: the same `STEP_PLAN`/`BEFORE_STEPS_SECONDS` shapes, with new numbers.

- [ ] **Step 1: Measure two clean runs (not a test; this is data collection)**

Run `agentx init --ui` twice, start to finish, in a fresh AWS account with nothing installed yet
(use a throwaway `--env`, then `agentx destroy` it after each run). For each run, read
`~/.agentx/logs/init-<env>.log` (FR-070's full log) for every step's start and done timestamps and
compute each step's duration in seconds; average the two runs' durations per step. Record the two raw
runs' numbers in a code comment above `STEP_PLAN`, with the date, so a future remeasurement knows what
it is replacing.

- [ ] **Step 2: Write the failing test**

```ts
it("spec 048 FR-002: every step's usualSeconds is measured, not the phase 1 first estimate, and the file says when", () => {
  expect(STEP_PLAN.prerequisites.usualSeconds).not.toBe(30); // phase 1's first guess
  const source = readFileSync(new URL("../../../packages/cli/src/init/ui/journey.ts", import.meta.url), "utf8");
  expect(source).toMatch(/Measured on two clean runs, \d{4}-\d{2}-\d{2}/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts`
Expected: FAIL: `usualSeconds` still reads the phase 1 estimates; no "Measured on" comment.

- [ ] **Step 4: Write the data change**

Replace the comment above `STEP_PLAN` ("First estimates from the live run of 2026-10-01...") with:

```ts
/** Measured on two clean runs, YYYY-MM-DD (fill in from Step 1 above), averaged per step. Phase 1's
 * first estimates (the 2026-10-01 live run) are superseded; replace these again the next time a
 * live run's timing drifts enough to matter. */
```

and each step's `usualSeconds` with its measured average (whatever Step 1 found); likewise
`BEFORE_STEPS_SECONDS`'s two entries, measured as the time from the page opening to the first
question answered, and from the plan's confirmation to the GitHub app step starting.

- [ ] **Step 5: Run test to verify it passes, update every test that pinned an old number**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts`
Expected: PASS once the new numbers are in; every other test that asserts an exact `totalMinutes()`,
`needsYouMinutes()`, `timeLeftText` or welcome-screen line (phase 1 and phase 2's own tests, and this
plan's own harness tests) gets its new exact expected value, computed from the new `STEP_PLAN`, never
loosened to a range.

- [ ] **Step 6: Run the whole suite, then commit**

```bash
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
npx vitest run
```

```bash
git add packages/cli/src/init/ui/journey.ts tests/contract/init-ui-journey.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts
git commit -m "feat(init): time estimates come from two measured clean runs, not the first guess (048 FR-002)"
```

---

### Task 9: Admin sign-in reuses the settings email; the alerts and test-reply cards' wording matches the spec (FR-055 to FR-057)

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts` (`adminUserStep`)
- Modify: `packages/cli/src/init/ui/cards.ts` (`adminCard`, `alertsCard`, `replyCard` wording, if any
  still carries a spec-040-era phrase; compare each against FR-055/FR-056/FR-057's exact words first)
- Test: `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-ui-cards.test.ts`

**Interfaces:**
- Consumes: phase 2's `InitAnswers.adminEmail`.
- Produces: no new exported interface; `adminUserStep` reads one more source before asking.

- [ ] **Step 1: Write the failing test**

```ts
it("spec 048 FR-055: reuses the email from settings, asking nothing when it is known", async () => {
  const { context, progress } = await finishContext({ answers: { ...sampleAnswers(), adminEmail: "owner@example.com" } });
  const prompter = scriptedPrompter([]); // asks nothing
  await expect(adminUserStep().run({ ...context, prompter }, progress)).resolves.toMatchObject({ status: "done", note: "admin owner@example.com" });
});
```

(Compare `adminCard`'s "signing-in"/"done" lines, `alertsCard`'s "confirm"/"testing"/"done" lines and
`replyCard`'s "waiting"/"done" lines against FR-055's "Check your inbox for an email with your
temporary password", FR-056's "Send a test alert"/"It arrived"/"It did not arrive" and FR-057's
"names the bot by handle and app name, links to the channel, and shows the reply time"; today's
wording, read in Task "cards.ts" earlier in this codebase, already matches closely. Add a test only
for a word this comparison finds actually wrong; do not add a no-op snapshot test for wording that
already matches.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts`
Expected: FAIL: `adminUserStep` still asks even though `context.answers.adminEmail` is set.

- [ ] **Step 3: Write minimal implementation**

In `finish-steps.ts`'s `adminUserStep`:

```ts
        const email = recorded?.username ?? context.flags.adminEmail ?? context.answers.adminEmail ?? await context.prompter.ask(/* unchanged */);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/finish-steps.ts packages/cli/src/init/ui/cards.ts tests/contract/init-finish-steps.test.ts
git commit -m "feat(init): admin sign-in reuses the settings email instead of asking again (048 FR-055)"
```

---

### Task 10: The Finish-phase waits reuse "Still there? Keep waiting" (FR-064, carried from phase 3)

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts` (`adminUserStep`'s sign-in wait, `firstProjectStep`'s
  channel-invite wait, `alertsStep`'s confirmation wait all call phase 3's `waitWithCheckIn`)
- Modify: `packages/cli/src/init/ui/cards.ts` (`adminCard`, `channelCard`, `alertsCard` gain
  `waitUntil`/`waitLabel`)
- Test: `tests/contract/init-finish-steps.test.ts`, `tests/contract/init-ui-cards.test.ts`

**Interfaces:**
- Consumes: phase 3's `waitWithCheckIn`, `WizardCard.waitUntil`/`.waitLabel`.
- Produces: nothing new; this task is wiring, the same shape phase 3's Task 9 used for the GitHub and
  Slack waits.

- [ ] **Step 1: Write the failing tests**

```ts
it("spec 048 FR-064: the admin sign-in wait asks to keep waiting instead of giving up, only with a page", async () => {
  let asked = 0;
  const context = initContext({ surface: { card: () => undefined }, adminSession: async () => { throw new Error("not signed in yet"); } });
  // ...drive adminUserStep.run with a prompter that answers "keep waiting" once, then signs in;
  // assert the step completes rather than throwing at the first deadline.
});
```

(Write one such test per wait, following Task 9 of phase 3's exact pattern: with a surface, the
deadline asks and extends on yes; without one, it gives up exactly as it does today. Reuse that
task's test shape rather than inventing a new one.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts`
Expected: FAIL: each wait still ends the run at its first deadline regardless of a surface.

- [ ] **Step 3: Write minimal implementation**

Wrap each of the three waits' own polling loop with `waitWithCheckIn`, passing `surface:
context.surface`, `prompter: context.prompter`, the wait's own existing `pollMs`/deadline values
unchanged, and a `question` of "Still there? Keep waiting?"; each card gains `waitUntil: new
Date(context.now() + deadlineMs).toISOString()` and `waitLabel: "Still there? Keep waiting."` on its
waiting stage, exactly as phase 3's GitHub "create" card does.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cards.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/finish-steps.ts packages/cli/src/init/ui/cards.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cards.test.ts
git commit -m "feat(init): the admin sign-in, channel invite and alert waits ask to keep waiting too (048 FR-064)"
```

---

### Task 11: A browser notification when the run starts waiting after an unattended stretch (FR-005)

**Files:**
- Modify: `packages/cli/src/init/ui/page.ts` (the welcome screen's button; the client-side comparison)
- Modify: `packages/cli/src/init/ui/journey.ts` (`welcomeLines` gains the offer, or a sibling constant
  `NOTIFY_LABEL` the page renders as a button beside the welcome text)
- Test: `tests/contract/init-ui-page.test.ts`, `tests/contract/init-ui-journey.test.ts`

**Interfaces:**
- Consumes: `state.waitingOnYou` (already on every `WizardState`).
- Produces: `NOTIFY_LABEL = "Notify me when AgentX needs me"`; no server-side change.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-journey.test.ts
it("spec 048 FR-005: names the notification button", () => {
  expect(NOTIFY_LABEL).toBe("Notify me when AgentX needs me");
});
```

```ts
// tests/contract/init-ui-page.test.ts
describe("spec 048 FR-005: a notification when the run starts waiting after an unattended stretch", () => {
  it("offers to ask for permission on the welcome screen", () => {
    expect(WIZARD_JS).toContain("Notification.requestPermission");
    expect(WIZARD_JS).toContain(JSON.stringify(NOTIFY_LABEL));
  });

  it("fires only on a false-to-true transition of waitingOnYou, not on the first state", () => {
    expect(WIZARD_JS).toContain("new Notification(");
    expect(WIZARD_JS).toMatch(/wasWaiting\s*&&|!wasWaiting/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts tests/contract/init-ui-page.test.ts`
Expected: FAIL: no `NOTIFY_LABEL`; the client never calls `Notification.requestPermission` or
`new Notification`.

- [ ] **Step 3: Write minimal implementation**

In `journey.ts`:

```ts
/** FR-005: the welcome screen's notification offer; a browser Notification fires once the run first
 * starts waiting on the operator after an unattended stretch. */
export const NOTIFY_LABEL = "Notify me when AgentX needs me";
```

In `page.ts`'s `WIZARD_JS`, in the welcome block and the top-level `render`/state-tracking code:

```js
const NOTIFY_LABEL = ${JSON.stringify(NOTIFY_LABEL)};
let notifyWanted = false;
let wasWaiting = false;
let sawFirstState = false;

function notifyButton() {
  const button = el("button", "", NOTIFY_LABEL);
  button.type = "button";
  button.addEventListener("click", () => {
    if (!("Notification" in window)) { button.disabled = true; button.textContent = "Notifications are not supported here."; return; }
    Notification.requestPermission().then((permission) => {
      notifyWanted = permission === "granted";
      button.disabled = true;
      button.textContent = notifyWanted ? "We will notify you." : "Notifications were not allowed.";
    });
  });
  return button;
}
```

In `render(state)`, after the existing welcome-screen block, append `notifyButton()` once (guarded so
it is not rebuilt on every render); and, in the shared tail of `render` (or a dedicated small
function called from both `render` and the `state`/`snapshot` listeners), the transition check:

```js
function checkNotify(state) {
  if (sawFirstState && notifyWanted && !wasWaiting && state.waitingOnYou) {
    try { new Notification("AgentX needs you", { body: state.pageTitle }); } catch { /* ignore */ }
  }
  wasWaiting = state.waitingOnYou;
  sawFirstState = true;
}
```

called once per `state`/`snapshot` event, right after `render(...)` in each of the three
`source.addEventListener` handlers that call it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-journey.test.ts tests/contract/init-ui-page.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/ui/journey.ts packages/cli/src/init/ui/page.ts tests/contract/init-ui-journey.test.ts tests/contract/init-ui-page.test.ts
git commit -m "feat(init): a browser notification fires once the run starts waiting after being left alone (048 FR-005)"
```

---

### Task 12: No-UI parity for the channel decision, copy-lint coverage, and docs

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts` (the terminal path's channel question order matches
  the form's field order exactly, via Task 2's `askForm` terminal fallback, already true once Tasks 3
  to 5 land, since `askForm` is the one function both paths call)
- Modify: `tests/contract/init-ui-copy-lint.test.ts` (confirm every new string this phase added passes)
- Modify: `docs/install.md`
- Test: `tests/contract/init-cli.test.ts` (no-UI parity), `tests/contract/init-ui-copy-lint.test.ts`

**Interfaces:**
- Consumes: everything built in Tasks 1 to 11.

- [ ] **Step 1: Write the failing test**

```ts
it("spec 048 FR-072: --yes asks the channel's remaining fields in the same order the form would show them (the Yes/No decision itself is settings', phase 3's Task 14)", async () => {
  const h = await harness();
  const result = await h.run(["--yes", "--admin-email", ADMIN_EMAIL, "--repository", "acme/payments-api", "--channel", "payments-api", /* ... */]);
  expect(result).toBe(0);
});

it("owner decision 2026-10-02: --channel alone (no --no-create-channel) creates the named channel when it does not exist", async () => {
  const h = await harness({ slackChannels: fakeSlackChannels([] /* no channel named payments-api yet */) });
  const result = await h.run(["--yes", "--admin-email", ADMIN_EMAIL, "--repository", "acme/payments-api", "--channel", "payments-api", /* ... */]);
  expect(result).toBe(0);
  expect(h.createdChannels()).toContain("payments-api");
});

it("owner decision 2026-10-02: --no-create-channel keeps today's find-or-fail behavior for --channel", async () => {
  const h = await harness({ slackChannels: fakeSlackChannels([] /* the channel does not exist */) });
  const result = await h.run(["--yes", "--admin-email", ADMIN_EMAIL, "--repository", "acme/payments-api", "--no-create-channel", "--channel", "does-not-exist", /* ... */]);
  expect(result).not.toBe(0);
  expect(h.stderr()).toMatch(/create it.*invite the bot/i);
});

it("every new string this phase added passes the copy-lint", () => {
  // Run the existing whole-page copy-lint test (phase 1/2/3's own) and confirm it still reports
  // nothing; this step is running the existing suite, not writing a new assertion, unless Step 2
  // of vitest finds something this phase missed.
});
```

(`h.createdChannels()`/`h.stderr()` above are illustrative; confirm `harness()`'s actual shape in
`tests/contract/init-cli.test.ts` and `tests/support/init-ui-harness.ts` first, and use whatever
assertion that harness already exposes for "which Slack calls were made" and "what the failed run
printed", in the same spirit as this plan's other "confirm the exact signature first" notes.)

- [ ] **Step 2: Run tests to verify they pass or fail**

Run: `npx vitest run tests/contract/init-cli.test.ts tests/contract/init-ui-copy-lint.test.ts`
Expected: PASS once every earlier task's flags and copy are in place; fix whichever string or flag
ordering the test names otherwise.

- [ ] **Step 3: `docs/install.md`**

Add: the first-project screen's one form and its fields, the channel question's two paths, that
build progress is now real resource counts, that the welcome screen can ask for a notification, and
that time estimates are measured, not guessed.

- [ ] **Step 4: Run the whole suite and the gate, then commit**

```bash
export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH
npm run typecheck:all && npm run lint && npm run build && npm test && npm run infra:synth
```

```bash
git add packages/cli/src/init/finish-steps.ts tests/contract/init-cli.test.ts tests/contract/init-ui-copy-lint.test.ts docs/install.md
git commit -m "test(init): no-UI parity for the channel's remaining fields; --channel's use-it-or-create-it scripted behavior; copy-lint and docs for phase 4 (048 FR-072, FR-081, owner decision 2026-10-02)"
```

---

## Self-Review

**1. Spec coverage (phase 4 row of the spec's Phases table):**

| Requirement | Task |
|---|---|
| FR-002 measured time estimates | 8 |
| FR-007 real build progress | 6, 7 |
| FR-050 the first project on one screen (repository, name, commands, trackers) | 2, 3 |
| FR-051 the channel question's Yes path: create, join, invite (the Yes/No decision itself moved to settings: phase 3 Task 14, owner decision 2026-10-02) | 4 |
| FR-052 the channel question's No path: picker, up-front invite | 5 |
| FR-053 the channel scopes follow the settings decision (phase 3 Task 14, owner decision 2026-10-02); Task 1 here is only `SlackChannelApi` | 1 |
| FR-055 admin sign-in reuses the settings email | 9 |
| FR-056 alerts: detect, test, arrived/did not arrive | 9 |
| FR-057 test reply: named by handle, linked, timed | 9 |
| FR-064 (carried): the Finish-phase waits also ask to keep waiting | 10 |
| FR-005's notification | 11 |
| FR-072 no-UI parity for the channel decision | 12 |

**2. Placeholder scan:** every code step shows real code; a handful of steps are explicitly
"confirm the exact current signature first" pointers (Task 3's `addProject` edit, Task 5's
`addChannel`/`bindPickedChannel` split, Task 6's `LoadedRelease.template`), each naming the exact
existing function and the exact new behavior wanted, for the same reason phase 3's plan gives: a plan
written before the branch it builds on exists cannot pin a line number from a file it has not seen
change yet. Task 8 is openly not code-first (it measures, then codes), named as such rather than
disguised as a normal TDD step.

**3. Type consistency:** `FormField.multiple` (Task 2) is what the trackers field (Task 3) builds
with; `FormField.showWhen` (Task 2) has no consumer left in this phase, since the channel fields
(Tasks 4, 5) are now included outright rather than shown conditionally (owner decision, 2026-10-02).
`PROJECT_FIELD`, `CHANNEL_DECISION_GROUP` (Tasks 3, 4) are the field names every later task's test
reads by; `projectFields`'s `channelDecision` input (Task 4) is what Tasks 4 and 5 both key their own
fields' inclusion on, and is itself `context.answers.settings.createChannel` (phase 3's Task 14), read
once by `finish-steps.ts` before building the form. `SlackChannelApi.create`/`.list`/`.lookupByEmail`/
`.invite` (Task 1) are what `createAndInviteChannel` (Task 4) and `bindPickedChannel` (Task 5)
consume. `StackStatusReader.resourcesDone` (Tasks 6, 7) and `buildProgressCard` (Task 6) are produced
and consumed within the same two tasks, with no later task depending on either.

**4. Review Focus:** each of the five lines has its pinned test in the named task (Tasks 4, 4, 5, 3,
6).

## Rulings On Spec Ambiguities

1. **The channel create-or-not question is answered at settings, before the Slack app exists, and
   its manifest scopes follow the answer (owner decision, 2026-10-02, overruling this plan's earlier
   reading).** The design doc left open whether the extra scopes are requested only on Yes or always
   (section 9, question 3); this plan originally followed `spec.md`'s own "Decided in this spec"
   paragraph, which kept the question at the channel step and always requested both scopes, reasoning
   that Slack fixes a bot's scopes at install time and the channel question came after the Slack app
   already existed, so asking for the scopes only on Yes would force a reinstall partway through the
   run. The owner chose the other branch of that same reasoning: move the question earlier instead of
   requesting the scopes unconditionally. Phase 3's Task 14 now asks "Should AgentX create the channel
   for you?" at settings, before the Slack app is created, and builds its manifest with
   `channels:manage`/`groups:write` only when the answer is Yes. This phase's project form (Tasks 3 to
   5) no longer asks that question at all; it reads the already-known answer from
   `context.answers.settings.createChannel` and shows only the fields that answer calls for. This also
   resolves, for a scripted install, what `--channel <name>` alone (no `--create-channel`/
   `--no-create-channel`) means: since `createChannel` already defaults to "yes" (Decisions, owner
   decision 9 of 2026-10-02), it is answering Yes, so the channel step creates the named channel if it
   does not exist (`createAndInviteChannel`), or uses it if it does (`SlackNameTakenError`'s existing
   fallback to `bindPickedChannel`, which a scripted run resolves to "use" by itself, since
   `prompter.choose`'s own default is `"use"` and there is no one to ask); `--no-create-channel` drops
   the scopes and keeps the plain find-or-fail behavior `bindPickedChannel` already has.
2. **A taken channel name on the Yes path falls back to the No path's own bind, not a second create
   attempt.** Once Slack refuses the create, the channel already exists; finding and binding it is
   exactly what the No path already does, so Task 4 reuses Task 5's `bindPickedChannel` rather than
   writing a second "use the existing one" code path.
3. **A two-part step's progress tracks both of its stacks, combined (owner decision, 2026-10-02,
   overruling this plan's earlier reading).** `core` (foundation and identity) and `control-plane`
   (control-plane and runtime) each have two stacks. This plan originally read FR-007's "one row per
   part being built... with... resources done out of the expected count" as satisfied by one row per
   step, not per stack, and had Task 6 poll only the first part named in `DEPLOY_STEP_PARTS[input.id]`
   since CloudFormation deploys a step's parts one after another, so the first part was also the one
   actually in progress for most of the step's time. The owner overruled that: the single row a step
   gets MUST track every part it has, not only the first. Task 6's poll now reads `resourcesDone` and
   `status` for every part of the step, and the card reports resources done and expected summed across
   every part (a part whose stack does not exist yet, because it has not started deploying, counts as
   zero done toward the total, not as unknown, since its expected count is already known from its own
   template), with each part's own last-read status carried in the card's `details` so a reconnecting
   page can see which stack is still running or has failed. The time estimate already covered both
   parts without change: `usualSeconds` is looked up by step id, not by part, so it was never only the
   first part's budget. The row is combined-complete only once every part's own resources-done reaches
   its own expected count; a failure thrown by the second part surfaces on this same step, with the
   last status line this task recorded for that part still showing in `details`.
4. **The repository picker's proposed commands are not re-fetched when a different repository is
   picked on the same form.** A form has no live round trip mid-fill; re-proposing would need one.
   FR-050 asks only that commands be prefilled, editable and explained, which the first repository's
   proposal already satisfies; a person who picks a different repository on purpose edits the
   prefilled command by hand, same as they would edit any other wrong default.
5. **The browser Notification fires at most once per wait, not once per `state` event while still
   waiting.** `wasWaiting` only flips the check on a transition, so a long wait with many `state`
   updates (elapsed-time ticks, a card's countdown) notifies once, not repeatedly; this matches FR-005's
   own wording ("a browser notification MUST fire when the run starts waiting"), which names the
   start of the wait, not its duration.

## Execution Handoff

Plan complete and saved to `specs/048-guided-install/plans/phase-4-pickers-and-progress.md`.
Implementation starts only after phase 3's PR has merged into mainline (no stacking). Please review
the plan. Which execution approach would you prefer?

- **Subagent-driven:** a fresh subagent implements each task and a fresh reviewer checks it before
  the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context
  per task and per review.
- **Native:** one session implements every task, then one fresh reviewer on the most capable model
  checks the whole branch. Cheapest and fastest; no independent review until the end.

**Recommendation: subagent-driven**, because the channel question's Yes and No paths (Tasks 4 and 5)
both build on Task 3's form and Task 2's new field capabilities, and a per-task reviewer is the
cheapest way to catch a field-name or `showWhen` mismatch between tasks before the next one builds on
it; Task 8's data-measurement step also benefits from a fresh reviewer confirming the two live runs
were genuinely clean before their numbers are committed.
