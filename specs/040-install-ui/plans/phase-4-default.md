# Spec 040 Phase 4: The Page by Default, Packaging and Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `agentx init` with neither `--ui` nor `--no-ui` opens the install page when it runs in an
interactive terminal on a machine that can open a browser, and asks in the terminal everywhere
else (`--yes`, CI, CloudShell, SSH, no terminal), saying in one line how to get the page. A closed
tab no longer leaves the run waiting in silence. The page ships inside the published npm package,
and the README and `docs/install.md` describe the page and `--no-ui`.

**Architecture:**
- **One decision function.** `resolveUiMode` turns `--ui`/`--no-ui`, `--yes`, `--no-browser`, an
  injected prompter, "is this an interactive terminal" and "can this machine open a browser" into
  `page` or `terminal` (FR-001, Q1). `browserAvailable` reads the platform and the environment
  (Q2, Q12). Both are injectable through `InitCliDependencies`, so tests decide them.
- **A closed-tab reminder (Q3).** The hub counts connected pages. When a question waits and no page
  has been connected for 60 seconds, the terminal says once where to reopen it.
- **Packaging (FR-060, Q11).** The page is compiled code inside the CLI's one bundled file (phase 1's
  choice). The pack test proves it is in the installed package and that `init --help` shows the
  page flags.
- **Docs (FR-061).** The install guide and the README describe the page, what it shows, `--no-ui`,
  and SSH use.

**Tech Stack:** TypeScript 5.9 strict, Node 22.19 to 22.x, commander 15, Vitest, esbuild (the
existing pack). No new dependency.

**Spec:** [../spec.md](../spec.md), the binding authority. Phase 4 delivers the Decisions' phase 4
row: FR-001's default, FR-060, FR-061, and User Story 4 (headless installs keep working; a host
with no browser falls back to the terminal). Open decisions are in [questions.md](questions.md);
this plan follows every recommendation, and a task that depends on one says "Depends on Q<n>".

**Phases:** [phase-2-connect.md](phase-2-connect.md), [phase-3-finish.md](phase-3-finish.md), then
this plan. Both must be merged first: turning the page on by default before its screens exist
would ship phase 1's generic questions as the default experience.

**Branch:** `feat/040d-default`, cut from mainline after phase 3 merges. One PR against `mainline`.

## Global Constraints

- **Headless installs do not change (User Story 4, SC-004).** `--yes`, a session with no terminal,
  CI, and every existing `agentx init` test behave exactly as before. An injected prompter always
  means no page unless `--ui` is given, so every existing test keeps its path.
- **`--ui` and `--no-ui` keep their meaning:** `--ui` always starts the page (and is still refused
  with `--yes`); `--no-ui` always means the terminal.
