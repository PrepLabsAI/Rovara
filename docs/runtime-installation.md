# Standard portable runtime qualification

Deployment provisions the pinned worker image, Node 22.23.2, Docker, the private Docker socket, and the fixed runtime/evidence directories. It does not install or qualify the verifier on an operator host, and it does not register either runtime catalog. Standard catalog qualification remains a separate operator action on the actual Linux ARM64 worker supervisor.

The qualification candidate runs with 2 vCPU and 4 GiB of container memory. The supervisor host must provide at least those CPU and memory resources in addition to the operating system and worker service; the default AWS worker profile is `m6g.large` (2 vCPU, 8 GiB RAM).

An administrator issues a fresh challenge through the broker. The control plane derives the setup and feature catalog IDs from deployment configuration. The administrator supplies the intended EC2 binding, private worker endpoint, generation, transport correlation UUID, and fixed `linux-arm64-docker-v1` profile:

```sh
agentx --env <environment> admin runtime-installation challenge \
  --binding-file ./verifier-runtime-binding.json \
  --endpoint http://10.0.2.15:8080 \
  --generation 3 \
  --transport-correlation-id 11111111-1111-4111-8111-111111111111 \
  --profile linux-arm64-docker-v1 \
  --out ./runtime-install-challenge.json
```

Use the existing approved operator process to place that challenge at `/mnt/workspace/.agentx-runtime/evidence/runtime-install-challenge.json` on the selected host. The worker container mounts this host evidence directory at `/mnt/agentx-runtime/evidence`. Run the packaged qualifier inside the existing worker container, as its `node` user, using the image's fixed Node binary:

```sh
docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js \
  --challenge-file /mnt/agentx-runtime/evidence/runtime-install-challenge.json \
  --evidence-root /mnt/agentx-runtime/evidence \
  --out /mnt/agentx-runtime/evidence/runtime-install-proposal.json
```

The qualifier checks the boot-injected workspace UUID and generation, verifies the private endpoint matches a non-loopback host IPv4 address and worker port, inspects actual prerequisites and installed bytes, then runs the fixed positive and negative probes through the production compiler, E2E CLI, and contained candidate runner. Copy the resulting proposal from the host path `/mnt/workspace/.agentx-runtime/evidence/runtime-install-proposal.json` using the same approved operator process. No SSH, SSM, upload/download, or other host transport is implemented by this workflow.

The issuing administrator registers the exact proposal file and digest through the broker:

```sh
agentx --env <environment> admin runtime-installation register \
  --proposal-file ./runtime-install-proposal.json
```

Registration validates the fixed scenario identities, challenge-bound original request/response captures, complete pinned E2E report and run-start record, expected negative failure, candidate cleanup receipt, installed manifest, issuer attribution, and exact proposal approval digest. It stores immutable evidence and uses one conditional transaction to publish both distinct setup and feature catalog records while consuming the one-use challenge. A catalog record is evidence that the fixed qualification passed for its recorded manifest and environment; runtime admission still checks freshness and recomputes the installed manifest before execution.

The endpoint and EC2 binding remain administrator-selected inputs. The broker does not independently discover the private host or verify the launch binding against cloud metadata. This is operator-managed qualification evidence, not hardware attestation. Darwin/Colima qualification is supported for local candidate testing only; the registrar rejects it for the standard Linux catalogs. Qualification must be observed on the actual Linux supervisor for the intended deployment; local or TEST qualification alone does not establish production qualification.

## Web/API application runtime profile

`linux-arm64-web-api-v1` qualifies the browser and API runtime (scope `application-web-api/v1`) with `install-qualification-cli.js --profile linux-arm64-web-api-v1`, after a challenge issued for that profile. It runs six probes through the production Docker host and the real collector: the CSV and API state positives must pass; the CSV defect must fail on its `csv` assertion; the web egress probe must fail with `probe.example.com` recorded as blocked; the API egress probe must fail on its `http-status` assertion; and the build command that reaches the instance metadata service must fail with exit 7 and `build-failed`. A probe that passes when it should fail, fails for another cause, or is skipped, flaky or retried rejects the whole qualification (for example `negative-probe-passed:web-csv-negative-v1`).

Registration of the resulting proposal writes two v2 catalog rows, one per target kind (`PROFILE#linux-arm64-web-api-v1#web` and `#api`), in the same one-use-challenge transaction. The broker re-judges every recorded probe observation, and re-derives each one from the retained evidence in the proposal, before it writes anything; the proposal's `READY` state is never trusted on its own. The six probe asset digests are pinned in `@agentx/contracts`; a proposal parses only when its recorded digests and the installed manifest's entries for those files equal them, and registration refuses to move either row to an older worker generation.

### Operator command

