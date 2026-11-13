# Modular split, phase 2a step 1: the move map

This is the map of the mechanical package split of Rovara Code (phase 2a of the modularization plan, step 1). It says where every package and
directory was, where it is now, which named entries each package has, and what the split could not do without a real logic change.

Nothing in the split changes behaviour. The commits are file moves, renames of package names and paths, and additions (entries, guard tests, a pack
step). No test changed except an import path or a path string.

## The rules the split follows

- **Named entries only.** A package has one root entry and a short written-out list of named sub-entries in `exports`. No wildcards. Other code
  imports `@rovara-code/core/merge-tracking`, never a file inside `dist`. `tests/contract/package-entries.test.ts` fails on any other import.
- **One version.** Every package is `0.1.0` (0.x). The same test checks it.
- **Built and versioned, not published (decision 154).** Every package is `"private": true`, has no `publishConfig`, and there is no npm publish step or
  token. CI packs each package with `npm pack` and uploads the tarballs as the build artifact `code-packages` (job `pack`,
  `scripts/pack-packages.ts`). Cloud installs from that artifact.
- **An API report per package.** `packages/<name>/api-report.txt` lists each entry's exported names. `tests/contract/package-api-report.test.ts` fails
  when the built declarations differ. Refresh on purpose with `UPDATE_API_REPORT=1`.

## Package map

| Was | Is now | Directory | Done in this step |
|---|---|---|---|
| `@agentx/contracts` | `@rovara-code/contracts` | `packages/contracts` (unchanged) | renamed; new browser-safe entry `./browser` |
| `@agentx/broker` (all of `packages/broker`) | `@rovara-code/core` | `packages/core` (`git mv` from `packages/broker`) | renamed and moved whole; see "What the split could not do" |
| `@rovara/aws-adapters` | `@rovara-code/aws` | `packages/aws-adapters` (directory unchanged, see "How the move was done") | renamed; the four generic adapters only |
| `@agentx/worker` | `@rovara-code/worker` | `packages/worker` (unchanged) | renamed; entries added (it had none) |
| `@agentx/testing` | `@rovara-code/testing` | `packages/testing` (unchanged) | renamed; the `./ports/*` wildcard written out |
| `@agentx/gateway`, `mcp`, `model-runtime`, `orchestrator`, `verifier`, `local-adapters`, `slack-service`, `cli`, `infra` | unchanged | unchanged | not in the target table; they keep their names and directories until a later step says where they go |

Not done, by design: `@rovara-code/local` (phase 2b: the laptop app, `rovara up`), the per-outside-system packages (`@rovara-code/github`,
`@rovara-code/slack`; see below), and anything in Cloud.

### Dependencies between the packages (no package depends on one above it)

```
contracts
  <- aws, gateway, local-adapters, mcp, model-runtime, verifier
       <- core   (aws, contracts, gateway, local-adapters, model-runtime, verifier)
            <- testing (core, contracts)
            <- cli     (core, contracts, gateway, mcp, model-runtime)
  <- worker         (contracts, model-runtime, verifier)
  <- orchestrator   (contracts, model-runtime)  <- slack-service (contracts, orchestrator)
  <- infra          (contracts)
```

## Named entries per package

Entry names are the specifier after the package name. A target is always a file in `dist` built from the same path in `src`.

**`@rovara-code/contracts`**: `.` (everything, for Node), `./browser` (the browser-safe subset, below), `./dns-helper`.

The browser-safe entry is `src/browser.ts`: 143 of the root entry's 265 `export *` modules. A module is in it only when nothing it imports, directly
or through its own relative imports, is a Node built-in, the `typescript` package, or a use of `Buffer`, `process` or `require`
(`scripts/browser-safe.ts`). The test proves that for the file on every run. It was generated once from `index.ts` and is kept by hand after that: a
module added to `index.ts` is not in the browser entry until someone adds it on purpose.

