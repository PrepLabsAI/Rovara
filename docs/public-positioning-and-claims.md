# Public positioning and claim boundaries

Reviewed against AgentX `mainline` at `b9f008bfd60540d05d5eaa757ca086e5ab55f69b` on 2026-10-05. This is a source review, not live AWS acceptance, customer proof, or an owner-approved brand or license decision.

## Recommended positioning

**Category:** a remote coding-agent runtime and task workflow.

**Lead:** “Delegate a coding task. Get the change and its check report.”

**One-breath explanation:** AgentX runs a coding agent in a persistent, isolated workspace in your AWS account. Start from Slack or hand off from Claude Code, Codex, or Cursor. AgentX reports what its available checks passed, failed, or could not verify; a person reviews and merges the pull request.

This communicates the whole job: task intake, code work by the coding agent, persistent workspace, a check report, and the handoff to human review. The verification layer supports the workflow; it is not the whole product.

## Audience and value

- **CTOs and VPs of Engineering:** see where delegated work runs, which account owns the environment and bill, how check outcomes are reported, and where human review and merge authority remain.
- **Developers:** continue from familiar Slack or MCP entry points, let the remote coding agent work in a persistent workspace, and inspect the change and its check report.
- **Good first audience hypothesis:** teams with AWS ownership, an engineering platform function, and developers already using Slack plus Claude Code, Codex, or Cursor. This is positioning to validate in interviews, not established market demand.

## What current mainline supports

- `packages/worker/src/run-task.ts` installs the verification extension in both new and resumed Pi sessions.
- `packages/worker/src/verification/extension.ts` runs the check flow when the agent settles, gives one extra attempt when a regression is found, and can report a run as not verified when it stops, errors, or has nothing usable to check.
- `packages/worker/src/verification/checks.ts` runs project readiness commands when configured; otherwise it can use recognized test commands the agent ran. Outcomes include passed, failed, timed out, skipped/not run, or not verified depending on the case.
- `packages/worker/src/publish.ts` runs readiness checks during publication and passes the candidate commit to configured CodeBuild gates. When the broker requests check reporting, check results are sent with the pull request. If the reporting flag is absent, failed readiness checks block PR creation.
- The worker reports results; those results do not prove software correctness. No blanket claim that every task has a passing test suite is supportable.

## PR behavior in plain language

There are two compatibility paths in the current code. With the reporting-enabled broker, failing readiness checks can be included in a draft pull request so a person can inspect the change and failures. A broker that does not request check reporting rejects the publication when readiness checks fail. Describe this as the current code behavior, not as proof that every deployment uses the newer broker path.

CodeBuild gates receive the candidate commit. Task-time readiness checks run in the workspace as part of publication. Do not say every check is rerun against the exact PR commit. AgentX can open a pull request; it has no merge path.

## Claims to use and claims to avoid

| Use | Avoid |
|---|---|
| “AgentX runs a coding agent in a remote workspace and returns a change with a check report.” | “AgentX proves the code works.” |
| “The report shows what passed, failed, or could not be verified.” | “Every task is verified” or “every check passes.” |
| “A person reviews and merges the pull request.” | “AgentX merges safely” or any implication that a human gate is enforced by a configurable approval prompt on every action. |
| “The current reporting-enabled broker can open a draft PR with failing check results.” | “A PR opens only after every check passes.” |
| “Configured CodeBuild gates run against the candidate commit.” | “All checks always run on the exact PR commit.” |
| “Deploys into your AWS account; AWS and model charges depend on configuration and use.” | “Free,” “one-click,” “secure by default,” or cost certainty. |
| “Source-available under FSL-1.1-ALv2.” | “Open source” until the license actually changes to an OSI-approved license. |

## Proof status

- **Repository CI:** PR #300 was merged at the pinned mainline commit. Its GitHub run reported nine checks passed; the PR's own test summary reported 7,867 passing and 20 environment-gated tests skipped. This is automated repository evidence. It is not an independent review, successful end-to-end AWS install, customer use, or product correctness proof.
- **Live acceptance:** the source includes live-service tests, but this review did not establish a completed, end-to-end deployment-to-PR acceptance run in a real AWS account. Do not claim production readiness or live install success from unit, contract, integration, or CI results.
- **Evaluations:** a pilot and evaluation tooling exist. The controlled model-comparison campaign in `specs/046-model-cost-comparison/spec.md` is still marked draft. Keep pilot and benchmark claims private until methods, run records, matched conditions, limitations, and independently checked outputs support a public statement.
- **Release:** the AgentX repository is private and no public release or npm package is available in this snapshot. Offer the field guide and setup prerequisites; do not advertise a working public install.
- **License:** FSL-1.1-ALv2 is source-available, not OSI open source. If an Apache-at-launch decision is accepted, update the actual license and its notices before changing launch copy.

## Category and page research

Snapshot date: 2026-10-05. Reviewed official product pages:

- [Herdr](https://herdr.dev/) leads with persistent coding-agent sessions that keep running across disconnects and machines, followed by a real terminal view and a direct install path.
- [Paperclip](https://paperclip.app/about/) sells an open-source agent-management system through the executive concept of agents with org charts, budgets, goals, and human governance.
- [OpenHands Enterprise](https://www.openhands.dev/enterprise) markets cloud-isolated coding runs, integrations, pull requests, control, and cost/governance features.

These examples show that remote persistence, integrations, isolation, and PR creation are category language, not sufficient differentiation by themselves. AgentX should lead with the concrete combination it implements: customer-account deployment, persistent coding work, an explicit check outcome report, and a human-controlled merge. The site should show one reproducible task journey when a consented, redacted demonstration can be published.

## Naming and open-source decisions

- Keep **AgentX** as the working product name in this update. The code, CLI, configuration, infrastructure, and evidence refer to AgentX; a display-brand change must not silently rename those stable identities. “Rovara” is currently the website's publisher/organization brand. Product naming and legal/trademark clearance remain open; this review does not approve a rename.
- Keep license wording at **source-available** until the repository license changes. A real open-source launch requires an accepted license decision, the corresponding LICENSE and third-party notice review, public repository/release artifacts, a reproducible install path, contribution/security guidance, and matching website/docs language.

## Website conversion path

1. State the task outcome in the hero, not the infrastructure mechanism alone.
2. Show the request-to-code-to-check-report-to-human-review path with the real system diagram.
3. Give leaders a short account, cost, review-authority, and failure-behavior explanation.
4. Give builders prerequisites and a first-task path that works on a clean supported setup.
5. Link directly to source and install only when public release artifacts exist; until then, make the unavailable status explicit.
6. Add benchmark, customer, time-saving, security, and production claims only when their underlying evidence is publishable and reviewable.
