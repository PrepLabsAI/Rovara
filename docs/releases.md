# Rovara releases

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

1. Tag a commit on mainline `vX.Y.Z` (for example `v1.2.3`) and push the tag. Only repository
   admins can push `v*` tags (the `release-tags` ruleset). A tag on a commit that is not on
   mainline stops the workflow before it publishes anything.
2. That triggers the `Release` GitHub Actions workflow (`.github/workflows/release.yml`). It always
   runs the test job first: typecheck, the stricter type check (`typecheck:all`), lint, build, the
   full test suite, and `infra:synth`.
3. Nothing else happens unless the repository variable `AGENTX_PUBLISH_ENABLED` is exactly `true`.
   It is `true` since v0.1.0; see "Release setup" below.
4. When publishing is enabled, three more jobs run in order:
   - **images**: builds and pushes the two container images, then reads back the digest the
     registry itself reports (not just what the build produced) before trusting it.
   - **release**: builds the release directory, verifies it, and creates a GitHub release titled
     "Rovara X.Y.Z" with `release.json` and a tarball of the whole directory attached.
   - **npm**: packs and publishes the CLI through npm trusted publishing, which adds provenance.
     A version already on the registry is skipped, not failed.
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

## Release setup

The first release, v0.1.0, shipped on 2026-10-06 from commit `87d28a2d`. Everything below is in
place; this records what it is, so a change to any piece can be made deliberately.

- **ECR Public repositories.** `agentx-worker` and `agentx-slack` in account `944937319445`
  (`us-east-1`), under the registry alias `i7z2k3a8`. A shorter alias, `agentx`, is requested and
  waiting on AWS's approval; switching to it means changing `AGENTX_ECR_PUBLIC_ALIAS`.
- **The publish role.** `arn:aws:iam::944937319445:role/agentx-github-release` can push images
  only to those two repositories, plus the two sign-in permissions ECR Public requires
  (`ecr-public:GetAuthorizationToken` and `sts:GetServiceBearerToken`). Its trust policy accepts
  GitHub's OIDC token only for this repository's version tags, matched by immutable ID rather than
  name:

  ```text
  token.actions.githubusercontent.com:aud = sts.amazonaws.com
  token.actions.githubusercontent.com:sub like repo:*@272978771/*@1307121896:ref:refs/tags/v*
  ```

  `272978771` is the PrepLabsAI organization and `1307121896` this repository. GitHub uses
  immutable subjects for this repository (`gh api repos/PrepLabsAI/Rovara/actions/oidc/customization/sub`),
  so a rename does not break the role; a transfer to another organization would.
- **The npm package.** `@preplabsai/rovara-code`, owned by the `preplabsai` npm organization
  (publishing needs an owner or developer role there; GitHub access does not grant it). Version
  0.1.0 was published by hand from the tag's commit, because npm trusted publishing can only be
  configured on a package that exists. Its Trusted Publisher is GitHub Actions, `PrepLabsAI` /
  `Rovara` / `release.yml`, and publishing requires two-factor authentication with tokens
  disallowed. Trusted publishing matches the repository by name, so a rename means updating it on
  npm and the `repository.url` that `scripts/release/pack-cli.ts` writes. See
  [npm-package.md](npm-package.md).
- **Repository variables** (Settings, Secrets and variables, Actions, Variables):
  `AGENTX_PUBLISH_ROLE_ARN` (the role above), `AGENTX_ECR_PUBLIC_ALIAS=i7z2k3a8`,
  `AGENTX_NPM_PACKAGE=@preplabsai/rovara-code` and `AGENTX_PUBLISH_ENABLED=true`. Setting the last
  one to anything else turns publishing off; a tag push then runs only the test job.
- **The `release-tags` ruleset.** Restricts creating, updating and deleting `refs/tags/v*` to the
  repository admin role. The workflow checks a tag's name and that its commit is on mainline, but
  GitHub runs the tagged commit's own copy of the workflow, so whoever can push a `v*` tag can
  publish. The ruleset is what limits that to admins.
- **The license.** `LICENSE` (FSL-1.1-ALv2) ships in the npm package and the release tarball.

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
4. Once, SC-001: a person who has never seen Rovara installs it from docs/install.md, on a clean
   computer and a new AWS account, with no help, and gets a Slack reply. Record every place they
   get stuck, and fix it.
