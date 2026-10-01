# Spec 040 Phase 3: The Finishing Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** after deployment, the install page walks the operator through creating the admin user
and signing in, registering the first project, binding its Slack channel, the connectors and the
alert subscription, and ends on a real AgentX reply in that channel, shown as a live card that
says what to fix when the reply does not come. The last screen says what works now; nothing on it
is needed to finish.

**Architecture:**
- **Nothing new is deployed or asked.** Spec 015 phase 15d2 already made these steps part of
  `agentx init` (`finish-steps.ts`), and phase 1 already asks their questions on the page. This
  phase adds a card to each, next to the lines it already writes, through phase 2's
  `context.surface`. The terminal path is unchanged line for line (SC-004).
- **Waits become cards that resolve by themselves:** the admin sign-in (its link is a page button,
  Q5), the bot's invite to a private channel, the alert subscription's confirmation, and the test
  reply. On the page, a wait that fails or times out can be tried again (Q7) with phase 2's
  `retryOnPage`; the terminal path stops as before.
- **The test reply keeps what it already reported.** A watch that ended on a failed turn does not
  see that same turn again when the operator watches again (`reported`), so a second watch waits
  for a new mention instead of failing at once.
- **The ready card (FR-052, Q10)** leads with what works now, then lists the optional day-2
  commands under "Later, if you want more".

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`),
Node 22.19 to 22.x, Vitest. No new dependency.

**Spec:** [../spec.md](../spec.md), the binding authority. Phase 3 delivers the Decisions' phase 3
row: FR-050 (admin user, sign-in, first project, channel bind as screens in the same run), FR-051
(a real reply confirmed, and what to fix when it does not arrive), FR-052 (no manual follow-up
command on the page), User Story 3 and, with the live check, SC-005. Open decisions are in
[questions.md](questions.md); this plan follows every recommendation, and a task that depends on
one says "Depends on Q<n>".

**Phases:** [phase-2-connect.md](phase-2-connect.md) (must be merged first: this plan uses its
cards, `InstallSurface`, `retryOnPage`, `openLink` and the headless operator's `clicked`), this
plan, then [phase-4-default.md](phase-4-default.md).

**Branch:** `feat/040c-finish`, cut from mainline after phase 2 merges. One PR against `mainline`.
No stacked PRs.

## Global Constraints

- **The terminal path does not change.** Without `--ui`, every line, question and error of the
  finishing steps stays exactly as it is; the existing `init-finish-steps`, `init-cli`,
  `setup-channel`, `setup-project-add` and alerts tests pass unchanged (SC-004).
- **Secrets (FR-012).** The admin's sign-in tokens, the connector keys and the webhook address are
  never in a card, a link, a log line, an event, a progress note or an error. Card builders take no
  secret. The alerts card names a webhook by its display form only (`https://host/...`).
- **Links.** Only `https://` addresses and the wizard's own address are shown (phase 2's
  `isShowableLink`). The Slack channel link is `https://slack.com/app_redirect?team=<T>&channel=<C>`.
- **No test reaches AWS, GitHub, Slack or Cognito.** Every client is injected.
- **Exact names and values:**
  - card ids appended: `admin`, `project`, `channel`, `connectors`, `alerts`, `reply`, `ready`;
  - questions, word for word: "Sign in again?", "Have you confirmed the subscription? Answer Yes to
    check again.", "Watch for the reply again?";
  - the ready card's optional section starts with the line "Later, if you want more:".
- **Copy:** plain words; every failure says what to do next; no em dashes anywhere user-facing.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test`.
  - Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.
- **Existing suites:** no assertion is removed or weakened; never `vitest -u`. Where test support
  changes (the UI harness returns `setup`), the task says so.
- **Build process:** the owner approves this plan before building; subagent-driven development,
  a fresh implementer and reviewer per task.

## Review Focus

1. **The person mentions the bot a few seconds before the reply card appears.** Expected: the
   watch counts a turn received up to 5 seconds before it started (the existing `EARLY_MS`), and the
   card resolves. Pinned in Task 5 (`init-ui-finish.test.ts`, "counts a mention made just before the
   watch started").
2. **The channel is private and the bot is not in it yet.** Expected: the channel card says to type
   `/invite <@U0BOT>` in it, and resolves to bound by itself once the bot can see it. Pinned in Task
   3 ("shows the invite wait, then the binding").
3. **The first watch saw a failed turn, and the operator watches again.** Expected: the second
   watch ignores that turn and waits for a new mention; it does not fail at once on the old one.
   Pinned in Task 5 ("a second watch does not fail on the turn the first one reported").
4. **The operator confirms the alert subscription while the card is up, then checks again.**
   Expected: nothing is subscribed a second time, and the test alarm goes out. Pinned in Task 4
   ("checks the subscription again without subscribing twice").
5. **The admin sign-in tab is never opened, and the sign-in times out.** Expected: on the page, the
   admin card shows the timeout and asks "Sign in again?"; yes opens a new sign-in; the terminal
   stops with today's message. Pinned in Task 2 ("a sign-in that timed out can be tried again").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/cli/src/init/ui/protocol.ts` (modify) | the finishing card ids | 1 |
| `packages/cli/src/init/ui/cards.ts` (modify) | `adminCard`, `projectCard`, `channelCard`, `connectorsCard`, `alertsCard`, `replyCard`, `readyCard`, `slackChannelLink` | 1 |
| `packages/cli/src/init/install-state.ts` (modify) | `CONNECTOR_LABELS`, moved from `finish-steps.ts` (which re-exports it) | 1 |
| `packages/cli/src/init/finish-steps.ts` (modify) | each finishing step's cards; sign in again; the alert wait and the reply watch on the page | 2, 3, 4, 5 |
| `packages/cli/src/setup/project-add.ts` (modify) | `onRepository`, told the chosen repository | 3 |
| `packages/cli/src/setup/channel-add.ts` (modify) | `onWaiting` | 3 |
| `packages/cli/src/setup/reply-watch.ts` (modify) | `reported` | 5 |
| `packages/cli/src/init/commands.ts` (modify) | the ready card | 6 |
| `tests/contract/init-ui-cards.test.ts` (modify: appended) | the finishing cards' words | 1 |
| `tests/contract/init-ui-finish.test.ts` (create) | each finishing step on the page | 2, 3, 4, 5 |
| `tests/contract/setup-channel.test.ts`, `setup-project-add.test.ts` (modify: appended) | `onWaiting`, `onRepository` | 3 |
| `tests/contract/init-ui-cli.test.ts` (modify: appended; the harness returns `setup`) | the whole install on the page | 2, 6, 7 |
| `specs/040-install-ui/spec.md` (modify) | record the rulings and answers | 8 |

---

### Task 1: The finishing cards

**Files:**
- Modify: `packages/cli/src/init/ui/protocol.ts`, `packages/cli/src/init/ui/cards.ts`, `packages/cli/src/init/install-state.ts` (`CONNECTOR_LABELS` moves here), `packages/cli/src/init/finish-steps.ts` (re-exports it)
- Test: `tests/contract/init-ui-cards.test.ts` (append)

Depends on Q10.

**Interfaces:**
- Consumes: phase 2's `WizardCard`, `CardId`, `cards.ts`; `CONNECTOR_LABELS` (`finish-steps.ts`);
  `InstallProgress` (`install-state.ts`).
- Produces:
  - `CardId` gains `"admin" | "project" | "channel" | "connectors" | "alerts" | "reply" | "ready"`;
  - `slackChannelLink(teamId: string, channelId: string): string`;
  - `adminCard(input: AdminCardInput)`, `projectCard(input: { name: string; revision: number; repository?: string })`,
    `channelCard(input: ChannelCardInput)`, `connectorsCard(input: { projectName: string; connected: Array<{ label: string; warning?: string }> })`,
    `alertsCard(input: AlertsCardInput)`, `replyCard(input: ReplyCardInput)`,
    `readyCard(input: { env: string; controlPlaneUrl: string; progress: InstallProgress })`, each returning `WizardCard`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/init-ui-cards.test.ts`:

```ts
import { adminCard, alertsCard, channelCard, connectorsCard, projectCard, readyCard, replyCard, slackChannelLink } from "../../packages/cli/src/init/ui/cards.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";

