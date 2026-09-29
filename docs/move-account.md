# Moving AgentX to another account

AgentX has no command that moves an environment. Moving is reinstalling: you install a new
environment in the new account, register your projects there again, and then remove the old one.
This is a deliberate decision, tracked in [issue #67](https://github.com/PrepLabsAI/AgentX/issues/67).

## 1. Keep a copy of your project files

`agentx destroy` removes the project files written for the old environment, so copy them first:

```sh
cp -R ~/.agentx/projects ~/agentx-projects-<old env>
```

They hold no secret, only each project's repository, commands, channel and connector references.

## 2. Install in the new account

Follow [docs/install.md](install.md) with admin credentials for the new account.

Give the new environment a different name from the old one if you run both from this computer.
The local records (`~/.agentx/environments/<env>.yaml` and the project files) are named after the
environment, so two environments with one name would share them, and removing the old one would
remove the new one's.

For Slack, choose one:

- **A new Slack app** (simplest). `init` creates it as usual. The old app keeps pointing at the
  old environment until you delete it.
- **Keep the old Slack app.** At the slack-app step, do not create a new app: paste the old app's
  Bot User OAuth Token and Signing Secret. Then, on the app's settings pages, change the Event
  Subscriptions and Interactivity Request URLs to the new control-plane stack's `SlackEventsUrl`
  and `SlackInteractivityUrl` outputs, and add the new
  `<control plane URL>/v1/auth/callback/slack` to OAuth and Permissions, Redirect URLs. From that
  moment, Slack messages go to the new environment only.

For GitHub, `init` creates a new GitHub App. To keep the old one instead, pass its
`--github-app-id`, `--github-installation-id` and `--github-private-key-file`.

## 3. Register your projects again

`init` registers the first project. Register every other one from your copy. Sign in as an
admin of the new environment, then register each file with the new foundation's worker launch
template and subnets:

```sh
agentx --env <new env> login --admin
aws cloudformation describe-stacks --stack-name agentx-<new env>-foundation --region <region> \
  --query "Stacks[0].Outputs[?OutputKey=='Ec2WorkerLaunchTemplateId' || OutputKey=='Ec2WorkerSubnets']"
agentx --env <new env> admin project register --file ~/agentx-projects-<old env>/<name>.yaml \
  --deployment-mode ec2-ebs --launch-template-id <Ec2WorkerLaunchTemplateId> --subnets <Ec2WorkerSubnets>
```

Then bind each project's channel: `agentx --env <new env> channel add --project <name> --channel
<channel>`.

## 4. Add the connectors again

Connector credentials live in the old account's Secrets Manager and do not move. For each
project, add them again:

```sh
agentx --env <new env> connector add linear|jira|asana --project <name>
```

## 5. What does not move

- **Turn records**: the history of what each Slack turn did. To keep it, export it from the old
  environment first with `agentx --env <old env> admin turns export --since 30d --output <file>` (records are
  kept 30 days).
- **Workspaces**: open worker sessions and their volumes. Finish or close them first.
- **Developer sign-in sessions**: everyone signs in again, to the new control plane URL
  (`npx @charterarc/agentx login <new control plane URL>`).
- **Settings you changed with `agentx config`**: set them again in the new environment
  ([docs/day-two.md](day-two.md)).

## 6. Remove the old environment

Once the new one answers in Slack, remove the old one with admin credentials for the old account:

```sh
agentx --env <old env> destroy --region <old region>
```

See [docs/teardown.md](teardown.md). Then delete the old GitHub App and Slack app if you replaced
them.
