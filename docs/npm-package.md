# Rovara Code npm package

The selected public package name is `@preplabsai/rovara-code` and its primary executable
is `rovara`. The package also installs `agentx` as a compatibility alias pointing to
the same executable. Configuration continues to live under `~/.agentx`; existing
AWS resource names, MCP server/tool identifiers and task/evidence IDs are unchanged.

Published since 0.1.0:

```sh
npx @preplabsai/rovara-code --help
npx @preplabsai/rovara-code init --env <name>
```

Or install once:

```sh
npm install -g @preplabsai/rovara-code
rovara --help
rovara login <your-installation-url>
```

Use Node 22.19 or newer. Sign-in requires an existing installation URL; installing
the npm package does not create an AWS environment by itself. The `init` command
downloads a release bundle matching its CLI version, then guides the administrator
through the existing installation and confirmation steps.

## Publishing

Every version after 0.1.0 publishes from `.github/workflows/release.yml` when an admin pushes its
`vX.Y.Z` tag (see [releases.md](releases.md)), through npm trusted publishing: no token is
stored, and npm adds provenance. The package's Trusted Publisher is GitHub Actions, organization
`PrepLabsAI`, repository `Rovara`, workflow `release.yml`; update it, and `repository.url` in
`scripts/release/pack-cli.ts`, together if the repository is renamed or moves.

## Publishing by hand

Only the first version needed this, because trusted publishing can only be configured on a package
that exists. Kept for a version that must be published outside the workflow:

1. Sign in to npm with `npm login --registry=https://registry.npmjs.org`.
2. Confirm the active npm account with `npm whoami` and its role with
   `npm org ls preplabsai <npm-username>`. The `preplabsai` organization uses the
   free public-packages plan; publishing requires an owner or developer role.
   GitHub organization access is separate from npm access.
3. Build the package from the intended release source with its matching version:

   ```sh
   npm ci
   npm run build
   npm run release:pack-cli -- --version <version> --out ./cli-release
   ```

   The archive is `cli-release/preplabsai-rovara-code-<version>.tgz`. It contains only
   the two bundled executable files, package manifest, README, MIT `LICENSE`, retained Apache
   license text (`LICENSE-APACHE`), license-grant notice (`RELICENSED.md`) and third-party notices.
   No private workspace dependencies need separate
   publication.
4. Review the exact artifact, source/version, distribution rights and matching
   deployment bundle/images with the release owner. The generated package retains
   the repository's MIT license, retained Apache 2.0 grant, and third-party license notices.
5. After release approval, publish that reviewed archive:

   ```sh
   npm publish ./cli-release/preplabsai-rovara-code-<version>.tgz --access public
   ```

   Publishing requires two-factor authentication. npm asks for a one-time password, or
   pass `--otp <code>`; with a security key, run it in an interactive terminal and approve
   in the browser.
6. Publish the version before pushing its tag. The workflow's npm job then finds it on the
   registry and skips it, while the images and the GitHub release publish normally.
7. Confirm the registry version, public installation commands and matching release
   downloads.

The packager embeds the chosen package name, including a `--name` override, into
generated login/resume commands and MCP client installation snippets. Existing
installation and authentication boundaries remain in force.

References: [npm public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
[npm organizations](https://docs.npmjs.com/creating-an-organization/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
