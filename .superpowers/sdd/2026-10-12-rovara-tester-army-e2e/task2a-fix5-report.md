# Task2A fix5 scoped report

## Authority and scope

Implemented the fifth bounded Task2A discovery correction against `MSDLC-OBJ-001@0.4` (objective digest `707543b940253c8e068da55af87b81b4c57dd8d0e82f83436be13f5391cdf0c2`) from clean source commit `1894b80affce5d2923737b0207fd702a9ac9141d`. This is local implementation evidence for the approved source-discovery contract; it is not a full Tester Army workflow, native runtime execution, or overall P0 completion claim.

## Corrections

- Android discovery now recognizes `AndroidManifest.xml` and application Gradle metadata independently of an `android/` directory prefix. Gradle-only app modules remain visible with an identity blocker; no package identity is guessed and Gradle is not executed.
- Apple application discovery now uses a bounded pure OpenStep parser to follow `PBXProject.targets` to application `PBXNativeTarget` records, their configuration lists and build settings, and a normalized in-snapshot `INFOPLIST_FILE`. SDK/platform settings corroborate iOS or macOS. Contradictions, malformed PBX data, unknown platform, unresolved variables, missing plist membership, or standalone plist without `APPL` plus a supported platform remain targeted blockers.
- Multiple application targets tied to one framework-owned plist stay associated with one app and retain distinct target IDs and runtime gaps. Unrelated project files with the same bundle ID remain distinct apps.
- Package manifests and standalone API schemas are canonically ordered. API target and recipe-input IDs bind to source paths. Dependency names index all candidate package manifests; only unique suppliers or explicit normalized `file:`/`link:` source relations create edges. Duplicate unresolved suppliers remain visible with all supplier paths in a blocking input.
- No contract schema or fixture capability was changed. Existing source snapshot, candidate identity, mock, floor, current-round, and per-assertion protections remain outside this source-discovery correction.

## Causal red evidence

Before production changes, the initial five-root regression run used:

```sh
PATH="/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin:$PATH" ./node_modules/.bin/vitest run tests/unit/e2e-review-fix5.test.ts
```

Raw output: `/Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix5-red-regressions.log` (5 failures, 1 positive same-bundle distinct-project control passed). It reproduced path-gated Android discovery, inventory-order-dependent standalone API IDs, first-match duplicate dependency suppliers, PBX ownership loss/misclassification, and dropped unclassified plist metadata. The raw transcript was captured from the exact starting source commit before implementation edits.

A further accepted boundary required retaining multiple PBX app targets associated with one framework-owned plist. Its test was added and run before the narrow correction:

```sh
PATH="/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin:$PATH" ./node_modules/.bin/vitest run tests/unit/e2e-review-fix5.test.ts
```

Raw output: `/Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix5-multitarget-red.log` (1 failure, 6 controls passed; the linked framework project retained only one of two app targets).

## Verification

Focused source and foundation gate, 13 files / 128 tests:

```sh
PATH="/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin:$PATH" ./node_modules/.bin/vitest run tests/unit/e2e-review-fix5.test.ts tests/unit/e2e-review-fix4.test.ts tests/unit/e2e-review-fix3.test.ts tests/unit/e2e-review-fix2.test.ts tests/unit/e2e-review-fix1.test.ts tests/unit/e2e-discovery.test.ts tests/unit/e2e-execution-plan.test.ts tests/contract/e2e-policy.test.ts tests/contract/e2e-review-regressions.test.ts tests/contract/e2e-review-fix2.test.ts tests/contract/setup-project-files.test.ts tests/contract/setup-project-add.test.ts tests/contract/fake-github-e2e.test.ts
```

Passed; raw output: `/Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix5-final-focused.log`.

Existing CLI gate, 4 files / 113 tests:

```sh
PATH="/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin:$PATH" ./node_modules/.bin/vitest run tests/contract/setup-admin.test.ts tests/contract/init-setup-page.test.ts tests/contract/config-commands.test.ts tests/contract/connector-config.test.ts
```

Passed; raw output: `/Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix5-final-cli.log`.

Additional checks, all passed:

```sh
PATH="/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin:$PATH" npm run build
PATH="/Users/abhishekgarg/.local/share/charterarc/toolchains/node-v22.23.2-darwin-arm64/bin:$PATH" npm run typecheck:all
git diff --check
```

Logs: `/Users/abhishekgarg/web/AgentX-e2e-p0-20261012-evidence/task2a-fix5-final-build.log`, `task2a-fix5-final-typecheck-all.log`, and `task2a-fix5-diffcheck.log`. Strict typecheck reported 0 errors against a 0-error baseline.

## Limits and status

The Apple parser is a bounded subset parser over immutable source bytes, not an Xcode invocation or complete PBX/plist evaluator. Unsupported syntax or settings remain unresolved. Android/iOS/macOS build, device, UI, and hardware workflows were not executed or installed. No live GitHub, cloud, credential, model, external publication, or deployment action was performed. Native operations and missing business assertions remain for later authorized units; this source proposal does not authorize feature expectations.

Status: `implemented` locally; focused tests and static checks passed; awaiting fresh scoped independent review. See sibling evidence receipt `task2a-fix5-commit.json` for the frozen local commit/tree identity.
