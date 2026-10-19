# Rovara Real-Runtime E2E Roadmap

Status: proposed, 2026-10-18. Supersedes the scheduling in `docs/rovara-e2e/runtime-completion-plan-20261017.md` (all runtimes at once, one combined test at the end). It keeps the product goals of the Oct 12 spec (`ManagedSDLC/docs/superpowers/specs/2026-10-12-rovara-tester-army-e2e/`). This document is the spec for the milestone plans that sit beside it.

## Goal

Before a draft PR opens, Rovara proves that the requested feature works by exercising the real candidate application. That means a browser and HTTP API first, then mobile apps, then desktop apps. Each runtime ships to mainline on its own and is demonstrated live in TEST (`agentxlivetest123`) before the next one starts.

## Where we are

- **Shipped (PRs #400 and #401):** discovery, setup approval and feature-plan E2E intent. It also covers the CHECKS round, the result adapter that rejects skipped, flaky or stale results, and fail → send back → retest, all gated before publication. Every scenario runs as a "portable contract": the candidate's exported JS function runs in a `--network=none` container. No browser runs and no HTTP calls are made.
- **Already in the mainline schema but marked unavailable:**
  - web, api, mobile and desktop targets;
  - the steps navigate, fill, click, request, choose-file, launch-app, tap, swipe, deep-link, restart-app and set-permission;
  - the assertions text, visible, csv, http-status, json, state and file.

  Discovery assigns `web-phase-unavailable` and `api-phase-unavailable`.
- **Branch `codex/rovara-e2e-runtime-automation-20261017` (paused at `c3b2ff95`, 54k lines):**
  - **Worth salvaging:** pure contracts, the application compiler, web/API case hosts (`@e2e-dev/web` 0.14.0 plus `playwright-core` 1.63.0), the application result adapter, probe assets and a web/API fixture app.
  - **Not salvaged for M1:** a 13k-line Python root lease helper that never ran on Linux, Darwin Swift runtimes, the model-governance stack and the installed-authority admin. Nothing in the broker or worker calls the salvaged runtime yet, and no test has ever launched Chromium.

## Decisions

1. **One runtime family per milestone, shipped in order:** M1 browser + API, then M2 mobile, then M3 desktop. Each sub-milestone is one PR to mainline with its own live TEST demo. Nothing waits for a combined campaign.
2. **Docker containment on the existing EC2 runner.** This replaces the root lease helper. Each run gets its own `--internal` Docker network. The pieces run like this:
   - The candidate is built in a build container that has registry egress but no credentials, with IMDS blocked.
   - The app runs on the internal network only.
   - Rovara's executor container holds the e2e CLI, `@e2e-dev/web` and a local Chromium. It runs on the same internal network, and its CDP endpoint is bound to `127.0.0.1` inside that container.

   None of these containers gets the Docker socket, cloud credentials or egress. This extends P0's `container-envelope.ts` conventions.
3. **Deterministic first.** Fixed steps and exact assertions ship before AI navigation (`agent` steps). The model only ever navigates; assertions decide pass or fail.
4. **Real runtimes are tested in CI, not on the dev Mac.** A `linux-runtime` CI job on `ubuntu-24.04-arm` builds the executor image and runs real Chromium against the fixture app. The live TEST demo then proves the installed host.
5. **A standing TEST fast lane, approved once.** It needs:
   - an IaC-managed qualification transport grant on the TEST worker role;
   - a lasting fixture-project membership and a higher workspace limit;
   - a one-command `scripts/test-deploy.ts`.

   This replaces per-run 30-minute grants. It needs one Tier 3 approval (ManagedSDLC `AGENTS.md:100`). Production keeps the strict per-change gate.
6. **Bounded review.** One reviewer pass per PR, plus at most one re-review. Correctness and security problems on the shipped path block; everything else becomes a follow-up issue.
7. **Mobile and desktop detailed plans are written when their milestone starts.** Each starts with a host spike, because their hosts (KVM for Android, `mac2.metal`, Windows) are not provisioned and their cost needs owner approval.

## Milestones

Each row is one PR, deployed to TEST, with its exit demo recorded in `docs/specs/rovara-e2e-runtimes/status.md`.

### M1: Browser and API (detailed plan: `docs/specs/rovara-e2e-runtimes/m1-browser-api-plan.md`)

| Sub | Ships | Exit demo in TEST |
|---|---|---|
| M1.0 | Fast lane: standing qualification grant (IaC), `scripts/test-deploy.ts`, web fixture repo | One command deploys a build to TEST; the fixture project is reachable without new grants |
| M1.1 | Salvaged runtime, executor image, Docker application host, web/API runtime qualification | `linux-arm64-web-api-v1` qualifies on the TEST runner: CSV positive passes; the defect, egress and IMDS probes fail as expected |
| M1.2 | Workflow wiring: discovery → plan → CHECKS → verify → publication for web/API | "Add Export CSV" request: the first candidate fails a real browser check → send back → repair → passes → draft PR with green CI |
| M1.3 | Synthetic accounts, external-origin mocks, screenshots/trace and per-scenario results in page/Slack | Viewer-refused and tenant-isolation scenarios with an external API mocked; failure shows a screenshot and expected vs actual |
| M1.4 | AI navigation (`agent` steps) through a governed model route | An agent step finds a renamed Export button; deterministic CSV assertions still decide |

### M2: Mobile (detailed plan written when M1.2 ships)

| Sub | Ships | Exit demo |
|---|---|---|
| M2.0 | Host spike plus owner cost approval. Android needs KVM: compare a bare-metal x86 instance against nested-virtualization support, and check current EC2 docs. iOS uses `mac2.metal` (24 h minimum; quota is already 1) | Written host decision; emulator boots and installs an APK on the chosen host |
| M2.1 | Android: candidate APK build, a fresh emulator per run, `@e2e-dev/mobile` 0.12.0 + `agent-device` 0.21.25 (salvage `android-provider.ts`, `mobile-provider.ts`, `mobile-templates.ts`, `native-artifact-staging.ts`). Steps launch-app/tap/swipe/deep-link/restart-app/set-permission | Android fixture feature: fail → repair → pass → draft PR |
| M2.2 | iOS on `mac2.metal`: `xcodebuild` simulator build, `simctl`, same provider interface (salvage `ios-provider.ts`) | iOS fixture feature, same journey |

### M3: Desktop (detailed plan written when M2.1 ships)

| Sub | Ships | Exit demo |
|---|---|---|
| M3.1 | Electron on Linux: executor variant with Xvfb plus the Playwright Electron driver | Electron fixture feature journey |
| M3.2 | Native Linux: AT-SPI driver (salvage `packages/verifier-native/linux/driver.py`) | GTK fixture journey |
| M3.3 | Native macOS on the M2.2 Mac host (salvage the Swift helpers in `packages/verifier-native/macos`) | macOS fixture journey |
| M3.4 | Native Windows: UI Automation (salvage `packages/verifier-native/windows/Driver.cs`), Windows host | Windows fixture journey |

**Rules that keep every runtime on the same pattern.** M1 builds them, and M2 and M3 must only add to them:

- **Runtime profile:** a capability descriptor (salvaged `e2e-runtime-capabilities.ts`) plus a catalog registration and its qualification probes. Each runtime adds one profile.
- **Readiness:** discovery and planning read readiness from the catalog. An unqualified profile makes its scenarios unavailable, or mock-backed where an approved mock exists. Rovara never invents a pass.
- **Execution:** the worker dispatches on application admission kind to a host implementation of `E2EApplicationRuntimePorts`. Each runtime adds one host implementation.
- **Results:** the application result adapter, broker re-verification and publication guard are shared by every runtime.

## Testing strategy

Every milestone is tested at these levels. A level is never replaced by a lower one.

1. **Unit and contract** (Vitest, fakes, run anywhere): compiler, adapter, host argument construction, gating rules.
2. **Linux runtime** (`tests/linux/**`, CI `linux-runtime` job, `ROVARA_DOCKER=1`): real containers, real Chromium (later a real emulator or desktop session where CI can host it) against fixture apps, including causal defects and containment negatives.
3. **Native journey** (`tests/e2e/m*-journey.test.ts`): broker and worker in process over the real runtime, from plan approval through failing round, send-back, passing round and the publication gate.
4. **Live TEST acceptance** (`docs/specs/rovara-e2e-runtimes/m*-live-acceptance.md` runbooks): installed host qualification, then the exit demo through Slack/CLI to a draft PR in the fixture repo with green CI.

## Ways of working

- **One milestone in flight.** Up to 3 parallel implementers on disjoint files; shared files (`broker.ts`, `developer-tasks.ts`, contracts `index.ts`, lockfile) are owned by one task at a time.
- **Fresh session per sub-milestone.** Start from this roadmap, the milestone plan and `docs/specs/rovara-e2e-runtimes/status.md`; don't reuse a long-running thread.
- **Status lives in `docs/specs/rovara-e2e-runtimes/status.md`.** Update it at each verified step: what passed (with command or link), what's next, blockers.
- **Heavy suites run in CI.** Locally: focused tests only, one at a time, on Node 22.23.2.
- **Never present component tests as completion.** Only the exit demo closes a sub-milestone.
