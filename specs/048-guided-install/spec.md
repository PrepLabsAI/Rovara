# Feature Specification: Guided Install

**Feature Branch**: `docs/guided-install-spec` (spec); each phase ships on its own branch against
mainline (no stacked PRs)
**Created**: 2026-10-01
**Status**: Draft, for owner review
**Input**: The guided install design proposal and the owner's decisions of 2026-10-01 (scope B,
the full guided redesign, with the first PR carrying the quick copy and link fixes). Evidence: the
combined live check on env `livefinal` (2026-10-01), its 21 ranked UX gaps, and a code review of
the install page (60 findings). Related issue: #222.

## Context

Spec 040 moved `agentx init` into a browser page. The live check on 2026-10-01 showed that the page
asks the right questions but does not guide anyone. The owner's verdict: "very very poor. Not a
proper guided experience, the user feels lost and disconnected."

What a first-time installer meets today:

1. **No sense of place or time.** 13 steps over about 45 minutes, listed at the bottom of the
   page with no estimates. Deploys show "running" and nothing else.
2. **Human stops scattered through the waits.** GitHub, Slack, the Request URL, a sign-in
   approval and the channel each interrupt a long deploy, with no "your turn" signal. The user has
   to watch the tab for the whole install.
3. **17 setup questions up front**, most of them expert questions, with no recommended path and
   no help text.
4. **Failures strand the user.** A bad image reference failed the install after about 15
   minutes. The page disappeared, the reason was only in the terminal, and the resume refused the
   answer that would have fixed it. The only way out was to start again.
5. **Wrong or misleading defaults.** The cost estimate left out the biggest cost, the default
   budget sat below the estimate, alerts were never offered, and the default Slack app name
   clashed with an existing app.
6. **Internal words and two copies of everything.** Phase numbers, config keys and CloudFormation
   IDs on the page; the terminal repeats the page while some instructions exist only in the
   terminal.

This spec makes the install a guided flow, like a good checkout: the user always knows where they
are, what comes next, how long it takes and when they are needed; every decision comes first and
the long part runs unattended; and every failure is fixed on the page.

It changes how the install is driven and in what order. It does not change what AgentX deploys,
with three exceptions named in Decisions: two Slack bot scopes are added to the manifest, the
alert email subscription is made earlier, and developer sign-in is turned on in the same deploy as
the Slack connection instead of a later one.

Spec 015 SC-002 (at most 15 actions, under 45 minutes) stays the long-term target. This spec sets
an interim target (SC-007) because reaching 15 needs the Slack manifest API, which is out of scope.

## User Scenarios & Testing *(mandatory)*

The primary user throughout is **a developer at a small company**, setting AgentX up for their
team. They are comfortable with a terminal and GitHub, have admin rights in an AWS account, and
are not an AWS expert.

### User Story 1 - Always Know Where I Am And When I Am Needed (Priority: P1)

From the first screen the installer sees the five phases of the install, how long each takes, and
which ones need them. During the long build they can leave, and the page calls them back when it
needs them.

**Why this priority**: The owner's core complaint is that the user feels lost. Without a sense of
place and time, every other fix still feels like being lost.

**Independent Test**: Run a full install with fakes. On every screen, the page shows the current
phase, "step N of 5", the time left, and a status word for every phase. When a question appears
after an unattended wait, the tab title changes and a notification fires.

**Acceptance Scenarios**:

1. **Given** the installer opens, **When** the welcome screen shows, **Then** it lists the five
   phases (Get started, Your choices, Build in AWS, Connect Slack, Finish) with a time for each, the
   total time, the time the user is needed, and says to keep the terminal open and the computer
   awake and that the tab is safe to close.
2. **Given** the build is running, **When** the user looks at the page, **Then** they see one row
   per part being built, in plain names, with elapsed time, the usual time and how many resources
   are done, and a line saying what needs them next and in about how long.
3. **Given** the user is in another tab during the build, **When** the install needs them,
   **Then** the tab title reads "(Action needed) Install AgentX" and, if they allowed it, a browser
   notification fires.
4. **Given** a step finished, **When** the next step starts, **Then** the finished step collapses
   to one line in the progress rail with a Details link, and the current step is the only open
   panel.

---

### User Story 2 - Answer Only What I Can Answer (Priority: P1)

The installer answers about five questions they can answer (their email, GitHub owner, install
name, app name) on one settings screen, sees the recommended settings in plain words, and leaves
the expert settings alone unless they want them. The plan is a short summary they can read, with
a way back.

**Why this priority**: 17 expert questions are where a newcomer gives up or guesses. Wrong guesses
here cause the late failures.

**Independent Test**: A journey test on the default path counts the questions and page actions,
and checks that no Advanced setting is required to reach the plan.

**Acceptance Scenarios**:

1. **Given** the settings screen, **When** the user fills the default-path fields and presses
   "Review the plan", **Then** every Advanced setting takes its recommended value and the plan
   shows it.
2. **Given** the plan, **When** the user presses "Change answers", **Then** the settings screen
   returns with every answer kept, and nothing has been created.
