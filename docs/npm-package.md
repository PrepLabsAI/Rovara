# Rovara Code npm package

The selected public package name is `@preplabsai/rovara-code` and its primary executable
is `rovara`. The package also installs `agentx` as a compatibility alias pointing to
the same executable. Configuration continues to live under `~/.agentx`; existing
AWS resource names, MCP server/tool identifiers and task/evidence IDs are unchanged.

To run it without installing:

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

## PrepLabsAI owner setup (done for 0.1.0)

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
   the two bundled executable files, package manifest, README, current LICENSE and
   third-party notices. No private workspace dependencies need separate publication.
4. Review the exact artifact, source/version, distribution rights and matching
   deployment bundle/images with the release owner. The generated package retains
   the repository's current FSL-1.1-ALv2 license. A brand change does not authorize
   a license change or establish open-source status.
5. After release approval, publish that reviewed archive:

   ```sh
   npm publish ./cli-release/preplabsai-rovara-code-<version>.tgz --access public
   ```

6. Configure the package's npm Trusted Publisher for GitHub organization
   `PrepLabsAI`, repository `Rovara`, workflow filename `release.yml`.
   Update these values together if the source repository moves.
7. Set the existing repository variable `AGENTX_NPM_PACKAGE` to
   `@preplabsai/rovara-code`, then `AGENTX_PUBLISH_ENABLED` to `true` (see
   [releases.md](./releases.md)).
8. Confirm the registry version, public installation commands and matching release
   downloads before replacing the website's installation placeholder.

The packager embeds the chosen package name, including a `--name` override, into
generated login/resume commands and MCP client installation snippets. Existing
installation and authentication boundaries remain in force.

References: [npm public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/),
[npm organizations](https://docs.npmjs.com/creating-an-organization/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
