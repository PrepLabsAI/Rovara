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

`AgentXReleasePipeline` runs Code's release from AWS for every qualifying push to `mainline`,
first to beta, then, when the owner approves that run, to production (#1242, #1578). It is a
Code-only CodePipeline V2 pipeline, `AgentXProductionRelease`, with one source (`GitHub`,
`PrepLabsAI/Rovara-Code` `mainline`), one trigger (a qualifying `mainline` push), and three stages:

```
Source (mainline push) → Beta (every run) ⏸ disabled transition → Production (its own approval, per run)
```

Code owns and deploys its own model gateway (`packages/model-gateway`,
`environments/model-gateway/Dockerfile`, `infra/lib/model-gateway*.ts`) directly from this
pipeline, ahead of the Code release in both stages. Rovara Cloud is released by its own
independent pipeline and does not appear here. Each stage runs, in this order:

| Action | What it does |
|---|---|
| `CodePreflight` | In Production, first of all, closes the transition into Production, so a newer run cannot pass the open transition while the run waits for its approval or runs its gates, and a rejected or timed-out run leaves the transition closed. Then, in both stages, runs the port guard on the Code tree with the private name list (it fails if the list cannot be loaded), whatever the CI proof says, and exports `CODE_LIVE_SHA` (the stage's previously released Code commit). Read-only: its role can clone the Code repository but not push (UseConnection is denied when `ProviderPermissionsRequired` is `read_write`) |
| `ApproveProduction` | Production only, right after `CodePreflight`: a CodePipeline manual approval for THIS run (see "Approving a production run"). Every other Production action, all of them writers, starts only after it is approved |
| `ModelGatewayImage` | Beta builds the `linux/arm64` model gateway image from the Code commit (`scripts/model-gateway-image.ts`), keyed by its build-context hash (`ctx-<64hex>`): an unchanged context reuses the existing digest in beta's gateway repository (`rovara-cloud-beta-gateway-images`). Production never builds: it copies beta's exact digest with `crane copy` into production's gateway repository and refuses any tag whose digest differs from beta's. In `adopt` mode, verifies the live gateway digest exists in ECR and builds or copies nothing |
| `ModelGatewayDeploy` | Synthesizes Code's `RovaraModelGateway` stack (`-c rovaraModelGateway=<env> -c rovaraCodeSha=<commit>`) and creates a named change set (`rovara-pipeline-<exec8>`), runs the change-set integrity, protected-resource (including image-only checks), rollback-floor, and first-switch (`gateway-source-switch`) gates on it, executes by name, and waits to settle. In `adopt` mode, verifies the change set is a no-op and discards it without executing |
| `ModelGatewayCheck` | Verifies the live gateway stack matches the deployed digest and `DeployedCodeSha`, its ECS service is settled on that pinned digest, `/healthz` serves the required `runPrice` version and snapshot, and price-fetch logs are fresh. Records the gateway's last-good state in the release account at `/agentx/release/model-gateway-last-good/<env>` |
| `ReleaseBeta` / `ReleaseProduction` | The Code release below (`npm run release:prod`). Skipped in `PIPELINE_MODE=adopt` or with `CODE_RELEASE=skip` |

The order is the model gateway (`ModelGatewayImage`, `ModelGatewayDeploy`, `ModelGatewayCheck`),
then the Code release (`ReleaseBeta` / `ReleaseProduction`).

- **Beta:** `release-agentx-model-gateway-beta` and `release-agentx-beta` run in the beta
  account as that account's `agentx-beta-release` role (`AgentXBetaReleaseAccess`). Release
  records (`/agentx/release/*`) and CI's proof stay in the release account.
- **Production:** the transition into it stays disabled. The newest beta run waits in front of
  it; a newer one replaces it (the pipeline runs in SUPERSEDED mode), so one promotion carries every
  merge since the last. `release-agentx-preflight-production` closes the transition again as the first
  command of the stage, before anything else, so each promotion lets one run in whatever happens next. The
  stage's next action, `ApproveProduction`, is a manual approval that belongs to one pipeline execution.

A run starts only from a push to `mainline` that changes a deployable path (table below).

Pipeline variables, each with a default so a push can start a run (override them when you start a
run by hand):

| Variable | Default | Meaning |
|---|---|---|
| `CODE_RELEASE` | `run` | `run` (default) releases the Code commit and its model gateway. A run started by hand can pass `skip` to skip deploying both |
| `PIPELINE_MODE` | `release` | `release` deploys. `adopt` checks the live model gateway against Code's records (no-op change set preview, live checks, adopts last-good) and changes nothing; run it once per environment before the first `release` run (a `release` run refuses when `/agentx/release/model-gateway-last-good/<env>` is absent). `rollback` deploys an earlier released Code commit (`CODE_ROLLBACK_TARGET`) and/or a recorded model gateway digest (`MODEL_GATEWAY_DIGEST`) |
| `CODE_ROLLBACK_TARGET` | `none` | With `PIPELINE_MODE=rollback`: the full 40-character Code commit to deploy. It must be in the stage's release history (below). `none` leaves Code as it is. Any other mode requires `none` |
| `MODEL_GATEWAY_DIGEST` | `none` | With `PIPELINE_MODE=rollback` in Beta: the recorded `sha256:<64hex>` model gateway digest from `/agentx/release/model-gateway-last-good/beta` (`none` resolves the recorded digest matching `CODE_ROLLBACK_TARGET`). Production always copies Beta's digest and takes no `MODEL_GATEWAY_DIGEST`. Any other mode requires `none` |

The Code release, in both projects, runs:

```sh
npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation
```

(the beta one with `--profile agentx-beta`), unless `CODE_RELEASE=skip` or `PIPELINE_MODE=adopt`,
in which case the build installs nothing and deploys nothing. After a release that finished, the
build's last command records the commit it released in an SSM String
(`/agentx/release/code-released/beta` or `/production`), which is never written for a `skip` or
`adopt` run.

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
release or a `skip`/`adopt` run), with the same writer rule: only the stage's release build role may write it, and only
its own. A missing or garbled list does not stop a forward release: the next one starts a new list from what is
valid. A list it cannot read for any other reason stops the build before anything is written.

**Rolling Code and the model gateway back** is a pipeline run with `PIPELINE_MODE=rollback`,
`CODE_ROLLBACK_TARGET=<40-hex sha>` and/or `MODEL_GATEWAY_DIGEST=<sha256:...>`.
Run `npm run gateway:release -- <beta|production> rollback-plan` to print the recorded digests and
whether each passes `scripts/model-gateway-release/rollback-floors.json`.
The Code Preflight refuses a Code rollback, exit 2, before the worktree exists and before any guard runs, unless the stage's
history is readable and lists the target, the target is not the commit already released, is in the clone, and is
older than (an ancestor of) the released commit. The guard that runs while the private name list is on disk is still the CURRENT
released commit's, over the range target..released. `ModelGatewayImage` verifies the rollback digest is in the
environment's last-good record (it never builds a new image from old source) and checks the rollback floors;
Production copies Beta's digest and verifies it is also in Production's own last-good record. The release build
then checks the Code target out, releases it, and on success records it as the released commit and moves it to
the head of the history.

The release build repeats the history and ancestor checks on the target before it checks anything out (its role
can read the history too): the history lists the target, and the target is in the clone and an ancestor of the
run's commit.

Runbook notes for a rollback:

- The history starts at the first release after the pipeline goes live, so the first rollback needs two finished
  releases, or a hand-seeded history: `aws ssm put-parameter --type String --name <history parameter> --value
  '["<40-hex live sha>"]'` in the release account.
- After a rollback, land the next fix as a merge commit (the merge queue does): the next forward run is judged from
  the rolled-back commit, and a squash that does not sit directly on it is refused as a linear landing until a
  merge commit lands.
- Production rolls back only to a commit and gateway digest Production itself released: it checks Production's own
  history and Production's own `/agentx/release/model-gateway-last-good/production`.
- Rolling Code back to a commit before `3ce46251e` (the dispatch rule for an owner-only People list) parks every
  task that has a People record. Treat such a rollback as one that strands those tasks, and move forward again to
  a commit that has `3ce46251e` as soon as the reason for the rollback allows.

There is no other adoption switch: `PIPELINE_MODE=adopt` is the only one, and every Preflight prints
the mode as a note.

### Approving a production run

Every production deploy needs the owner's explicit approval for that run (DEC 254zzz506). Two things hold
a run back, and they do different jobs:

- the disabled transition holds the run that is waiting (a newer run replaces it, so you promote beta's newest commit);
- the `ApproveProduction` action, right after the Production `CodePreflight` (which closes the transition
  first, so the gate is closed whether the run is approved, rejected or times out), releases one execution.
  An approval belongs to the execution that waits at it, so an open transition alone can never let a run
  into Production unapproved.

To promote the commit waiting in front of Production, as the owner:

1. Enable the transition in the console (**Enable transition** above the Production stage), or:

   ```sh
   aws codepipeline enable-stage-transition --pipeline-name AgentXProductionRelease \
     --stage-name Production --transition-type Inbound
   ```

   The waiting run enters Production and stops at `ApproveProduction`.
2. Open that run's `ApproveProduction` action (**Review** in the console). Its text names the pipeline
   execution, the Code commit, `CODE_RELEASE`, `PIPELINE_MODE`, `CODE_ROLLBACK_TARGET` and
   `MODEL_GATEWAY_DIGEST`. Check the execution id and Beta's logs before you approve, or reject
   (a rejected run stops and the stage unlocks), or from a terminal:

   ```sh
   aws codepipeline get-pipeline-state --name AgentXProductionRelease   # the approval token of the waiting action
   aws codepipeline put-approval-result --pipeline-name AgentXProductionRelease --stage-name Production \
     --action-name ApproveProduction --token <token> --result summary="<what you checked>",status=Approved
   ```

An approval that nobody answers fails after 24 hours (the run stops, the stage unlocks, and the next run
starts its own wait). Rejecting a run, or letting it time out, leaves the transition closed.

No role the template creates may approve, enable the transition, or start, retry or roll back a run: the
only `codepipeline` rights in it are the Production `CodePreflight`'s `DisableStageTransition` (it can only
close the gate) and the Beta `CodePreflight`'s read of the pipeline state. Approving is the owner's own
identity (an administrator or an SSO permission set that holds `codepipeline:PutApprovalResult` on
`AgentXProductionRelease/Production/ApproveProduction`).

Nothing waiting means production already runs beta's newest commit. A failed production
release leaves the transition disabled; the next promotion takes beta's newest commit again.

| A push to `mainline` that changes | Result |
|---|---|
| Only docs, specs, top-level `tests/`, unrelated `scripts/` or `.github` | No pipeline execution |
| `packages/model-gateway/**`, `environments/model-gateway/**` or `scripts/model-gateway*` | Builds/reuses model gateway image, updates `RovaraModelGateway` by change set, verifies `/healthz` and ECS settle, then runs the Code release |
| Any other deployable package (`packages/broker`, `cli`, `code-api`, `gateway`, `mcp`, `orchestrator`, `slack-service`), `environments/` or `infra`, but no worker image input | Gateway steps reuse unchanged image digest, checks run, then a control-plane deploy. The deployed worker digest is reused and the runtime is unchanged |
| A worker image input: `packages/worker`, `packages/contracts`, `packages/model-runtime`, the Dockerfile, `.dockerignore`, root `package.json`, `package-lock.json` or tsconfigs, or a workspace `package.json` | Gateway steps, checks, a new ARM64 worker image, a runtime update to `READY` on that digest, then a control-plane deploy |

Whether the worker changed is judged against the deployed image. The pipeline reads the commit
from the image's `release-<time>-<commit>` tag and diffs the worker image inputs up to `HEAD`. So
a worker change from a failed or superseded execution is still released by the next one. If that
commit cannot be determined, the pipeline builds a new image. Any change under `infra/` that
alters `AgentXProductionFoundation` fails the release until an administrator reviews and deploys
the foundation manually. The pipeline never creates the foundation and never deploys itself.

One-time setup, with an administrator's credentials:

```sh
npm run build --workspace @agentx/infra
npx cdk deploy AgentXReleasePipeline --app 'node infra/dist/bin/agentx.js' \
  --profile agentx-deployer -c agentxRegion=us-east-1 \
  --parameters GitHubConnectionArn=<codeconnections-arn> \
  --parameters BetaAccountId=<beta-account-id> \
  --parameters PortGuardNamesParameterName=<ssm parameter name of the private name list> \
  --parameters PortGuardNamesKeyArn=<kms key arn of that parameter>
```

`<codeconnections-arn>` is the ARN of the already-authorized GitHub connection in the release account.
The port guard's name list is an SSM SecureString in the release account; the stack takes only its name
and the key's ARN. Redeploying an existing pipeline stack keeps the parameters it already has. The
pipeline never deploys itself, so this is always by hand; review the change set first
(`--no-execute --require-approval never --change-set-name <name>`).

### Model gateway cross-account pull policy and one-time adoption

Production's `ModelGatewayImage` step never builds an image: it copies beta's exact digest with
`crane copy` using the production model gateway build role (`ProductionModelGatewayBuildRoleArn`
stack output, role name `agentx-release-model-gateway-production-build`). Once after deploying
`AgentXReleasePipeline`, grant that role read-only pull access on beta's model gateway ECR
repository (`rovara-cloud-beta-gateway-images-*`) in the beta account (using the policy generated
by `betaModelGatewayPullPolicy(productionBuildRoleArn)` in `infra/lib/release-pipeline.ts`):

```sh
aws ecr set-repository-policy --profile <beta-profile> --region us-east-1 \
  --repository-name <beta-gateway-images-repo> \
  --policy-text file://beta-gateway-pull-policy.json
```

Before the first `release` run deploys the model gateway from Code's pipeline, run the pipeline
once with `PIPELINE_MODE=adopt` (Beta, then enable/approve Production): it verifies the live
gateway digest, previews a no-op change set and discards it, verifies live gateway health, seeds
`/agentx/release/model-gateway-last-good/<env>`, and changes nothing in AWS stacks or ECR.

### What each build role may write into the artifact bucket

The bucket is not versioned and holds every artifact of every run, including the `Source` artifact the
Production stage reads after approval. So each build role writes only its own outputs (PH-S3-PREFIXES):
`PutObject` and `AbortMultipartUpload` on its own output prefix, plus an explicit Deny (`NotResource`
of that prefix) of `s3:PutObject*`, `s3:DeleteObject*` and `s3:AbortMultipartUpload` on everything else:

- Production Code release (`ReleaseBuild`): `<pipeline>/ReleaseMan*` (`ReleaseManifest`)
- Beta Code release (`BetaReleaseBuild`): `<pipeline>/BetaReleas*` (`BetaReleaseManifest`)
- Beta model gateway (`BetaModelGatewayBuild`): `<pipeline>/GatewayBet*` (`GatewayBetaImage`, `GatewayBetaDeploy`, `GatewayBetaCheck`)
- Production model gateway (`ProductionModelGatewayBuild`): `<pipeline>/GatewayPro*` (`GatewayProdImage`, `GatewayProdDeploy`, `GatewayProdCheck`)

The four prefixes are disjoint from each other and from `Source/*`.

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
