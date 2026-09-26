# AgentX releases

A release is a tagged, versioned bundle: the CloudFormation templates the installer deploys, the
code packages those templates reference, two container images, and the `agentx` CLI on npm. All of
it is built from the same tagged commit, so a release is always self-consistent.

## What a release contains

A release directory looks like this:

- `release.json` — the manifest: version, git commit, and a checksum for every file below.
- `templates/<part>.template.json` — one CloudFormation template per stack part (`foundation`,
  `identity`, `runtime`, `control-plane`, `slack`).
- `packages/<assetId>.zip` — the Lambda code each template references, one zip per package, named
  by the hash of its contents so the same code always produces the same file.
- Two container images (the worker and the Slack listener), pushed to ECR Public and referenced
  only by digest (a fixed fingerprint), never by a tag that could later point at something else.
  They are built for `arm64` machines only, the same chip the installer's runtime uses.
- The CLI, published to npm as a single self-contained package with no separate dependencies to
  install.

## How templates render for your environment

The published templates are not built once per customer environment. They are synthesized a
single time for a reserved, made-up environment name that no real environment is allowed to have
(`qqenv-placeholderqq`). At install time, the CLI replaces every occurrence of that placeholder —
including the underscore-only form some AWS resource names require — with your real environment
name, and refuses to proceed if any trace of the placeholder is still left afterward.

This keeps one code path for naming instead of two (a template-time one and a CloudFormation-time
one), and it lets a release check prove the rendered template is byte-for-byte what synthesizing
directly for that environment name would have produced (FR-012).

## Cutting a release

1. Tag a commit on mainline `vX.Y.Z` (for example `v1.2.3`) and push the tag.
2. That triggers the `Release` GitHub Actions workflow (`.github/workflows/release.yml`). It always
   runs the test job first: typecheck, lint, build, the full test suite, and `infra:synth`.
3. Nothing else happens unless the repository variable `AGENTX_PUBLISH_ENABLED` is exactly `true`.
   That is the default today — see "One-time owner setup" below.
4. When publishing is enabled, three more jobs run in order:
   - **images** — builds and pushes the two container images, then reads back the digest the
     registry itself reports (not just what the build produced) before trusting it.
   - **release** — builds the release directory, verifies it, and creates a GitHub release with
     `release.json` and a tarball of the whole directory attached.
   - **npm** — packs and publishes the CLI.
5. The version always comes from the tag name. There is no way to type a different version by
   hand, even when re-running the workflow manually — a manual run must still be started from a
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

1. **ECR Public repositories — done.** `agentx-worker` and `agentx-slack` exist in account
   `944937319445` (`us-east-1`). A shorter alias, `agentx`, has been requested and is waiting on
   AWS's approval; until it is approved, images use the default alias `i7z2k3a8` instead.
2. **A role GitHub can assume — done.** `arn:aws:iam::944937319445:role/agentx-github-release`
   exists. It can only be assumed from a version-tag push on `PrepLabsAI/AgentX`. Its permissions
   let it push images only to the two repositories above, plus the two sign-in permissions ECR
   Public itself requires to let anything push at all (`ecr-public:GetAuthorizationToken` and
   `sts:GetServiceBearerToken`).
3. **The npm package — partly done.** The `charterarc` npm organization exists, and the package
   name `@charterarc/agentx` is reserved. Before turning on `AGENTX_PUBLISH_ENABLED` (step 6
   below), publish the very first version by hand:
   1. From a checkout of the release tag's commit, run `npm ci && npm run build` first (workspace
      packages such as `@agentx/contracts` are only importable once built), then
      `npm run release:pack-cli -- --version <x.y.z> --out ./cli-release` (use the exact version
      you are about to tag, for example `0.1.0`). This writes a tarball named
      `./cli-release/charterarc-agentx-<x.y.z>.tgz`.
   2. `npm login`, signed in as an owner of the `charterarc` organization.
   3. `npm publish ./cli-release/charterarc-agentx-<x.y.z>.tgz --access public`.
   4. On the package's npm page, turn on "Trusted Publisher" (GitHub Actions,
      `PrepLabsAI/AgentX`, `release.yml`), so every later version can publish itself with no
      stored password.

   Publish this first version under the same version number you are about to tag, and do it before
   `AGENTX_PUBLISH_ENABLED` is set to `true`. When you later push that tag with publishing enabled,
   the workflow's own `npm` job checks whether that version is already on the registry before
   publishing, finds it, and skips the publish instead of failing: by then the images and the
   GitHub release have already published normally in that same run, the package itself is already
   correctly on npm, and every version after this first one publishes through npm automatically
   with no manual step.
4. **A license — done.** The `LICENSE` file (FSL-1.1-ALv2) is in this repository as of this phase.
5. **A decision still open.** `PrepLabsAI/AgentX` is a private repository today. Publishing a
   release makes the built code public: the npm package is plain, readable JavaScript, and the two
   images contain the same programs the repository does. The usual choice under this license is to
   make the repository public before the first release — doing so also turns on npm's provenance
   badge automatically.
6. **Repository variables — remaining.** Once the above is settled, set these under Settings →
   Secrets and variables → Actions → Variables, saving the last one for last:
   `AGENTX_PUBLISH_ROLE_ARN`, `AGENTX_ECR_PUBLIC_ALIAS`, `AGENTX_NPM_PACKAGE`, then
   `AGENTX_PUBLISH_ENABLED=true`.
7. **A tag protection ruleset — recommended.** The workflow only checks that a tag's *name* matches
   `vX.Y.Z`; it does not check who pushed it or what commit it points at. Anyone who can push a
   matching tag can trigger a real publish. Add a repository ruleset (Settings → Rules → Rulesets →
   New tag ruleset) targeting `v*` that restricts tag creation to repository owners/admins, so an
   accidental or malicious `v*` tag from anyone else can't publish.

## If a release fails partway

- Use GitHub's "Re-run failed jobs" button on the workflow run, not a fresh tag push. Re-running
  rebuilds and re-tags the images (the images job pushes the version tag again every time it runs,
  so that part is always safe), then continues into the jobs that failed.
- If the GitHub release was already created before something failed later (for example, npm),
  re-running will hit `gh release create`'s own guard and report that the release already exists.
  `gh release create` publishes a real release, not a draft, so there is no draft to delete instead.
  To redo that version, delete the release and its tag first, then push the tag again — or leave it
  and cut a new patch version instead.
