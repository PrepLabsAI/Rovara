# Spec 066: sign-in clients with full access

## Why

A person registered in Rovara who signs in to Rovara Cloud with that identity should be able to use Rovara through
Cloud as they do with the Rovara CLI. Until now a sign-in client's tokens reached only the access check and the scoped
routes of spec 065, so every Cloud feature needed a new route.

## Requirements

- **FR-001 (setting):** a sign-in client registration may have `fullAccess: true`, set and cleared by admin changes
  (`agentx admin sign-in-client add --full-access`, `update --full-access` / `--no-full-access`). Only a confidential
  client can have it; the CLI, the broker's plan and the sign-in server each refuse it otherwise.
- **FR-002 (developer API):** Rovara's developer API (`/v1/dev/*`) accepts a full-access client's token as its
  signed-in person, after the same checks as the access check (its own audience, a live session of that client, a
  person not removed), with that person's rights. A client without full access is refused there as before.
- **FR-003 (at once):** the setting is read on every request, so turning it off or removing the client ends the
  client's developer API access immediately, and no CLI sign-in is affected.
- **FR-004 (scopes):** a full-access client has every spec 065 scope on its own routes.
- **FR-005 (production):** the legacy deployment's linking-only sign-in (spec 064) serves `GET /v1/dev/projects`,
  `GET /v1/dev/workspaces` and the person's links. Tasks and ChatGPT sign-in stay out: it runs no task workflow.
- **FR-006 (admin):** the admin API (`/v1/admin/*`) is unchanged: it still needs an administrator's own sign-in.

## Proof

`tests/contract/full-access-clients.test.ts` (production and named-environment modes) and
`tests/contract/production-sign-in-clients.test.ts` (the change's wording).
