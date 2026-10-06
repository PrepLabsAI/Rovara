# AgentX releases

A release is a tagged, versioned bundle: the CloudFormation templates the installer deploys, the
code packages those templates reference, two container images, and the Rovara Code CLI on npm
(`@preplabsai/rovara-code`, command `rovara`, compatibility alias `agentx`). All of
it is built from the same tagged commit, so a release is always self-consistent.

## What a release contains

A release directory looks like this:

- `release.json`: the manifest: version, git commit, and a checksum for every file below.
- `templates/<region>/<part>.template.json`: one CloudFormation template per stack part
  (`access`, `foundation`, `identity`, `runtime`, `control-plane`, `slack`), for each region the
  release covers. The covered regions are exactly the ones with verified EC2 worker
  availability-zone IDs (`SUPPORTED_REGIONS` in `infra/lib/production-foundation.ts`; today just
  `us-east-1`). Adding a region means adding its verified zone IDs there; nothing else changes.
- `packages/<assetId>.zip`: the Lambda code each template references, one zip per package, named
  by the hash of its contents so the same code always produces the same file. Code packages are
  shared across every region a release covers, because asset hashes don't depend on region.
- Two container images (the worker and the Slack listener), pushed to ECR Public and referenced
  only by digest (a fixed fingerprint), never by a tag that could later point at something else.
  They are built for `arm64` machines only, the same chip the installer's runtime uses.
- The worker image carries Node 22, Git, the Docker CLI and Compose, Python 3 with pip and venv,
  and uv. A change to `environments/base/Dockerfile` reaches installs only through a new release's
  worker image: tag a release, and upgrade each environment with `agentx upgrade`. Bookworm's
  system Python is externally managed (PEP 668), so a repository should use `python3 -m venv` or
  uv, not a bare `pip install`. `uv python install` needs network access.
- The CLI, published to npm as a single self-contained package with no separate dependencies to
  install.

## How templates render for your environment

The published templates are not built once per customer environment. They are synthesized a
single time for a reserved, made-up environment name that no real environment is allowed to have
(`qqenv-placeholderqq`). At install time, the CLI replaces every occurrence of that placeholder
(including the underscore-only form some AWS resource names require) with your real environment
name, and refuses to proceed if any trace of the placeholder is still left afterward.

This keeps one code path for naming instead of two (a template-time one and a CloudFormation-time
one), and it lets a release check prove the rendered template is byte-for-byte what synthesizing
directly for that environment name would have produced (FR-012).

## Cutting a release

1. Tag a commit on mainline `vX.Y.Z` (for example `v1.2.3`) and push the tag. A tag on a commit
   that is not on mainline stops the workflow before it publishes anything.
2. That triggers the `Release` GitHub Actions workflow (`.github/workflows/release.yml`). It always
   runs the test job first: typecheck, the stricter type check (`typecheck:all`), lint, build, the
   full test suite, and `infra:synth`.
3. Nothing else happens unless the repository variable `AGENTX_PUBLISH_ENABLED` is exactly `true`.
   That is the default today; see "One-time owner setup" below.
4. When publishing is enabled, three more jobs run in order:
   - **images**: builds and pushes the two container images, then reads back the digest the
     registry itself reports (not just what the build produced) before trusting it.
   - **release**: builds the release directory, verifies it, and creates a GitHub release with
     `release.json` and a tarball of the whole directory attached.
   - **npm**: packs and publishes the CLI.
5. The version always comes from the tag name. There is no way to type a different version by
   hand, even when re-running the workflow manually. A manual run must still be started from a
   tag, or it fails immediately with a clear error.

## Checking a release on your own machine

- `npm run release:build -- --version <version> --out <dir> [--worker-image <repo@sha256:...>] [--slack-image <repo@sha256:...>]`
  builds the same release directory the workflow builds (the image flags are optional; leave them
  out to build templates and packages only).
- `npm run release:verify -- <dir>` checks every file's checksum against `release.json`, then
  rebuilds the templates and packages from the current checkout and compares them again, to catch
  a release directory that no longer matches what today's source would produce.
- `npm run release:pack-cli -- --version <version> --out <dir> [--name <package-name>]` builds the
  npm package for the CLI and packs it into a tarball, without publishing anything.

