# Implementation Plan: Sign-in for other services

**Spec**: [spec.md](spec.md) · **Issue**: #442

## Where things live

```mermaid
flowchart LR
  A[Administrator: agentx admin sign-in-client add] -->|admin change| B[Broker]
  B -->|invoke: register / remove| S[Sign-in Lambda]
  S --- T[(Sign-in table: CLIENT#id)]
  P[Person] -->|authorize, token| S
  X[Service] -->|token with its audience| P
  X -->|POST /v1/dev/access| B
  B -.reads.-> T
  B -->|grants, bindings, channel members| G[(State table, Slack directory)]
```

- **The sign-in table owns the registry** (`CLIENT#<id>`): the sign-in Lambda reads it on every authorize, token and
  refresh. Changes go through the sign-in Lambda, as ending sessions does; the broker only reads it.
- **The broker plans and applies the admin changes**, and serves the access check (`POST /v1/dev/access`), since it
  already reads sessions and developers from the sign-in table and owns project access.

## Phases

| Phase | Change |
|---|---|
| 063a | Contracts: `SignInClient`, its registration, the admin change kinds `register_sign_in_client` and `remove_sign_in_client`. Sign-in Lambda: register (new, replace, rotate the secret: only its hash is kept) and remove. Broker: the two planners, applied through the sign-in Lambda; a read route for the list. CLI: `agentx admin sign-in-client add|list|remove`. |
| 063b | Sign-in server: a registered client's authorize (exact redirect or loopback, PKCE), token and refresh (bound to the client; its secret for a confidential client); tokens with its audience and `azp`. A company-login session records `administrator` from `AdminClaim` and `AdminValues`. A test holds that Rovara's API refuses every client audience. |
| 063c | Broker: `POST /v1/dev/access`, by the person's client token, or by developer ID with a confidential client's secret: the live session and developer, `administrator`, and the projects Rovara's own rules give. |

Named environments only: the legacy deployment has no developer sign-in.

## Decisions

- **No new token audience on Rovara.** Rovara keeps accepting only `agentx-developer`; a client token's audience is
  the client's own, so nothing on Rovara's side needs to tell clients apart.
- **Secrets are hashed.** A confidential client's secret is shown once; the table keeps its SHA-256 only.
- **Administrator is a session fact.** Read from the company-login ID token at sign-in, kept on the session, so ending
  the session ends it; a Slack session never has it.
- **Only the admin client's own identity provider makes an administrator.** The sign-in Lambda gets the admin client's
  `OidcIssuer`, `AdminClaim` and `AdminValues`. The claim counts only when company sign-in uses that same issuer;
  another provider's claim of the same name means nothing, and anything unreadable makes nobody an administrator.
- **A client is bound end to end.** The auth request, the code and the session each carry the client ID. A code or
  refresh token presented by another client (the CLI included) is refused. A removed client is refused at once
  (`invalid_client`); a session that started before the client's latest registration ends, so removing and
  registering an ID again does not revive old sign-ins. Revoking ends only the calling client's own sessions.
- **The access check lives under `/v1/dev/`.** That route already reaches the broker with no API Gateway authorizer
  (the broker verifies tokens itself) and is throttled, so no new route is needed. The broker reads the client rows
  (`SIGNIN_CLIENTS`) directly; DeveloperIdentity still owns writing them.
- **The developer-ID form is never an administrator.** Administrator is a fact of the person's own company sign-in,
  so a service asking with only its own secret never learns it as true.
- **Defense in depth:** Rovara's own routes refuse any session that belongs to a registered client, even under a
  token addressed to Rovara.
