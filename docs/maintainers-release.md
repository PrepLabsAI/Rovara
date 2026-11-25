# Maintainers' production release

This page describes the maintainers' own deployment and its release pipeline. To move an
installed environment to a newer release, use `agentx --env <name> upgrade`; see
[Running Rovara](day-two.md#upgrade).

Registering a project and binding its channel are covered in [Administration client and projects](administration.md#2-register-a-project-and-bind-its-slack-channel). Workspaces are created by
Slack threads and by tasks from AI tools, never by an administrator.

For the production EBS-backed platform, preview the release without changing AWS:

```sh
npm run release:prod -- --profile agentx-deployer --region us-east-1 --dry-run
```

The first real production release creates the protected foundation (dedicated two-AZ VPC, two NAT
gateways, KMS key, private worker security group, flow logs, and an EC2 worker launch template), then creates worker settings. Later releases refuse to modify that foundation
and update only the runtime and control plane:

```sh
npm run release:prod -- --profile agentx-deployer --region us-east-1
```

The release updates worker settings and the control plane. Each workspace keeps its EBS volume;
a new image takes effect the next time its compute starts. Project registration and workspace
preparation are separate operations.

## Continuous production releases

`AgentXReleasePipeline` runs the same release from AWS for every qualifying push to `mainline`,
first to beta, then, when the owner approves that run, to production (#1242). It is a CodePipeline V2
pipeline, `AgentXProductionRelease`, with three stages:

```
Source (mainline push, Cloud release tag) → Beta (every run) ⏸ disabled transition → Production (its own approval, per run)
```

The pipeline also deploys the companion Cloud product (the gateway, web and app) next to Code.
Its repository is a second source, `CloudGitHub`, and its steps are CodeBuild projects that
belong to a separate private stack, referenced here only by name through parameters. Each stage
runs, in this order, with Preflight first:

| Action | What it does |
|---|---|
| `CodePreflight` | In Production, first of all, closes the transition into Production, so a newer run cannot pass the open transition while the run waits for its approval or runs its gates, and a rejected or timed-out run leaves the transition closed. Then, in both stages, runs the port guard on the Code tree with the private name list (it fails if the list cannot be loaded), whatever the CI proof says. Read-only: its role can clone the Code repository but not push (UseConnection is denied when `ProviderPermissionsRequired` is `read_write`) |
| `ApproveProduction` | Production only, right after the Code Preflight: a CodePipeline manual approval for THIS run (see "Approving a production run"). Every other Production action, all of them writers, starts only after it is approved |
| `Preflight` | Read-only: resolves the Cloud ref, pins Code, runs the gates, previews the change sets and writes the manifest; exports the effective `CODE_RELEASE` |
| `CloudImage`, `CloudGateway`, `GatewayCheck` | Cloud's gateway image and deploy, then the check that the live gateway satisfies this Code |
| `ReleaseBeta` / `ReleaseProduction` | The Code release below |
| `CloudWebApp`, `CloudProof` | Cloud's web and app deploy, then its live proof |

The order is the gateway, then Code, then web and app.

- **Beta:** the CodeBuild project `release-agentx-beta` runs the release in the beta
  account, as that account's `agentx-beta-release` role. CI's proof (below) is read first, in the
  release account.
- **Production:** the transition into it stays disabled. The newest beta run waits in front of
  it; a newer one replaces it (the pipeline runs in SUPERSEDED mode), so one promotion carries every
  merge since the last. `release-agentx-preflight-production` closes the transition again as the first
  command of the stage, before anything else, so each promotion lets one run in whatever happens next. The
  stage's next action, `ApproveProduction`, is a manual approval that belongs to one pipeline execution.

A run starts from a push to `mainline` that changes a deployable path (table below), or from a
Cloud release tag (`vX.Y.Z`, not `vX.Y.Z-suffix`). A run started by a Cloud tag releases the
newest `mainline` commit with it, and the other way round.

Pipeline variables, each with a default so a push or a tag can start a run (override them when
you start a run by hand):

| Variable | Default | Meaning |
|---|---|---|
| `CLOUD_REF` | `from-trigger` | The Cloud release tag to deploy. `from-trigger` (what every triggered run carries) means the one `vX.Y.Z` tag on the Cloud commit the run started from (`CLOUD_SOURCE_COMMIT`); Preflight refuses, before any write, when that commit has no such tag or more than one. `latest` (the newest tag on the Cloud trunk) is for a run you start by hand. An older tag is a Cloud rollback and forces `CODE_RELEASE=skip` |
| `CODE_RELEASE` | `run` | `skip` releases Cloud only; the commit's Code waits for a later run. Preflight may force `skip`, never `run` |
| `CLOUD_PROD` | `off` | `off` leaves production's Cloud as it is for this run, so no push or tag deploys it. Start the run that promotes with `CLOUD_PROD=on` (and `CLOUD_REF` set to the tag, by hand): a tag push alone never reaches production, which also needs the transition into Production enabled |
| `PIPELINE_MODE` | `release` | `adopt` only checks that Cloud as deployed is what the pipeline would deploy and changes nothing; run it once per environment before the first `release` run (the stage tool refuses a release run in an environment it never adopted). `rollback` deploys an earlier released Code commit (`CODE_ROLLBACK_TARGET`) and/or an older Cloud tag (`CLOUD_REF`) |
| `CODE_ROLLBACK_TARGET` | `none` | With `PIPELINE_MODE=rollback`: the full 40-character Code commit to deploy. It must be in the stage's release history (below). `none` leaves Code as it is. Any other mode requires `none` |

A `skip` run replaces a waiting promotion like any other run, so Preflight says which Code commit
it leaves unpromoted.

The Code release, in both projects, runs:

```sh
npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation
```

(the beta one with `--profile agentx-beta`), unless the stage's Preflight exported
`CODE_RELEASE=skip`, in which case the build installs nothing and deploys nothing. After a release
that finished, the build's last command records the commit it released in an SSM String
(`/agentx/release/code-released/beta` or `/production`), which is never written for a `skip` run.

The port guard step trusts only that record. It runs the guard as it was at the previously released
commit, over everything since (always the whole range from that commit to this one), and refuses, with
nothing run, in these cases:

- The record is missing or unreadable, or names a commit that is not in the clone or not an ancestor of
  this one.
- The landing is several commits on the released commit with none a merge (a rebase merge, or a merge
  queue group landed without merge commits). The message says how many commits and what to do: the next
  normal merge, a merge commit on top of them, releases them scanned whole; or re-land the change as one
  squash or one merge.

An octopus merge (three or more parents) is refused with its own message. A merge commit (including a queue group of merges), a single squash commit directly on the released
commit, and a run with no new Code are accepted. Seed each record once, by hand, with the commit now live
(`aws ssm put-parameter --type String --name <parameter> --value <40-hex sha>`): until then the first run
refuses. The repository's merge settings are not what protects this step; the check is.

Each release also keeps a short history of what the stage released: an SSM String beside the record
(`/agentx/release/code-history/beta` or `/production`), a JSON list of the last 10 commits, newest first. The
same braced step that records the commit writes it (the history first, the record last, nothing for a failed
release or a `skip` run), with the same writer rule: only the stage's release build role may write it, and only
its own. A missing or garbled list does not stop a forward release: the next one starts a new list from what is
valid. A list it cannot read for any other reason stops the build before anything is written.

**Rolling Code back** is a pipeline run with `PIPELINE_MODE=rollback` and `CODE_ROLLBACK_TARGET=<40-hex sha>`.
The Code Preflight refuses it, exit 2, before the worktree exists and before any guard runs, unless the stage's
history is readable and lists the target, the target is not the commit already released, is in the clone, and is
older than (an ancestor of) the released commit. A history that is missing or garbled refuses a rollback (it
never reads as "any commit"). The guard that runs while the private name list is on disk is still the CURRENT
released commit's, over the range target..released; nothing from the target, or from the commit that started the
run, runs then. The release build then checks the target out, releases it, and on success records it as the
released commit and moves it to the head of the history. The run goes through the same gates as any other
(Preflight, the protected-resource gate, the rollback floors, drift) and, for Production, the same approval (the transition, then
`ApproveProduction`). A rollback needs `CODE_RELEASE=run` (a Cloud-side `skip` with a target stops the Code build: Code
would not move) and `PIPELINE_MODE=rollback` with target `none` is a Cloud-only rollback (`CODE_RELEASE=skip`).
The next forward run is judged from the rolled-back commit: every commit since is scanned again, whole; a
squash that sits on a later commit than the rolled-back one is refused as a linear landing until a merge commit
lands.

The release build repeats the history and ancestor checks on the target before it checks anything out (its role
can read the history too): the history lists the target, and the target is in the clone and an ancestor of the
run's commit. So a build that reaches it some other way still cannot deploy a commit that was never released.

The Code Preflight exports ONE value, `CODE_CTX`, to that stage's Cloud Preflight action only (CodePipeline caps
an action's configuration value at 1000 characters, and the Cloud actions are close to it; every action keeps at
least 100 characters of headroom, which a test checks). It has no quotes and four parts:
`live:<40hex>,target:<40hex|none>,supersedes:<execution id|none>,supersedesSha:<40hex|none>`: the stage's released
commit (the stage tool's rollback pin), the rollback target, and, from Beta's Preflight, the execution waiting in
front of Production that this run replaces with the Code commit it holds, for the promotion summary. Production's
Preflight always says `none` for the last two (the stage tool keeps Beta's). The waiting-run lookup is best
effort: a lookup that fails prints a warning and leaves both `none`.

Runbook notes for a rollback:

- The history starts at the first release after the pipeline goes live, so the first rollback needs two finished
  releases, or a hand-seeded history: `aws ssm put-parameter --type String --name <history parameter> --value
  '["<40-hex live sha>"]'` in the release account (an admin act; it only widens the targets to the commit that is
  live now).
- After a rollback, land the next fix as a merge commit (the merge queue does): the next forward run is judged from
  the rolled-back commit, and a squash that does not sit directly on it is refused as a linear landing until a
  merge commit lands.
- Production rolls back only to a commit Production itself released: it checks Production's own history, so a
  commit that only Beta released is refused at Production's Preflight (after Beta has already rolled back; do not
  approve the run then).
- Rolling Code back to a commit before `3ce46251e` (the dispatch rule for an owner-only People list) parks every
  task that has a People record. A People record is created the first time someone opens a task's People view, so
  any hosted task may have one. The older dispatcher has no owner-only, no-checker branch. Treat such a rollback as
  one that strands those tasks, and move forward again to a commit that has `3ce46251e` as soon as the reason for the
  rollback allows. A staging proof is still owed: start a hosted task, open People, and check the next step
  dispatches.

A Cloud rollback run (`CLOUD_REF` set to an older tag) forces `CODE_RELEASE=skip` unless it also names a Code
rollback target.

There is no other adoption switch: nothing named `ROVARA_ADOPT_*` is a pipeline variable or an action
input. `PIPELINE_MODE` is the only one, and every Preflight prints the mode as a note.

### Approving a production run

Every production deploy needs the owner's explicit approval for that run (DEC 254zzz506). Two things hold
a run back, and they do different jobs:

- the disabled transition holds the run that is waiting (a newer run replaces it, so you promote beta's newest commit);
- the `ApproveProduction` action, right after the Production `CodePreflight` (which closes the transition
  first, so the gate is closed whether the run is approved, rejected or times out), releases one execution.
  An approval belongs to the execution that waits at it, so an open transition alone can never let a run
  into Production unapproved. If the transition is enabled while nothing waits, or stays open because the
  Production `CodePreflight` failed before its first command, the NEXT run enters the stage and stops at its
  own approval.

To promote the commit waiting in front of Production, as the owner:

1. Enable the transition in the console (**Enable transition** above the Production stage), or:

   ```sh
   aws codepipeline enable-stage-transition --pipeline-name AgentXProductionRelease \
     --stage-name Production --transition-type Inbound
   ```

   The waiting run enters Production and stops at `ApproveProduction`.
2. Open that run's `ApproveProduction` action (**Review** in the console). Its text names the pipeline
   execution, the Code commit, the Cloud source commit of the run, `CLOUD_REF`, `CLOUD_PROD`, `CODE_RELEASE`,
   `PIPELINE_MODE` and `CODE_ROLLBACK_TARGET`. Check the execution id against the run you meant to release, and
   the Cloud tag Beta resolved and deployed in Beta's `Preflight` log (it is not an exported variable, so the
   approval text cannot show it; the Cloud source commit is not always the commit that tag points at). Then approve, or reject (a rejected run stops and the stage unlocks), or from a terminal:

   ```sh
   aws codepipeline get-pipeline-state --name AgentXProductionRelease   # the approval token of the waiting action
   aws codepipeline put-approval-result --pipeline-name AgentXProductionRelease --stage-name Production \
     --action-name ApproveProduction --token <token> --result summary="<what you checked>",status=Approved
   ```

An approval that nobody answers fails after 24 hours (the run stops, the stage unlocks, and the next run
starts its own wait). Rejecting a run, or letting it time out, leaves the transition closed (the Code
Preflight closed it before the approval), and a later run would stop at its own approval anyway.

No role the template creates may approve, enable the transition, or start, retry or roll back a run: the
only `codepipeline` rights in it are the Production `CodePreflight`'s `DisableStageTransition` (it can only
close the gate) and the Beta `CodePreflight`'s read of the pipeline state. Approving is the owner's own
identity (an administrator or an SSO permission set that holds `codepipeline:PutApprovalResult` on
`AgentXProductionRelease/Production/ApproveProduction`). Nobody else is to hold it, and the Cloud projects' roles
(in the private stack) must not either; check that stack when it changes.

Nothing waiting means production already runs beta's newest commit. A failed production
release leaves the transition disabled; the next promotion takes beta's newest commit again.

| A push to `mainline` that changes | Result |
|---|---|
| Only docs, specs, top-level `tests/`, `scripts/` or `.github` | No pipeline execution |
| Any other deployable package (`packages/broker`, `cli`, `code-api`, `gateway`, `mcp`, `orchestrator`, `slack-service`), `environments/` or `infra`, but no worker image input | Checks, then a control-plane deploy. The deployed worker digest is reused and the runtime is unchanged |
| A worker image input: `packages/worker`, `packages/contracts`, `packages/model-runtime`, the Dockerfile, `.dockerignore`, root `package.json`, `package-lock.json` or tsconfigs, or a workspace `package.json` | Checks, a new ARM64 image, a runtime update to `READY` on that digest, then a control-plane deploy |

Whether the worker changed is judged against the deployed image. The pipeline reads the commit
from the image's `release-<time>-<commit>` tag and diffs the worker image inputs up to `HEAD`. So
a worker change from a failed or superseded execution is still released by the next one. If that
commit cannot be determined, the pipeline builds a new image. Any change under `infra/` that
alters `AgentXProductionFoundation` fails the release until an administrator reviews and deploys
the foundation manually. The pipeline never creates the foundation and never deploys itself.

One-time setup, with an administrator's credentials. The private Cloud actions stack must exist first
(CodePipeline refuses an action whose CodeBuild project is missing), and so must its projects' roles:

```sh
npm run build --workspace @agentx/infra
npx cdk deploy AgentXReleasePipeline --app 'node infra/dist/bin/agentx.js' \
  --profile agentx-deployer -c agentxRegion=us-east-1 \
  --parameters GitHubConnectionArn=<codeconnections-arn> \
  --parameters BetaAccountId=<beta-account-id> \
  --parameters CloudRepoOwner=<cloud-repo-owner> \
  --parameters CloudRepoName=<cloud-repo-name> \
  --parameters CloudRepoBranch=<cloud-trunk-branch> \
  --parameters CloudConnectionArn=<cloud-codeconnections-arn> \
  --parameters CloudBetaProjectName=<release-... project name> \
  --parameters CloudProductionProjectName=<release-... project name> \
  --parameters PortGuardNamesParameterName=<ssm parameter name of the private name list> \
  --parameters PortGuardNamesKeyArn=<kms key arn of that parameter>
```

`<codeconnections-arn>` is the ARN of the already-authorized GitHub connection in the release account;
`<cloud-codeconnections-arn>` is the one that can read the Cloud repository (it may be the same).
Find the values in the private release runbook (kept outside this repository). The two project names
must start with `release-`: the broker starts only `agentx-*` projects and the legacy runtime
boundary denies every CodeBuild action on `release-*`. The port guard's name list is an SSM SecureString
in the release account; the stack takes only its name and the key's ARN. The Cloud projects' roles need the stack's
`ArtifactBucketName` output (the artifacts pass through that bucket) and `codeconnections:UseConnection`
on both connections. Redeploying an existing pipeline stack keeps the GitHub connection and beta-account values
it already has, so those two `--parameters` can be left out. The pipeline never deploys itself, so this is always by hand;
review the change set first (`--no-execute --require-approval never --change-set-name <name>`).

### What each build role may write into the artifact bucket

The bucket is not versioned and holds every artifact of every run, including the `Source` and `CloudSource` artifacts the Production stage
reads after the approval. So each build role writes only its own output (PH-S3-PREFIXES): `PutObject` and `AbortMultipartUpload` on its own
output prefix, plus an explicit Deny (`NotResource` of that prefix) of `s3:PutObject*`, `s3:DeleteObject*` and the abort on everything else.
The two Code roles' prefixes are `<pipeline>/ReleaseMan*` (ReleaseManifest) and `<pipeline>/BetaReleas*` (BetaReleaseManifest); the Cloud
roles (private stack, same rule) hold `State<Beta|Prod>*`. The Cloud state artifacts are named `State<Beta|Prod><Action>` (for example
`StateBetaPreflight`) so one short prefix tells an environment's states from every other artifact; nothing is allowed on a bare `Beta*`.

- **First-run check.** The key layout used (`<pipeline name, first 20 characters>/<artifact name, first 10 characters>/<id>`) is the one CodePipeline is
  believed to use; it has not been read from a real run. After the first beta run, list the keys once (`aws s3 ls s3://<ArtifactBucketName>/ --recursive`
  from the release account) and check that every artifact sits under `AgentXProductionRele*/` and that the state artifacts sit under
  folders starting `StateBeta` or `StateProd`. An `AccessDenied` on an artifact upload in the first run means the layout differs: fix the
  pattern (here and in the private stack), do not widen it to the whole bucket.
- **Shared folders are expected.** With the 10-character cut, artifacts whose names share their first ten characters share one folder: the four
  beta states `StateBetaCloudImage`, `StateBetaCloudGateway`, `StateBetaCloudWebApp` and `StateBetaCloudProof` all live under `StateBetaC/` (and
  likewise `StateProdC/`; the Preflight and GatewayCheck states have `StateBetaP/`, `StateBetaG/`). That is safe: every object id under a folder is unique
  per artifact and run, a later stage reads an artifact by its exact key, and the grants are by the `StateBeta*` or `StateProd*` prefix, which this does not change.
- **Deploy-order coupling.** This pipeline and the private Cloud actions stack share the pipeline name, the 20/10 numbers and the state
  names (one digest of them is pinned in `tests/contract/release-pipeline-s3-prefixes.test.ts` and, as the same literal, in the Cloud
  repository's `cloud-release-actions.test.ts`). The Cloud stack's new grants refuse the old names (`Beta<Action>State`). First deploy: Cloud actions stack
  first (projects must exist), then this stack, as above. If an older pipeline with the old names is already running: update THIS stack first
  (the Cloud stack's old whole-bucket grant works with either names), then the Cloud actions stack, and merge both changes together.
- **Known, not a regression.** The beta Cloud role can still overwrite `StateBetaCloudProof`, the artifact the Production Preflight reads
  (it writes its own state; before this change it could write anything). The pipeline's own role and the two source action roles also keep
  CDK's whole-bucket read-write; scoping them and enabling bucket versioning are follow-ups.

The beta account needs, once, before the pipeline's first beta release:

1. CDK bootstrap (`npx cdk bootstrap aws://<beta-account-id>/us-east-1`).
2. The beta release role, `AgentXBetaReleaseAccess`:

   ```sh
   npx cdk deploy AgentXBetaReleaseAccess --app 'node infra/dist/bin/agentx.js' \
     --profile <beta-profile> -c agentxRegion=us-east-1 -c agentxBetaAccess=enabled \
     --parameters ReleaseAccountId=<release-account-id>
   ```

3. The same first release production had: the foundation, the control plane (its own sign-in pool,
   callback signing key and GitHub App key secret), then one local
   `npm run release:prod -- --profile <beta-profile> --require-existing-foundation` with
   `AGENTX_MODEL_PROVIDER` and `AGENTX_MODEL_ID` set. Beta has its own Slack, GitHub and Linear
   apps; never point production's at it.
4. Beta's address, `beta.rovara.dev`, in front of the beta control plane's API:

   ```sh
   npx cdk deploy AgentXBetaDomain --app 'node infra/dist/bin/agentx.js' \
     --profile <beta-profile> -c agentxRegion=us-east-1 -c agentxBetaDomain=enabled \
     --parameters DomainName=beta.rovara.dev --parameters ApiId=<beta control plane API id>
   ```

   The `rovara.dev` zone is in the release account, so add ACM's validation record there while
   the deploy waits, then an alias A record for `beta.rovara.dev` to the stack's
   `RegionalDomainName` (`RegionalHostedZoneId`).

Protect `mainline` in GitHub. The build role can deploy through the CDK bootstrap roles, so push
access to `mainline` is deploy access. To roll back, revert the change on `mainline`, or run
`npm run release:prod -- --worker-image <digest>` locally with an earlier digest from
`agentx-worker-production`.

Spec 014 phase 14c part 1 adds an optional `actionPolicy` field to project definitions, ahead of
the gate that reads it in part 2. Its rollback floor (plan R6) starts the moment any project
revision stores `actionPolicy`, not once part 2 ships: a stored revision with the field fails the
strict parse of any component older than 14c, including the worker's `prepare` invocation and the
administration CLI's local project-file check. Before reverting 14c1, or rolling the control plane
or runtime back below it, confirm no stored project revision carries `actionPolicy`:

```sh
export AWS_PROFILE=agentx-deployer AWS_REGION=us-east-1
STATE_TABLE_NAME=$(aws cloudformation describe-stacks --stack-name AgentXControlPlane \
  --query "Stacks[0].Outputs[?OutputKey=='StateTableName'].OutputValue" --output text)

aws dynamodb scan --table-name "$STATE_TABLE_NAME" --consistent-read \
  --filter-expression "#et = :project AND attribute_exists(#def.#ap)" \
  --expression-attribute-names '{"#et":"entityType","#def":"definition","#ap":"actionPolicy"}' \
  --expression-attribute-values '{":project":{"S":"PROJECT"}}' \
  --projection-expression "pk, sk"
```

This is read-only. Each item the scan returns is one offending revision: `pk` is
`PROJECT#<project-name>` and `sk` is `REV#<revision, zero-padded>`. If the response carries a
`LastEvaluatedKey`, repeat the scan with `--exclusive-start-key` set to it before treating an empty
page as clean. `actionPolicy` cannot be removed from a stored revision: project revisions are
immutable. Registering a new revision without the field only changes what a new thread, and an
existing thread's non-disk settings, read going forward; a thread whose workspace is still pinned
to an older revision that carries `actionPolicy` keeps reading that revision, so reverting stays
unsafe for it until that thread closes or the revision is otherwise no longer live.

Spec 014 phase 14c part 2 turns the action gate on. Operator notes:

- In the Slack app's **Interactivity & Shortcuts** settings, turn Interactivity on and set the
  Request URL to the `AgentXControlPlane` output `SlackInteractivityUrl`. Without it a button press
  reaches no one, and members must confirm by replying `@AgentX yes`.
- On Slack Enterprise Grid, the team ID in a button press may differ from the one in the thread's
  mention events. A press would then find no pending confirmation and answer that it is no longer
  pending. This has not been checked on a Grid workspace; there, a typed `@AgentX yes` still works.
- A confirming `yes` claims its confirmation only after the thread's conversation bookkeeping (the
  workspace check, the conversation record and any settings notice), just before the turn runs, so
  a request that stops early leaves the question pending. Two answers racing each other can both do
  that bookkeeping; only one claims and runs the calls, and the other is told the confirmation was
  already used.
- The part 1 rollback floor above still applies.
- Rolling the control plane back below this release does not break the turn record export, but
  `agentx admin turns export` then skips every record that has a call `gate` or one of the new
  dispositions: the older control plane's record schema refuses them, counts them as `skipped` and
  logs `turn_record.invalid`. The records stay in the table and export again after rolling forward,
  within their 30 days.
- Rolling the Slack service back below this release while confirmations are pending turns a
  button press (the control plane still queues it as "yes" or "cancel") or a typed `@AgentX yes`
  into an ordinary, ungated turn. The model may then re-issue the call it was holding back, and it
  runs without asking. Roll back only when no confirmation is pending, or tell members not to
  answer pending ones.
- Turn records gain a `gate` object on each call and the dispositions `confirmation_refused`,
  `confirmation_cancelled` and `yes_to_all_granted`. Only `answered` and `failed` count in turn
  metrics. The
  service logs `gate.decision` for each call, and `gate.confirmation_requested`,
  `gate.confirmation_approved`, `gate.confirmation_cancelled`, `gate.confirmation_refused` and
  `gate.yes_to_all` for answers. `gate.reply_withheld` means a turn's only reply was its
  confirmation; the turn record still keeps the model's text.
  `gate.confirmation_failed` means a question could not be saved or posted; the member is told
  that nothing it would list will run.

Spec 014 phase 14d adds the **Details** button. Operator notes:

- Only the last part of a reply gets the button, and only when that turn made at least one tool
  call and its turn record will be written. Replies without tool calls, confirmation questions and
  Rovara's own notices have no button. If Slack refuses the button (an API error such as
  `invalid_blocks`), the reply is posted as plain text and the Slack service logs
  `reply.details_failed` with Slack's error code as `slackError`. A network error or timeout is
  logged the same way without a code and is not followed by a text copy, since Slack may already
  have posted the reply; the request is retried like any failed post.
- Who can open it: any member who can see the reply, from the thread's own workspace. A member of
  another organization in a Slack Connect channel is told "AgentX couldn't find the details for
  this reply.", and nothing is read. So is a press whose payload carries no workspace team ID. On
  Enterprise Grid, a member of a sibling workspace in the same grid may open it when the press
  carries the same grid ID for the workspace and the member; the record's own team must still
  match the thread's. The Grid case has not been checked on a Grid workspace. Every refusal is
  logged as `interaction.details_refused` with a `reason` (for example `external_member`,
  `expired`, `not_found`) and the viewer's user ID. A sibling-workspace press that finds no record
  is told the details couldn't be found (`not_found_foreign_team`), never that saving failed.
- What it shows: a call's arguments are stored redacted and capped at 2,048 characters. The view
  shows at most 2,000 characters of each call's arguments, and less when a turn made many calls.
  Record text is escaped, so it cannot form a link, mention or alert in the view. The request and
  response text, the workspace and the worker operations are never read.
- Turn records are kept 30 days. After that the view says "AgentX keeps turn details for 30 days.
  The details for this reply, from <date>, are no longer kept." It says so from the button alone,
  without a read, and also for a record DynamoDB has not deleted yet.
- A press within 60 seconds of the reply, before the record is saved, says the details are still
  being saved. A record that was never saved points to `turn_record.write_failed`. A record that
  fails its schema (`interaction.details_invalid`) points to `agentx admin turns export`. A read
  that fails or takes more than 1 second (`interaction.details_read_failed`) says to press
  Details again. If the view cannot open (`interaction.details_open_failed`), the member gets
  "I couldn't open the details in time. Press Details again." privately.
- The control plane sets `TURN_RECORDS_TABLE_NAME` on the ingress Lambda. It is optional. Without
  it, the Lambda logs `interaction.details_not_configured` at the first button press after it
  starts, and every Details press says the details couldn't be loaded. Approve and Cancel keep working.
- The ingress Lambda's role gains one statement: `dynamodb:GetItem` on the `TurnRecords` table,
  not its index, and no Query or Scan. The partition key must start with `THREAD#`. The read must
  name only the attributes the view shows, plus the keys `pk`, `sk`, `exportPk` and `exportSk`
  (`TURN_DETAILS_READ_ATTRIBUTES` in `infra/lib/control-plane.ts`). A `Null` condition refuses a
  read that names no attributes, which would otherwise return the whole record, request text
  included. The Slack service still only puts turn records, and the broker still only queries them.
- Release in this order: runtime, then control plane, then Slack service. The control plane's
  Details handler stays dormant until the Slack service posts buttons. After the control plane
  deploys, and before the Slack service does, check the grant with the IAM policy simulator:

  ```bash
  FUNCTION=$(aws cloudformation describe-stack-resources --stack-name AgentXControlPlane \
    --query "StackResources[?ResourceType=='AWS::Lambda::Function' && starts_with(LogicalResourceId, 'SlackIngress')].PhysicalResourceId" --output text)
  ROLE=$(aws lambda get-function-configuration --function-name "$FUNCTION" --query Role --output text)
  TURNS=$(aws cloudformation describe-stacks --stack-name AgentXControlPlane \
    --query "Stacks[0].Outputs[?OutputKey=='TurnRecordsTableName'].OutputValue" --output text)
  TABLE=$(aws dynamodb describe-table --table-name "$TURNS" --query Table.TableArn --output text)
  # The Details attributes: "allowed".
  aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names dynamodb:GetItem --resource-arns "$TABLE" \
    --context-entries "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=THREAD#x,ContextKeyType=stringList" \
      "ContextKeyName=dynamodb:Attributes,ContextKeyValues=pk,sk,eventId,calls,ContextKeyType=stringList" \
    --query 'EvaluationResults[0].EvalDecision'
  # The request text: "implicitDeny".
  aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names dynamodb:GetItem --resource-arns "$TABLE" \
    --context-entries "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=THREAD#x,ContextKeyType=stringList" \
      "ContextKeyName=dynamodb:Attributes,ContextKeyValues=pk,sk,requestText,ContextKeyType=stringList" \
    --query 'EvaluationResults[0].EvalDecision'
  # No attributes named at all: "implicitDeny".
  aws iam simulate-principal-policy --policy-source-arn "$ROLE" --action-names dynamodb:GetItem --resource-arns "$TABLE" \
    --context-entries "ContextKeyName=dynamodb:LeadingKeys,ContextKeyValues=THREAD#x,ContextKeyType=stringList" \
    --query 'EvaluationResults[0].EvalDecision'
  ```

  Then confirm it live, with the ingress role's permissions (for example from a break-glass admin
  allowed to assume the role). A read with no projection must fail with `AccessDeniedException`:

  ```bash
  aws dynamodb get-item --table-name "$TURNS" --key '{"pk":{"S":"THREAD#x"},"sk":{"S":"TURN#x"}}'
  ```

  Then deploy the Slack service. In a bound channel, ask for something that calls a tool, and
  press **Details** as yourself and as a second member. Both see the view, and nothing new appears
  in the thread.
- Roll back the Slack service first: new replies lose the button, and buttons already posted keep
  working. Do not roll the control plane back below this release while replies with buttons are
  less than 30 days old. If you do, an old button tells the member "This button is no longer
  available." (`interaction.ignored`), and no longer opens anything.