const T0 = Date.parse("2026-09-27T00:00:00.000Z");
const WHERE = { channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" };

describe("the finishing cards", () => {
  it("admin: the new user, the sign-in wait, a failed sign-in, and who signed in", () => {
    expect(adminCard({ stage: "signing-in", who: "alice@example.com", createdEmail: "alice@example.com" })).toEqual({
      id: "admin", title: "Admin user", status: "waiting",
      lines: [
        "Created your admin user alice@example.com. Cognito emailed a temporary password to alice@example.com; you choose your own password when you first sign in.",
        "Sign in to AgentX as alice@example.com in the tab the button opens. This page moves on by itself once you have.",
      ],
    });
    expect(adminCard({ stage: "signing-in", who: "alice@example.com" }).lines).toHaveLength(1);
    expect(adminCard({ stage: "failed", problem: "the AgentX sign-in did not finish within 10 minutes" })).toMatchObject({ status: "failed", lines: ["the AgentX sign-in did not finish within 10 minutes", "Answer Yes below to sign in again."] });
    expect(adminCard({ stage: "done", username: "alice@example.com" })).toMatchObject({ status: "ok", lines: ["Signed in to AgentX as alice@example.com."] });
  });

  it("project and channel", () => {
    expect(projectCard({ name: "payments-api", revision: 1, repository: "acme/payments-api" })).toEqual({
      id: "project", title: "First project", status: "ok", lines: ["Project payments-api, revision 1, for acme/payments-api, runs on EC2 workers."],
    });
    expect(projectCard({ name: "payments-api", revision: 2 }).lines).toEqual(["Project payments-api, revision 2, runs on EC2 workers."]);
    expect(channelCard({ stage: "waiting", channelName: "payments", botUserId: "U0BOT00001" })).toEqual({
      id: "channel", title: "Slack channel", status: "waiting",
      lines: ["The bot cannot see #payments yet.", "If #payments is private, type /invite <@U0BOT00001> in it; if it does not exist, create it. This page moves on by itself (up to 10 minutes)."],
    });
    expect(channelCard({ stage: "done", channelName: "payments", projectName: "payments-api" })).toMatchObject({ status: "ok", lines: ["#payments is bound to project payments-api."] });
  });

  it("connectors and alerts, naming a webhook only by its display form", () => {
    expect(connectorsCard({ projectName: "payments-api", connected: [] }).lines).toEqual(["No connectors on payments-api yet. You can add Linear, Jira or Asana later."]);
    expect(connectorsCard({ projectName: "payments-api", connected: [{ label: "Linear" }, { label: "Jira", warning: "the Jira service account can also see issues in HR" }] }).lines).toEqual([
      "Connected to payments-api: Linear, Jira.", "Warning (Jira): the Jira service account can also see issues in HR.",
    ]);
    expect(alertsCard({ stage: "confirm", shownAs: "https://events.pagerduty.com/..." })).toMatchObject({
      id: "alerts", status: "waiting",
      lines: [
        "Confirm the alert subscription for https://events.pagerduty.com/...: open the email from AWS Notifications and choose Confirm subscription (a webhook confirms by opening the SubscribeURL that SNS sent it).",
        "Then answer Yes below to check again.",
      ],
    });
    expect(alertsCard({ stage: "done", shownAs: "ops@example.com" }).lines).toEqual(["Alerts go to ops@example.com, and the test alarm arrived."]);
    expect(alertsCard({ stage: "none" }).lines).toEqual(["No alert address yet. Set one later with agentx config set alerts.address."]);
  });

  it("the test reply: how to mention the bot, a link to the channel, and what to fix", () => {
    expect(slackChannelLink("T0123456789", "C0PAY00001")).toBe("https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001");
    expect(replyCard({ stage: "waiting", ...WHERE, botUserId: "U0BOT00001", minutes: 10 })).toEqual({
      id: "reply", title: "Test reply", status: "waiting",
      lines: [
        'In #payments, post a message that mentions the bot, for example "@<the bot> what can you do?".',
        "Type @ and pick the bot from Slack's mention list: a workspace that had an older AgentX app shows two bots with similar names, and this one's member ID is U0BOT00001.",
        "Waiting up to 10 minutes for AgentX to reply in its thread. This page moves on by itself.",
      ],
      link: { url: "https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001", label: "Open #payments in Slack" },
    });
    expect(replyCard({ stage: "failed", ...WHERE, problem: "no AgentX reply in #payments within 10 minutes" })).toMatchObject({ status: "failed", lines: ["no AgentX reply in #payments within 10 minutes", "Fix it, then answer Yes below to watch for a reply again."] });
    expect(replyCard({ stage: "done", channelName: "payments", seconds: 12 })).toMatchObject({ status: "ok", lines: ["AgentX replied in #payments in 12 seconds."] });
  });

  it("FR-052 and Q10: the ready card says what works now, and puts every command under Later", () => {
    const card = readyCard({ env: "staging", controlPlaneUrl: "https://cp.example.test", progress: {
      ...emptyProgress("staging", T0),
      slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
      project: { name: "payments-api", revision: 2, channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" },
      connectors: [{ type: "linear", ref: "linear" }],
    } });
    expect(card).toEqual({
      id: "ready", title: "AgentX is ready", status: "ok",
      lines: [
        "AgentX environment staging is ready.",
        "Talk to it: mention the bot (member ID U0BOT00001) in #payments, project payments-api, revision 2.",
        "Developers sign in from their AI tools with: npx @charterarc/agentx login https://cp.example.test",
        "Connected: Linear.",
        "Later, if you want more:",
        "More connectors: agentx --env staging connector add linear|jira|asana --project payments-api",
        "More projects: agentx --env staging project add, then agentx --env staging channel add",
        "A test alarm any time: agentx --env staging alerts test",
      ],
      link: { url: "https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001", label: "Open #payments in Slack" },
    });
    const later = card.lines.indexOf("Later, if you want more:");
    expect(card.lines.slice(0, later).some((line) => line.includes("agentx --env"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts`
Expected: FAIL (the builders are not exported).

- [ ] **Step 3: Extend the card ids**

In `packages/cli/src/init/ui/protocol.ts`:

```ts
export type CardId =
  | "aws" | "prerequisites" | "github" | "slack" | "slack-urls"
  // Phase 3's finishing screens, appended.
  | "admin" | "project" | "channel" | "connectors" | "alerts" | "reply" | "ready";
```

- [ ] **Step 4: Write the builders**

Append to `packages/cli/src/init/ui/cards.ts` (import `CONNECTOR_LABELS` and `type InstallProgress`
from `../install-state.js`, after the move described below):

```ts
/** A link that opens a Slack channel in the Slack app or the browser. */
export function slackChannelLink(teamId: string, channelId: string): string {
  return `https://slack.com/app_redirect?team=${encodeURIComponent(teamId)}&channel=${encodeURIComponent(channelId)}`;
}

export type AdminCardInput =
  | { stage: "signing-in"; who: string; createdEmail?: string }
  | { stage: "failed"; problem: string }
  | { stage: "done"; username: string };

/** FR-050: the admin user and the operator's sign-in. The sign-in page's address comes from the
 * run itself (the page's Next button), not from this card. */
export function adminCard(input: AdminCardInput): WizardCard {
  const base = { id: "admin" as const, title: "Admin user" };
  switch (input.stage) {
    case "signing-in": return {
      ...base, status: "waiting",
      lines: [
        ...(input.createdEmail === undefined ? [] : [`Created your admin user ${input.createdEmail}. Cognito emailed a temporary password to ${input.createdEmail}; you choose your own password when you first sign in.`]),
        `Sign in to AgentX as ${input.who} in the tab the button opens. This page moves on by itself once you have.`,
      ],
    };
    case "failed": return { ...base, status: "failed", lines: [input.problem, "Answer Yes below to sign in again."] };
    case "done": return { ...base, status: "ok", lines: [`Signed in to AgentX as ${input.username}.`] };
  }
}

export function projectCard(input: { name: string; revision: number; repository?: string }): WizardCard {
  return {
    id: "project", title: "First project", status: "ok",
    lines: [`Project ${input.name}, revision ${input.revision}${input.repository === undefined ? "" : `, for ${input.repository}`}, runs on EC2 workers.`],
  };
}

export type ChannelCardInput =
  | { stage: "waiting"; channelName: string; botUserId: string }
  | { stage: "done"; channelName: string; projectName: string };

export function channelCard(input: ChannelCardInput): WizardCard {
  const base = { id: "channel" as const, title: "Slack channel" };
  if (input.stage === "done") return { ...base, status: "ok", lines: [`#${input.channelName} is bound to project ${input.projectName}.`] };
  return {
    ...base, status: "waiting",
    lines: [
      `The bot cannot see #${input.channelName} yet.`,
      `If #${input.channelName} is private, type /invite <@${input.botUserId}> in it; if it does not exist, create it. This page moves on by itself (up to 10 minutes).`,
    ],
  };
}

export function connectorsCard(input: { projectName: string; connected: ReadonlyArray<{ label: string; warning?: string }> }): WizardCard {
  const lines = input.connected.length === 0
    ? [`No connectors on ${input.projectName} yet. You can add Linear, Jira or Asana later.`]
    : [
      `Connected to ${input.projectName}: ${input.connected.map((entry) => entry.label).join(", ")}.`,
      ...input.connected.flatMap((entry) => (entry.warning === undefined ? [] : [`Warning (${entry.label}): ${entry.warning}.`])),
    ];
  return { id: "connectors", title: "Connectors", status: "ok", lines };
}

export type AlertsCardInput = { stage: "confirm"; shownAs: string } | { stage: "done"; shownAs: string } | { stage: "none" };

/** `shownAs` is an email address, or a webhook's display form (https://host/...), never its secret. */
export function alertsCard(input: AlertsCardInput): WizardCard {
  const base = { id: "alerts" as const, title: "Alerts" };
  switch (input.stage) {
    case "confirm": return {
      ...base, status: "waiting",
      lines: [
        `Confirm the alert subscription for ${input.shownAs}: open the email from AWS Notifications and choose Confirm subscription (a webhook confirms by opening the SubscribeURL that SNS sent it).`,
        "Then answer Yes below to check again.",
      ],
    };
    case "done": return { ...base, status: "ok", lines: [`Alerts go to ${input.shownAs}, and the test alarm arrived.`] };
    case "none": return { ...base, status: "info", lines: ["No alert address yet. Set one later with agentx config set alerts.address."] };
  }
}

export type ReplyCardInput =
  | { stage: "waiting"; channelName: string; channelId: string; teamId: string; botUserId: string; minutes: number }
  | { stage: "failed"; channelName: string; channelId: string; teamId: string; problem: string }
  | { stage: "done"; channelName: string; seconds: number };

/** FR-051: the test reply, with 15e's note on picking the right bot from Slack's mention list. */
export function replyCard(input: ReplyCardInput): WizardCard {
  const base = { id: "reply" as const, title: "Test reply" };
  if (input.stage === "done") return { ...base, status: "ok", lines: [`AgentX replied in #${input.channelName} in ${input.seconds} seconds.`] };
  const link = { url: slackChannelLink(input.teamId, input.channelId), label: `Open #${input.channelName} in Slack` };
  if (input.stage === "failed") return { ...base, status: "failed", lines: [input.problem, "Fix it, then answer Yes below to watch for a reply again."], link };
  return {
    ...base, status: "waiting",
    lines: [
      `In #${input.channelName}, post a message that mentions the bot, for example "@<the bot> what can you do?".`,
      `Type @ and pick the bot from Slack's mention list: a workspace that had an older AgentX app shows two bots with similar names, and this one's member ID is ${input.botUserId}.`,
      `Waiting up to ${input.minutes} minutes for AgentX to reply in its thread. This page moves on by itself.`,
    ],
    link,
  };
}

/** FR-052 and Q10: what works now, then the optional commands under "Later, if you want more:".
 * The same facts as readyText, which the terminal and the page's outcome still show. */
export function readyCard(input: { env: string; controlPlaneUrl: string; progress: InstallProgress }): WizardCard {
  const { env, progress } = input;
  const cli = `agentx --env ${env}`;
  const { project, slack } = progress;
  const connectors = progress.connectors ?? [];
  const teamId = project?.teamId ?? slack?.teamId;
  return {
    id: "ready", title: "AgentX is ready", status: "ok",
    lines: [
      `AgentX environment ${env} is ready.`,
      ...(project?.channelName === undefined || slack === undefined ? [] : [`Talk to it: mention the bot (member ID ${slack.botUserId}) in #${project.channelName}, project ${project.name}, revision ${project.revision}.`]),
      `Developers sign in from their AI tools with: npx @charterarc/agentx login ${input.controlPlaneUrl}`,
      connectors.length === 0 ? "No connectors yet." : `Connected: ${connectors.map((entry) => CONNECTOR_LABELS[entry.type]).join(", ")}.`,
      ...connectors.flatMap((entry) => (entry.warning === undefined ? [] : [`Warning (${CONNECTOR_LABELS[entry.type]}): ${entry.warning}.`])),
      "Later, if you want more:",
      ...(project === undefined ? [] : [`More connectors: ${cli} connector add linear|jira|asana --project ${project.name}`]),
      `More projects: ${cli} project add, then ${cli} channel add`,
      `A test alarm any time: ${cli} alerts test`,
    ],
    ...(project?.channelId === undefined || project.channelName === undefined || teamId === undefined
      ? {} : { link: { url: slackChannelLink(teamId, project.channelId), label: `Open #${project.channelName} in Slack` } }),
  };
}
```

`cards.ts` importing `finish-steps.ts` and `finish-steps.ts` importing `cards.ts` (Tasks 2 to 5)
would be a cycle. `CONNECTOR_LABELS` is only read at call time, so ES modules would resolve it, but
a cycle is a trap for the next change: move `CONNECTOR_LABELS` from `finish-steps.ts` to
`install-state.ts`, beside `CONNECTOR_TYPES`, re-export it from `finish-steps.ts`
(`export { CONNECTOR_LABELS } from "./install-state.js";`, so every existing import keeps
working), and import it in `cards.ts` from `../install-state.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/install-state.ts packages/cli/src/init/finish-steps.ts tests/contract/init-ui-cards.test.ts
git commit -m "feat(init-ui): the finishing screens' cards"
```

---

### Task 2: The admin user and signing in

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts`
- Test: `tests/contract/init-ui-finish.test.ts` (create), `tests/contract/init-ui-cli.test.ts` (append; the harness returns `setup`)

Depends on Q5 and Q7.

**Interfaces:**
- Consumes: Task 1's `adminCard`; phase 2's `retryOnPage`, `context.surface`, `openLink`.
- Produces: nothing new for later tasks; `adminUserStep`'s result and progress facts are unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-finish.test.ts
// Spec 040 phase 3: each finishing step on the install page. The steps are the ones agentx init
// already runs (phase 15d2); these tests check what each shows on the page, and that a wait that
// fails can be tried again there, while the terminal path stops exactly as it did.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { writeEnvironmentSettings } from "../../packages/cli/src/environments/settings.js";
import { adminUserStep, alertsStep, e2eStep } from "../../packages/cli/src/init/finish-steps.js";
import { emptyProgress } from "../../packages/cli/src/init/install-state.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { initContext, progressHandle, sampleAnswers, scriptedPrompter, T0, type TestInitContext } from "../support/init-fakes.js";
import { ADMIN_EMAIL, CONTROL_PLANE, fakeAlerts, fakeControlPlane, fakeCognito, setupServices, STAGING_SETTINGS, turn } from "../support/setup-fakes.js";

let context: TestInitContext | undefined;
afterEach(async () => { if (context !== undefined) await rm(context.home, { recursive: true, force: true }); context = undefined; });
const page = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };
const session = { controlPlaneUrl: CONTROL_PLANE, accessToken: "t" };
const TIMED_OUT = agentXError("OPERATION_INTERRUPTED", "the AgentX sign-in did not finish within 10 minutes; run agentx init again and finish signing in as the admin user in the browser");

describe("the admin user on the page (FR-050)", () => {
  it("shows the new admin user and the sign-in wait, then who signed in", async () => {
    const surface = page();
    context = initContext({ prompter: scriptedPrompter([ADMIN_EMAIL]), surface, setup: setupServices({ cognito: fakeCognito() }), adminSession: async () => session });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await adminUserStep().run(context, progressHandle())).toEqual({ status: "done", note: `admin ${ADMIN_EMAIL}` });
    expect(surface.cards.map((card) => [card.id, card.status, card.lines])).toEqual([
      ["admin", "waiting", [
        `Created your admin user ${ADMIN_EMAIL}. Cognito emailed a temporary password to ${ADMIN_EMAIL}; you choose your own password when you first sign in.`,
        `Sign in to AgentX as ${ADMIN_EMAIL} in the tab the button opens. This page moves on by itself once you have.`,
      ]],
      ["admin", "ok", [`Signed in to AgentX as ${ADMIN_EMAIL}.`]],
    ]);
  });

  it("Review Focus 5: a sign-in that timed out can be tried again on the page", async () => {
    const surface = page();
    let sessions = 0;
    context = initContext({
      prompter: scriptedPrompter([ADMIN_EMAIL, true]), surface, setup: setupServices({ cognito: fakeCognito() }),
      adminSession: async () => { sessions += 1; if (sessions === 1) throw TIMED_OUT; return session; },
    });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    await adminUserStep().run(context, progressHandle());
    expect(sessions).toBe(2);
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Your email address, for your AgentX admin user", "Sign in again?"]);
    expect(surface.cards.find((card) => card.status === "failed")?.lines[0]).toBe("the AgentX sign-in did not finish within 10 minutes; run agentx init again and finish signing in as the admin user in the browser");
  });

  it("the terminal path stops on a timed-out sign-in, as before", async () => {
    context = initContext({ prompter: scriptedPrompter([ADMIN_EMAIL]), setup: setupServices({ cognito: fakeCognito() }), adminSession: async () => { throw TIMED_OUT; } });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    await expect(adminUserStep().run(context, progressHandle())).rejects.toBe(TIMED_OUT);
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Your email address, for your AgentX admin user"]);
  });
});
```

In `tests/contract/init-ui-cli.test.ts`, make `harness()` also return `setup` (support only), and
append:

```ts
  it("FR-050 and Q5: the admin sign-in page is a button on the install page, never a tab opened by itself", async () => {
    const h = await harness();
    const SIGN_IN = "https://auth.example.test/oauth2/authorize?client_id=c&state=s";
    const login: typeof h.setup.login = async (options) => { await options.openBrowser?.(SIGN_IN); return h.setup.login(options); };
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, setup: { ...h.setup, login } })).toBe(0);
    await operator.settled();
    expect(operator.clicked).toContain(SIGN_IN);
    expect(operator.opened).toHaveLength(1);
    const during = operator.states.find((state) => state.link?.url === SIGN_IN);
    expect(during?.link?.label).toBe("Open auth.example.test");
    expect(during?.cards?.find((card) => card.id === "admin")?.status).toBe("waiting");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-finish.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL (no admin card; "Sign in again?" is never asked).

- [ ] **Step 3: Show the admin card, and sign in again on the page**

In `packages/cli/src/init/finish-steps.ts`, import `retryOnPage` from `./retry.js` and
`adminCard, type AdminCardInput` from `./ui/cards.js`. Replace `adminUserStep` with:

```ts
export function adminUserStep(): InitStep<InitContext> {
  return {
    id: "admin-user",
    title: "Create the admin user and sign in",
    async run(context, progress) {
      const settings = await requireSettings(context);
      const recorded = progress.current().admin;
      const show = (card: AdminCardInput) => context.surface?.card(adminCard(card));
      // FR-050 (Q7): on the page, a sign-in that fails or times out can be tried again; the
      // terminal stops, as before. The sign-in page itself is the page's Next button (Q5).
      const signIn = (who: string, createdEmail?: string) => retryOnPage({
        surface: context.surface, prompter: context.prompter, question: "Sign in again?",
        failed: (problem) => show({ stage: "failed", problem }),
        run: async () => {
          show({ stage: "signing-in", who, ...(createdEmail === undefined ? {} : { createdEmail }) });
          return context.adminSession();
        },
      });
      if (settings.identity.mode === "cognito") {
        const email = recorded?.username ?? context.flags.adminEmail ?? await context.prompter.ask("Your email address, for your AgentX admin user", {
          flag: "--admin-email", validate: (value) => (AlertEmailSchema.safeParse(value).success ? undefined : "must be an email address"),
        });
        let created = false;
        if (recorded === undefined) {
          created = (await ensureCognitoAdmin({
            cognito: context.setup.cognito, poolId: userPoolId(settings), email, write: context.write,
            confirm: (question) => context.prompter.confirm(question, { defaultValue: false }),
          })).created;
          await progress.update({ admin: { username: email, mode: "cognito" } });
        }
        await signIn(email, created ? email : undefined);
        show({ stage: "done", username: email });
        return { status: "done", note: `admin ${email}` };
      }
      // F13 and C6 (FR-021): with your own OIDC, the admin claim is what makes someone an AgentX
      // administrator, so an install whose answers name none is refused, never signed in unchecked.
      const identity = context.answers.identity;
      if (identity.mode !== "oidc") {
        throw agentXError("CONFIG_INVALID", `the install's identity settings do not match its answers: /agentx/${context.env}/settings says your own OIDC provider, but the answers say Cognito; check which install wrote /agentx/${context.env}/settings, or start a new install with another --env`);
      }
      if (identity.adminClaim === undefined || identity.adminValues === undefined) {
        throw agentXError("CONFIG_INVALID", `the install's answers name no admin claim; AgentX cannot check that you are an administrator of your own OIDC provider, and an install's answers cannot change halfway. Start a new install with another --env, passing --admin-claim and --admin-values`);
      }
      const session = await signIn("an administrator of your company's sign-in");
      const username = oidcAdminName(session.accessToken);
      await progress.update({ admin: { username, mode: "oidc" } });
      show({ stage: "done", username });
      return { status: "done", note: `admin ${username} signed in with your OIDC provider` };
    },
  };
}
```

The two refusals and every terminal line are word for word as before.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-finish.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/finish-steps.ts tests/contract/init-ui-finish.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): the admin user screen, with the sign-in as a page button and sign in again"
```

---

### Task 3: The first project and its channel

**Files:**
- Modify: `packages/cli/src/setup/project-add.ts`, `packages/cli/src/setup/channel-add.ts`, `packages/cli/src/init/finish-steps.ts`
- Test: `tests/contract/setup-project-add.test.ts` (append), `tests/contract/setup-channel.test.ts` (append), `tests/contract/init-ui-cli.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's `projectCard`, `channelCard`.
- Produces: `addProject`'s input gains `onRepository?: (fullName: string) => void`, told the
  repository once it is chosen (its result is unchanged, so the tests that pin it with `toEqual`
  stay as they are); `addChannel`'s input gains `onWaiting?: (channelName: string) => void`,
  called once, with the invite line.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/setup-channel.test.ts` (it already defines `session`, `TEAM`, `BOT` and
`clock()`):

```ts
describe("the invite wait, told to the install page (spec 040 phase 3)", () => {
  it("calls onWaiting once, with the channel's name, when the bot cannot see it yet", async () => {
    const waited: string[] = [];
    const lines: string[] = [];
    const plane = fakeControlPlane();
    const bound = await addChannel({
      session, botToken: "xoxb-1", teamId: TEAM, botUserId: BOT, projectName: "payments-api",
      prompter: scriptedPrompter(["payments"]), write: (line) => { lines.push(line); }, ...clock(),
      services: { fetch: plane.fetch, slackChannels: fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: true, isMember: true }], { visibleAfterFinds: 3 }) },
      flags: {}, onWaiting: (name) => { waited.push(name); },
    });
    expect(bound).toEqual({ channelId: "C0PAY00001", channelName: "payments" });
    expect(waited).toEqual(["payments"]);
    // The terminal's line is unchanged.
    expect(lines).toContain(`The bot cannot see #payments yet. If #payments is private, type /invite <@${BOT}> in it; if it does not exist, create it. Waiting up to 10 minutes.`);
  });
});
```

Append to `describe("agentx project add (FR-040)", ...)` in `tests/contract/setup-project-add.test.ts`:

```ts
  it("tells the install page which repository it chose, and returns what it always returned", async () => {
    const chosen: string[] = [];
    const result = await addProject({
      env: "staging", session, githubToken: "ghs_x", prompter: scriptedPrompter(["acme/payments-api", "", true]), write: () => undefined, services: services(), flags: {},
      onRepository: (fullName) => { chosen.push(fullName); },
    });
    expect(chosen).toEqual(["acme/payments-api"]);
    expect(result).toEqual({ name: "payments-api", revision: 1, file: join(configDir, "payments-api.yaml") });
  });
