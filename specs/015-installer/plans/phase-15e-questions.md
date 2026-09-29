# Phase 15e: questions for the owner

The spec leaves these product decisions open. The plan
([phase-15e-day-two.md](phase-15e-day-two.md)) is written to the recommendation for each, and the
tasks that depend on one say so. Nothing is blocked: answer when convenient, and a changed answer
only changes the tasks named.

For each question: the options, the recommendation, and what it costs if the recommendation is wrong.

## 1. How does `agentx destroy` confirm?

FR-055 says the operator types the environment's name and no flag skips it. The brief adds: refuse
production, and any environment AgentX did not create, unless confirmed by typing.

- **A.** Type the environment's name, always. Nothing more.
- **B. (recommended)** Type the name, always. For an environment named `production`, or one with
  neither settings nor install answers (AgentX has no record of creating it), also type the AWS
  account id shown on screen. No flag skips either.
- **C.** B, plus a `--i-understand` flag for `production`.

Recommendation: **B.** The account id is a second, deliberate step exactly where a slip is most
costly, and it never becomes a habit for ordinary environments. The authors' own adopted deployment
(fixed stack names) is refused outright, whatever is typed.

Cost if wrong: small. Either direction is a few lines in `confirmationPrompts` (Task 14) and its
tests (Tasks 14, 16).

Tasks: 14, 16.

## 2. What does `destroy` remove by default, and what does `--keep-data` keep?

FR-055 removes the retained data by default and keeps it with `--keep-data`. Two tables hold
history people may want: the turn records (the audit of what each Slack turn did, kept 30 days) and
the developer sign-in table (sessions and change audit, spec 025).

- **A. (recommended)** As FR-055 says: remove everything by default; `--keep-data` keeps every table
  (turn records and developer sign-in included), bucket, secret, the Cognito user pool and the KMS
  keys, and removes the rest (log groups, parameters, local files).
- **B.** Keep the turn records and developer sign-in tables by default; a `--delete-audit` flag
  removes them.
- **C.** Export the audit tables to the artifact bucket before deleting (then the bucket is deleted
  too, so to a local file).

Recommendation: **A.** It is what the spec says, `destroy` exists to leave nothing behind (retained
names block a reinstall), and `agentx admin turns export` already exports turns before a teardown if
someone wants them. The plan's text shown before confirming lists every table by count.

