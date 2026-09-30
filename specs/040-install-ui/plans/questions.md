# Spec 040 Phases 2 to 4: Owner Questions

Phase 1 (the wizard server, the browser prompter, the event and log streams, and the review and
resume screens behind `--ui`) merged as PR #146. Planning phases 2 to 4 raised thirteen decisions the
spec leaves open. Each has two to four options, the recommended one first.

The plans follow every recommendation. A task that depends on an answer says "Depends on Q<n>", so
a different answer changes only the tasks named below it. Each plan's last spec task records the
answers in the spec.

- [phase-2-connect.md](phase-2-connect.md): the AWS, GitHub and Slack connect screens and the
  prerequisite checklist.
- [phase-3-finish.md](phase-3-finish.md): the admin user, project, channel bind and test reply
  screens.
- [phase-4-default.md](phase-4-default.md): the page on by default, packaging and docs.

## Q1. What does `agentx init` do when neither `--ui` nor `--no-ui` is given?

FR-001 already says: the page, when a browser is available and the session is interactive,
otherwise the terminal. The spec's Decisions also say the terminal path stays. This asks you to
confirm that phase 4 really switches the default, and that the terminal path is kept rather than
removed.

- **A (recommended).** Do what FR-001 says. In an interactive terminal on a machine that can open a
  browser, `agentx init` opens the page. Anywhere else (`--yes`, CI, CloudShell, SSH, no terminal)
  it asks in the terminal, as today. `--no-ui` always means the terminal. Nothing is removed.
- **B.** Keep the terminal as the default for one more release, and make the page the default in the
  release after. Phase 4 then ships only packaging and docs.
- **C.** Page only: remove the terminal questions. This breaks User Story 4 (headless installs) and
  every CI and CloudShell install, so it is not recommended.

**Cost if wrong:** low. The choice is one function (`resolveUiMode`) and its tests.

**Depends on it:** phase 4 Tasks 1 and 4.

## Q2. What happens on a machine with no browser (SSH, CloudShell, a container)?

User Story 4 says the wizard "prints its URL and falls back to the terminal prompter". Both at once
would mean two places answering the same question.

- **A (recommended).** Ask in the terminal, as today, and print one line first: "No browser here, so
  agentx init asks in this terminal. To use the install page instead, run agentx init --ui and open
  the address it prints (over SSH, forward its port with ssh -L)." No page is started.
- **B.** Start the page anyway, print its address and the `ssh -L` command, and ask nothing in the
  terminal. The operator must forward a port before they can do anything.
- **C.** Start both, and take whichever answer arrives first. Two prompts for one question is
  confusing, and a secret typed in the terminal while the page shows the same field is easy to get
  wrong. Not recommended.

**Cost if wrong:** low. It is one branch in phase 4 Task 2.

**Depends on it:** phase 4 Task 2.

## Q3. What happens when the browser tab is closed in the middle of an install?

Today (phase 1) the run keeps waiting for the page's answer, with no word in the terminal. The page
comes back whole when the address is opened again (it gets a full snapshot on connect).

- **A (recommended).** Keep waiting. When a question is waiting and no page has been connected for
  60 seconds, print once in the terminal: "The install page is closed. Open <address> to continue,
  or press Ctrl-C to stop; agentx init continues from here next time." Stopping is already safe:
  the progress is in SSM and the next run resumes.
- **B.** Move the rest of the questions to the terminal once the tab has been closed for 60 seconds.
  Secrets would then be typed into the terminal mid-run, which the operator did not expect.
- **C.** Stop the install when the tab closes. A browser that reloads or loses its connection for a
  moment would then end a 30-minute install.

**Cost if wrong:** low. One timer in the wizard (phase 4 Task 2).

**Depends on it:** phase 4 Task 2.

## Q4. How are secrets typed into the page?

FR-012 fixes where a secret may go (only through `cleanSecret` to Secrets Manager; never to the page,
an event, a log line, a progress note or disk). FR-040 asks for masked fields. The spec is silent on
the field's own behaviour.

