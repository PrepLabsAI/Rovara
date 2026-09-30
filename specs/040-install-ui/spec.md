# Feature Specification: Local Install UI

**Feature Branch**: `feat/040-install-ui`
**Created**: 2026-09-28
**Status**: Approved
**Input**: Paperclip PRE-2, plan accepted 2026-09-28 (full scope: the wizard ends with a working
project, not a list of follow-up commands)

## Context

Spec 015 US1 promises that `agentx init` "walks the engineer through creating the GitHub and Slack
apps, creates their admin user, sets up a first project and channel, and ends with a working reply
in Slack", with "nothing copied between screens by hand". What shipped is a terminal wizard: the
operator answers hidden prompts, pastes Slack tokens into a TTY, reads a priced plan as text, and
is then told by `nextStepsText()` to run three more commands by hand. Every AWS question assumes
ambient credentials, so "which account am I installing into" is something the operator has to know
rather than something the installer shows them.

This feature puts the install behind a browser page on `127.0.0.1`, the way the Paperclip installer
works, and closes the gap between spec 015 US1 and what `agentx init` actually does.

`agentx init` is already shaped for this. Everything a person touches passes through four seams:

| Seam | Where | What the UI does with it |
| --- | --- | --- |
| `Prompter` (`ask`/`choose`/`confirm`/`secret`) | `packages/cli/src/init/prompts.ts` | A `browserPrompter()` pushes the question to the page and awaits the posted answer |
| `InitEvent` + `onEvent` | `packages/cli/src/init/steps.ts` | The live step checklist |
| `write(line)` | `packages/cli/src/init/commands.ts` | The log pane |
| `openBrowser(url)` | `packages/cli/src/auth.ts` | Opens the wizard |

Resume (`InstallProgress` in SSM), the priced review screen (`confirmInstallPlan`) and
single-install concurrency (`withEnvironmentLock`) already exist and are reused unchanged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install From A Browser (Priority: P1)

An engineer runs `agentx init`. A page opens on `127.0.0.1`. It shows which AWS account and region
they are about to install into, the prerequisite results, what will be created and what it costs
per month, and then the eight install steps with live status. Every question `agentx init` asks
today is asked on that page instead of the terminal.

**Independent Test**: on a machine with a browser, `agentx init` completes an install end to end
without the operator typing anything into the terminal after the command itself.

### User Story 2 - Connect AWS, GitHub And Slack Without Leaving The Wizard (Priority: P1)

The wizard is where the three connections are made: an AWS profile is picked and its identity
shown, a GitHub App is created through GitHub's manifest flow and its repositories chosen, and a
Slack app is created from a generated manifest with its two credentials pasted into masked fields
and its Request URLs probed.

**Independent Test**: from a machine with no GitHub App and no Slack app, both apps exist and are
installed at the end of the run, and the operator never copied a value between two windows by hand.

### User Story 3 - The Install Ends With Something That Works (Priority: P1)

The last wizard screens create the admin user, sign in, register the first project, bind a Slack
channel, and confirm a real reply in that channel. `nextStepsText()`'s three manual commands are
gone.

**Independent Test**: after the wizard reports success, a message in the chosen channel gets an
AgentX reply in its thread, with no command run by hand.

### User Story 4 - Headless Installs Still Work (Priority: P2)

`--yes` unattended installs, CI, CloudShell and SSH sessions keep working exactly as they do today.

**Independent Test**: the existing `agentx init --yes` tests pass unchanged, and on a host with no
browser init prints one line saying how to use the page (`--ui`, and `ssh -L` over SSH), then asks in
the terminal (Q2).

## Requirements

### The wizard server

- **FR-001**: `agentx init --ui` MUST start an HTTP server bound to `127.0.0.1` on an ephemeral
  port, open the operator's browser at it, and serve the wizard. `--no-ui` MUST force the terminal
  path. When neither is given, the UI is used if a browser is available and the session is
  interactive; otherwise the terminal prompter is used. A browser is available when the session is
  not over SSH, not in CloudShell or CI, and the machine is macOS, or Linux with a display; Windows
  uses the terminal by default (Q12). `--no-browser` with neither flag means the terminal. Without a
  browser, in an interactive terminal with neither flag and no `--yes`, `init` prints one line saying
  how to get the page, then asks in the terminal (Q2).