3. **Given** the plan, **When** the user reads the cost, **Then** every line is priced, including
   every default model, and the suggested budget is the estimate plus about 20%, for the whole
   account.
4. **Given** the user is signed in to AWS as the root user, **When** the account screen shows,
   **Then** it warns in plain words and offers "Continue as root" and a link on how to create an
   admin user, and continuing works.
5. **Given** the default path, **When** the plan shows, **Then** alerts go to the user's email,
   and the GitHub and Slack apps share one name that includes the install name.

---

### User Story 3 - Do The Human Parts Together, Then Walk Away (Priority: P1)

Every decision, the plan and the GitHub app come before the long build. After the build starts
there is one Slack visit, where all four Slack values are pasted on one screen, and then a short
finish.

**Why this priority**: Scattered stops force the user to babysit a 40-minute install, and the
Slack values in two trips are the most error-prone part.

**Independent Test**: The journey test records each point the run waits on the user. After the
build starts, waits occur only in the Connect Slack and Finish phases, and Slack values are asked
on one screen.

**Acceptance Scenarios**:

1. **Given** the plan was confirmed, **When** the GitHub step runs, **Then** it runs before the
   long build starts, and the build then needs nothing from the user.
2. **Given** the AgentX service is up, **When** the Connect Slack phase starts, **Then** one form
   asks for the Client ID, Client Secret, Signing Secret and Bot User OAuth Token, each with a
   direct link to the Slack page that holds it and a hint of what it looks like.
3. **Given** the Slack values are saved, **When** the Slack connection is deployed, **Then**
   developer sign-in is turned on in the same deploy with no separate approval, and the plan had
   said so.
4. **Given** a Slack workspace that needs an admin to approve new apps, **When** the user presses
   "My workspace needs an admin to approve it", **Then** the page says the progress is saved, keeps
   checking whether the app was installed, and continues by itself when it is.

---

### User Story 4 - Fix Failures On The Page (Priority: P1)

When something goes wrong, the page stays up, says what happened in plain words, and offers a
button that fixes it: try again, change the answer that caused it, or go fix it elsewhere and
check again. Anything that can be checked before AWS resources exist is checked first.

**Why this priority**: The live check's worst moment was a late failure that could not be fixed
without starting over. A failure that ends the run turns a 45-minute install into 90.

**Independent Test**: For each step, inject a failure. The page shows a failure screen with at
least one page action, and the action leads to a successful run of that step. Separately, the
live check's image failure is reported before anything is created.

**Acceptance Scenarios**:

1. **Given** a release whose image references AWS cannot pull, **When** the user reaches the plan,
   **Then** the check after settings reports it before anything is created, with "Change the worker
   image" as a page action.
2. **Given** a deploy step failed because of an answer that no finished step depends on, **When**
   the user presses "Change <answer>", **Then** only that field reopens, the new value is saved,
   and the step runs again.
3. **Given** a transient failure (throttling, a timeout), **When** the failure screen shows,
   **Then** "Try this step again" reruns it and the earlier steps are kept.
4. **Given** the run was stopped and `agentx init` is run again, **When** the old tab is still
   open, **Then** it reconnects at the same address by itself and says "Welcome back. Continuing
   with: <step>".
5. **Given** a wait (GitHub, Slack) reaches its time limit, **When** the user is away, **Then**
   the page shows "Still there? Keep waiting" instead of ending the run.
6. **Given** a failed run, **When** the page shows, **Then** it never says "Finished" and never
   shows an error code such as `INTERNAL_ERROR` outside the technical details.

---

### User Story 5 - Choose The Project's Channel Without Guessing (Priority: P2)

The channel step says what the channel is for and asks whether AgentX should create it. If yes,
AgentX creates and joins it. If no, the user picks from the channels the bot can see, or types a
name, and sees the invite step for a private channel before they choose.

**Why this priority**: The blank channel box was the clearest "I can't answer this from the page"
moment in the live check, but it does not strand the install.

**Independent Test**: With a fake Slack, run the channel step both ways: Yes creates a channel and
the bot is a member; No lists the visible channels, and choosing a private one shows the invite
command with a copy button before the user continues.

**Acceptance Scenarios**:

1. **Given** the channel step, **When** it shows, **Then** it says "AgentX answers in this channel
   for this project" and asks "Should AgentX create the channel for you?".
2. **Given** the user answers Yes with a name and public or private, **When** they continue,
   **Then** AgentX creates the channel, the bot is a member, and the installer is invited to it.
3. **Given** the user answers No, **When** the picker shows, **Then** it lists the public channels
   and the private channels the bot is already in, with search, and a field for a channel not
   listed.
4. **Given** the user picks or names a private channel the bot is not in, **When** the choice is
   shown, **Then** the page shows "/invite @<bot handle>" with a copy button and says it notices
   when the bot joins.
5. **Given** the name the user chose for a new channel is taken, **When** creation is tried,
   **Then** the page says so and offers to use that channel or pick another name.

---

### User Story 6 - Finish With Something I Can Read And Use (Priority: P2)

The ready screen stays open, tells the user how to try AgentX, what to send developers, and how to
look after the install, using only commands that work for this install and names rather than IDs.

