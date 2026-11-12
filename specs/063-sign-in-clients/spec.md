# Feature Specification: Sign-in for other services

**Feature Branch**: `claude/063-sign-in-clients`
**Created**: 2026-11-12
**Status**: Draft
**Issue**: #442
**Input**: "A service built on Rovara, such as a dashboard or a scheduler that acts as a channel adapter, has its own
command line and web page. The people who use it are Rovara users, and they should sign in with Rovara (Slack or
company login) rather than with a second identity system."
Clarified on 2026-11-12: a Rovara administrator, for the access check, is a person whose company-login sign-in carries
the administrator claim, as the admin client decides today; a Slack-only sign-in is never an administrator.

## Why

Rovara's sign-in server issues RS256 tokens addressed to Rovara (audience `agentx-developer`) for one client, the
Rovara CLI. A service that accepted those tokens would hold credentials that also work on Rovara's API: a token stolen
from it, or replayed by it, could act on Rovara. And the service cannot ask Rovara what a signed-in person may do.

## User scenarios

1. **An administrator registers a service.** `agentx admin sign-in-client add scheduler --audience scheduler
   --redirect https://scheduler.example.com/callback --loopback` registers it, as an admin change other administrators
   can see. `agentx admin sign-in-client remove scheduler` removes it: its sign-ins stop working at their next refresh.
2. **A person signs in to the service.** From the service's command line (a loopback redirect, as `agentx login`
   does) or its web page (authorization code with PKCE), they sign in with Slack or company login, and the service
   receives a token addressed to it, and a refresh token bound to it.
3. **The service checks access.** It calls Rovara's access check with the person's token, and learns who they are,
   whether they are a Rovara administrator, and which projects they can use. A server-side service registered with
   a secret may ask by developer ID instead.
4. **The token is useless on Rovara.** The same token sent to Rovara's API is refused.

## Requirements

- **FR-001 (registry):** an administrator registers a sign-in client: an ID (lower-case, `[a-z][a-z0-9-]{1,31}`), a
  name, an audience (not `agentx-developer`, not another client's), its exact HTTPS redirect URLs (at most 10, no
  query or fragment, public hosts only), whether it may use a loopback redirect, and whether it is confidential. A
  confidential client gets a secret, shown once. Registering, replacing, rotating and removing are admin changes
  (`register_sign_in_client`, `remove_sign_in_client`), confirmed and recorded as the other kinds are.
- **FR-002 (sign-in):** `/v1/auth/authorize` takes a registered client's ID and one of its redirect URLs (or a
  loopback one, if allowed) with a PKCE challenge, as the CLI's does. The code and the refresh token are bound to that
  client; `/v1/auth/token` redeems them only with its ID (and its secret, for a confidential client). The access token
  carries the client's audience and the client's ID (`azp`); its lifetime is the CLI's. A removed client's refresh
  is refused.
- **FR-003 (refused by Rovara):** Rovara's API accepts only `agentx-developer` tokens, so a client's token is refused
  everywhere but the access check. A test holds this for every registered audience.
- **FR-004 (access check):** `POST /v1/access` answers `{ developerId, displayName, administrator, projects }`
  for a client's own token (`Authorization: Bearer`), or, for a confidential client authenticated with its secret,
  for a developer ID. It reads the live session and grants, so a revoked grant, an ended sign-in or a revoked
  developer shows on the next call within the token's lifetime: an ended session or a revoked developer answers 401.
  `projects` lists the projects the person can use now, with Rovara's own rules (granted, or a member of a bound
  channel).
- **FR-005 (administrator):** `administrator` is true only for a company-login session whose ID token carried the
  administrator claim (`AdminClaim`, `AdminValues`) when it signed in. It is recorded on the session, so it ends with
  the session.

## Security considerations

**Untrusted actors:** registered services (which may be compromised), people signing in to them, anyone holding a
client's token or code.

**Trust boundaries:**
1. Service → sign-in server: the client ID, an exact registered redirect URL (or loopback), PKCE, and a secret for a
   confidential client.
2. Client token → Rovara: never accepted (audience).
3. Service → access check: the person's token addressed to that client, or the confidential client's secret.

**Abuse cases:**
- A service uses its token on Rovara's API: refused by audience (FR-003).
- A service asks about a person who never signed in to it: refused without its secret; with it, it learns only what
  the person could see (the developer ID form is for server-side adapters linked to that person).
- A redirect to an attacker's page: only exact registered URLs or loopback; codes are single-use, PKCE-bound and
  short-lived.
- A removed or rotated client keeps working: refresh refuses a removed client at once; access tokens live only as
  long as the CLI's.
- Claiming administrator through Slack: never; only a company-login session with the claim.

**Fail-closed:** an unknown client, a mismatched redirect, a missing or wrong secret, an ended session or an unreadable
grant answers an error and issues nothing.

## Out of scope

Consent screens for third-party services (clients are the organization's own, registered by an administrator),
scopes narrower than "this person's access", and the legacy deployment, which has no developer sign-in.
