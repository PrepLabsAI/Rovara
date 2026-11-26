# Pull requests and CodeBuild gates

How Rovara validates, publishes and maintains pull requests, and how to add CodeBuild gates.

Pull-request creation is explicit; Rovara never publishes automatically after a coding task. The
registered project's `readiness` commands run inside the EC2 workspace before a candidate is
pushed, inside the dev container when the workspace was prepared with one. Optional repository `codeBuildGates` then run remotely against that exact pushed commit.
Rovara rejects an empty diff, merge conflicts, or any failed/timed-out check before creating a PR.

Ask for it in the thread, naming the repository by its project YAML `name`, for example:
`Create a pull request for the personal-website repository titled "Improve homepage navigation".`
The orchestrator then calls `agentx_create_pull_request`; ordinary coding requests expose no
implicit publish step.

Rovara creates `agentx/<operation-id>`, makes a Rovara-authored commit, pushes without force, and
creates a ready-for-review PR against the repository's configured `defaultBranch`. The terminal
result includes the PR URL and number, commit, head/base branches, and check evidence. Repeating the
same accepted request reconciles the existing branch and PR rather than creating a duplicate. When
CodeBuild gates are configured, the result also identifies each build and its resolved commit,
status, phase, timestamps, and CloudWatch logs link supplied by AWS.

New publication always captures the intended workspace tree and replays it onto the latest remote
default branch as exactly one commit. Earlier Rovara publication commits left in the persistent
workspace are not inherited by the new PR. A conflict or effective empty diff stops before push.

Maintain a Rovara-owned PR from the same thread by naming the repository and PR number: append
the workspace's new commits, sync the base branch into it, update its title or body, or close and
reopen it. The orchestrator makes all of these changes (append, sync, edit title/body, close,
reopen, replace, and revert) through one tool, `agentx_manage_pull_request`, choosing the action
that matches the request.

`append` runs readiness checks and accepts only workspace commits that descend from the recorded
PR head. With CodeBuild gates, append and sync first push an operation-specific validation branch;
the visible PR branch advances only after every build passes. `sync` merges the latest default
branch into the PR branch. Neither action rebases or
force-pushes published history. Remote Pi may rebase or amend commits that are still unpublished,
provided the resulting history remains a descendant of the published PR head; once published, use
another append, or ask to replace the PR with clean history. Replacement creates the new PR before closing the original and never changes the original branch.
For an already merged Rovara PR, ask for a reviewable revert PR instead of changing the default
branch directly.

Only PRs with durable Rovara ownership evidence are eligible. PRs created by an earlier Rovara
version are adopted only when their `agentx/<operation-id>` branch matches a successful publication
operation in the same thread workspace.

The installed GitHub App must have these repository permissions:

- **Contents: Read and write** for cloning and pushing the Rovara branch.
- **Pull requests: Read and write** for finding or creating the PR.