- **A (recommended).** A masked field with no "show" button. Password managers are asked not to fill
  or save it (`autocomplete="off"` and the common "ignore" attributes). The field is emptied the
  moment its value is sent, and the question area is emptied once the answer is taken, so the value
  does not stay in the page even hidden. A refused value must be pasted again.
- **B.** As A, plus a "show" button, so the operator can check what they pasted. Easier to fix a bad
  paste; the secret is then on screen.
- **C.** The page never takes a secret: it asks for a file path, and the CLI reads the file. Safer
  against shoulder-surfing, but Slack and GitHub show these values in a browser, so it adds a copy to
  disk that FR-012 exists to avoid.

**Cost if wrong:** low. A few lines of the page's module.

**Depends on it:** phase 2 Task 1.

## Q5. When the install needs another site (GitHub, Slack, the AgentX sign-in page), who opens it?

The terminal path opens the system browser for each one. In the page, a new tab that appears on its
own is easy to miss, and some browsers block it.

- **A (recommended).** The page shows a button, and the operator clicks it; the link opens in a new
  tab. The installer opens only the first tab (the page itself). With `--no-browser`, the page still
  shows the same buttons.
- **B.** Open each site in a new tab automatically, as the terminal path does, and also show it on
  the page.

**Cost if wrong:** low. One function (`openLink`) decides it.

**Depends on it:** phase 2 Tasks 2 and 5; phase 3 Task 2.

## Q6. May the page accept GitHub's redirect back, which comes from another site?

FR-030 wants GitHub's manifest callback served by the wizard's own address. GitHub sends the browser
back with a normal link from github.com, which carries no session token and is a cross-site visit,
so the phase 1 checks (FR-010, FR-011) would refuse it.

- **A (recommended).** One narrow exception: `GET /github/created`, only while this run is waiting
  for a GitHub App, only with the manifest flow's own `state` (checked in constant time), and only
  once. The `Host` check still applies. The answer is a short page that says "go back to the Install
  AgentX tab" and reveals nothing. Every other route keeps every check.
- **B.** Keep GitHub's return on the separate one-time port the terminal path uses today. FR-030 is
  then not met, and the operator sees a second local address.
- **C.** No callback: the operator copies the address GitHub sends them to and pastes it into the
  page. That is the "copying between windows" User Story 2 rules out.

**Cost if wrong:** medium. It is the one relaxed check in the server, so it is where a reviewer
should look hardest (phase 2 Review Focus).

**Depends on it:** phase 2 Task 5.

## Q7. When a check fails on the page, does the page offer to try again?

FR-023 (prerequisites), FR-041 (the Request URL) and FR-051 (the test reply) ask for checks that can
be run again without restarting. Today every one of them stops the run with "run agentx init
again". The alert subscription wait also stops the run when nobody has confirmed within 10 minutes.

- **A (recommended).** On the page only: the card shows what failed and what to do, and asks "Check
  again?". Yes runs the check again; No stops the run with today's message. The terminal path is
  unchanged, so its tests and its scripts stay as they are (SC-004).
- **B.** The same "check again" question in the terminal too. Friendlier there as well, but it
  changes the terminal path, its tests, and the unattended `--yes` behaviour.
- **C.** Stop on the page too, as today. Simplest, but FR-023 and FR-041 are then not met.

**Cost if wrong:** low. One helper (`retryOnPage`) decides it for every check.

**Depends on it:** phase 2 Tasks 2, 4 and 7; phase 3 Tasks 4 and 5.

## Q8. When Slack refuses a bot token that looks right, what does the page do?

FR-040 asks for the two format checks (`checkSlackBotToken`, `checkSlackSigningSecret`) inline. A
token can pass them and still be refused by Slack (revoked, another workspace, a user's token
pasted in the wrong field), or the operator can say "no, that is not the right bot".

- **A (recommended).** On the page, show Slack's reason on the Slack card and ask "Paste the Slack bot
  token and signing secret again?". Yes asks for both again; No stops as today. Nothing is saved
  until a token is accepted. The terminal path is unchanged.
- **B.** Stop the run with the reason, as the terminal does. The operator runs `agentx init` again
  and it continues at the Slack step.

**Cost if wrong:** low. One loop in the Slack step.

**Depends on it:** phase 2 Task 6.

