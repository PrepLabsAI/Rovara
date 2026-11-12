# Sign-in for other services

A service built on Rovara (a dashboard, or a scheduler that acts as a channel adapter) can let Rovara users sign in
with Rovara rather than with an identity system of its own. An administrator registers it as a **sign-in client**.
Its tokens carry its own audience, so Rovara's API refuses them.

Developer sign-in must be set up (`agentx signin enable`). Every change is an admin change: the CLI shows what it will
do and asks before applying it, and `agentx admin changes` records it.

## Register a service

```sh
agentx admin sign-in-client add scheduler \
  --name Scheduler \
  --audience scheduler \
  --redirect https://scheduler.example.com/callback \
  --loopback
```

- `--audience`: the audience its tokens carry. It can't be `agentx-developer` or another client's audience.
- `--redirect`: an exact `https` URL on a public host that its web page returns to, with no query or fragment.
  Repeat it for more URLs, up to 10.
- `--loopback`: the service may sign people in from a terminal with a loopback redirect, as `agentx login` does.
- `--confidential`: for a server-side service. The CLI makes a secret and shows it once, after the change applies.
  Only the secret's SHA-256 hash leaves your computer. Add `--secret-file <path>` to write the secret to a new file
  (mode 600) instead of printing it. Each `add --confidential` makes a new secret, so running it again rotates the
  secret.

Running `add` again for the same ID replaces the client.

## List and remove

```sh
agentx admin sign-in-client list
agentx admin sign-in-client remove scheduler
```

After a client is removed, nobody can sign in to it.

## Sign people in from the service

The service uses Rovara's sign-in server as an OAuth 2.0 authorization server. Its discovery document is at
`<api>/v1/auth/.well-known/openid-configuration`.

1. Send the person to `<api>/v1/auth/authorize` with `response_type=code`, the service's `client_id`, one of its
   registered `redirect_uri`s (or a loopback one, if it registered `--loopback`), `state`, and a PKCE
   `code_challenge` with `code_challenge_method=S256`. They sign in with Slack or company login.
2. Redeem the code at `<api>/v1/auth/token` (`grant_type=authorization_code`) with the same `client_id`,
   `redirect_uri` and `code_verifier`. A confidential client also sends its secret, as `client_secret` or with HTTP
   Basic.
3. The access token is addressed to the service: its `aud` is the client's audience and its `azp` is the client ID.
   It lasts as long as the CLI's. Refresh it with `grant_type=refresh_token`. The refresh token works only for this
   client.
4. Sign out with `<api>/v1/auth/revoke`.

Rovara's own API refuses these tokens.

A session records whether the person is a Rovara administrator. Only a company sign-in counts, and only when it uses
the same identity provider as the admin client and its ID token carries the administrator claim (`AdminClaim`,
`AdminValues`). A Slack sign-in never counts.

Status: phases 063a (the registry) and 063b (sign-in). The access check comes in 063c
([spec](../specs/063-sign-in-clients/spec.md)).
