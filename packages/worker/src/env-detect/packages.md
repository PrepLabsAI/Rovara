# Workspace discovery foundation (TE-P1)

`detectWorkspacePackages(paths, load, cwd, options?)` in `packages.ts` is a worker-internal,
read-only entry point for the future package-unit draft lane. It is deliberately not
called by `test-env-detect.ts`, exported from contracts, or sent over the wire yet.
No repository command, filesystem traversal, graph computation, or build script is executed.

The caller supplies a complete repository-relative POSIX file inventory of **at most 5,000 files**,
plus the same workspace-bound loader used by `boundedReader`. The loader must enforce
checkout containment, including symlinks; this function has no filesystem access.
An already truncated inventory cannot prove complete discovery and must not be passed.
Larger inventories are refused before loading any file. The caller's lister can stop
at 5,001 entries and pass that overflow sentinel; no unbounded listing is required.

The result is `single`, `workspace`, or `unavailable`:

- `single` contains exactly one `.` unit with today's `runDetectors` result, unchanged.
- `workspace` contains sorted, unique roots and separate `Detection` values. A root
  remainder `.` unit retains metadata and every undeclared file. Each file belongs to
  its deepest declared package; no inventory path silently disappears.
- `unavailable` contains no units and a fixed reason. A listed definition that cannot
  be read, an invalid/unsupported declaration, an unresolved member, or a discovery
  budget refusal must not be interpreted as a single package or a successful check.

The whole call has at most **64 units**, including the remainder, and **one 4-MiB
read budget** shared by discovery and all units. One parent-owned `boundedReader`
enforces the existing 256-KiB file limit and caches every path, including inherited
root locks, once. As with today's reader, the loader may supply one file that crosses
the remaining budget; that file is not served, and no further uncached loads occur.
Workspace budget exhaustion refuses the entire result. Each unit keeps the existing
32-check/20-setup-command limits. `omittedPaths` remains zero with the total inventory
cap; there is no new 64-check limit (that belongs to evidence).

Discovery and **all** detector passes run inside one attempt of the existing worker
guard, with one 60-second default wall-clock limit and its memory limit. `timeoutMs`
can shorten that call's limit; `only` selects built-in detectors. The guard terminates
and joins its thread before returning. Timeout, crash or missing thread entry returns
`unavailable`, with no partial units or unguarded fallback. The loader remains the
caller's responsibility: it must be bounded asynchronous I/O and cannot execute repo
code. An in-flight load may settle after timeout, but is never forwarded to a stopped
thread. `discoverWorkspaceRoots` and `detectWorkspacePackagesInThread` are internal
helpers, not alternate consumer entry points.

`command.cwd` is relative to the workspace, including the repository and package root.
Sources, report paths, globs, dependency evidence and seed paths retain their existing
**unit-relative** meaning. `inheritedFiles` maps virtual paths to repository-relative
paths: when a Node package has no local lock, a root package-manager lock supplies
manager selection. Its setup command runs at the repository root; its test command
runs in the package. Consumers must use that mapping for citations. Setup commands
may repeat across units; the future integration must deduplicate execution without
losing package ownership. Other ancestor build settings/wrappers are not synthesized.
The detected commands are proposals, not proof that a build has run or will succeed.

Supported declarations:

- pnpm `packages` in `pnpm-workspace.yaml`, including negative globs (takes precedence
  over package.json workspaces when `packages` is present); npm/yarn `workspaces`
  array or `{ packages: [...] }`. Settings-only pnpm files and nohoist-only Yarn
  objects do not declare a workspace.
- Turborepo uses those package-manager declarations; `turbo.json` alone is insufficient.
- Nx package-manager declarations, colocated `project.json`, and legacy
  `workspace.json` projects with explicit roots. Nx without projects stays single.
  Inferred plugin graphs are not run.
- Gradle literal `include` lists in Groovy/Kotlin settings, with colon-separated paths.
  Parenthesized multiline lists parse fully; bare comma continuations refuse.
  Dynamic include arguments and projectDir remapping refuse. Strings, includeGroup
  and includeBuild do not declare modules; composite builds are not expanded.
- Maven literal `<modules>` lists, recursively. Property interpolation and profile-dependent modules are refused.
- Python uv `[tool.uv.workspace]` literal `members` and `exclude` arrays.

Globs match existing package/build manifests, not arbitrary source folders. Unknown
workspace systems and dynamic build graphs require a later adapter. Patterns are
capped at 256 total (including exclusions across declarations), compiled once and
matched only within their literal prefix in the sorted folder index. Supported syntax
is literal paths, `*`, `?`, whole-segment `**`, and simple alphanumeric character classes;
extended glob/brace syntax refuses. Optional malformed root package JSON and an
oversized root pom preserve today's single-repo result when no other workspace is
declared. A malformed root package in a declared workspace still refuses.
Go `go.work`, Cargo workspaces, Poetry/Hatch/Pants Python projects, Bazel and Lerna-only
layouts are **not supported yet** and remain single-repository detections. This is not a
complete build-language interpreter. Repository strings remain internal; a future UI,
Check or PR consumer must apply its existing inert-text boundary before displaying them.

The follow-up contract/core lane must define package identities and bounds, a package
unit wire field, per-package truncation fields, and evidence sections/caps. It must
carry these results without pretending packages are repository IDs or flattening
40 packages into today's 32-check/20-command repository record. It must also wire the
loader to a complete bounded inventory, preserve citations, and review setup ordering and
shared build configuration before activating this discovery path. TE-P2 graph selection
and TE-P3 folder rules/Check rendering remain separate.
