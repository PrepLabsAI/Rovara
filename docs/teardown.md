# Removing an environment

This guide removes one AgentX environment from an AWS account: its stacks, its EC2 workers, the
data the stacks keep, its secrets and its settings. Nothing removed here can be brought back.
It answers [issue #66](https://github.com/PrepLabsAI/AgentX/issues/66).

Both ways below need admin credentials in the environment's account. The operator role cannot
delete the access stack's IAM roles or the kept data, by design.

## With agentx destroy

```sh
agentx --env <env> destroy --region <region>
```

`--env` is required: `destroy` never falls back to the default environment name. Pass `--region`
when the environment is not in your AWS configuration's region; `destroy` refuses a region that
the environment's settings, or this computer's record of it, contradict.

It first reads everything and prints what it will delete. Then it asks you to type the
environment's name. For an environment named `production`, or one AgentX has no record of
creating, it also asks you to type the AWS account id it shows. No flag skips either question.
Without a terminal, it reads each answer as a line from stdin, so the exact name is still needed.

Then it removes, in this order:

1. It saves a list of what the stacks keep to SSM (`/agentx/<env>/destroy/inventory`), so a
   re-run still knows it after the stacks are gone.
2. It turns termination protection off and deletes `agentx-<env>-slack`, `agentx-<env>-runtime`
   and `agentx-<env>-control-plane`, waiting for each.
3. It terminates the EC2 worker instances and deletes their workspace volumes. Deleting the
   volumes deletes every worker session's workspace.
4. It turns protection off and deletes `agentx-<env>-identity`, `agentx-<env>-foundation` and
   `agentx-<env>-access`, waiting for each.
5. It deletes what the stacks keep: it empties and deletes the buckets (every version), and
   deletes the tables, the flow-log group and the Cognito user pool. It schedules each KMS key
   for deletion in 7 days and deletes its aliases.
6. It deletes every secret under `agentx/<env>/`, without recovery, so a new install can reuse
   the names.
7. It deletes every parameter under `/agentx/<env>/`, then the settings, then the lock.
8. On this computer, it removes `~/.agentx/environments/<env>.yaml`, the project files written for
   this environment, and the stored admin sign-in.

It touches only names that belong to the environment. Anything that fails that check is left in
place and listed at the end.

**`--keep-data`** keeps the tables (turn records and developer sign-in included), buckets,
secrets, the Cognito user pool and the KMS keys, and removes the rest. Run `destroy` again without
it to remove what was kept.

**How long.** Deleting `agentx-<env>-control-plane` usually takes 20 to 40 minutes, while its
Lambda functions release their network interfaces. `destroy` prints a line each minute.

**After a failure**, fix what it names and run the same command again. It continues where it
stopped.

**Nothing found.** When it finds nothing for the environment, it says so, naming the account and
region it looked in, and exits 2. If the environment is in another region, pass `--region`.

**What it prints for you to do.** AgentX cannot delete these, so `destroy` prints each step:

- Delete the GitHub App, on its settings page, Advanced, Delete GitHub App.
- Delete the Slack app, at the bottom of its Basic Information page.
- Revoke each connector's credential in Linear, Jira or Asana.
- Delete the ECR repositories under `agentx-<env>/` that the image cache made.

## By hand

Use this if `agentx` is not available. Every command needs `--region <region>`. Where a command
lists more than one id, act on each.

**1. Record what the stacks keep.** Stack deletion keeps some resources on purpose. List each
stack's resources before you delete it:

```sh
aws cloudformation list-stack-resources --stack-name agentx-<env>-<part> --region <region> \
  --query "StackResourceSummaries[].[ResourceType,PhysicalResourceId]" --output text
```

Note every bucket, table, log group, user pool and KMS key. The next steps delete them.

**2. Turn termination protection off** on every stack:

```sh
aws cloudformation update-termination-protection --no-enable-termination-protection \
  --stack-name agentx-<env>-<part> --region <region>
```

**3. Delete the first three stacks**, in this order, each after the one before it is gone:
`agentx-<env>-slack`, then `agentx-<env>-runtime`, then `agentx-<env>-control-plane`.

```sh
aws cloudformation delete-stack --stack-name agentx-<env>-slack --region <region>
aws cloudformation wait stack-delete-complete --stack-name agentx-<env>-slack --region <region>
```

The control-plane delete takes 20 to 40 minutes. If the wait times out, run it again.

**4. Remove the EC2 workers.** Step Functions launched them, outside CloudFormation, so no stack
delete removes them, and a running worker blocks the foundation stack's delete. The `agentx:env`
tag keeps any other deployment's workers out of the list, including the one that predates named
environments, whose workers are also tagged `Environment=production`.

```sh
aws ec2 describe-instances --region <region> \
  --filters Name=tag:DeploymentMode,Values=ec2-ebs Name=tag:Environment,Values=<env> Name=tag:agentx:env,Values=<env> \
  --query "Reservations[].Instances[].InstanceId" --output text
aws ec2 terminate-instances --instance-ids <ids> --region <region>
aws ec2 wait instance-terminated --instance-ids <ids> --region <region>
aws ec2 describe-volumes --region <region> \
  --filters Name=tag:DeploymentMode,Values=ec2-ebs Name=tag:Environment,Values=<env> Name=tag:agentx:env,Values=<env> \
  --query "Volumes[].VolumeId" --output text
aws ec2 delete-volume --volume-id <id> --region <region>
```

**5. Delete the last three stacks** the same way, in this order: `agentx-<env>-identity` (there is
none with your own OIDC provider), then `agentx-<env>-foundation`, then `agentx-<env>-access`.

**6. Delete what the stacks kept**, from your list in step 1:

- **The Cognito user pool**, which has deletion protection. A pool that still has a domain cannot
  be deleted, so first look for one and, if `describe-user-pool` shows a `Domain`, delete it:
  ```sh
  aws cognito-idp describe-user-pool --user-pool-id <id> --region <region> --query "UserPool.Domain" --output text
  aws cognito-idp delete-user-pool-domain --user-pool-id <id> --domain <domain> --region <region>
  aws cognito-idp update-user-pool --user-pool-id <id> --deletion-protection INACTIVE --region <region>
  aws cognito-idp delete-user-pool --user-pool-id <id> --region <region>
  ```
  `update-user-pool` resets settings you leave out; the pool is being deleted, so that is fine.
- **Each bucket.** Empty every object version and delete marker first, then delete it. List
  them; `delete-objects` takes at most 1,000 at a time:
  ```sh
  aws s3api list-object-versions --region <region> --bucket <bucket> --max-items 1000 \
    --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}, Quiet: `true`}' --output json > delete.json
  ```
  If `delete.json` has an empty `Objects` list (`"Objects": []`), the bucket is empty: stop here.
  Otherwise delete those, then list again, until the list is empty:
  ```sh
  aws s3api delete-objects --region <region> --bucket <bucket> --delete file://delete.json
  ```
  Then delete the empty bucket:
  ```sh
  aws s3 rb s3://<bucket> --region <region>
  ```
- **Each table:**
  ```sh
  aws dynamodb delete-table --table-name <table> --region <region>
  ```
- **The VPC flow-log group:**
  ```sh
  aws logs delete-log-group --log-group-name <name> --region <region>
  ```
- **Each KMS key.** Schedule its deletion (7 days is the minimum), and delete its aliases under
  `alias/agentx/<env>/`:
  ```sh
  aws kms list-aliases --key-id <key id> --region <region> --query "Aliases[].AliasName" --output text
  aws kms schedule-key-deletion --key-id <key id> --pending-window-in-days 7 --region <region>
  aws kms delete-alias --alias-name <alias> --region <region>
  ```

**7. Delete every secret under `agentx/<env>/`**, without recovery, so the names can be reused:

```sh
aws secretsmanager list-secrets --region <region> --filters Key=name,Values=agentx/<env>/ \
  --query "SecretList[].Name" --output text
aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery --region <region>
```

Repeat `delete-secret` for each name the listing shows. A secret you made yourself for
`--openrouter-secret-arn` is yours to keep or delete. Revoke the OpenRouter key in OpenRouter too.

**8. Delete every parameter under `/agentx/<env>/`**, the settings and the lock last:

```sh
aws ssm get-parameters-by-path --path /agentx/<env>/ --recursive --region <region> \
  --query "Parameters[].Name" --output text
aws ssm delete-parameters --names <up to 10 names> --region <region>
aws ssm delete-parameter --name /agentx/<env>/settings --region <region>
aws ssm delete-parameter --name /agentx/<env>/lock --region <region>
```

**9. Delete the image cache's ECR repositories** under `agentx-<env>/`:

```sh
aws ecr describe-repositories --region <region> \
  --query "repositories[?starts_with(repositoryName, 'agentx-<env>/')].repositoryName" --output text
aws ecr delete-repository --force --repository-name <name> --region <region>
```

**10. On this computer**, sign out of the environment with `agentx --env <env> logout --admin`,
then remove `~/.agentx/environments/<env>.yaml` and each file in `~/.agentx/projects/` whose
header names `--env <env>`.

**11. Delete the GitHub App and the Slack app**, and revoke connector credentials, as listed
above under "What it prints for you to do".

A failed first create removes what it made (the kept resources use `RetainExceptOnCreate`), so
"delete the stack and run again" works. The one exception is the Cognito user pool, which
deletion protection keeps; delete it as in step 6 when convenient.
