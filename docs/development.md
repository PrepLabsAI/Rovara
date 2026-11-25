# Developing Rovara

Local validation, the spec documents, and the GitHub Spec Kit setup.

## Local validation

Use Node 22.19 or newer (Node 22 LTS recommended):

```sh
npm ci
npm run typecheck
npm run typecheck:all
npm run lint
npm test
npm run infra:synth
```

`npm run typecheck:all` builds the packages (`tsc -b`) and type-checks `tests/` and `scripts/` in
parallel incremental shards (`scripts/typecheck-shards.ts`), writing `.tsbuildinfo` files under
`node_modules/.cache/tsc-shards/` so repeat runs skip unchanged shards. Every file covered by
`tsconfig.lint.json` must type-check with zero errors.

`npm run lint` lints the whole repository with the rules of `eslint .`, but in shards (scripts/lint-shards.ts): one eslint
process per group of directories, each with its own, smaller TypeScript program, then one for everything else. One process
over the whole repository needs more than 6 GB. Each shard has a 4 GB heap cap, and two run at a time on a machine with 16 GB or
more (`--jobs 1` runs them one after the other). Run `npm run typecheck` first: the programs read the packages' built
declarations. `node scripts/lint-shards.ts --only <shard>[,<shard>]` lints some shards, and `--list` names them. A plain
`npx eslint <file>` still works and uses the whole-repository program (tsconfig.lint.json).

Run `npm run build` (`tsc -b`) once after `npm ci` before running an operator script from `scripts/` that imports `packages/*/src` (`preflight`, `eval`, `ec2-preflight`, the `test-deploy*` family, `test-model-canary`, `test-qualify-runtime`, `test-services-mirror`, `saved-env-builder-copy`): the Code API package (`packages/code-api`) is loaded from its built `dist/`, which a fresh checkout does not have. `scripts/release-production.ts` is the exception: the release builds run it straight after `npm ci`, so it loads nothing from `packages/` until its own build step (`tests/contract/release-fresh-checkout.test.ts`).

The latest results are the CI runs on each pull request. Docker and AWS are not required for this
local suite.

For Bedrock/OpenRouter configuration, Slack model selection, and the live verification checklist, see [OpenRouter model access](openrouter.md). To use your own Anthropic or OpenAI API key, see [Your own Anthropic or OpenAI API key](model-providers.md).

## Implementation documents

- [Production AWS architecture](architecture-production.md): EC2 workers and persistent EBS,
  per-session EBS, networking, release, isolation, and migration boundaries.
- [Ports](ports.md): the plug-in points of the core engine and their adapters.
- [Project configuration](project-configuration.md): every field of a project file.
- [Constitution](constitution.md): project principles.
