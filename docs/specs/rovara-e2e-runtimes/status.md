# Rovara E2E runtimes: status

## M1: Browser and API

| Sub | Ships | Exit demo in TEST | Status |
|---|---|---|---|
| M1.0 | Fast lane: standing qualification grant (IaC), `scripts/test-deploy.ts`, web fixture repo | One command deploys a build to TEST; the fixture project is reachable without new grants | done, except registering the fixture project (moved to M1.2) |
| M1.1 | Salvaged runtime, executor image, Docker application host, web/API runtime qualification | `linux-arm64-web-api-v1` qualifies on the TEST runner: CSV positive passes; the defect, egress and IMDS probes fail as expected | **done 2026-10-19** (live in TEST) |
| M1.2 | Workflow wiring: discovery -> plan -> CHECKS -> verify -> publication for web/API | "Add Export CSV" request: the first candidate fails a real browser check -> send back -> repair -> passes -> draft PR with green CI | not started |
| M1.3 | Synthetic accounts, external-origin mocks, screenshots/trace and per-scenario results in page/Slack | Viewer-refused and tenant-isolation scenarios with an external API mocked; failure shows a screenshot and expected vs actual | not started |
| M1.4 | AI navigation (`agent` steps) through a governed model route | An agent step finds a renamed Export button; deterministic CSV assertions still decide | not started |

## Log

- 2026-10-18: owner approved the standing TEST fast-lane packet (`test-fast-lane.md`) once. M1 asks for no per-run grants after this.
- 2026-10-18: Task 0.1 committed: optional standing qualification transport (CDK context `agentx:e2eQualificationTransport=enabled`); deployed to TEST through the `qualification-transport` unit of `scripts/test-deploy.ts` (not yet deployed).
- 2026-10-18: Task 0.2: `scripts/test-deploy.ts` (plan-first TEST deploy) and `test-fast-lane.md` written. Fixture project `rovara-web-fixture` is backed by the owner-created, empty private repository `abhishek255/rovara-orders-web-fixture`; Task 0.3 seeds and registers it.
- 2026-10-19: final whole-branch review of M1.0/M1.1 fixed before the live TEST qualification: the qualification instance is tagged `DeploymentMode=e2e-qualification` (the session reconciler ends unowned `ec2-ebs` instances after 15 minutes); the standing grant is scoped per instance with `${aws:userid}` (`e2e-runtime/<role unique ID>:<instance ID>/`); the qualification script preflights the transport before launching; the hook checks and pulls the executor image; the fast-lane packet lists every action both scripts perform. The web/API registration expires 7 days after qualification, so M1.2 demos must run within that window or requalify.
- 2026-10-19: **M1.1 exit, live in TEST (`agentxlivetest123`)**, from branch head `d36bb1bb` (PR #402):
  - `scripts/test-deploy.ts --apply` deployed, in order:
    - the qualification transport: one added `E2eQualificationTransport` policy on the worker role, Get `e2e-runtime/${aws:userid}/challenge.json`, Put `…/{proposal,ready,status}.json`;
    - the Broker and Dispatcher code: CodeSha256 verified, with eight no-op `BrokerE1355FD6.Arn` re-evaluations accepted by the guard;
    - the worker image `worker@sha256:1994ba69…`;
    - the new `ExecutorImageUri` `executor@sha256:05d1b9e0…` (ECR repository `agentx-nativeflow-20261008/executor`, created with owner approval).
  - `scripts/test-qualify-runtime.ts --apply` ran the preflight, launched runner `i-0cfe8d699d3b4b7af` (m6g.large, 10.42.134.12) with volume `vol-0417c462bc528622e`, waited for ready, issued challenge `f5f37659-…`, collected the hook's proposal, registered it, and deleted the challenge.
  - Catalog rows `PROFILE#linux-arm64-web-api-v1#web` and `#api` are READY, generation 1, qualified 2026-10-19T20:23:00Z, expiring 2026-10-26T20:23:00Z.
  - The existing P0 runner (`default-sandbox`, `i-0cec8fcbfff835b9f`) is untouched.
- 2026-10-19: live findings fixed through reviewed changes before re-running:
  - test-deploy uploaded to the unversioned control-plane artifacts bucket; it now uses the versioned access-stack bucket and checks it matches the deployed Lambda code bucket;
  - the post-execute wait polled a consumed change set; it now waits on the stack;
  - the exact-change guard refused CloudFormation's no-op Arn re-evaluations; it now accepts only those, caused by the code units of the run.
- 2026-10-19: Task H1: network walls for untrusted containers (see "Before M1.2 runs untrusted candidates"). Verified locally (unit and contract tests, fake Docker); the Linux behaviour is verified by the `linux-runtime` CI job.
- 2026-10-19: TEST cleanup with owner approval: terminated five unregistered P0 qualification instances and deleted their five detached 20 GiB data volumes.

## Before M1.2 runs untrusted candidates

M1.1 qualifies only Rovara's own fixture. These must be done before a candidate repository's code runs on a qualified runner:

- [x] Build-container egress was broader than "registry egress": the default bridge reached the VPC, the host (the worker on `0.0.0.0:8080`), other runs and the internet. Done (H1, 2026-10-19), in code only, not yet deployed:
  - Builds run on their own per-run bridge `rvb<8 hex>` (not `--internal`: package registries need the internet), app and executor on the per-run `--internal` bridge `rvi<8 hex>`. The default bridge is no longer used, and the source copy runs with `--network none`.
  - `packages/worker/ec2/boot.sh` installs the host firewall through the reboot-safe `rovara-container-firewall` unit (the worker unit `Requires=` it): `DOCKER-USER` drops from `rvb+` to `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16` and `127/8`; drops from `rvi+` to anything outside an `rvi` bridge; `INPUT` drops from `rvb+` and `rvi+` (no container reaches a host port); IMDS stays dropped; IPv6 gets `INPUT` drops where `ip6tables` exists (Docker IPv6 is off on the worker, so this is defence in depth). Cross-run traffic between two `rvi` bridges is left to Docker's own isolation chains, and the Linux CI test checks it.
  - DNS: Docker's embedded resolver forwards from the container's network namespace, so the VPC resolver (a private address, exempt from the worker security group) needs an exception. The firewall reads the nameservers in `/etc/resolv.conf` and `/run/systemd/resolve/resolv.conf` and lets `rvb+` reach only those, on port 53. CI cannot reproduce a private resolver (its upstream is public), so this is verified by the contract test and first proven live on the next runner.
  - Two new required probes: `build-lateral-denial-v1` (the build container connects to its gateway at the worker port and to a private address; exit 7 only if both time out) and `app-host-denial-v1` (the app starts behind a guard that connects to the host on its internal bridge at port 8080 and starts only if that times out). The network policy digest moved to `e2e-web-api-network-policy/v2`.
  - **Requalify after deploy.** The required probe set and the network policy digest changed, and a running worker only gets the firewall from the boot script of a new instance. The runner registered on 2026-10-19 (`i-0cfe8d699d3b4b7af`) predates the walls: launch a new qualification runner from the new worker image and register it (`scripts/test-qualify-runtime.ts`) before any candidate code runs. A domain allowlist or a registry-only proxy remains a future option.
- Chromium runs with `--no-sandbox` (Ruling P; the container is the boundary). Revisit with a seccomp profile that allows user namespaces.
- Group deadlines must stay under the one-hour stale sweep, and orphan workspace directories need a sweep.
- The flaky `e2e-application-build-source` test: investigate.
