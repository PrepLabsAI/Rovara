# Feature Specification: Scoped actions for sign-in clients

**Created**: 2026-11-13
**Status**: Draft
**Input**: "We should go with scoped permissions for Cloud." The Rovara Cloud web app (PrepLabsAI/Rovara-cloud#1) signs
people in through Rovara Code as a sign-in client (spec 063). It must also create projects and manage who may use them,
from its own screens, as the signed-in person.

## Why

A sign-in client's token is refused everywhere on Rovara's API except the access check (spec 063 FR-004). This is
deliberate: a token stolen from a service must not work on Rovara. But it means a service such as Cloud can read who a
person is, and can't act for them. Its alternative, an administrator credential of its own, would let it do anything,
and would audit everything as the service.

## User scenarios

1. **An administrator allows Cloud specific actions.** `agentx admin sign-in-client add rovara-cloud … --scope
   projects:members,projects:create` registers or changes it, as an admin change.
2. **A person signs in to Cloud.** Cloud asks for those scopes when it starts the sign-in. Its token carries the scopes
   it asked for that its registration allows, and no others.
3. **Cloud acts for them.** With that token, Cloud lists a project's members, adds or removes one (065a), and creates a
   project from a repository (065b). Each action is checked as the signed-in person: Cloud can do only what that person
   could do, and only what its scopes allow.

## Requirements

- **FR-001 (registration):** a sign-in client's registration names the scopes it may ask for, from a fixed list:
  `projects:members` (list, add and remove a project's members) and `projects:create` (create a project from a
  repository). None by default. Registering or changing the scopes is the existing `register_sign_in_client` admin
  change.
- **FR-002 (token):** the sign-in client sends `scope` (space-separated) to `/v1/auth/authorize`. The session keeps
  the requested scopes that its registration allows, and every access token issued from it, including after a refresh,
  carries them as `scope`. A scope the client may not use is dropped, not an error. Removing a scope from the
  registration ends it at the client's next token refresh.
- **FR-003 (routes):** `/v1/dev/client/*` takes only a sign-in client's token: its own audience, a live session bound to
  that client, and the scope the route needs. A CLI token, a token for another client, or a token without the scope
  is refused with `401` or `403`, and the route does nothing.
- **FR-004 (as the person):** each route runs as the signed-in developer, with their own rights. Only an administrator
  of a project, or a Rovara administrator, adds or removes its members. Only a Rovara administrator creates a
  project (065b).
- **FR-005 (members, 065a):** `GET /v1/dev/client/projects/{project}/members` lists the developers granted the project.
  `PUT …/members/{developer}` grants it, where `developer` is an email address or a developer ID, as
  `agentx admin project grant` takes it. `DELETE …/members/{developer}` revokes a grant. Each change records who made
  it, through which client.
- **FR-006 (create, 065b):** `POST /v1/dev/client/projects` takes a GitHub repository (`owner/name`), a name, and
  optional setup and test commands. Rovara Code builds the project definition with its own GitHub App credential and its
  deployment's worker settings, then registers it with the caller as its administrator.

## Security considerations

- **Scopes come from a person's admin change,** never from the client itself. A client asking for more than its
  registration allows gets less, not an error that would reveal the list.
- **The token stays useless elsewhere.** Its audience is still the client's, so every route outside
  `/v1/dev/client/*` and the access check refuses it, as spec 063 requires.
- **No escalation.** A scope never adds a right the person lacks: the routes check the person's own rights (FR-004) as
  well as the scope.
- **Revocation.** Removing the client or its scope, revoking the person's sign-in, or ending the session stops it at
  the next refresh. A request with an ended session is refused at once (the session is checked on each request).
- **Fails closed:** an unknown client, a missing or expired token, or a scope that is not on the token gets a refusal.

## Out of scope

- A consent screen. Scopes are an administrator's decision, made at registration, not each person's.
- Scopes for other routes (tasks, workspaces). Each new action is a new, named scope.