Change them under **GitHub Settings → Developer settings → GitHub Apps → your Rovara app (the
maintainers' is AgentX SDLC; `init` names yours with `--github-app-name`) → Permissions & events →
Repository permissions**. After saving, the installation owner must approve the updated
permissions for the installation. The App private key stays in Secrets Manager; it is never sent to
the worker. Rovara mints short-lived, single-repository tokens separately for clone,
push, and PR operations.

Rovara does not merge, approve, delete branches, add reviewers/labels, or force-push in this
workflow. A Rovara Code (version 2) pull request's description is a verdict with drawers: the result,
the risk and the number of things to check in one heading, six short lines, a numbered list of what
needs a person, and folded sections (described in full below). The "Rovara" Check (on for every hosted install whose GitHub App has the Checks permission) and the "ready for review" line in the chat and the ticket say the same heading. Rovara comments on a pull
request only when a person must act (a failed marked check, a CI fix round after the pull request is
out of draft, a stop), never for good news. The worker rejects force flags, force-with-lease flags, and plus-prefixed refspecs at the
credentialed Git command boundary.

## The pull request's description and the "Rovara" Check

A Rovara Code (version 2) pull request's description, the "Rovara" Check and the "ready for review" line all say one verdict.

- **The description** (redesigned, DEC 254z; the same for every project, there is no switch). It is a verdict with drawers. It opens with one quoted line saying what the change is for, then, between the markers, one heading with three parts (the test result in its fixed words, the risk, and how many things need a person: `Verified · Low risk · nothing extra to check`), six short lines (**Changed**, **Proven**, **Tested against**, **Reviews**, **Risk**, **Needs you**), and, only when something is wrong or weaker than it looks, a numbered list "Check these before you approve". Below that, one closed drawer for each of Requirements and proof, Checks, Test setup, Reviews, Screenshots (only when browser evidence ran) and What Rovara used (only when above zero), each with a summary line that already says its result ("Checks: 3 of 4 passed, 1 failed"); then `Fixes <KEY>` for a Linear ticket, the closing "Plan and record" drawer (the plan, who asked and approved, the audit record, the session link) and the line that a person approves and merges. **A drawer never holds the only copy of bad news:** a failed, blocked, not-run, faked, weakened, out-of-date, disputed or unread item is a thing to check above the first drawer, and the heading says how many. Silent when fine: no "None" sections (no "Lessons used: None", no "Tests added: none"), no per-file list (GitHub's Files changed tab is that; the count stays and flagged files are named), no comment for good news. Without a Testing view the heading uses the fixed words "Checks passed", "Checks failed" and so on, never "Verified".
  It opens saying the changed files have not been read yet, with the risk **not judged yet, treated as high** and the reason "Rovara has not yet checked which files changed against the code host". Within a tracking pass of the push, the changed files are read **from the code host**
  (the files between the base and the checked head, with the host's counts) and the description is rewritten (only if nobody edited it) with the counts; the risk is judged from those files and can then be below high. What the worker reported in `workspace.diff` is never believed:
  the proof page shows it only as "reported by the worker, not checked", and it can never lower the risk. A host that cannot list the files leaves the risk high and is asked again. A description over the size limit shrinks in a fixed order (tables fold their passed rows, "What Rovara used" becomes a count and a link, drawer bodies become "Listed in the Rovara Check and on the task page", the list keeps its first 10 things); the quote, the heading, the six lines, the markers and the closing line never shrink away. The words come from one verdict object (`packages/contracts/src/pr-verdict.ts`), which also writes the title of a Ready "Rovara" Check when the host supplies it; `tests/fixtures/pr-body/*.md` are the whole description of four example tasks, kept as files so every change to the layout shows as an exact diff.
- **The same verdict everywhere it is said** (L4-PRP, design pr-redesign.md B4 and B7). One function builds the heading, the six lines and the list of things to check (`prVerdictOf`, `packages/contracts/src/pr-verdict.ts`) from the facts of the code now on the pull request, and the surfaces take its words and nothing else. The description is built by `workflowPullRequestBody`; the "Rovara" Check's title and text by `workflowPullRequestCheckVerdict` (same inputs, same functions, the same last guards: Linear words sealed, no email address), asked through the build step's `createPullRequestVerdictSource` (`core/build-step/pull-request-verdict.ts`), which reads the same description inputs as `verifyPublishedChanges` (`descriptionInputsOf`). The Check's text starts with the heading, the six lines and the whole list of things to check, then the gate's own parts (Change proof, Your CI, Full suite); the title of a **Ready** Check is the heading, unless the result is a failed or could-not-run one (a green Check is never titled "Code failed checks"). The verdict never changes the Check's conclusion, status or title for a hold, a neutral reason or a refusal: only the table does. The source answers only for this company's task, a Rovara Code workflow with a candidate, and an open pull request at the head the Check is written for, holding the checked candidate; for anything else, a read that fails, a read over two seconds, or a kept file list at its 200-file limit (the description was made from the whole list, so the numbers could differ) it says nothing, and the Check is what it was. The files come from the code host's list, never the worker's: with none the verdict says the files were not read and the risk is treated as high. `createMergeTrackingService` gives the Check this source whenever the host passes `summaryCheck` (its gate, facts and address; a host that passes none gets no Check, as before), and a verdict the host passes itself is kept. **The Check is on for everyone** (L4-RC, owner decision 2026-11-17: the pull request redesign has no switch): the hosted job services (`createHostedBrokerCoreServices`, `aws/core-job-services.ts`, used by the deployed broker) passes `rovaraCheckSource()` (`services/rovara-check.ts`: the gate is open for every task and nothing else is decided there; the conclusion is still only `rovaraCheckOf`'s table). Hosted, the company-scoped code host (`aws/core-code-host.ts`) offers the Check write and the App's id, each held to the company's own repositories like every other call; the write mints its own token that asks for Checks write on that one repository. An install whose GitHub App was never given the Checks permission (an App made before the manifest asked for it, until its owner accepts the new permission) refuses that token: no Check is written, the pass and everything else go on unchanged, one `summary_check.no_permission` line is logged, and the write is asked again after an hour, not on every pass. Rovara never makes its Check a required check: only a customer's own branch rule can, and then a failed Check (a change-proof hold or a failed full suite) blocks the merge, a Rovara problem is neutral, and the pass does not wait on the Check as if it were the customer's CI. The Check has no "Details" link yet: Code has no address for a core task's page (the description has none either). When Rovara marks a pull request ready for review it asks the same source once, and says the heading in the "ready for review" line on the task's timeline, in the chat (under the pull request's link, in the Slack plugin's card; the hosted Slack adapter in `aws/slack-adapter.ts` does not say it yet: that file has an accepted port-guard entry, so its one-line change waits for the controller) and in the ticket's comment (`Result: ...`); the milestone's `verdict` field holds only the heading's fixed words and counts, and a heading its schema does not take is left out and never stops a pull request from being marked ready.

## Configure CodeBuild gates

CodeBuild projects are administrator-owned infrastructure. Create a project with a GitHub source
(use AWS CodeConnections for private repositories), a service role, compute image, and repository
`buildspec.yml`. Its name must begin with `agentx-`. Add the approved project to the repository in
the Rovara project YAML, increment `revision`, and register that immutable revision. New threads
then use it:

```yaml
repositories:
  - name: personal-website
    url: https://github.com/example/personal-website.git
    path: repo/personal-website
    defaultBranch: main
    credentialRef: github-agentx-sdlc
    codeBuildGates:
      - name: quality
        projectName: agentx-personal-website-quality
        timeoutMinutes: 30
      - name: browser
        projectName: agentx-personal-website-playwright
        timeoutMinutes: 45
```

Unit tests, backend integration tests, and Playwright commands belong in the CodeBuild project's
buildspec. Rovara supplies only the exact Git commit as `sourceVersion`; it does not allow the
worker to override the buildspec, image, role, environment, source, or artifacts. The broker owns
`StartBuild`/`BatchGetBuilds` permission scoped to `agentx-*` projects, while the worker receives no
CodeBuild AWS credentials. A failed new-PR build leaves its candidate branch for diagnosis but
creates no PR. A failed existing-PR build leaves the PR head unchanged.

This release gates one repository publication at a time. Testing unpublished frontend and backend
candidates together and creating multiple PRs as one unit requires a future multi-repository
change-set workflow; a CodeBuild project may use secondary sources, but Rovara does not yet bind
multiple candidate commits atomically.