```

Append to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("Review Focus 2: a private channel shows the invite wait, then the binding, and the project card shows the repository", async () => {
    const h = await harness();
    const slackChannels = fakeSlackChannels([{ id: "C0PAY00001", name: "payments", isPrivate: true, isMember: true }], { visibleAfterFinds: 3 });
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, setup: { ...h.setup, slackChannels } })).toBe(0);
    await operator.settled();
    const channel = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "channel") ?? []);
    expect(channel.map((card) => card.status)).toContain("waiting");
    expect(channel.at(-1)).toMatchObject({ status: "ok", lines: ["#payments is bound to project payments-api."] });
    expect(operator.states.at(-1)?.cards?.find((card) => card.id === "project")?.lines).toEqual(["Project payments-api, revision 1, for acme/payments-api, runs on EC2 workers."]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/setup-channel.test.ts tests/contract/setup-project-add.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL (`onWaiting` and `onRepository` are not called; no project or channel card).

- [ ] **Step 3: `onRepository` and `onWaiting`**

In `packages/cli/src/setup/project-add.ts`, add to `addProject`'s input
`/** The install page's project card (spec 040 phase 3): told the repository once it is chosen. */ onRepository?: (fullName: string) => void;`
and change the one line that chooses it:

```ts
  const chosenRepository = async () => {
    const picked = await chooseRepository(await input.services.repositories.list(input.githubToken), prompter, flags.repository);
    input.onRepository?.(picked.fullName);
    return picked;
  };
