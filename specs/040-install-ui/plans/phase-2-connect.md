# Spec 040 Phase 2: The Connect Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agentx init --ui` makes the three connections on the page. It shows which AWS profile,
account and role the install lands in and signs in again when the session has expired. It shows
the prerequisites as a pass/fail list that can be checked again. It creates the GitHub App through
the manifest flow on the wizard's own address and shows the installation wait as a card. It
creates the Slack app from a button, checks its two credentials inline, and shows the Request URL
check as a live card that can run again.

**Architecture:**
- **Status cards.** The wizard state gains `cards` (one per id, replaced in place) and `link` (the
  one address the run is waiting on the operator to open). A card is text only: a title, a status,
  lines, an optional checklist and an optional link. Every card is built by a function in
  `ui/cards.ts` from facts a step already has; no builder takes a secret (FR-012). The page lays
  them out with `textContent` and opens links in a new tab.
- **An `InstallSurface` on the init context.** `context.surface` exists only with `--ui`. Steps
  call `context.surface?.card(...)` next to the lines they already write, so the terminal path is
  unchanged line for line (SC-004). In the page, `context.openBrowser` becomes `openLink`, which
  puts the address on the page as a button (Q5).
- **Check again, on the page only (Q7).** `retryOnPage` runs a check; on failure with a page it
  shows the problem and asks "...again?"; without a page it rethrows at once, exactly as today.
  Prerequisites (FR-023), the Request URL (FR-041), the AWS sign-in (FR-021) and a refused Slack
  token (Q8) use it.
- **GitHub's callback on the wizard's own origin (FR-030, Q6).** The wizard server mounts the
  manifest flow's two routes while the GitHub App step waits: `/github/start` behind every phase 1
  check, and `/github/created`, the one route that accepts GitHub's cross-site redirect, only with
  the flow's `state`, only once. The terminal path keeps its one-time listener.

**Tech Stack:** TypeScript 5.9 strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`),
Node 22.19 to 22.x, `node:http`, Vitest, commander 15. No new dependency.

**Spec:** [../spec.md](../spec.md), the binding authority. Phase 2 delivers the Decisions' phase 2
row: FR-020 to FR-023 (Connect AWS, the prerequisite checklist), FR-030 and FR-031 (Connect
GitHub), FR-040 and FR-041 (Connect Slack), and User Story 2. The spec's "third" connect screen is
Connect AWS. Open decisions are in [questions.md](questions.md); this plan follows every
recommendation, and a task that depends on one says "Depends on Q<n>".

**Phases:** this plan, then [phase-3-finish.md](phase-3-finish.md) (the finishing screens), then
[phase-4-default.md](phase-4-default.md) (on by default, packaging, docs). Each plan is its own PR
(Q13), because each is shippable alone, each ends in its own live check in a throwaway environment,
and phase 3 builds on this phase's cards and surface, which a reviewer should approve first.

**Branch:** `feat/040b-connect`, cut from mainline after this plan is approved (mainline was
`59ff7e3` when it was written; phase 1 merged as PR #146). One PR against `mainline`. No stacked
PRs.

## What phase 1 built, and what this phase changes in it

- `packages/cli/src/init/ui/protocol.ts`: the page and server's types. Gains the card types.
- `packages/cli/src/init/ui/state.ts`: the hub (steps, log, plan, resume, the one question). Gains
  `showCard`, `showLink` and `isShowableLink`.
- `packages/cli/src/init/ui/page.ts`: the HTML, CSS and module as text. Gains the cards area, the
  "Next" link, and the secret field rules of Q4.
- `packages/cli/src/init/ui/server.ts`: the four checks and five routes. Gains the two GitHub routes.
- `packages/cli/src/init/ui/index.ts`: `startInstallWizard`. Gains `surface`, `openLink`,
  `manifestHost`.
- `packages/cli/src/init/commands.ts`: starts the wizard with `--ui`. Gains the AWS profile question,
  `resolveCaller`, the surface wiring and the prerequisite card.
- `tests/support/wizard-browser.ts`: the headless operator. Learns to click the page's links.

## Global Constraints

- **The terminal path does not change.** Without `--ui`, every line `agentx init` writes, every
  question it asks and every error it throws stays exactly as it is. `context.surface` is undefined
  there, and every new branch is behind it. The existing `agentx init` tests pass unchanged
  (SC-004), including `--yes` and every `init-*.test.ts` file.
- **Loopback only (FR-002).** Every listener binds `127.0.0.1` on an ephemeral port. No new port is
  opened by this phase: the GitHub routes live on the wizard's own listener.
- **Every request carries the session token (FR-010) and passes the Host, Sec-Fetch-Site, Origin and
  Referer checks (FR-011)**, with one exception, Q6's: `GET /github/created`, only while a GitHub
  App is awaited, only with the matching `state`, once, and still only with the listener's own
  `Host`. No response carries a CORS header.
- **Secrets (FR-012).** A secret typed on the page goes only to the `Prompter` caller, then
  `cleanSecret`, then Secrets Manager. It is never in a card, a link, a log line, an `InitEvent`, a
  progress note, an error message or a file. Card builders take no secret. Every task that handles
  one plants a known value and asserts it appears nowhere else. In the page, a masked field is
  emptied the moment it is sent and the question area is emptied once answered (Q4).
- **Links.** The page shows only `https://` addresses without userinfo and this machine's
  `http://127.0.0.1:<port>/` addresses (`isShowableLink`). Links open with `target="_blank"` and
  `rel="noopener noreferrer"`. The page never parses markup: no `innerHTML`.
- **No test reaches AWS, GitHub or Slack.** Every client is injected. The only real network use in
  tests is `127.0.0.1`.