The worker container needs the `EXECUTOR_IMAGE` environment variable (the executor image its boot script pulled) and the Docker socket, as P0 does. The qualifier fails closed when `EXECUTOR_IMAGE` is unset or is not a plain image reference, and uses the pinned Node 22.23.2 base image to build the qualification app. Probe runs are staged under `/mnt/agentx-runtime/candidates/web-api-probes`, a path the worker shares with the Docker host. Each probe runs under the run ID derived from the challenge, and the raw evidence of each probe is also kept privately under a `web-api-probe-evidence-<challengeId>-<random>/` directory in the evidence root.

```sh
docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js \
  --profile linux-arm64-web-api-v1 \
  --challenge-file /mnt/agentx-runtime/evidence/runtime-install-challenge.json \
  --evidence-root /mnt/agentx-runtime/evidence \
  --out /mnt/agentx-runtime/evidence/runtime-install-proposal.json
```

Copy the proposal out and register it as above (`agentx admin runtime-installation register --proposal-file ...`); the same command registers a P0 or a web/API proposal. A qualification takes several minutes (six container runs, including a build), so the broker issues a `linux-arm64-web-api-v1` challenge with a 60 minute lifetime (a `linux-arm64-docker-v1` challenge keeps its 5 minutes); there is no lifetime option. Qualify and register within that hour, since registration is refused once the challenge has expired. A qualification interrupted part-way can be run again with the same challenge: the runner clears the containers, network and files its earlier attempt left for each probe before starting it.

### The opt-in boot hook (TEST)

A worker whose user data sets `AGENTX_E2E_QUALIFICATION_PREFIX` (exactly `e2e-runtime/<uuid>/`), `AGENTX_E2E_QUALIFICATION_PROFILE=linux-arm64-web-api-v1` and `AGENTX_E2E_QUALIFICATION_BUCKET` (all validated by the boot configuration schema) runs the command above itself, once the worker answers `/ping` (it uploads `<prefix>ready.json` then, so the issuer can start the challenge's lifetime only for a ready host): it fetches `<prefix>challenge.json` from the bucket with the instance role (the standing grant of `agentx:e2eQualificationTransport=enabled`), runs the qualifier, and uploads `<prefix>proposal.json` and `<prefix>status.json` (`{"state":"SUCCEEDED"|"FAILED","reason":...,"finishedAt":...}`). It runs as its own systemd unit after the worker has started, so a failure changes nothing about the worker or the boot. Without the variables nothing runs. `scripts/test-qualify-runtime.ts` launches such a worker, issues the challenge for it and registers the result: see `docs/specs/rovara-e2e-runtimes/m1-live-acceptance.md`.

### What the registrar verifies, and what it does not

The probes run against the qualification app, an installed copy of the orders fixture (`packages/verifier/assets/qualification-app`, covered by the installed-runtime manifest). Its tree digest is pinned in `@agentx/contracts`; the qualifier refuses to start unless the installed tree is exactly the pinned one, and the proposal parses only when its manifest lists exactly those files.

Each probe record embeds the bounded evidence its observation was derived from, like P0 embeds its report bytes: the scenario bundle that ran, the collector's complete wire collection and oracle (every raw executor report and proof byte), the executor's `blocked-requests.json` for web probes, or, for a run that produced nothing to collect, the host's structured build result. The registrar re-derives every observation from those bytes with the same pure functions the runner used (`deriveWebApiProbeObservation`) and registers nothing unless each recorded observation equals what its bytes show:

- `probe-evidence-mismatch:<probeId>`: the evidence does not re-derive to the recorded observation (an edited report, a collection whose digests do not hold, a scenario other than the one pinned for that probe, a blocked-requests file naming another run or shard, a build command or exit code the host did not report).
- `probe-evidence-unbound:<probeId>`: the evidence is not a run of this challenge's probe. Every probe run ID is derived from the challenge digest and the probe ID, and the evidence, the collector's run binding and the blocked-requests file must carry it; evidence recorded for another challenge, or copied from another probe, is unbound. Missing evidence is unbound too.
- `probe-evidence-oversized`: the whole canonical proposal may not exceed 5 MiB (the standard P0 proposal keeps its 1 MiB retention bound). The bound also keeps the registration request under the 6 MB Lambda request limit. Each real probe contributes roughly 60-75 KB of evidence, so a proposal is a few hundred KB.

Trust limits. The binding proves that the recorded outcomes follow from the retained bytes and that those bytes belong to this challenge's runs of the pinned scenarios. It does not prove that a hostile qualifying host ran them honestly: the evidence is produced on the operator-selected host, so a host that fabricated a complete, internally consistent collection would pass. The blocked-requests file is tied to its run only by the run, group and upstream run IDs it names, and the build result is the Docker host's own account of the exit code it received (a fabricated build result is consistent with itself). This is operator-managed qualification evidence, not hardware attestation, as for P0.
