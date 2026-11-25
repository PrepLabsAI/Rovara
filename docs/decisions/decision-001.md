# Decision 001: the model gateway is public and part of Code

- **Date:** 2026-11-25
- **Decider:** the owner
- **Work item:** [#1478](https://github.com/PrepLabsAI/Rovara/issues/1478)
- **Replaces:** the model-gateway part of DEC 214 ("the model gateway … stays in Cloud")

## Context

Cloud depends on Code for its API, and Code's agents depend on Cloud's model gateway for every model call. Each repository needs the
other to ship. #1478 moves the gateway into Code so that Code owns it. Under DEC 214, Code's port guard refused the gateway as Cloud-only work.
It also listed the Cloud repository's name as private. The gateway's live AWS resources carry that name (in their stack names, their
settings paths and their IAM path), and renaming them would replace the stacks.

## Decision

The model gateway is public and Code's. The port guard no longer treats the gateway, or the Cloud repository's name, as private.

## Consequences

- **Guard rules:** the port guard's Cloud-only deployment words drop the gateway (and its old name, the model proxy), and its private-name
  list drops the Cloud repository's name. `111111111111` joins the placeholder account ids.
- **Still Cloud-only:** billing, budgets, the company admin backend, the team record, the audit ledger, devices, the Cloud web app and
  anything else called cloud. Private branch names, real account ids and customer names stay refused.
- **The Cloud repository:** it stays private. Only its name is no longer a secret.