```

In `packages/cli/src/setup/channel-add.ts`, add to `addChannel`'s input
`/** The install page's channel card (spec 040 phase 3): told once, with the invite line. */ onWaiting?: (channelName: string) => void;`
and call it right after the invite line is written:

```ts
    if (!askedForInvite && wait === FIND_POLL_MS) {
      input.write(`The bot cannot see #${name} yet. If #${name} is private, type /invite <@${input.botUserId}> in it; if it does not exist, create it. Waiting up to 10 minutes.`);
      input.onWaiting?.(name);
      askedForInvite = true;
    }
```

- [ ] **Step 4: Show the project and channel cards**

In `packages/cli/src/init/finish-steps.ts`, import `projectCard, channelCard` from
`./ui/cards.js`. In `firstProjectStep.run`:
- pass `onRepository` to `addProject` and show the project card once the project is known
  (a project an earlier run recorded is shown without its repository);
- pass `onWaiting: (channelName) => context.surface?.card(channelCard({ stage: "waiting", channelName, botUserId: slack.botUserId })),`
  to `addChannel`;
- before `return { status: "done", ... }`, when the channel is known:
  `if (project.channelName !== undefined) context.surface?.card(channelCard({ stage: "done", channelName: project.channelName, projectName: project.name }));`

The step as a whole reads:

```ts
    async run(context, progress) {
      const session = await context.adminSession();
      let project = progress.current().project;
      let shown = false;
      if (project === undefined) {
        const installationId = progress.current().github?.installationId;
        const githubToken = await installationToken({
          env: context.env, secrets: context.secrets, github: context.setup.github,
          ...(installationId === undefined ? {} : { installationId }),
          nowSeconds: Math.floor(context.now() / 1000),
        });
        let repository: string | undefined;
        const added = await addProject({
          env: context.env, session, githubToken, prompter: context.prompter, write: context.write, services: context.setup, flags: context.flags,
          onRepository: (fullName) => { repository = fullName; },
        });
        project = { name: added.name, revision: added.revision };
        await progress.update({ project });
        context.surface?.card(projectCard({ name: added.name, revision: added.revision, ...(repository === undefined ? {} : { repository }) }));
        shown = true;
      }
      if (!shown) context.surface?.card(projectCard({ name: project.name, revision: project.revision }));
      if (project.channelId === undefined) {
        const slack = progress.current().slack;
        if (slack === undefined) throw agentXError("CONFIG_INVALID", "install progress has no Slack app facts; the Slack app step must finish first, so run agentx init again");
        const bound = await addChannel({
          session, botToken: await readSlackBotToken(context.secrets, context.env), teamId: slack.teamId, botUserId: slack.botUserId, projectName: project.name,
          prompter: context.prompter, write: context.write, sleep: context.sleep, now: context.now, services: context.setup, flags: context.flags,
          onWaiting: (channelName) => context.surface?.card(channelCard({ stage: "waiting", channelName, botUserId: slack.botUserId })),
        });
        project = { ...project, channelId: bound.channelId, channelName: bound.channelName, teamId: slack.teamId };
        await progress.update({ project });
      }
      if (project.channelName !== undefined) context.surface?.card(channelCard({ stage: "done", channelName: project.channelName, projectName: project.name }));
      return { status: "done", note: `project ${project.name} in #${project.channelName ?? project.channelId}` };
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/setup-channel.test.ts tests/contract/setup-project-add.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS, every existing `addProject` and `addChannel` test unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/setup/project-add.ts packages/cli/src/setup/channel-add.ts packages/cli/src/init/finish-steps.ts tests/contract/setup-channel.test.ts tests/contract/setup-project-add.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): the first project and channel screens, with the invite wait as a card"
```

---

### Task 4: The connectors and the alerts

**Files:**
- Modify: `packages/cli/src/init/finish-steps.ts`
- Test: `tests/contract/init-ui-finish.test.ts` (append), `tests/contract/init-ui-cli.test.ts` (append)

Depends on Q7.

> **As built (ruling R3):** `ensureSubscribed` takes an optional `onWaiting`, so the page shows an
> alerts "waiting" card while the confirmation wait runs (up to 10 minutes), then the "confirm" card
> below; the first test's statuses are `["waiting", "waiting", "ok"]`.

**Interfaces:**
- Consumes: Task 1's `connectorsCard`, `alertsCard`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/init-ui-finish.test.ts`:

