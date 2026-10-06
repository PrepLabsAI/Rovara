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
workflow. The worker rejects force flags, force-with-lease flags, and plus-prefixed refspecs at the
credentialed Git command boundary.

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
