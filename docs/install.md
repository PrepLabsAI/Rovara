# Installing AgentX

This guide installs one AgentX environment in your AWS account. There are three ways to do it:

- **With published templates** (recommended). No source checkout and no CDK bootstrap.
- **With cdk.** `cdk deploy` from a clean checkout of the release's tag.
- **Through your platform team.** They deploy the access stack (the IAM roles) from a bundle you
  write; you do the rest with the operator role.

Every way uses the same command, `agentx init`, and ends with AgentX answering in Slack. After
the install, [docs/day-two.md](day-two.md) covers running it.

## Before you start

You need:

- **An AWS account.** AgentX recommends a dedicated AWS account for each install: environments
  that share an account are not a security boundary against each other.
- **Admin credentials in that account for the first run** (for example `aws login` or an SSO
  profile). The platform team path needs them only on the platform team's side. Later, day-2
  commands use the narrower operator role that the install creates.
- **Node 22.19 or later** (Node 22 only).
- **A GitHub organization or personal account** that will own the AgentX GitHub App.
- **A Slack workspace where you can create apps.** If new apps need an admin's approval, `init`
  waits for it.
- **An email address for alerts**, or a PagerDuty or Opsgenie integration address.
- **Room in the region's quotas:**
  - EC2 On-Demand Standard vCPUs (quota `L-1216C47A`): at least 1, so a worker can start.
  - Two free EC2-VPC Elastic IPs (quota `L-0263D0A3`). The limit is 5 per region, and each
    environment's two NAT gateways take 2. An empty region fits two environments, and one next to
    an existing environment fits one more. `doctor` warns when fewer than 2 are free.

  `init` checks both before it creates anything. To see the Elastic IP room yourself:

  ```sh
  aws service-quotas get-service-quota --service-code ec2 --quota-code L-0263D0A3 --region <region>
  aws ec2 describe-addresses --region <region> --query "length(Addresses)"
  ```

Pick an environment name: lower-case letters, digits and hyphens, such as `prod` or `staging`.
Every command takes it as `--env <env>`. Always pass it: without it, `agentx` means the
environment named `production`.

**Before the first release is published**, run `init` from a source checkout instead of `npx`:
build the CLI (`npm ci && npm run build`), build a release (`npm run release:build`), and pass it
with `--release <dir>`. See [docs/releases.md](releases.md). Everything else below is the same.

## With published templates (recommended)

```sh
npx @charterarc/agentx --env <env> init --region <region>
```

### The install page

In a terminal on your own computer, `init` opens a page in your browser, served from this computer
only (`127.0.0.1`). Everything `init` asks is asked there: which AWS profile and account it installs
into (with a Sign in button when your session has expired), the prerequisites as a checklist, the
plan and its monthly cost with Yes and No buttons to create it or not, then each step with its
status. The GitHub App and the Slack app are made from buttons on the page, and the page moves on
by itself once GitHub sends you back. Secrets (the Slack token and signing secret, connector keys)
are typed into hidden fields. Each goes straight to AWS Secrets Manager and is never shown again,
and the field is emptied as soon as it is sent. The install ends on the page once AgentX replies
in your channel for the first time.

Keep the tab open until the install finishes. If the tab is closed, `init` keeps waiting and,
after a minute, prints the address again in the terminal. Open it to carry on, or press Ctrl-C and run
`init` again later (it continues where it stopped).

`--no-ui` asks every question in this terminal instead. `init` also uses the terminal on its own
where no browser can open: over SSH, in AWS CloudShell, in CI, and with `--yes` or `--no-browser`.
It then prints:

> No browser here, so agentx init asks in this terminal. To use the install page instead, run agentx init --ui and open the address it prints (over SSH, forward its port with ssh -L).

Over SSH, `agentx init --ui` prints the page's address and the command that forwards its port.
Run that command on your own computer (`ssh -L <port>:127.0.0.1:<port> <host>`) and open the
address there.