```ts
describe("the alerts on the page", () => {
  const TOPIC = "arn:aws:sns:us-east-1:123456789012:agentx-staging-alerts";
  const setupFor = (alerts: ReturnType<typeof fakeAlerts>) => setupServices({ alerts, stackOutputs: async () => ({ OperatorAlertsTopicArn: TOPIC }) });
  const answers = sampleAnswers({ alert: { kind: "email", address: "ops@example.com" } });

  it("Review Focus 4: waits on the page for the confirmation, checks again without subscribing twice, then sends the test alarm", async () => {
    const surface = page();
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000_000, budgetUsd: 100 });
    const base = scriptedPrompter([true, true]);
    // The operator confirms the email while the card is up, then answers Yes.
    const prompter = { ...base, confirm: async (question: string, options: { defaultValue: boolean }) => { if (question.startsWith("Have you confirmed")) alerts.confirmAll(); return base.confirm(question, options); } };
    context = initContext({ answers, prompter, surface, setup: setupFor(alerts) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await alertsStep().run(context, progressHandle())).toEqual({ status: "done", note: "alerts to ops@example.com, test alarm received" });
    expect(alerts.subscribed).toHaveLength(1);
    expect(base.asked[0]).toBe("Have you confirmed the subscription? Answer Yes to check again.");
    expect(surface.cards.map((card) => card.status)).toEqual(["waiting", "ok"]);
  });

  it("the terminal path still stops and says to run agentx init again when nobody has confirmed", async () => {
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000_000, budgetUsd: 100 });
    context = initContext({ answers, prompter: scriptedPrompter([]), setup: setupFor(alerts) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    const outcome = await alertsStep().run(context, progressHandle());
    expect(outcome).toMatchObject({ status: "waiting" });
  });

  it("saying no on the page stops the same way", async () => {
    const alerts = fakeAlerts({ confirmAfterPolls: 1_000_000, budgetUsd: 100 });
    context = initContext({ answers, prompter: scriptedPrompter([false]), surface: page(), setup: setupFor(alerts) });
    await writeEnvironmentSettings(context.store, STAGING_SETTINGS);
    expect(await alertsStep().run(context, progressHandle())).toMatchObject({ status: "waiting" });
  });
});
```