**Why this priority**: The ready screen disappeared in the live check and pointed to an
unpublished package (#222). It is the hand-off to the team.

**Independent Test**: After a faked install, the ready screen is still served 10 minutes later,
holds no raw Slack markup and no unpublished package names, and every command on it includes
`--env`.

**Acceptance Scenarios**:

1. **Given** the install finished, **When** the user does nothing, **Then** the ready screen stays
   until they press "Close installer" or 30 minutes pass, whichever is first.
2. **Given** the ready screen, **When** it shows the developer sign-in command, **Then** the
   command works for this install as shown (#222).
3. **Given** the ready screen, **When** it names the bot and channel, **Then** it uses the bot's
   handle and the channel name, never a member ID or `<@U...>` markup.

---

### User Story 7 - A Quiet Terminal, And The Same Order Without A Browser (Priority: P2)

With the page open, the terminal prints one line per step. Without a page (SSH, CI, `--yes`), the
terminal path asks in the same order and runs the same early checks.

**Why this priority**: Two copies of the same text compete for attention, and a terminal-only
install should get the same early checks and fewer stops.

**Independent Test**: In page mode, capture the terminal output of a full faked install: three
start lines and one line per step change. In no-UI mode, the step order and the early checks match
page mode, and the existing `--yes` tests pass.

**Acceptance Scenarios**:

1. **Given** page mode, **When** the plan is shown on the page, **Then** the terminal does not
   print the plan or the cost table; both go to the log file.
2. **Given** no-UI mode, **When** the install runs, **Then** the questions come in the same order
   as the page, the same early checks run before anything is created, and no picker or progress
   visual is required.

---

### User Story 8 - Words A Newcomer Understands (Priority: P2)

Every screen uses plain names for what AgentX builds, one name per thing from start to end, and
no internal words. A test keeps it that way.

**Why this priority**: Internal words made the plan and several cards unreadable, and they come
back unless a test stops them.

**Independent Test**: The copy-lint test runs over every source of page text and fails on each
banned pattern; seeded examples of each pattern make it fail.

**Acceptance Scenarios**:

1. **Given** any page text, **When** the copy-lint test runs, **Then** it finds no phase or spec
   numbers, dotted config keys, CloudFormation logical IDs or resource types, raw Slack markup, raw
   Slack or AWS IDs outside technical details, or unpublished package names.
2. **Given** the GitHub app, **When** it is named on any screen, **Then** the same name is used on
   every screen (the slug only in details).

### Edge Cases

- **The browser blocks new tabs.** Every "go elsewhere" step has a visible link button, so the
  user is never stuck (FR-037).
- **Notifications denied or unsupported.** The tab title still changes; nothing else depends on
  notifications (FR-005).
- **The tab is closed or reloaded mid-build.** The run continues; reopening the address shows the
  current state (FR-063).
- **The computer sleeps or the terminal is closed.** The run stops; running `agentx init` again
  resumes at the same address where possible (FR-063).
- **The previous address is taken on resume.** The old tab says the installer moved; the terminal
  prints the new address (FR-063).
- **AWS sign-in expires during the build.** The SSO sign-in code or link appears on the page, not
  only in the terminal (FR-038).
- **The run stops after the GitHub app is created but before its credentials are stored.**
  Resume detects the app and offers to finish it or replace it, with what each removes (FR-032).
- **Slack gives the bot a different handle** (for example `@agentx-production2`) because of a
  clash. The page uses the handle Slack assigned everywhere after that (FR-026, FR-027).
- **The workspace forbids channel creation by apps.** Creation fails with a plain reason and the
  page switches to the pick-or-name path with the answers kept (FR-051).
- **The installer's email is not found in the Slack workspace.** The page asks the installer to
  find themselves in a member search so AgentX can invite them to the new channel (FR-051).
- **A private channel the bot is not in.** It cannot appear in the picker; the name field and the
  up-front invite step cover it (FR-052).
- **The user wants to change an answer a finished step depends on** (for example the GitHub
  owner after the app exists). The page says why it cannot change and offers "Start over" with what
  it removes (FR-062).
- **An Advanced model with no price on file.** The plan shows that line as "not priced", the
  total says what it leaves out, and the budget default is based on the priced lines with a note
  (FR-024).
- **The user is away when the ready screen's 30 minutes end.** The installer stops; the page keeps
  showing the ready content with a note that the installer has closed, and the log file has the
  same summary (FR-059).
- **A failure while the user is in another tab.** The "Action needed" signals fire for failures
  too (FR-005).
- **A second operator runs init on the same install.** The existing lock behavior (spec 015)
  applies; the page shows it as a failure screen with plain words (FR-060).

## Requirements *(mandatory)*

### Functional Requirements

**Page shell and progress**

- **FR-001**: The page MUST show a persistent progress rail with five phases, in this order: Get
  started, Your choices, Build in AWS, Connect Slack, Finish. Each phase MUST show its time
  estimate and a status word (Done, Now, Waiting for you, Coming up, Stopped); status MUST NOT be
  shown by color or symbol alone. A slim header MUST show the install name, AWS account, region,
  "step N of 5" and the overall time left.
- **FR-002**: Time estimates MUST come from measured durations (at least two clean runs per
  step), stored with the step definitions, and shown as "usually N minutes". A running step MUST
  show its elapsed time. A step that runs past its estimate MUST say "taking longer than usual"
  rather than a negative or zero time left.
- **FR-003**: The page MUST have one current-step panel that holds the explanation, any link and
  the question together. Finished steps MUST collapse to one line in the rail with a Details link.
- **FR-004**: The plan and the technical log MUST be behind links ("View the plan", "Show
  technical log") and MUST NOT stay pinned on the page after the plan is confirmed.
- **FR-005**: Whenever the run waits on the user (a question, a link to follow, or a failure), the
  tab title MUST read "(Action needed) Install AgentX"; otherwise it MUST read "Install AgentX
  (step N of 5)". The welcome screen MUST offer "Notify me when AgentX needs me"; when allowed, a
  browser notification MUST fire when the run starts waiting on the user after an unattended wait.
- **FR-006**: The welcome screen MUST say what will be installed, list the five phases with their
  times, state the total time and the time the user is needed, and say to keep the terminal open
  and the computer awake and that the tab can be closed and reopened safely.
- **FR-007**: During the Build in AWS phase, the panel MUST show one row per part being built, in
  plain names, with elapsed time, usual time and resources done out of the expected count, plus
  "You can leave now" and what needs the user next, in about how long.
- **FR-008**: The page MUST announce changes to the current-step panel to screen readers, give
  every field a real label, tie errors and hints to their field, and show question text large and
  in plain case.
- **FR-009**: The page MUST open before the release download and show the download on the page
  with its size and progress.

**Questions and forms**

- **FR-010**: Every question MUST have a label, one line saying why it is asked, an example, the
  default it takes, and a "Learn more" link where one helps. A field whose default is empty MUST
  read "Optional. Leave empty to use AgentX's default."
- **FR-011**: Buttons MUST be labeled with verbs. The forward action MUST be the primary button,
  whatever the terminal default is.
- **FR-012**: A screen MUST be able to ask several related values as one form, validating each
  field inline and keeping valid values when another field is rejected.

**Get started**

- **FR-015**: The account screen MUST ask which AWS profile only when there is more than one, then
  show the account ID, account alias if any and who is signed in, before it asks the region. The
  region question MUST have one line of help and preselect the AWS CLI's default region.
- **FR-016**: When the signed-in identity is the AWS root user, the account screen MUST show a
  plain warning ("You are signed in as the AWS root user. AgentX works, but AWS advises an admin
  user instead."), a "How to create an admin user" link, and "Continue as root". Continuing MUST
  be allowed. The ready screen MUST name any day-2 command that does not work from root.
- **FR-017**: The dedicated-account advice MUST be a one-time tip in plain words, with no double
  negative.
- **FR-018**: The account-level checks (region support, EC2 vCPU quota, Elastic IPs, Amazon
  Bedrock in the region) MUST run right after the region is chosen, before any setting is asked.

**Your choices**

- **FR-020**: Settings MUST be one screen with a "Recommended settings" summary in plain words and
  the default-path fields only: your email, GitHub owner (with owner type detected where
  possible), install name (default `production`, with help on what it names), and the app name used
  for both apps.
- **FR-021**: An "Advanced settings" section MUST hold every other setting: deploy engine, how the
  admin and developers sign in, each model (all as choice lists, the worker model included),
  permission boundary, operator principal, budget amount and scope, the "mentions from other apps"
  choice (reworded in plain words), and the alert destination type and address. No Advanced
  setting MUST be required to reach the plan.
- **FR-022**: The admin sign-in and developer sign-in choices MUST be asked together under one
  heading, "How people sign in", each with one line on who it is for.
- **FR-023**: The default monthly budget MUST be the cost estimate plus 20%, rounded up to a whole
  $10, scoped to the whole account. The budget field MUST show the estimate beside it. Tag scope
  MUST be offered in Advanced only, with one plain sentence on its activation delay.
- **FR-024**: The cost estimate MUST price every model on the default path and every model offered
  as a choice. A model with no price on file MUST be labeled "price not on file" where it is offered.
  The total MUST NOT leave out a line silently: an unpriced line is shown as "not priced" and the
  total says what it does not include.
- **FR-025**: Alerts MUST be offered by default: the email from settings is the default alert
  address. Turning alerts off MUST be possible in Advanced and MUST show one plain sentence on what
  the user gives up. The alert subscription MUST be made as soon as its topic exists, so the
  confirmation email is waiting before the Finish phase.
- **FR-026**: The default name for both the GitHub app and the Slack app MUST follow one pattern
  that includes the install name ("AgentX (<install name>)"), trimmed at a word boundary to each
  platform's length limit. When Slack assigns the bot a different handle than expected, the page
  MUST show the assigned handle and use it from then on.
- **FR-027**: Each thing MUST keep one name on every screen, start to end. The page MUST show
  people, bots, workspaces, channels and apps by name, never by raw ID, outside technical details.
- **FR-028**: After settings and before the plan, the answer-dependent checks MUST run: model
  access and the Anthropic first-use form, image references the release will deploy, stack and app
  name lengths, existing stacks or apps with the same name, and that the GitHub owner exists.
- **FR-029**: The plan MUST be a plain summary: what is created in AWS, GitHub and Slack (by
  name), how long the build takes, a cost table with three columns (item, monthly, basis) and its
  usage assumption stated once, the budget and alert address, that developer sign-in is turned on,
  and how to remove everything later. "Show every resource" MUST reveal the full list (stacks,
  roles, secret paths). The buttons MUST be "Create AgentX" (primary) and "Change answers", which
  returns to settings with every answer kept. Nothing MUST be created before "Create AgentX".
- **FR-030**: Turning on developer sign-in MUST be part of the confirmed plan and MUST NOT ask a
  separate approval later in the run.

**Order of the install**

- **FR-031**: The install MUST run in this order: Get started (account, region, account checks);
  Your choices (settings, answer checks, plan, GitHub app); Build in AWS (every part except the
  Slack connection, unattended); Connect Slack (one visit, then the Slack connection with developer
  sign-in); Finish (admin sign-in, project and channel, alerts, test reply, ready).
- **FR-032**: The GitHub app MUST be created and installed before the long build starts. Any
  setup its credentials need first MUST be short (under about a minute) and run before the GitHub
  step. If the run stops after the app is created and before its credentials are stored, resume
  MUST detect the app and offer to finish with it or replace it, saying what each choice removes.
- **FR-033**: The Connect Slack phase MUST start with the app creation link and two buttons,
  "Installed, continue" and "My workspace needs an admin to approve it", then ask for the Client
  ID, Client Secret, Signing Secret and Bot User OAuth Token on one form, in the order they appear
  in Slack. Each field MUST have a direct link to the Slack page that holds it and a hint of what it
  looks like. On submit, the values MUST be checked, and the bot and workspace shown back by name
  for a yes or "That is the wrong app".
- **FR-034**: The Slack creation card MUST say up front that Slack may show a Request URL error
  and that this is expected. After the Slack connection is deployed, the page MUST show the address
  Slack should have, a link to Event Subscriptions, a countdown, and "It shows Verified" and "It
  still shows an error" (which opens help and a retry).
- **FR-035**: After the build starts, the run MUST wait on the user only in the Connect Slack and
  Finish phases.
- **FR-036**: When the workspace needs an admin to approve the app, the page MUST say the progress
  is saved, keep checking whether the app was installed, and continue by itself when it is. If the
  run is stopped meanwhile, resume MUST continue at this step.
- **FR-037**: Every card that sends the user elsewhere MUST show a link button that works without
  a pop-up, and MUST say it opens in a new tab and to come back. The GitHub return tab MUST close
  itself where the browser allows, and otherwise say to go back to the installer tab.
- **FR-038**: Anything the user must act on that comes from a child process (for example an AWS
  SSO sign-in code) MUST appear on the page.

**Project and channel**

- **FR-050**: The Finish phase MUST ask for the first project on one screen: a repository picker
  (with a note to install the GitHub app only on the repositories AgentX should use), the project
  name prefilled from the repository, the setup and test commands prefilled and editable with one
  line on why AgentX runs them and where they were found, the channel (FR-051, FR-052), and the
  issue trackers as checkboxes with "Skip for now".
- **FR-051**: The channel part MUST say what the channel is for and ask "Should AgentX create the
  channel for you?". On Yes, the user gives a name (prefilled from the project) and public or
  private; AgentX MUST create the channel, join it, and invite the installer, found in the workspace
  by the email from settings. When that email is not found, the page MUST let the installer find
  themselves in a member search. When the name is taken, the page MUST offer to use that channel or
  pick another name. When creation is refused, the page MUST say why in plain words and switch to
  the No path with the answers kept.
- **FR-052**: On No, the page MUST offer a searchable picker of the public channels and the
  private channels the bot is already in, plus a field for a channel not listed. For a private
  channel the bot is not in, the page MUST show "/invite @<bot handle>" with a copy button before
  the user continues, and MUST detect when the bot joins.
- **FR-053**: The Slack app manifest MUST include the bot scopes that creating public and private
  channels needs (`channels:manage`, `groups:write`), because Slack scopes are fixed at install
  time and adding one later forces a reinstall. AgentX MUST use them only when the user answers Yes
  in FR-051.

**Finish**

- **FR-055**: The admin sign-in MUST reuse the email from settings, say which email to expect
  (sender and subject), put the "Sign in to AgentX" button in the same card, and detect completion
  by itself.
- **FR-056**: The alerts step MUST detect the confirmed subscription by itself, then offer "Send a
  test alert" with "It arrived" and "It did not arrive" (which opens help).
- **FR-057**: The test reply step MUST name the bot by handle and app name, link to the channel,
  and show the reply time when the reply lands.
- **FR-058**: The page MUST show the ready summary once, as the ready screen, with no second
  closing card repeating it.
- **FR-059**: The ready screen MUST stay until the user presses "Close installer" or 30 minutes
  pass, whichever is first. It MUST show how to try AgentX in the channel, the developer sign-in
  command that works for this install as shown (#222), day-2 commands with `--env` and copy
  buttons, what was created, and the log file path. When the installer stops, the page MUST keep
  showing the ready content with a note that the installer has closed, and the log file MUST hold
  the same summary.

**Failures and recovery**

- **FR-060**: A failure MUST NOT end the page. The failed step MUST show Stopped in the rail, and
  the panel MUST show a failure screen in three parts: what happened in plain words, what to do as
  at least one page action, and technical details (collapsed: the raw message, the stack name, a
  link to the stack in the AWS console, the log path). A failed run MUST NOT be labeled "Finished",
  and error codes MUST appear only in the technical details.
- **FR-061**: The page actions MUST fit the kind of failure: transient, "Try this step again"; a
  wrong answer, "Change <answer>", which reopens only that field and reruns the step; an outside
  fix (quota, the Anthropic form, Slack admin approval), a link to where to fix it and "I fixed it,
  check again"; a stack that needs cleanup, "Clean up and try again" with a plain sentence on what
  is deleted. Every failure screen MUST also offer "Stop for now", which ends the run and shows the
  command to continue later with a copy button. That is the only place on a failure screen a
  command appears outside the technical details.
- **FR-062**: Each answer MUST be associated with the steps that depend on it. After a failure, and
  on resume, an answer MUST be changeable when no finished step depends on it, and the new value
  MUST be saved to the install record before the step runs again. When a finished step depends on
  it, the page MUST say which step and why, and offer "Start over" with what it removes, where that
  applies.
- **FR-063**: Running `agentx init` again for a stopped install MUST reuse the previous page
  address and access token when it can, and an open tab MUST reconnect by itself. When the address
  cannot be reused, the old tab MUST say the installer moved, and the terminal MUST print the new
  address. On resume, the rail MUST show finished steps as Done and the panel MUST say "Welcome
  back. Continuing with: <step>".
- **FR-064**: A wait for the user (GitHub, Slack, admin sign-in, channel invite, alert
  confirmation) MUST show a countdown and, at zero, "Still there? Keep waiting" instead of ending
  the run.
- **FR-065**: Every input that can make a step fail after AWS resources exist MUST be checked
  before anything is created, wherever a check is possible: region support, quotas, Elastic IPs,
  model access and the Anthropic first-use form, the release's image references, name lengths,
  clashing stacks or apps, the GitHub owner, the budget value and the email address. When a live
  run finds a late failure that could have been checked earlier, its check MUST be added to this
  list before the next release.
- **FR-066**: Model and region failures MUST offer "Change the model" or "Change the region". The
  Anthropic first-use failure MUST offer "Open the Bedrock model catalog" (a link for the chosen
  region), a short list of what to do there, "I submitted it, check again" and "Pick another
  model".
- **FR-067**: When the page loses its connection, it MUST try to reconnect by itself and, if the
  installer has stopped, say so and show the command to continue with a copy button.

**Terminal**

- **FR-070**: In page mode the terminal MUST print three lines at start (the page address; keep
  this terminal open and the computer awake, with the total time; the log file path), then one line
  per step change ("[3/5] Build in AWS: Start the AgentX service (about 13 minutes)" or "[4/5]
  Connect Slack: waiting for you in the browser"), and one line on failure. The plan, cost table,
  deploy output and child process output MUST go to the log file and the technical log only.
- **FR-071**: The log file MUST NOT hold the page's access token.
- **FR-072**: Without the page (no browser, `--no-ui`, `--yes`, CI, SSH), the install MUST follow
  the same order (FR-031) and run the same early checks (FR-018, FR-028, FR-065) as page mode. It
  MUST NOT require pickers or progress visuals. The answer rule of FR-062 MUST apply to answers
  given by flags on resume. The existing `--yes` behavior and flags MUST keep working.

**Words on the page**

- **FR-080**: Page text MUST use plain names for what AgentX builds: "AWS permissions" (access
  stack), "the network and sign-in" (foundation and identity stacks), "the AgentX service" (control
  plane and runtime), "the Slack connection" (Slack service), "install name" (environment), "AgentX
  sign-in" (Cognito user pool), "main model", "safety check model" and "coding model" (orchestrator,
  classifier and worker models), "the address Slack sends messages to" (Request URL). Slack's own
  labels (Signing Secret, Bot User OAuth Token, Client ID, Client Secret) MUST be kept as Slack
  writes them.
- **FR-081**: A copy-lint test MUST run over every source of page text and fail on: phase, spec
  or FR numbers; dotted config keys; CloudFormation logical IDs and resource types; raw Slack
  markup (`<@U`); raw Slack or AWS IDs and ARNs outside technical details; "Enter for"; an empty
  "Leave empty for"; error codes such as `INTERNAL_ERROR` outside technical details; "Finished" on a
  failed run; day-2 commands without `--env`; unpublished package names; and text telling the user
  to pass a CLI flag, run a command or read the terminal, outside "Stop for now", the lost
  connection notice and the ready screen.
- **FR-082**: A test MUST fail when a default model, or a model offered as a choice, has no price
  on file without the "price not on file" label of FR-024.

### Key Entities

- **Phase**: one of the five human-sized parts of the install, with its time estimate, whether it
  needs the user, and its status.
- **Step**: one unit of work inside a phase, with a plain name, a measured time estimate, the
  answers it depends on, and its status (including Stopped).
- **Answer**: one setting, with its default, help text, whether it is on the default path or in
  Advanced, and the steps that depend on it (which decide whether it can still change).
- **Failure screen**: what happened, the page actions that fit the failure, and the technical
  details.
- **Install record**: the existing saved progress of an install (spec 015), extended with the
  answers, the page address and access token for resume.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of screens show the current phase, "step N of 5" and the time left (a test per
  screen).
- **SC-002**: Zero instructions exist only in the terminal: a test asserts that every line the user
  must act on also appears on the page.
- **SC-003**: Zero page text tells the user to pass a CLI flag, run a command or read the terminal,
  outside the allowed places in FR-081 (copy-lint test).
- **SC-004**: Every failure is recoverable on the page: for every step, an injected failure shows
  a failure screen with at least one page action, the page stays up, and the action leads to a
  successful rerun. Zero failures end the page.
- **SC-005**: Values copied by hand between windows are at most 4, all on one screen in one
  Slack visit (today 4, in two trips). The user visits Slack's app settings for values once.
- **SC-006**: After the build starts, the run waits on the user only in the Connect Slack and
  Finish phases (journey test).
- **SC-007**: The default path asks at most 10 questions and needs at most 28 page actions,
  counted by the journey test (today about 17 setup questions and 41 actions).
- **SC-008**: On a clean account, time to ready is 35 minutes or less, and the user is needed for
  12 minutes or less (a timed live run).
- **SC-009**: Zero known failures appear only after AWS resources exist: each item in FR-065 has a
  test that its failure is reported before anything is created.
- **SC-010**: A stopped install resumes in the same tab at the same address (live test: stop,
  rerun, the old tab reconnects).
- **SC-011**: Zero internal words on the page (copy-lint test of FR-081, with a seeded example of
  each banned pattern proving it fails).
- **SC-012**: Every default model and every model offered as a choice has a price or the "price not
  on file" label (FR-082 test).
- **SC-013**: The live check's image failure (gap 1) is fixed on the page in under 5 minutes of
  the user's time, with no teardown.
- **SC-014**: Newcomer usability check: one person who has never installed AgentX and is not an AWS
  expert installs it with no help and gets a Slack reply. An observer records every point where
  they hesitate for more than 30 seconds or ask a question, and asks them at three random moments
  which phase they are in and when they are next needed; they answer correctly each time. Every
  recorded point is fixed or filed as an issue before this spec is done.
- **SC-015**: The existing `agentx init --yes` tests pass, and a test shows the no-UI path asks in
  the same order and runs the same early checks as page mode.
- **SC-016**: Each of the 21 gaps in the traceability table has a passing test or a live check
  item that covers it.

## Gap Traceability

The 21 gaps from the live check, ranked by harm, and the requirements that close them.

| # | Gap | Requirements |
|---|---|---|
| 1 | Stuck after a failure; the fixing answer refused on resume | FR-028, FR-062, FR-065 |
| 2 | Failures go to the terminal; `INTERNAL_ERROR`; "Finished" on failure | FR-060, FR-061, FR-067, FR-081 |
| 3 | Links exist only if a pop-up opens | FR-033, FR-034, FR-037 |
| 4 | Approving the sign-in change blind | FR-029, FR-030 |
| 5 | Blank channel box | FR-050, FR-051, FR-052, FR-053 |
| 6 | No progress view | FR-001, FR-002, FR-007 |
| 7 | Nothing says when it needs you | FR-005, FR-031, FR-035 |
| 8 | Step list out of sync with what is happening | FR-001, FR-003, FR-029 |
| 9 | Page closes the moment the install finishes | FR-059 |
| 10 | Resume opens a new address | FR-063 |
| 11 | 17 setup questions, no recommended settings | FR-010, FR-020, FR-021, FR-022 |
| 12 | Plan is an audit dump; No is the blue button; no way back | FR-011, FR-029 |
| 13 | Terminal repeats the page; terminal-only information | FR-038, FR-070 |
| 14 | Internal words and stale text | FR-080, FR-081 |
| 15 | Slack values copied by hand in two trips, no links | FR-033 |
| 16 | Cost leaves out the worker model; budget below the estimate; tag budget reads $0 | FR-023, FR-024, FR-082 |
| 17 | Alerts never offered | FR-025, FR-056 |
| 18 | Default Slack app name clashes | FR-026 |
| 19 | Names and IDs shift between screens | FR-027, FR-081 |
| 20 | No root user warning; double negative | FR-016, FR-017 |
| 21 | Ready summary points to an unpublished package | FR-059, FR-081 |

## Assumptions

- The measured step times from the live run (AWS permissions about 40 seconds, the network and
  sign-in about 3.5 minutes, GitHub about 2 minutes) are first estimates; FR-002's measured numbers
  replace them before phase 4 ships.
- The GitHub app does not need any stack to be created (it has no webhook). If storing its
  credentials needs a resource from a stack, that resource is created in under about a minute
  before the GitHub step (FR-032).
- Slack's manifest flow cannot hand AgentX the app's credentials without a configuration token, so
  four values are still pasted by hand (SC-005).
- `channels:read` and `groups:read` (already in the manifest) let the bot list public channels and
  the private channels it is in; `users:read.email` (already in the manifest) lets AgentX find the
  installer by email.
- The cost estimate uses the Amazon Bedrock list price for each model in the chosen region; where
  only the provider's list price is known, the plan says so in the basis column.
- The install keeps running only while the terminal process runs and the computer stays awake, as
  today.
- Spec 015's lock, install record and resume, and spec 040's server security rules (loopback only,
  session token, origin checks, secrets never echoed) stay as they are.

## Out Of Scope

- Creating the Slack app and reading its credentials through Slack's manifest API with a
  configuration token, which would bring the pasted values to zero. A later spec.
- Any change to what AgentX deploys, beyond the three named in Context and Decisions.
- Remote or multi-user access to the installer.
- Pickers and progress visuals in the no-UI terminal path (owner decision 5).
- The Slack and admin product issues from the same live check: #215, #216, #217, #218, #219, #220
  and #225 (task and admin experience after install), and #221 (developer sign-in left behind by
  teardown).
- Translations and a mobile layout beyond narrow-screen use of the same page.

## Decisions

**Owner decisions (2026-10-01)**

1. The separate "Apply this change?" for developer sign-in is dropped; it is a line in the plan
   (FR-029, FR-030).
2. The default budget is the estimate plus about 20%, scoped to the whole account; tag scope is in
   Advanced (FR-023).
3. The channel step asks "Should AgentX create the channel for you?". Yes: AgentX creates and joins
   it. No: a picker of channels the bot can see plus a name field, with the invite step shown up
   front for a private channel (FR-051, FR-052).
4. The ready screen stays until "Close installer" or 30 minutes (FR-059).
5. The no-UI terminal path keeps the same order and early checks, without pickers or progress
   visuals (FR-072).
6. A root user is warned, with "Continue as root" (FR-016).
7. Scope B, the full guided redesign, in four PRs against mainline; the first PR carries the quick
   copy and link fixes.

**Decided in this spec (for the owner to confirm)**

- **The channel scopes are always in the manifest** (FR-053). The owner left open whether the
  extra scopes are requested only on Yes or always. Slack fixes scopes when the app is installed,
  and the channel question comes after the Slack app exists, so asking for them only on Yes would
  mean either a reinstall or moving the channel question before the Slack visit. This spec keeps
  the question at the channel step, as decided, and always requests the two scopes.
- **The installer is invited to a channel AgentX creates** (FR-051), found by the email from
  settings. A private channel the bot creates has no other member, so without this the installer
  could not see it.
- **The budget rounds up to a whole $10** (FR-023), so the number on screen is easy to read.
- **Interim action target of 28** (SC-007), short of spec 015 SC-002's 15, which stays the
  long-term goal.
- **Answers given by flags follow the same change rule on resume** (FR-072), so the terminal path
  does not keep the trap of gap 1.

## Phases

Four PRs, each against mainline (no stacking), then one live end-to-end check and an update to
specs 040 and 015.

| Phase | PR | What ships | Requirements |
|---|---|---|---|
| 1 | Page shell and quick fixes (about 2 weeks) | Progress rail with phases and estimates, one current-step panel, help text and forms in the question protocol, verb buttons, the basic failure screen with "Try this step again" for deploy steps and no "Finished" on failure, link buttons on every external card, the copy-lint test and the copy fixes it forces, root warning, one app name pattern, model prices and the budget default, the quiet terminal, the ready screen that stays, #222, and the image check before anything is created | FR-001 to FR-004, FR-005 (tab title), FR-006, FR-008, FR-010 to FR-012, FR-016, FR-017, FR-023, FR-024, FR-026, FR-027, FR-037, FR-058 to FR-060, FR-070, FR-071, FR-080 to FR-082, and the image check of FR-065 |
| 2 | Order and early checks (about 1.5 weeks) | Account checks first, the settings screen with Recommended and Advanced, answer checks, the plain plan with "Change answers", GitHub before the build, one Slack visit, sign-in folded into the Slack connection, alerts offered and subscribed early, the release download on the page, the no-UI path in the same order | FR-009, FR-015, FR-018, FR-020 to FR-022, FR-025, FR-028 to FR-036, FR-038, FR-065, FR-072 |
| 3 | Recovery (about 1.5 weeks) | Page actions by kind of failure, answer change after a failure, same-address resume, waits that do not end the run, the lost connection notice | FR-061 to FR-064, FR-066, FR-067 |
| 4 | Pickers and progress (about 1 week) | The project screen with the channel question and picker, the channel scopes, real build progress, notifications, measured estimates, admin sign-in, alert and test reply cards | FR-002 (measured numbers), FR-007, FR-050 to FR-053, FR-055 to FR-057, and FR-005's notification |

Each phase ships with its own tests (SC-001 to SC-004, SC-009, SC-011, SC-012, SC-015 as their
requirements land). SC-005 to SC-008, SC-010, SC-013, SC-014 and SC-016 are checked in the final
live end-to-end check after phase 4.