`init` asks its questions first: the region, identity (Cognito, or your own OIDC provider), the
models, the alert address, a monthly budget, and your GitHub account. It checks the
prerequisites, prints every stack, role, secret and app it will create with an estimated monthly
cost, and asks before creating anything.

It then runs these steps in order, and records each one in SSM as it finishes:

1. **prerequisites**: checks your credentials, the region, the quotas, model access (a one-token
   call to each model) and the engine's tools.
2. **access**: deploys the access stack (`agentx-<env>-access`) with your own credentials: the
   CloudFormation service role, the operator role, the artifact bucket and the image cache rule.
3. **core**: deploys the foundation (network, workers) and identity (Cognito) stacks; identity is
   skipped with your own OIDC provider.
4. **github-app**: you click once on GitHub's pre-filled page to create the GitHub App, then pick
   the repositories it may use.
5. **control-plane**: deploys the control plane and the runtime.
6. **slack-app**: you create the Slack app from AgentX's manifest, install it, then paste the Bot
   User OAuth Token and the Signing Secret into two hidden fields.
7. **slack-service**: deploys the Slack service, checks both Slack URLs with a signed request, and
   asks you to confirm that Slack shows the Request URL as Verified.
8. **developer-signin**: sets how developers sign in: Slack (the default), your company's sign-in
   (OIDC), or both. For Slack, paste the Slack app's Client ID and Client Secret.
9. **admin-user**: creates your admin user from your email (Cognito emails a temporary password)
   and opens the sign-in page on `127.0.0.1:8765`.
10. **first-project**: you pick a repository, confirm or edit its setup and test commands, and pick
    its Slack channel (for a private channel, `/invite @<bot>` first).
11. **connectors**: offers Linear, Jira and Asana; say no to add them later.
12. **alerts**: you confirm the email subscription (a PagerDuty or Opsgenie address confirms on its
    own); a test alarm is sent and you say whether it arrived.
13. **e2e**: you mention the bot in the channel; `init` ends when AgentX replies in the thread.
    Type @ and pick the bot from Slack's mention list. A workspace that had an older AgentX app
    shows two bots with similar names: pick the one whose member ID `init` prints.

**What you click or paste:** the GitHub App page (create, then pick repositories), the Slack app
page (create, install), two Slack pastes (token and signing secret), two more for developer
sign-in (Client ID and Client Secret), the Verified check, your admin sign-in, the alert email's
confirmation link, and one Slack mention.

**Resuming.** Run the same command again. `init` starts at the first step that is not done; a
done step never runs again. When the Slack workspace needs an admin to approve the app, `init`
stops with status "waiting" and exit code 0. Once approved, run it again.

**No browser.** `--no-browser` prints every address instead of opening it, and keeps `init` in the
terminal unless you also pass `--ui`. Over SSH, forward the port it names
(`ssh -L 8765:127.0.0.1:8765 <host>`). When `init` cannot open a browser, it says so and carries
on as if you gave `--no-browser`.

**Unattended.** `--yes` answers every question from its flag or its default. It needs `--region`.
Secrets never go in a flag's value: pass a file or an environment variable name. For example:

```sh
npx @charterarc/agentx --env <env> init --region <region> --yes \
  --github-account <org> --github-account-type organization \
  --alert-email <address> --budget 100 --budget-scope tag \
  --slack-bot-token-file <file> --slack-signing-secret-file <file> \
  --slack-client-id <id> --slack-client-secret-file <file> \
  --admin-email <email> --repository <owner/name> --channel <channel> --connectors none
```

`agentx init --help` lists every flag. `--yes` still prints the plan, and answers yes to checks
such as "Request URL Verified?", so read the printed summary afterwards.

**The cost estimate.** The plan shows an estimated monthly cost for your models at a stated use:
1,000 turns, 100 worker sessions, 60 worker instance-hours and 10 kept workspaces a month, at
us-east-1 list prices. It is an estimate, not a bill. The budget (`--budget`, default 100 US
dollars) alerts you at 80% actual and 100% forecast. With `--budget-scope tag` (the default),
someone with billing rights activates the `agentx:env` cost allocation tag once, in Billing, Cost
allocation tags; until then the budget reads 0.

