# Maintainers' production release

This page describes the maintainers' own deployment and its release pipeline. To move an
installed environment to a newer release, use `agentx --env <name> upgrade`; see
[Running AgentX](day-two.md#upgrade).

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

`AgentXReleasePipeline` runs the same production release from AWS for every qualifying push to
`mainline`. It is a CodePipeline V2 pipeline with a native ARM CodeBuild project,
`release-agentx-production`, which runs:

```sh
npm run release:prod -- --region "$AWS_REGION" --reuse-unchanged-worker --require-existing-foundation
```

| A push to `mainline` that changes | Result |
|---|---|
| Only docs, specs, top-level `tests/`, `scripts/` or `.github` | No pipeline execution |
| Any other deployable package (`packages/broker`, `cli`, `gateway`, `mcp`, `orchestrator`, `slack-service`), `environments/` or `infra`, but no worker image input | Checks, then a control-plane deploy. The deployed worker digest is reused and the runtime is unchanged |
| A worker image input: `packages/worker`, `packages/contracts`, `packages/model-runtime`, the Dockerfile, `.dockerignore`, root `package.json`, `package-lock.json` or tsconfigs, or a workspace `package.json` | Checks, a new ARM64 image, a runtime update to `READY` on that digest, then a control-plane deploy |

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
  --parameters GitHubConnectionArn=arn:aws:codeconnections:us-east-1:944937319445:connection/7e76074b-e840-439f-b94c-6806a2bf9513
```

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
  AgentX's own notices have no button. If Slack refuses the button (an API error such as
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