- **Exact names and values:**
  - card ids `aws`, `prerequisites`, `github`, `slack`, `slack-urls`; statuses `info`, `running`,
    `waiting`, `ok`, `failed`;
  - routes `GET /github/start` (token required) and `GET /github/created` (Q6's exception);
  - questions, word for word: "AWS profile to install with", "Your AWS sign-in is missing or has
    expired. What next?", "Check the prerequisites again?", "Paste the Slack bot token and signing
    secret again?", "Run the Request URL check again?";
  - the GitHub start page's CSP: `default-src 'none'; script-src 'nonce-<nonce>'; form-action
    https://github.com; base-uri 'none'; frame-ancestors 'none'`.
- **Copy:** plain words; every failure says what to do next; no em dashes in any user-facing text,
  card, question or error.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test`.
  - Use Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
  - Known load flakes (issue #59): rerun that file alone.
- **Existing suites:** no assertion is removed or weakened; never run vitest with `-u`. Where a
  phase 1 test's support code changes (the headless operator learns to click links), the task says
  so; no phase 1 assertion changes.
- **Build process:** the owner approves this plan before building. Building uses
  superpowers:subagent-driven-development, a fresh implementer and a fresh reviewer per task.

## Review Focus

1. **GitHub sends the browser back after the run has stopped waiting** (the 15-minute timeout, or
   the run ended). Expected: `/github/created` is no longer mounted, so it gets the ordinary token
   refusal (401) and resolves nothing; the step has already failed with "no GitHub App was created
   within 15 minutes; run agentx init again". Pinned in Task 5 (`init-ui-github.test.ts`, "a
   callback after the wait ended is refused like any other request").
2. **The operator presses "Create the GitHub App" twice** and two GitHub tabs send the browser back.
   Expected: the first callback resolves the code, the second is refused (401), and GitHub is asked
   for exactly one conversion. Pinned in Task 5 ("takes the first callback only").
3. **A token pasted with a trailing newline or the terminal's bracketed-paste markers.** Expected:
   the masked field accepts it, `checkSlackBotToken` sees the clean value, and nothing is echoed.
   Pinned in Task 6 (`init-ui-prompter.test.ts`, "secret runs the field check on the cleaned value").
4. **`aws sso login` cannot run** (the AWS CLI is not installed, or the login is cancelled).
   Expected: the AWS card shows "could not run aws sso login --profile dev: ..." and the question
   comes back; Stop ends the run with the original credentials error. Pinned in Task 3
   (`init-aws-account.test.ts`, "shows a sign-in that could not run and asks again").
5. **The operator fixes a quota and checks the prerequisites again.** Expected: every check runs
   again, and the new card lists only the new results, not the old failures. Pinned in Task 4
   (`init-prerequisites.test.ts`, "checks everything again, and the card lists only the new
   results").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/cli/src/init/ui/protocol.ts` (modify) | `CardId`, `CardStatus`, `WizardLink`, `WizardCheck`, `WizardCard`; `cards` and `link` on the state | 1 |
| `packages/cli/src/init/ui/state.ts` (modify) | `showCard`, `showLink`, `isShowableLink`; the link cleared on step events | 1 |
| `packages/cli/src/init/ui/page.ts` (modify) | the cards area, the Next link, Q4's secret field rules | 1 |
| `packages/cli/src/init/ui/cards.ts` (create) | every connect card's words; `linkLabel` | 2, 3, 4, 5, 6, 7 |
| `packages/cli/src/init/context.ts` (modify) | `InstallSurface`, `ManifestHost`, `OpenManifestHost`; `surface` and `manifestHost` on the context | 2, 5 |
| `packages/cli/src/init/retry.ts` (create) | `retryOnPage`, `problemText` | 2 |
| `packages/cli/src/init/ui/index.ts` (modify) | `surface`, `openLink`, `manifestHost` on the wizard | 2, 5 |
| `packages/cli/src/init/commands.ts` (modify) | wiring; the AWS profile question; `resolveCaller`; the prerequisite card | 2, 3, 4 |
| `packages/cli/src/init/aws-account.ts` (create) | profiles, the profile question, the caller with sign-in | 3 |
| `packages/cli/src/init/prerequisites.ts` (modify) | `PrerequisiteCheck`, `onCheck` | 4 |
| `packages/cli/src/init/ui/server.ts` (modify) | `mountManifest`, the two GitHub routes | 5 |
| `packages/cli/src/init/github-app.ts` (modify) | the manifest host seam, the nonce, the GitHub cards | 5 |
| `packages/cli/src/init/prompts.ts` (modify) | `validate` on `secret`, `fieldCheck`, `secretFromSource`'s `validate` | 6 |
| `packages/cli/src/init/ui/prompter.ts` (modify) | the secret field runs `validate` | 6 |
| `packages/cli/src/init/slack-app.ts` (modify) | Slack cards, inline checks, paste again; the Request URL card; `onWaiting` | 6, 7 |
| `tests/support/wizard-browser.ts` (modify) | the operator clicks the page's links and plays GitHub for either listener | 2, 5 |
| `tests/contract/init-ui-cards.test.ts` (create) | Task 1 | 1 |
| `tests/contract/init-retry.test.ts` (create) | Task 2 | 2 |
| `tests/contract/init-aws-account.test.ts` (create) | Task 3 | 3 |
| `tests/contract/init-ui-github.test.ts` (create) | Task 5 | 5 |
| `tests/contract/init-prerequisites.test.ts`, `init-ui-prompter.test.ts`, `init-slack-app.test.ts`, `init-ui-cli.test.ts` (modify: new tests appended) | Tasks 4, 6, 7, 8 | 4, 6, 7, 8 |
| `specs/040-install-ui/spec.md` (modify) | record the rulings and answers | 9 |

---

### Task 1: Status cards and links on the page

**Files:**
- Modify: `packages/cli/src/init/ui/protocol.ts`, `packages/cli/src/init/ui/state.ts`, `packages/cli/src/init/ui/page.ts`
- Test: `tests/contract/init-ui-cards.test.ts` (create)

Depends on Q4.

**Interfaces:**
- Consumes: phase 1's `createWizardHub`, `WIZARD_JS`, `wizardHtml`.
- Produces: `WizardCard`, `WizardLink`, `WizardCheck`, `CardId`, `CardStatus` (protocol);
  `WizardHub.showCard(card: WizardCard): void`, `WizardHub.showLink(link: WizardLink): void`,
  `isShowableLink(url: string): boolean` (state); `WizardState.cards?: WizardCard[]`,
  `WizardState.link?: WizardLink`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-cards.test.ts
// Spec 040 phase 2: the status cards and the one "open this" link the page shows beside the
// question, and the rules that keep a link, or a secret, from reaching the page by accident.
import { describe, expect, it } from "vitest";
import { WIZARD_JS, wizardHtml } from "../../packages/cli/src/init/ui/page.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { createWizardHub, isShowableLink, LINK_REFUSED } from "../../packages/cli/src/init/ui/state.js";

const card = (overrides: Partial<WizardCard> = {}): WizardCard => ({ id: "github", title: "GitHub App", status: "waiting", lines: ["one"], ...overrides });

describe("status cards", () => {
  it("shows a card, replaces it in place by id, and keeps the order cards first appeared in", () => {
    const hub = createWizardHub("staging");
    expect(hub.state().cards).toBeUndefined();
    hub.showCard(card({ id: "aws", title: "AWS account", status: "ok" }));
    hub.showCard(card());
    hub.showCard(card({ id: "aws", title: "AWS account", status: "failed", lines: ["two"] }));
    expect(hub.state().cards?.map((shown) => [shown.id, shown.status, shown.lines])).toEqual([["aws", "failed", ["two"]], ["github", "waiting", ["one"]]]);
  });

  it("gives a page that connects late every card in its snapshot", () => {
    const hub = createWizardHub("staging");
    hub.showCard(card({ checks: [{ label: "EC2 vCPU quota", ok: false, detail: "must be at least 1" }] }));
    expect(hub.snapshot().cards).toEqual([card({ checks: [{ label: "EC2 vCPU quota", ok: false, detail: "must be at least 1" }] })]);
  });

  it("pushes each card to every listener as it changes", () => {
    const hub = createWizardHub("staging");
    const seen: number[] = [];
    hub.subscribe({ state: (state) => { seen.push(state.cards?.length ?? 0); }, log: () => undefined, closed: () => undefined });
    hub.showCard(card({ id: "aws" }));
    hub.showCard(card());
    expect(seen).toEqual([1, 2]);
  });
});

describe("links", () => {
  it("shows only https addresses without a user name, and this machine's 127.0.0.1 addresses", () => {
    for (const url of ["https://github.com/apps/agentx-acme-staging/installations/new", "http://127.0.0.1:51234/github/start?t=abc"]) expect(isShowableLink(url)).toBe(true);
    for (const url of ["http://github.com/", "javascript:alert(1)", "data:text/html,x", "https://user:pw@github.com/", "http://localhost:51234/", "http://127.0.0.1.evil.test/", "", "not an address"]) {
      expect(isShowableLink(url)).toBe(false);
    }
  });

  it("drops a card's link it cannot check, and never shows a run link it cannot check", () => {
    const hub = createWizardHub("staging");
    hub.showCard(card({ link: { url: "javascript:alert(1)", label: "Create" } }));
    expect(hub.state().cards?.[0]).not.toHaveProperty("link");
    hub.showLink({ url: "http://example.com/", label: "Open example.com" });
    expect(hub.state().link).toBeUndefined();
    // The refusal is logged without the address, which could be anything.
    expect(hub.snapshot().log).toEqual([LINK_REFUSED, LINK_REFUSED]);
  });

  it("clears the run's link when its step ends, or when the next one starts", () => {
    const hub = createWizardHub("staging");
    hub.setSteps([{ id: "github-app", title: "Create and install the GitHub App" }, { id: "control-plane", title: "Deploy the control plane and runtime" }]);
    hub.showLink({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com" });
    expect(hub.state().link).toEqual({ url: "https://github.com/apps/agentx-acme-staging/installations/new", label: "Open github.com" });
    hub.applyEvent({ kind: "step-done", id: "github-app", title: "Create and install the GitHub App" });
    expect(hub.state().link).toBeUndefined();
    hub.showLink({ url: "https://api.slack.com/apps", label: "Open api.slack.com" });
    hub.applyEvent({ kind: "step-started", id: "control-plane", title: "Deploy the control plane and runtime" });
    expect(hub.state().link).toBeUndefined();
  });
});

describe("the page", () => {
  it("has a place for the cards and for the Next link, and still no inline script", () => {
    const html = wizardHtml("t");
    expect(html).toContain('<div id="cards"></div>');
    expect(html).toContain('<section id="next" class="card hidden">');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  it("builds cards and links from text only, and opens links in a new tab without a referrer", () => {
    expect(WIZARD_JS).not.toContain("innerHTML");
    expect(WIZARD_JS).not.toContain("insertAdjacentHTML");
    expect(WIZARD_JS).not.toContain("document.write");
    expect(WIZARD_JS).toContain('anchor.target = "_blank";');
    expect(WIZARD_JS).toContain('anchor.rel = "noopener noreferrer";');
    expect(WIZARD_JS).toContain("renderCards(state.cards, state.link);");
  });

  it("Q4: empties a masked field the moment it is sent, empties the question area once answered, and asks password managers to leave it alone", () => {
    expect(WIZARD_JS).toContain('if (question.masked) field.value = "";');
    expect(WIZARD_JS).toContain('byId("question-body").replaceChildren();');
    expect(WIZARD_JS).toContain('field.setAttribute("data-1p-ignore", "");');
    expect(WIZARD_JS).toContain('field.setAttribute("data-lpignore", "true");');
    // Enter sends through the same reader as the button, so it empties the field too.
    expect(WIZARD_JS).toContain("submit(question.id, read());");
    expect(WIZARD_JS).not.toContain("submit(question.id, field.value)");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts`
Expected: FAIL (`isShowableLink` and `LINK_REFUSED` are not exported; `showCard` is not a function).

- [ ] **Step 3: Add the card types to the protocol**

Append to `packages/cli/src/init/ui/protocol.ts`, after `WizardResume`:

```ts
/** A status card's id: one card per id, and a newer card with the same id replaces it in place.
 * Phase 3 appends the finishing screens' ids. */
export type CardId = "aws" | "prerequisites" | "github" | "slack" | "slack-urls";

export type CardStatus = "info" | "running" | "waiting" | "ok" | "failed";

/** An address the operator opens from the page, in a new tab. Only an `https://` address or this
 * machine's `http://127.0.0.1:<port>/` is ever shown (state.ts's isShowableLink). */
export interface WizardLink { url: string; label: string }

/** One line of a checklist card, such as one prerequisite. */
export interface WizardCheck { label: string; ok: boolean; detail: string }

/** What one part of the install looks like right now. Text only, built by ui/cards.ts from facts a
 * step already has. No card builder takes a secret, so no card can carry one (FR-012). */
export interface WizardCard {
  id: CardId;
  title: string;
  status: CardStatus;
  lines: string[];
  checks?: WizardCheck[];
  link?: WizardLink;
}
```

And add two fields to `WizardState`, after `resume?`:

```ts
  /** The connect and finishing screens' cards, in the order each first appeared. */
  cards?: WizardCard[];
  /** The one address the run is waiting on the operator to open, when no card offers it. */
  link?: WizardLink;
```

- [ ] **Step 4: Teach the hub cards and links**

In `packages/cli/src/init/ui/state.ts`, import the new types:

```ts
import type { WizardCard, WizardLink, WizardPhase, WizardQuestion, WizardResume, WizardSnapshot, WizardState, WizardStep } from "./protocol.js";
```

Add, above `createWizardHub`:

```ts
/** Logged, without the address, when a link fails isShowableLink. */
export const LINK_REFUSED = "the installer left out a link it could not check (only https:// addresses are shown)";

const LOOPBACK_LINK = /^http:\/\/127\.0\.0\.1:\d{1,5}\//;

/** True for an address the page may offer as a link: this machine's 127.0.0.1 listener, or an
 * https:// address with a host and no user name or password in it. */
export function isShowableLink(url: string): boolean {
  if (LOOPBACK_LINK.test(url)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname !== "" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

/** The card without its link. */
function withoutLink(card: WizardCard): WizardCard {
  return { id: card.id, title: card.title, status: card.status, lines: card.lines, ...(card.checks === undefined ? {} : { checks: card.checks }) };
}
```

Add to the `WizardHub` interface, after `showResume`:

```ts
  /** Shows a card, or replaces the one with the same id where it stands. */
  showCard(card: WizardCard): void;
  /** The address the run now waits on the operator to open. Cleared when a step starts or ends. */
  showLink(link: WizardLink): void;
```

In `createWizardHub`, add beside the other `let`s:

```ts
  let cards: WizardCard[] = [];
  let link: WizardLink | undefined;
```

In `state`, after the `resume` line:

```ts
    ...(cards.length === 0 ? {} : { cards }),
    ...(link === undefined ? {} : { link }),
```

Name the `log` method's body so `showCard` and `showLink` can call it, by turning the returned
object's `log(line) {...}` into a call of a local function declared above the `return`:

```ts
  const appendLog = (line: string) => {
    log.push(line);
    if (log.length > LOG_BACKLOG * 2) log.splice(0, log.length - LOG_BACKLOG);
    for (const listener of listeners) listener.log(line);
  };
```

and in the returned object `log: appendLog,`. Then change `applyEvent` so every step event clears
the link first:

```ts
    applyEvent(event) {
      // The link belonged to the step that just started or ended.
      link = undefined;
      switch (event.kind) {
        case "step-skipped": return changeStep(event.id, event.title, { status: "skipped" });
        case "step-started": return changeStep(event.id, event.title, { status: "running" });
        case "step-done": return changeStep(event.id, event.title, { status: "done" });
        case "step-waiting": return changeStep(event.id, event.title, { status: "waiting", message: event.message });
      }
    },
```

and add, after `showResume`:

```ts
    showCard(next) {
      let shown = next;
      if (next.link !== undefined && !isShowableLink(next.link.url)) {
        appendLog(LINK_REFUSED);
        shown = withoutLink(next);
      }
      cards = cards.some((existing) => existing.id === shown.id)
        ? cards.map((existing) => (existing.id === shown.id ? shown : existing))
        : [...cards, shown];
      publish();
    },
    showLink(next) {
      if (!isShowableLink(next.url)) {
        appendLog(LINK_REFUSED);
        return;
      }
      link = next;
      publish();
    },
```

- [ ] **Step 5: Lay the cards out on the page, and apply Q4 to secret fields**

In `packages/cli/src/init/ui/page.ts`, in `wizardHtml`, add two elements between the `plan` section
and the `question` section:

```html
  <section id="next" class="card hidden"><h2>Next</h2><div id="next-link"></div></section>
  <div id="cards"></div>
```

Append to `WIZARD_CSS` (inside the template string, before its closing backtick):

```css
a.button { border: 1px solid rgba(128,128,128,.5); border-radius: .35rem; display: inline-block; font: inherit; margin-top: .5rem; padding: .45rem 1rem; text-decoration: none; }
a.button.primary { background: #1a56db; border-color: #1a56db; color: #fff; }
.card.status p { margin: 0 0 .35rem; }
.card.status.ok { border-color: #2e7d32; }
.card.status.waiting { border-color: #b06000; }
.card.status.failed { border-color: #c62828; }
ul.checks { list-style: none; margin: .5rem 0 0; padding: 0; }
ul.checks li { display: flex; gap: .6rem; padding: .15rem 0; }
ul.checks li.ok .mark { color: #2e7d32; }
ul.checks li.failed .mark { color: #c62828; }
```

In `WIZARD_JS`, add these two functions after `renderResume` (plain browser JavaScript inside the
template string: no `${` anywhere in it, so nothing is interpolated):

```js
function linkButton(link) {
  const anchor = document.createElement("a");
  anchor.className = "button primary";
  anchor.href = link.url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.textContent = link.label;
  return anchor;
}

function renderCards(cards, link) {
  const holder = byId("cards");
  holder.replaceChildren();
  const offered = new Set();
  for (const card of cards ?? []) {
    const section = document.createElement("section");
    section.className = "card status " + card.status;
    const title = document.createElement("h2");
    title.textContent = card.title;
    section.append(title);
    for (const line of card.lines) {
      const paragraph = document.createElement("p");
      paragraph.textContent = line;
      section.append(paragraph);
    }
    if (card.checks) {
      const list = document.createElement("ul");
      list.className = "checks";
      for (const check of card.checks) {
        const item = document.createElement("li");
        item.className = check.ok ? "ok" : "failed";
        const mark = document.createElement("span");
        mark.className = "mark";
        mark.textContent = check.ok ? "\\u2713" : "\\u2717";
        const text = document.createElement("span");
        text.textContent = check.label + ": " + check.detail;
        item.append(mark, text);
        list.append(item);
      }
      section.append(list);
    }
    if (card.link) {
      section.append(linkButton(card.link));
      offered.add(card.link.url);
    }
    holder.append(section);
  }
  // The run's own "open this" address, unless a card already offers the same one.
  const next = link && !offered.has(link.url) ? link : null;
  show("next", Boolean(next));
  const slot = byId("next-link");
  slot.replaceChildren();
  if (next) slot.append(linkButton(next));
}
```

In `buildQuestion`, replace the text-field branch (from `const field = ...` to
`queueMicrotask(() => field.focus());`) with:

```js
    const field = question.multiline ? document.createElement("textarea") : document.createElement("input");
    if (!question.multiline) field.type = question.masked ? "password" : "text";
    field.autocomplete = question.masked ? "off" : "on";
    if (question.masked) {
      field.spellcheck = false;
      // Q4: ask password managers neither to fill nor to save a secret.
      field.setAttribute("data-1p-ignore", "");
      field.setAttribute("data-lpignore", "true");
      field.setAttribute("data-bwignore", "");
    }
    if (question.defaultValue !== undefined && !question.masked) field.placeholder = question.defaultValue;
    body.append(field);
    if (question.defaultValue !== undefined && !question.masked) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = "Leave empty for " + question.defaultValue;
      body.append(hint);
    }
    read = () => {
      const value = field.value;
      // Q4: a secret leaves the field the moment it is sent; a refused one is pasted again.
      if (question.masked) field.value = "";
      return value;
    };
    if (!question.multiline) {
      field.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); submit(question.id, read()); } });
    }
    queueMicrotask(() => field.focus());
```

In `render`, call the cards renderer after `renderResume(state.resume);`:

```js
  renderCards(state.cards, state.link);
```

and in its no-question branch, empty the question area so an answered secret does not stay in the
page, even hidden:

```js
  if (!state.question) {
    renderedQuestion = null;
    sending = false;
    byId("question-body").replaceChildren();
    show("question", false);
    return;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-cards.test.ts tests/contract/init-ui-server.test.ts tests/contract/init-ui-prompter.test.ts tests/contract/init-ui-cli.test.ts`
Expected: PASS, every phase 1 test included.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/init/ui/protocol.ts packages/cli/src/init/ui/state.ts packages/cli/src/init/ui/page.ts tests/contract/init-ui-cards.test.ts
git commit -m "feat(init-ui): status cards and a Next link on the install page; secrets leave the page once sent"
```

---

### Task 2: The install surface: cards from steps, links as buttons, and check again

**Files:**
- Create: `packages/cli/src/init/ui/cards.ts`, `packages/cli/src/init/retry.ts`
- Modify: `packages/cli/src/init/context.ts`, `packages/cli/src/init/ui/index.ts`, `packages/cli/src/init/commands.ts`, `tests/support/wizard-browser.ts`
- Test: `tests/contract/init-retry.test.ts` (create), `tests/contract/init-ui-cli.test.ts` (append)

Depends on Q5 and Q7.

**Interfaces:**
- Consumes: Task 1's `showCard`, `showLink`.
- Produces:
  - `interface InstallSurface { card(card: WizardCard): void }` and `InitContext.surface?: InstallSurface` (context.ts);
  - `InstallWizard.surface: InstallSurface`, `InstallWizard.openLink: (url: string) => Promise<boolean>` (index.ts);
  - `linkLabel(url: string): string` (cards.ts);
  - `problemText(error: unknown): string` and
    `retryOnPage<T>(input: { surface: InstallSurface | undefined; prompter: Prompter; question: string; run: () => Promise<T>; failed: (problem: string) => void }): Promise<T>` (retry.ts);
  - `WizardOperator.clicked: string[]` (test support).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-retry.test.ts
// Q7: a check that fails on the page asks to be run again; without a page it fails exactly as it
// always has, asking nothing.
import { describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { problemText, retryOnPage } from "../../packages/cli/src/init/retry.js";
import { scriptedPrompter } from "../support/init-fakes.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";

const surface = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };

describe("retryOnPage", () => {
  it("without a page, rethrows the first failure and asks nothing", async () => {
    const prompter = scriptedPrompter([]);
    const failure = agentXError("CONFIG_INVALID", "the quota is 0");
    let runs = 0;
    const problems: string[] = [];
    await expect(retryOnPage({ surface: undefined, prompter, question: "Check again?", failed: (problem) => { problems.push(problem); }, run: async () => { runs += 1; throw failure; } }))
      .rejects.toBe(failure);
    expect(runs).toBe(1);
    expect(prompter.asked).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("on the page, shows the problem without its code, asks, and runs again on yes", async () => {
    const prompter = scriptedPrompter([true]);
    const problems: string[] = [];
    let runs = 0;
    const result = await retryOnPage({
      surface: surface(), prompter, question: "Check the prerequisites again?", failed: (problem) => { problems.push(problem); },
      run: async () => { runs += 1; if (runs === 1) throw agentXError("CONFIG_INVALID", "the quota is 0; request an increase"); return "passed"; },
    });
    expect(result).toBe("passed");
    expect(problems).toEqual(["the quota is 0; request an increase"]);
    expect(prompter.asked).toEqual(["Check the prerequisites again?"]);
  });

  it("on the page, rethrows the original failure when the operator says no", async () => {
    const failure = agentXError("CONFIG_INVALID", "the quota is 0");
    await expect(retryOnPage({ surface: surface(), prompter: scriptedPrompter([false]), question: "Check again?", failed: () => undefined, run: async () => { throw failure; } }))
      .rejects.toBe(failure);
  });

  it("names an expired AWS session the way the rest of the CLI does", () => {
    const expired = Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
    expect(problemText(expired)).toBe("AWS credentials missing or expired: The security token included in the request is expired");
    expect(problemText("plain")).toBe("plain");
  });
});
```

Append to `tests/contract/init-ui-cli.test.ts`, inside `describe("agentx init --ui", ...)`:

```ts
  it("Q5: every other site is a button on the page, and the installer opens only the page itself", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.opened).toHaveLength(1);
    expect(operator.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(operator.clicked).toContain("https://github.com/apps/agentx-acme-staging/installations/new");
    expect(operator.clicked).toContain("https://api.slack.com/apps/A0APP/event-subscriptions");
    expect(operator.clicked.some((url) => /^http:\/\/127\.0\.0\.1:\d+\/github\/start/.test(url))).toBe(true);
  });

  it("the terminal path still opens every site in the system browser", async () => {
    const h = await harness();
    const opened: string[] = [];
    expect(await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]), openBrowser: browserThatCreatesGitHubApp(opened) })).toBe(0);
    expect(opened).toContain("https://github.com/apps/agentx-acme-staging/installations/new");
    expect(opened).toContain("https://api.slack.com/apps/A0APP/event-subscriptions");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-retry.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL (`retry.js` does not exist; `operator.clicked` is undefined).

- [ ] **Step 3: Write `retry.ts`**

```ts
// packages/cli/src/init/retry.ts
// Q7 (FR-023, FR-041, FR-051): a check that fails while someone watches the install page asks to
// be run again, and runs again on yes. Without a page (the terminal path, --yes) it fails exactly
// as it always has, asking nothing, so the terminal's questions and errors stay as they are.
import { cliErrorFor } from "../deploy/commands.js";
import type { InstallSurface } from "./context.js";
import type { Prompter } from "./prompts.js";

/** The error's own words for a card: mapped as the rest of the CLI maps it (an expired AWS
 * session reads as one), without the "CODE: " prefix. */
export function problemText(error: unknown): string {
  const mapped = cliErrorFor(error);
  const message = mapped instanceof Error ? mapped.message : String(mapped);
  return message.replace(/^[A-Z_]+: /, "");
}

export async function retryOnPage<T>(input: {
  surface: InstallSurface | undefined;
  prompter: Prompter;
  /** Asked after a failure, for example "Check the prerequisites again?". Yes is the default. */
  question: string;
  run: () => Promise<T>;
  /** Shows the failure on the page (a card) before the question. */
  failed: (problem: string) => void;
}): Promise<T> {
  for (;;) {
    try {
      return await input.run();
    } catch (error) {
      if (input.surface === undefined) throw error;
      input.failed(problemText(error));
      if (!(await input.prompter.confirm(input.question, { defaultValue: true }))) throw error;
    }
  }
}
```

- [ ] **Step 4: Add the surface to the context**

In `packages/cli/src/init/context.ts`, add the import and the interface above `InitContext`:

```ts
import type { WizardCard } from "./ui/protocol.js";

/** The install page, with --ui only. Steps show what they are doing on it, next to the lines they
 * already write; with no page, every step behaves exactly as before. */
export interface InstallSurface { card(card: WizardCard): void }
```

and the field, after `openBrowser?`:

```ts
  /** With --ui only: the page's cards. Undefined on the terminal path, and every use is `?.`. */
  surface?: InstallSurface;
```

- [ ] **Step 5: Start `cards.ts` with the link label**

```ts
// packages/cli/src/init/ui/cards.ts
// What each screen of the install page says (spec 040 FR-020 to FR-041, and phase 3's finishing
// screens). Every card is built here, from facts a step already has, so the page's words are
// tested in one place and the page only lays text out. No builder takes a secret, so no card can
// carry one (FR-012).
import type { WizardCard } from "./protocol.js";

/** A button's label for an address the run opens: "Open github.com". */
export function linkLabel(url: string): string {
  try {
    return `Open ${new URL(url).host}`;
  } catch {
    return "Open the address";
  }
}

// Unused until Task 3 adds the first card builder; keeps the import honest for lint.
export type { WizardCard };
```

(Task 3 removes the re-export line when it adds `awsCard`, which uses `WizardCard`.)

- [ ] **Step 6: Give the wizard a surface and a page-button browser**

In `packages/cli/src/init/ui/index.ts`, import them:

```ts
import type { InstallSurface } from "../context.js";
import { linkLabel } from "./cards.js";
```

add to `InstallWizard`, after `prompter`:

```ts
  /** The page's cards, for the init context (context.surface). */
  surface: InstallSurface;
  /** Q5: the init context's openBrowser with --ui. The address becomes a button on the page, and
   * the operator opens it; nothing is opened on its own. Always true: the page shows it. */
  openLink: (url: string) => Promise<boolean>;
```

and to the returned object, after `prompter: browserPrompter(hub),`:

```ts
    surface: { card: (card) => hub.showCard(card) },
    openLink: async (url) => {
      hub.showLink({ url, label: linkLabel(url) });
      return true;
    },
```

- [ ] **Step 7: Wire them into `init`**

In `packages/cli/src/init/commands.ts`, right after `const activePrompter = prompter;`, add:

```ts
  // With --ui, the page's cards; the terminal path has none (SC-004).
  const surface = session.wizard?.surface;
  // Q5: with --ui, every other site is a button on the page. The terminal path opens the system
  // browser, or prints the address with --no-browser, as before.
  const stepBrowser = session.wizard?.openLink
    ?? (options.browser ? neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) : undefined);
```

In `adminSession`, replace
`...(options.browser ? { openBrowser: neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) } : {}),`
with

```ts
      ...(stepBrowser === undefined ? {} : { openBrowser: stepBrowser }),
```

and in `context`, replace the same `...(options.browser ? {...} : {})` line with

```ts
    ...(stepBrowser === undefined ? {} : { openBrowser: stepBrowser }),
    ...(surface === undefined ? {} : { surface }),
```

(`adminSession` is declared after `activePrompter`, so `stepBrowser` is in scope for both.)

- [ ] **Step 8: Teach the headless operator to click the page's links**

In `tests/support/wizard-browser.ts`, add `clicked` to `WizardOperator`:

```ts
  /** Every link the page offered, in the order the operator clicked it (Q5). */
  clicked: string[];
```

Replace `open`'s GitHub branch with a shared `visit`, declared inside `fakeWizardOperator` above
`drive`:

```ts
  const clicked: string[] = [];
  /** What a person's browser does with a link the page offers: GitHub's form page is played back
   * as GitHub (a redirect to the callback with a code and the page's state); anything else is
   * only recorded. Works for the terminal path's one-time listener and for the wizard's own
   * /github/start (Task 5), whose address carries the session token. */
  const visit = async (url: string): Promise<void> => {
    if (!/^http:\/\/127\.0\.0\.1:\d+\/github\/start/.test(url)) return;
    const page = await (await fetch(url)).text();
    const state = /[?&]state=([a-f0-9]+)/.exec(page)?.[1];
    const callback = new URL("/github/created", new URL(url).origin);
    callback.searchParams.set("code", options.githubCode ?? "0123456789abcdef0123");
    callback.searchParams.set("state", state ?? "missing");
    // GitHub's redirect is a cross-site top-level visit with no session token.
    await fetch(callback, { headers: { "sec-fetch-site": "cross-site", referer: "https://github.com/" } });
  };
```

At the top of `onState`, before the question handling, click every link not clicked yet:

```ts
      for (const link of [state.link, ...(state.cards ?? []).map((card) => card.link)]) {
        if (link === undefined || clicked.includes(link.url)) continue;
        clicked.push(link.url);
        await visit(link.url);
      }
```

In `open`, replace the `/github/start` branch with `if (url.includes("/github/start")) { await visit(url); return true; }`,
and return `clicked` from the factory next to `opened`.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-retry.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS. `init-cli.test.ts` (the terminal path) passes unchanged.

- [ ] **Step 10: Commit**

```bash
git add packages/cli/src/init/retry.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/context.ts packages/cli/src/init/ui/index.ts packages/cli/src/init/commands.ts tests/support/wizard-browser.ts tests/contract/init-retry.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): an install surface for steps, links as page buttons, and check again on the page"
```

---

### Task 3: Connect AWS: the profile, the account, and signing in again

**Files:**
- Create: `packages/cli/src/init/aws-account.ts`
- Modify: `packages/cli/src/init/ui/cards.ts`, `packages/cli/src/init/commands.ts`
- Test: `tests/contract/init-aws-account.test.ts` (create), `tests/contract/init-ui-cli.test.ts` (append)

Depends on Q7 and Q9.

**Interfaces:**
- Consumes: Task 2's `InstallSurface`, `problemText`; `CallerIdentity` (`environments/adopt.ts`);
  `CommandRunner` (`deploy/cdk-engine.ts`); `cliErrorFor`.
- Produces:
  - `type AwsProfileKind = "sso" | "login" | "keys" | "other"`, `interface AwsProfile { name: string; kind: AwsProfileKind; region?: string }`;
  - `parseAwsIni(text: string): Map<string, Map<string, string>>`;
  - `listAwsProfiles(input: { home: string; processEnv: NodeJS.ProcessEnv; readFile?: (path: string) => Promise<string> }): Promise<AwsProfile[]>`;
  - `pickAwsProfile(input: { profiles: AwsProfile[]; processEnv: NodeJS.ProcessEnv; prompter: Prompter }): Promise<AwsProfile | undefined>`;
  - `signInCommand(profile: AwsProfile): { command: "aws"; args: string[]; display: string } | undefined`;
  - `resolveCaller(input: { identity: () => CallerIdentity; region: string; prompter: Prompter; runner: CommandRunner; surface?: InstallSurface; profile?: AwsProfile }): Promise<{ account: string; arn: string }>`;
  - `awsCard(...)`, `awsSignedOutCard(...)` (cards.ts).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-aws-account.test.ts
// FR-020 and FR-021 (Q9): the AWS screen lists this machine's profiles, shows the account the
// install lands in, and signs in again when the session has expired, instead of ending the run.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAwsProfiles, parseAwsIni, pickAwsProfile, resolveCaller, signInCommand, type AwsProfile } from "../../packages/cli/src/init/aws-account.js";
import type { CommandRunner } from "../../packages/cli/src/deploy/cdk-engine.js";
import type { WizardCard } from "../../packages/cli/src/init/ui/protocol.js";
import { HOLDER, scriptedPrompter } from "../support/init-fakes.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const home = async () => { const dir = await mkdtemp(join(tmpdir(), "agentx-aws-home-")); dirs.push(dir); await mkdir(join(dir, ".aws")); return dir; };
const expired = () => Object.assign(new Error("The security token included in the request is expired"), { name: "ExpiredTokenException" });
const surface = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };
function runner(fail?: Error): CommandRunner & { runs: string[] } {
  const runs: string[] = [];
  return { runs, async run(command, args) { runs.push([command, ...args].join(" ")); if (fail !== undefined) throw fail; return { stdout: "" }; } };
}
const DEV: AwsProfile = { name: "dev", kind: "sso" };

describe("the AWS profiles on this machine", () => {
  it("lists every profile in config and credentials, default first, with how each signs in, and never a key", async () => {
    const dir = await home();
    await writeFile(join(dir, ".aws", "config"), [
      "[default]", "region = us-west-2", "",
      "[profile agentx-admin]", "login_session = arn:aws:iam::944937319445:user/owner", "region = us-east-1", "",
      "[profile dev]", "sso_session = acme", "sso_account_id = 111111111111", "sso_role_name = Admin", "",
      "[sso-session acme]", "sso_start_url = https://acme.awsapps.com/start", "",
      "[profile ci]", "role_arn = arn:aws:iam::222222222222:role/ci", "source_profile = default", "",
    ].join("\n"));
    await writeFile(join(dir, ".aws", "credentials"), [
      "[default]", "aws_access_key_id = AKIAEXAMPLEKEY", "aws_secret_access_key = SECRETexampleVALUE", "",
      "[legacy]", "aws_access_key_id = AKIAOTHERKEY", "aws_secret_access_key = SECRETotherVALUE",
    ].join("\n"));
    const profiles = await listAwsProfiles({ home: dir, processEnv: {} });
    expect(profiles).toEqual([
      { name: "default", kind: "keys", region: "us-west-2" },
      { name: "agentx-admin", kind: "login", region: "us-east-1" },
      { name: "ci", kind: "other" },
      { name: "dev", kind: "sso" },
      { name: "legacy", kind: "keys" },
    ]);
    const listed = JSON.stringify(profiles);
    for (const secret of ["AKIAEXAMPLEKEY", "SECRETexampleVALUE", "AKIAOTHERKEY", "SECRETotherVALUE"]) expect(listed).not.toContain(secret);
  });

  it("reads AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE when they are set, and finds nothing where there are no files", async () => {
    const dir = await home();
    await writeFile(join(dir, "elsewhere"), "[profile dev]\nsso_session = acme\n");
    expect(await listAwsProfiles({ home: dir, processEnv: { AWS_CONFIG_FILE: join(dir, "elsewhere"), AWS_SHARED_CREDENTIALS_FILE: join(dir, "none") } })).toEqual([DEV]);
    expect(await listAwsProfiles({ home: join(dir, "missing"), processEnv: {} })).toEqual([]);
  });

  it("reads sections and keys, ignoring comments and blank lines", () => {
    expect(parseAwsIni("# note\n[profile a]\n Region = eu-west-1 \n; other\n\n[b]\nx=1")).toEqual(new Map([
      ["profile a", new Map([["region", "eu-west-1"]])],
      ["b", new Map([["x", "1"]])],
    ]));
  });

  it("signs in to an IAM Identity Center profile with aws sso login, and an aws login profile with aws login", () => {
    expect(signInCommand(DEV)).toEqual({ command: "aws", args: ["sso", "login", "--profile", "dev"], display: "aws sso login --profile dev" });
    expect(signInCommand({ name: "agentx-admin", kind: "login" })).toEqual({ command: "aws", args: ["login", "--profile", "agentx-admin"], display: "aws login --profile agentx-admin" });
    expect(signInCommand({ name: "ci", kind: "other" })).toBeUndefined();
    expect(signInCommand({ name: "legacy", kind: "keys" })).toBeUndefined();
  });
});

describe("choosing the profile", () => {
  it("asks which of two or more, defaulting to AWS_PROFILE, and puts the answer in AWS_PROFILE", async () => {
    const processEnv: NodeJS.ProcessEnv = { AWS_PROFILE: "dev" };
    const prompter = scriptedPrompter([""]);
    const picked = await pickAwsProfile({ profiles: [{ name: "default", kind: "keys" }, DEV], processEnv, prompter });
    expect(picked).toEqual(DEV);
    expect(prompter.asked).toEqual(["AWS profile to install with"]);
    expect(processEnv.AWS_PROFILE).toBe("dev");
  });

  it("uses the only profile without asking", async () => {
    const processEnv: NodeJS.ProcessEnv = {};
    const prompter = scriptedPrompter([]);
    expect(await pickAwsProfile({ profiles: [DEV], processEnv, prompter })).toEqual(DEV);
    expect(processEnv.AWS_PROFILE).toBe("dev");
  });

  it("asks nothing when keys are in the environment, which win over any profile", async () => {
    const processEnv: NodeJS.ProcessEnv = { AWS_ACCESS_KEY_ID: "AKIAENV" };
    expect(await pickAwsProfile({ profiles: [DEV, { name: "default", kind: "keys" }], processEnv, prompter: scriptedPrompter([]) })).toBeUndefined();
    expect(processEnv.AWS_PROFILE).toBeUndefined();
  });
});

describe("the account the install lands in", () => {
  it("shows the account, the role and the profile once AWS answers", async () => {
    const page = surface();
    const caller = await resolveCaller({ identity: () => ({ get: async () => ({ account: "123456789012", arn: HOLDER }) }), region: "us-east-1", prompter: scriptedPrompter([]), runner: runner(), surface: page, profile: DEV });
    expect(caller).toEqual({ account: "123456789012", arn: HOLDER });
    expect(page.cards).toEqual([{
      id: "aws", title: "AWS account", status: "ok",
      lines: [
        "AgentX installs into account 123456789012 in us-east-1.",
        `Signed in as ${HOLDER} (profile dev).`,
        "AgentX recommends a dedicated AWS account for each install: environments that share an account are not a security boundary against each other.",
      ],
    }]);
  });

  it("without a page, an expired session fails exactly as before and runs nothing", async () => {
    const failure = expired();
    const commands = runner();
    await expect(resolveCaller({ identity: () => ({ get: async () => { throw failure; } }), region: "us-east-1", prompter: scriptedPrompter([]), runner: commands, profile: DEV })).rejects.toBe(failure);
    expect(commands.runs).toEqual([]);
  });

  it("on the page, offers the profile's sign-in, runs it, and asks AWS again with a new client", async () => {
    const page = surface();
    const commands = runner();
    let clients = 0;
    const caller = await resolveCaller({
      identity: () => { clients += 1; const mine = clients; return { get: async () => { if (mine === 1) throw expired(); return { account: "123456789012", arn: HOLDER }; } }; },
      region: "us-east-1", prompter: scriptedPrompter(["signin"]), runner: commands, surface: page, profile: DEV,
    });
    expect(caller.account).toBe("123456789012");
    expect(commands.runs).toEqual(["aws sso login --profile dev"]);
    expect(clients).toBe(2);
    expect(page.cards.map((card) => card.status)).toEqual(["failed", "ok"]);
    expect(page.cards[0]?.lines).toEqual([
      "AgentX cannot use the AWS sign-in of profile dev.",
      "AWS credentials missing or expired: The security token included in the request is expired",
      "Choose Sign in to run aws sso login --profile dev; a browser tab opens for it.",
    ]);
  });

  it("shows a sign-in that could not run and asks again; Stop ends the run with the credentials error", async () => {
    const page = surface();
    const failure = expired();
    const prompter = scriptedPrompter(["signin", "stop"]);
    await expect(resolveCaller({
      identity: () => ({ get: async () => { throw failure; } }), region: "us-east-1", prompter,
      runner: runner(Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" })), surface: page, profile: DEV,
    })).rejects.toBe(failure);
    expect(prompter.asked).toEqual(["Your AWS sign-in is missing or has expired. What next?", "Your AWS sign-in is missing or has expired. What next?"]);
    expect(page.cards.at(-1)?.lines).toContain("could not run aws sso login --profile dev: spawn aws ENOENT");
  });

  it("offers only check again for a profile AgentX cannot sign in to, and rethrows anything that is not a sign-in problem", async () => {
    const page = surface();
    let calls = 0;
    const caller = await resolveCaller({
      identity: () => ({ get: async () => { calls += 1; if (calls === 1) throw expired(); return { account: "123456789012", arn: HOLDER }; } }),
      region: "us-east-1", prompter: scriptedPrompter(["retry"]), runner: runner(), surface: page, profile: { name: "legacy", kind: "keys" },
    });
    expect(caller.account).toBe("123456789012");
    expect(page.cards[0]?.lines.at(-1)).toBe("Update the credentials of profile legacy in a terminal, then choose Check again.");

    const denied = Object.assign(new Error("not authorized to perform sts:GetCallerIdentity"), { name: "AccessDeniedException" });
    await expect(resolveCaller({ identity: () => ({ get: async () => { throw denied; } }), region: "us-east-1", prompter: scriptedPrompter([]), runner: runner(), surface: surface(), profile: DEV })).rejects.toBe(denied);
  });
});
```

Append to `tests/contract/init-ui-cli.test.ts`, inside `describe("agentx init --ui", ...)`:

```ts
  it("FR-020: asks which AWS profile on the page, uses it, and shows the account before anything is created", async () => {
    const h = await harness();
    await mkdir(join(h.home, ".aws"), { recursive: true });
    await writeFile(join(h.home, ".aws", "config"), "[default]\nregion = us-east-1\n[profile dev]\nsso_session = acme\n");
    const processEnv: NodeJS.ProcessEnv = {};
    const operator = fakeWizardOperator(["dev", ...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, processEnv })).toBe(0);
    await operator.settled();
    expect(operator.asked[0]).toBe("AWS profile to install with");
    expect(processEnv.AWS_PROFILE).toBe("dev");
    // The account is on the page by the time the review screen asks to create anything.
    const review = operator.states.find((state) => state.question?.text === "Create all of this?");
    expect(review?.cards?.find((card) => card.id === "aws")?.lines[0]).toBe("AgentX installs into account 123456789012 in us-east-1.");
  });

  it("FR-022: the region picker offers only the release's regions", async () => {
    const h = await harness();
    // No --region, so the region is the first question; then the first-run answers, and no to the plan.
    const operator = fakeWizardOperator(["", ...FIRST_RUN.slice(0, -1), false]);
    await executeCli(["--env", "staging", "init", "--release", await releaseDir(), "--ui"], {
      stdout: { write: () => undefined }, stderr: { write: () => undefined }, environments: { home: h.home },
      init: { ...h.base, openBrowser: operator.open },
    });
    await operator.settled();
    const region = operator.states.find((state) => state.question?.text === "AWS region")?.question;
    expect(region?.choices?.map((choice) => choice.value)).toEqual(["us-east-1"]);
  });
```

This test needs the harness to return `base`: add `base` to the object `harness()` returns (a
support change only; no assertion changes). The region question takes the first entry of
`FIRST_RUN` (""), so the script above still lines up.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-aws-account.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL (`aws-account.js` does not exist; no profile question is asked).

- [ ] **Step 3: Write the AWS cards**

In `packages/cli/src/init/ui/cards.ts`, remove the temporary `export type { WizardCard };` line and
add:

```ts
import { DEDICATED_ACCOUNT_NOTE } from "../prerequisites.js";

export function awsCard(input: { account: string; arn: string; region: string; profile?: string }): WizardCard {
  return {
    id: "aws", title: "AWS account", status: "ok",
    lines: [
      `AgentX installs into account ${input.account} in ${input.region}.`,
      `Signed in as ${input.arn}${input.profile === undefined ? "" : ` (profile ${input.profile})`}.`,
      DEDICATED_ACCOUNT_NOTE,
    ],
  };
}

/** FR-021: the session is missing or expired. `signIn` is the command Sign in runs, when the
 * profile has one; `ranProblem` is why the last sign-in could not run. */
export function awsSignedOutCard(input: { profile?: string; problem: string; signIn?: string; ranProblem?: string }): WizardCard {
  const next = input.signIn !== undefined
    ? `Choose Sign in to run ${input.signIn}; a browser tab opens for it.`
    : input.profile === undefined
      ? "Sign in again in a terminal, then choose Check again."
      : `Update the credentials of profile ${input.profile} in a terminal, then choose Check again.`;
  return {
    id: "aws", title: "AWS account", status: "failed",
    lines: [
      input.profile === undefined ? "AgentX cannot use your AWS sign-in." : `AgentX cannot use the AWS sign-in of profile ${input.profile}.`,
      input.problem,
      ...(input.ranProblem === undefined ? [] : [input.ranProblem]),
      next,
    ],
  };
}
```

- [ ] **Step 4: Write `aws-account.ts`**

```ts
// packages/cli/src/init/aws-account.ts
// FR-020 to FR-022 (Q9): which AWS profile the install uses, which account and role that is, and
// signing in again when the session has expired. Only the page asks the profile question; the
// terminal path uses the ambient credentials exactly as before. A profile's keys are never read
// into anything this module returns.
import { readFile as readFileFromDisk } from "node:fs/promises";
import { join } from "node:path";
import { AgentXError } from "@agentx/contracts";
import { cliErrorFor } from "../deploy/commands.js";
import type { CommandRunner } from "../deploy/cdk-engine.js";
import type { CallerIdentity } from "../environments/adopt.js";
import type { InstallSurface } from "./context.js";
import type { Prompter } from "./prompts.js";
import { problemText } from "./retry.js";
import { awsCard, awsSignedOutCard } from "./ui/cards.js";

export type AwsProfileKind = "sso" | "login" | "keys" | "other";
export interface AwsProfile { name: string; kind: AwsProfileKind; region?: string }

const KIND_LABELS: Record<AwsProfileKind, string> = { sso: "IAM Identity Center", login: "aws login", keys: "access keys", other: "a role or a process" };

/** An AWS config or credentials file: `[section]` headers, and `key = value` lines, keys lower-cased. */
export function parseAwsIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").trim();
      current = sections.get(name) ?? new Map<string, string>();
      sections.set(name, current);
      continue;
    }
    const pair = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (pair !== null && current !== undefined) current.set((pair[1] ?? "").trim().toLowerCase(), (pair[2] ?? "").trim());
  }
  return sections;
}

function kindOf(values: Map<string, string>): AwsProfileKind {
  if (values.has("sso_session") || values.has("sso_start_url")) return "sso";
  if (values.has("login_session")) return "login";
  if (values.has("aws_access_key_id")) return "keys";
  return "other";
}

/** Every profile in the AWS CLI's two files, `default` first, then by name. Only names, how each
 * signs in, and a region: never a key. */
export async function listAwsProfiles(input: { home: string; processEnv: NodeJS.ProcessEnv; readFile?: (path: string) => Promise<string> }): Promise<AwsProfile[]> {
  const read = input.readFile ?? ((path: string) => readFileFromDisk(path, "utf8"));
  const optional = async (path: string) => { try { return await read(path); } catch { return ""; } };
  const config = parseAwsIni(await optional(input.processEnv.AWS_CONFIG_FILE ?? join(input.home, ".aws", "config")));
  const credentials = parseAwsIni(await optional(input.processEnv.AWS_SHARED_CREDENTIALS_FILE ?? join(input.home, ".aws", "credentials")));
  const profiles = new Map<string, AwsProfile>();
  for (const [section, values] of config) {
    // "sso-session x" and "services x" sections are not profiles.
    const name = section === "default" ? "default" : section.startsWith("profile ") ? section.slice("profile ".length).trim() : "";
    if (name === "") continue;
    const region = values.get("region");
    profiles.set(name, { name, kind: kindOf(values), ...(region === undefined || region === "" ? {} : { region }) });
  }
  for (const [name, values] of credentials) {
    if (!values.has("aws_access_key_id")) continue;
    const known = profiles.get(name);
    if (known === undefined) profiles.set(name, { name, kind: "keys" });
    else if (known.kind === "other") profiles.set(name, { ...known, kind: "keys" });
  }
  return [...profiles.values()].sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : a.name.localeCompare(b.name)));
}

/** FR-020: the profile the install uses, put in AWS_PROFILE before any AWS client is built. None
 * when keys in the environment win over every profile, or when this machine has no profile. */
export async function pickAwsProfile(input: { profiles: AwsProfile[]; processEnv: NodeJS.ProcessEnv; prompter: Prompter }): Promise<AwsProfile | undefined> {
  const { profiles, processEnv } = input;
  if (processEnv.AWS_ACCESS_KEY_ID !== undefined) return undefined;
  const first = profiles[0];
  if (first === undefined) return undefined;
  const current = profiles.find((profile) => profile.name === (processEnv.AWS_PROFILE ?? "default")) ?? first;
  let picked = current;
  if (profiles.length > 1) {
    const name = await input.prompter.choose<string>(
      "AWS profile to install with",
      profiles.map((profile) => ({ value: profile.name, label: `${profile.name} (${KIND_LABELS[profile.kind]})` })),
      { flag: "AWS_PROFILE", defaultValue: current.name },
    );
    picked = profiles.find((profile) => profile.name === name) ?? current;
  }
  processEnv.AWS_PROFILE = picked.name;
  return picked;
}

/** FR-021: the AWS CLI command that signs this profile in again, when it has one. */
export function signInCommand(profile: AwsProfile): { command: "aws"; args: string[]; display: string } | undefined {
  const args = profile.kind === "sso" ? ["sso", "login", "--profile", profile.name] : profile.kind === "login" ? ["login", "--profile", profile.name] : undefined;
  return args === undefined ? undefined : { command: "aws", args, display: `aws ${args.join(" ")}` };
}

const isSignInProblem = (error: unknown): boolean => {
  const mapped = cliErrorFor(error);
  return mapped instanceof AgentXError && mapped.code === "AUTH_REQUIRED";
};

/** The caller, shown on the page (FR-020). On the page, a missing or expired session offers the
 * profile's sign-in and asks AWS again (FR-021); `identity` builds a fresh client each time, so a
 * credential the SDK failed to load is looked up again. Without a page, the first failure is
 * thrown exactly as before. */
export async function resolveCaller(input: {
  identity: () => CallerIdentity; region: string; prompter: Prompter; runner: CommandRunner; surface?: InstallSurface; profile?: AwsProfile;
}): Promise<{ account: string; arn: string }> {
  const { surface, profile } = input;
  const signIn = profile === undefined ? undefined : signInCommand(profile);
  let ranProblem: string | undefined;
  for (;;) {
    try {
      const caller = await input.identity().get();
      surface?.card(awsCard({ ...caller, region: input.region, ...(profile === undefined ? {} : { profile: profile.name }) }));
      return caller;
    } catch (error) {
      if (surface === undefined || !isSignInProblem(error)) throw error;
      surface.card(awsSignedOutCard({
        problem: problemText(error),
        ...(profile === undefined ? {} : { profile: profile.name }),
        ...(signIn === undefined ? {} : { signIn: signIn.display }),
        ...(ranProblem === undefined ? {} : { ranProblem }),
      }));
      ranProblem = undefined;
      const next = await input.prompter.choose<"signin" | "retry" | "stop">("Your AWS sign-in is missing or has expired. What next?", [
        ...(signIn === undefined ? [] : [{ value: "signin" as const, label: `Sign in (${signIn.display})` }]),
        { value: "retry", label: "I signed in another way; check again" },
        { value: "stop", label: "Stop the install" },
      ], { flag: "AWS_PROFILE", defaultValue: signIn === undefined ? "retry" : "signin" });
      if (next === "stop") throw error;
      if (next === "signin" && signIn !== undefined) {
        try {
          await input.runner.run(signIn.command, signIn.args, { cwd: process.cwd(), display: signIn.display });
        } catch (runError) {
          ranProblem = `could not run ${signIn.display}: ${runError instanceof Error ? runError.message : String(runError)}`;
        }
      }
    }
  }
}
```

- [ ] **Step 5: Ask on the page, then resolve the caller**

In `packages/cli/src/init/commands.ts`, import:

```ts
import { listAwsProfiles, pickAwsProfile, resolveCaller } from "./aws-account.js";
```

Right before `const regions = release.regions();`, add:

```ts
  // FR-020 (Q9): on the page, the operator picks the AWS profile before anything reads AWS. It is
  // put in AWS_PROFILE, which every AWS client built below, and every child process (cdk, the AWS
  // CLI), reads. processEnv is process.env on a real run. The terminal path asks nothing here.
  const awsProfile = session.wizard === undefined
    ? undefined
    : await pickAwsProfile({ profiles: await listAwsProfiles({ home: services.home, processEnv }), processEnv, prompter });
```

Add the profile's region as the last fallback of the region default:

```ts
  const environmentRegion = [processEnv.AWS_REGION, processEnv.AWS_DEFAULT_REGION, awsProfile?.region].find((value) => value !== undefined && regions.includes(value));
```

Replace `const caller = await (deployDeps.identity ?? stsCallerIdentity(new STSClient({ region }))).get();` with:

```ts
  // FR-020 and FR-021: the account the install lands in, on the page; there, an expired session
  // is signed in again instead of ending the run. The terminal path throws as before.
  const caller = await resolveCaller({
    identity: () => deployDeps.identity ?? stsCallerIdentity(new STSClient({ region })),
    region, prompter, runner,
    ...(session.wizard === undefined ? {} : { surface: session.wizard.surface }),
    ...(awsProfile === undefined ? {} : { profile: awsProfile }),
  });
```

(`surface` from Task 2 is declared later, after the answers; this uses `session.wizard.surface`
directly because the caller is resolved before then.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-aws-account.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS. The phase 1 UI tests ask no profile question: their home has no `.aws` folder.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/init/aws-account.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/commands.ts tests/contract/init-aws-account.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): the AWS screen: pick a profile, show the account, sign in again when expired"
```

---

### Task 4: The prerequisite checklist

**Files:**
- Modify: `packages/cli/src/init/prerequisites.ts`, `packages/cli/src/init/ui/cards.ts`, `packages/cli/src/init/commands.ts`
- Test: `tests/contract/init-prerequisites.test.ts` (append), `tests/contract/init-ui-cli.test.ts` (append)

Depends on Q7.

**Interfaces:**
- Consumes: Task 2's `retryOnPage`, `surface`.
- Produces: `interface PrerequisiteCheck { label: string; ok: boolean; detail: string }`;
  `checkPrerequisites`'s new optional input `onCheck?: (check: PrerequisiteCheck) => void`;
  `prerequisitesCard(input: { status: "running" | "ok" | "failed"; checks: readonly PrerequisiteCheck[] }): WizardCard`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/init-prerequisites.test.ts` (it already imports `checkPrerequisites`,
`passingChecks`, `sampleAnswers` and `fakeRelease`; add `PrerequisiteCheck` to the prerequisites
import):

```ts
describe("the prerequisite checklist (spec 040 FR-023)", () => {
  const run = (checks: ReturnType<typeof passingChecks>, onCheck?: (check: PrerequisiteCheck) => void) => {
    const lines: string[] = [];
    const done = checkPrerequisites({
      answers: sampleAnswers(), release: fakeRelease(), caller: { account: "123456789012", arn: "arn:aws:sts::123456789012:assumed-role/Admin/alice" },
      checks, prompter: scriptedPrompter([]), write: (line) => { lines.push(line); }, ...(onCheck === undefined ? {} : { onCheck }),
    });
    return { lines, done };
  };

  it("reports each check as it finishes, and writes exactly the lines it wrote before", async () => {
    const reported: PrerequisiteCheck[] = [];
    const withList = run(passingChecks(), (check) => { reported.push(check); });
    await withList.done;
    const without = run(passingChecks());
    await without.done;
    expect(withList.lines).toEqual(without.lines);
    expect(reported.map((check) => [check.label, check.ok])).toEqual([
      ["Region", true], ["EC2 vCPU quota", true], ["Elastic IPs", true],
      ...[...new Set([sampleAnswers().models.orchestrator, sampleAnswers().models.classifier, sampleAnswers().models.worker])].map((model) => [`Model ${model}`, true]),
    ]);
    expect(reported[1]).toEqual({ label: "EC2 vCPU quota", ok: true, detail: "EC2 Standard on-demand vCPU quota is 32 in us-east-1" });
  });

  it("reports a failed check with the same words the error lists", async () => {
    const reported: PrerequisiteCheck[] = [];
    const { done } = run(passingChecks({ ec2Quota: async () => 0 }), (check) => { reported.push(check); });
    await expect(done).rejects.toThrow("EC2 Standard on-demand vCPU quota in us-east-1 must be at least 1");
    expect(reported.find((check) => check.label === "EC2 vCPU quota")).toEqual({
      label: "EC2 vCPU quota", ok: false, detail: "EC2 Standard on-demand vCPU quota in us-east-1 must be at least 1 for an m6g.medium worker; request an increase in Service Quotas",
    });
  });
});
```

Append to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("FR-023: a failed prerequisite is a checklist on the page, and checking again after the fix goes on", async () => {
    const h = await harness();
    let quotaReads = 0;
    const checks = passingChecks({ ec2Quota: async () => { quotaReads += 1; return quotaReads === 1 ? 0 : 32; } });
    // Every first-run answer, then "Check the prerequisites again?" yes, then the review screen.
    const operator = fakeWizardOperator([...FIRST_RUN.slice(0, -1), true, true, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, checks })).toBe(0);
    await operator.settled();
    expect(operator.asked).toContain("Check the prerequisites again?");
    const cards = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "prerequisites") ?? []);
    const failed = cards.find((card) => card.status === "failed");
    expect(failed?.checks?.find((check) => check.label === "EC2 vCPU quota")).toMatchObject({ ok: false });
    // Review Focus 5: the card after the fix lists only the new results.
    const last = cards.at(-1);
    expect(last?.status).toBe("ok");
    expect(last?.checks?.every((check) => check.ok)).toBe(true);
    expect(last?.checks?.filter((check) => check.label === "EC2 vCPU quota")).toHaveLength(1);
  });

  it("FR-023: saying no to checking again creates nothing", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([...FIRST_RUN.slice(0, -1), false]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, checks: passingChecks({ ec2Quota: async () => 0 }) })).not.toBe(0);
    await operator.settled();
    expect(h.printed()).toContain("init cannot start; nothing was created");
    expect(h.deployer.requests).toEqual([]);
    expect(h.store.values.has(installAnswersParameterName("staging"))).toBe(false);
  });
```

(`passingChecks` is imported in that file already; if not, add it to the `init-fakes` import.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL (`onCheck` is never called; no "Check the prerequisites again?" is asked).

- [ ] **Step 3: Report each check from `checkPrerequisites`**

In `packages/cli/src/init/prerequisites.ts`, export the type after `PendingOpenRouterKey`:

```ts
/** One prerequisite's result, for the page's checklist (spec 040 FR-023). `detail` is the ok line
 * without its "ok " prefix, or the problem exactly as the error lists it. */
export interface PrerequisiteCheck { label: string; ok: boolean; detail: string }
```

Add `onCheck?: (check: PrerequisiteCheck) => void;` to `checkPrerequisites`'s input type, after
`openRouterKey?`. At the top of the function body, after `const problems: string[] = [];`, add:

```ts
  // Each check is reported as it finishes (the page's checklist); the lines written and the
  // problems collected are exactly what they were before.
  const passed = (label: string, line: string) => { write(line); input.onCheck?.({ label, ok: true, detail: line.replace(/^ok /, "") }); };
  const failed = (label: string, problem: string) => { problems.push(problem); input.onCheck?.({ label, ok: false, detail: problem }); };
```

Then replace each call, and nothing else:

| Where | Before | After |
|---|---|---|
| region | `if (regionProblem !== undefined) problems.push(regionProblem);` | `if (regionProblem !== undefined) failed("Region", regionProblem); else input.onCheck?.({ label: "Region", ok: true, detail: \`${region} is covered by this release\` });` |
| EC2 quota, too low | `problems.push(\`EC2 Standard on-demand vCPU quota in ...\`)` | `failed("EC2 vCPU quota", \`EC2 Standard on-demand vCPU quota in ...\`)` (same string) |
| EC2 quota, ok | `write(\`ok EC2 Standard on-demand vCPU quota is ${quota} in ${region}\`)` | `passed("EC2 vCPU quota", \`ok EC2 Standard on-demand vCPU quota is ${quota} in ${region}\`)` |
| EC2 quota, unreadable | `problems.push(\`could not check EC2 vCPU quota ...\`)` | `failed("EC2 vCPU quota", ...)` |
| Elastic IPs, too few | `problems.push(\`this environment needs ...\`)` | `failed("Elastic IPs", ...)` |
| Elastic IPs, ok | `write(\`ok ${free} of ${quota} EC2-VPC Elastic IPs free ...\`)` | `passed("Elastic IPs", ...)` |
| Elastic IPs, unreadable | `problems.push(\`could not check Elastic IPs ...\`)` | `failed("Elastic IPs", ...)` |
| OpenRouter model, ok | `write(\`ok ${identifier} supports tools and answers\`)` | `passed(\`Model ${identifier}\`, ...)` |
| OpenRouter fallback, ok | `write(\`ok ${identifier}: OpenRouter secret missing; ...\`)` | `passed(\`Model ${identifier}\`, ...)` |
| OpenRouter fallback, failed | `problems.push(modelCheckProblem({ modelId: fallback.modelId, ... }))` | `failed(\`Model ${fallback.modelId}\`, modelCheckProblem(...))` |
| OpenRouter, failed | `problems.push(\`${identifier}: OpenRouter preflight failed; ...\`)` | `failed(\`Model ${identifier}\`, ...)` |
| Bedrock model, ok | `write(\`ok ${modelId} answers\`)` | `passed(\`Model ${modelId}\`, \`ok ${modelId} answers\`)` |
| Bedrock model, failed | `problems.push(modelCheckProblem({ modelId, role, region, error }))` | `failed(\`Model ${modelId}\`, modelCheckProblem({ modelId, role, region, error }))` |
| OIDC, mismatch | `problems.push(\`the OIDC discovery document at ...\`)` | `failed("OIDC discovery", ...)` |
| OIDC, ok | `write(\`ok OIDC discovery at ${url}\`)` | `passed("OIDC discovery", ...)` |
| OIDC, error | `problems.push(errorMessage(error))` | `failed("OIDC discovery", errorMessage(error))` |
| Node | `problems.push(\`the cdk engine needs Node 22.19 ...\`)` | `failed("Node", ...)` |
| npx | `problems.push("the cdk engine needs npx (it comes with npm)")` | `failed("npx", ...)` |
| CDK bootstrap, unreadable | `problems.push(\`could not check CDK bootstrap: ...\`)` | `failed("CDK bootstrap", ...)` |
| CDK bootstrap, done | `write(\`ok CDK bootstrapped in ${region}\`)` | `passed("CDK bootstrap", ...)` |
| CDK bootstrap, declined | `problems.push(\`CDK is not bootstrapped in ${region}; ...\`)` | `failed("CDK bootstrap", ...)` |

The two lines that are not checks stay `write`: `AWS account ...` and `DEDICATED_ACCOUNT_NOTE`, and
the "CDK is not bootstrapped ... creates the CDKToolkit stack" explanation.

- [ ] **Step 4: The checklist card**

In `packages/cli/src/init/ui/cards.ts`, extend the prerequisites import and add:

```ts
import { DEDICATED_ACCOUNT_NOTE, type PrerequisiteCheck } from "../prerequisites.js";

export function prerequisitesCard(input: { status: "running" | "ok" | "failed"; checks: readonly PrerequisiteCheck[] }): WizardCard {
  const lines = input.status === "running"
    ? ["Checking this account and region before anything is created."]
    : input.status === "ok"
      ? ["Every check passed."]
      : ["Nothing has been created. Fix each item marked with a cross, then answer Yes below to check again."];
  return { id: "prerequisites", title: "Prerequisites", status: input.status, lines, checks: input.checks.map((check) => ({ ...check })) };
}
```

- [ ] **Step 5: Show it, and check again on the page**

In `packages/cli/src/init/commands.ts`, import `retryOnPage` from `./retry.js`, `prerequisitesCard`
from `./ui/cards.js`, and `type PrerequisiteCheck` from `./prerequisites.js`. Task 2 declared
`surface` right after `const activePrompter = prompter;`, which is above this line. Replace the
`runPrerequisites` line with:

```ts
  // FR-023 (Q7): on the page, the checks are a checklist, and a failure can be checked again
  // after the fix; the terminal path stops with the collected problems, as before.
  const runPrerequisites = () => retryOnPage({
    surface, prompter: activePrompter, question: "Check the prerequisites again?",
    // The card already lists every failed check, so the retry shows nothing of its own.
    failed: () => undefined,
    run: async () => {
      const found: PrerequisiteCheck[] = [];
      const show = (status: "running" | "ok" | "failed") => surface?.card(prerequisitesCard({ status, checks: found }));
      show("running");
      try {
        await checkPrerequisites({
          answers: finalAnswers, release, caller, checks, prompter: activePrompter, write,
          onCheck: (check) => { found.push(check); show("running"); },
          ...(pendingKey === undefined ? {} : { openRouterKey: pendingKey }),
        });
      } catch (error) {
        show("failed");
        throw error;
      }
      show("ok");
    },
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-prerequisites.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS, the existing prerequisite tests unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/init/prerequisites.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/commands.ts tests/contract/init-prerequisites.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): the prerequisites as a checklist on the page, checked again after a fix"
```

---

### Task 5: GitHub on the wizard's own address

**Files:**
- Modify: `packages/cli/src/init/context.ts`, `packages/cli/src/init/ui/server.ts`, `packages/cli/src/init/ui/index.ts`, `packages/cli/src/init/github-app.ts`, `packages/cli/src/init/ui/cards.ts`, `packages/cli/src/init/commands.ts`
- Test: `tests/contract/init-ui-github.test.ts` (create), `tests/contract/init-ui-cli.test.ts` (append)

Depends on Q5 and Q6.

**Interfaces:**
- Consumes: Task 1's link rules, Task 2's surface and operator.
- Produces:
  - `interface ManifestHost { port: number; startUrl: string; redirectUrl: string; code: Promise<string>; close(): void }` and
    `type OpenManifestHost = (input: { state: string; page: (redirectUrl: string, nonce?: string) => string; timeoutMs: number }) => Promise<ManifestHost>` (context.ts);
    `InitContext.manifestHost?: OpenManifestHost`;
  - `WizardServer.mountManifest(input: Parameters<OpenManifestHost>[0]): ManifestHost`;
  - `InstallWizard.manifestHost: OpenManifestHost`;
  - `manifestFormPage(input: { actionUrl: string; manifest: GitHubManifest; nonce?: string }): string`;
  - `GITHUB_START_PATH = "/github/start"`, `GITHUB_CALLBACK_PATH = "/github/created"`, `manifestFormCsp(nonce: string): string` (server.ts);
  - `githubCard(input: GitHubCardInput): WizardCard` (cards.ts).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-github.test.ts
// FR-030 (Q6): the GitHub App's manifest form and GitHub's redirect back are served by the
// wizard's own address. The redirect is the one request that may arrive from another site without
// the session token, so it is held to the manifest flow's own state, once, while a GitHub App is
// awaited, and to the listener's own Host.
import { afterEach, describe, expect, it } from "vitest";
import { WIZARD_TOKEN_HEADER } from "../../packages/cli/src/init/ui/protocol.js";
import { GITHUB_CALLBACK_PATH, manifestFormCsp, startWizardServer, type WizardServer } from "../../packages/cli/src/init/ui/server.js";
import { createWizardHub } from "../../packages/cli/src/init/ui/state.js";
import { githubAppManifest, manifestFormPage } from "../../packages/cli/src/init/github-app.js";

const TOKEN = "test-session-token-bbbbbbbbbbbbbbbbbbb";
const STATE = "0123456789abcdef0123456789abcdef";
const open: WizardServer[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map((server) => server.close())); });

async function wizard() {
  const server = await startWizardServer({ hub: createWizardHub("staging"), token: TOKEN });
  open.push(server);
  return { server, origin: `http://127.0.0.1:${server.port}` };
}
const page = (redirectUrl: string, nonce?: string) => manifestFormPage({ actionUrl: `https://github.com/settings/apps/new?state=${STATE}`, manifest: githubAppManifest({ appName: "AgentX", redirectUrl }), ...(nonce === undefined ? {} : { nonce }) });
const fromGitHub = { "sec-fetch-site": "cross-site", referer: "https://github.com/" };
const settled = <T>(promise: Promise<T>) => Promise.race([promise.then(() => "resolved", () => "rejected"), new Promise((resolve) => setTimeout(() => resolve("pending"), 50))]);

describe("the GitHub App flow on the wizard's own address", () => {
  it("serves the form page with the session token only, under a CSP that lets its one script post to GitHub", async () => {
    const { server, origin } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    expect(mount.redirectUrl).toBe(`${origin}${GITHUB_CALLBACK_PATH}`);
    expect(mount.startUrl).toBe(`${origin}/github/start?t=${TOKEN}`);
    expect((await fetch(`${origin}/github/start`)).status).toBe(401);
    const response = await fetch(mount.startUrl);
    expect(response.status).toBe(200);
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
    expect(csp).toBe(manifestFormCsp(nonce));
    expect(csp).toContain("form-action https://github.com");
    const html = await response.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`action="https://github.com/settings/apps/new?state=${STATE}"`);
    // The manifest names the wizard's own callback (its JSON is HTML-escaped, which leaves the address as it is).
    expect(html).toContain(mount.redirectUrl);
    mount.close();
  });

  it("takes GitHub's cross-site redirect with the right state, once, and resolves the code", async () => {
    const { server, origin } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    const answer = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=${STATE}`, { headers: fromGitHub });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(answer.headers.get("access-control-allow-origin")).toBeNull();
    expect(await answer.text()).toContain("Go back to the Install AgentX tab to continue.");
    await expect(mount.code).resolves.toBe("0123456789abcdef0123");
    // Review Focus 2: a second callback (a second GitHub tab) is refused like any other request.
    expect((await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=fedcba9876543210fedc&state=${STATE}`, { headers: fromGitHub })).status).toBe(401);
  });

  it("refuses a callback with another run's state, and keeps waiting for the right one", async () => {
    const { server, origin } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    const wrong = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=ffffffffffffffffffffffffffffffff`, { headers: fromGitHub });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("This page is from a different agentx init run.");
    expect(await settled(mount.code)).toBe("pending");
    expect((await fetch(`${origin}${GITHUB_CALLBACK_PATH}?state=${STATE}`, { headers: fromGitHub })).status).toBe(400);
    expect(await settled(mount.code)).toBe("pending");
    mount.close();
  });

  it("refuses a callback that names another Host, even with the right state", async () => {
    const { server } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve) => {
      request({ host: "127.0.0.1", port: server.port, path: `${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=${STATE}`, headers: { host: `localhost:${server.port}` } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); }).end();
    });
    expect(status).toBe(403);
    expect(await settled(mount.code)).toBe("pending");
    mount.close();
  });

  it("Review Focus 1: a callback after the wait ended is refused like any other request", async () => {
    const { server, origin } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 20 });
    await expect(mount.code).rejects.toThrow("no GitHub App was created within 0 minutes; run agentx init again");
    expect((await fetch(`${origin}${GITHUB_CALLBACK_PATH}?code=0123456789abcdef0123&state=${STATE}`, { headers: fromGitHub })).status).toBe(401);
    // Without a mount the start page is not there either.
    expect((await fetch(`${origin}/github/start`, { headers: { [WIZARD_TOKEN_HEADER]: TOKEN } })).status).toBe(404);
  });

  it("rejects the wait when the wizard closes", async () => {
    const { server } = await wizard();
    const mount = server.mountManifest({ state: STATE, page, timeoutMs: 60_000 });
    await server.close();
    open.splice(0);
    await expect(mount.code).rejects.toThrow("the install wizard closed before the GitHub App was created");
  });
});
```

Append to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("FR-030 and FR-031: the GitHub App is created and installed through the wizard's own address, shown as cards", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const wizardOrigin = new URL(operator.opened[0] ?? "").origin;
    expect(operator.clicked).toContain(`${wizardOrigin}/github/start?t=${new URL(operator.opened[0] ?? "").searchParams.get("t") ?? ""}`);
    expect(h.github.conversions).toEqual(["0123456789abcdef0123"]);
    const stages = operator.states.flatMap((state) => state.cards?.filter((card) => card.id === "github").map((card) => card.lines[0]) ?? []);
    // The app's name is the first run's default ("AgentX <account> <env>"); its slug is GitHub's.
    expect(stages).toContain('Create the GitHub App "AgentX acme staging" for acme. GitHub opens with everything filled in; press Create GitHub App.');
    expect(stages).toContain("Install agentx-acme-staging on acme and choose the repositories AgentX may use.");
    expect(stages.at(-1)).toBe("agentx-acme-staging is installed on acme.");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-github.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL (`mountManifest` is not a function).

- [ ] **Step 3: The manifest host seam**

In `packages/cli/src/init/context.ts`, add above `InitContext`:

```ts
/** Where the GitHub App's manifest form is served and GitHub's redirect is received: the terminal
 * path's one-time listener (github-app.ts's startManifestListener), or the wizard's own address
 * with --ui (FR-030). */
export interface ManifestHost { port: number; startUrl: string; redirectUrl: string; code: Promise<string>; close(): void }
export type OpenManifestHost = (input: { state: string; page: (redirectUrl: string, nonce?: string) => string; timeoutMs: number }) => Promise<ManifestHost>;
```

and the field, after `surface?`:

```ts
  /** With --ui only: the wizard serves the GitHub App flow itself. */
  manifestHost?: OpenManifestHost;
```

- [ ] **Step 4: The two routes on the wizard server**

In `packages/cli/src/init/ui/server.ts`, add the imports and constants:

```ts
import type { ManifestHost, OpenManifestHost } from "../context.js";

export const GITHUB_START_PATH = "/github/start";
export const GITHUB_CALLBACK_PATH = "/github/created";

/** The GitHub form page's policy: its one script (by nonce) submits one form, to GitHub only. */
export function manifestFormCsp(nonce: string): string {
  return `default-src 'none'; script-src 'nonce-${nonce}'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'`;
}

/** The callback's answer carries nothing and loads nothing, and sends no Referer onward. */
const CALLBACK_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};
const CALLBACK_PAGE = (text: string) => `<!doctype html><meta charset="utf-8"><title>Install AgentX</title><p>${text}</p>`;

interface ManifestRoute {
  state: string;
  page: (redirectUrl: string, nonce?: string) => string;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}
```

Add to `WizardServer`:

```ts
  /** FR-030: serves the GitHub App flow until the code arrives, the wait times out, or `close`. */
  mountManifest(input: Parameters<OpenManifestHost>[0]): ManifestHost;
```

Inside `startWizardServer`, beside `streams`, add `let manifest: ManifestRoute | undefined;` and
`let expectedHost = "";` (set next to `expectedOrigin` after listening:
`expectedHost = \`127.0.0.1:${port}\`;`).

Add the callback handler inside `startWizardServer`, above `handle`:

```ts
  // Q6: GitHub's redirect back is a cross-site top-level visit with no session token. It is let
  // through only here: while a GitHub App is awaited, with the flow's own state, once.
  const githubCallback = (url: URL, response: ServerResponse): void => {
    const route = manifest;
    const answer = (status: number, text: string) => {
      const body = CALLBACK_PAGE(text);
      response.writeHead(status, { ...CALLBACK_HEADERS, "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(body);
    };
    if (route === undefined) return answer(404, "Not found.");
    if (!tokensMatch(url.searchParams.get("state") ?? undefined, route.state)) return answer(400, "This page is from a different agentx init run.");
    const code = url.searchParams.get("code");
    if (code === null || code === "") return answer(400, "GitHub sent no code. Go back to the Install AgentX tab.");
    manifest = undefined;
    clearTimeout(route.timer);
    route.resolve(code);
    return answer(200, "AgentX has the new GitHub App. Go back to the Install AgentX tab to continue.");
  };
```

At the very top of `handle`, before `refusalReason`, add:

```ts
    if (request.method === "GET" && url.pathname === GITHUB_CALLBACK_PATH && manifest !== undefined && headerValue(request, "host") === expectedHost) {
      return githubCallback(url, response);
    }
```

After the `/app.js` route, add the start route (behind every check, like every other route):

```ts
    if (request.method === "GET" && url.pathname === GITHUB_START_PATH) {
      if (manifest === undefined) return send(response, 404, "text/plain; charset=utf-8", "not found\n");
      const nonce = randomBytes(16).toString("base64");
      const body = manifest.page(`${expectedOrigin}${GITHUB_CALLBACK_PATH}`, nonce);
      response.writeHead(200, { ...SECURITY_HEADERS, "content-security-policy": manifestFormCsp(nonce), "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(body);
      return;
    }
```

Add `mountManifest` to the returned object, and reject a pending wait in `close`:

```ts
    mountManifest(next) {
      if (manifest !== undefined) {
        clearTimeout(manifest.timer);
        manifest.reject(agentXError("CONFIG_INVALID", "a newer GitHub App page replaced this one; use the newest one"));
      }
      let resolveCode: (code: string) => void = () => undefined;
      let rejectCode: (error: Error) => void = () => undefined;
      const code = new Promise<string>((resolvePromise, reject) => { resolveCode = resolvePromise; rejectCode = reject; });
      code.catch(() => undefined);
      const timer = setTimeout(() => {
        if (manifest?.timer === timer) manifest = undefined;
        rejectCode(agentXError("CONFIG_INVALID", `no GitHub App was created within ${Math.round(next.timeoutMs / 60_000)} minutes; run agentx init again`));
      }, next.timeoutMs);
      timer.unref();
      manifest = { state: next.state, page: next.page, resolve: resolveCode, reject: rejectCode, timer };
      return {
        port,
        // The page and the terminal already hold the session token; the start page needs it.
        startUrl: `${expectedOrigin}${GITHUB_START_PATH}?${WIZARD_TOKEN_QUERY}=${encodeURIComponent(token)}`,
        redirectUrl: `${expectedOrigin}${GITHUB_CALLBACK_PATH}`,
        code,
        close: () => {
          if (manifest?.timer !== timer) return;
          clearTimeout(timer);
          manifest = undefined;
        },
      };
    },
```

and at the start of `close()`:

```ts
      if (manifest !== undefined) {
        clearTimeout(manifest.timer);
        manifest.reject(agentXError("CONFIG_INVALID", "the install wizard closed before the GitHub App was created"));
        manifest = undefined;
      }
```

- [ ] **Step 5: Offer it through the wizard, and use it in the GitHub App step**

In `packages/cli/src/init/ui/index.ts`, import `type OpenManifestHost` from `../context.js`, add
`manifestHost: OpenManifestHost;` to `InstallWizard`, and to the returned object:

```ts
    manifestHost: async (input) => server.mountManifest(input),
```

In `packages/cli/src/init/commands.ts`'s `context`, after the `surface` line:

```ts
    ...(session.wizard === undefined ? {} : { manifestHost: session.wizard.manifestHost }),
```

In `packages/cli/src/init/github-app.ts`:
- `manifestFormPage` takes an optional nonce:

```ts
export function manifestFormPage(input: { actionUrl: string; manifest: GitHubManifest; nonce?: string }): string {
  const script = input.nonce === undefined ? "<script>" : `<script nonce="${escapeHtml(input.nonce)}">`;
  return [
    "<!doctype html><meta charset=\"utf-8\"><title>Create the AgentX GitHub App</title>",
    `<form id="manifest-form" method="post" action="${escapeHtml(input.actionUrl)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(input.manifest))}">`,
    "<p>Opening GitHub with the AgentX GitHub App filled in.</p><button type=\"submit\">Continue to GitHub</button></form>",
    `${script}document.getElementById("manifest-form").submit()</script>`,
  ].join("\n");
}
```

- `startManifestListener`'s `page` input type widens to `(redirectUrl: string, nonce?: string) => string`
  (it still calls `input.page(redirectUrl)`), and `ManifestListener` becomes
  `export type ManifestListener = ManifestHost;` (import `type ManifestHost` from `./context.js`).
- In `createWithManifest`, open whichever host the context has, and show the create card:

```ts
  const openHost: OpenManifestHost = context.manifestHost ?? startManifestListener;
  const listener = await openHost({
    state,
    page: (redirectUrl, nonce) => manifestFormPage({ actionUrl, manifest: githubAppManifest({ appName, redirectUrl }), ...(nonce === undefined ? {} : { nonce }) }),
    timeoutMs: GITHUB_WAIT_MS,
  });
  try {
    context.write(`Create the GitHub App "${appName}" for ${account}: GitHub opens with everything filled in; press Create GitHub App.`);
    context.surface?.card(githubCard({ stage: "create", appName, account, startUrl: listener.startUrl }));
```

  (the rest of the function is unchanged).
- In `githubAppStep.run`, show the install, repositories and done cards:
  - right after `const installUrl = ...;`, inside the `else` branch before `context.write(\`Install the app on ...\`)`:
    `context.surface?.card(githubCard({ stage: "install", slug: app.slug, account, installUrl }));`
  - inside `if (!told) { ... }`, after its `context.write`:
    `context.surface?.card(githubCard({ stage: "repositories", slug: app.slug, account, settingsUrl: installationSettingsUrl(accountType, account, installationId) }));`
  - right before `return { status: "done", ... }`:
    `context.surface?.card(githubCard({ stage: "done", slug: app.slug, account }));`

  Import `githubCard` from `./ui/cards.js` and `type OpenManifestHost` from `./context.js`.

- [ ] **Step 6: The GitHub card**

In `packages/cli/src/init/ui/cards.ts`:

```ts
export type GitHubCardInput =
  | { stage: "create"; appName: string; account: string; startUrl: string }
  | { stage: "install"; slug: string; account: string; installUrl: string }
  | { stage: "repositories"; slug: string; account: string; settingsUrl: string }
  | { stage: "done"; slug: string; account: string };

/** FR-030 and FR-031: creating the app, then the installation wait, as one card. */
export function githubCard(input: GitHubCardInput): WizardCard {
  const base = { id: "github" as const, title: "GitHub App" };
  switch (input.stage) {
    case "create": return {
      ...base, status: "waiting",
      lines: [`Create the GitHub App "${input.appName}" for ${input.account}. GitHub opens with everything filled in; press Create GitHub App.`, "This page moves on by itself once GitHub sends you back."],
      link: { url: input.startUrl, label: "Create the GitHub App" },
    };
    case "install": return {
      ...base, status: "waiting",
      lines: [`Install ${input.slug} on ${input.account} and choose the repositories AgentX may use.`, "Waiting for the installation. This page moves on by itself."],
      link: { url: input.installUrl, label: "Install the app and choose repositories" },
    };
    case "repositories": return {
      ...base, status: "waiting",
      lines: [`${input.slug} is installed but can see no repositories.`, "Choose at least one. This page moves on by itself."],
      link: { url: input.settingsUrl, label: "Choose repositories" },
    };
    case "done": return { ...base, status: "ok", lines: [`${input.slug} is installed on ${input.account}.`] };
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-github.test.ts tests/contract/init-github-app.test.ts tests/contract/init-ui-server.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS. `init-github-app.test.ts` (the terminal listener) passes unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/init/context.ts packages/cli/src/init/ui/server.ts packages/cli/src/init/ui/index.ts packages/cli/src/init/github-app.ts packages/cli/src/init/ui/cards.ts packages/cli/src/init/commands.ts tests/contract/init-ui-github.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): create and install the GitHub App through the wizard's own address"
```

---

### Task 6: Connect Slack: the create button, inline checks, and paste again

**Files:**
- Modify: `packages/cli/src/init/prompts.ts`, `packages/cli/src/init/ui/prompter.ts`, `packages/cli/src/init/slack-app.ts`, `packages/cli/src/init/ui/cards.ts`
- Test: `tests/contract/init-ui-prompter.test.ts` (append), `tests/contract/init-prompts.test.ts` (append), `tests/contract/init-ui-cli.test.ts` (append)

Depends on Q4 and Q8.

**Interfaces:**
- Consumes: Task 2's `retryOnPage`, `surface`.
- Produces: `Prompter.secret`'s options gain `validate?: (value: string) => string | undefined`;
  `fieldCheck(check: (value: string) => unknown): (value: string) => string | undefined`;
  `secretFromSource`'s input gains `validate?`; `slackAppCard(input: SlackCardInput): WizardCard`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/contract/init-ui-prompter.test.ts`:

```ts
describe("inline checks on a secret field (FR-040)", () => {
  it("secret runs the field check on the cleaned value, and shows its refusal without the value", async () => {
    const { hub, prompter } = setup();
    const answer = prompter.secret("Slack bot token", { flag: "--slack-bot-token", validate: fieldCheck(checkSlackBotToken) });
    const refusal = post(hub, "xoxp-9999-USERtokenVALUE");
    expect(refusal).toBe("that is a user token (xoxp-); paste the Bot User OAuth Token from OAuth & Permissions, which starts with xoxb-");
    expect(JSON.stringify(hub.snapshot())).not.toContain("USERtokenVALUE");
    // Review Focus 3: a paste with markers and a trailing newline is cleaned before the check.
    expect(post(hub, "\u001b[200~xoxb-1111-2222-SECRETbotTOKENvalue\u001b[201~\n")).toBeUndefined();
    await expect(answer).resolves.toBe("xoxb-1111-2222-SECRETbotTOKENvalue");
  });
});
```

(Import `fieldCheck` and `checkSlackBotToken` from `../../packages/cli/src/init/prompts.js`.)

Append to `tests/contract/init-prompts.test.ts`:

```ts
describe("fieldCheck and the terminal's secret prompt (spec 040 FR-040)", () => {
  it("turns a throwing check into a field message without the error code", () => {
    const check = fieldCheck(checkSlackSigningSecret);
    expect(check("0123456789abcdef0123456789abcdef")).toBeUndefined();
    expect(check("nothex")).toBe("a Slack signing secret is 32 lowercase hexadecimal characters (Basic Information, App Credentials, Signing Secret)");
  });

  it("the terminal's hidden prompt ignores validate, so a bad value still fails where it always did", async () => {
    const prompter = terminalPrompter({ readLine: async () => "", readSecret: async () => "not-a-token", write: () => undefined });
    await expect(prompter.secret("Slack bot token", { flag: "--slack-bot-token", validate: () => "refused" })).resolves.toBe("not-a-token");
  });
});
```

(Import `fieldCheck`, `checkSlackSigningSecret` and `terminalPrompter` in that file if not already.)

Append to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("FR-040: the Slack app is created from a button, and a wrong token is refused on the field", async () => {
    const h = await harness();
    const typo = "xoxp-9999-USERtokenVALUE";
    const { code, operator } = await h.runUi([...FIRST_RUN, "installed", typo, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, true, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    expect(operator.clicked.some((url) => url.startsWith("https://api.slack.com/apps?new_app=1&manifest_json="))).toBe(true);
    expect(operator.fieldErrors).toContain("that is a user token (xoxp-); paste the Bot User OAuth Token from OAuth & Permissions, which starts with xoxb-");
    expect(operator.asked.filter((question) => question === "Slack bot token")).toHaveLength(2);
    expect(JSON.stringify(operator.states)).not.toContain("USERtokenVALUE");
    expect(await h.everywhere()).not.toContain("USERtokenVALUE");
    const slack = operator.states.at(-1)?.cards?.find((card) => card.id === "slack");
    expect(slack).toMatchObject({ status: "ok", lines: ["Slack app A0APP is installed in workspace T0TEAM."] });
  });

  it("Q8: when Slack refuses a token that looks right, the page asks for both again and saves nothing until one works", async () => {
    const h = await harness();
    let tests = 0;
    const slack = fakeSlackApi({
      authTest: async () => { tests += 1; return tests === 1 ? { ok: false, error: "invalid_auth" } : { ok: true, user_id: "U0BOT", bot_id: "B0BOT", team_id: "T0TEAM", team: "Acme", url: "https://acme.slack.com/", user: "agentx" }; },
    });
    const operator = fakeWizardOperator([...FIRST_RUN, "installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, TEST_BOT_TOKEN, TEST_SIGNING_SECRET, true, true, ...SIGNIN, ...FINISH]);
    expect(await h.run(["--ui"], { openBrowser: operator.open, slack })).toBe(0);
    await operator.settled();
    expect(operator.asked).toContain("Paste the Slack bot token and signing secret again?");
    const refused = operator.states.flatMap((state) => state.cards ?? []).find((card) => card.id === "slack" && card.status === "failed");
    expect(refused?.lines).toContain("Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions");
  });

  it("Q8: the terminal path still stops when Slack refuses the token", async () => {
    const h = await harness();
    const slack = fakeSlackApi({ authTest: async () => ({ ok: false, error: "invalid_auth" }) });
    expect(await h.run([], { prompter: scriptedPrompter([...FIRST_RUN, "installed", TEST_BOT_TOKEN, TEST_SIGNING_SECRET]), slack })).not.toBe(0);
    expect(h.printed()).toContain("Slack refused the bot token (invalid_auth); copy it again from OAuth & Permissions");
  });
```

(Import `fakeSlackApi` there if it is not already.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-prompter.test.ts tests/contract/init-prompts.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL (`fieldCheck` is not exported; the typo is not refused on the field).

- [ ] **Step 3: `validate` on secrets, and `fieldCheck`**

In `packages/cli/src/init/prompts.ts`, change `Prompter.secret`'s signature and its doc:

```ts
  /** Hidden answer: nothing typed is echoed. A multiline request is refused up front on an
   * interactive prompt. `validate` is checked on the field by the install page (spec 040 FR-040);
   * the terminal's hidden prompt ignores it, and the caller's own check still runs after. */
  secret(question: string, options: PromptFlag & { multiline?: boolean; validate?: (value: string) => string | undefined }): Promise<string>;
```

Add below `stripPasteMarkers`:

```ts
/** A check that throws (checkSlackBotToken and the like) as a field validator: the refusal's own
 * words, without the error code. The checks never quote the value, so neither does this. */
export function fieldCheck(check: (value: string) => unknown): (value: string) => string | undefined {
  return (value) => {
    try {
      check(value);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message.replace(/^[A-Z_]+: /, "") : "that value is not valid";
    }
  };
}
```

In `secretFromSource`, add `validate?: (value: string) => string | undefined;` to its input, and
pass it with the prompt only (a file or an environment variable has no field):

```ts
  const secretOptions = {
    flag: input.flag,
    ...(input.multiline === true ? { multiline: true } : {}),
    ...(input.validate === undefined ? {} : { validate: input.validate }),
  };
  return clean(await input.prompter.secret(input.what, secretOptions));
```

- [ ] **Step 4: The page's secret field runs it**

In `packages/cli/src/init/ui/prompter.ts`, give `secretCheck` the validator:

```ts
function secretCheck(what: string, multiline: boolean, validate?: (value: string) => string | undefined): AnswerCheck {
  return (raw) => {
    const value = stripPasteMarkers(raw).trim();
    if (value === "") return { error: `the ${what} is empty` };
    if (!multiline && /\s/.test(value)) return { error: `the ${what} contains spaces or line breaks; copy it again and paste only the value` };
    const problem = validate?.(value);
    return problem === undefined ? { value } : { error: problem };
  };
}
```

and in `secret`: `secretCheck(question, multiline, options.validate)`.

- [ ] **Step 5: The Slack card**

In `packages/cli/src/init/ui/cards.ts`:

```ts
export type SlackCardInput =
  | { stage: "create"; appName: string; createUrl: string }
  | { stage: "credentials"; appName: string }
  | { stage: "bot"; user: string; team: string }
  | { stage: "refused"; problem: string }
  | { stage: "approval"; appName: string; rerun: string }
  | { stage: "done"; appId: string; teamId: string };

/** FR-040: the Slack app, from the create button to its stored credentials. */
export function slackAppCard(input: SlackCardInput): WizardCard {
  const base = { id: "slack" as const, title: "Slack app" };
  switch (input.stage) {
    case "create": return {
      ...base, status: "waiting",
      lines: [
        `Create the Slack app "${input.appName}" from AgentX's manifest: pick the workspace, press Next, then Create, then Install to Workspace.`,
        "If your workspace needs an admin to approve new apps, choose Request to Install, then answer Not yet below.",
      ],
      link: { url: input.createUrl, label: "Create the Slack app" },
    };
    case "credentials": return {
      ...base, status: "waiting",
      lines: [
        "Paste the Bot User OAuth Token (OAuth & Permissions) and the Signing Secret (Basic Information, App Credentials) below.",
        "Both go straight to AWS Secrets Manager and are never shown again.",
      ],
    };
    case "bot": return { ...base, status: "waiting", lines: [`Slack says this token belongs to the bot @${input.user} in workspace ${input.team}.`] };
    case "refused": return { ...base, status: "failed", lines: [input.problem, "Nothing was saved."] };
    case "approval": return { ...base, status: "waiting", lines: [`Slack is waiting for a workspace admin to approve "${input.appName}".`, `Once it is installed, run ${input.rerun}; it continues here.`] };
    case "done": return { ...base, status: "ok", lines: [`Slack app ${input.appId} is installed in workspace ${input.teamId}.`] };
  }
}
```

- [ ] **Step 6: Show it, check inline, and paste again on the page**

In `packages/cli/src/init/slack-app.ts`, import `fieldCheck` from `./prompts.js`, `retryOnPage`
from `./retry.js`, and `slackAppCard, type SlackCardInput` from `./ui/cards.js`.

Move the bot checks (today's lines from `const common = ...` to the confirm's `throw`) into a
function beside `slackAppStep`, so a refused token can be pasted again on the page:

```ts
interface SlackBot { botToken: string; signingSecret: string; appId: string; teamId: string; botUserId: string }

/** The two credentials, checked on their fields (FR-040) and then with Slack, and the operator's
 * word that this is the right bot. Throws, and saves nothing, when any of it fails. */
async function collectBot(context: InitContext, api: SlackApi, progress: ProgressHandle, show: (card: SlackCardInput) => void): Promise<SlackBot> {
  const common = { processEnv: context.processEnv, prompter: context.prompter };
  const botToken = checkSlackBotToken(await secretFromSource({ ...common, what: "Slack bot token", flag: "--slack-bot-token", source: context.secretFlags.slackBotToken ?? {}, validate: fieldCheck(checkSlackBotToken) }));
  const signingSecret = checkSlackSigningSecret(await secretFromSource({ ...common, what: "Slack signing secret", flag: "--slack-signing-secret", source: context.secretFlags.slackSigningSecret ?? {}, validate: fieldCheck(checkSlackSigningSecret) }));

  const auth = await api.authTest(botToken);
  if (!auth.ok) throw agentXError("CONFIG_INVALID", `Slack refused the bot token (${auth.error ?? "no reason given"}); copy it again from OAuth & Permissions`);
  if (auth.bot_id === undefined || auth.user_id === undefined || auth.team_id === undefined) {
    throw agentXError("CONFIG_INVALID", "that token does not belong to a bot user; paste the Bot User OAuth Token (it starts with xoxb-)");
  }
  const earlier = progress.current().slack;
  if (earlier !== undefined && earlier.teamId !== auth.team_id) {
    throw agentXError("CONFIG_INVALID", `that token belongs to Slack workspace ${auth.team_id}, but this install uses ${earlier.teamId}; nothing was saved`);
  }
  const info = await api.botsInfo(botToken, auth.bot_id);
  const appId = info.bot?.app_id;
  if (!info.ok || appId === undefined) {
    throw agentXError("RUNTIME_UNAVAILABLE", `Slack bots.info did not return the app id (${info.error ?? "no app_id"}); run agentx init again`);
  }

  const where = auth.url === undefined ? "" : ` (${auth.url})`;
  context.write(`Bot @${auth.user ?? auth.user_id} in workspace ${auth.team ?? auth.team_id}${where}`);
  show({ stage: "bot", user: auth.user ?? auth.user_id, team: auth.team ?? auth.team_id });
  if (!(await context.prompter.confirm("Is this the AgentX bot in the right workspace?", { defaultValue: true }))) {
    throw agentXError("CONFIG_INVALID", "nothing was saved; copy the Bot User OAuth Token from the AgentX app in the right workspace, then run agentx init again");
  }
  return { botToken, signingSecret, appId, teamId: auth.team_id, botUserId: auth.user_id };
}
```

In `slackAppStep.run`:
- declare `const show = (card: SlackCardInput) => context.surface?.card(slackAppCard(card));` after
  `const url = ...;`;
- call `show({ stage: "create", appName, createUrl: url });` at the end of both the `resuming` and
  the new-app branch (after their writes and `openBrowser`);
- in the `approval` branch, before its `return`:

```ts
        show({ stage: "approval", appName, rerun: `agentx init --env ${env} --region ${context.answers.region}` });
```

- replace everything from `context.write("Copy the Bot User OAuth Token ...")` to the end of `run`
  with:

```ts
      context.write("Copy the Bot User OAuth Token from OAuth & Permissions, and the Signing Secret from Basic Information, App Credentials.");
      show({ stage: "credentials", appName });
      // Q8: on the page, a token Slack refuses is pasted again; the terminal stops, as before.
      const bot = await retryOnPage({
        surface: context.surface, prompter: context.prompter, question: "Paste the Slack bot token and signing secret again?",
        failed: (problem) => show({ stage: "refused", problem }),
        run: () => collectBot(context, api, progress, show),
      });

      // Read, merge, write: a concurrent writer (this step alongside `agentx signin enable slack`)
      // could lose an update. Left for admins to avoid by running one at a time.
      await context.secrets.put(slackSecretName(env), slackSecretWithBot(await context.secrets.get(slackSecretName(env)), { signingSecret: bot.signingSecret, botToken: bot.botToken }));
      await progress.update({ slack: { appId: bot.appId, teamId: bot.teamId, botUserId: bot.botUserId } });
      show({ stage: "done", appId: bot.appId, teamId: bot.teamId });
      return { status: "done", note: `Slack app ${bot.appId} in workspace ${bot.teamId}` };
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-prompter.test.ts tests/contract/init-prompts.test.ts tests/contract/init-slack-app.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts`
Expected: PASS. `init-slack-app.test.ts` (every terminal Slack case) passes unchanged.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/src/init/prompts.ts packages/cli/src/init/ui/prompter.ts packages/cli/src/init/slack-app.ts packages/cli/src/init/ui/cards.ts tests/contract/init-ui-prompter.test.ts tests/contract/init-prompts.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init-ui): the Slack screen: a create button, inline credential checks, and paste again"
```

---

### Task 7: The Request URL check as a live card

**Files:**
- Modify: `packages/cli/src/init/slack-app.ts`, `packages/cli/src/init/ui/cards.ts`
- Test: `tests/contract/init-slack-app.test.ts` (append)

Depends on Q7.

**Interfaces:**
- Consumes: Task 2's `retryOnPage`.
- Produces: `probeSlackUrls`'s input gains `onWaiting?: () => void`;
  `slackUrlsCard(input: SlackUrlsCardInput): WizardCard`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("verifying the Slack URLs after the Slack service deploys", ...)` in
`tests/contract/init-slack-app.test.ts`:

```ts
  const withSlack = () => progressHandle({ ...emptyProgress("staging", T0), slack: { appId: "A0APP", teamId: "T0TEAM", botUserId: "U0BOT" } });
  const page = () => { const cards: WizardCard[] = []; return { cards, card: (card: WizardCard) => { cards.push(card); } }; };

  it("FR-041: on the page, a check Slack has not verified runs again, and the card shows each stage", async () => {
    const surface = page();
    // Not verified; yes, run it again; verified.
    const context = slackContext([false, true, true], { fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET, staleFor: 1 }), surface });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await verifySlackUrls(context, withSlack());
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual([
      "Does Slack show the Request URL as Verified?", "Run the Request URL check again?", "Does Slack show the Request URL as Verified?",
    ]);
    expect(surface.cards.map((card) => [card.id, card.status])).toEqual([
      ["slack-urls", "running"], ["slack-urls", "running"], ["slack-urls", "waiting"], ["slack-urls", "failed"],
      ["slack-urls", "running"], ["slack-urls", "waiting"], ["slack-urls", "ok"],
    ]);
    expect(surface.cards[1]?.lines).toContain("The Slack service keeps the old signing secret for up to 5 minutes; checking again every 15 seconds.");
    expect(surface.cards[3]?.link).toEqual({ url: "https://api.slack.com/apps/A0APP/event-subscriptions", label: "Open Event Subscriptions" });
    expect(JSON.stringify(surface.cards)).not.toContain(TEST_SIGNING_SECRET);
  });

  it("FR-041: without a page, a check Slack has not verified still stops at once and asks nothing more", async () => {
    const context = slackContext([false], { fetch: slackIngressFetch({ signingSecret: TEST_SIGNING_SECRET }) });
    context.secrets.values.set(SLACK_SECRET, JSON.stringify({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN }));
    await expect(verifySlackUrls(context, withSlack())).rejects.toThrow("Slack has not verified");
    expect((context.prompter as ReturnType<typeof scriptedPrompter>).asked).toEqual(["Does Slack show the Request URL as Verified?"]);
  });
```

(Import `type WizardCard` from `../../packages/cli/src/init/ui/protocol.js`. `slackIngressFetch`'s
`staleFor: 1` answers the first request 401, the cached old secret, which is what makes
`probeSlackUrls` call `onWaiting` and show the second `running` card.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-slack-app.test.ts`
Expected: FAIL (the first test throws "Slack has not verified" after one question).

- [ ] **Step 3: The Request URL card**

In `packages/cli/src/init/ui/cards.ts`:

```ts
export type SlackUrlsCardInput =
  | { stage: "checking"; eventsUrl: string }
  | { stage: "waiting-for-secret"; eventsUrl: string }
  | { stage: "verify"; pageUrl: string }
  | { stage: "failed"; problem: string; pageUrl: string }
  | { stage: "done"; eventsUrl: string };

/** FR-041: the Request URL check, live, and run again after a fix. */
export function slackUrlsCard(input: SlackUrlsCardInput): WizardCard {
  const base = { id: "slack-urls" as const, title: "Slack Request URL" };
  const events = { url: "", label: "Open Event Subscriptions" };
  switch (input.stage) {
    case "checking": return { ...base, status: "running", lines: [`Sending ${input.eventsUrl} a signed test request, the way Slack will.`] };
    case "waiting-for-secret": return {
      ...base, status: "running",
      lines: [`Sending ${input.eventsUrl} a signed test request, the way Slack will.`, "The Slack service keeps the old signing secret for up to 5 minutes; checking again every 15 seconds."],
    };
    case "verify": return {
      ...base, status: "waiting",
      lines: ["AgentX answers Slack's URL check.", "Open Event Subscriptions. If the Request URL is not marked Verified, press Retry there, then answer below."],
      link: { ...events, url: input.pageUrl },
    };
    case "failed": return { ...base, status: "failed", lines: [input.problem, "Fix it, then answer Yes below to run the check again."], link: { ...events, url: input.pageUrl } };
    case "done": return { ...base, status: "ok", lines: [`Slack has verified ${input.eventsUrl}.`] };
  }
}
```

- [ ] **Step 4: `onWaiting`, and the check that can run again**

In `probeSlackUrls`, add `onWaiting?: () => void;` to the input, and call it where it writes the
waiting line:

```ts
    if (!told) {
      input.write("Waiting for the Slack ingress to pick up the new signing secret (it keeps the old one for up to 5 minutes)");
      input.onWaiting?.();
      told = true;
    }
```

Replace `verifySlackUrls` with:

```ts
export async function verifySlackUrls(context: InitContext, progress: ProgressHandle): Promise<void> {
  const name = slackSecretName(context.env);
  const signingSecret = storedSigningSecret(await context.secrets.get(name));
  if (signingSecret === undefined) throw agentXError("CONFIG_INVALID", `secret ${name} holds no Slack signing secret; run agentx init again to repeat the Slack app step`);
  const { eventsUrl, interactivityUrl } = await controlPlaneSlackUrls(context);
  const appId = progress.current().slack?.appId;
  const page = appId === undefined ? "https://api.slack.com/apps" : `https://api.slack.com/apps/${appId}/event-subscriptions`;
  const show = (card: SlackUrlsCardInput) => context.surface?.card(slackUrlsCard(card));
  // FR-041 (Q7): on the page, a failed check runs again after the fix; the terminal stops, as before.
  await retryOnPage({
    surface: context.surface, prompter: context.prompter, question: "Run the Request URL check again?",
    failed: (problem) => show({ stage: "failed", problem, pageUrl: page }),
    run: async () => {
      show({ stage: "checking", eventsUrl });
      await probeSlackUrls({
        eventsUrl, interactivityUrl, signingSecret, fetch: context.fetch, now: context.now, sleep: context.sleep, write: context.write,
        onWaiting: () => show({ stage: "waiting-for-secret", eventsUrl }),
      });
      context.write(`AgentX now answers Slack's URL check. Open ${page}; if the Request URL is not marked Verified, press Retry.`);
      show({ stage: "verify", pageUrl: page });
      if (context.openBrowser !== undefined) await context.openBrowser(page);
      if (!(await context.prompter.confirm("Does Slack show the Request URL as Verified?", { defaultValue: true }))) {
        throw agentXError("CONFIG_INVALID", `Slack has not verified ${eventsUrl}. On ${page}, press Retry; if it still fails, look for invalid_signature in the control plane's SlackIngress logs, then run agentx init again`);
      }
    },
  });
  show({ stage: "done", eventsUrl });
}
```

The terminal path's order is unchanged: probe, the write, `openBrowser`, the confirm.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-slack-app.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts tests/contract/doctor*.test.ts`
Expected: PASS (`doctor` also calls `probeSlackUrls`; it passes no `onWaiting`).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/slack-app.ts packages/cli/src/init/ui/cards.ts tests/contract/init-slack-app.test.ts
git commit -m "feat(init-ui): the Slack Request URL check as a live card that can run again"
```

---

### Task 8: The connect screens end to end

**Files:**
- Test: `tests/contract/init-ui-cli.test.ts` (append)

This task changes no production code unless a test finds a defect (then the defect is fixed in the
task that owns the code, test first).

**Interfaces:**
- Consumes: every earlier task.

- [ ] **Step 1: Write the end-to-end tests**

```ts
  it("User Story 2: a first install shows each connect screen in order, each ends ok, and nothing was copied by hand", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    expect(code).toBe(0);
    const last = operator.states.at(-1);
    expect(last?.cards?.map((card) => [card.id, card.status])).toEqual([
      ["aws", "ok"], ["prerequisites", "ok"], ["github", "ok"], ["slack", "ok"], ["slack-urls", "ok"],
    ]);
    // Every answer came from the scripted operator, and no answer was an address pasted back:
    // the GitHub code arrived through the wizard's own callback.
    expect(operator.asked).not.toContain("Paste that address (or just its code)");
    expect(operator.opened).toHaveLength(1);
  });

  it("FR-012: no secret reaches a card, a link, the page's state, the log, the terminal, SSM or the cache", async () => {
    const h = await harness();
    const { code, operator } = await h.runUi([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH_WITH_LINEAR]);
    expect(code).toBe(0);
    const cards = JSON.stringify(operator.states.map((state) => [state.cards, state.link]));
    for (const secret of [TEST_BOT_TOKEN, TEST_SIGNING_SECRET, "fedcba9876543210fedcba9876543210", LINEAR_KEY, TEST_PRIVATE_KEY.split("\n")[1] ?? "missing"]) {
      expect(secret.length).toBeGreaterThan(10);
      expect(cards).not.toContain(secret);
      expect(JSON.stringify(operator.states)).not.toContain(secret);
      expect(await h.everywhere()).not.toContain(secret);
    }
  });

  it("a page that reconnects mid-install gets every card back in its snapshot", async () => {
    const h = await harness();
    const { operator } = await h.runUi([...FIRST_RUN.slice(0, -1), false]);
    const review = operator.states.find((state) => state.question?.text === "Create all of this?");
    expect(review?.cards?.map((card) => card.id)).toEqual(["aws", "prerequisites"]);
  });
```

(Import `TEST_PRIVATE_KEY` from `../support/init-fakes.js`; its second line is a base64 line of
the GitHub App's private key, which the conversion hands to the CLI.)

- [ ] **Step 2: Run the whole suite**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/contract/init-ui-cli.test.ts
git commit -m "test(init-ui): the connect screens end to end, and no secret on any card"
```

---

### Task 9: Record the rulings and the owner's answers in the spec

This task changes no code. It writes this phase's rulings, and the owner's answers to
[questions.md](questions.md) as given (not as recommended, where the owner chose otherwise), into
the spec. If an answer differs from a recommendation this plan followed, stop: the owning task
changes first, with its test, then this task records it.

**Files:**
- Modify: `specs/040-install-ui/spec.md`

- [ ] **Step 1: Amend the spec**
  - FR-011: add "One exception (Q6): `GET /github/created`, only while the GitHub App step waits
    for the manifest code, only with the manifest flow's `state` (compared in constant time), once,
    and only with the listener's own `Host`. Its answer loads nothing and sends no Referer."
  - FR-012: add "In the page, a masked field is emptied as soon as its value is sent, and the
    question area is emptied once the answer is taken (Q4)."
  - FR-020: add "The profiles are read from the AWS CLI's config and credentials files; with two or
    more, the page asks which; the choice is not stored (Q9)."
  - FR-021: add "The sign-in action is `aws sso login --profile <name>` for an IAM Identity Center
    profile and `aws login --profile <name>` for an `aws login` profile; other profiles get Check
    again only (Q9)."
  - FR-023, FR-041: add "Checking again is offered on the page only; the terminal path stops as
    before (Q7)."
  - FR-040: add "A token Slack refuses is pasted again on the page (Q8)."
  - FR-030: add "The terminal path keeps its one-time listener."
  - Decisions: add "**Cards.** The page's connect and finishing screens are status cards built in
    `ui/cards.ts` from facts a step already has; no card builder takes a secret. Steps reach the
    page through an optional `InstallSurface` on the init context, so the terminal path is
    unchanged (phase 2)." and under Phasing: "Phase 2 built (PR #<n>)."
- [ ] **Step 2: Check the copy** with `grep -c "$(printf '\342\200\224')" specs/040-install-ui/spec.md` (prints 0), then commit:

```bash
git add specs/040-install-ui/spec.md
git commit -m "docs(spec-040): record the phase 2 rulings and the owner's answers"
```

---

### Task 10: Live check (deferred to the combined final live check) in a throwaway environment (owner present)

> **Deferred to the combined final live check (owner, 2026-09-30).** No live testing happens until
> spec 025 phases 25d and 25e and spec 040 phases 2 to 4 are all built. This task is not run when
> this phase is built; its steps below are kept as the checklist for that one final check, run in a
> single throwaway environment, with the owner's go-ahead.


This task changes no code unless it finds a defect. A defect is fixed with a failing test first,
in the task that owns the code, then reviewed. It tests the real connect screens: a real browser,
real AWS, a real GitHub App manifest flow redirecting to the wizard, a real Slack app. It needs:
- the owner's explicit go-ahead;
- an admin AWS session for account 944937319445 (`aws login --profile agentx-admin`, driven from
  this session, the owner's preference), because the access stack creates IAM roles;
- **no other throwaway environment in the account**: only one fits at a time (the Elastic IP
  quota). Confirm no `agentx-live*` stack exists before Step 3;
- a Slack workspace and a GitHub organization or account for tests, and a test repository the
  owner names. Never production's Slack app, GitHub App, stacks, secrets or `/agentx/production/*`;
- a browser on the owner's Mac.

It uses a new environment, `live40b`, in `us-east-1`.

- [ ] **Step 1: Prepare (read-only)**
  - Build a release from this branch: `npm run release:build -- --version 0.0.6 --out <scratch>/rel`.
  - Read production's image digests, read-only, exactly as 25b's live check did.
  - Confirm `aws ssm get-parameters-by-path --path /agentx/live40b --recursive --region us-east-1`
    returns nothing, that no `agentx-live*` stack exists, and that no EC2 instance, volume or
    Elastic IP is tagged for a `live*` environment.
- [ ] **Step 2: Owner approval.** Tell the owner what it creates (the environment's stacks, a
  GitHub App and a Slack app in their test organization and workspace, EC2 worker time for the test
  reply), the cost (about $3 a day for the stacks while it exists, torn down the same day), and that
  everything is removed in Step 8.
- [ ] **Step 3: The AWS screen (FR-020, FR-021).** With the owner's agreement, sign the profile out
  first (`aws logout --profile agentx-admin`). Run
  `node packages/cli/dist/main.js --env live40b init --ui --release <scratch>/rel --worker-image <worker digest ref> --slack-image <slack digest ref>`.
  - The page opens on 127.0.0.1 and lists this Mac's profiles; pick `agentx-admin`.
  - The AWS card shows the signed-out state and offers "Sign in (aws login --profile agentx-admin)";
    choose it, sign in in the tab it opens, and the card then shows account 944937319445 and the
    role ARN.
  - The region picker lists only the release's regions (FR-022).
- [ ] **Step 4: The prerequisites (FR-023).** The checklist shows each check with a tick. If the
  account happens to fail one, fix it and choose Yes to check again; otherwise record that the
  re-run rests on the contract tests. Confirm the plan's review screen, then the install starts.
- [ ] **Step 5: GitHub (FR-030, FR-031).** Press "Create the GitHub App": GitHub opens with the
  manifest filled in; press Create GitHub App. GitHub sends the browser to
  `http://127.0.0.1:<the wizard's port>/github/created`, the tab says "go back to the Install AgentX
  tab", and the card moves to the installation wait by itself. Install the app on the test
  repository; the card resolves to done. In the browser's developer tools, confirm the form page's
  CSP header and that the form submission to github.com was not blocked by `form-action`.
- [ ] **Step 6: Slack (FR-040, FR-041).** Press "Create the Slack app", create and install it. Paste
  a user token (`xoxp-...`) first: the field says it is a user token, and the page shows no part of
  it. Paste the bot token and the signing secret. After the Slack service deploys, the Request URL
  card shows the probe, then "Open Event Subscriptions"; answer No once and Yes to run it again, then
  Yes once Slack shows Verified. Finish the rest of the install on the page (phase 1's generic
  questions) through the test reply.
- [ ] **Step 7: No secret leaked (FR-012).** Search the terminal scrollback, `~/.agentx`, the SSM
  parameters under `/agentx/live40b`, and the browser's saved passwords for the bot token, the
  signing secret, the Slack client secret and the private key's first base64 line: no match. The
  browser offered to save none of the masked fields.
- [ ] **Step 8: Tear down**, exactly as 25c's Task 18 Step 12 for `live40b` (every tagged instance
  and volume, the stacks and what they retain, the secrets and parameters, the GitHub App and the
  Slack app, the local sign-in), then confirm no `agentx-live40b-*` stack, no `/agentx/live40b`
  parameter and no `live40b` instance, volume or Elastic IP remains.
- [ ] **Step 9: Record the evidence** in the PR description: the commands, what each screen showed,
  each defect fixed, and any finding that changes a ruling above. Raise those with the owner before
  merge.

## Not in this phase

- **Phase 3:** the finishing screens (admin user and sign-in, project, channel bind, connectors,
  alerts, the test reply, the ready screen). In this phase they still work on the page as phase 1's
  generic questions.
- **Phase 4:** the page on by default, the closed-tab reminder, packaging and docs.
- **Not planned:** an `--profile` flag for the terminal path (Q9's option B); Windows browser
  support (Q12); a DOM-level test of the page's module (the page is checked by its text and by the
  live check, as in phase 1).

## Self-review

- **Spec coverage.** FR-020: Task 3 (profiles, the question, the account card before the plan).
  FR-021: Task 3 (`resolveCaller`'s sign-in). FR-022: the release's regions, pinned in Task 3.
  FR-023: Task 4. FR-030: Task 5 (both routes on the wizard's origin; the `state` check kept, now in
  constant time). FR-031: Task 5 (the install and repositories cards, resolving by themselves).
  FR-040: Task 6 (the create button, masked fields, the two checks inline). FR-041: Task 7. FR-011's
  one exception and FR-012's page rules: Tasks 1 and 5. User Story 2's independent test: Task 8 and
  Task 10. SC-001 (inline validation of secrets): Task 6; SC-002 (the new routes' refusals): Task 5;
  SC-003 (headless install through the UI): Task 8; SC-004: every task's gate runs the terminal
  tests unchanged.
- **Placeholder scan.** Every code step shows its code, and the facts the tests lean on (the
  sample answers' region, the first run's default app name `AgentX acme staging`,
  `slackIngressFetch`'s `staleFor`) were checked against the code when this plan was written.
- **Type consistency.** `WizardCard`, `WizardLink`, `WizardCheck`, `CardId` and `CardStatus` are
  Task 1's, used unchanged by every card builder. `InstallSurface` (Task 2) is the one seam steps
  use; `ManifestHost` and `OpenManifestHost` (Task 5) live in `context.ts` so `github-app.ts`,
  `server.ts` and `index.ts` share them without a cycle. `PrerequisiteCheck` (Task 4) has the same
  fields as `WizardCheck`, and `prerequisitesCard` copies it. `retryOnPage`'s input is the same in
  Tasks 4, 6 and 7. `SlackCardInput` and `SlackUrlsCardInput` are separate cards on purpose: the app
  and its Request URL are different steps.
- **Review Focus.** Each line has its test in the owning task: 1 and 2 in Task 5, 3 in Task 6, 4 in
  Task 3, 5 in Task 4.
- **The owner's answers (2026-09-30).** All thirteen as recommended, so no task changes; the live
  check is deferred to the combined final live check (owner, 2026-09-30).
