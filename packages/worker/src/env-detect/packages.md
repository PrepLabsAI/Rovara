# Workspace discovery foundation (TE-P1)

`detectWorkspacePackages(paths, load, cwd, options?)` in `packages.ts` is a worker-internal,
read-only entry point for the future package-unit draft lane. It is deliberately not
called by `test-env-detect.ts`, exported from contracts, or sent over the wire yet.
No command, filesystem traversal, graph computation, or build script is executed.

The caller supplies the **complete, uncapped** repository-relative POSIX file inventory,
plus the same workspace-bound loader used by `boundedReader`. The loader must enforce
checkout containment, including symlinks; this function has no filesystem access.
An already truncated inventory cannot prove complete discovery and must not be passed.

The result is `single`, `workspace`, or `unavailable`:

- `single` contains exactly one `.` unit with today's `runDetectors` result, unchanged.
- `workspace` contains sorted, unique roots and separate `Detection` values. A root
  manifest retains a `.` unit. Each file belongs to its deepest declared package;
  nested package files never consume their parent's detection budget.
- `unavailable` contains no units and a fixed reason. A listed definition that cannot
  be read, an invalid/unsupported declaration, an unresolved member, or a discovery
  budget refusal must not be interpreted as a single package or a successful check.

Every unit gets its own 5,000-path, 256-KiB-file, 4-MiB-total reader and the existing
32-check/20-setup-command detector limits. `omittedPaths` records the number beyond
5,000 (including inherited lock aliases). Existing detection notes retain check and
byte-budget refusals. There is no new 64-check limit: that belongs to evidence.
Discovery metadata has its own existing bounded-reader budget. Root declarations
are read first; if a required member definition is cut or an Nx inventory is
truncated, discovery refuses rather than returning an incomplete package list.
Unrelated nested manifests cannot turn a non-workspace repository into a workspace.

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
  over package.json workspaces); npm/yarn `workspaces` array or `{ packages: [...] }`.
- Turborepo uses those package-manager declarations; `turbo.json` alone is insufficient.
- Nx package-manager declarations, colocated `project.json`, and legacy
  `workspace.json` projects with explicit roots. Inferred plugin graphs are not run.
- Gradle literal `include` lists in Groovy/Kotlin settings, with colon-separated paths.
  Dynamic include arguments, projectDir remapping and composite builds are refused.
- Maven literal `<modules>` lists, recursively. Property interpolation and profile-dependent modules are refused.
- Python uv `[tool.uv.workspace]` literal `members` and `exclude` arrays.

Globs match existing package/build manifests, not arbitrary source folders. Unknown
workspace systems and dynamic build graphs require a later adapter; this is not a
complete build-language interpreter. Repository strings remain internal; a future UI,
Check or PR consumer must apply its existing inert-text boundary before displaying them.

The follow-up contract/core lane must define package identities and bounds, a package
unit wire field, per-package truncation fields, and evidence sections/caps. It must
carry these results without pretending packages are repository IDs or flattening
40 packages into today's 32-check/20-command repository record. It must also wire the
loader to a complete inventory, preserve citations, and review setup ordering and
shared build configuration before activating this discovery path. TE-P2 graph selection
and TE-P3 folder rules/Check rendering remain separate.