- **`--no-browser` means no default page.** With neither `--ui` nor `--no-ui`, `--no-browser` is
  read as "this machine has no browser to open": the terminal is used, with Q2's line. `--ui
  --no-browser` still starts the page and prints its address.
- **Loopback only, the token, and FR-012** hold as in phases 1 to 3; nothing here changes the
  server.
- **Exact names and values:**
  - `resolveUiMode`, `browserAvailable`, `NO_BROWSER_LINE`, `PAGE_CLOSED_MS = 60_000`,
    `pageClosedLine(url)`;
  - `InitCliDependencies.isInteractive?: () => boolean`, `InitCliDependencies.browserAvailable?: () => boolean`;
  - the help texts: `--ui` "ask every question on a page on 127.0.0.1 (the default in an
    interactive terminal that can open a browser)", `--no-ui` "ask every question in the terminal".
- **Copy:** plain words; no em dashes in any help text, terminal line, doc or test fixture that a
  person reads.
- **The gate:** `npm run typecheck && npm run lint && npm run build && npm test`. Task 3's pack test
  is slow (about 5 minutes); run it alone while iterating.
  - Node 22: `export PATH=/private/tmp/claude-501/node-v22.20.0-darwin-arm64/bin:$PATH`.
- **Existing suites:** no assertion removed or weakened; never `vitest -u`. The pack test gains
  assertions only.
- **Build process:** the owner approves this plan before building; subagent-driven development.

## Review Focus

1. **An SSH session to a Mac** (`platform` is `darwin`, so `open` would work, but it would open on
   the far screen). Expected: no default page; the terminal, with Q2's line. Pinned in Task 1
   (`init-ui-mode.test.ts`, "an SSH session never opens a page by default, even on macOS").
2. **A Linux desktop session with no `DISPLAY` or `WAYLAND_DISPLAY`** (a server console, a
   container with a TTY). Expected: the terminal. Pinned in Task 1 ("Linux needs a display").
3. **The page reloads** (the operator presses reload in the middle of a question). Expected: the
   page reconnects within seconds, so no reminder is printed. Pinned in Task 2 ("a page that
   reconnects within a minute gets no reminder").
4. **A question waits for a long time with the page open** (the operator went for coffee).
   Expected: no reminder, because a page is connected. Pinned in Task 2 ("no reminder while a page
   is connected").
5. **`agentx init` run by a script with a terminal attached but `--yes`** (an operator's own
   wrapper). Expected: the terminal path exactly as before; no page. Pinned in Task 1 ("--yes is
   the terminal, whatever else holds").

---

## File map

| File | Responsibility | Task |
|---|---|---|
| `packages/cli/src/init/ui-mode.ts` (create) | `resolveUiMode`, `browserAvailable`, `NO_BROWSER_LINE` | 1 |
| `packages/cli/src/init/commands.ts` (modify) | the default; the new dependencies; Q2's line | 1 |
| `packages/cli/src/main.ts` (modify) | the two help texts; the options' doc comments | 1 |
| `packages/cli/src/init/ui/state.ts` (modify) | `connected()` | 2 |
| `packages/cli/src/init/ui/index.ts` (modify) | the closed-tab reminder | 2 |
| `tests/contract/init-ui-mode.test.ts` (create) | Task 1 | 1 |
| `tests/contract/init-ui-reminder.test.ts` (create) | Task 2 | 2 |
| `tests/contract/init-ui-cli.test.ts` (modify: appended) | the default end to end | 1 |
| `tests/contract/release-pack-cli.test.ts` (modify: assertions appended) | FR-060 | 3 |
| `docs/install.md`, `README.md` (modify) | FR-061 | 4 |
| `tests/contract/install-docs.test.ts` (create) | FR-061 | 4 |
| `specs/040-install-ui/spec.md` (modify) | the rulings, the answers, status | 5 |

---

### Task 1: The page by default

**Files:**
- Create: `packages/cli/src/init/ui-mode.ts`
- Modify: `packages/cli/src/init/commands.ts`, `packages/cli/src/main.ts`
- Test: `tests/contract/init-ui-mode.test.ts` (create), `tests/contract/init-ui-cli.test.ts` (append)

Depends on Q1, Q2 and Q12.

**Interfaces:**
- Produces:
  - `type InitUiMode = { mode: "page" } | { mode: "terminal"; noBrowser?: true }`;
  - `resolveUiMode(input: { ui: boolean | undefined; yes: boolean; injectedPrompter: boolean; interactive: boolean; browser: boolean }): InitUiMode`;
  - `browserAvailable(input: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): boolean`;
  - `NO_BROWSER_LINE: string`;
  - `InitCliDependencies.isInteractive?`, `InitCliDependencies.browserAvailable?`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-mode.test.ts
// FR-001 (Q1, Q2, Q12): with neither --ui nor --no-ui, agentx init uses the install page in an
// interactive terminal on a machine that can open a browser, and the terminal everywhere else.
import { describe, expect, it } from "vitest";
import { browserAvailable, resolveUiMode } from "../../packages/cli/src/init/ui-mode.js";

const base = { ui: undefined, yes: false, injectedPrompter: false, interactive: true, browser: true };

describe("which way agentx init asks", () => {
  it("the page by default in an interactive terminal that can open a browser", () => {
    expect(resolveUiMode(base)).toEqual({ mode: "page" });
  });

  it("--ui is always the page, and --no-ui always the terminal", () => {
    expect(resolveUiMode({ ...base, ui: true, interactive: false, browser: false })).toEqual({ mode: "page" });
    expect(resolveUiMode({ ...base, ui: false })).toEqual({ mode: "terminal" });
  });

  it("Review Focus 5: --yes is the terminal, whatever else holds", () => {
    expect(resolveUiMode({ ...base, yes: true })).toEqual({ mode: "terminal" });
  });

  it("an injected prompter (a test, or a caller with its own) is the terminal unless --ui is given", () => {
    expect(resolveUiMode({ ...base, injectedPrompter: true })).toEqual({ mode: "terminal" });
    expect(resolveUiMode({ ...base, injectedPrompter: true, ui: true })).toEqual({ mode: "page" });
  });

  it("no terminal is the terminal path (which then refuses, as before, without --yes)", () => {
    expect(resolveUiMode({ ...base, interactive: false })).toEqual({ mode: "terminal" });
  });

  it("no browser is the terminal, marked so init says how to get the page", () => {
    expect(resolveUiMode({ ...base, browser: false })).toEqual({ mode: "terminal", noBrowser: true });
  });
});

describe("whether this machine can open a browser", () => {
  it("macOS can", () => {
    expect(browserAvailable({ platform: "darwin", env: {} })).toBe(true);
  });

  it("Review Focus 1: an SSH session never opens a page by default, even on macOS", () => {
    expect(browserAvailable({ platform: "darwin", env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22" } })).toBe(false);
    expect(browserAvailable({ platform: "linux", env: { SSH_TTY: "/dev/pts/0", DISPLAY: ":0" } })).toBe(false);
  });

  it("Review Focus 2: Linux needs a display", () => {
    expect(browserAvailable({ platform: "linux", env: {} })).toBe(false);
    expect(browserAvailable({ platform: "linux", env: { DISPLAY: ":0" } })).toBe(true);
    expect(browserAvailable({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } })).toBe(true);
  });

  it("CloudShell and CI cannot", () => {
    expect(browserAvailable({ platform: "linux", env: { AWS_EXECUTION_ENV: "CloudShell", DISPLAY: ":0" } })).toBe(false);
    expect(browserAvailable({ platform: "darwin", env: { CI: "true" } })).toBe(false);
    expect(browserAvailable({ platform: "darwin", env: { CI: "false" } })).toBe(true);
  });

  it("Q12: Windows stays on the terminal by default", () => {
    expect(browserAvailable({ platform: "win32", env: {} })).toBe(false);
  });
});
```

