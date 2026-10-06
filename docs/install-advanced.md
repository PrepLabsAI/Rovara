# Other ways to install Rovara

Most installs use the one command in [Installing Rovara](install.md). This page covers the other
ways: with the CDK, through a platform team, and from a source checkout. Every one runs the same
`agentx init` steps, asks the same questions and ends with Rovara answering in Slack, so read
[Before you start](install.md#before-you-start) and [The install page](install.md#the-install-page)
first.

## With cdk

Use this when you want CDK's own diffs. It deploys the same release.

1. Bootstrap CDK in the region once. `init` offers to do it, and `--yes` does it for you:

   ```sh
   npx cdk bootstrap aws://<account>/<region>
   ```

2. Check out the release's tag, cleanly. `init` refuses a checkout with changes or at another
   commit:

   ```sh
   git clone --branch v<version> --depth 1 https://github.com/PrepLabsAI/Rovara.git agentx-<version>
   ```

   `<version>` is the version of the `agentx` you run (`npx @preplabsai/rovara-code --version`).

3. Run `init` with the cdk engine:

   ```sh
   npx @preplabsai/rovara-code --env <env> init --region <region> --engine cdk --source agentx-<version>
   ```

   `init` runs `npm ci` and `npm run build` in the checkout, then `cdk synth` once to read which
   parameters each stack takes, then `cdk deploy` one stack at a time. The steps and questions are
   the same as in [Installing Rovara](install.md).

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
   every other install step. It never deploys the access stack.

## From a source checkout

Use this to install a commit that has no release yet, such as a change you are testing. You build
the release yourself and push its two container images to a registry the install can pull from.

```sh
npm ci && npm run build
npm run release:build -- --version <x.y.z> --out ./release \
  --worker-image <worker repo@sha256:...> --slack-image <slack repo@sha256:...>

export AWS_PROFILE=<an admin profile for the target account>
node packages/cli/dist/bin.js --env <env> init --region <region> --release ./release \
  --worker-image <worker repo@sha256:...> --slack-image <slack repo@sha256:...>
```

The images are referenced by digest only. [Releases](releases.md#checking-a-release-on-your-own-machine)
covers building and checking a release directory.