**`@rovara-code/core`** (the old broker entries, renamed, plus the service layer from #502):

| Entry | File |
|---|---|
| `.` | `src/index.ts` |
| `./channel` | `src/core/channel/index.ts` |
| `./channel-slack-adapter` | `src/plugins/channel/slack/index.ts` |
| `./e2e/discovery`, `./e2e/execution-plan` | `src/e2e/discovery.ts`, `src/e2e/execution-plan.ts` |
| `./fakes` | `src/plugins/fake/index.ts` |
| `./local` | `src/local/index.ts` |
| `./ports` | `src/ports/index.ts` |
| `./plugins/channel-slack`, `./plugins/object-storage-s3`, `./plugins/secrets-aws` | the three plug-in module files |
| `./services` | `src/services/index.ts` (the service layer) |
| `./task-flow`, `./cost` | `src/core/task-flow/index.ts`, `src/core/cost/index.ts` (named for Cloud, below) |
| `./lessons/<name>` | one entry per file of `src/lessons/` (96), for the path Cloud imports as `dist/lessons/<name>.js` (below) |
| `./merge-tracking`, `./sessions`, `./notices`, `./decisions`, `./callbacks`, `./candidate-export`, `./context-tools`, `./documents` | `src/services/<name>.ts`, one per service |

**`@rovara-code/aws`**: `.`, `./dynamodb`, `./s3`, `./secrets-manager`, `./sqs` (unchanged apart from the name).

**`@rovara-code/worker`**: `.` (`src/index.ts`), `./main` (`src/main.ts`, the worker's start file). The worker image runs `packages/worker/dist/main.js` by
path, which does not change.

**`@rovara-code/testing`**: `.`, `./channel`, `./fakes`, `./isolation`, `./ports` and one `./ports/<name>` per conformance suite
(21 files, written out where there was a wildcard).

The packages that keep their old names keep their entries.

## What Cloud imports today, and where it maps

The Cloud install lane listed the broker paths Cloud uses. Each is now a named entry; nothing is reached by a path inside `dist`.

| Cloud used | Now |
|---|---|
| `@agentx/broker/ports` | `@rovara-code/core/ports` |
| `@agentx/broker` `core/channel` (`dist/core/channel`) | `@rovara-code/core/channel` |
| `@agentx/broker` `core/task-flow` (`dist/core/task-flow`) | `@rovara-code/core/task-flow` (new) |
| `@agentx/broker` `core/cost` (`dist/core/cost`) | `@rovara-code/core/cost` (new) |
| `@agentx/broker` `dist/lessons/<file>.js` | `@rovara-code/core/lessons/<file>`; there is no `lessons/index.ts`, so each of the 96 files is its own entry. This list is wide on purpose (the exact files Cloud uses are not known here); trim it to what Cloud needs |
| `@agentx/local-adapters` (and `/storage`, `/queue`, `/object-storage`, `/audit-sink`, `/company-instructions`) | unchanged name and entries |
| `@agentx/contracts` | `@rovara-code/contracts` |

## Packing for Cloud

- `files` in every package.json is `["dist", "!dist/**/*.map", ...]` (verifier adds `assets`, worker adds `ec2` and `service-catalog`). npm obeys `.gitignore`, which
  ignores `dist/`, so without `files` a tarball held `src/` and not the build. Pack only after `npm run build`. `scripts/pack-packages.ts` fails if a
  tarball has no `dist/`, has `src/`, or holds a `*.map`.
- CI job `pack` stamps `<version>-ci.<short sha>` on every package and on their exact dependencies on each other (`scripts/stamp-package-versions.ts`, in the
  checkout only), builds, packs, and uploads the artifact `code-packages`: one `.tgz` per package plus `packs.json` (name, version, file, sha256).
- Cloud also writes into Code's tree with two generators, `scripts/generate-e2e-agent-models.ts` and `scripts/update-public-suffix-list.mjs`. They belong
  in Code. They are not moved in this lane (only the first is in this tree today; the second is not).

## Every directory of the old broker

`packages/broker/src/*` is now `packages/core/src/*`, unchanged inside. The table says what each directory is and what a later step would do with
it. "Later" is a proposal, not something this step did.

| Directory | Files | What it is | Later |
|---|---:|---|---|
| `core/` | 459 | the task engine (task flow, merge, proof, plan, sessions, decisions, ...) | stays in `@rovara-code/core` |
| `services/` | 9 | the host-neutral service layer (#502) | stays; named entries above |
| `ports/` | 20 | in-memory implementations of the ports and port helpers | stays |
| `developer/` | 44 | task records, access, sharing, plan documents | stays (the engine reads it; see cycles) |
| `e2e/` | 31 | E2E evidence, plans, model routes | stays |
| `context-sources/`, `connections/`, `connectors/`, `chatgpt/`, `rovara-code/`, `agents/`, `monitoring/` | 63 | engine-side integrations and helpers | stay |
| root files (`auth.ts`, `handler.ts`, `registry.ts`, `projects.ts`, `callbacks.ts`, ...) | 27 | the broker's shared helpers and the handler | stay |
| `plugins/` | 53 | the built-in plug-ins (GitHub, Slack, Linear, Jira, CodeBuild, Bedrock, S3, Secrets Manager, fakes) and the registry that lists them | the outside-system plug-ins leave once the registry moves up (see cycles) |
| `local/` | 76 | the laptop app | phase 2b: `@rovara-code/local` |
| `lessons/` | 96 | the lessons engine, used only by `local/` | goes with `local/`, or its own package |
| `aws/` | 129 | the AWS control plane: Lambda handlers, Slack web, admin pages, workflows | not one of the four generic adapters; a later decision where it belongs (it is already public, see the port guard note) |

## What the split could not do without a real logic change

The target table says `@rovara-code/core` is `packages/broker/src/core`, and that GitHub and Slack are packages of their own. Neither can be cut out of
the broker mechanically. The measurements are from the import graph of `packages/broker/src` at the base commit (f5a14c386).

1. **`core/` is not separable from the rest of the broker.** `core/` has 458 source files. They import 71 times from `developer/`, 16 from `e2e/`, 10 from
   `aws/`, 8 from `rovara-code/`, 7 from `ports/`, 16 from `plugins/routing.ts`, and from the root files `callbacks.ts`, `handler.ts` and
   `repository-access.ts`. Going the other way, seven files outside `core/` import it back, so these are real cycles and not just a layering to flip:

   ```
   aws/broker.ts                          -> core/intake/quick-auto-start.ts
   developer/pull-request-feedback-section.ts -> core/proof/linear-close.ts
   developer/task-records.ts              -> core/second-review/store.ts
   e2e/media-evidence.ts                  -> core/proof/evidence-pack.ts
   plugins/code-host/github/spec-git-client.ts -> core/spec/publish.ts
   ports/policy-defaults.ts               -> core/cost/price-table.ts, core/pr-commands/comment-checks.ts
   ```

   The smallest set of files that can be a package with `core/` and `services/` is the closure of their imports: 678 files (467 plus 211 pulled in from
   `aws/` 81, `developer/` 39, `e2e/` 27, `connectors/` 12, `context-sources/` 9, `ports/` 7, `connections/` 6, `chatgpt/` 5, `rovara-code/` 5,
   three plug-in files and 17 root files). That cuts several folders in two, which is not what the target table describes. So this step moved the whole
   broker and called it core.

   Phase 2b has since cut this down: one type import
   (`aws/e2e-runtime-readiness.ts` taking `TransactItems` from `aws/developer-task-actions.ts`) carried 122 of the 211 extra files, and removing it makes the closure 556
   files. `tests/contract/engine-boundary.test.ts` now holds the engine to a committed file set (`engine-boundary-files.txt` plus `core/`, `services/` and `ports/`)
   and fails on any import that leaves it.

2. **`local/` needs 196 distinct engine files** (152 in `core/`, 6 in `services/`, 8 in `plugins/`, 7 in `context-sources/`, and others). If `local/`
   becomes its own package (phase 2b) and the engine is a separate package, `local/` can import only named entries, so the engine would need about 196
   entries, or `local/` would have to import through a few barrels. This needs a decision in 2b: it is the real cost of the split. For now `local/` lives in
   `@rovara-code/core`, so `@rovara-code/core/local` is the existing entry and nothing cross-package imports by path.

3. **GitHub and Slack cannot leave the package without a cycle.** `plugins/index.ts` (the registry of built-in plug-ins) imports both. The Slack plug-in
   (8 files) imports only `plugins/module-support.ts`; the GitHub plug-in (13 files) imports `github-app.ts`, `github-job-log.ts`,
   `github-pull-status.ts`, `repository-access.ts`, `agents/github-agent-tools.ts`, `core/spec/publish.ts`, `ports/secret-error.ts`,
   `plugins/code-host/code-owners-file.ts` and `module-support.ts`. A `@rovara-code/slack` or `@rovara-code/github` package would import those from core
   and core would import the package back (through the registry and through `local/`), and TypeScript project references refuse a cycle. Two things
   break it, both more than a move: the registry and `local/` move above the plug-ins (that is 2b), and `aws/github-webhooks.ts` stops importing
   `plugins/code-host/github/signature.ts` (the one file the engine takes from the GitHub plug-in).

4. **A cross-package relative import was in the source**: `core/src/e2e-presentation.ts` imported `../../contracts/src/e2e-view-node.js`. It is now
   `@rovara-code/contracts` (the same module, already exported by the root entry). Type-only; the guard test now forbids the pattern.

5. **`aws/` in core holds the AWS control plane**, not one of the four generic adapters. It was already public on `code/next`. It moved with the broker, and
   the port guard now sees its 129 files as new files under an `aws/` directory (see the next section).

## Tests changed for a reason other than an import path

Every test file changed in commit 1 follows the rename. Beyond an import path, a package name or a path string, these needed more, each because of the rename and
nothing else:

- `tests/unit/port-guard.test.ts`, `tests/contract/artifact-retention-infrastructure.test.ts`, `tests/unit/test-deploy-check.test.ts`: an expected list that was
  sorted, in which `packages/core/...` now sorts after `packages/contracts/...`; the lists were reordered.
- `tests/unit/setup-dns-watch-setup-mode-frozen.test.ts`: two SHA-256 constants of frozen files; the only change in those files is their `@agentx/contracts` import line.
- `tests/contract/__snapshots__/legacy-templates.test.ts.snap`: the release pipeline's trigger path `packages/{broker,...}` is now `packages/{core,...}`.
- `tests/contract/admin-health-infrastructure.test.ts`, `tests/contract/worker-e2e-import-boundary.test.ts`, `tests/unit/e2e-agent-model-seam.test.ts`: regular
  expressions that spelled the old package scope (`@agentx\/contracts`, and the scope of the workspace walker, which now accepts `@rovara-code` too).
- `tests/contract/port-guard-ci.test.ts` (commit 2): the `local` gate also waits for the new `pack` job.

One source line is not an import path: the comment the EC2 boot script carries (`# Rendered by ec2WorkerBootScript (...)` in `packages/contracts/src/session.ts`) says
`(contracts)` instead of `(@agentx/contracts)`. The longer new name pushed the worst-case user data 3 bytes past its test's margin.

Failing, and not caused by the split: `tests/contract/loop-cli.test.ts` (`/var` against `/private/var` in a macOS temp path) fails on the base commit too. The E2E fixture
tests need Node exactly 22.23.2 (`heavy.sh` puts 22.23.3 first); they pass under 22.23.2. Failing because of the split: `tests/contract/port-guard-range.test.ts` (above).

## Things that need the controller

- **The port guard reads a directory move as new files.** The guard does not follow renames (`--no-renames`, on purpose), so the range
  `f5a14c386..HEAD` reports 171 `cloud-aws` findings (128 files of `packages/core/src/aws/` as new files under an `aws/` directory, and 43 AWS SDK imports in files of `core/`), 10
  `accepted-stale` entries (files in the accepted list whose imports changed), and 3 `private-name` findings on one line of
  `packages/core/src/aws/task-person-proof-runtime.ts` (line 11, an ARN pattern holding an account id; it is the same line the file has on `code/next`, so it is
  already public). All 184 are in `packages/core`; none is new content: every one is a file that was already on `code/next`. The same goes for `tests/contract/port-guard-range.test.ts`, which runs the guard over the real CI range and so fails for the same reason; it passes on the base. Judging this needs the controller. The
  accepted list is read from `code/next`, so it cannot be fixed from this branch.
- **`scripts/boundary-allowlist.json` changed** (the package name and directories of the generic AWS adapters, and the sanctioned Bedrock folder). Cloud
  keeps a byte-identical copy and compares against it, so Cloud's copy needs the same edit.
- **Cloud's imports.** Cloud imports `@agentx/contracts` and the broker by their old names. After this lands they are `@rovara-code/contracts` and
  `@rovara-code/core`. The names in Cloud's own packages (`@agentx/ui`, `@agentx/web`, ...) are untouched here.
- **Worker and verifier tarballs.** `@agentx/verifier` depends on `e2e` by `file:../../upstream/e2e-0.20.0.tgz`. The tarballs that `npm pack` makes
  keep that dependency as written, which does not resolve outside this repository. Cloud will need that tarball too, or the dependency changed. Not
  done here (it is a dependency decision, not a move).
- **Specs and old docs** under `specs/`, `docs/specs/` and `.superpowers/` keep the old names and paths: they are records of what was true then.

## How the move was done

1. `git mv packages/broker packages/core`. The AWS adapters package keeps the directory `packages/aws-adapters`: the port guard refuses a new file under any directory called `aws/`, so a directory `packages/aws/` would have been refused (the guard's own tests say so). The package name is `@rovara-code/aws`; the directory is not part of an entry.
2. A scripted find-and-replace over every tracked file except the historical records above: the five package names and the broker path, in imports,
   `package.json` dependencies, tsconfig references, Dockerfiles, scripts, tests and live docs. `package-lock.json` was regenerated with
   `npm install --package-lock-only`; only workspace names and links changed in it.
3. Additions: the `exports` lists, `files` lists (so `npm pack` ships `dist`), the browser entry, the two guard tests and the API reports, the
   pack script and CI job, this document.