Append to `tests/contract/init-ui-cli.test.ts`:

```ts
  it("FR-001: with neither flag, an interactive terminal that can open a browser gets the page", async () => {
    const h = await harness();
    const operator = fakeWizardOperator([...FIRST_RUN, ...SLACK, ...SIGNIN, ...FINISH]);
    // No --ui, and no injected prompter: the default decides.
    expect(await h.run([], { openBrowser: operator.open, isInteractive: () => true, browserAvailable: () => true })).toBe(0);
    await operator.settled();
    expect(operator.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
    expect(operator.remaining()).toBe(0);
  });

  // The terminal path refuses without a TTY; a developer running the suite with one attached would
  // be asked on stdin instead, so the test runs only where stdin is not a TTY (always, in CI).
  it.skipIf(process.stdin.isTTY === true)("User Story 4: with no browser, the terminal asks, after one line saying how to get the page", async () => {
    const h = await harness();
    const refused = fakeWizardOperator([]);
    // No TTY in the test process: the terminal path refuses, as before, but only after the line.
    expect(await h.run([], { openBrowser: refused.open, isInteractive: () => true, browserAvailable: () => false })).not.toBe(0);
    expect(refused.opened).toEqual([]);
    expect(h.printed()).toContain("No browser here, so agentx init asks in this terminal. To use the install page instead, run agentx init --ui and open the address it prints (over SSH, forward its port with ssh -L).");
  });

  it.skipIf(process.stdin.isTTY === true)("--no-browser with neither flag is the terminal, with the same line", async () => {
    const h = await harness();
    const none = fakeWizardOperator([]);
    await h.run(["--no-browser"], { openBrowser: none.open, isInteractive: () => true, browserAvailable: () => true });
    expect(none.opened).toEqual([]);
    expect(h.printed()).toContain("No browser here, so agentx init asks in this terminal.");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-mode.test.ts tests/contract/init-ui-cli.test.ts`
Expected: FAIL (`ui-mode.js` does not exist; the default run asks in the terminal).

- [ ] **Step 3: Write `ui-mode.ts`**

```ts
// packages/cli/src/init/ui-mode.ts
// FR-001 (Q1, Q2, Q12): which way agentx init asks its questions when neither --ui nor --no-ui is
// given. The page needs a person at an interactive terminal on a machine whose own screen can show
// a browser; anywhere else (--yes, CI, CloudShell, SSH, no terminal) the terminal path runs exactly
// as it always has.

export type InitUiMode = { mode: "page" } | { mode: "terminal"; noBrowser?: true };

/** Printed before the terminal's first question when only the missing browser kept the page away. */
export const NO_BROWSER_LINE =
  "No browser here, so agentx init asks in this terminal. To use the install page instead, run agentx init --ui and open the address it prints (over SSH, forward its port with ssh -L).";

export function resolveUiMode(input: { ui: boolean | undefined; yes: boolean; injectedPrompter: boolean; interactive: boolean; browser: boolean }): InitUiMode {
  if (input.ui === true) return { mode: "page" };
  if (input.ui === false || input.yes || input.injectedPrompter || !input.interactive) return { mode: "terminal" };
  return input.browser ? { mode: "page" } : { mode: "terminal", noBrowser: true };
}

const set = (value: string | undefined) => value !== undefined && value !== "";

/** True when a browser opened here would show on this machine's own screen. */
export function browserAvailable(input: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv }): boolean {
  const { env } = input;
  // Over SSH a browser would open on the far machine's screen, if anywhere.
  if (set(env.SSH_CONNECTION) || set(env.SSH_TTY)) return false;
  // AWS CloudShell and CI runners have no screen.
  if (env.AWS_EXECUTION_ENV === "CloudShell") return false;
  if (set(env.CI) && env.CI !== "false") return false;
  if (input.platform === "darwin") return true;
  if (input.platform === "linux") return set(env.DISPLAY) || set(env.WAYLAND_DISPLAY);
  // Q12: openSystemBrowser has no Windows opener yet.
  return false;
}
```