## Q9. How does the AWS screen pick and sign in to a profile?

FR-020 and FR-021 ask for a profile list, the chosen profile's account, and a sign-in action.

- **A (recommended).** List the profiles in `~/.aws/config` and `~/.aws/credentials` (or
  `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`). When there are two or more, ask which one;
  one is used without asking. The choice is not saved: a resumed install asks again, and the
  existing account check stops it if the profile is for another account. Sign-in runs
  `aws sso login --profile <name>` for an IAM Identity Center profile and `aws login --profile
  <name>` for an `aws login` profile; for access keys or a role, the page says to fix it in a
  terminal and offers "check again". Keys in the environment (`AWS_ACCESS_KEY_ID`) win over any
  profile, so no profile is asked then.
- **B.** As A, plus an `--profile` flag for the terminal path too.
- **C.** As A, but save the profile name in the install answers, so a resume does not ask. The
  answers are shared by everyone who resumes an install from any machine, and profile names are
  per machine, so this is not recommended.

**Cost if wrong:** low. Only phase 2 Task 3 reads profiles.

**Depends on it:** phase 2 Task 3.

## Q10. What does the last screen say about day-2 commands?

FR-052 says the manual follow-up commands go once the install finishes the job itself. They have:
since spec 015 phase 15d2, `readyText` no longer lists commands needed to finish, only optional
ones (more projects, more connectors, a test alarm).

- **A (recommended).** The final card leads with what works now (where to talk to AgentX, and how
  developers sign in), then lists the optional commands under "Later, if you want more". Nothing on
  it is needed to finish.
- **B.** Drop the optional commands from the page; keep them in the terminal only.

**Cost if wrong:** low. One card builder.

**Depends on it:** phase 3 Task 6.

## Q11. Where do the page's files live?

The spec's Decisions say "static assets built to `packages/cli/dist/ui/`". Phase 1 instead put the
page, its stylesheet and its module in `page.ts` as text, so they compile into the CLI with
everything else and ship in its one bundled file with no copy step. FR-060 also names
`release:build` output, but `release:build` builds the CloudFormation templates and never carries
the CLI; the CLI ships only as the npm package.

- **A (recommended).** Keep phase 1's way, and correct the spec: the assets are part of the CLI's
  compiled code; FR-060 is met by the npm package, and a test checks the page is inside it.
- **B.** Move them to real files in `packages/cli/dist/ui/`, copied by the build and by
  `release:pack-cli`. This adds a copy step and a way to ship a CLI without its page.

**Cost if wrong:** low either way; B is a build change plus a pack test.

**Depends on it:** phase 4 Task 3.

## Q12. Is the page the default on Windows?

`openSystemBrowser` supports macOS (`open`) and Linux (`xdg-open`) only; on Windows it throws.

- **A (recommended).** On Windows the default stays the terminal. `--ui` still works there: it prints
  the address, and the operator opens it.
- **B.** Teach `openSystemBrowser` to use `start` on Windows now, and make the page the default there
  too. Nobody installs AgentX from Windows today, so this is untested work.

**Cost if wrong:** low. One platform check in `browserAvailable`.

**Depends on it:** phase 4 Task 1.

## Q13. How do the three phases ship and get live-checked?

The project rule is one throwaway environment at a time (the Elastic IP quota), a live check per
phase with your go-ahead, and PRs that target mainline (no stacked PRs).

- **A (recommended).** Three PRs, one per phase. Each is branched from mainline after the one before
  it merges. Phases 2 and 3 each do a full install through the page in a throwaway environment
  (`live40b`, then `live40c`), torn down the same day (about $3 a day while it exists, plus the
  EC2 time of one test reply). Phase 4's check is cheap: the packed CLI with no flags opens the page
  on your Mac and stops after the prerequisites (`--stop-after prerequisites`), which creates only
  the install's SSM parameters; the same command in CloudShell asks in the terminal.
- **B.** One PR for phases 2 and 3 with a single full install at the end, then phase 4. Cheaper, but
  a problem found in the live check is harder to place, and the PR is about twice the size.

**Cost if wrong:** a day of calendar time either way.

**Depends on it:** every plan's live-check task.