`fakeAlerts` records one `subscribed` entry per `subscribe` call, and `confirmAll` confirms every
pending subscription; `sampleAnswers()` has no budget, so the step reads none; the test alarm's own
confirm ("Did a test alarm named ... arrive at ops@example.com?") takes the second scripted `true`.

Append to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("the connectors card lists what was connected", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH_WITH_LINEAR]);
    expect(code).toBe(0);
    expect(operator.states.at(-1)?.cards?.find((card) => card.id === "connectors")?.lines).toEqual(["Connected to payments-api: Linear."]);
    expect(operator.states.at(-1)?.cards?.find((card) => card.id === "alerts")?.lines).toEqual(["Alerts go to ops@example.com, and the test alarm arrived."]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-finish.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: The connectors card**

In `connectorsStep.run`, before the `return`, add:

```ts
      context.surface?.card(connectorsCard({
        projectName: project.name,
        connected: (progress.current().connectors ?? []).map((entry) => ({ label: CONNECTOR_LABELS[entry.type], ...(entry.warning === undefined ? {} : { warning: entry.warning }) })),
      }));
```

- [ ] **Step 4: The alerts card, and the wait on the page**

In `alertsStep.run`:
- in the `--no-alerts` branch, before its `return`: `context.surface?.card(alertsCard({ stage: "none" }));`
- replace the `if (!recorded.subscribed) { ... }` block with:

```ts
      if (!recorded.subscribed) {
        const target: AlertTarget = answers.alert.kind === "email"
          ? { kind: "email", address: answers.alert.address }
          : { kind: "webhook", display: answers.alert.display, endpoint: await requireWebhook(context, answers.alert.secretName) };
        const subscribe = () => ensureSubscribed({ api: context.setup.alerts, topicArn, target, write: context.write, sleep: context.sleep, now: context.now });
        let state = await subscribe();
        // Q7: on the page, the operator confirms and checks again; ensureSubscribed never
        // subscribes an address twice. The terminal stops and says to run init again, as before.
        while (state === "pending" && context.surface !== undefined) {
          context.surface.card(alertsCard({ stage: "confirm", shownAs }));
          if (!(await context.prompter.confirm("Have you confirmed the subscription? Answer Yes to check again.", { defaultValue: true }))) break;
          state = await subscribe();
        }
        if (state === "pending") return { status: "waiting", message: `Confirm the alert subscription for ${shownAs} (the AWS Notifications email, or your webhook's SubscribeURL), then run agentx init --env ${context.env} --region ${answers.region} again.` };
        // Recorded before the test alarm, so a failed test is retried without subscribing again.
        await progress.update({ alerts: { subscribed: true, tested: false } });
      }
```

- after `await progress.update({ alerts: { subscribed: true, tested: true } });`:
  `context.surface?.card(alertsCard({ stage: "done", shownAs }));`

Import `connectorsCard, alertsCard` from `./ui/cards.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-finish.test.ts tests/contract/init-finish-steps.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/finish-steps.ts tests/contract/init-ui-finish.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): the connectors and alerts screens; the alert confirmation waits on the page"
```

---

### Task 5: The test reply (FR-051)

**Files:**
- Modify: `packages/cli/src/setup/reply-watch.ts`, `packages/cli/src/init/finish-steps.ts`
- Test: `tests/contract/init-ui-finish.test.ts` (append)

Depends on Q7.

**Interfaces:**
- Consumes: Task 1's `replyCard`; phase 2's `retryOnPage`.
- Produces: `waitForThreadedReply`'s input gains `reported?: Set<string>`: the event ids of turns
  already reported as failed; they are skipped, and a newly failed turn is added before the throw.
  `REPLY_WAIT_MS` stays the one source of the minutes shown.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/init-ui-finish.test.ts`:

```ts
describe("the test reply on the page (FR-051)", () => {
  const progress = () => progressHandle({
    ...emptyProgress("staging", T0),
    slack: { appId: "A0APP00001", teamId: "T0123456789", botUserId: "U0BOT00001" },
    project: { name: "payments-api", revision: 1, channelName: "payments", channelId: "C0PAY00001", teamId: "T0123456789" },
  });
  const SUBJECT = "T0123456789/C0PAY00001/1790000000.000100";

  it("shows how to mention the bot and a link to the channel, then the reply", async () => {
    const surface = page();
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: SUBJECT, receivedAt: new Date(T0 + 2000).toISOString(), disposition: "answered", durationMs: 12_000 })];
    context = initContext({ surface, setup: setupServices({ fetch: plane.fetch }), adminSession: async () => session });
    await e2eStep().run(context, progress());
    expect(surface.cards.map((card) => [card.status, card.link?.url])).toEqual([
      ["waiting", "https://slack.com/app_redirect?team=T0123456789&channel=C0PAY00001"],
      ["ok", undefined],
    ]);
    expect(surface.cards[0]?.lines[1]).toContain("this one's member ID is U0BOT00001");
  });

  it("Review Focus 1: counts a mention made just before the watch started", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: SUBJECT, receivedAt: new Date(T0 - 3000).toISOString(), disposition: "answered", durationMs: 9_000 })];
    context = initContext({ surface: page(), setup: setupServices({ fetch: plane.fetch }), adminSession: async () => session });
    expect(await e2eStep().run(context, progress())).toEqual({ status: "done", note: "a mention in #payments got a threaded reply in 9 seconds" });
  });

  it("Review Focus 3: a second watch does not fail on the turn the first one reported, and waits for a new mention", async () => {
    const surface = page();
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: SUBJECT, receivedAt: new Date(T0 + 2000).toISOString(), disposition: "error" })];
    const base = scriptedPrompter([true]);
    const prompter = { ...base, confirm: async (question: string, options: { defaultValue: boolean }) => {
      // The operator fixes the problem and mentions the bot again before answering Yes.
      plane.turns.push(turn({ subject: "T0123456789/C0PAY00001/1790000100.000100", receivedAt: new Date((context?.now() ?? T0) + 1000).toISOString(), disposition: "answered", durationMs: 7_000 }));
      return base.confirm(question, options);
    } };
    context = initContext({ prompter, surface, setup: setupServices({ fetch: plane.fetch }), adminSession: async () => session });
    expect(await e2eStep().run(context, progress())).toEqual({ status: "done", note: "a mention in #payments got a threaded reply in 7 seconds" });
    expect(base.asked).toEqual(["Watch for the reply again?"]);
    expect(surface.cards.find((card) => card.status === "failed")?.lines[0]).toContain("but the turn ended as error");
  });

  it("without a page, a failed reply still stops with what to fix", async () => {
    const plane = fakeControlPlane();
    plane.turns = [turn({ subject: SUBJECT, receivedAt: new Date(T0 + 2000).toISOString(), disposition: "error" })];
    context = initContext({ setup: setupServices({ fetch: plane.fetch }), adminSession: async () => session });
    await expect(e2eStep().run(context, progress())).rejects.toThrow("but the turn ended as error; see agentx --env staging admin turns export --since 15m, fix it, then run agentx --env staging init again");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-finish.test.ts`