- **FR-002**: The server MUST exit with the `init` run. It MUST NOT outlive the command, and MUST
  NOT bind any address other than the loopback one. When a question waits and no page has been
  connected for a minute, the terminal says once, for that question, where to reopen the page (Q3).
- **FR-003**: A `browserPrompter()` MUST implement `Prompter` against the page: `ask`, `choose`,
  `confirm` and `secret` each render as a question and resolve with the posted answer. Validation
  rejections MUST be shown inline on the field rather than thrown as a failed run.
- **FR-004**: The page MUST show the `InitEvent` stream as a step checklist (skipped, started,
  done, waiting) and the `write(line)` output as a log pane, both live.
- **FR-005**: The priced install plan from `confirmInstallPlan` MUST be shown as a review screen
  whose confirm is a button. An install MUST NOT create anything before it is confirmed.
- **FR-006**: When `readInstallProgress` reports a part-finished install for the environment, the
  wizard MUST open on a resume screen naming the completed steps and the step it will continue
  from.

### Security

- **FR-010**: Every request MUST carry a single-use session token minted for that run. A request
  without it MUST be refused.
- **FR-011**: The server MUST reject any request whose `Origin` or `Referer` is not its own, MUST
  send no CORS headers, and MUST reject cross-site `Sec-Fetch-Site` values. One exception (Q6):
  `GET /github/created`, only while the GitHub App step waits for the manifest code, only with the
  manifest flow's `state` (compared in constant time), once, and only with the listener's own
  `Host`. Its answer loads nothing and sends no Referer. A late or second callback is refused by the
  ordinary checks (403 for GitHub's cross-site visit, 401 without a session token) and resolves
  nothing.
- **FR-012**: A secret entered in the page MUST pass straight through the existing `cleanSecret` →
  Secrets Manager path. It MUST NOT be echoed back to the page, put in an `InitEvent`, written to
  an install-progress `note`, or written to disk. In the page, a masked field is emptied as soon as
  its value is sent, and the question area is emptied once the answer is taken (Q4).

### Connect AWS

- **FR-020**: The AWS screen MUST list the profiles in the operator's AWS configuration, and for
  the selected one show the resolved `sts:GetCallerIdentity` account id and ARN, so the operator can
  see which account the install will land in before it starts. The profiles are read from the AWS
  CLI's config and credentials files; with two or more, the page asks which; the choice is not
  stored (Q9).
- **FR-021**: When credentials are missing or expired (`AUTH_REQUIRED`), the screen MUST offer a
  sign-in action that runs the profile's SSO login and re-resolves the identity, instead of ending
  the run with advice text. The sign-in action is `aws sso login --profile <name>` for an IAM
  Identity Center profile and `aws login --profile <name>` for an `aws login` profile; other
  profiles get Check again only (Q9).
- **FR-022**: The region picker MUST offer only the regions the release supports.
- **FR-023**: The prerequisite checks (region support, Bedrock model access, EC2 vCPU quota) MUST be
  shown as a pass/fail list, each failure with what to do about it, and MUST be re-runnable without
  restarting `init`. Checking again is offered on the page only; the terminal path stops as before
  (Q7). On the page, a prerequisite failure that no check reports is listed as a failed
  "Prerequisites" item with the error's words.

### Connect GitHub

- **FR-030**: The GitHub App MUST be created through the existing manifest flow, with the manifest
  form and the callback both served by the wizard's own origin, so the operator stays in the
  wizard. The existing `state` check MUST still be enforced on the callback. The terminal path
  keeps its one-time listener.
- **FR-031**: After creation the wizard MUST link the operator to the app's repository-selection
  page and show the installation wait as a waiting card that resolves when the installation
  appears.

### Connect Slack

- **FR-040**: The Slack screen MUST offer a button that opens Slack's create-app page with the
  generated manifest, then two masked fields for the bot token and signing secret, validated inline
  by the existing `checkSlackBotToken` and `checkSlackSigningSecret`. A token Slack refuses is
  pasted again on the page (Q8).
- **FR-041**: The Request URL verification MUST be shown as a live card with its result, and MUST
  be re-runnable after the operator fixes the app. Checking again is offered on the page only; the
  terminal path stops as before (Q7).

### Finish the job

- **FR-050**: After deployment the wizard MUST create the Cognito admin user, sign the operator in,
  register the first project and bind a Slack channel, as screens in the same run. On the page,
  the sign-in page is a button (Q5), and a sign-in that fails or times out can be tried again (Q7).
  A private channel's invite wait and the alert subscription's confirmation are cards that resolve
  by themselves: the alert card waits on the page (up to 10 minutes) and, after that, the alert
  wait can be checked again on the page.
- **FR-051**: The final screen MUST confirm a real reply in the bound channel, and MUST report what
  to fix when it does not arrive. A second watch ignores a turn the first one already reported as
  failed. On the page, a failed or missed reply can be watched for again (Q7); the terminal path
  stops as before.
- **FR-052**: The page's last card leads with what works now (where to talk to AgentX, how
  developers sign in) and lists the optional day-2 commands under 'Later, if you want more'. No
  command is needed to finish; `nextStepsText()` no longer exists (spec 015 phase 15d2 removed
  it). (Q10.)