## One-time owner setup

Nothing publishes until an owner does the following, once. None of it touches the live AgentX
deployment.

1. **ECR Public repositories: done.** `agentx-worker` and `agentx-slack` exist in account
   `944937319445` (`us-east-1`). A shorter alias, `agentx`, has been requested and is waiting on
   AWS's approval; until it is approved, images use the default alias `i7z2k3a8` instead.
2. **A role GitHub can assume: done.** `arn:aws:iam::944937319445:role/agentx-github-release`
   exists. It can only be assumed from a version-tag push on `PrepLabsAI/AgentX`. Its permissions
   let it push images only to the two repositories above, plus the two sign-in permissions ECR
   Public itself requires to let anything push at all (`ecr-public:GetAuthorizationToken` and
   `sts:GetServiceBearerToken`).
3. **The npm package: owner setup required.** The selected package is
   `@preplabsai/rovara-code`. Verify that the release owner controls the `preplabs` npm
   organization; GitHub organization membership does not grant npm organization access.
   A registry 404 does not reserve a package name. Before turning on
   `AGENTX_PUBLISH_ENABLED` (step 6 below), prepare the first version:
   1. From a checkout of the release tag's commit, run `npm ci && npm run build` first (workspace
      packages such as `@agentx/contracts` are only importable once built), then
      `npm run release:pack-cli -- --version <x.y.z> --out ./cli-release` (use the exact version
      you are about to tag, for example `0.1.0`). This writes a tarball named
      `./cli-release/preplabsai-rovara-code-<x.y.z>.tgz`.
   2. `npm login --registry=https://registry.npmjs.org`, signed in with publishing
      permission for the `preplabs` organization. Check with `npm whoami` and
      `npm org ls preplabs`.
   3. Inspect the packed files and obtain the release owner's approval of the exact
      artifact and version before public publication. Verify the matching deployment
      bundle and images are available to the intended users, then publish with
      `npm publish ./cli-release/preplabsai-rovara-code-<x.y.z>.tgz --access public`.
   4. On the package's npm page, turn on "Trusted Publisher" (GitHub Actions,
      `PrepLabsAI/AgentX`, `release.yml`), so every later version can publish itself with no
      stored password.

   The first package publication makes bundled source publicly readable. Keep the
   repository's current LICENSE and third-party notices in the package; changing the
   product name does not change its license. `init` still needs a matching GitHub release
   bundle and images. Until they are accessible, npm publication alone is not a usable
   self-hosted release.

   Publish this first version under the same version number you are about to tag, and do it before
   `AGENTX_PUBLISH_ENABLED` is set to `true`. When you later push that tag with publishing enabled,
   the workflow's own `npm` job checks whether that version is already on the registry before
   publishing, finds it, and skips the publish instead of failing: by then the images and the
   GitHub release have already published normally in that same run, the package itself is already
   correctly on npm, and every version after this first one publishes through npm automatically
   with no manual step.
4. **A license: done.** The `LICENSE` file (FSL-1.1-ALv2) is in this repository as of this phase.
5. **A decision still open.** `PrepLabsAI/AgentX` is a private repository today. Publishing a
   release makes the built code public: the npm package is plain, readable JavaScript, and the two
   images contain the same programs the repository does. The usual choice under this license is to
   make the repository public before the first release. Doing so also turns on npm's provenance
   badge automatically.
6. **Repository variables: remaining.** Once the above is settled, set these under Settings →
   Secrets and variables → Actions → Variables, saving the last one for last:
   `AGENTX_PUBLISH_ROLE_ARN`, `AGENTX_ECR_PUBLIC_ALIAS`,
   `AGENTX_NPM_PACKAGE=@preplabsai/rovara-code`, then
   `AGENTX_PUBLISH_ENABLED=true`.
7. **A tag protection ruleset: recommended.** The workflow checks that a tag's *name* matches
   `vX.Y.Z` and that its commit is on mainline; it does not check who pushed it. That mainline
   check only catches mistakes: GitHub runs the tagged commit's own copy of the workflow, so
   someone who can push a tag could also remove the check on a branch and tag that. Anyone who can
   push a matching tag can therefore trigger a real publish. Add a repository ruleset (Settings →
   Rules → Rulesets → New tag ruleset) targeting `v*` that restricts creating, updating and
   deleting those tags to repository owners/admins, so a `v*` tag from anyone else can't publish.
   Rulesets need a public repository or GitHub Pro (see item 5).