Expected: FAIL (no reply card; the second watch fails at once on the old turn).

- [ ] **Step 3: `reported` in the reply watch**

In `packages/cli/src/setup/reply-watch.ts`, add to the input:

```ts
  /** Event ids of turns an earlier watch already reported as failed: skipped here, so a second
   * watch waits for a new mention (spec 040 FR-051). A newly failed turn is added before the throw. */
  reported?: Set<string>;
```

and change the two lines that pick turns:

```ts
    const mine = turns.filter((entry) => entry.subject.startsWith(prefix) && Date.parse(entry.receivedAt) >= started - EARLY_MS && input.reported?.has(entry.eventId) !== true);
```

and before the `throw` for `other`: `input.reported?.add(other.eventId);`.

- [ ] **Step 4: The reply card, and watching again on the page**

In `packages/cli/src/init/finish-steps.ts`, import `REPLY_WAIT_MS` from
`../setup/reply-watch.js` and `replyCard, type ReplyCardInput` from `./ui/cards.js`. Replace the
body of `e2eStep.run` after the progress check with:

```ts
      const where = { channelName: project.channelName, channelId: project.channelId, teamId: slack.teamId };
      const show = (card: ReplyCardInput) => context.surface?.card(replyCard(card));
      const reported = new Set<string>();
      // FR-051 (Q7): on the page, the card says what to fix and the operator watches again; the
      // terminal stops with the same advice, as before.
      const reply = await retryOnPage({
        surface: context.surface, prompter: context.prompter, question: "Watch for the reply again?",
        failed: (problem) => show({ stage: "failed", ...where, problem }),
        run: async () => {
          show({ stage: "waiting", ...where, botUserId: slack.botUserId, minutes: Math.round(REPLY_WAIT_MS / 60_000) });
          return waitForThreadedReply({
            env: context.env, session: await context.adminSession(), fetch: context.setup.fetch, teamId: slack.teamId, channelId: project.channelId,
            channelName: project.channelName, botUserId: slack.botUserId, rerun: `agentx --env ${context.env} init`, write: context.write, sleep: context.sleep, now: context.now,
            reported,
          });
        },
      });
      show({ stage: "done", channelName: project.channelName, seconds: reply.seconds });
      return { status: "done", note: `a mention in #${project.channelName} got a threaded reply in ${reply.seconds} seconds` };
```

`project.channelId` and `project.channelName` are narrowed by the step's existing check above.
If TypeScript loses the narrowing inside the closure, bind them first:
`const channelId = project.channelId; const channelName = project.channelName;` and use those.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-finish.test.ts tests/contract/init-finish-steps.test.ts tests/contract/setup-channel.test.ts tests/contract/init-cli.test.ts`
Expected: PASS (`waitForThreadedReply`'s other callers pass no `reported`).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/setup/reply-watch.ts packages/cli/src/init/finish-steps.ts tests/contract/init-ui-finish.test.ts
git commit -m "feat(init-ui): the test reply as a live card; watching again ignores a turn already reported"
```

---

### Task 6: The ready screen (FR-052)

**Files:**
- Modify: `packages/cli/src/init/commands.ts`
- Test: `tests/contract/init-ui-cli.test.ts` (append)

Depends on Q10.

**Interfaces:**
- Consumes: Task 1's `readyCard`.

- [ ] **Step 1: Write the failing test**

```ts
  it("FR-052: the page ends on a ready card that needs no command to finish, and the outcome is still readyText", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const last = operator.states.at(-1);
    const ready = last?.cards?.find((card) => card.id === "ready");
    expect(ready?.lines[0]).toBe("AgentX environment staging is ready.");
    expect(ready?.link?.url).toBe("https://slack.com/app_redirect?team=T0TEAM&channel=C0PAY00001");
    const later = ready?.lines.indexOf("Later, if you want more:") ?? -1;
    expect(later).toBeGreaterThan(0);
    expect(ready?.lines.slice(0, later).some((line) => line.includes("agentx --env"))).toBe(false);
    // The phase 1 outcome is unchanged: the same summary the terminal prints.
    expect(last?.outcome).toContain("AgentX environment staging is ready.");
  });

  it("a run stopped with --stop-after shows no ready card", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN], ["--stop-after", "prerequisites"]);
    expect(code).toBe(0);
    expect(operator.states.at(-1)?.cards?.some((card) => card.id === "ready")).toBe(false);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/contract/init-ui-cli.test.ts`
Expected: FAIL (no ready card).

- [ ] **Step 3: Show it**

In `packages/cli/src/init/commands.ts`, import `readyCard` from `./ui/cards.js`, and in `init`'s
success path, after `const progress = ...;` and before the `return`:

```ts
    // FR-052: the page's last card says what works now; the terminal and the page's outcome keep
    // readyText.
    if (surface !== undefined && settings !== undefined && progress !== undefined) {
      surface.card(readyCard({ env, controlPlaneUrl: settings.controlPlaneUrl, progress }));
    }
```

(The `--stop-after` branch returns before this, so a cut-short run shows no ready card.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/init/commands.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): the ready screen, with every day-2 command under Later"
```

---

### Task 7: The whole install on the page

**Files:**
- Test: `tests/contract/init-ui-cli.test.ts` (append)

This task changes no production code unless a test finds a defect (fixed test first in its task).

- [ ] **Step 1: Write the tests**

```ts
  it("User Story 3 and SC-003: a first install on the page ends with a reply, every card ok, and nothing typed in the terminal", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.states.at(-1)?.cards?.map((card) => [card.id, card.status])).toEqual([
      ["aws", "ok"], ["prerequisites", "ok"], ["github", "ok"], ["slack", "ok"], ["slack-urls", "ok"],
      ["admin", "ok"], ["project", "ok"], ["channel", "ok"], ["connectors", "ok"], ["alerts", "ok"], ["reply", "ok"], ["ready", "ok"],
    ]);
    expect(h.plane.bindings).toEqual(["T0TEAM/C0PAY00001"]);
    expect(operator.opened).toHaveLength(1);
  });

  it("FR-012: no finishing secret reaches a card", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH_WITH_LINEAR]);
    expect(code).toBe(0);
    const cards = JSON.stringify(operator.states.map((state) => state.cards));
    for (const secret of [LINEAR_KEY, TEST_BOT_TOKEN, "fedcba9876543210fedcba9876543210"]) expect(cards).not.toContain(secret);
  });

  it("a resumed install shows the finishing cards of the steps it runs", async () => {
    const h = await harness();
    h.deployer.fail.set(environmentStackName("staging", "control-plane"), new Error("Resource limit exceeded"));
    expect(await h.run([], { prompter: scriptedPrompter(FIRST_RUN) })).not.toBe(0);
    h.deployer.fail.clear();
    const { code, operator } = await h.runUi([...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.states.at(-1)?.cards?.map((card) => card.id)).toEqual(expect.arrayContaining(["admin", "project", "channel", "reply", "ready"]));
  });
```