Confirm in the live check (Task 6) that CloudShell sets `AWS_EXECUTION_ENV=CloudShell`; it has no
`DISPLAY` either, so the Linux rule already keeps it on the terminal if the variable differs.

- [ ] **Step 4: Use it in `init`**

In `packages/cli/src/init/commands.ts`, import
`browserAvailable, NO_BROWSER_LINE, resolveUiMode` from `./ui-mode.js`, add to
`InitCliDependencies`:

```ts
  /** Whether a person is at an interactive terminal (default: stdin is a TTY). */
  isInteractive?: () => boolean;
  /** Whether a browser opened here would show on this machine's screen (default: browserAvailable). */
  browserAvailable?: () => boolean;
```

and replace the prompter selection, from `let prompter: Prompter;` to the `processPrompter` branch,
with:

```ts
  // FR-001: --ui, --no-ui, or (neither given) the page in an interactive terminal on a machine
  // that can open a browser. --no-browser reads as "no browser here" for the default (Q2).
  const uiMode = resolveUiMode({
    ui: options.ui, yes: options.yes, injectedPrompter: deps.prompter !== undefined,
    interactive: (deps.isInteractive ?? (() => process.stdin.isTTY === true))(),
    browser: options.browser && (deps.browserAvailable ?? (() => browserAvailable({ platform: process.platform, env: processEnv })))(),
  });
  let prompter: Prompter;
  if (uiMode.mode === "page") {
    if (options.yes) throw agentXError("CONFIG_INVALID", "agentx init --ui asks its questions on a page; --yes answers them without asking. Use one or the other");
    const wizard = await startInstallWizard({
      env, write,
      ...(options.browser ? { openBrowser: neverThrowingBrowser(deps.openBrowser ?? openSystemBrowser, write) } : {}),
    });
    session.wizard = wizard;
    prompter = deps.prompter ?? wizard.prompter;
  } else if (deps.prompter !== undefined) {
    prompter = deps.prompter;
  } else if (options.yes) {
    prompter = unattendedPrompter();
  } else {
    if (uiMode.noBrowser === true) write(NO_BROWSER_LINE);
    if (process.stdin.isTTY !== true) {
      throw agentXError("CONFIG_INVALID", "agentx init asks questions; run it in a terminal, pass --ui to answer them in a browser, or pass --yes with a flag for every answer");
    }
    prompter = processPrompter(services.stderr);
  }
```

The refusal text, the `--ui --yes` refusal and every other branch are unchanged. Update the
`InitOptions.ui` doc comment to: "--ui / --no-ui. Undefined means neither was given: the page in an
interactive terminal that can open a browser, else the terminal (resolveUiMode)."

- [ ] **Step 5: The help texts**

In `packages/cli/src/main.ts`:

```ts
    .option("--ui", "ask every question on a page on 127.0.0.1 (the default in an interactive terminal that can open a browser)")
    .option("--no-ui", "ask every question in the terminal")
```

and the `InitCommandOptions.ui` doc comment: "--ui / --no-ui. Undefined when neither was given
(resolveUiMode decides)."

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-mode.test.ts tests/contract/init-ui-cli.test.ts tests/contract/init-cli.test.ts tests/contract/cli-main.test.ts`
Expected: PASS. Every `init-cli.test.ts` run injects a prompter or passes `--yes`, so none of them
starts a page.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/init/ui-mode.ts packages/cli/src/init/commands.ts packages/cli/src/main.ts tests/contract/init-ui-mode.test.ts tests/contract/init-ui-cli.test.ts
git commit -m "feat(init): the install page by default in an interactive terminal that can open a browser"
```

---

### Task 2: A closed tab is not a silent wait

**Files:**
- Modify: `packages/cli/src/init/ui/state.ts`, `packages/cli/src/init/ui/index.ts`
- Test: `tests/contract/init-ui-reminder.test.ts` (create)

Depends on Q3.

**Interfaces:**
- Produces: `WizardHub.connected(): number`; `PAGE_CLOSED_MS = 60_000`;
  `pageClosedLine(url: string): string`;
  `pageClosedReminder(input: { hub: WizardHub; url: string; write: (line: string) => void; now: () => number }): { check(): void }`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/contract/init-ui-reminder.test.ts