## With cdk

Use this when you want CDK's own diffs. It deploys the same release.

1. Bootstrap CDK in the region once. `init` offers to do it, and `--yes` does it for you:

   ```sh
   npx cdk bootstrap aws://<account>/<region>
   ```

2. Check out the release's tag, cleanly. `init` refuses a checkout with changes or at another
   commit:

   ```sh
   git clone --branch v<version> --depth 1 https://github.com/PrepLabsAI/AgentX.git agentx-<version>
   ```

   `<version>` is the version of the `agentx` you run (`npx @charterarc/agentx --version`).

3. Run `init` with the cdk engine:

   ```sh
   npx @charterarc/agentx --env <env> init --region <region> --engine cdk --source agentx-<version>
   ```

   `init` runs `npm ci` and `npm run build` in the checkout, then `cdk deploy` one stack at a time.
   The steps and questions are the same as above.

   The cdk engine builds the stacks from `--source`, but still reads the release's images and
   notes. A published `agentx` downloads them. An `agentx` built from source has no published
   release, so also pass `--release <dir>` (`npm run release:build` builds one).

**The one difference in secret handling.** The CDK CLI takes the callback signing key only as a
`cdk deploy --parameters` argument. So while that command runs, the key is visible in your own
computer's process list. `agentx` never prints it: it shows `<redacted>` in the command, in errors
and in the output. The templates engine passes the key to CloudFormation without it ever being on
a command line.

An environment keeps its engine. Upgrades of a cdk environment need `--source` and admin
credentials (see [docs/day-two.md](day-two.md)).

## Through your platform team (export)

Use this when only your platform team may create IAM roles. You write a bundle; they deploy the
access stack from it with their credentials; you deploy the rest with the operator role.

1. **You write the bundle.** Download the release, `agentx-<version>.tar.gz` from the GitHub
   release `v<version>`, and unpack it into a directory. Then:

   ```sh
   npx @charterarc/agentx --env <env> init --export <dir> --region <region> \
     --release <release dir> --operator-principal <your role or user ARN>
   ```

   It changes nothing in AWS. It makes two read-only calls (your account id, and whether `<env>`
   is already installed), so it needs credentials for the target account. `--operator-principal`
   is who may assume the operator role; without it, any principal in the account that IAM allows
   may. To use OpenRouter, create its secret yourself and pass `--openrouter-secret-arn <arn>`.

2. **What the bundle holds.** No secret. It has:
   - `README.md`: the steps for the platform team, and how to tear the environment down;
   - `deploy-access.sh`: deploys the access stack, asks first (`--yes` skips the question);
   - `templates/` and `parameters/`: every stack's template and parameters for `<env>`;
   - `packages/` with `packages/SHA256SUMS`: the release's code packages and their checksums;
   - `policies/`: the roles' policies, and `access-deployer.json`, the policy the platform team's
     principal needs to run `deploy-access.sh`;
   - `init-answers.json`: the answers you already gave.

3. **The platform team deploys the access stack**, from the bundle directory, with their own
   credentials:

   ```sh
   ./deploy-access.sh
   ```

   On a failure it prints the reason and the exact command to recover.

4. **You continue with the operator role:**

   ```sh
   npx @charterarc/agentx --env <env> init --resume --region <region> --from-bundle <dir>
   ```

   It reads `init-answers.json`, asks only the rest, checks the access stack exists, and runs
   every other step above. It never deploys the access stack.

## After the install

- Check it any time with `agentx --env <env> doctor --region <region>`.
- Upgrades, settings, more projects, channels and connectors: [docs/day-two.md](day-two.md).
- Removing it: [docs/teardown.md](teardown.md).
- Moving it to another AWS account: [docs/move-account.md](move-account.md).
- Developers' AI tools (Claude Code, Codex, Cursor): [docs/mcp-install.md](mcp-install.md).