Cost if wrong: B adds a flag and a kept-by-default list (Task 14's `KEPT_BY_KEEP_DATA` and Task 16);
C is a new export step of about a day. Data deleted under A cannot be recovered, which is why the
typed confirmation exists.

Tasks: 14, 16.

## 3. What does `agentx upgrade` do when the target release is older than the environment's?

- **A. (recommended)** Refuse, naming both versions. The same release is allowed (a re-run finishes
  an upgrade that stopped).
- **B.** Refuse unless `--allow-downgrade` is given.
- **C.** Allow it with a warning.

Recommendation: **A.** A newer release may write data or settings an older one cannot read (the
worker parses strictly, which is why the upgrade order puts it first), and CloudFormation rolls back
a failed stack but not data. A real rollback is "deploy the previous release's fix forward", or
restore from backups, not a downgrade command.

Cost if wrong: B is a flag and one test (Task 10). Nothing is lost by starting with A.

Tasks: 10, 12.

## 4. `config set limits.workspacesPerMember` and `limits.workspacesPerOrg` before spec 025 phase 25e

FR-048 maps both keys to the control plane's workspace limits setting (spec 025 FR-053, D8), which
the broker already reads. The only writer is 25e's `agentx_admin_set_workspace_limits` admin change
tool (with confirmation and audit), which is not built yet.

- **A. (recommended)** `config list` and `get` show both keys with the install-time default and say
  the control plane may hold a newer setting; `config set` refuses them with a message naming 25e.
- **B.** `config set` writes the DynamoDB item directly with the operator role (a new
  `dynamodb:PutItem` permission on the state table, no audit record).
- **C.** Build a small control-plane admin route for the setting in 15e, ahead of 25e.

Recommendation: **A.** B bypasses the confirmation and audit D8 chose, and widens the operator role;
C builds part of 25e twice. The stack parameters already give every new install sensible limits.

Cost if wrong: B needs a policy change, a test and a spec line (about half a day); C about two days
and overlaps 25e.

Tasks: 3, 4.

## 5. Does `doctor` detect drift, or only report the last result?

FR-050 asks for drift. CloudFormation's drift detection reads every resource with the caller's own
rights, which the least-privilege operator role does not have (it would need read access to every
service AgentX uses).

- **A. (recommended)** `doctor` reports each stack's last drift result (`DescribeStacks` carries it)
  and, when drift has never been checked or a stack drifted, prints the admin command to check or see
  it.
- **B.** `doctor --detect-drift` starts detection and waits, and needs admin credentials.
- **C.** Widen the operator role with read access to every service, so `doctor` always detects.

Recommendation: **A,** with B as a small later addition if people ask. C breaks least privilege for
a check that rarely changes the answer.

Cost if wrong: B is about half a day (a flag, a wait, tests). C is a policy change the platform team
must approve.

Tasks: 5.

## 6. What does the release test automate?

The spec's release tests include a live Slack reply and `alerts test` in a throwaway account. A
pre-made test Slack app's Request URL cannot follow each new environment's API address without
Slack's App Manifest API and a rotating app configuration token; the admin user's first sign-in
needs a browser; an email alert subscription needs a person to confirm it.

- **A. (recommended)** The workflow installs with each engine up to `developer-signin`
  (`init --stop-after`), runs `doctor`, upgrades from the previous release, changes a setting under
  the operator role, runs the export path under the operator role, and destroys everything. The
  Slack reply, `alerts test`, the manual-guide teardown and SC-001 are a documented manual release
  check (docs/releases.md).
- **B.** A, plus the Slack App Manifest API with a configuration token stored and rotated in a
  GitHub secret, a test Slack user token to post the mention, and an https endpoint that confirms
  the SNS subscription, so the whole flow runs unattended.
- **C.** Keep every release test manual.

Recommendation: **A.** It automates everything that can fail silently between releases (templates,
both engines, upgrade, IAM under the operator role, teardown) and leaves the three person-only steps
to a short checklist.

Cost if wrong: B is two to three days, plus a Slack token that must be rotated on every run.

Tasks: 18 (and 19 for the checklist).

## 7. `destroy` needs admin credentials

SC-005 says day-2 commands run under the operator role alone. `destroy` deletes the access stack and
its IAM roles, and the retained data, which the operator role cannot do by design.

- **A. (recommended)** `destroy` refuses the operator role up front and says it needs admin
  credentials. SC-005 is read as excluding `destroy`, and the spec says so.
- **B.** Give the operator role delete rights on the environment's stacks and data, and let the
  platform team delete the access stack.

Recommendation: **A.** Removing an environment is the one irreversible act; asking for the same
rights that created it is what a platform team expects, and it keeps the operator role narrow.

Cost if wrong: B is a large policy change (deletes on every data service), a split teardown, and a
harder story for the platform team.

Tasks: 16, 17.

## 8. Changing `alerts.address` leaves the old subscription

The operator role has `sns:Subscribe` (email and https only) but no `sns:Unsubscribe`: 15d2 kept it
out, and a test pins that.

- **A. (recommended)** `config set alerts.address` subscribes the new address and prints the exact
  `aws sns unsubscribe` command for each old subscription, for an admin. A webhook is shown only by
  its host.
- **B.** Add `sns:Unsubscribe` on the environment's topic to the operator role, and have
  `config set` remove the old subscriptions.

Recommendation: **A** for this phase. B is reasonable (a topic-scoped unsubscribe cannot reroute
alerts elsewhere), but it reverses a 15d2 decision and its test, so it should be the owner's call.

Cost if wrong: B is a policy line, a spec line, a test change and about ten lines of code.

Tasks: 4.

## 9. The access stack during `upgrade` under the operator role

The operator role cannot change the access stack (it holds the IAM roles; changing it is the
platform team's job).

- **A. (recommended)** Under the operator role, `upgrade` compares the deployed access template with
  the release's. Unchanged: it upgrades every other stack. Changed: it stops before deploying
  anything and names `agentx upgrade --export`, whose bundle includes the access stack. With admin
  credentials, `upgrade` deploys access first. (With the cdk engine, whose templates differ from the
  published ones, it prints a notice and skips access.)
- **B.** Always skip the access stack, and leave it to the platform team to notice.
- **C.** Always require admin credentials for `upgrade`.

Recommendation: **A.** It keeps the common upgrade under the operator role (SC-005), and it never
leaves the access stack silently behind a release that needs it.

Cost if wrong: B risks a stack that no longer matches the release; C loses SC-005 for upgrades.

Tasks: 12, 13.

## 10. `doctor`'s Asana check

FR-050 asks for each connector's test read. For Asana, a test read needs a fresh access token, and a
refresh rotates the refresh token the control plane's broker holds.

- **A. (recommended)** `doctor` checks that the Asana credential exists with a refresh token (so the
  bot finished signing in) and does not refresh it. Linear and Jira get a real read.
- **B.** `doctor` refreshes, reads the project, and writes the rotated refresh token back to the
  secret (a race with the broker's own refresh).
- **C.** Ask the control plane to test the credential (a new admin route).

Recommendation: **A** now, C later with spec 025's admin reads. B can break a working connector if
the broker refreshes at the same moment.

Cost if wrong: an expired Asana credential shows up in Slack instead of in `doctor`. C is about a day
in the control plane.

Tasks: 7.

## 11. The typed confirmation when stdin is not a terminal

FR-055's typed name has no flag. The release test (question 6) must destroy what it made, unattended.

- **A. (recommended)** When stdin is not a terminal, `destroy` reads each typed answer as a line from
  stdin, so `printf 'rt12t\n' | agentx --env rt12t destroy` works and still requires the exact name.
- **B.** A `--confirm <env>` flag.
- **C.** The release test tears down by the manual guide only.

Recommendation: **A.** It keeps "no flag skips this" literally true: something must still type the
environment's name, and a script that pipes the wrong name removes nothing.

Cost if wrong: B is one option and one test; C loses the automated check of `destroy` itself.

Tasks: 17, 18.
