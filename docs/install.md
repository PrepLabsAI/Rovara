# Installing Rovara

This guide installs one Rovara environment in your AWS account. There are three ways to do it:

- **With published templates** (recommended). No source checkout and no CDK bootstrap.
- **With cdk.** `cdk deploy` from a clean checkout of the release's tag.
- **Through your platform team.** They deploy the access stack (the IAM roles) from a bundle you
  write; you do the rest with the operator role.

Every way uses the same command, `agentx init`, and ends with Rovara answering in Slack. After
the install, [docs/day-two.md](day-two.md) covers running it.

## Before you start

You need:

- **An AWS account.** A separate AWS account just for Rovara keeps its costs and permissions apart
  from your other work. Give each install its own: environments that share an account are not a
  security boundary against each other.
- **Admin credentials in that account for the first run** (for example `aws login` or an SSO
  profile). The platform team path needs them only on the platform team's side. Later, day-2
  commands use the narrower operator role that the install creates.
- **Node 22.19 or newer (Node 22 LTS recommended).** AWS CloudShell comes with Node 20; see
  [Node 22 in AWS CloudShell](#node-22-in-aws-cloudshell). With an older Node, `agentx` stops
  before it does anything and says what to install.
- **A GitHub organization or personal account** that will own the Rovara GitHub App.
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

### Node 22 in AWS CloudShell

AWS CloudShell has Node 20, and Rovara needs Node 22. `npm install` only warns about it
(`EBADENGINE`); `agentx` itself stops with this command in its message. Run it once in
CloudShell's default Bash shell:

```sh
V=v22.23.3 A=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') && F=node-$V-linux-$A.tar.gz && D=$HOME/.local/node22 && rm -rf "$D.new" && mkdir -p "$D.new" && (cd "$D.new" && curl -fSL --progress-bar -O "https://nodejs.org/dist/$V/$F" && curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " $F\$" | sha256sum -c - && tar -xzf "$F" --strip-components=1 && rm "$F") && rm -rf "$D" && mv "$D.new" "$D" && (grep -qs 'local/node22/bin' ~/.bashrc || echo 'export PATH="$HOME/.local/node22/bin:$PATH"' >> ~/.bashrc) && export PATH="$D/bin:$PATH" && node --version
```

It downloads the official Node 22.23.3 for this machine (x86_64 or arm64) from nodejs.org,
checks it against nodejs.org's published SHA-256 checksums before unpacking it, and puts it in
`~/.local/node22` in your CloudShell home folder (about 200 MB of the 1 GB CloudShell keeps). It
unpacks into `~/.local/node22.new` first and only then replaces `~/.local/node22`, so a failed
download leaves the Node you had (run it again, or `rm -rf ~/.local/node22.new`). It adds one
line to `~/.bashrc` so later CloudShell sessions use it too, and prints the new `node --version`.
It needs no `sudo`.
This only affects your own CloudShell, in this region; nothing else in your AWS account uses it.

To remove it, delete the folder and the `~/.bashrc` line, then open a new CloudShell tab:

```sh
rm -rf ~/.local/node22 ~/.local/node22.new
sed -i '/local\/node22\/bin/d' ~/.bashrc
```

Pick an environment name: lower-case letters, digits and hyphens, such as `prod` or `staging`.
Every command takes it as `--env <env>`. Always pass it: without it, `agentx` means the
environment named `production`.

**Before the first release is published**, run `init` from a source checkout instead of `npx`:
build the CLI (`npm ci && npm run build`), build a release (`npm run release:build`), and pass it
with `--release <dir>`. See [docs/releases.md](releases.md). Everything else below is the same.

## With published templates (recommended)

```sh
npx @preplabsai/rovara-code --env <env> init --region <region>
```

### The install page

In a terminal on your own computer, `init` opens a page in your browser, served from this computer
only (`127.0.0.1`). The page shows the five parts of the install (Get started, Your choices, Build
in AWS, Connect Slack, Finish), how long each usually takes, which one you are in, and the time
left. The browser tab's title reads "(Action needed) Install AgentX" whenever the install waits for
you.

The page walks you through five parts, and tells you when it needs you:

1. **Get started.** The page opens first and shows Rovara downloading. You pick the AWS profile (only
   when you have more than one), see the account you are signed in to, and pick the region. Rovara
   then checks the account: EC2 capacity, Elastic IPs and Amazon Bedrock in that region.
2. **Your choices.** One settings screen: your email, the GitHub owner, the install name and the app
   name. Everything else has a recommended value under Advanced settings. Rovara checks your answers
   (the models, the release's images, the names, the GitHub owner) before anything is created, then
   shows the plan with its cost. Press Create Rovara, or Change answers to go back with every answer
   kept. Then you create and install the GitHub app.
3. **Build in AWS.** About 18 minutes, unattended. You can leave; the alert confirmation email
   arrives during this part.
4. **Connect Slack.** One visit: create the Slack app, then paste its Client ID, Client Secret,
   Signing Secret and Bot User OAuth Token on one form. Developer sign-in is turned on with the
   Slack connection, as the plan said.
5. **Finish.** Your admin sign-in, the first project and channel, alerts, and a first reply.

Without a browser (`--no-ui`, SSH, CI) the terminal asks in the same order and runs the same checks;
it asks the Advanced settings only if you answer yes to "Change the advanced settings?".

The GitHub app and Slack app are made from link buttons on the page. Secrets are typed into hidden
fields, go straight to AWS Secrets Manager, and are never shown again. If a deploy step fails, the
page says what happened and offers Try this step again; Stop for now shows the command that
continues later. The install ends on a ready screen with the commands for your team, which stays
open until you press Close installer, or for 30 minutes.

While the page is open, the terminal prints the page's address, how long the install takes, the
path of the full log (`~/.agentx/logs/init-<env>.log`), then one line per step. Everything else
(the plan, the deploy output, the output of the tools `init` runs) goes to that log file and to the
page's technical log. The log file never holds the page's access token.

Keep the terminal open and your computer awake until the install finishes. If the tab is closed,
`init` keeps waiting and, after a minute, prints the address again in the terminal. Open it to
carry on, or press Ctrl-C and run `init` again later (it continues where it stopped).

`--yes` also uses the terminal and answers every question for you. A CI run has no one to type
answers, so it needs `--yes` (or `--ui`); without either, it stops. Over SSH, in AWS CloudShell, on
Linux with no display, on Windows, or with `--no-browser`, `init` asks in the terminal. In an
interactive terminal without `--yes`, it first prints this line:

> No browser here, so agentx init asks in this terminal. To use the install page instead, run agentx init --ui --no-browser and open the address it prints (over SSH, forward its port with ssh -L).

Over SSH, run `agentx init --ui --no-browser`. It prints the page's address and the command that
forwards its port. Run that command on your own computer (`ssh -L <port>:127.0.0.1:<port> <host>`)
and open the address there.

**Resuming.** Run the same command again. `init` starts at the first step that is not done; a
done step never runs again. When the Slack workspace needs an admin to approve the app, `init`
stops with status "waiting" and exit code 0. Once approved, run it again.

**No browser.** `--no-browser` prints every address instead of opening it, and keeps `init` in the
terminal unless you also pass `--ui`. Over SSH, forward the port each address names. For
example, the admin sign-in page uses `ssh -L 8765:127.0.0.1:8765 <host>`. When `init` cannot
open a browser, it says so and prints the address to open instead.

**Unattended.** `--yes` answers every question from its flag or its default. It needs `--region`.
Secrets never go in a flag's value: pass a file or an environment variable name. For example:

```sh
npx @preplabsai/rovara-code --env <env> init --region <region> --yes \
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
   git clone --branch v<version> --depth 1 https://github.com/PrepLabsAI/Rovera.git agentx-<version>
   ```

   `<version>` is the version of the `agentx` you run (`npx @preplabsai/rovara-code --version`).

3. Run `init` with the cdk engine:

   ```sh
   npx @preplabsai/rovara-code --env <env> init --region <region> --engine cdk --source agentx-<version>
   ```

   `init` runs `npm ci` and `npm run build` in the checkout, then `cdk synth` once to read which
   parameters each stack takes, then `cdk deploy` one stack at a time. The steps and questions are
   the same as above.

   A published `agentx` downloads its own release for the images and notes. An `agentx` built from
   source needs no release when you pass `--engine cdk` and `--source` on the command line:

   - The version is the checkout's release tag (`v<version>`). The checkout must be clean and at
     exactly one release tag.
   - The images come from `--worker-image` and `--slack-image` when you pass both. Otherwise `init`
     downloads that tag's `release.json` from GitHub (only that file, not the release archive).
     It must be the release built from the same commit.
   - The regions to choose from are the ones in that `release.json`. Without it, pass `--region`,
     or set the region in your AWS configuration.

   `--release <dir>` still works with the cdk engine. It must hold the release of the checkout's
   tag, or `init` stops before the plan.

**The one difference in secret handling.** The CDK CLI takes the callback signing key only as a
`cdk deploy --parameters` argument. So while that command runs, the key is visible in your own
computer's process list. `agentx` never prints it: it shows `<redacted>` in the command, in errors
and in the output. The templates engine passes the key to CloudFormation without it ever being on
a command line.

An environment keeps its engine. Upgrades of a cdk environment need `--source` and admin
credentials (see [docs/day-two.md](day-two.md)). An `agentx` built from source upgrades to the
checkout's tag, with no `--release` or `--to`.

## Through your platform team (export)

Use this when only your platform team may create IAM roles. You write a bundle; they deploy the
access stack from it with their credentials; you deploy the rest with the operator role.

1. **You write the bundle.** Download the release, `agentx-<version>.tar.gz` from the GitHub
   release `v<version>`, and unpack it into a directory. Then:

   ```sh
   npx @preplabsai/rovara-code --env <env> init --export <dir> --region <region> \
     --release <release dir> --operator-principal <your role or user ARN>
   ```

   It changes nothing in AWS. It makes two read-only calls (your account id, and whether `<env>`
   is already installed), so it needs credentials for the target account. `--operator-principal`
   is who may assume the operator role; without it, any principal in the account that IAM allows
   may. To use OpenRouter, Anthropic or OpenAI, create the key's secret yourself and pass
   `--openrouter-secret-arn`, `--anthropic-secret-arn` or `--openai-secret-arn <arn>`.

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
   npx @preplabsai/rovara-code --env <env> init --resume --region <region> --from-bundle <dir>
   ```

   It reads `init-answers.json`, asks only the rest, checks the access stack exists, and runs
   every other step above. It never deploys the access stack.

## After the install

- Check it any time with `agentx --env <env> doctor --region <region>`.
- Upgrades, settings, more projects, channels and connectors: [docs/day-two.md](day-two.md).
- Removing it: [docs/teardown.md](teardown.md).
- Moving it to another AWS account: [docs/move-account.md](move-account.md).
- Developers' AI tools (Claude Code, Codex, Cursor): [docs/mcp-install.md](mcp-install.md).
