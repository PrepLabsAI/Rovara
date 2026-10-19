# Rovara E2E runtimes: status

## M1: Browser and API

| Sub | Ships | Exit demo in TEST | Status |
|---|---|---|---|
| M1.0 | Fast lane: standing qualification grant (IaC), `scripts/test-deploy.ts`, web fixture repo | One command deploys a build to TEST; the fixture project is reachable without new grants | in progress |
| M1.1 | Salvaged runtime, executor image, Docker application host, web/API runtime qualification | `linux-arm64-web-api-v1` qualifies on the TEST runner: CSV positive passes; the defect, egress and IMDS probes fail as expected | not started |
| M1.2 | Workflow wiring: discovery -> plan -> CHECKS -> verify -> publication for web/API | "Add Export CSV" request: the first candidate fails a real browser check -> send back -> repair -> passes -> draft PR with green CI | not started |
| M1.3 | Synthetic accounts, external-origin mocks, screenshots/trace and per-scenario results in page/Slack | Viewer-refused and tenant-isolation scenarios with an external API mocked; failure shows a screenshot and expected vs actual | not started |
| M1.4 | AI navigation (`agent` steps) through a governed model route | An agent step finds a renamed Export button; deterministic CSV assertions still decide | not started |

## Log

- 2026-10-18: owner approved the standing TEST fast-lane packet (`test-fast-lane.md`) once. M1 asks for no per-run grants after this.
- 2026-10-18: Task 0.1 committed: optional standing qualification transport (CDK context `agentx:e2eQualificationTransport=enabled`); deployed to TEST through the `qualification-transport` unit of `scripts/test-deploy.ts` (not yet deployed).
- 2026-10-18: Task 0.2: `scripts/test-deploy.ts` (plan-first TEST deploy) and `test-fast-lane.md` written. Fixture project `rovara-web-fixture` is backed by the owner-created, empty private repository `abhishek255/rovara-orders-web-fixture`; Task 0.3 seeds and registers it.