## If a release fails partway

- Use GitHub's "Re-run failed jobs" button on the workflow run, not a fresh tag push. It re-runs
  only the jobs that failed (and the jobs after them); jobs that already succeeded, such as the
  images job, are not run again, and their results are reused.
- If only the npm job failed, "Re-run failed jobs" simply retries the npm step. Nothing else runs
  again.
- The one case that needs cleanup: the release job itself failing after it created the GitHub
  release (`gh release create` is its last step, so this is rare). A re-run then reports that the
  release already exists. `gh release create` publishes a real release, not a draft. To redo that
  version, delete the release and its tag, then push the tag again, or cut a new patch version.

## The release test

The `Release test` workflow (`.github/workflows/release-test.yml`) installs, upgrades and removes
real environments in a throwaway AWS account, with both engines and the platform team path. It
runs by hand, before a release is tagged, and never touches the live deployment.

### One-time owner setup

1. **A throwaway AWS account** that holds nothing else. The Elastic IP limit is 5 per region, and
   each environment's two NAT gateways take 2, so an empty account fits two environments. The
   workflow still runs one environment at a time, as a margin: it installs one after another and
   removes each before the next starts.
2. **A role GitHub can assume** in that account, with admin rights there. Its trust policy allows
   this repository's `workflow_dispatch` runs through GitHub OIDC (no long-lived keys), and its
   maximum session is at least 3 hours, since an install and an upgrade can outlast the 1 hour
   default. The workflow also names it as each environment's operator principal, so it must be
   able to assume `agentx-<env>-operator`. Store its ARN in the repository variable
   `vars.AGENTX_RELEASE_TEST_ROLE_ARN`. `vars.AGENTX_RELEASE_TEST_REGION` is optional (default
   `us-east-1`).
3. **Two private ECR repositories** in that account and region: `agentx-release-test/worker` and
   `agentx-release-test/slack`. The workflow pushes the candidate's images there.
   Each repository needs a lifecycle policy that expires `rt-*` images a few days after they are
   pushed: every run pushes both images tagged `rt-<run id>`, and nothing else removes them.
4. **A test GitHub App**, installed on a test repository: `vars.RT_GITHUB_ACCOUNT`,
   `vars.RT_GITHUB_APP_ID`, `vars.RT_GITHUB_INSTALLATION_ID`, and its private key in
   `secrets.RT_GITHUB_PRIVATE_KEY`.
5. **A test Slack app**, installed in a test workspace: `vars.RT_SLACK_CLIENT_ID`, and
   `secrets.RT_SLACK_BOT_TOKEN`, `secrets.RT_SLACK_SIGNING_SECRET` and
   `secrets.RT_SLACK_CLIENT_SECRET`.
6. **Turn it on:** set `vars.AGENTX_ENABLE_RELEASE_TEST` to `true`. Until then the workflow does
   nothing.

### Running it

In GitHub, open Actions, then Release test, then Run workflow, on the commit you plan to tag. Give
two versions: `previous`, the published release to install first, and `candidate`, the version
this commit will become (newer than `previous`).

For each engine (templates, then cdk), it installs `previous` up to the `developer-signin` step
(`init --stop-after developer-signin`), runs `doctor`, upgrades to the candidate, runs `doctor`,
changes a setting under the operator role alone, and destroys the environment. Then it runs the
platform team path: `init --export`, `deploy-access.sh`, `init --resume --from-bundle` under the
operator role, `doctor`, and `destroy`. A last job destroys anything a failed run left behind.

### The manual release check

Some steps need a person, so do these by hand before tagging, in a throwaway account:

1. One full `agentx init`, all the way to a Slack reply in the thread (docs/install.md).
2. `agentx --env <env> alerts test`, and check the alarm arrives.
3. Remove that environment by hand, following docs/teardown.md's "By hand" section, and check
   nothing is left.
4. Once, SC-001: a person who has never seen AgentX installs it from docs/install.md, on a clean
   computer and a new AWS account, with no help, and gets a Slack reply. Record every place they
   get stuck, and fix it.