- [ ] **Step 2: Run the whole suite**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/contract/init-ui-cli.test.ts
git commit -m "test(init-ui): the whole install on the page, ending with a reply"
```

---

### Task 8: Record the rulings and the owner's answers in the spec

This task changes no code. It records this phase's rulings and the owner's answers as given. If an
answer differs from a recommendation this plan followed, stop: the owning task changes first, with
its test, then this task records it.

**Files:**
- Modify: `specs/040-install-ui/spec.md`

- [ ] **Step 1: Amend the spec**
  - FR-050: add "On the page, the sign-in page is a button (Q5), and a sign-in that fails or times
    out can be tried again (Q7). A private channel's invite wait and the alert subscription's
    confirmation are cards that resolve by themselves, and the alert wait can be checked again on
    the page."
  - FR-051: add "A second watch ignores a turn the first one already reported as failed."
  - FR-052: replace with "The page's last card leads with what works now (where to talk to AgentX,
    how developers sign in) and lists the optional day-2 commands under 'Later, if you want more'.
    No command is needed to finish; `nextStepsText()` no longer exists (spec 015 phase 15d2
    removed it)." (Q10.)
  - Under Phasing: "Phase 3 built (PR #<n>)."
- [ ] **Step 2: Check the copy** (`grep -c "$(printf '\342\200\224')" specs/040-install-ui/spec.md`
  prints 0), then commit:

```bash
git add specs/040-install-ui/spec.md
git commit -m "docs(spec-040): record the phase 3 rulings and the owner's answers"
```

---

### Task 9: Live check (deferred to the combined final live check) in a throwaway environment (owner present): SC-005

> **Deferred to the combined final live check (owner, 2026-09-30).** No live testing happens until
> spec 025 phases 25d and 25e and spec 040 phases 2 to 4 are all built. This task is not run when
> this phase is built; its steps below are kept as the checklist for that one final check, run in a
> single throwaway environment, with the owner's go-ahead.


This task changes no code unless it finds a defect (fixed with a failing test first, in the task
that owns the code, then reviewed). It is spec 015 US1's independent test, now through the page:
on a clean machine, `agentx init --ui` ends with a message in the bound channel getting an AgentX
reply, with no command typed after `agentx init`. It needs:
- the owner's explicit go-ahead;
- an admin AWS session for account 944937319445 (`aws login --profile agentx-admin`, driven from
  this session);
- **no other throwaway environment in the account** (only one fits: the Elastic IP quota). Confirm
  phase 2's `live40b` is fully torn down;
- a Slack test workspace with one test user, a GitHub test organization or account and a test
  repository the owner names; never production's apps, stacks, secrets or `/agentx/production/*`;
- a browser on the owner's Mac, and an email inbox for the Cognito admin user and the alert
  subscription.

It uses a new environment, `live40c`, in `us-east-1`.

- [ ] **Step 1: Prepare (read-only)**: build a release from this branch
  (`npm run release:build -- --version 0.0.7 --out <scratch>/rel`), read production's image digests
  read-only as 25b did, and confirm nothing exists for `live40c` (SSM path, stacks, tagged EC2
  instances, volumes and Elastic IPs).
- [ ] **Step 2: Owner approval**: what it creates (the stacks, a GitHub App, a Slack app, a Cognito
  admin user, an SNS email subscription, EC2 worker time for the test reply), the cost (about $3 a
  day while it exists, torn down the same day), and the teardown in Step 7.
- [ ] **Step 3: Install through the page, typing nothing in the terminal after the command.**
  `node packages/cli/dist/main.js --env live40c init --ui --release <scratch>/rel --worker-image <digest> --slack-image <digest>`.
  Do the connect screens as phase 2's live check did. Then:
  - Admin user: enter the owner's email; the card says Cognito emailed a temporary password; press
    the Next button, sign in with the temporary password, set a new one; the card turns to "Signed
    in to AgentX as ...".
  - Project: choose the test repository; the project card shows it.
  - Channel: name a new private channel and create it in Slack without the bot; the channel card
    shows the invite wait; type `/invite @<the bot>` there; the card turns to bound by itself.
  - Connectors: say no to all three (a connector's own live check is its spec's).
  - Alerts: the alerts card asks to confirm the subscription; confirm the AWS Notifications email,
    answer Yes; the test alarm arrives; answer Yes.
  - Test reply: press "Open #<channel> in Slack", mention the bot picking it from the mention list;
    the reply card turns to "AgentX replied in #<channel> in N seconds".
  - The ready card shows where to talk to AgentX and the developer sign-in command, with the day-2
    commands under Later.
- [ ] **Step 4: Watch again (FR-051), with the owner's consent to wait up to 10 minutes.** Run
  `node packages/cli/dist/main.js --env live40c init --ui` again after removing the `e2e` step's
  record (`agentx --env live40c` has no command for it; edit `/agentx/live40c/install/progress` to
  drop `steps.e2e`, with the owner's agreement); do not mention the bot; after 10 minutes the card
  says no reply arrived and what to check; answer Yes, mention the bot, and the card resolves.
  Otherwise record that this rests on the contract tests.
- [ ] **Step 5: SC-005's check.** Confirm with the owner that nothing was typed in the terminal after
  the command in Step 3, and record the time from the command to the ready card.
- [ ] **Step 6: No secret leaked (FR-012)**: as phase 2's Step 7, adding the Cognito tokens (the
  local token store is expected to hold them; nothing else may) and the page's saved passwords.
- [ ] **Step 7: Tear down `live40c`** exactly as 25c's Task 18 Step 12, and remove the Cognito user
  with the stacks; confirm nothing tagged or named `live40c` remains.
- [ ] **Step 8: Record the evidence** in the PR description: commands, what each card showed, the
  timings, each defect fixed, any finding that changes a ruling.

## Not in this phase

- **Phase 4:** the page on by default, the closed-tab reminder, packaging and docs.
- **Not planned:** running a day-2 command from the page (Q10's option C); a connector's own screen
  beyond the existing questions and the connectors card (each connector's questions are already on
  the page since phase 1).

## Self-review

- **Spec coverage.** FR-050: Tasks 2 (admin user, sign-in) and 3 (first project, channel bind), in
  the same run, as cards. FR-051: Task 5 (the real reply confirmed; the failure says what to fix and
  the watch can run again). FR-052: Task 6 (and Task 1's `readyCard`), with the finding that
  `nextStepsText()` is already gone, recorded by Task 8. User Story 3: Tasks 7 and 9. SC-003: Task
  7. SC-005: Task 9. SC-004: every task's gate runs the terminal tests unchanged; `addProject` and
  `addChannel` gain optional callbacks only, so no pinned result changes.
- **Placeholder scan.** Every code step shows its code. The facts the tests lean on (`STAGING_SETTINGS`'s Cognito
  mode, `fakeAlerts`'s fields, that the repo has no import-cycle lint rule) were checked when this
  plan was written; one step (Task 5, TypeScript's narrowing inside a closure) says what to do if
  the compiler disagrees.
- **Type consistency.** Every builder in Task 1 returns phase 2's `WizardCard`; the input types
  (`AdminCardInput`, `ChannelCardInput`, `AlertsCardInput`, `ReplyCardInput`) are used unchanged
  by Tasks 2 to 5. `reported` is a `Set<string>` of event ids in both `reply-watch.ts` and the
  e2e step. `onWaiting` takes the channel name, and `onRepository` the repository's full name, in the setup
  modules and in the first-project step alike.
- **Review Focus.** 1 and 3 in Task 5, 2 in Task 3, 4 in Task 4, 5 in Task 2.
- **The owner's answers (2026-09-30).** All thirteen as recommended, so no task changes; the live
  check is deferred to the combined final live check (owner, 2026-09-30).
