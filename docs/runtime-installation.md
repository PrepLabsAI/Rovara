# Standard portable runtime qualification

Deployment provisions the pinned worker image, Node 22.23.2, Docker, the private Docker socket, and the fixed runtime/evidence directories. It does not install or qualify the verifier on an operator host, and it does not register either runtime catalog. Standard catalog qualification remains a separate operator action on the actual Linux ARM64 worker supervisor.

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

The endpoint and EC2 binding remain administrator-selected inputs. The broker does not independently discover the private host or verify the launch binding against cloud metadata. This is operator-managed qualification evidence, not hardware attestation. Darwin/Colima qualification is supported for local candidate testing only; the registrar rejects it for the standard Linux catalogs. Linux supervisor qualification has not yet been run, so standard production registration remains unverified.