// Q3: when a question waits and no page has been connected for a minute, the terminal says once
// where to reopen the page. A page that reconnects, or stays open, gets no reminder.
import { describe, expect, it } from "vitest";
import { PAGE_CLOSED_MS, pageClosedLine, pageClosedReminder } from "../../packages/cli/src/init/ui/index.js";
import { browserPrompter } from "../../packages/cli/src/init/ui/prompter.js";
import { createWizardHub, type WizardListener } from "../../packages/cli/src/init/ui/state.js";

const URL = "http://127.0.0.1:51234/?t=token";
const quiet: WizardListener = { state: () => undefined, log: () => undefined, closed: () => undefined };

function setup() {
  let clock = 0;
  const lines: string[] = [];
  const hub = createWizardHub("staging");
  const reminder = pageClosedReminder({ hub, url: URL, write: (line) => { lines.push(line); }, now: () => clock });
  return { hub, lines, reminder, advance: (ms: number) => { clock += ms; reminder.check(); } };
}

describe("the closed-tab reminder", () => {
  it("says once where to reopen the page when a question has waited a minute with no page", () => {
    const { hub, lines, advance } = setup();
    void browserPrompter(hub).ask("Alert email address", { flag: "--alert-email" });
    advance(PAGE_CLOSED_MS - 1);
    expect(lines).toEqual([]);
    advance(1);
    expect(lines).toEqual([pageClosedLine(URL)]);
    advance(PAGE_CLOSED_MS * 5);
    expect(lines).toHaveLength(1);
    expect(pageClosedLine(URL)).toBe(`The install page is closed. Open ${URL} to continue, or press Ctrl-C to stop; agentx init continues from here next time.`);
  });

  it("Review Focus 4: no reminder while a page is connected", () => {
    const { hub, lines, advance } = setup();
    hub.subscribe(quiet);
    void browserPrompter(hub).ask("Alert email address", { flag: "--alert-email" });
    advance(PAGE_CLOSED_MS * 10);
    expect(lines).toEqual([]);
  });

  it("Review Focus 3: a page that reconnects within a minute gets no reminder", () => {
    const { hub, lines, advance } = setup();
    const unsubscribe = hub.subscribe(quiet);
    void browserPrompter(hub).ask("Alert email address", { flag: "--alert-email" });
    advance(PAGE_CLOSED_MS * 2);
    unsubscribe();
    advance(PAGE_CLOSED_MS - 1_000);
    hub.subscribe(quiet);
    advance(PAGE_CLOSED_MS * 2);
    expect(lines).toEqual([]);
  });

  it("says nothing while no question waits (a deploy step running for minutes)", () => {
    const { lines, advance } = setup();
    advance(PAGE_CLOSED_MS * 30);
    expect(lines).toEqual([]);
  });

  it("reminds again for the next question after one is answered", () => {
    const { hub, lines, advance } = setup();
    const prompter = browserPrompter(hub);
    void prompter.ask("Alert email address", { flag: "--alert-email" });
    advance(PAGE_CLOSED_MS);
    const id = hub.state().question?.id ?? "";
    hub.answer(id, "ops@example.com");
    void prompter.ask("Slack app name", { flag: "--slack-app-name", defaultValue: "AgentX" });
    advance(PAGE_CLOSED_MS);
    expect(lines).toEqual([pageClosedLine(URL), pageClosedLine(URL)]);
  });

  it("counts the pages the hub is connected to", () => {
    const hub = createWizardHub("staging");
    const off = hub.subscribe(quiet);
    expect(hub.connected()).toBe(1);
    off();
    expect(hub.connected()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/contract/init-ui-reminder.test.ts`
Expected: FAIL (`pageClosedReminder` is not exported).

- [ ] **Step 3: `connected()` on the hub**

In `packages/cli/src/init/ui/state.ts`, add to `WizardHub`
`/** How many pages are connected now (their event streams). */ connected(): number;` and to the
returned object `connected: () => listeners.size,`.

- [ ] **Step 4: The reminder**

In `packages/cli/src/init/ui/index.ts`:

```ts
/** Q3: how long a question may wait with no page connected before the terminal says where it is. */
export const PAGE_CLOSED_MS = 60_000;
const REMINDER_CHECK_MS = 5_000;

export function pageClosedLine(url: string): string {
  return `The install page is closed. Open ${url} to continue, or press Ctrl-C to stop; agentx init continues from here next time.`;
}

/** Says once per question, in the terminal, where to reopen a page that has been closed for a
 * minute. `check` is called on a timer; tests call it directly. */
export function pageClosedReminder(input: { hub: WizardHub; url: string; write: (line: string) => void; now: () => number }): { check(): void } {
  let lastConnected = input.now();
  let reminded: string | undefined;
  return {
    check() {
      if (input.hub.connected() > 0) {
        lastConnected = input.now();
        return;
      }
      const waiting = input.hub.state().question?.id;
      if (waiting === undefined || waiting === reminded) return;
      if (input.now() - lastConnected < PAGE_CLOSED_MS) return;
      reminded = waiting;
      input.write(pageClosedLine(input.url));
    },
  };
}
```

In `startInstallWizard`, after the "Every question agentx init asks is on that page" line, start it
and stop it on close:

```ts
  const reminder = pageClosedReminder({ hub, url: server.url, write: input.write, now: Date.now });
  const timer = setInterval(() => reminder.check(), REMINDER_CHECK_MS);
  timer.unref();
```

and in `close()`, first line after `closed = true;`: `clearInterval(timer);`.

The reminder's `write` is `input.write`, which is `init`'s tee (terminal and log pane); a line in
the log pane of a closed page does no harm, and the next page that connects sees it in the backlog.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/contract/init-ui-reminder.test.ts tests/contract/init-ui-server.test.ts tests/contract/init-ui-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/init/ui/state.ts packages/cli/src/init/ui/index.ts tests/contract/init-ui-reminder.test.ts
git commit -m "feat(init-ui): say where to reopen the install page when its tab has been closed for a minute"
```

---

### Task 3: The page ships in the npm package (FR-060)

**Files:**
- Modify: `tests/contract/release-pack-cli.test.ts` (assertions appended to the offline install test)

Depends on Q11.

This task changes no production code: the page is compiled into the CLI's bundle already. It pins
that, so a later build change cannot ship a CLI without its page.

- [ ] **Step 1: Write the failing assertions**

In `it("installs offline into an empty directory and runs", ...)`, after
`expect(help).toContain("admin");`, add:

```ts
    // FR-060: the install page is inside the installed package's one bundled file, and init's
    // help names both ways to ask.
    const initHelp = (await run(bin, ["init", "--help"])).stdout;
    expect(initHelp).toContain("--ui");
    expect(initHelp).toContain("--no-ui");
    expect(initHelp).toContain("the default in an interactive terminal that can open a browser");
    const bundle = await readFile(join(project, "node_modules", "@charterarc", "agentx", "bin", "agentx.mjs"), "utf8");
    expect(bundle).toContain("<title>Install AgentX</title>");
    expect(bundle).toContain("x-agentx-wizard-token");
    expect(bundle).toContain("renderCards(state.cards, state.link);");
```

The installed file is `bin/agentx.mjs` (the manifest assertion above pins it), and
`scripts/release/pack-cli.ts` calls esbuild without `minify`, so the page module's own source text
is in the bundle as written.

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/contract/release-pack-cli.test.ts -t "installs offline"`
Expected: PASS once Task 1's help text is in (it fails on `the default in an interactive terminal`
before Task 1). If it fails on the bundle strings, the page is not in the bundle: stop and raise it,
because FR-060 is then not met.

- [ ] **Step 3: Commit**

```bash
git add tests/contract/release-pack-cli.test.ts
git commit -m "test(release): the install page ships inside the published CLI"
```

---

### Task 4: The docs (FR-061)

**Files:**
- Modify: `docs/install.md`, `README.md`
- Test: `tests/contract/install-docs.test.ts` (create)

Depends on Q1, Q2, Q3 and Q4.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contract/install-docs.test.ts
// FR-061: the install guide and the README describe the install page and --no-ui, and stay in
// plain words with no em dashes.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NO_BROWSER_LINE } from "../../packages/cli/src/init/ui-mode.js";

const read = (path: string) => readFileSync(path, "utf8");

describe("the install docs (FR-061)", () => {
  it("the install guide describes the page, --no-ui, SSH, and a closed tab", () => {
    const guide = read("docs/install.md");
    const section = guide.slice(guide.indexOf("### The install page"));
    expect(guide.indexOf("### The install page")).toBeGreaterThan(0);
    for (const text of ["127.0.0.1", "--no-ui", "--ui", "ssh -L", "CloudShell", "--yes", "closed", "never shown again"]) expect(section).toContain(text);
    // The guide quotes the line init prints on a machine with no browser.
    expect(guide).toContain(NO_BROWSER_LINE);
  });

  it("the README says the install opens a page, and how to stay in the terminal", () => {
    const readme = read("README.md");
    expect(readme).toContain("install page");
    expect(readme).toContain("--no-ui");
  });

  it("uses no em dashes", () => {
    for (const path of ["docs/install.md", "README.md"]) expect(read(path)).not.toContain("\u2014");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/contract/install-docs.test.ts`
Expected: FAIL (no "### The install page" section).

- [ ] **Step 3: Write the docs**

In `docs/install.md`, under "## With published templates (recommended)", right after the command
block, insert:

```markdown
### The install page

In a terminal on your own computer, `init` opens a page in your browser, served from this computer
only (`127.0.0.1`). Everything `init` asks is asked there: which AWS profile and account it installs
into (with a Sign in button when your session has expired), the prerequisites as a checklist, the
plan and its monthly cost with a Create button, then each step with its status. The GitHub App and
the Slack app are made from buttons on the page, and the page moves on by itself once GitHub or
Slack is done. Secrets (the Slack token and signing secret, connector keys) are typed into hidden
fields; each goes straight to AWS Secrets Manager and is never shown again, and the field is
emptied as soon as it is sent. The install ends on the page with AgentX's first reply in your
channel.

Keep the tab open until the install finishes. If you close it, `init` keeps waiting and, after a
minute, prints the address again in the terminal; open it to carry on, or press Ctrl-C and run
`init` again later (it continues where it stopped).

`--no-ui` asks every question in this terminal instead. `init` also uses the terminal on its own
where no browser can open: over SSH, in AWS CloudShell, in CI, and with `--yes` or `--no-browser`.
It then prints:

> No browser here, so agentx init asks in this terminal. To use the install page instead, run agentx init --ui and open the address it prints (over SSH, forward its port with ssh -L).

Over SSH, `agentx init --ui` prints the page's address and port; forward that port from your own
computer (`ssh -L <port>:127.0.0.1:<port> <host>`) and open the address there.
```

Then, in the numbered steps below it, replace "then paste the Bot User OAuth Token and the Signing
Secret into two hidden prompts" with "then paste the Bot User OAuth Token and the Signing Secret
into two hidden fields", and in "**No browser.**", replace its first sentence with "`--no-browser`
prints every address instead of opening it, and keeps `init` in the terminal unless you also pass
`--ui`."

In `README.md`, in "## Install AgentX in your AWS account", after
"`npx @charterarc/agentx init --env <name>`.", add a paragraph:

```markdown
On your own computer, `init` opens an install page in your browser, served only from this computer,
and asks everything there, from the AWS account to the first reply in Slack. Pass `--no-ui` to
answer in the terminal instead; SSH sessions, CloudShell, CI and `--yes` use the terminal on their
own. See [docs/install.md](docs/install.md#the-install-page).
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/contract/install-docs.test.ts tests/contract/day-two-docs.test.ts tests/contract/ci-docs-only.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/install.md README.md tests/contract/install-docs.test.ts
git commit -m "docs(install): the install page, --no-ui, SSH and a closed tab"
```

---

### Task 5: Record the rulings, the answers and the status in the spec

This task changes no code. If an answer differs from a recommendation this plan followed, stop: the
owning task changes first, with its test, then this task records it.

**Files:**
- Modify: `specs/040-install-ui/spec.md`

- [ ] **Step 1: Amend the spec**
  - FR-001: add "A browser is available when the session is not over SSH, not in CloudShell or CI,
    and the machine is macOS, or Linux with a display; Windows uses the terminal by default (Q12).
    `--no-browser` with neither flag means the terminal. Without a browser, `init` prints one line
    saying how to get the page, then asks in the terminal (Q2)."
  - User Story 4: replace "the wizard prints its URL and falls back to the terminal prompter" with
    "init prints one line saying how to use the page (`--ui`, and `ssh -L` over SSH), then asks in
    the terminal (Q2)".
  - FR-002: add "When a question has waited a minute with no page connected, the terminal says once
    where to reopen the page (Q3)."
  - FR-060: replace with "The wizard's page, stylesheet and module are compiled into the CLI and ship
    in its published npm package, which a pack test checks. `release:build` builds the
    CloudFormation release and does not carry the CLI (Q11)."
  - Decisions, Location: replace "static assets built to `packages/cli/dist/ui/`" with "the page's
    assets are text in `ui/page.ts`, compiled with the rest of the CLI (Q11)".
  - Decisions, Terminal path stays: add "It stays the default for `--yes`, CI, CloudShell, SSH and
    any session without a browser (Q1)."
  - Status: "Implemented", with the four phases' PR numbers under Phasing.
- [ ] **Step 2: Check the copy** (`grep -c "$(printf '\342\200\224')" specs/040-install-ui/spec.md`
  prints 0), then commit:

```bash
git add specs/040-install-ui/spec.md
git commit -m "docs(spec-040): record the phase 4 rulings and answers; spec 040 implemented"
```

---

### Task 6: Live check (deferred to the combined final live check) (owner present): the default, headless, and a closed tab

> **Deferred to the combined final live check (owner, 2026-09-30).** No live testing happens until
> spec 025 phases 25d and 25e and spec 040 phases 2 to 4 are all built. This task is not run when
> this phase is built; its steps below are kept as the checklist for that one final check, run in a
> single throwaway environment, with the owner's go-ahead.


This task changes no code unless it finds a defect (fixed with a failing test first, in its task).
It is cheap by design (Q13): it stops after the prerequisites, which creates only the install's SSM
parameters and its lock. It needs:
- the owner's explicit go-ahead;
- an AWS session for account 944937319445 on the owner's Mac (`aws login --profile agentx-admin`)
  and in CloudShell;
- no other throwaway environment in the account (phase 3's `live40c` torn down).

It uses `live40d` on the Mac and `live40e` in CloudShell, in `us-east-1`.

- [ ] **Step 1: Prepare.** Build a release and pack the CLI from this branch:
  `npm run release:build -- --version 0.0.8 --out <scratch>/rel` and
  `npm run release:pack-cli -- --version 0.0.8 --out <scratch>/cli`; install the tarball into an
  empty scratch folder with `npm install --offline <tarball>`. Confirm nothing exists under
  `/agentx/live40d` or `/agentx/live40e`.
- [ ] **Step 2: The default on the Mac (FR-001).** In Terminal, with no `--ui` and no `--no-ui`:
  `<scratch>/node_modules/.bin/agentx --env live40d init --region us-east-1 --release <scratch>/rel --stop-after prerequisites`.
  The page opens by itself. Answer every question on the page, confirm the plan, and see the
  prerequisites step finish and the page say it stopped after it.
- [ ] **Step 3: A closed tab (Q3).** Start a fresh install the same way with `--env live40f`. At
  the first question, close the tab. After a minute the terminal prints "The install page is
  closed. Open ... to continue"; open that address, and the page comes back on the same question.
  Answer it, then press Ctrl-C at the next question (nothing is created before the plan).
- [ ] **Step 4: `--no-ui` and SSH.** Run the Step 3 command with `--no-ui`: the questions are in the
  terminal; press Ctrl-C at the first one. Then `ssh localhost` (with the owner's agreement to enable Remote Login
  for the check, or skip it) and run the same command without flags: the terminal prints the no
  browser line and asks there; Ctrl-C.
- [ ] **Step 5: CloudShell (User Story 4).** Upload the packed tarball and the release folder (a
  zip) to CloudShell, install the tarball, and run
  `agentx --env live40e init --region us-east-1 --release <dir>` with no flags. It prints the no
  browser line and asks in the terminal. Record `echo $AWS_EXECUTION_ENV` (the plan expects
  `CloudShell`). Ctrl-C at the first question.
- [ ] **Step 6: Tear down.** Delete every parameter under `/agentx/live40d`, `/agentx/live40e` and
  `/agentx/live40f` (`aws ssm get-parameters-by-path --recursive`, then `delete-parameters`), and
  confirm no stack, secret or EC2 resource was created for any of them. Remove the scratch folders.
- [ ] **Step 7: Record the evidence** in the PR description: each command, what it showed, the
  CloudShell variable's value, and any defect fixed.

## Not in this phase

- **Not planned:** a Windows browser opener (Q12's option B); remembering the AWS profile (Q9's
  option C); moving the page's assets to separate files (Q11's option B).

## Self-review

- **Spec coverage.** FR-001's default: Task 1 (with `--no-browser`'s reading and Q2's line). FR-002's
  "no silent wait" (Q3's addition): Task 2. FR-060: Task 3 (the npm package; `release:build`'s part
  corrected in Task 5, Q11). FR-061: Task 4. User Story 4: Task 1's tests (`--yes`, no terminal, no
  browser) and Task 6 Steps 4 and 5. SC-004: Task 1's gate runs every existing `init` test; each
  injects a prompter or passes `--yes`, and `resolveUiMode` keeps both on the terminal.
- **Placeholder scan.** Every code step shows its code. One fact is left to the live check (CloudShell's
  `AWS_EXECUTION_ENV`), with the Linux display rule as the fallback if it differs; the two tests
  that need a stdin without a TTY skip themselves where one is attached.
- **Type consistency.** `InitUiMode` is Task 1's, used once in `commands.ts`. `connected()` and
  `pageClosedReminder` are Task 2's; the reminder uses phase 1's `WizardHub.state().question`.
  `NO_BROWSER_LINE` is one constant, printed by `commands.ts` and quoted by the docs test.
- **Review Focus.** 1, 2 and 5 in Task 1; 3 and 4 in Task 2.
- **The owner's answers (2026-09-30).** All thirteen as recommended, so no task changes; the live
  check is deferred to the combined final live check (owner, 2026-09-30).
