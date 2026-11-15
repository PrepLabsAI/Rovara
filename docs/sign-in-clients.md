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

- `--scope`: what the service may do on Rovara as the signed-in person, comma-separated (see
  [Act as the signed-in person](#act-as-the-signed-in-person)). None by default.

Running `add` again for the same ID replaces the whole client, and `--confidential` makes a new secret. To change a
registered client, use `update`.

## Change a service

```sh
agentx admin sign-in-client update web-app --scope projects:members
```

`update` changes only the settings you give and keeps everything else, its secret included:

- `--name`, `--audience`, `--loopback` or `--no-loopback`.
- `--redirect <url>` (repeat for more) replaces its redirect URLs; `--clear-redirects` removes them all.
- `--scope a,b` replaces its scopes; `--scope none` removes them all.
- `--rotate-secret` gives it a new secret, shown once (or written with `--secret-file`); the old one stops working.

The person who runs it never sees the stored secret: Rovara carries it over.

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

## Check what a person can do

`POST <api>/v1/dev/access` answers who the person is, whether they are a Rovara administrator, and which projects
they can use now:

```json
{ "developerId": "…", "displayName": "Ada", "administrator": false,
  "projects": [{ "name": "payments-api", "access": "channel" }], "notices": [] }
```

`access` is `granted` (a grant), `channel` (through a Slack channel), or `administrator` (a project they administer).

- With the person's token: `Authorization: Bearer <their access token for the service>` and no body.
- By developer ID, for a confidential service only: HTTP Basic with the client ID and secret, and the body
  `{ "developerId": "…" }`. This form always answers `administrator: false`.

Rovara reads the person's sign-in and grants on every call. An ended sign-in, a revoked developer or a removed client
answers 401. If Slack can't be reached, `notices` contains `slack_unavailable` and projects that come only from a
channel are left out.

## Act as the signed-in person

A service registered with `--scope` asks for those scopes when it starts a sign-in (`scope=projects:members` on
`/v1/auth/authorize`, space-separated). Its tokens then carry the scopes it asked for that its registration allows, as
`scope`. A scope it may not use is dropped, not refused. Removing a scope from the registration ends it at the next
token refresh.

With such a token, the `/v1/dev/client/*` routes act as the signed-in person, within their own rights:

| Scope | Route | Does |
| --- | --- | --- |
| (none) | `GET /v1/dev/client/projects/{project}` | A project the person may use: its latest revision, their access, and its repositories |
| `projects:members` | `GET /v1/dev/client/projects/{project}/members` | Lists the people granted the project |
| `projects:members` | `PUT /v1/dev/client/projects/{project}/members/{who}` | Grants the project, as `agentx admin project grant` does; `who` is an email address or a developer ID |
| `projects:members` | `DELETE /v1/dev/client/projects/{project}/members/{who}` | Revokes a grant |

Only the project's administrators, or a Rovara administrator (company sign-in with the administrator claim), may use
the member routes. A token without the scope gets 403, and any other token (the CLI's, another service's, an ended
sign-in) gets 401. Each change records the person and the service that made it.

The member list shows grants made once this release is in. A grant made before it is listed once it is made again.

See the specs: [sign-in clients](../specs/063-sign-in-clients/spec.md) and
[scoped actions](../specs/065-client-scopes/spec.md).