### Packaging

- **FR-060**: The wizard's page, stylesheet and module are compiled into the CLI and ship in its
  published npm package, which a pack test checks. `release:build` builds the CloudFormation release
  and does not carry the CLI (Q11).
- **FR-061**: The README and `docs/` install instructions MUST describe the UI path and `--no-ui`.

## Success Criteria

- **SC-001**: Unit tests cover the `browserPrompter` protocol (each `Prompter` method, inline
  validation, cancellation) and that no secret reaches an event, a log line or a progress note.
- **SC-002**: HTTP-level tests cover the server's routes, the session-token refusal, the
  `Origin`/`Referer`/`Sec-Fetch-Site` refusals, and that the listener is loopback-only.
- **SC-003**: A headless end-to-end test drives a full install through the UI path using the
  existing fake `deps.github` and `deps.slack` seams.
- **SC-004**: The existing `agentx init` tests pass unchanged; `--yes` behaviour is untouched.
- **SC-005**: On a clean machine, `agentx init` ends with a message in the bound Slack channel
  getting an AgentX reply, with no command typed after `agentx init` (spec 015 US1's independent
  test, now actually met).

## Out Of Scope

- A frontend framework or a second build toolchain. The page is plain HTML, one ES module and
  server-sent events; the repo ships no non-JS assets today and a published CLI is the wrong place
  to add a bundler.
- Remote or multi-user access to the wizard. It is loopback-only, one operator, one run.
- Any change to what `init` deploys. This feature changes how the operator drives the install, not
  what the install creates.

## Decisions

- **Location**: `packages/cli/src/init/ui/`. The page's assets are text in `ui/page.ts`, compiled
  with the rest of the CLI (Q11). Not a separate package: it ships with the CLI and shares the init
  types.
- **Terminal path stays**: the UI is additive. `InitCliDependencies` is already a DI seam, so the
  UI is injected and the existing tests are untouched. It stays the default for `--yes`, CI,
  CloudShell, SSH and any session without a browser (Q1).
- **Phasing**: (1) server, prompter, event/log stream, review and resume screens behind `--ui`;
  (2) the three connect screens and the prerequisite checklist; (3) admin user, project, channel
  bind and the test reply; (4) UI on by default plus packaging and docs. Phase 1 is shippable alone.
  Phase 2 built, see PR #161; its live check is deferred
  to the combined final live check (owner, 2026-09-30).
  Phase 3 built (PR after #161 merges); live check deferred to the combined final live check
  (owner, 2026-09-30).
  Phase 4 built (PR after phases 2 and 3 merge); live check deferred to the combined final live
  check (owner, 2026-09-30).
- **Cards.** The page's connect and finishing screens are status cards built in `ui/cards.ts` from
  facts a step already has; no card builder takes a secret. Steps reach the page through an
  optional `InstallSurface` on the init context, so the terminal path is unchanged (phase 2).
- **Retry on the page.** Where the page offers to try again, its failure cards drop the terminal's
  closing "run agentx ... init again" advice (phase 2); phase 3's test reply card follows the same
  rule (R2), and so does the admin card's failed sign-in. A failure the page offers no retry for
  (the test alarm, an OIDC token with no name to record) keeps its own next step.
- Phase 4 fixed the two notes from phase 3, and the GitHub App card the same way. On the page, a
  failed sign-in drops its sign-in button, so none is left while Sign in again? is asked. The
  channel card and the GitHub App card show failed, with the error's own words and next step (the
  page offers no retry there), when their wait times out or the step fails after a waiting card.
