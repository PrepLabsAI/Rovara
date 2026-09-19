# Research: Create Pull Request

## Decision: Use installation tokens narrowed per repository and action

**Decision**: Mint separate installation tokens for Git push (`contents: write`) and pull-request
reconciliation/creation (`pull_requests: write`), each restricted to the selected repository.

**Rationale**: GitHub supports restricting an installation token by repository and permissions.
HTTP Git access requires Contents permission, while creating a pull request requires Pull requests
write permission. Separate tokens prevent the worker from receiving PR API authority.

**Alternatives considered**: One token with both permissions was simpler but unnecessarily exposed
PR API authority to repository processes. A long-lived PAT violated the existing secret boundary.

Sources: [installation token endpoint](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app),
[GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app),
[pull-request endpoint](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request).

## Decision: Reconcile by deterministic branch before creating

**Decision**: Generate the branch from the publication operation ID, push without force, query for
an open pull request matching that head and configured base, and create only when absent. After an
ambiguous creation failure, query again before reporting failure.

**Rationale**: At-least-once dispatch and HTTP timeouts can repeat requests after GitHub accepted a
side effect. A deterministic head/base pair is externally observable and makes retries convergent.

**Alternatives considered**: Random branch names created inside the worker could duplicate on retry.
Blind POST retry could create errors or duplicates. Persisting tokens for later retry was rejected.

Source: [GitHub pull-request endpoints](https://docs.github.com/en/rest/pulls/pulls).

## Decision: Reuse registered readiness commands as the first publication gate

**Decision**: Rerun all commands already registered as project readiness checks before staging or
committing publication changes.

**Rationale**: This preserves administrator control and requires no mutable client-supplied shell
policy. Projects that require tests must include them in readiness. The result records each check.

**Alternatives considered**: Letting the local model invent test commands weakened reproducibility.
Adding a new project schema field would require immediate workspace migration work unrelated to the
first PR slice. External CodeBuild/Jenkins orchestration remains a later feature.

## Decision: Commit in the worker; create the PR in the broker

**Decision**: The worker validates files, creates the local branch/commit, and pushes using askpass.
The broker calls GitHub's PR API through a capability-scoped internal request.

**Rationale**: Git operations need the mounted checkout, while the broker owns Secrets Manager and
external control-plane side effects. This preserves the local-orchestrator boundary and gives the
broker one place to redact GitHub failures.

**Alternatives considered**: Giving Pi a general GitHub token or `gh` login expanded authority.
Uploading patches to the broker would duplicate Git behavior and mishandle large/binary changes.

## Decision: Ready-for-review, one repository, no force

**Decision**: The first version creates one ready-for-review PR for one configured repository,
targets its registered default branch, and never force-pushes, merges, approves, or deletes.

**Rationale**: This is the smallest complete review workflow and makes side effects understandable.

**Alternatives considered**: Draft/reviewer/label support and coordinated multi-repository PRs add
policy and partial-failure states that should be designed separately.
